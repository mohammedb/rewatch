//! Smaller copies of recordings for teammates.
//!
//! A full recording is several gigabytes. For each recent game a 1080p copy is made
//! next to it (`review.mp4`, about a fifth of the size). Teammates are handed that
//! copy instead of the original: quicker to send, lighter to store. Copies are only
//! made while no game is running, at the lowest priority, and stop at once if a game
//! starts.

use crate::settings::{log, Settings};
use crate::video::CREATE_NO_WINDOW;
use anyhow::{anyhow, Result};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

pub const FILE: &str = "review.mp4";
const PART: &str = "review.part";
/// Left beside a recording whose copy could not be made or would not be smaller.
pub const FAILED: &str = "review.failed";
const IDLE_PRIORITY_CLASS: u32 = 0x0000_0040;
/// Recordings older than this are handed out as they are.
const RECENT_MS: i64 = 7 * 24 * 3600 * 1000;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Whether this app should be making copies at all.
pub fn enabled(s: &Settings) -> bool {
    s.review_copies && s.share_with_friends && !s.friends.is_empty()
}

/// What a teammate should fetch for the recording in `dir`:
/// "ready" (the small copy exists), "pending" (it is going to be made soon, wait for
/// it) or "off" (take the original).
pub fn state(dir: &Path, started_ms: i64, on: bool) -> &'static str {
    if dir.join(FILE).exists() {
        "ready"
    } else if on && !dir.join(FAILED).exists() && now_ms() - started_ms < RECENT_MS {
        "pending"
    } else {
        "off"
    }
}

/// The newest recent recording that still lacks its small copy.
fn next_wanted(root: &Path) -> Option<PathBuf> {
    let mut found: Vec<(i64, PathBuf)> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let dir = e.path();
            if dir.join(FILE).exists() || dir.join(FAILED).exists() || !dir.join("game.mp4").exists() {
                return None;
            }
            let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("match.json")).ok()?).ok()?;
            // Only games can be matched with a teammate's recording.
            if doc.get("clock").and_then(|c| c.as_array()).map(|a| a.is_empty()).unwrap_or(true) {
                return None;
            }
            let started = doc.get("startedEpochMs").and_then(|x| x.as_i64()).unwrap_or(0);
            (now_ms() - started < RECENT_MS).then_some((started, dir))
        })
        .collect();
    found.sort_by_key(|(started, _)| -*started);
    found.into_iter().next().map(|(_, dir)| dir)
}

fn height_of(ffmpeg: &Path, file: &Path) -> i64 {
    crate::video::probe(ffmpeg, file).height
}

/// Encode `game.mp4` in `dir` to a smaller file. `stop` is asked twice a second;
/// when it says yes the work is abandoned. Returns Ok(false) if it was abandoned.
pub fn make(ffmpeg: &Path, dir: &Path, stop: &dyn Fn() -> bool) -> Result<bool> {
    // One copy at a time: the background loop and a game being sent to a coach may
    // both want the same one, and they would write over each other's half-made file.
    static ONE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
    if dir.join(FILE).exists() || dir.join(FAILED).exists() {
        return Ok(true);
    }
    let src = dir.join("game.mp4");
    let part = dir.join(PART);
    let p = |x: &Path| x.to_string_lossy().to_string();
    let tall = height_of(ffmpeg, &src) > 1080;
    // The sound is copied as it is, so the copy lines up with the original exactly.
    let tail: Vec<String> = ["-c:a", "copy", "-movflags", "+faststart", "-f", "mp4"].map(String::from).to_vec();
    let nvenc: Vec<String> = ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "28", "-b:v", "0", "-g", "120"].map(String::from).to_vec();
    let soft_scale: Vec<String> = if tall { vec!["-vf".into(), "scale=-2:1080".into()] } else { Vec::new() };

    // Tried in order; the first that works is used. The first keeps the picture on an
    // NVIDIA card from start to finish, the last works on any PC.
    let mut attempts: Vec<(&str, Vec<String>, Vec<String>)> = Vec::new();
    let mut gpu_in: Vec<String> = ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"].map(String::from).to_vec();
    gpu_in.extend(["-i".into(), p(&src)]);
    let mut gpu_out: Vec<String> = if tall { vec!["-vf".into(), "scale_cuda=-2:1080".into()] } else { Vec::new() };
    gpu_out.extend(nvenc.clone());
    attempts.push(("NVIDIA", gpu_in, gpu_out));
    let plain_in: Vec<String> = vec!["-i".into(), p(&src)];
    for (label, enc) in [
        ("NVIDIA (processor decode)", nvenc.clone()),
        ("AMD", ["-c:v", "h264_amf", "-usage", "transcoding", "-quality", "balanced", "-rc", "cqp", "-qp_i", "28", "-qp_p", "28", "-g", "120"].map(String::from).to_vec()),
        ("Intel", ["-c:v", "h264_qsv", "-preset", "medium", "-global_quality", "28", "-g", "120"].map(String::from).to_vec()),
        ("processor", ["-c:v", "libx264", "-preset", "veryfast", "-crf", "27", "-pix_fmt", "yuv420p", "-g", "120"].map(String::from).to_vec()),
    ] {
        let mut out = soft_scale.clone();
        out.extend(enc);
        attempts.push((label, plain_in.clone(), out));
    }

    let mut last_error = String::new();
    for (label, input, output) in attempts {
        let _ = std::fs::remove_file(&part);
        let mut cmd = Command::new(ffmpeg);
        cmd.args(["-y", "-hide_banner", "-loglevel", "error"]).args(&input).args(&output).args(&tail).arg(&part);
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).creation_flags(CREATE_NO_WINDOW | IDLE_PRIORITY_CLASS);
        let mut child = cmd.spawn().map_err(|e| anyhow!("could not start FFmpeg: {e}"))?;
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if stop() {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&part);
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(500));
        };
        if status.success() && std::fs::metadata(&part).map(|m| m.len() > 1000).unwrap_or(false) {
            let (a, b) = (std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0), std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0));
            if !worth_keeping(a, b) {
                // A recording that is already small (a short or very still one) gains
                // nothing from a copy: hand out the original instead.
                let _ = std::fs::remove_file(&part);
                let _ = std::fs::write(dir.join(FAILED), "the copy would not be smaller than the original");
                return Ok(true);
            }
            std::fs::rename(&part, dir.join(FILE))?;
            log(format!(
                "[copy] made the teammates' copy of {} with the {label} encoder: {} MB instead of {} MB",
                dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                b / 1_048_576,
                a / 1_048_576
            ));
            return Ok(true);
        }
        use std::io::Read;
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            let _ = e.read_to_string(&mut err);
        }
        last_error = err.lines().rev().take(3).collect::<Vec<_>>().join(" | ");
    }
    let _ = std::fs::remove_file(&part);
    Err(anyhow!("no encoder could make the copy: {last_error}"))
}

