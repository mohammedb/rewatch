//! Champion select, kept with the game that follows it: the picks, bans and timer as
//! the League client reports them (see `champselect`), the Discord call and the
//! microphone, the client's own sound, and, if the player asks for it, a video of the
//! client's window. A champion select that ends without a game (someone dodged) is
//! thrown away.
//!
//! The game's folder does not exist yet while picks are made, so champion select is
//! recorded into a folder of its own and moved into the game's folder when the game's
//! process starts. Finishing the game then turns it into the files the player plays.
//!
//! The client is only asked: where it is in its flow (every couple of seconds, while it
//! is open and no game is running) and, during champion select, what is picked (once a
//! second). Nothing is clicked or sent to it.

use crate::audio::{self, Clock, TrackKind, TrackResult};
use crate::champselect;
use crate::session::{self, Layout};
use crate::settings::{log, Settings};
use crate::video::{self, run_tool, VideoRecorder};
use crate::winutil::{self, CaptureTarget};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The folder in the recordings folder that holds champion select until its game
/// starts. It has no match.json, so nothing that walks the recordings counts it.
pub const PENDING: &str = ".draft";

/// How champion select's files are named, next to the game's.
pub const FILES: Layout = Layout { raw: "draft.mkv", video: "draft.mp4", prefix: "draft-" };

/// The picks and bans, kept with the game for good.
pub const PICKS: &str = "draft-picks.json";

/// What champion select leaves in the game's folder until it is finished, and which
/// is deleted then.
pub const RAW_FILES: [&str; 6] = ["draft.mkv", "draft.log", "draft-game.wav", "draft-discord.wav", "draft-mic.wav", "draft.json"];

/// A kept champion select goes with a game that starts within this long after it.
const KEEP_FOR: Duration = Duration::from_secs(10 * 60);
/// Longer than any champion select: past this something is off, and it is let go.
const LONGEST: Duration = Duration::from_secs(20 * 60);
/// How long the client may not answer before champion select is taken to be over.
const NO_ANSWER: Duration = Duration::from_secs(20);

/// What a recording of champion select knows about itself, kept next to its files.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DraftMeta {
    pub started_epoch_ms: i64,
    #[serde(default)]
    pub ended_epoch_ms: Option<i64>,
    pub queue_id: Option<i64>,
    pub queue_name: Option<String>,
    /// What the video shows, when one is recorded.
    #[serde(default)]
    pub target: Option<CaptureTarget>,
    pub fps: u32,
    pub codec: String,
    /// How each sound track went (silent, or why it failed), once it has ended.
    #[serde(default)]
    pub tracks: Vec<TrackResult>,
}

/// Champion select being recorded.
pub struct Draft {
    pub meta: DraftMeta,
    dir: PathBuf,
    begun: Instant,
    /// When the client last said where it was.
    heard: Instant,
    stop: Arc<AtomicBool>,
    video: Option<VideoRecorder>,
    audio: Vec<JoinHandle<TrackResult>>,
    picks: Option<JoinHandle<champselect::Timeline>>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn read_meta(dir: &Path) -> Option<DraftMeta> {
    fs::read_to_string(dir.join("draft.json")).ok().and_then(|s| serde_json::from_str(&s).ok())
}

/// Whether champion select has begun, from the client's phase.
pub fn begins(phase: Option<&str>) -> bool {
    phase == Some("ChampSelect")
}

/// Why to let go of the champion select being recorded, if there is a reason. `phase`
/// is what the client says now (None: it did not answer), `silent` how long it has not
/// answered, `running` how long champion select has been recorded.
fn give_up(phase: Option<&str>, silent: Duration, running: Duration) -> Option<&'static str> {
    if running > LONGEST {
        return Some("it ran longer than any champion select");
    }
    match phase {
        // Still picking, or the game is being launched: carry on until the game's own
        // process appears, so nothing between the two is missed.
        Some("ChampSelect" | "GameStart" | "InProgress" | "Reconnect") => None,
        // Back to the lobby, the queue or nothing: no game follows.
        Some(_) => Some("champion select ended without a game"),
        None if silent > NO_ANSWER => Some("the League client stopped answering"),
        None => None,
    }
}

