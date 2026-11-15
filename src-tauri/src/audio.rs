//! Three independent sound captures, each written to its own WAV file.
//!
//! Every file is laid out on the session clock: sample N of the file belongs to
//! session time N / 48000 s. Gaps (a silent app delivers no packets) are filled with
//! silence, and small clock differences between the sound device and the system are
//! corrected by padding or dropping a packet, so the tracks stay in step with the
//! video for the whole game.

use crate::settings::log;
use crate::winutil;
use anyhow::{anyhow, Result};
use std::fs::File;
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use wasapi::{AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

pub const RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
/// Bytes per frame as delivered by the capture client (32-bit float stereo).
const IN_FRAME: usize = 8;

#[derive(Debug, Clone, PartialEq)]
pub enum TrackKind {
    /// Sound of one process and its children (the game).
    Process(u32),
    /// Everything except Discord. Used for manual recordings where there is no game.
    SystemWithoutDiscord,
    /// The Discord app and its children.
    Discord,
    /// A microphone, by device id. None means the Windows default input.
    Mic(Option<String>),
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TrackResult {
    pub name: String,
    pub path: PathBuf,
    pub frames: u64,
    /// Loudest sample seen, 0.0 to 1.0. Zero means the track is silent throughout.
    pub peak: f32,
    pub error: Option<String>,
}

/// Session clock shared by every capture.
#[derive(Clone, Copy)]
pub struct Clock {
    pub start: Instant,
    pub start_qpc_100ns: u64,
}

impl Clock {
    pub fn now() -> Self {
        Self {
            start: Instant::now(),
            start_qpc_100ns: winutil::qpc_100ns(),
        }
    }
    pub fn secs(&self) -> f64 {
        self.start.elapsed().as_secs_f64()
    }
}

struct Wav {
    w: BufWriter<File>,
    frames: u64,
    peak: f32,
}

impl Wav {
    fn create(path: &Path) -> Result<Wav> {
        let f = File::create(path)?;
        let mut w = BufWriter::with_capacity(1 << 18, f);
        // Sizes are written as "unknown" so the file is readable even if the app dies
        // before finalize; they are patched when the recording ends cleanly.
        let byte_rate = RATE * CHANNELS as u32 * 2;
        w.write_all(b"RIFF")?;
        w.write_all(&0xFFFF_FFFFu32.to_le_bytes())?;
        w.write_all(b"WAVEfmt ")?;
        w.write_all(&16u32.to_le_bytes())?;
        w.write_all(&1u16.to_le_bytes())?;
        w.write_all(&CHANNELS.to_le_bytes())?;
        w.write_all(&RATE.to_le_bytes())?;
        w.write_all(&byte_rate.to_le_bytes())?;
        w.write_all(&(CHANNELS * 2).to_le_bytes())?;
        w.write_all(&16u16.to_le_bytes())?;
        w.write_all(b"data")?;
        w.write_all(&0xFFFF_FFFFu32.to_le_bytes())?;
        Ok(Wav {
            w,
            frames: 0,
            peak: 0.0,
        })
    }

    fn write_silence(&mut self, frames: u64) -> Result<()> {
        const ZERO: [u8; 4096] = [0u8; 4096];
        let mut bytes = frames * 4;
        while bytes > 0 {
            let n = bytes.min(ZERO.len() as u64) as usize;
            self.w.write_all(&ZERO[..n])?;
            bytes -= n as u64;
        }
        self.frames += frames;
        Ok(())
    }

    /// `data` is interleaved 32-bit float stereo.
    fn write_f32(&mut self, data: &[u8]) -> Result<()> {
        let mut out = Vec::with_capacity(data.len() / 2);
        for s in data.chunks_exact(4) {
            let v = f32::from_le_bytes([s[0], s[1], s[2], s[3]]);
            let a = v.abs();
            if a > self.peak {
                self.peak = a;
            }
            let i = (v.clamp(-1.0, 1.0) * 32767.0) as i16;
            out.extend_from_slice(&i.to_le_bytes());
        }
        self.w.write_all(&out)?;
        self.frames += (data.len() / IN_FRAME) as u64;
        Ok(())
    }

    fn finalize(mut self) -> Result<(u64, f32)> {
        self.w.flush()?;
        let data_bytes = (self.frames * 4).min(0xFFFF_FF00) as u32;
        let mut f = self.w.into_inner().map_err(|e| anyhow!("{e}"))?;
        f.seek(SeekFrom::Start(4))?;
        f.write_all(&(data_bytes + 36).to_le_bytes())?;
        f.seek(SeekFrom::Start(40))?;
        f.write_all(&data_bytes.to_le_bytes())?;
        Ok((self.frames, self.peak))
    }
}

fn open_client(kind: &TrackKind) -> Result<AudioClient> {
    let client = match kind {
        TrackKind::Process(pid) => AudioClient::new_application_loopback_client(*pid, true),
        TrackKind::Discord => {
            let pid = winutil::find_discord_root_pid().ok_or_else(|| anyhow!("Discord is not running"))?;
            AudioClient::new_application_loopback_client(pid, true)
        }
        TrackKind::SystemWithoutDiscord => {
            // Exclude Discord's tree if it runs, otherwise exclude ourselves (we make no sound).
            let pid = winutil::find_discord_root_pid().unwrap_or_else(std::process::id);
            AudioClient::new_application_loopback_client(pid, false)
        }
        TrackKind::Mic(id) => {
            let enumerator = DeviceEnumerator::new().map_err(|e| anyhow!("{e}"))?;
            // A chosen device that has since been unplugged falls back to the default.
            let dev = id
                .as_deref()
                .filter(|i| !i.is_empty())
                .and_then(|i| enumerator.get_device(i).ok())
                .map(Ok)
                .unwrap_or_else(|| enumerator.get_default_device(Direction::Capture))
                .map_err(|e| anyhow!("no microphone: {e}"))?;
            dev.get_iaudioclient()
        }
    };
    client.map_err(|e| anyhow!("{e}"))
}

/// Capture until `stop` is set. Returns when the file is closed.
pub fn run_track(
    name: &str,
    kind: TrackKind,
    path: PathBuf,
    clock: Clock,
    stop: Arc<AtomicBool>,
) -> TrackResult {
    let mut result = TrackResult {
        name: name.to_string(),
        path: path.clone(),
        frames: 0,
        peak: 0.0,
        error: None,
    };
    let _ = wasapi::initialize_mta();
    let mut wav = match Wav::create(&path) {
        Ok(w) => w,
        Err(e) => {
            result.error = Some(format!("cannot create file: {e}"));
            return result;
        }
    };

    let format = WaveFormat::new(32, 32, SampleType::Float, RATE as usize, CHANNELS as usize, None);
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: 0,
    };
    let mut buf = vec![0u8; IN_FRAME * RATE as usize]; // one second
    let mut last_open_error = String::new();

    'outer: while !stop.load(Ordering::Relaxed) {
        // (Re)open the source. Discord may start later or restart mid-game.
        let opened = (|| -> Result<_> {
            let mut client = open_client(&kind)?;
            client
                .initialize_client(&format, Direction::Capture, mode, None)
                .map_err(|e| anyhow!("{e}"))?;
            let event = client.set_get_eventhandle().map_err(|e| anyhow!("{e}"))?;
            let capture = client.get_audiocaptureclient().map_err(|e| anyhow!("{e}"))?;
            client.start_stream().map_err(|e| anyhow!("{e}"))?;
            Ok((client, event, capture))
        })();
        let (client, event, capture) = match opened {
            Ok(v) => v,
            Err(e) => {
                let msg = e.to_string();
                if msg != last_open_error {
                    log(format!("[audio:{name}] waiting: {msg}"));
                    last_open_error = msg;
                }
                for _ in 0..20 {
                    if stop.load(Ordering::Relaxed) {
                        break 'outer;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                continue;
            }
        };
        log(format!("[audio:{name}] capturing"));
        last_open_error.clear();
        let mut last_alive_check = Instant::now();

        loop {
            if stop.load(Ordering::Relaxed) {
                let _ = client.stop_stream();
                break 'outer;
            }
            let _ = event.wait_for_event(200);

            // Drain every packet that is ready.
            loop {
                let frames = match capture.get_next_packet_size() {
                    Ok(Some(n)) if n > 0 => n as usize,
                    Ok(_) => break,
                    Err(e) => {
                        log(format!("[audio:{name}] device lost: {e}"));
                        let _ = client.stop_stream();
                        continue 'outer;
                    }
                };
                let need = frames * IN_FRAME;
                if buf.len() < need {
                    buf.resize(need, 0);
                }
                let (got, info) = match capture.read_from_device(&mut buf[..need]) {
                    Ok(v) => v,
                    Err(e) => {
                        log(format!("[audio:{name}] read failed: {e}"));
                        let _ = client.stop_stream();
                        continue 'outer;
                    }
                };
                let got = got as u64;
                if got == 0 {
                    break;
                }

                // Where on the session clock does this packet start?
                let now_frames = (clock.secs() * RATE as f64) as i64;
                let by_arrival = now_frames - got as i64;
                let by_stamp = info.timestamp as i64 - clock.start_qpc_100ns as i64;
                let stamp_frames = (by_stamp as f64 / 1e7 * RATE as f64) as i64;
                // Trust the device timestamp only when it is plausible.
                let (target, slack) = if info.timestamp != 0
                    && (stamp_frames - by_arrival).abs() < (RATE as i64) / 2
                {
                    (stamp_frames, (RATE as i64) * 40 / 1000)
                } else {
                    (by_arrival, (RATE as i64) * 150 / 1000)
                };
                let written = wav.frames as i64;
                if target > written + slack {
                    if let Err(e) = wav.write_silence((target - written) as u64) {
                        result.error = Some(format!("write failed: {e}"));
                        break 'outer;
                    }
                } else if written > target + slack {
                    // We are ahead of the clock: skip this packet to fall back in line.
                    continue;
                }
                if let Err(e) = wav.write_f32(&buf[..got as usize * IN_FRAME]) {
                    result.error = Some(format!("write failed: {e}"));
                    break 'outer;
                }
            }

            // A per-app capture goes quiet forever when its app exits; notice and reopen.
            if last_alive_check.elapsed() > Duration::from_secs(3) {
                last_alive_check = Instant::now();
                let gone = match &kind {
                    TrackKind::Process(pid) => !winutil::pid_alive(*pid),
                    TrackKind::Discord => winutil::find_discord_root_pid().is_none(),
                    _ => false,
                };
                if gone {
                    let _ = client.stop_stream();
                    if matches!(kind, TrackKind::Process(_)) {
                        // The game is gone; nothing more will come.
                        while !stop.load(Ordering::Relaxed) {
                            std::thread::sleep(Duration::from_millis(100));
                        }
                        break 'outer;
                    }
                    continue 'outer;
                }
            }
        }
    }

    // Pad to the moment the session ended so all tracks have the same length.
    let end_frames = (clock.secs() * RATE as f64) as u64;
    if end_frames > wav.frames {
        let _ = wav.write_silence(end_frames - wav.frames);
    }
    match wav.finalize() {
        Ok((frames, peak)) => {
            result.frames = frames;
            result.peak = peak;
        }
        Err(e) => result.error = Some(format!("finalize failed: {e}")),
    }
    if result.error.is_none() && !last_open_error.is_empty() && result.peak == 0.0 {
        result.error = Some(last_open_error);
    }
    result
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    /// Windows' default "communications" input, which is what Discord uses unless told otherwise.
    pub is_default_comms: bool,
    /// Current input level 0.0 to 1.0. Only non-zero while some app has the device open.
    pub level: f32,
}

/// Active microphones on this PC.
pub fn list_microphones() -> Vec<MicInfo> {
    let _ = wasapi::initialize_mta();
    let mut out = Vec::new();
    let Ok(enumerator) = DeviceEnumerator::new() else { return out };
    let id_of = |role| {
        enumerator
            .get_default_device_for_role(Direction::Capture, role)
            .ok()
            .and_then(|d| d.get_id().ok())
    };
    let default = id_of(wasapi::Role::Console);
    let comms = id_of(wasapi::Role::Communications);
    let Ok(collection) = enumerator.get_device_collection(Direction::Capture) else { return out };
    for dev in &collection {
        let Ok(dev) = dev else { continue };
        let Ok(id) = dev.get_id() else { continue };
        out.push(MicInfo {
            name: dev.get_friendlyname().unwrap_or_else(|_| "Unknown device".into()),
            is_default: default.as_deref() == Some(id.as_str()),
            is_default_comms: comms.as_deref() == Some(id.as_str()),
            level: dev
                .get_audiometerinformation()
                .and_then(|m| m.get_peak_value())
                .unwrap_or(0.0),
            id,
        });
    }
    out
}

// ------------------------------------------------------------------ microphone check

/// The setup guide's microphone check: one device held open while the page keeps asking
/// how loud it is. It closes by itself a moment after the page stops asking.
struct MicCheck {
    device: String,
    started: Instant,
    /// Loudness as f32 bits, 0.0 to 1.0, falling back slowly after each sound.
    level: Arc<std::sync::atomic::AtomicU32>,
    asked: Arc<std::sync::Mutex<Instant>>,
    error: Arc<std::sync::Mutex<Option<String>>>,
    stop: Arc<AtomicBool>,
}

static MIC_CHECK: std::sync::Mutex<Option<MicCheck>> = std::sync::Mutex::new(None);

/// How loud microphone `device` is right now, 0.0 to 1.0 ("" is the Windows default).
/// The first call opens it; it is closed again a second and a half after the last.
pub fn mic_level(device: &str) -> Result<f32> {
    let mut slot = MIC_CHECK.lock().map_err(|_| anyhow!("the microphone check is stuck"))?;
    // A check that could not open the device is not retried on every call.
    let restart = match slot.as_ref() {
        Some(c) if c.device == device => c.stop.load(Ordering::Relaxed) && c.started.elapsed() > Duration::from_secs(3),
        _ => true,
    };
    if restart {
        if let Some(old) = slot.take() {
            old.stop.store(true, Ordering::Relaxed);
        }
        let check = MicCheck {
            device: device.to_string(),
            started: Instant::now(),
            level: Arc::new(std::sync::atomic::AtomicU32::new(0)),
            asked: Arc::new(std::sync::Mutex::new(Instant::now())),
            error: Arc::new(std::sync::Mutex::new(None)),
            stop: Arc::new(AtomicBool::new(false)),
        };
        let (dev, level, asked, error, stop) = (device.to_string(), check.level.clone(), check.asked.clone(), check.error.clone(), check.stop.clone());
        std::thread::spawn(move || run_mic_check(dev, level, asked, error, stop));
        *slot = Some(check);
    }
    let check = slot.as_ref().expect("set above");
    if let Ok(mut t) = check.asked.lock() {
        *t = Instant::now();
    }
    if let Some(e) = check.error.lock().ok().and_then(|e| e.clone()) {
        return Err(anyhow!(e));
    }
    Ok(f32::from_bits(check.level.load(Ordering::Relaxed)))
}

/// Close the microphone check now.
pub fn mic_check_stop() {
    if let Some(check) = MIC_CHECK.lock().ok().and_then(|mut s| s.take()) {
        check.stop.store(true, Ordering::Relaxed);
    }
}

fn run_mic_check(
    device: String,
    level: Arc<std::sync::atomic::AtomicU32>,
    asked: Arc<std::sync::Mutex<Instant>>,
    error: Arc<std::sync::Mutex<Option<String>>>,
    stop: Arc<AtomicBool>,
) {
    let _ = wasapi::initialize_mta();
    let kind = TrackKind::Mic(Some(device).filter(|d| !d.is_empty()));
    let format = WaveFormat::new(32, 32, SampleType::Float, RATE as usize, CHANNELS as usize, None);
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: 0,
    };
    let opened = (|| -> Result<_> {
        let mut client = open_client(&kind)?;
        client
            .initialize_client(&format, Direction::Capture, mode, None)
            .map_err(|e| anyhow!("{e}"))?;
        let event = client.set_get_eventhandle().map_err(|e| anyhow!("{e}"))?;
        let capture = client.get_audiocaptureclient().map_err(|e| anyhow!("{e}"))?;
        client.start_stream().map_err(|e| anyhow!("{e}"))?;
        Ok((client, event, capture))
    })();
    let (client, event, capture) = match opened {
        Ok(v) => v,
        Err(e) => {
            log(format!("[audio:check] could not open the microphone: {e}"));
            if let Ok(mut slot) = error.lock() {
                *slot = Some(format!("Could not open the microphone: {e}"));
            }
            stop.store(true, Ordering::Relaxed);
            return;
        }
    };
    let mut buf = vec![0u8; IN_FRAME * RATE as usize / 10];
    let mut window = 0f32;
    let mut shown = 0f32;
    let mut tick = Instant::now();
    'outer: while !stop.load(Ordering::Relaxed) {
        if asked.lock().map(|t| t.elapsed() > Duration::from_millis(1500)).unwrap_or(true) {
            break;
        }
        let _ = event.wait_for_event(100);
        loop {
            let frames = match capture.get_next_packet_size() {
                Ok(Some(n)) if n > 0 => n as usize,
                Ok(_) => break,
                Err(e) => {
                    log(format!("[audio:check] device lost: {e}"));
                    break 'outer;
                }
            };
            let need = frames * IN_FRAME;
            if buf.len() < need {
                buf.resize(need, 0);
            }
            let Ok((got, _)) = capture.read_from_device(&mut buf[..need]) else { break };
            for s in buf[..(got as usize * IN_FRAME).min(need)].chunks_exact(4) {
                window = window.max(f32::from_le_bytes([s[0], s[1], s[2], s[3]]).abs());
            }
        }
        // Twenty readings a second; a sound stays on the meter a moment after it ends.
        if tick.elapsed() >= Duration::from_millis(50) {
            tick = Instant::now();
            shown = window.max(shown * 0.7).min(1.0);
            window = 0.0;
            level.store(shown.to_bits(), Ordering::Relaxed);
        }
    }
    let _ = client.stop_stream();
    level.store(0, Ordering::Relaxed);
    stop.store(true, Ordering::Relaxed);
}
