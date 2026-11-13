//! Video capture: one FFmpeg process that grabs a display on the graphics card and
//! feeds it straight to the hardware encoder. Frames never pass through main memory.

use crate::settings::Settings;
use crate::winutil::CaptureTarget;
use anyhow::{anyhow, Result};
use std::fs::File;
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;

pub struct VideoRecorder {
    child: Child,
    log_path: PathBuf,
}

/// Which encoder does the work. The three graphics-card families keep the picture on
/// the card from capture to file; `Cpu` is the fallback that works anywhere but costs
/// processor time.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Family {
    Nvenc,
    Amf,
    Qsv,
    Cpu,
}

impl Family {
    pub fn label(self) -> &'static str {
        match self {
            Family::Nvenc => "NVIDIA",
            Family::Amf => "AMD",
            Family::Qsv => "Intel",
            Family::Cpu => "processor",
        }
    }
    fn from_setting(s: &str) -> Option<Family> {
        match s {
            "nvenc" => Some(Family::Nvenc),
            "amf" => Some(Family::Amf),
            "qsv" => Some(Family::Qsv),
            "cpu" => Some(Family::Cpu),
            _ => None,
        }
    }
}

/// The codec that will really be used. AV1 is only offered on NVIDIA here, and the
/// processor fallback is always H.264.
pub fn effective_codec(s: &Settings, family: Family) -> &'static str {
    match (family, s.codec.as_str()) {
        (Family::Cpu, _) => "h264",
        (_, "hevc") => "hevc",
        (Family::Nvenc, "av1") => "av1",
        _ => "h264",
    }
}

/// Target output height when downscaling is enabled and the display is taller.
pub fn target_height(s: &Settings, target: &CaptureTarget) -> Option<u32> {
    let h: u32 = match s.resolution.as_str() {
        "1440" => 1440,
        "1080" => 1080,
        "720" => 720,
        _ => return None,
    };
    (target.h as u32 > h).then_some(h)
}

fn capture_chain(
    target: &CaptureTarget,
    fps: u32,
    family: Family,
    stamp_epoch_us: Option<i64>,
    scale_h: Option<u32>,
    gpu_scale: bool,
) -> String {
    let mut g = format!("ddagrab=output_idx={}:framerate={}:draw_mouse=1", target.output_idx, fps);
    if let Some(x) = stamp_epoch_us {
        g += &format!(",setpts=(RTCTIME-{x})/(TB*1000000)");
        // State the frame rate again after stamping. The grabber's clock counts in
        // microseconds, and without this the AV1 and H.265 encoders take that for a
        // million frames a second and give each frame almost no bits: recordings
        // came out at about 1 Mbit/s and badly blocky (found 2026-11-13; H.264 was
        // not affected). This also makes the file constant frame rate.
        g += &format!(",fps={fps}");
    }
    match (family, scale_h, gpu_scale) {
        (Family::Nvenc, Some(h), true) => {
            g += &format!(",hwmap=derive_device=cuda,scale_cuda=w=-2:h={h}:force_original_aspect_ratio=decrease:force_divisible_by=2:format=nv12");
        }
        (Family::Qsv, Some(h), true) => {
            g += &format!(",hwmap=derive_device=qsv,format=qsv,scale_qsv=w=-2:h={h}");
        }
        (Family::Qsv, None, _) => g += ",hwmap=derive_device=qsv,format=qsv",
        (Family::Cpu, Some(h), _) => {
            g += &format!(",hwdownload,format=bgra,scale=-2:{h}:flags=fast_bilinear");
        }
        (Family::Cpu, None, _) => g += ",hwdownload,format=bgra",
        // QSV encoders take nv12, not yuv420p.
        (Family::Qsv, Some(h), _) => {
            g += &format!(",hwdownload,format=bgra,scale=-2:{h}:flags=fast_bilinear,format=nv12");
        }
        (Family::Nvenc | Family::Amf, Some(h), _) => {
            g += &format!(",hwdownload,format=bgra,scale=-2:{h}:flags=fast_bilinear,format=yuv420p");
        }
        (Family::Nvenc | Family::Amf, None, _) => {}
    }
    g
}