/// Start the video of the client's window (or, if the window can't be captured on its
/// own, of its screen). None if neither starts: champion select is still kept without.
fn start_video(settings: &Settings, client: u32, dir: &Path, ref_epoch_us: i64, meta: &mut DraftMeta) -> Option<VideoRecorder> {
    let (ffmpeg, _) = settings.ffmpeg_tools();
    let mut target = if session::wants_window(settings, &ffmpeg) {
        winutil::window_target(client, 1).unwrap_or_else(|| winutil::capture_target(Some(client), 0))
    } else {
        winutil::capture_target(Some(client), 0)
    };
    // A screen of menus: 30 frames a second is plenty.
    let mut s = settings.clone();
    s.fps = settings.fps.clamp(15, 30);
    let family = video::resolve_family(&ffmpeg, &target, &s);
    let raw = dir.join(FILES.raw);
    let mut started = VideoRecorder::start(&ffmpeg, &target, &s, family, ref_epoch_us, &raw);
    if started.is_err() && target.window.is_some() {
        log("[draft] the client's window could not be captured; recording its display");
        target = target.display();
        started = VideoRecorder::start(&ffmpeg, &target, &s, family, ref_epoch_us, &raw);
    }
    match started {
        Ok(v) => {
            meta.target = Some(target);
            meta.fps = s.fps;
            meta.codec = video::effective_codec(&s, family).to_string();
            Some(v)
        }
        Err(e) => {
            log(format!("[draft] no video of the client: {e}"));
            None
        }
    }
}

impl Draft {
    /// Start recording champion select. Fails only without a recordings folder or the
    /// client.
    pub fn start(settings: &Settings, queue: Option<(i64, String)>) -> Result<Draft> {
        let root = settings.recordings_path().ok_or_else(|| anyhow!("No recordings folder is set yet"))?;
        let client = winutil::find_pid_by_name(winutil::CLIENT_UX_EXE).ok_or_else(|| anyhow!("the League client is not open"))?;
        let dir = root.join(PENDING);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir)?;

        let clock = Clock::now();
        let ref_epoch_us = SystemTime::now().duration_since(UNIX_EPOCH)?.as_micros() as i64;
        let stop = Arc::new(AtomicBool::new(false));
        let mut meta = DraftMeta {
            started_epoch_ms: now_ms(),
            ended_epoch_ms: None,
            queue_id: queue.as_ref().map(|q| q.0),
            queue_name: queue.map(|q| q.1),
            target: None,
            fps: 0,
            codec: String::new(),
            tracks: Vec::new(),
        };

