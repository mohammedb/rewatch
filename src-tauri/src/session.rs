//! One recording: starts video, the sound tracks, the mouse log and the game-feed
//! reader on a shared clock, and joins everything into the final files at the end.

use crate::audio::{self, Clock, TrackKind, TrackResult};
use crate::liveclient::{self, LiveData};
use crate::settings::{log, Settings};
use crate::video::{self, run_tool, VideoRecorder};
use crate::winutil::{self, CaptureTarget};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub started_at: String,
    pub started_epoch_ms: i64,
    /// "game" (started automatically for a League game) or "manual".
    pub mode: String,
    pub queue_id: Option<i64>,
    pub queue_name: Option<String>,
    /// Riot's id for the game, when the League client could be asked.
    #[serde(default)]
    pub game_id: Option<i64>,
    pub target: CaptureTarget,
    pub fps: u32,
    pub codec: String,
    pub mouse: bool,
    /// Game keys were logged to `keys.csv`.
    #[serde(default)]
    pub keys: bool,
}

pub struct Session {
    pub meta: SessionMeta,
    pub dir: PathBuf,
    pub game_pid: Option<u32>,
    clock: Clock,
    stop: Arc<AtomicBool>,
    video: Option<VideoRecorder>,
    audio: Vec<JoinHandle<TrackResult>>,
    mouse: Option<JoinHandle<()>>,
    keys: Option<JoinHandle<()>>,
    live: Arc<Mutex<LiveData>>,
    live_thread: Option<JoinHandle<()>>,
    bookmarks: Arc<Mutex<Vec<f64>>>,
    hotkey_thread: Option<JoinHandle<()>>,
}