fn encoder_args(s: &Settings, family: Family) -> Vec<String> {
    let fps = s.fps.clamp(15, 240).to_string();
    let q = s.quality.clamp(10, 40).to_string();
    let codec = effective_codec(s, family);
    let v = |list: &[&str]| list.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    match family {
        Family::Nvenc => {
            let mut a = v(&["-c:v", &format!("{codec}_nvenc"), "-preset", "p4", "-rc", "vbr", "-cq", &q, "-b:v", "0", "-g", &fps]);
            if codec != "av1" {
                a.extend(v(&["-bf", "0"]));
            }
            a
        }
        Family::Amf => v(&["-c:v", &format!("{codec}_amf"), "-usage", "transcoding", "-quality", "balanced", "-rc", "cqp", "-qp_i", &q, "-qp_p", &q, "-g", &fps]),
        Family::Qsv => v(&["-c:v", &format!("{codec}_qsv"), "-preset", "medium", "-global_quality", &q, "-g", &fps]),
        Family::Cpu => v(&["-c:v", "libx264", "-preset", "veryfast", "-crf", &q, "-pix_fmt", "yuv420p", "-g", &fps]),
    }
}

/// How a re-encode of a clip is told what size to aim for.
#[derive(Debug, Clone, Copy)]
pub enum Rate {
    /// Constant quality: the graphics cards' quality number; the processor gets 2 less.
    Quality(u32),
    /// A video bitrate in kbps, capped at that rate (for clips of a set file size).
    Kbps(u32),
}

/// H.264 encoder arguments to try in turn for a clip: the graphics card's encoder if
/// there is one, the processor otherwise.
pub fn h264_ladder(rate: Rate) -> Vec<Vec<String>> {
    let v = |list: &[&str]| list.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    match rate {
        Rate::Quality(q) => {
            let (q, crf) = (q.to_string(), q.saturating_sub(2).to_string());
            vec![
                v(&["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", &q, "-b:v", "0"]),
                v(&["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", &q, "-qp_p", &q]),
                v(&["-c:v", "h264_qsv", "-global_quality", &q]),
                v(&["-c:v", "libx264", "-preset", "veryfast", "-crf", &crf, "-pix_fmt", "yuv420p"]),
            ]
        }
        Rate::Kbps(k) => {
            let (r, buf) = (format!("{k}k"), format!("{}k", k * 2));
            let cap = ["-b:v", r.as_str(), "-maxrate", r.as_str(), "-bufsize", buf.as_str()];
            let with = |head: &[&str]| [v(head), v(&cap)].concat();
            vec![
                with(&["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr"]),
                with(&["-c:v", "h264_amf", "-quality", "balanced", "-rc", "vbr_peak"]),
                with(&["-c:v", "h264_qsv"]),
                [with(&["-c:v", "libx264", "-preset", "medium"]), v(&["-pix_fmt", "yuv420p"])].concat(),
            ]
        }
    }
}

fn device_args(target: &CaptureTarget) -> Vec<String> {
    if target.adapter_idx == 0 {
        return Vec::new();
    }
    vec![
        "-init_hw_device".into(),
        format!("d3d11va=cap:{}", target.adapter_idx),
        "-filter_hw_device".into(),
        "cap".into(),
    ]
}

static CHOSEN: std::sync::Mutex<Option<Family>> = std::sync::Mutex::new(None);
/// The last on-card scaling probe: (encoder, output height, display, worked).
static GPU_SCALE_WORKS: std::sync::Mutex<Option<(Family, u32, u32, bool)>> = std::sync::Mutex::new(None);