        // What is picked, on the same clock as the sound.
        let picks = {
            let (league, stop) = (settings.league_path(), stop.clone());
            Some(std::thread::spawn(move || champselect::follow(league, clock, stop)))
        };
        let mut audio = Vec::new();
        let mut spawn_track = |name: &'static str, kind: TrackKind| {
            let (path, stop) = (dir.join(format!("{}{name}.wav", FILES.prefix)), stop.clone());
            audio.push(std::thread::spawn(move || audio::run_track(name, kind, path, clock, stop)));
        };
        // The client's own sound: music, picks and lock-ins.
        spawn_track("game", TrackKind::Process(client));
        if settings.record_discord {
            spawn_track("discord", TrackKind::Discord);
        }
        if settings.record_mic {
            let id = settings.mic_device.trim();
            spawn_track("mic", TrackKind::Mic((!id.is_empty()).then(|| id.to_string())));
        }
        let video = if settings.draft_video { start_video(settings, client, &dir, ref_epoch_us, &mut meta) } else { None };

        fs::write(dir.join("draft.json"), serde_json::to_string_pretty(&meta)?)?;
        let seen = match meta.target {
            Some(t) if video.is_some() => format!(", and the client's {} at {}x{} @{}fps", t.kind(), t.w, t.h, meta.fps),
            _ => String::new(),
        };
        log(format!("[draft] recording champion select ({}): picks and bans{seen}", meta.queue_name.as_deref().unwrap_or("queue unknown")));
        let now = Instant::now();
        Ok(Draft { meta, dir, begun: now, heard: now, stop, video, audio, picks })
    }

    /// Why to stop and throw this champion select away, given what the client says
    /// now (None: it did not answer), or None to carry on.
    pub fn give_up(&mut self, phase: Option<&str>) -> Option<&'static str> {
        if phase.is_some() {
            self.heard = Instant::now();
        }
        give_up(phase, self.heard.elapsed(), self.begun.elapsed())
    }

    /// Stop recording. Kept, the files wait for the game in the pending folder (see
    /// `attach`); otherwise they are deleted.
    pub fn stop(mut self, keep: bool, why: &str) {
        if let Some(v) = self.video.take() {
            // The game is starting: don't hold it up. The client may hide its window by
            // then, and a window that sends nothing keeps FFmpeg from hearing "stop".
            if let Err(e) = v.stop_within(Duration::from_secs(3)) {
                log(format!("[draft] video stop: {e}"));
            }
        }
        self.stop.store(true, Ordering::Relaxed);
        let tracks: Vec<TrackResult> = self.audio.drain(..).filter_map(|h| h.join().ok()).collect();
        let timeline = self.picks.take().and_then(|h| h.join().ok()).unwrap_or_default();
        let secs = self.begun.elapsed().as_secs();
        if !keep {
            let _ = fs::remove_dir_all(&self.dir);
            log(format!("[draft] champion select thrown away ({secs}s): {why}"));
            return;
        }
        self.meta.ended_epoch_ms = Some(now_ms());
        self.meta.tracks = tracks;
        if !timeline.snapshots.is_empty() {
            let _ = fs::write(self.dir.join(PICKS), champselect::to_json(&timeline).to_string());
        }
        let _ = fs::write(self.dir.join("draft.json"), serde_json::to_string_pretty(&self.meta).unwrap_or_default());
        log(format!("[draft] champion select kept for its game ({secs}s, {} changes seen): {why}", timeline.snapshots.len()));
    }
}

/// Move a kept champion select into the folder of the game that follows it. Only one
/// that ended a few minutes before counts; anything else left over is thrown away.
pub fn attach(settings: &Settings, game_dir: &Path) -> bool {
    let Some(root) = settings.recordings_path() else { return false };
    let pending = root.join(PENDING);
    if !pending.exists() {
        return false;
    }
    let fresh = read_meta(&pending)
        .and_then(|m| m.ended_epoch_ms)
        .is_some_and(|end| now_ms() - end <= KEEP_FOR.as_millis() as i64);
    if fresh {
        for name in RAW_FILES.iter().chain(&[PICKS]) {
            let from = pending.join(name);
            if from.exists() {
                if let Err(e) = fs::rename(&from, game_dir.join(name)) {
                    log(format!("[draft] could not move {name} to the game: {e}"));
                }
            }
        }
        log(format!("[draft] champion select goes with {}", game_dir.display()));
    }
    let _ = fs::remove_dir_all(&pending);
    fresh
}

/// Throw away a champion select left over from before (the app closed during one).
pub fn clear_pending(settings: &Settings) {
    if let Some(root) = settings.recordings_path() {
        let pending = root.join(PENDING);
        if pending.exists() {
            let _ = fs::remove_dir_all(&pending);
            log("[draft] removed a champion select left over from before");
        }
    }
}