/// Watch the bookmark key and note the time of each press.
fn hotkey_loop(key: winutil::Hotkey, bookmarks: Arc<Mutex<Vec<f64>>>, clock: Clock, stop: Arc<AtomicBool>) {
    let mut was_down = winutil::hotkey_down(&key);
    while !stop.load(Ordering::Relaxed) {
        let down = winutil::hotkey_down(&key);
        if down && !was_down {
            if let Ok(mut b) = bookmarks.lock() {
                b.push(clock.secs());
            }
        }
        was_down = down;
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn mouse_loop(path: PathBuf, target: CaptureTarget, clock: Clock, stop: Arc<AtomicBool>) {
    let Ok(file) = fs::File::create(&path) else { return };
    let mut w = std::io::BufWriter::new(file);
    let _ = writeln!(w, "t_ms,x,y,buttons");
    let mut last: Option<(i32, i32, u8)> = None;
    let mut last_t = -1000i64;
    let mut last_flush = std::time::Instant::now();
    while !stop.load(Ordering::Relaxed) {
        if let Some((x, y, b)) = winutil::mouse_state() {
            let t = (clock.secs() * 1000.0) as i64;
            let (rx, ry) = (x - target.x, y - target.y);
            let changed_buttons = last.map(|l| l.2 != b).unwrap_or(true);
            let moved = last.map(|l| l.0 != rx || l.1 != ry).unwrap_or(true);
            // Button changes are always written; movement at most every 16 ms.
            if changed_buttons || (moved && t - last_t >= 16) {
                let _ = writeln!(w, "{t},{rx},{ry},{b}");
                last = Some((rx, ry, b));
                last_t = t;
            }
        }
        if last_flush.elapsed() > Duration::from_secs(2) {
            let _ = w.flush();
            last_flush = std::time::Instant::now();
        }
        std::thread::sleep(Duration::from_millis(8));
    }
    let _ = w.flush();
}

impl Session {
    /// Start recording. `game_pid` is the League game process when started
    /// automatically, or None for a manual recording of the primary display.
    pub fn start(settings: &Settings, game_pid: Option<u32>, client: liveclient::ClientInfo) -> Result<Session> {
        let queue = client.queue;
        let root = settings
            .recordings_path()
            .ok_or_else(|| anyhow!("No recordings folder is set yet"))?;
        let now = chrono::Local::now();
        let id = now.format("%Y-%m-%d_%H-%M-%S").to_string();
        let dir = root.join(&id);
        fs::create_dir_all(&dir)?;

        let target = winutil::capture_target(game_pid, 20);
        let (ffmpeg, _) = settings.ffmpeg_tools();
        let family = video::resolve_family(&ffmpeg, &target, settings);

        // Session time zero. The wall-clock value goes to FFmpeg, the monotonic one to
        // everything else; they are taken back to back.
        let clock = Clock::now();
        let ref_epoch_us = SystemTime::now().duration_since(UNIX_EPOCH)?.as_micros() as i64;
        let stop = Arc::new(AtomicBool::new(false));

        let meta = SessionMeta {
            id,
            started_at: now.to_rfc3339(),
            started_epoch_ms: now.timestamp_millis(),
            mode: if game_pid.is_some() { "game".into() } else { "manual".into() },
            queue_id: queue.as_ref().map(|q| q.0),
            queue_name: queue.map(|q| q.1),
            game_id: client.game_id,
            target,
            fps: settings.fps,
            codec: video::effective_codec(settings, family).to_string(),
            mouse: settings.mouse_tracking,
            // Only for League games: a manual recording has no game window to watch.
            keys: settings.key_tracking && game_pid.is_some(),
        };
        fs::write(dir.join("session.json"), serde_json::to_string_pretty(&meta)?)?;

        // Sound first (starts instantly), then video.
        let mut audio = Vec::new();
        let mut spawn_track = |name: &'static str, kind: TrackKind| {
            let (path, stop) = (dir.join(format!("{name}.wav")), stop.clone());
            audio.push(std::thread::spawn(move || audio::run_track(name, kind, path, clock, stop)));
        };
        spawn_track(
            "game",
            match game_pid {
                Some(pid) => TrackKind::Process(pid),
                None => TrackKind::SystemWithoutDiscord,
            },
        );
        if settings.record_discord {
            spawn_track("discord", TrackKind::Discord);
        }
        if settings.record_mic {
            let id = settings.mic_device.trim();
            spawn_track("mic", TrackKind::Mic((!id.is_empty()).then(|| id.to_string())));
        }

        let video = match VideoRecorder::start(&ffmpeg, &target, settings, family, ref_epoch_us, &dir.join("video.mkv")) {
            Ok(v) => v,
            Err(e) => {
                stop.store(true, Ordering::Relaxed);
                for h in audio {
                    let _ = h.join();
                }
                let _ = fs::remove_dir_all(&dir);
                return Err(e);
            }
        };

        let mouse = settings.mouse_tracking.then(|| {
            let (path, stop) = (dir.join("mouse.csv"), stop.clone());
            std::thread::spawn(move || mouse_loop(path, target, clock, stop))
        });

        let keys = match (meta.keys, game_pid) {
            (true, Some(pid)) => {
                let (path, stop) = (dir.join("keys.csv"), stop.clone());
                Some(std::thread::spawn(move || crate::keys::record_loop(path, pid, clock, stop)))
            }
            _ => None,
        };

        let live = Arc::new(Mutex::new(LiveData::default()));
        let live_thread = {
            let (live, stop, dump) = (live.clone(), stop.clone(), dir.join("live.json"));
            Some(std::thread::spawn(move || liveclient::poll_loop(live, clock, stop, Some(dump))))
        };

        log(format!(
            "[session {}] recording {}x{} @{}fps on output {} ({}, {} encoder)",
            meta.id, target.w, target.h, meta.fps, target.output_idx, meta.mode, family.label()
        ));
        let bookmarks = Arc::new(Mutex::new(Vec::new()));
        let hotkey_thread = winutil::parse_hotkey(&settings.bookmark_hotkey).map(|key| {
            let (bookmarks, stop) = (bookmarks.clone(), stop.clone());
            std::thread::spawn(move || hotkey_loop(key, bookmarks, clock, stop))
        });
        Ok(Session {
            meta,
            dir,
            game_pid,
            clock,
            stop,
            video: Some(video),
            audio,
            mouse,
            keys,
            live,
            live_thread,
            bookmarks,
            hotkey_thread,
        })
    }

    pub fn add_bookmark(&self) -> usize {
        let mut b = self.bookmarks.lock().unwrap();
        b.push(self.clock.secs());
        b.len()
    }

    pub fn bookmark_count(&self) -> usize {
        self.bookmarks.lock().map(|b| b.len()).unwrap_or(0)
    }

    pub fn video_alive(&mut self) -> bool {
        self.video.as_mut().map(|v| v.is_running()).unwrap_or(false)
    }

    /// Stop everything and produce the final files. Returns the match id.
    pub fn stop_and_finalize(mut self, settings: &Settings) -> Result<String> {
        if let Some(v) = self.video.take() {
            // Carry on even if FFmpeg did not stop cleanly: the sound threads still have
            // to be stopped and whatever video exists is still worth saving.
            if let Err(e) = v.stop() {
                log(format!("[session {}] video stop: {e}", self.meta.id));
            }
        }
        self.stop.store(true, Ordering::Relaxed);
        let mut tracks = Vec::new();
        for h in self.audio.drain(..) {
            if let Ok(r) = h.join() {
                tracks.push(r);
            }
        }
        if let Some(h) = self.mouse.take() {
            let _ = h.join();
        }
        if let Some(h) = self.keys.take() {
            let _ = h.join();
        }
        if let Some(h) = self.live_thread.take() {
            let _ = h.join();
        }
        if let Some(h) = self.hotkey_thread.take() {
            let _ = h.join();
        }
        let live = self.live.lock().map(|l| l.clone()).unwrap_or_default();
        let bookmarks = self.bookmarks.lock().map(|b| b.clone()).unwrap_or_default();
        finalize_dir(&self.dir, &self.meta, live, bookmarks, tracks, settings)
    }
}

fn file_size(p: &Path) -> u64 {
    fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// Join the raw capture files of one session folder into the final recording and
/// write `match.json`. Also used to rescue a recording that was interrupted.
pub fn finalize_dir(
    dir: &Path,
    meta: &SessionMeta,
    live: LiveData,
    bookmarks: Vec<f64>,
    tracks: Vec<TrackResult>,
    settings: &Settings,
) -> Result<String> {
    let (ffmpeg, _) = settings.ffmpeg_tools();
    let raw_video = dir.join("video.mkv");
    if file_size(&raw_video) == 0 {
        return Err(anyhow!("No video was captured"));
    }
    let p = |x: &Path| x.to_string_lossy().to_string();

    // When, on the session clock, the first video frame was taken.
    let video_start = video::probe(&ffmpeg, &raw_video).start;

    let has = |name: &str| file_size(&dir.join(format!("{name}.wav"))) > 44;
    let mut args: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error", "-i"].map(String::from).to_vec();
    args.push(p(&raw_video));
    // Each sound file starts at session time zero; skip ahead to where video begins.
    let mut inputs: Vec<&str> = Vec::new();
    for name in ["game", "discord", "mic"] {
        if has(name) {
            args.extend(["-ss".into(), format!("{video_start:.4}"), "-ignore_length".into(), "1".into(), "-i".into()]);
            args.push(p(&dir.join(format!("{name}.wav"))));
            inputs.push(name);
        }
    }
    let idx = |name: &str| inputs.iter().position(|n| *n == name).map(|i| i + 1);

    args.extend(["-map".into(), "0:v".into()]);
    if let Some(i) = idx("game") {
        args.extend(["-map".into(), format!("{i}:a"), "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
    }
    args.extend(["-c:v".into(), "copy".into()]);
    if meta.codec == "hevc" {
        args.extend(["-tag:v".into(), "hvc1".into()]);
    }
    let final_video = dir.join("game.mp4");
    args.push(p(&final_video));
    for name in ["discord", "mic"] {
        if let Some(i) = idx(name) {
            args.extend(["-map".into(), format!("{i}:a"), "-c:a".into(), "aac".into(), "-b:a".into(), "128k".into()]);
            args.push(p(&dir.join(format!("{name}.m4a"))));
        }
    }
    run_tool(&ffmpeg, &args)?;

    // Facts about the finished video.
    let facts = video::probe(&ffmpeg, &final_video);
    let width = if facts.width > 0 { facts.width } else { meta.target.w as i64 };
    let height = if facts.height > 0 { facts.height } else { meta.target.h as i64 };
    let duration = facts.duration;

    // Thumbnail from a fifth of the way in.
    let _ = run_tool(
        &ffmpeg,
        &[
            "-y", "-hide_banner", "-loglevel", "error", "-ss", &format!("{:.2}", duration * 0.2), "-i", &p(&final_video),
            "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", &p(&dir.join("thumb.jpg")),
        ]
        .map(String::from),
    );

    // Everything in match.json is in video time (session time minus video start).
    let to_media = |t: f64| (t - video_start).max(0.0);
    let mut events = live.events.clone();
    for e in &mut events {
        e.t = to_media(e.t);
    }
    events.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    let clock: Vec<[f64; 2]> = live.clock.iter().map(|c| [to_media(c[0]), c[1]]).collect();
    let mut stats = live.stats.clone();
    for t in &mut stats.t {
        *t = (to_media(*t) * 10.0).round() / 10.0;
    }

    let track_json: Vec<Value> = ["game", "discord", "mic"]
        .iter()
        .filter(|n| idx(n).is_some())
        .map(|n| {
            let r = tracks.iter().find(|t| t.name == *n);
            json!({
                "name": n,
                "file": if *n == "game" { Value::Null } else { json!(format!("{n}.m4a")) },
                "silent": r.map(|r| r.peak == 0.0).unwrap_or(false),
                "note": r.and_then(|r| r.error.clone()),
            })
        })
        .collect();

    let game = build_game_summary(&live, meta);
    let mouse_file = dir.join("mouse.csv");
    let keys_file = dir.join("keys.csv");
    let doc = json!({
        "version": 1,
        "id": meta.id,
        "startedAt": meta.started_at,
        "startedEpochMs": meta.started_epoch_ms,
        "mode": meta.mode,
        "duration": duration,
        "width": width,
        "height": height,
        "fps": meta.fps,
        "codec": meta.codec,
        "video": "game.mp4",
        "tracks": track_json,
        "game": game,
        "events": events,
        "clock": clock,
        "stats": if stats.t.len() > 1 { json!(stats) } else { Value::Null },
        "bookmarks": bookmarks.iter().map(|t| json!({ "t": to_media(*t) })).collect::<Vec<_>>(),
        "mouse": if meta.mouse && file_size(&mouse_file) > 20 {
            json!({ "file": "mouse.csv", "offset": video_start, "w": meta.target.w, "h": meta.target.h })
        } else { Value::Null },
        "keys": if meta.keys && file_size(&keys_file) > 20 {
            json!({ "file": "keys.csv", "offset": video_start, "names": crate::keys::names() })
        } else { Value::Null },
    });
    fs::write(dir.join("match.json"), serde_json::to_string_pretty(&doc)?)?;
    // When each sound track had someone talking, for the comms rows of the timeline.
    let _ = crate::voice::for_dir(&ffmpeg, dir);

    // Raw capture files are no longer needed.
    for f in ["video.mkv", "video.log", "game.wav", "discord.wav", "mic.wav", "live.json", "session.json"] {
        let _ = fs::remove_file(dir.join(f));
    }
    log(format!("[session {}] saved, {:.0}s, video starts at {:.3}s", meta.id, duration, video_start));
    Ok(meta.id.clone())
}

/// The champion's internal name, which is what Riot's image files are named after.
/// The feed gives it in two shapes: "game_character_displayname_MonkeyKing" and
/// "Character_MonkeyKing_Name". Falls back to the display name without punctuation.
pub fn champion_key(raw: &str, display: &str) -> String {
    let key = if let Some(k) = raw.strip_prefix("game_character_displayname_") {
        k
    } else if let Some(k) = raw.strip_prefix("Character_").and_then(|r| r.strip_suffix("_Name")) {
        k
    } else {
        ""
    };
    if !key.is_empty() {
        return key.to_string();
    }
    display.chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

/// Champion, result, KDA and scoreboard from the last read of the game feed.
fn build_game_summary(live: &LiveData, meta: &SessionMeta) -> Value {
    let Some(snap) = &live.snapshot else {
        return json!({ "queueId": meta.queue_id, "queueName": meta.queue_name, "result": Value::Null });
    };
    let str_of = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let champ_key = |v: &Value| champion_key(&str_of(v, "rawChampionName"), &str_of(v, "championName"));
    let me_name = live.me.clone().unwrap_or_default();
    let players: Vec<Value> = snap
        .get("allPlayers")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                // Practice Tool dummies come through as players without a champion.
                .filter(|p| !str_of(p, "championName").is_empty())
                .map(|p| {
                    let name = ["riotIdGameName", "summonerName"]
                        .iter()
                        .map(|k| str_of(p, k))
                        .find(|s| !s.is_empty())
                        .unwrap_or_default();
                    let sc = p.get("scores").cloned().unwrap_or(Value::Null);
                    let n = |k: &str| sc.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0) as i64;
                    json!({
                        "name": name,
                        "isMe": !me_name.is_empty() && (name == me_name || str_of(p, "summonerName") == me_name || str_of(p, "riotId") == me_name),
                        "champion": str_of(p, "championName"),
                        "championKey": champ_key(p),
                        "team": str_of(p, "team"),
                        // TOP, JUNGLE, MIDDLE, BOTTOM or UTILITY in matchmade games; empty otherwise.
                        "position": str_of(p, "position"),
                        "level": p.get("level").and_then(|x| x.as_i64()).unwrap_or(0),
                        "kills": n("kills"), "deaths": n("deaths"), "assists": n("assists"), "cs": n("creepScore"),
                        "wards": sc.get("wardScore").and_then(|x| x.as_f64()),
                        "items": p.get("items").and_then(|v| v.as_array()).map(|its| its.iter().map(|it| json!({
                            "id": it.get("itemID").and_then(|x| x.as_i64()).unwrap_or(0),
                            "name": str_of(it, "displayName"),
                        })).collect::<Vec<_>>()).unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let me = players.iter().find(|p| p["isMe"] == json!(true)).cloned().unwrap_or(Value::Null);
    json!({
        "queueId": meta.queue_id,
        "queueName": meta.queue_name,
        "gameId": meta.game_id,
        "mode": snap.pointer("/gameData/gameMode"),
        "map": snap.pointer("/gameData/mapName"),
        "length": snap.pointer("/gameData/gameTime"),
        "result": live.result,
        "me": me,
        "players": players,
    })
}

/// Finish recordings that were cut short (app or PC went down mid-game): any folder
/// that still has raw capture files and no match.json.
pub fn recover_interrupted(settings: &Settings, skip_id: Option<&str>) -> Vec<String> {
    let mut done = Vec::new();
    let Some(root) = settings.recordings_path() else { return done };
    let Ok(entries) = fs::read_dir(&root) else { return done };
    for entry in entries.flatten() {
        let dir = entry.path();
        let id = entry.file_name().to_string_lossy().to_string();
        if Some(id.as_str()) == skip_id || !dir.is_dir() {
            continue;
        }
        if dir.join("match.json").exists() || !dir.join("video.mkv").exists() {
            continue;
        }
        let Some(meta) = fs::read_to_string(dir.join("session.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<SessionMeta>(&s).ok())
        else {
            continue;
        };
        let live: LiveData = fs::read_to_string(dir.join("live.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        log(format!("[recover] finishing interrupted recording {id}"));
        match finalize_dir(&dir, &meta, live, Vec::new(), Vec::new(), settings) {
            Ok(id) => done.push(id),
            Err(e) => log(format!("[recover] {id} failed: {e}")),
        }
    }
    done
}

#[cfg(test)]
mod tests {
    use super::champion_key;

    #[test]
    fn champion_key_handles_both_feed_formats() {
        assert_eq!(champion_key("game_character_displayname_Lillia", "Lillia"), "Lillia");
        assert_eq!(champion_key("Character_Aatrox_Name", "Aatrox"), "Aatrox");
        assert_eq!(champion_key("game_character_displayname_MonkeyKing", "Wukong"), "MonkeyKing");
        assert_eq!(champion_key("", "Lee Sin"), "LeeSin");
        assert_eq!(champion_key("something_else", "Miss Fortune"), "MissFortune");
    }
}