fn probe_chain(ffmpeg: &Path, target: &CaptureTarget, settings: &Settings, family: Family, scale_h: Option<u32>, gpu_scale: bool) -> bool {
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-y"].map(String::from).to_vec();
    args.extend(device_args(target));
    args.extend(["-f".into(), "lavfi".into(), "-i".into(), capture_chain(target, 30, family, None, scale_h, gpu_scale)]);
    args.extend(["-frames:v".into(), "2".into()]);
    args.extend(encoder_args(settings, family));
    args.extend(["-an".into(), "-f".into(), "null".into(), "-".into()]);
    run_tool(ffmpeg, &args).is_ok()
}

/// The encoder to use. With the setting on automatic, each graphics-card encoder is
/// tried once with a two-frame capture (about a second each) and the first that
/// works is remembered until the app closes.
pub fn resolve_family(ffmpeg: &Path, target: &CaptureTarget, settings: &Settings) -> Family {
    if let Some(f) = Family::from_setting(settings.encoder.as_str()) {
        return f;
    }
    if let Some(f) = *CHOSEN.lock().unwrap() {
        return f;
    }
    let mut chosen = Family::Cpu;
    for family in [Family::Nvenc, Family::Amf, Family::Qsv] {
        if probe_chain(ffmpeg, target, settings, family, None, false) {
            chosen = family;
            break;
        }
    }
    crate::settings::log(format!("[video] encoder chosen automatically: {}", chosen.label()));
    *CHOSEN.lock().unwrap() = Some(chosen);
    chosen
}

fn can_gpu_scale(ffmpeg: &Path, target: &CaptureTarget, settings: &Settings, family: Family, h: u32) -> bool {
    if !matches!(family, Family::Nvenc | Family::Qsv) {
        return false;
    }
    if let Some((f, fh, out, ok)) = *GPU_SCALE_WORKS.lock().unwrap() {
        if f == family && fh == h && out == target.output_idx {
            return ok;
        }
    }
    let ok = probe_chain(ffmpeg, target, settings, family, Some(h), true);
    crate::settings::log(format!(
        "[video] on-card downscale ({}) {}",
        family.label(),
        if ok { "ready" } else { "unavailable, using fallback" }
    ));
    *GPU_SCALE_WORKS.lock().unwrap() = Some((family, h, target.output_idx, ok));
    ok
}