/// A copy earns its place only if it is clearly smaller than the original.
fn worth_keeping(original: u64, copy: u64) -> bool {
    copy.saturating_mul(100) < original.saturating_mul(85)
}

/// Remove copies that are not smaller than their original (version 0.2.0 kept them).
fn prune(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for dir in entries.flatten().map(|e| e.path()) {
        let size = |name: &str| std::fs::metadata(dir.join(name)).map(|m| m.len()).unwrap_or(0);
        let (original, copy) = (size("game.mp4"), size(FILE));
        if copy > 0 && original > 0 && !worth_keeping(original, copy) && std::fs::remove_file(dir.join(FILE)).is_ok() {
            let _ = std::fs::write(dir.join(FAILED), "the copy was not smaller than the original");
            log(format!("[copy] removed a copy that was no smaller than its recording: {}", dir.display()));
        }
    }
}

/// Background loop. `busy` says whether a game is running or being recorded; while it
/// does, nothing is encoded.
pub fn worker(settings: impl Fn() -> Settings, busy: impl Fn() -> bool) {
    std::thread::sleep(Duration::from_secs(40));
    if let Some(root) = settings().recordings_path() {
        prune(&root);
    }
    loop {
        let s = settings();
        let job = if enabled(&s) && !busy() { s.recordings_path().and_then(|root| next_wanted(&root)) } else { None };
        let Some(dir) = job else {
            std::thread::sleep(Duration::from_secs(30));
            continue;
        };
        let (ffmpeg, _) = s.ffmpeg_tools();
        match make(&ffmpeg, &dir, &busy) {
            Ok(true) => {}
            Ok(false) => std::thread::sleep(Duration::from_secs(30)),
            Err(e) => {
                log(format!("[copy] {e}"));
                // Do not try this one again; teammates get the original instead.
                let _ = std::fs::write(dir.join(FAILED), e.to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn teammates_are_told_what_to_fetch() {
        let dir = std::env::temp_dir().join(format!("rewatch-copy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let recent = now_ms() - 3600 * 1000;
        assert_eq!(state(&dir, recent, true), "pending");
        assert_eq!(state(&dir, recent, false), "off");
        assert_eq!(state(&dir, now_ms() - 30 * 24 * 3600 * 1000, true), "off");
        std::fs::write(dir.join(FAILED), "x").unwrap();
        assert_eq!(state(&dir, recent, true), "off");
        std::fs::write(dir.join(FILE), "x").unwrap();
        assert_eq!(state(&dir, recent, false), "ready");
        let _ = std::fs::remove_dir_all(&dir);
        // 1.7 GB for a 6.1 GB recording is worth it; 149 MB for a 26 MB one is not.
        assert!(worth_keeping(6130, 1684));
        assert!(!worth_keeping(26, 149));
        assert!(!worth_keeping(100, 90));
    }
}