/// Champion select's sound without a video: each track as its own `.m4a`, starting
/// where champion select did. The names of the tracks made.
fn join_sound(ffmpeg: &Path, dir: &Path) -> Result<Vec<&'static str>> {
    let wav = |name: &str| dir.join(format!("{}{name}.wav", FILES.prefix));
    let p = |x: &Path| x.to_string_lossy().to_string();
    let names: Vec<&'static str> = ["game", "discord", "mic"].into_iter().filter(|n| session::file_size(&wav(n)) > 44).collect();
    if names.is_empty() {
        return Ok(names);
    }
    let mut args: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error"].map(String::from).to_vec();
    for name in &names {
        args.extend(["-ignore_length".into(), "1".into(), "-i".into(), p(&wav(name))]);
    }
    for (i, name) in names.iter().enumerate() {
        args.extend(["-map".into(), format!("{i}:a"), "-c:a".into(), "aac".into(), "-b:a".into(), "128k".into()]);
        args.push(p(&dir.join(format!("{}{name}.m4a", FILES.prefix))));
    }
    run_tool(ffmpeg, &args)?;
    Ok(names)
}

/// Turn the champion select recorded before the game in `dir` into the files the
/// player plays, and describe it for match.json. Null when there is none (the game
/// itself is never held up by it).
///
/// `offset` is where the picks' clock is in the sound and video: with a video, the
/// sound is cut to start with the picture, a moment into champion select.
pub fn finish(ffmpeg: &Path, dir: &Path) -> Value {
    let meta = read_meta(dir);
    let picks = dir.join(PICKS).exists();
    let results = meta.as_ref().map(|m| m.tracks.clone()).unwrap_or_default();
    let started = meta.as_ref().map(|m| m.started_epoch_ms);
    if session::file_size(&dir.join(FILES.raw)) > 0 {
        let codec = meta.as_ref().map(|m| m.codec.clone()).filter(|c| !c.is_empty()).unwrap_or_else(|| "h264".into());
        match session::join(ffmpeg, dir, &FILES, &codec) {
            Ok(joined) => {
                let facts = video::probe(ffmpeg, &dir.join(FILES.video));
                let target = meta.as_ref().and_then(|m| m.target);
                return json!({
                    "picks": picks.then_some(PICKS),
                    "video": FILES.video,
                    "offset": (joined.video_start * 1000.0).round() / 1000.0,
                    "duration": facts.duration,
                    "width": if facts.width > 0 { facts.width } else { target.map(|t| t.w as i64).unwrap_or(0) },
                    "height": if facts.height > 0 { facts.height } else { target.map(|t| t.h as i64).unwrap_or(0) },
                    "capture": target.map(|t| t.kind()),
                    "startedEpochMs": started,
                    "tracks": session::track_list(&joined, &results, &FILES),
                });
            }
            Err(e) => log(format!("[draft] {}: the video could not be joined: {e}", dir.display())),
        }
    }
    if !picks {
        return Value::Null;
    }
    let names = join_sound(ffmpeg, dir).unwrap_or_else(|e| {
        log(format!("[draft] {}: its sound could not be joined: {e}", dir.display()));
        Vec::new()
    });
    let duration = meta
        .as_ref()
        .and_then(|m| m.ended_epoch_ms.map(|end| (end - m.started_epoch_ms) as f64 / 1000.0))
        .unwrap_or(0.0);
    let tracks: Vec<Value> = names
        .iter()
        .map(|n| {
            let r = results.iter().find(|t| t.name == *n);
            json!({
                "name": n,
                "file": format!("{}{n}.m4a", FILES.prefix),
                "silent": r.map(|r| r.peak == 0.0).unwrap_or(false),
                "note": r.and_then(|r| r.error.clone()),
            })
        })
        .collect();
    json!({
        "picks": PICKS,
        "video": Value::Null,
        "offset": 0.0,
        "duration": duration,
        "startedEpochMs": started,
        "tracks": tracks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: Duration = Duration::from_secs(1);

    #[test]
    fn champion_select_is_followed_to_its_game_or_dropped() {
        assert!(begins(Some("ChampSelect")));
        for phase in [None, Some("Lobby"), Some("Matchmaking"), Some("ReadyCheck"), Some("InProgress")] {
            assert!(!begins(phase), "{phase:?}");
        }
        // Picking, then the game launching: carry on.
        for phase in ["ChampSelect", "GameStart", "InProgress", "Reconnect"] {
            assert_eq!(give_up(Some(phase), 0 * S, 90 * S), None, "{phase}");
        }
        // A dodge, or anything else that is not on the way to a game.
        for phase in ["Lobby", "Matchmaking", "ReadyCheck", "None", "FailedToLaunch", "EndOfGame", "TerminatedInError"] {
            assert!(give_up(Some(phase), 0 * S, 90 * S).is_some(), "{phase}");
        }
        // The client not answering for a moment is not the end; for long, it is.
        assert_eq!(give_up(None, 6 * S, 90 * S), None);
        assert!(give_up(None, 30 * S, 90 * S).is_some());
        // Nothing runs forever.
        assert!(give_up(Some("ChampSelect"), 0 * S, 21 * 60 * S).is_some());
    }

    fn meta(ended: Option<i64>, target: Option<CaptureTarget>) -> DraftMeta {
        DraftMeta {
            started_epoch_ms: 1_000,
            ended_epoch_ms: ended,
            queue_id: Some(420),
            queue_name: Some("Ranked Solo/Duo".into()),
            target,
            fps: 30,
            codec: if target.is_some() { "h264".into() } else { String::new() },
            tracks: Vec::new(),
        }
    }

    #[test]
    fn a_kept_champion_select_moves_to_its_game_only_while_fresh() {
        let base = std::env::temp_dir().join(format!("rewatch-draft-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("rec");
        let game = root.join("2026-11-16_21-00-00");
        fs::create_dir_all(&game).unwrap();
        let settings = Settings { recordings_dir: root.to_string_lossy().to_string(), ..Settings::default() };
        let pending = root.join(PENDING);
        let put = |ended: Option<i64>| {
            fs::create_dir_all(&pending).unwrap();
            for name in [PICKS, "draft-game.wav", "draft-discord.wav"] {
                fs::write(pending.join(name), b"x").unwrap();
            }
            fs::write(pending.join("draft.json"), serde_json::to_string(&meta(ended, None)).unwrap()).unwrap();
        };

        // Still being recorded (never ended), or ended long ago: not this game's.
        put(None);
        assert!(!attach(&settings, &game));
        assert!(!pending.exists() && !game.join(PICKS).exists());
        put(Some(now_ms() - 11 * 60 * 1000));
        assert!(!attach(&settings, &game));
        assert!(!pending.exists() && !game.join(PICKS).exists());

        // Ended a minute ago: it moves in, picks and all, and the pending folder goes.
        put(Some(now_ms() - 60 * 1000));
        assert!(attach(&settings, &game));
        assert!(!pending.exists());
        for name in [PICKS, "draft-game.wav", "draft-discord.wav", "draft.json"] {
            assert!(game.join(name).exists(), "{name}");
        }
        // The picks outlive the files finishing removes.
        assert!(!RAW_FILES.contains(&PICKS));
        // Nothing waiting: nothing happens.
        assert!(!attach(&settings, &game));
        // A recording with no champion select has nothing to finish.
        assert_eq!(finish(Path::new("ffmpeg"), &root.join("nothing-here")), Value::Null);
        let _ = fs::remove_dir_all(&base);
    }

    /// The bundled FFmpeg, which is not kept in git: tests that need it are skipped
    /// without it.
    fn bundled_ffmpeg() -> Option<PathBuf> {
        let ffmpeg = Path::new(env!("CARGO_MANIFEST_DIR")).join("bin").join("ffmpeg.exe");
        ffmpeg.exists().then_some(ffmpeg)
    }

    fn make(ffmpeg: &Path, dir: &Path, args: &[&str], out: &str) {
        let ok = std::process::Command::new(ffmpeg)
            .args(["-y", "-hide_banner", "-loglevel", "error"])
            .args(args)
            .arg(dir.join(out))
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "making {out}");
    }

    #[test]
    fn champion_select_is_joined_with_its_own_sound_tracks() {
        let Some(ffmpeg) = bundled_ffmpeg() else { return };
        let dir = std::env::temp_dir().join(format!("rewatch-draft-join-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // Video that began half a second into the capture, and test tones from its start.
        make(&ffmpeg, &dir, &["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "3", "-c:v", "libx264", "-output_ts_offset", "0.5"], "draft.mkv");
        for (name, hz) in [("game", 440), ("discord", 660), ("mic", 880)] {
            make(&ffmpeg, &dir, &["-f", "lavfi", "-i", &format!("sine=frequency={hz}:duration=3.5"), "-ar", "48000", "-ac", "2"], &format!("draft-{name}.wav"));
        }
        let target = CaptureTarget { adapter_idx: 0, output_idx: 0, x: 0, y: 0, w: 320, h: 180, window: Some(5) };
        fs::write(dir.join("draft.json"), serde_json::to_string(&meta(Some(4_500), Some(target))).unwrap()).unwrap();
        fs::write(dir.join(PICKS), "{}").unwrap();

        let v = finish(&ffmpeg, &dir);
        assert_eq!(v["video"], "draft.mp4");
        assert_eq!(v["picks"], PICKS);
        assert_eq!(v["capture"], "window");
        assert_eq!((v["width"].as_i64(), v["height"].as_i64()), (Some(320), Some(180)));
        let names: Vec<&str> = v["tracks"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        let files: Vec<Value> = v["tracks"].as_array().unwrap().iter().map(|t| t["file"].clone()).collect();
        assert_eq!(names, ["game", "discord", "mic"]);
        assert_eq!(files, [Value::Null, json!("draft-discord.m4a"), json!("draft-mic.m4a")]);
        // The picks' clock is half a second ahead of the picture and the sound beside it.
        assert!((v["offset"].as_f64().unwrap() - 0.5).abs() < 0.05, "offset {}", v["offset"]);
        // Each sound track starts where the video does and lasts as long.
        let length = |name: &str| video::probe(&ffmpeg, &dir.join(name)).duration;
        let picture = length("draft.mp4");
        assert!((picture - 3.0).abs() < 0.2, "draft.mp4 lasts {picture}s");
        for name in ["draft-discord.m4a", "draft-mic.m4a"] {
            assert!((length(name) - picture).abs() < 0.2, "{name} lasts {}s against {picture}s", length(name));
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn champion_select_without_a_video_keeps_its_picks_and_sound() {
        let Some(ffmpeg) = bundled_ffmpeg() else { return };
        let dir = std::env::temp_dir().join(format!("rewatch-draft-sound-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for (name, hz) in [("game", 440), ("discord", 660)] {
            make(&ffmpeg, &dir, &["-f", "lavfi", "-i", &format!("sine=frequency={hz}:duration=3.5"), "-ar", "48000", "-ac", "2"], &format!("draft-{name}.wav"));
        }
        fs::write(dir.join("draft.json"), serde_json::to_string(&meta(Some(4_500), None)).unwrap()).unwrap();
        fs::write(dir.join(PICKS), "{}").unwrap();

        let v = finish(&ffmpeg, &dir);
        assert_eq!(v["video"], Value::Null);
        assert_eq!(v["picks"], PICKS);
        assert_eq!(v["offset"], 0.0);
        assert_eq!(v["duration"], 3.5);
        // The client's sound has no video to be in: it is a file of its own.
        let files: Vec<Value> = v["tracks"].as_array().unwrap().iter().map(|t| t["file"].clone()).collect();
        assert_eq!(files, [json!("draft-game.m4a"), json!("draft-discord.m4a")]);
        for name in ["draft-game.m4a", "draft-discord.m4a"] {
            let secs = video::probe(&ffmpeg, &dir.join(name)).duration;
            assert!((secs - 3.5).abs() < 0.2, "{name} lasts {secs}s");
        }
        // Without picks there is nothing to show.
        fs::remove_file(dir.join(PICKS)).unwrap();
        assert_eq!(finish(&ffmpeg, &dir), Value::Null);
        let _ = fs::remove_dir_all(&dir);
    }
}