impl VideoRecorder {
    /// `ref_epoch_us` is the wall-clock moment (microseconds since 1970) of session time
    /// zero. Each frame is stamped with "wall clock minus that", so the first frame's
    /// timestamp in the file tells exactly when on the session clock video began.
    pub fn start(
        ffmpeg: &Path,
        target: &CaptureTarget,
        settings: &Settings,
        family: Family,
        ref_epoch_us: i64,
        out: &Path,
    ) -> Result<VideoRecorder> {
        let fps = settings.fps.clamp(15, 240);
        let scale_h = target_height(settings, target);
        let gpu_scale = scale_h.map(|h| can_gpu_scale(ffmpeg, target, settings, family, h)).unwrap_or(false);
        let graph = capture_chain(target, fps, family, Some(ref_epoch_us), scale_h, gpu_scale);
        let log_path = out.with_extension("log");
        let log = File::create(&log_path)?;

        let mut cmd = Command::new(ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "warning", "-y", "-copyts"]);
        cmd.args(device_args(target));
        cmd.args(["-f", "lavfi", "-i", &graph]);
        cmd.args(encoder_args(settings, family));
        cmd.args(["-an"]).arg(out);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::from(log))
            .creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);

        let mut child = cmd
            .spawn()
            .map_err(|e| anyhow!("could not start FFmpeg ({}): {e}", ffmpeg.display()))?;

        // Fail fast if the capture or encoder could not be opened.
        let begun = Instant::now();
        while begun.elapsed() < Duration::from_millis(1200) {
            if let Some(status) = child.try_wait()? {
                let tail = std::fs::read_to_string(&log_path).unwrap_or_default();
                return Err(anyhow!(
                    "FFmpeg stopped right away ({status}): {}",
                    tail.lines().rev().take(4).collect::<Vec<_>>().join(" | ")
                ));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(VideoRecorder {
            child,
            log_path,
        })
    }

    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Ask FFmpeg to finish the file, and wait for it.
    pub fn stop(mut self) -> Result<()> {
        if let Some(mut stdin) = self.child.stdin.take() {
            let _ = stdin.write_all(b"q\n");
            let _ = stdin.flush();
        }
        let begun = Instant::now();
        loop {
            if self.child.try_wait()?.is_some() {
                break;
            }
            if begun.elapsed() > Duration::from_secs(15) {
                let _ = self.child.kill();
                let _ = self.child.wait();
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // Keep the log only if FFmpeg had something to say.
        if std::fs::metadata(&self.log_path).map(|m| m.len() == 0).unwrap_or(false) {
            let _ = std::fs::remove_file(&self.log_path);
        }
        Ok(())
    }
}

/// Run an FFmpeg/FFprobe tool to completion without flashing a console window.
pub fn run_tool(exe: &Path, args: &[String]) -> Result<String> {
    let out = Command::new(exe)
        .args(args)
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS)
        .output()
        .map_err(|e| anyhow!("could not run {}: {e}", exe.display()))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(anyhow!(
            "{} failed: {}",
            exe.file_name().and_then(|n| n.to_str()).unwrap_or("tool"),
            err.lines().rev().take(6).collect::<Vec<_>>().join(" | ")
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// What FFmpeg reports about a media file.
#[derive(Debug, Default, PartialEq)]
pub struct MediaInfo {
    /// Timestamp of the first frame, in seconds.
    pub start: f64,
    pub duration: f64,
    pub width: i64,
    pub height: i64,
}

/// Read a file's start time, length and picture size by asking FFmpeg to describe it.
/// (FFmpeg alone is enough, so the app does not need FFprobe as well.)
pub fn probe(ffmpeg: &Path, file: &Path) -> MediaInfo {
    let out = Command::new(ffmpeg)
        .args(["-hide_banner", "-i"])
        .arg(file)
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS)
        .output();
    match out {
        Ok(o) => parse_media_info(&String::from_utf8_lossy(&o.stderr)),
        Err(_) => MediaInfo::default(),
    }
}

fn parse_media_info(text: &str) -> MediaInfo {
    let mut info = MediaInfo::default();
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Duration: ") {
            let clock = rest.split(',').next().unwrap_or("");
            let parts: Vec<f64> = clock.split(':').filter_map(|p| p.trim().parse().ok()).collect();
            if parts.len() == 3 {
                info.duration = parts[0] * 3600.0 + parts[1] * 60.0 + parts[2];
            }
            if let Some(start) = rest.split("start: ").nth(1) {
                info.start = start.split(',').next().and_then(|s| s.trim().parse().ok()).unwrap_or(0.0);
            }
        } else if info.width == 0 && line.contains("Video:") {
            // The picture size is the first "1234x567" token on the video stream's line.
            for token in line.split(|c: char| c == ',' || c.is_whitespace()) {
                if let Some((w, h)) = token.split_once('x') {
                    let digits = |s: &str| s.len() >= 2 && s.chars().all(|c| c.is_ascii_digit());
                    if digits(w) && digits(h) {
                        info.width = w.parse().unwrap_or(0);
                        info.height = h.parse().unwrap_or(0);
                        break;
                    }
                }
            }
        }
    }
    info
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_info_is_read_from_ffmpeg_text() {
        let mp4 = "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'game.mp4':\n  Duration: 00:01:28.64, start: 0.000000, bitrate: 20726 kb/s\n  Stream #0:0[0x1](und): Video: h264 (Main) (avc1 / 0x31637661), yuv420p(tv, bt470bg/bt709/iec61966-2-1, progressive), 2560x1440 [SAR 1:1 DAR 16:9], 20561 kb/s, 59.22 fps, 59.94 tbr, 16k tbn (default)\n  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 192 kb/s (default)\n";
        assert_eq!(parse_media_info(mp4), MediaInfo { start: 0.0, duration: 88.64, width: 2560, height: 1440 });
        let mkv = "Input #0, matroska,webm, from 'video.mkv':\n  Duration: 00:34:07.50, start: 0.365000, bitrate: 21000 kb/s\n  Stream #0:0: Video: hevc (Main), yuv420p(tv), 3840x2160, 60 fps, 60 tbr, 1k tbn\n";
        let info = parse_media_info(mkv);
        assert!((info.start - 0.365).abs() < 1e-9);
        assert!((info.duration - 2047.5).abs() < 1e-9);
        assert_eq!((info.width, info.height), (3840, 2160));
        assert_eq!(parse_media_info("garbage"), MediaInfo::default());
    }

    #[test]
    fn codec_follows_what_the_encoder_can_do() {
        let mut s = Settings::default();
        s.codec = "av1".into();
        assert_eq!(effective_codec(&s, Family::Nvenc), "av1");
        assert_eq!(effective_codec(&s, Family::Amf), "h264");
        assert_eq!(effective_codec(&s, Family::Cpu), "h264");
        s.codec = "hevc".into();
        assert_eq!(effective_codec(&s, Family::Qsv), "hevc");
        assert_eq!(effective_codec(&s, Family::Cpu), "h264");
        let target = CaptureTarget { adapter_idx: 0, output_idx: 1, x: 0, y: 0, w: 1920, h: 1080 };
        assert!(capture_chain(&target, 60, Family::Cpu, Some(5), None, false).ends_with(",hwdownload,format=bgra"));
        // The frame rate is stated right after the wall-clock stamp, for every encoder.
        for family in [Family::Nvenc, Family::Amf, Family::Qsv, Family::Cpu] {
            assert!(capture_chain(&target, 60, family, Some(5), None, false).contains("setpts=(RTCTIME-5)/(TB*1000000),fps=60"));
        }
        assert!(!capture_chain(&target, 60, Family::Nvenc, None, None, false).contains("fps="));
        assert!(capture_chain(&target, 60, Family::Nvenc, None, None, false).starts_with("ddagrab=output_idx=1:framerate=60"));

        // Downscaling: only triggers when display height exceeds target height.
        s.resolution = "1080".into();
        let uhd = CaptureTarget { adapter_idx: 0, output_idx: 0, x: 0, y: 0, w: 3840, h: 2160 };
        assert_eq!(target_height(&s, &uhd), Some(1080));
        assert_eq!(target_height(&s, &target), None);
        assert!(capture_chain(&uhd, 60, Family::Nvenc, Some(5), Some(1080), true).contains("scale_cuda=w=-2:h=1080"));
        assert!(capture_chain(&uhd, 60, Family::Qsv, Some(5), Some(1080), true).contains("scale_qsv=w=-2:h=1080"));
        assert!(capture_chain(&uhd, 60, Family::Nvenc, Some(5), Some(1080), false).contains("hwdownload,format=bgra,scale=-2:1080"));
        // One encoder ladder for clips: quality mode keeps the old numbers (the processor
        // 2 lower), bitrate mode caps every encoder at the same rate.
        let q = h264_ladder(Rate::Quality(23));
        assert_eq!(q.len(), 4);
        assert!(q[0].join(" ").contains("h264_nvenc -preset p5 -rc vbr -cq 23"));
        assert!(q[3].join(" ").contains("libx264 -preset veryfast -crf 21 -pix_fmt yuv420p"));
        let k = h264_ladder(Rate::Kbps(900));
        assert!(k.iter().all(|e| e.join(" ").contains("-b:v 900k -maxrate 900k -bufsize 1800k")));
        assert!(k[3].join(" ").ends_with("-pix_fmt yuv420p"));
        // Without on-card scaling, QSV still gets a pixel format its encoder accepts.
        assert!(capture_chain(&uhd, 60, Family::Qsv, Some(5), Some(1080), false).ends_with("format=nv12"));
    }
}
