//! Watching a teammate's view of the same game, by friend code.
//!
//! Every install has an identity (a key pair kept in the app folder). Its public half
//! is the "friend code". Two PCs that have each other's code connect directly across
//! the internet through iroh: encrypted end to end, no IP addresses, no router setup.
//! iroh's public helper servers are used to find the other PC and, when no direct
//! path exists, to pass the encrypted traffic along.
//!
//! A PC only answers people on its own friends list, and only hands out video with
//! game sound. Two recordings of one game are lined up through the in-game clock
//! each of them stored.

use crate::settings::{app_dir, log, Settings};
use anyhow::{anyhow, Result};
use iroh::endpoint::{presets, Connection, RecvStream, SendStream};
use iroh::{Endpoint, EndpointId, SecretKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, RwLock};
use std::time::Duration;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

const ALPN: &[u8] = b"rewatch/pov/1";
const MAX_REQUEST: usize = 64 * 1024;
/// Replies can be long: a list of every game, or a game's notes and drawings.
const MAX_REPLY: usize = 16 * 1024 * 1024;

// ------------------------------------------------------------- game matching

/// What one app tells another about a recording, enough to recognise the same game
/// and line the two videos up.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GameCard {
    pub id: String,
    pub game_id: Option<i64>,
    /// Wall-clock time at which the in-game clock read zero.
    pub game_start_ms: i64,
    /// Every player as "name|champion", sorted. Identifies a game when Riot's id is missing.
    pub roster: Vec<String>,
    pub player: String,
    pub champion: String,
    pub champion_key: String,
    /// The player's lane, when the game assigned one.
    pub position: String,
    /// Cursor log, if the recording has one: seconds to add to video time to get the
    /// log's time, and the size of the screen the positions were recorded on.
    pub mouse_offset: Option<f64>,
    pub mouse_w: i64,
    pub mouse_h: i64,
    pub duration: f64,
    /// Video time minus in-game time for this recording.
    pub offset: f64,
    /// Whether a smaller copy for teammates exists: "ready", "pending" (being made,
    /// wait for it) or "off" (take the original). Empty from apps older than 0.2.
    pub review: String,
}

/// Card for a recording, or None if it has no in-game clock (a manual screen recording).
pub fn card_from_match(doc: &Value) -> Option<GameCard> {
    let mut diffs: Vec<f64> = doc
        .get("clock")?
        .as_array()?
        .iter()
        .filter_map(|c| Some(c.get(0)?.as_f64()? - c.get(1)?.as_f64()?))
        .collect();
    if diffs.is_empty() {
        return None;
    }
    diffs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let offset = diffs[diffs.len() / 2];
    let text = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let mut roster: Vec<String> = doc
        .pointer("/game/players")
        .and_then(|p| p.as_array())
        .map(|a| a.iter().map(|p| format!("{}|{}", text(p, "name"), text(p, "champion"))).collect())
        .unwrap_or_default();
    roster.sort();
    let me = doc.pointer("/game/me").cloned().unwrap_or(Value::Null);
    Some(GameCard {
        id: text(doc, "id"),
        game_id: doc.pointer("/game/gameId").and_then(|x| x.as_i64()),
        game_start_ms: doc.get("startedEpochMs").and_then(|x| x.as_i64()).unwrap_or(0) + (offset * 1000.0) as i64,
        roster,
        player: text(&me, "name"),
        champion: text(&me, "champion"),
        champion_key: text(&me, "championKey"),
        position: text(&me, "position"),
        mouse_offset: doc.pointer("/mouse/offset").and_then(|x| x.as_f64()),
        mouse_w: doc.pointer("/mouse/w").and_then(|x| x.as_i64()).unwrap_or(0),
        mouse_h: doc.pointer("/mouse/h").and_then(|x| x.as_i64()).unwrap_or(0),
        duration: doc.get("duration").and_then(|x| x.as_f64()).unwrap_or(0.0),
        offset,
        review: String::new(),
    })
}

/// Whether two recordings are of the same game.
pub fn same_game(a: &GameCard, b: &GameCard) -> bool {
    if let (Some(x), Some(y)) = (a.game_id, b.game_id) {
        return x == y;
    }
    // Without Riot's id: the same ten players and champions, started within five minutes.
    !a.roster.is_empty() && a.roster == b.roster && (a.game_start_ms - b.game_start_ms).abs() < 5 * 60 * 1000
}

/// Every game recording in a folder: where it is, and its card. `copies_on` says
/// whether this app makes smaller copies for teammates (see `copies`).
pub fn cards_with_dirs(root: &Path, copies_on: bool) -> Vec<(PathBuf, GameCard)> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|e| {
            let text = std::fs::read_to_string(e.path().join("match.json")).ok()?;
            let doc = serde_json::from_str::<Value>(&text).ok()?;
            let mut card = card_from_match(&doc)?;
            let started = doc.get("startedEpochMs").and_then(|x| x.as_i64()).unwrap_or(0);
            card.review = crate::copies::state(&e.path(), started, copies_on).to_string();
            Some((e.path(), card))
        })
        .collect()
}

type CardList = Vec<(PathBuf, GameCard)>;
static CARDS: std::sync::Mutex<Option<(PathBuf, bool, std::time::Instant, CardList)>> = std::sync::Mutex::new(None);

/// The same list, read from disk at most every fifteen seconds. Teammates' apps ask
/// often, and reading every recording's file each time would be wasteful.
pub fn cached_cards(root: &Path, copies_on: bool) -> CardList {
    let mut slot = CARDS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((r, on, at, list)) = slot.as_ref() {
        if r == root && *on == copies_on && at.elapsed() < Duration::from_secs(15) {
            return list.clone();
        }
    }
    let list = cards_with_dirs(root, copies_on);
    *slot = Some((root.to_path_buf(), copies_on, std::time::Instant::now(), list.clone()));
    list
}

/// Just enough of a card to recognise the game: what is sent when asking about one.
fn key_of(card: &GameCard) -> GameCard {
    GameCard { game_id: card.game_id, game_start_ms: card.game_start_ms, roster: card.roster.clone(), ..Default::default() }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ------------------------------------------- notes, drawings and who talked

/// What a teammate wrote and drew on a game and when they spoke, in my video's time.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Extras {
    pub friend: String,
    pub code: String,
    pub player: String,
    pub champion: String,
    pub champion_key: String,
    pub notes: Vec<Value>,
    pub drawings: Vec<Value>,
    /// Stretches during which their microphone picked up speech.
    pub voice: Vec<[f64; 2]>,
    /// The titles their AI review gave the players of this game, if they have one.
    pub titles: Vec<Value>,
    /// Team reviews of fights they asked for, in my video's time.
    pub team: Vec<Value>,
}

/// What this PC tells a teammate about one of its recordings: notes and drawings (if
/// sharing those is on) and the times the microphone heard speech. Times are in this
/// recording's video time; `offset` lets the other side convert.
fn extras_reply(dir: &Path, card: &GameCard, share_notes: bool) -> Value {
    let read = |name: &str| std::fs::read_to_string(dir.join(name)).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let review = if share_notes { read("review.json") } else { None }.unwrap_or(Value::Null);
    let voice = read("voice.json").and_then(|v| v.get("mic").cloned()).unwrap_or(Value::Null);
    json!({
        "ok": true,
        "offset": card.offset,
        "player": card.player,
        "champion": card.champion,
        "championKey": card.champion_key,
        "notes": review.get("notes").cloned().unwrap_or(json!([])),
        "drawings": review.get("drawings").cloned().unwrap_or(json!([])),
        "voice": voice,
        // So the whole team sees the same titles when one of them has the AI review on.
        "titles": crate::coach::load(dir).and_then(|c| c.get("titles").cloned()).unwrap_or(json!([])),
        "team": crate::team::load(dir),
    })
}

/// Turn a teammate's reply into my video's time, keeping only well-formed entries.
pub fn extras_from_reply(reply: &Value, friend: &str, code: &str, my_offset: f64) -> Extras {
    let text = |v: &Value, k: &str, max: usize| v.get(k).and_then(|x| x.as_str()).unwrap_or("").chars().take(max).collect::<String>();
    // A moment at `t` in their video is at `t - shift` in mine.
    let shift = reply.get("offset").and_then(|x| x.as_f64()).unwrap_or(0.0) - my_offset;
    let list = |k: &str| reply.get(k).and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let player = text(reply, "player", 60);
    let notes = list("notes")
        .iter()
        .take(500)
        .filter_map(|n| {
            let mut note = json!({ "id": text(n, "id", 40), "t": n.get("t")?.as_f64()? - shift, "text": text(n, "text", 2000) });
            // A reply names the note it answers, so the thread reads the same on both PCs.
            let parent = text(n, "replyTo", 40);
            if !parent.is_empty() {
                note["replyTo"] = json!(parent);
            }
            Some(note)
        })
        .collect();
    let drawings = list("drawings")
        .iter()
        .take(500)
        .filter_map(|d| {
            let shapes: Vec<Value> = d
                .get("shapes")?
                .as_array()?
                .iter()
                .take(200)
                .filter_map(|s| {
                    let tool = s.get("tool")?.as_str()?;
                    let color = s.get("color")?.as_str()?;
                    let pts: Vec<[f64; 2]> = serde_json::from_value(s.get("pts")?.clone()).ok()?;
                    let ok = matches!(tool, "pen" | "arrow" | "circle")
                        && color.len() <= 9
                        && color.starts_with('#')
                        && color[1..].chars().all(|c| c.is_ascii_hexdigit())
                        && !pts.is_empty()
                        && pts.len() <= 5000;
                    ok.then(|| json!({ "tool": tool, "color": color, "pts": pts }))
                })
                .collect();
            // Drawn over their own recording unless the drawing says otherwise.
            let view = Some(text(d, "view", 60)).filter(|v| !v.is_empty()).unwrap_or_else(|| player.clone());
            Some(json!({ "id": text(d, "id", 40), "t": d.get("t")?.as_f64()? - shift, "view": view, "shapes": shapes }))
        })
        .collect();
    let voice = serde_json::from_value::<Vec<[f64; 2]>>(reply.get("voice").cloned().unwrap_or(Value::Null))
        .unwrap_or_default()
        .into_iter()
        .take(20000)
        .map(|s| [s[0] - shift, s[1] - shift])
        .collect();
    let titles = list("titles")
        .iter()
        .take(12)
        .filter_map(|t| {
            let (champion, title) = (text(t, "champion", 40), text(t, "title", 40));
            (!champion.is_empty() && !title.is_empty()).then(|| json!({ "champion": champion, "title": title, "why": text(t, "why", 240) }))
        })
        .collect();
    let lines = |v: &Value, k: &str| -> Vec<String> {
        v.get(k).and_then(|x| x.as_array()).map(|a| a.iter().take(5).filter_map(|s| s.as_str()).map(|s| s.chars().take(400).collect()).collect()).unwrap_or_default()
    };
    let team = list("team")
        .iter()
        .take(20)
        .filter_map(|r| {
            let players: Vec<Value> = r
                .get("players")
                .and_then(|p| p.as_array())
                .map(|a| a.iter().take(5).map(|p| json!({ "champion": text(p, "champion", 40), "did": text(p, "did", 400), "better": text(p, "better", 400) })).collect())
                .unwrap_or_default();
            Some(json!({
                "t": r.get("t")?.as_f64()? - shift,
                "end": r.get("end")?.as_f64()? - shift,
                "views": lines(r, "views"),
                "model": text(r, "model", 60),
                "summary": text(r, "summary", 500),
                "turningPoint": text(r, "turningPoint", 400),
                "shouldHave": lines(r, "shouldHave"),
                "players": players,
                "call": text(r, "call", 300),
            }))
        })
        .collect();
    Extras {
        team,
        titles,
        friend: friend.to_string(),
        code: code.to_string(),
        player,
        champion: text(reply, "champion", 60),
        champion_key: text(reply, "championKey", 60),
        notes,
        drawings,
        voice,
    }
}

fn extras_cache(dir: &Path, code: &str) -> PathBuf {
    dir.join(format!("{}.extras.json", save_prefix(code)))
}

/// Teammates' notes, drawings and speech times kept from earlier. Needs no connection.
pub fn saved_extras(dir: &Path, mine: &GameCard) -> Vec<Extras> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".extras.json"))
        .filter_map(|e| serde_json::from_str::<Value>(&std::fs::read_to_string(e.path()).ok()?).ok())
        .map(|v| {
            let text = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
            extras_from_reply(v.get("reply").unwrap_or(&Value::Null), &text("friend"), &text("code"), mine.offset)
        })
        .collect()
}

// ------------------------------------------------------------ watch together

/// One app telling its teammates where its player is: which game, which moment,
/// playing or paused. `ctl` goes up each time someone presses play, pause or seeks;
/// everyone follows the highest one they have seen.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WatchMsg {
    pub game: GameCard,
    pub t_game: f64,
    pub playing: bool,
    pub rate: f64,
    pub ctl: i64,
    pub name: String,
    pub stop: bool,
}

struct MyWatch {
    id: String,
    card: GameCard,
    ctl: i64,
    /// Whose position everyone is following. None means mine.
    leader: Option<EndpointId>,
    /// The other side of a game sent for coaching: who it came from, or went to.
    with: Vec<EndpointId>,
    /// The game was sent to me, so teammates have no part in it.
    received: bool,
}

#[derive(Default)]
struct WatchHub {
    mine: Option<MyWatch>,
    peers: HashMap<EndpointId, (WatchMsg, std::time::Instant)>,
    notify: Option<Arc<dyn Fn(Value) + Send + Sync>>,
}

type Hub = Arc<std::sync::Mutex<WatchHub>>;

/// What to do with a teammate's position report, given the session this app is in:
/// "control" (follow it now), "sync" (it is the leader's regular report: correct any
/// drift) or "presence" (just note that they are there).
fn watch_kind(mine: &mut MyWatch, peer: EndpointId, msg: &WatchMsg) -> &'static str {
    if msg.ctl > mine.ctl {
        mine.ctl = msg.ctl;
        mine.leader = Some(peer);
        "control"
    } else if msg.ctl == mine.ctl && mine.leader == Some(peer) {
        "sync"
    } else {
        "presence"
    }
}

fn note_watch(hub: &Hub, peer: EndpointId, msg: WatchMsg) {
    let Ok(mut h) = hub.lock() else { return };
    let code = peer.to_string();
    let event = if msg.stop {
        h.peers.remove(&peer);
        json!({ "kind": "left", "code": code, "name": msg.name })
    } else {
        let mut event = json!({ "kind": "presence", "code": code, "name": msg.name, "playing": msg.playing, "rate": msg.rate });
        if let Some(mine) = h.mine.as_mut() {
            if same_game(&msg.game, &mine.card) {
                event["kind"] = json!(watch_kind(mine, peer, &msg));
                event["matchId"] = json!(mine.id);
                event["t"] = json!(msg.t_game + mine.card.offset);
            }
        }
        h.peers.insert(peer, (msg, std::time::Instant::now()));
        event
    };
    let notify = h.notify.clone();
    drop(h);
    if let Some(f) = notify {
        f(event);
    }
}

fn game_running() -> bool {
    crate::winutil::find_pid_by_name(&crate::winutil::game_exe()).is_some()
}

// --------------------------------------------------- views saved for offline

/// File name stem for a teammate's saved view inside one of my recording folders.
fn save_prefix(code: &str) -> String {
    format!("pov_{}", code.chars().filter(|c| c.is_ascii_alphanumeric()).take(12).collect::<String>())
}

/// A teammate's view saved next to my own recording, so it still plays when they are
/// offline. Lives in my recording's folder, so it counts towards the size limit and
/// is deleted together with the recording.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SavedView {
    pub friend: String,
    pub code: String,
    pub card: GameCard,
}

/// Complete saved views in one recording folder. The small note file is written
/// last, so its presence means the video beside it is whole.
pub fn saved_views(dir: &Path) -> Vec<SavedView> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.starts_with("pov_") && name.ends_with(".json")
        })
        .filter_map(|e| serde_json::from_str::<SavedView>(&std::fs::read_to_string(e.path()).ok()?).ok())
        .filter(|v| dir.join(format!("{}.mp4", save_prefix(&v.code))).exists())
        .collect()
}

fn pov_from_saved(v: &SavedView, dir: &Path, mine: &GameCard) -> Pov {
    let prefix = save_prefix(&v.code);
    let csv = dir.join(format!("{prefix}.csv"));
    let has_mouse = v.card.mouse_offset.is_some() && csv.exists();
    Pov {
        friend: v.friend.clone(),
        code: v.code.clone(),
        status: "ready".into(),
        cached: true,
        player: v.card.player.clone(),
        champion: v.card.champion.clone(),
        champion_key: v.card.champion_key.clone(),
        position: v.card.position.clone(),
        shift: v.card.offset - mine.offset,
        duration: v.card.duration,
        video: Some(dir.join(format!("{prefix}.mp4")).to_string_lossy().to_string()),
        mouse: has_mouse.then(|| csv.to_string_lossy().to_string()),
        mouse_offset: v.card.mouse_offset.unwrap_or(0.0),
        mouse_w: v.card.mouse_w,
        mouse_h: v.card.mouse_h,
        saving: None,
    }
}

/// The views already saved for one recording. Needs no connection.
pub fn saved_povs(dir: &Path, mine: &GameCard) -> Vec<Pov> {
    saved_views(dir).iter().map(|v| pov_from_saved(v, dir, mine)).collect()
}

#[derive(Clone)]
struct SaveJob {
    dir: PathBuf,
    peer: EndpointId,
    friend: String,
    code: String,
    card: GameCard,
    tries: u32,
}

type SaveQueue = Arc<std::sync::Mutex<std::collections::VecDeque<SaveJob>>>;
/// Bytes saved so far and total, per "folder|code".
type SaveProgress = Arc<std::sync::Mutex<HashMap<String, (u64, u64)>>>;

fn save_key(dir: &Path, code: &str) -> String {
    format!("{}|{}", dir.to_string_lossy(), code)
}

fn enqueue(queue: &SaveQueue, job: SaveJob) {
    if job.dir.join(format!("{}.json", save_prefix(&job.code))).exists() {
        return;
    }
    if let Ok(mut q) = queue.lock() {
        if !q.iter().any(|j| j.dir == job.dir && j.code == job.code) {
            q.push_back(job);
        }
    }
}

/// Copy one teammate's view (video, then cursor log) into my recording's folder.
/// A download that was cut short carries on from where it stopped.
async fn save_view(
    endpoint: &Endpoint,
    conns: &tokio::sync::Mutex<HashMap<EndpointId, Connection>>,
    job: &SaveJob,
    progress: &SaveProgress,
) -> Result<()> {
    let prefix = save_prefix(&job.code);
    // Take the smaller copy made for teammates when there is one. If it is still
    // being made, come back later rather than fetching the full recording.
    let (remote, part) = match job.card.review.as_str() {
        "ready" => (crate::copies::FILE, job.dir.join(format!("{prefix}.r.mp4.part"))),
        "pending" => return Err(anyhow!("their smaller copy is still being made")),
        _ => ("game.mp4", job.dir.join(format!("{prefix}.mp4.part"))),
    };
    let done = job.dir.join(format!("{prefix}.mp4"));
    let key = save_key(&job.dir, &job.code);
    if !done.exists() {
        let have = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
        let want = json!({ "op": "file", "id": job.card.id, "file": remote, "start": have, "bulk": true });
        match ask(endpoint, conns, job.peer, want).await {
            Ok((head, mut recv)) => {
                let total = head.get("total").and_then(|x| x.as_u64()).unwrap_or(0);
                let mut file = tokio::fs::OpenOptions::new().create(true).append(true).open(&part).await?;
                let mut got = have;
                let mut buf = vec![0u8; 256 * 1024];
                let mut checked = std::time::Instant::now();
                loop {
                    match recv.read(&mut buf).await {
                        Ok(Some(n)) if n > 0 => {
                            file.write_all(&buf[..n]).await?;
                            got += n as u64;
                            if let Ok(mut p) = progress.lock() {
                                p.insert(key.clone(), (got, total));
                            }
                        }
                        Ok(_) => break,
                        Err(_) => return Err(anyhow!("interrupted")),
                    }
                    // Never compete with a game for the connection.
                    if checked.elapsed() > Duration::from_secs(2) {
                        checked = std::time::Instant::now();
                        if game_running() {
                            return Err(anyhow!("paused for a game"));
                        }
                    }
                }
                file.flush().await?;
                drop(file);
                if got < total {
                    return Err(anyhow!("incomplete"));
                }
            }
            // Asking to continue past the end means the part file is already whole.
            Err(e) if e.to_string() == "range" && have > 0 => {}
            Err(e) => return Err(e),
        }
        tokio::fs::rename(&part, &done).await?;
    }
    if job.card.mouse_offset.is_some() {
        let want = json!({ "op": "file", "id": job.card.id, "file": "mouse.csv", "bulk": true });
        if let Ok((_, mut recv)) = ask(endpoint, conns, job.peer, want).await {
            if let Ok(bytes) = recv.read_to_end(64 * 1024 * 1024).await {
                let _ = tokio::fs::write(job.dir.join(format!("{prefix}.csv")), bytes).await;
            }
        }
    }
    let note = SavedView { friend: job.friend.clone(), code: job.code.clone(), card: job.card.clone() };
    tokio::fs::write(job.dir.join(format!("{prefix}.json")), serde_json::to_vec(&note)?).await?;
    Ok(())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Bytes to send for a request that starts at `start` and optionally ends at `end`.
pub fn clamp_range(start: u64, end: Option<u64>, total: u64) -> Option<(u64, u64)> {
    if total == 0 || start >= total {
        return None;
    }
    let end = end.unwrap_or(total - 1).min(total - 1);
    (start <= end).then_some((start, end))
}

/// Start and optional end from an HTTP `Range` header. No header means from the start.
pub fn parse_range(value: Option<&str>) -> (u64, Option<u64>) {
    let Some(spec) = value.and_then(|v| v.trim().strip_prefix("bytes=")) else { return (0, None) };
    let Some((a, b)) = spec.split_once('-') else { return (0, None) };
    (a.trim().parse().unwrap_or(0), b.trim().parse().ok())
}

// ------------------------------------------------------------------ identity

/// This install's key pair. Created on first use and kept in the app folder.
pub fn load_identity(path: &Path) -> SecretKey {
    if let Some(key) = std::fs::read_to_string(path).ok().and_then(|s| SecretKey::from_str(s.trim()).ok()) {
        return key;
    }
    let key = SecretKey::generate();
    let hex: String = key.to_bytes().iter().map(|b| format!("{b:02x}")).collect();
    if let Err(e) = std::fs::write(path, hex) {
        log(format!("[pov] could not save identity: {e}"));
    }
    key
}

pub fn identity_path() -> PathBuf {
    app_dir().join("identity.key")
}

/// The friend code to hand to teammates. Known without going online.
pub fn my_code() -> String {
    load_identity(&identity_path()).public().to_string()
}

pub fn parse_code(code: &str) -> Option<EndpointId> {
    EndpointId::from_str(code.trim()).ok()
}

// -------------------------------------------------------------------- engine

/// Who may ask this PC for recordings, and what it serves.
#[derive(Default)]
struct Policy {
    share: bool,
    friends: HashSet<EndpointId>,
    name: String,
    root: Option<PathBuf>,
    /// Smaller copies for teammates are being made on this PC.
    copies: bool,
    /// Notes and drawings are shared with teammates.
    notes: bool,
    /// People whose games are accepted for coaching, with the name they go by here.
    students: HashMap<EndpointId, String>,
    /// Where the games they send are kept.
    inbox: Option<PathBuf>,
    /// The list of games this PC has sent to coaches.
    shares: PathBuf,
}

fn policy_from(settings: &Settings) -> Policy {
    Policy {
        students: settings.students.iter().filter_map(|f| Some((parse_code(&f.code)?, f.name.clone()))).collect(),
        inbox: crate::sharing::inbox(settings),
        shares: crate::sharing::store(),
        share: settings.share_with_friends,
        friends: settings.friends.iter().filter_map(|f| parse_code(&f.code)).collect(),
        name: settings.share_name.clone(),
        root: settings.recordings_path(),
        copies: crate::copies::enabled(settings),
        notes: settings.share_notes,
    }
}

/// Someone who is not on the teammates list and tried to connect. Shown in Settings
/// so pairing takes one click instead of a second pasted code.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PairRequest {
    pub code: String,
    pub name: String,
    pub at_ms: i64,
}

type Requests = Arc<std::sync::Mutex<Vec<PairRequest>>>;

fn note_request(requests: &Requests, peer: EndpointId, req: &Value) {
    let name: String = req
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect();
    let code = peer.to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let Ok(mut list) = requests.lock() else { return };
    if let Some(known) = list.iter_mut().find(|r| r.code == code) {
        if !name.is_empty() {
            known.name = name;
        }
        known.at_ms = now;
        return;
    }
    log(format!(
        "[pov] {} ({}) asked to connect but is not on your teammates list",
        peer.fmt_short(),
        if name.is_empty() { "no name" } else { name.as_str() }
    ));
    if list.len() >= 20 {
        list.remove(0);
    }
    list.push(PairRequest { code, name, at_ms: now });
}

// ------------------------------------------------------ games sent for coaching

/// Someone who is not accepted yet and wants to send this PC a game.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub code: String,
    pub name: String,
    /// The recording's id on their PC, and when they sent it.
    pub id: String,
    pub at: i64,
    pub game: Value,
    pub message: String,
    pub at_ms: i64,
}

/// One game to fetch from a student.
#[derive(Clone)]
struct Receive {
    peer: EndpointId,
    code: String,
    name: String,
    inbox: PathBuf,
    pkg: Value,
    tries: u32,
}

#[derive(Default)]
struct Coaching {
    /// Offers waiting for a yes.
    offers: std::sync::Mutex<Vec<Offer>>,
    /// Students whose apps should be asked what they have sent.
    ask: std::sync::Mutex<Vec<EndpointId>>,
    jobs: std::sync::Mutex<std::collections::VecDeque<Receive>>,
    /// Games arriving right now, by "code|id".
    progress: std::sync::Mutex<HashMap<String, Value>>,
    /// People whose wish to send a game has been announced since the app started.
    /// Anyone with this PC's code can offer, so each is announced once, not per offer.
    told: std::sync::Mutex<HashSet<String>>,
    notify: std::sync::Mutex<Option<Arc<dyn Fn(&str, Value) + Send + Sync>>>,
}

type Coach = Arc<Coaching>;

impl Coaching {
    /// Tell the app something happened: "offer", "received" or "share".
    fn tell(&self, kind: &str, what: Value) {
        let f = self.notify.lock().ok().and_then(|n| n.clone());
        if let Some(f) = f {
            f(kind, what);
        }
    }

    fn ask_soon(&self, peer: EndpointId) {
        if let Ok(mut ask) = self.ask.lock() {
            if !ask.contains(&peer) {
                ask.push(peer);
            }
        }
    }
}

fn note_offer(coach: &Coach, peer: EndpointId, req: &Value) {
    let text = |k: &str, max: usize| crate::sharing::clean(req.get(k).and_then(|x| x.as_str()).unwrap_or(""), max);
    let id = text("id", 80);
    if !valid_id(&id) {
        return;
    }
    let offer = Offer {
        code: peer.to_string(),
        name: text("name", 40),
        id,
        at: req.get("at").and_then(|x| x.as_i64()).unwrap_or(0),
        game: crate::sharing::clean_summary(req.get("game").unwrap_or(&Value::Null)),
        message: text("message", 500),
        at_ms: now_ms(),
    };
    {
        let Ok(mut list) = coach.offers.lock() else { return };
        let theirs = list.iter().filter(|o| o.code == offer.code).count();
        match list.iter().position(|o| o.code == offer.code && o.id == offer.id) {
            Some(i) => list[i] = offer.clone(),
            // A few per person and a few people at most: a stranger cannot fill the list.
            None if theirs >= 5 => return,
            None => {
                if list.len() >= 20 {
                    list.remove(0);
                }
                list.push(offer.clone());
            }
        }
    }
    let fresh = coach.told.lock().map(|mut told| told.len() < 200 && told.insert(offer.code.clone())).unwrap_or(false);
    if fresh {
        log(format!("[coach] {} ({}) wants to send a game", peer.fmt_short(), if offer.name.is_empty() { "no name" } else { offer.name.as_str() }));
        coach.tell("offer", serde_json::to_value(&offer).unwrap_or(Value::Null));
    }
}

/// One whole file of a game sent to this PC, into memory. For the small ones.
async fn fetch_shared(
    endpoint: &Endpoint,
    conns: &tokio::sync::Mutex<HashMap<EndpointId, Connection>>,
    peer: EndpointId,
    id: &str,
    name: &str,
    max: usize,
) -> Result<Vec<u8>> {
    let want = json!({ "op": "file", "id": id, "file": name, "shared": true, "bulk": true });
    let (_, mut recv) = ask(endpoint, conns, peer, want).await?;
    recv.read_to_end(max).await.map_err(|_| anyhow!("interrupted"))
}

/// Fetch a game a student sent and file it under `Coaching`: the video first (it
/// carries on from where it stopped if the connection drops), then the files that go
/// with it, and `match.json` last, so a game is only listed once it is whole.
/// Returns this PC's id for it.
async fn receive(
    endpoint: &Endpoint,
    conns: &tokio::sync::Mutex<HashMap<EndpointId, Connection>>,
    job: &Receive,
    coach: &Coach,
) -> Result<String> {
    let pkg = &job.pkg;
    let id = pkg.get("id").and_then(|x| x.as_str()).filter(|id| valid_id(id)).ok_or_else(|| anyhow!("bad offer"))?.to_string();
    let at = pkg.get("at").and_then(|x| x.as_i64()).unwrap_or(0);
    let comms = pkg.get("comms").and_then(|x| x.as_bool()).unwrap_or(false);
    let remote = pkg.pointer("/video/file").and_then(|x| x.as_str()).unwrap_or("");
    let size = pkg.pointer("/video/size").and_then(|x| x.as_u64()).unwrap_or(0);
    // Their smaller copy is this PC's whole video of the game.
    let local = match remote {
        "review.mp4" | "game.mp4" => "game.mp4",
        crate::highlights::REEL_FILE => crate::highlights::REEL_FILE,
        _ => return Err(anyhow!("bad offer")),
    };
    let folder = crate::sharing::folder(&id, &job.code);
    let dir = job.inbox.join(&folder);
    tokio::fs::create_dir_all(&dir).await?;
    let key = format!("{}|{id}", job.code);
    let game = crate::sharing::clean_summary(pkg.get("game").unwrap_or(&Value::Null));
    let show = |got: u64, total: u64| {
        if let Ok(mut p) = coach.progress.lock() {
            p.insert(key.clone(), json!({ "code": job.code, "name": job.name, "id": id, "game": game, "got": got, "total": total }));
        }
    };
    let done = dir.join(local);
    let part = dir.join(format!("{local}.part"));
    // Listed as arriving from here on, which also keeps it from being queued again.
    show(if done.exists() { size } else { 0 }, size);
    if !done.exists() {
        let have = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
        show(have, size);
        let room = crate::winutil::free_bytes(&job.inbox).unwrap_or(u64::MAX);
        if room < size.saturating_sub(have).saturating_add(1 << 30) {
            return Err(anyhow!("not enough room on the drive"));
        }
        let want = json!({ "op": "file", "id": id, "file": remote, "start": have, "shared": true, "bulk": true });
        match ask(endpoint, conns, job.peer, want).await {
            Ok((head, mut recv)) => {
                let total = head.get("total").and_then(|x| x.as_u64()).unwrap_or(0);
                let mut file = tokio::fs::OpenOptions::new().create(true).append(true).open(&part).await?;
                let mut got = have;
                let mut buf = vec![0u8; 256 * 1024];
                let mut checked = std::time::Instant::now();
                loop {
                    match recv.read(&mut buf).await {
                        Ok(Some(n)) if n > 0 => {
                            file.write_all(&buf[..n]).await?;
                            got += n as u64;
                            show(got, total);
                        }
                        Ok(_) => break,
                        Err(_) => return Err(anyhow!("interrupted")),
                    }
                    // Never compete with a game for the connection.
                    if checked.elapsed() > Duration::from_secs(2) {
                        checked = std::time::Instant::now();
                        if game_running() {
                            return Err(anyhow!("paused for a game"));
                        }
                    }
                }
                file.flush().await?;
                drop(file);
                if got < total {
                    return Err(anyhow!("incomplete"));
                }
            }
            // Asking to continue past the end means the part file is already whole.
            Err(e) if e.to_string() == "range" && have > 0 => {}
            Err(e) => return Err(e),
        }
        tokio::fs::rename(&part, &done).await?;
    }
    // Only names this app knows are ever written, whatever their app lists.
    let names: Vec<String> = pkg
        .get("files")
        .and_then(|f| f.as_array())
        .map(|a| a.iter().take(30).filter_map(|f| f.get("name").and_then(|n| n.as_str()).map(String::from)).collect())
        .unwrap_or_default();
    for name in names.iter().filter(|n| n.as_str() != "match.json" && crate::sharing::carried(n, comms)) {
        let max = if name.ends_with(".m4a") { 512 } else { 64 } * 1024 * 1024;
        match fetch_shared(endpoint, conns, job.peer, &id, name, max).await {
            Ok(bytes) => tokio::fs::write(dir.join(name), bytes).await?,
            // Gone since it was listed: the game is still worth having.
            Err(e) if e.to_string() == "not_found" => {}
            Err(e) => return Err(e),
        }
    }
    // The player's own notes and drawings on it, kept so they show without a connection.
    if let Ok((reply, _)) = ask(endpoint, conns, job.peer, json!({ "op": "extras", "shared": id })).await {
        let keep = json!({ "friend": job.name, "code": job.code, "reply": reply });
        let _ = tokio::fs::write(extras_cache(&dir, &job.code), keep.to_string()).await;
    }
    let bytes = fetch_shared(endpoint, conns, job.peer, &id, "match.json", 32 * 1024 * 1024).await?;
    let from = crate::sharing::From {
        name: job.name.clone(),
        code: job.code.clone(),
        id: id.clone(),
        at,
        comms,
        message: crate::sharing::clean(pkg.get("message").and_then(|x| x.as_str()).unwrap_or(""), 500),
        received_at: now_ms(),
    };
    let doc = crate::sharing::localize(serde_json::from_slice(&bytes)?, &folder, &from, local)?;
    let tmp = dir.join("match.tmp");
    tokio::fs::write(&tmp, serde_json::to_vec_pretty(&doc)?).await?;
    tokio::fs::rename(&tmp, dir.join("match.json")).await?;
    // So their app can say it arrived.
    let _ = ask(endpoint, conns, job.peer, json!({ "op": "got", "id": id, "at": at })).await;
    Ok(folder)
}

/// Cards of the games students have sent, under this PC's ids for them.
fn received_cards(inbox: &Path) -> CardList {
    crate::sharing::received(inbox)
        .into_iter()
        .filter_map(|(dir, _)| {
            let doc = serde_json::from_str::<Value>(&std::fs::read_to_string(dir.join("match.json")).ok()?).ok()?;
            let card = card_from_match(&doc)?;
            Some((dir, card))
        })
        .collect()
}

pub struct Engine {
    /// Always present; an Option only so it can be wound down safely on drop.
    rt: Option<tokio::runtime::Runtime>,
    endpoint: Endpoint,
    policy: Arc<RwLock<Policy>>,
    conns: Arc<tokio::sync::Mutex<HashMap<EndpointId, Connection>>>,
    online: Arc<AtomicBool>,
    requests: Requests,
    queue: SaveQueue,
    progress: SaveProgress,
    hub: Hub,
    /// Teammates a position report is on its way to, so reports never pile up
    /// behind someone who is offline.
    sending: Arc<std::sync::Mutex<HashSet<EndpointId>>>,
    /// Setting: save teammates' views for offline use.
    keep: Arc<AtomicBool>,
    /// Games being sent to this PC for coaching.
    coach: Coach,
    proxy_port: u16,
    proxy_token: String,
}

fn random_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    (0..3).map(|_| format!("{:016x}", RandomState::new().build_hasher().finish())).collect()
}

async fn write_frame(send: &mut SendStream, v: &Value) -> Result<()> {
    let bytes = v.to_string().into_bytes();
    send.write_all(&(bytes.len() as u32).to_le_bytes()).await.map_err(|e| anyhow!("{e}"))?;
    send.write_all(&bytes).await.map_err(|e| anyhow!("{e}"))?;
    Ok(())
}

async fn read_frame(recv: &mut RecvStream, max: usize) -> Result<Value> {
    let mut len = [0u8; 4];
    recv.read_exact(&mut len).await.map_err(|e| anyhow!("{e}"))?;
    let len = u32::from_le_bytes(len) as usize;
    if len > max {
        return Err(anyhow!("message too large"));
    }
    let mut buf = vec![0u8; len];
    recv.read_exact(&mut buf).await.map_err(|e| anyhow!("{e}"))?;
    Ok(serde_json::from_slice(&buf)?)
}

/// Send the bytes `start..=end` of a file as the reply to a request. `bulk` marks a
/// background copy, which gives way to a game on this PC.
async fn send_file(send: &mut SendStream, path: Option<PathBuf>, start: u64, end: Option<u64>, bulk: bool) -> Result<()> {
    let refuse = |why: &str| json!({ "ok": false, "error": why });
    let opened = match path {
        Some(p) => tokio::fs::File::open(p).await.ok(),
        None => None,
    };
    let Some(mut file) = opened else {
        write_frame(send, &refuse("not_found")).await?;
        let _ = send.finish();
        return Ok(());
    };
    let total = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let Some((start, end)) = clamp_range(start, end, total) else {
        write_frame(send, &refuse("range")).await?;
        let _ = send.finish();
        return Ok(());
    };
    write_frame(send, &json!({ "ok": true, "total": total, "start": start, "end": end })).await?;
    file.seek(std::io::SeekFrom::Start(start)).await?;
    let mut left = end - start + 1;
    let mut buf = vec![0u8; 128 * 1024];
    let mut checked = std::time::Instant::now();
    while left > 0 {
        if bulk && checked.elapsed() > Duration::from_secs(2) {
            checked = std::time::Instant::now();
            if game_running() {
                // Drop the stream; the other side carries on later from here.
                return Ok(());
            }
        }
        let want = buf.len().min(left as usize);
        let n = file.read(&mut buf[..want]).await?;
        if n == 0 {
            break;
        }
        // The viewer stops reading when it has what it needs; that ends the loop.
        if send.write_all(&buf[..n]).await.is_err() {
            return Ok(());
        }
        left -= n as u64;
    }
    let _ = send.finish();
    Ok(())
}

/// What became of a request that might be about a game sent for coaching.
enum Coached {
    /// It was, and this is the answer.
    Reply(Value),
    /// It was, and the answer (a file) has gone out already.
    Sent,
    /// It is an ordinary request between teammates.
    No,
}

/// Answer a request about a game sent for coaching, from either side of it: the
/// player who sent it answers the person it was sent to, and that person answers the
/// player. Neither has to be on the other's teammates list, and "let teammates watch
/// my recordings" has no say here: a game sent to someone was sent on purpose.
async fn serve_coaching(send: &mut SendStream, req: &Value, peer: EndpointId, policy: &Arc<RwLock<Policy>>, coach: &Coach) -> Result<Coached> {
    let (root, inbox, shares, student) = {
        let p = policy.read().unwrap();
        (p.root.clone(), p.inbox.clone(), p.shares.clone(), p.students.contains_key(&peer))
    };
    let refuse = |why: &str| json!({ "ok": false, "error": why });
    let code = peer.to_string();
    let text = |k: &str| req.get(k).and_then(|x| x.as_str()).unwrap_or("");
    let about_shared = req.get("shared").is_some_and(|v| !v.is_null() && *v != json!(false));
    let reply = match (text("op"), about_shared) {
        // A player wants to send this PC a game. From someone accepted before, their
        // app is asked for it at once; from anyone else it waits for a yes.
        ("offer", _) => {
            let (id, at) = (text("id"), req.get("at").and_then(|x| x.as_i64()).unwrap_or(0));
            let turned_down = inbox.as_deref().is_some_and(|i| crate::sharing::removed(i).contains(&crate::sharing::key(&code, id, at)));
            if turned_down {
                json!({ "ok": true, "accepted": false, "declined": true })
            } else if student {
                coach.ask_soon(peer);
                json!({ "ok": true, "accepted": true })
            } else {
                note_offer(coach, peer, req);
                json!({ "ok": true, "accepted": false })
            }
        }
        // The person a game was sent to has fetched it.
        ("got", _) => {
            let (id, at) = (text("id"), req.get("at").and_then(|x| x.as_i64()).unwrap_or(0));
            if crate::sharing::mark_got(&shares, id, &code, at) {
                coach.tell("share", json!({ "id": id, "code": code, "state": "received" }));
            }
            json!({ "ok": true })
        }
        // What this PC has sent to the person asking, ready to fetch.
        ("shared", _) => {
            let games: Vec<Value> = match &root {
                Some(root) => crate::sharing::to_peer(&shares, &code).iter().filter_map(|s| crate::sharing::package(root, s)).collect(),
                None => Vec::new(),
            };
            json!({ "ok": true, "games": games })
        }
        // One file of a game sent to the person asking: only what that share covers.
        // Always a background copy, so never while a game is played on this PC.
        ("file", true) => {
            if game_running() {
                return Ok(Coached::Reply(refuse("busy")));
            }
            let (id, name) = (text("id"), text("file"));
            let path = match (&root, crate::sharing::find(&shares, &code, id)) {
                (Some(root), Some(share)) if valid_id(id) && crate::sharing::may_fetch(&root.join(id), &share, name) => Some(root.join(id).join(name)),
                _ => None,
            };
            let start = req.get("start").and_then(|x| x.as_u64()).unwrap_or(0);
            send_file(send, path, start, req.get("end").and_then(|x| x.as_u64()), true).await?;
            return Ok(Coached::Sent);
        }
        // Notes and drawings on a game sent for coaching, asked for by its other side.
        ("extras", true) => {
            let id = text("shared");
            let mine = root.as_ref().filter(|_| valid_id(id)).and_then(|root| {
                let share = crate::sharing::find(&shares, &code, id)?;
                let dir = root.join(id);
                let doc: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("match.json")).ok()?).ok()?;
                let mut reply = extras_reply(&dir, &card_from_match(&doc)?, true);
                if !share.comms {
                    // When I spoke belongs with the voices, which did not go along.
                    reply["voice"] = Value::Null;
                }
                Some(reply)
            });
            let theirs = || inbox.as_deref().and_then(|inbox| crate::sharing::find_received(inbox, &code, id)).and_then(|(dir, _)| coach_reply(&dir));
            mine.or_else(theirs).unwrap_or_else(|| refuse("none"))
        }
        _ => return Ok(Coached::No),
    };
    Ok(Coached::Reply(reply))
}

/// What a coach's PC tells the player about the game they sent: the coach's notes and
/// drawings on it. The video is the player's own, so the times need no shifting, and
/// a drawing with no view named lands on the player's own view.
fn coach_reply(dir: &Path) -> Option<Value> {
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("match.json")).ok()?).ok()?;
    let card = card_from_match(&doc)?;
    let review = std::fs::read_to_string(dir.join("review.json")).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(Value::Null);
    Some(json!({
        "ok": true,
        "offset": card.offset,
        "player": card.player,
        "champion": "",
        "championKey": "",
        "notes": review.get("notes").cloned().unwrap_or(json!([])),
        "drawings": review.get("drawings").cloned().unwrap_or(json!([])),
    }))
}

/// Whether `peer` is someone this PC has sent a game to, or takes games from.
fn coaching_with(policy: &Arc<RwLock<Policy>>, peer: EndpointId) -> bool {
    let (student, shares) = {
        let p = policy.read().unwrap();
        (p.students.contains_key(&peer), p.shares.clone())
    };
    student || !crate::sharing::to_peer(&shares, &peer.to_string()).is_empty()
}

/// Answer one request from a teammate.
async fn serve_stream(
    mut send: SendStream,
    mut recv: RecvStream,
    peer: EndpointId,
    policy: Arc<RwLock<Policy>>,
    requests: Requests,
    hub: Hub,
    coach: Coach,
) -> Result<()> {
    let req = read_frame(&mut recv, MAX_REQUEST).await?;
    let (is_friend, share, name, root, copies, notes) = {
        let p = policy.read().unwrap();
        (p.friends.contains(&peer), p.share, p.name.clone(), p.root.clone(), p.copies, p.notes)
    };
    let refuse = |why: &str| json!({ "ok": false, "error": why });
    let op = req.get("op").and_then(|x| x.as_str()).unwrap_or("");
    let cards = || root.as_deref().map(|r| cached_cards(r, copies)).unwrap_or_default();
    match serve_coaching(&mut send, &req, peer, &policy, &coach).await? {
        Coached::Reply(reply) => {
            write_frame(&mut send, &reply).await?;
            let _ = send.finish();
            return Ok(());
        }
        Coached::Sent => return Ok(()),
        Coached::No => {}
    }
    // Watching together also works with the person a game was sent to, or came from.
    let coaching = op == "watch" && !is_friend && coaching_with(&policy, peer);
    let reply = if !is_friend && !coaching {
        note_request(&requests, peer, &req);
        refuse("not_friend")
    } else if op == "watch" {
        // Watching together works between teammates whether or not recordings are shared.
        note_watch(&hub, peer, serde_json::from_value(req.clone()).unwrap_or_default());
        json!({ "ok": true })
    } else if !share {
        refuse("sharing_off")
    } else {
        match op {
            "hello" => json!({ "ok": true, "name": name }),
            "games" => json!({ "ok": true, "games": cards().into_iter().map(|(_, c)| c).collect::<Vec<_>>() }),
            "extras" => {
                let key: GameCard = serde_json::from_value(req.get("game").cloned().unwrap_or(Value::Null)).unwrap_or_default();
                match cards().into_iter().find(|(_, c)| same_game(c, &key)) {
                    Some((dir, card)) => extras_reply(&dir, &card, notes),
                    None => refuse("none"),
                }
            }
            "file" => {
                // "bulk" marks a background copy (saving a view for offline use), as
                // opposed to someone watching right now. Those never run while a game
                // is being played on this PC: uploading would cost the game its ping.
                let bulk = req.get("bulk").and_then(|x| x.as_bool()).unwrap_or(false);
                if bulk && game_running() {
                    write_frame(&mut send, &refuse("busy")).await?;
                    let _ = send.finish();
                    return Ok(());
                }
                let id = req.get("id").and_then(|x| x.as_str()).unwrap_or("");
                let start = req.get("start").and_then(|x| x.as_u64()).unwrap_or(0);
                let end = req.get("end").and_then(|x| x.as_u64());
                // Only the video with game sound (the original or its smaller copy) and
                // the cursor log are ever handed out.
                let path = match (&root, valid_id(id), req.get("file").and_then(|x| x.as_str())) {
                    (Some(root), true, Some(name @ ("game.mp4" | "review.mp4" | "mouse.csv"))) => Some(root.join(id).join(name)),
                    _ => None,
                };
                send_file(&mut send, path, start, end, bulk).await?;
                return Ok(());
            }
            _ => refuse("unknown"),
        }
    };
    write_frame(&mut send, &reply).await?;
    let _ = send.finish();
    Ok(())
}

async fn serve_conn(conn: Connection, policy: Arc<RwLock<Policy>>, requests: Requests, hub: Hub, coach: Coach) {
    let peer = conn.remote_id();
    while let Ok((send, recv)) = conn.accept_bi().await {
        let (policy, requests, hub, coach) = (policy.clone(), requests.clone(), hub.clone(), coach.clone());
        tokio::spawn(async move {
            let _ = serve_stream(send, recv, peer, policy, requests, hub, coach).await;
        });
    }
}

/// Open a request stream to a teammate, reusing the connection when there is one.
async fn open_stream(
    endpoint: &Endpoint,
    conns: &tokio::sync::Mutex<HashMap<EndpointId, Connection>>,
    peer: EndpointId,
) -> Result<(SendStream, RecvStream)> {
    let cached = conns.lock().await.get(&peer).cloned();
    if let Some(conn) = cached {
        if let Ok(pair) = conn.open_bi().await {
            return Ok(pair);
        }
        conns.lock().await.remove(&peer);
    }
    let conn = tokio::time::timeout(Duration::from_secs(12), endpoint.connect(peer, ALPN))
        .await
        .map_err(|_| anyhow!("offline"))?
        .map_err(|_| anyhow!("offline"))?;
    let pair = conn.open_bi().await.map_err(|_| anyhow!("offline"))?;
    conns.lock().await.insert(peer, conn);
    Ok(pair)
}

/// Send a request and read the reply header. The stream is returned for any body.
async fn ask(
    endpoint: &Endpoint,
    conns: &tokio::sync::Mutex<HashMap<EndpointId, Connection>>,
    peer: EndpointId,
    req: Value,
) -> Result<(Value, RecvStream)> {
    let (mut send, mut recv) = open_stream(endpoint, conns, peer).await?;
    write_frame(&mut send, &req).await.map_err(|_| anyhow!("offline"))?;
    let _ = send.finish();
    let head = tokio::time::timeout(Duration::from_secs(12), read_frame(&mut recv, MAX_REPLY))
        .await
        .map_err(|_| anyhow!("offline"))?
        .map_err(|_| anyhow!("offline"))?;
    if head.get("ok").and_then(|x| x.as_bool()) == Some(true) {
        Ok((head, recv))
    } else {
        Err(anyhow!("{}", head.get("error").and_then(|x| x.as_str()).unwrap_or("refused")))
    }
}

/// A blocking reader over a network stream, for the local bridge to the video player.
struct BodyReader {
    handle: tokio::runtime::Handle,
    recv: Option<RecvStream>,
    left: u64,
}

impl Read for BodyReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.left == 0 || buf.is_empty() {
            return Ok(0);
        }
        let Some(mut recv) = self.recv.take() else { return Ok(0) };
        let want = buf.len().min(self.left as usize).min(256 * 1024);
        let (tx, rx) = mpsc::channel();
        self.handle.spawn(async move {
            let mut tmp = vec![0u8; want];
            let got = recv.read(&mut tmp).await;
            let _ = tx.send((recv, got.map(|n| {
                tmp.truncate(n.unwrap_or(0));
                tmp
            })));
        });
        match rx.recv() {
            Ok((recv, Ok(data))) => {
                self.recv = Some(recv);
                buf[..data.len()].copy_from_slice(&data);
                self.left -= data.len() as u64;
                Ok(data.len())
            }
            _ => Err(std::io::Error::other("the teammate's stream ended")),
        }
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

/// A teammate's view of a game, as offered to the player.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Pov {
    pub friend: String,
    /// Their friend code.
    pub code: String,
    /// The view is saved on this PC and plays without them being online.
    pub cached: bool,
    /// Bytes saved so far and total, while it is being saved.
    pub saving: Option<(u64, u64)>,
    /// "ready" | "none" (did not record this game) | "offline" | "denied" (they have
    /// not added you) | "off" (their sharing is off) | "badcode"
    pub status: String,
    pub player: String,
    pub champion: String,
    pub champion_key: String,
    pub position: String,
    /// Seconds to add to a time in my video to get the same moment in theirs.
    pub shift: f64,
    pub duration: f64,
    pub video: Option<String>,
    /// Their cursor log, when they recorded one.
    pub mouse: Option<String>,
    pub mouse_offset: f64,
    pub mouse_w: i64,
    pub mouse_h: i64,
}

fn status_for(err: &anyhow::Error) -> &'static str {
    match err.to_string().as_str() {
        "not_friend" => "denied",
        "sharing_off" => "off",
        _ => "offline",
    }
}

impl Engine {
    /// Go online with the identity stored at `identity`.
    pub fn start(identity: &Path, settings: &Settings) -> Result<Engine> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("rewatch-net")
            .enable_all()
            .build()?;
        let secret = load_identity(identity);
        // Look the helper servers up through Cloudflare's public DNS rather than the
        // PC's own. Some internet providers' content filters
        // redirect iroh's relay servers to a block page, which leaves this feature
        // unable to connect.
        // It applies to this feature's lookups only, nothing else on the PC.
        use iroh::dns::{DnsResolver, NameserverConfig};
        let dns = DnsResolver::builder()
            .add_nameserver_config(NameserverConfig::udp(std::net::IpAddr::from([1, 1, 1, 1])))
            .add_nameserver_config(NameserverConfig::udp(std::net::IpAddr::from([1, 0, 0, 1])))
            .build();
        // Bind on the engine's own runtime and wait for the answer over a channel.
        // This function is called from the app's command threads, which belong to
        // another async runtime; blocking on a runtime from there panics.
        let (tx, rx) = mpsc::channel();
        rt.spawn(async move {
            let bound = Endpoint::builder(presets::N0)
                .dns_resolver(dns)
                .secret_key(secret)
                .alpns(vec![ALPN.to_vec()])
                .bind()
                .await
                .map_err(|e| e.to_string());
            let _ = tx.send(bound);
        });
        let endpoint = match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(Ok(endpoint)) => endpoint,
            other => {
                // A runtime may not be dropped from an async thread either; let it wind
                // down in the background.
                rt.shutdown_background();
                let why = match other {
                    Ok(Err(e)) => e,
                    _ => "timed out".to_string(),
                };
                return Err(anyhow!("Could not start the connection to teammates: {why}"));
            }
        };
        let policy = Arc::new(RwLock::new(policy_from(settings)));
        let online = Arc::new(AtomicBool::new(false));
        let requests: Requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let hub: Hub = Arc::new(std::sync::Mutex::new(WatchHub::default()));
        let coach: Coach = Arc::new(Coaching::default());
        // Whatever students sent while this PC was off is asked for first thing.
        for peer in policy.read().unwrap().students.keys() {
            coach.ask_soon(*peer);
        }

        // Answer teammates.
        {
            let (endpoint, policy, requests, hub, coach) = (endpoint.clone(), policy.clone(), requests.clone(), hub.clone(), coach.clone());
            rt.spawn(async move {
                while let Some(incoming) = endpoint.accept().await {
                    let (policy, requests, hub, coach) = (policy.clone(), requests.clone(), hub.clone(), coach.clone());
                    tokio::spawn(async move {
                        if let Ok(conn) = incoming.await {
                            serve_conn(conn, policy, requests, hub, coach).await;
                        }
                    });
                }
            });
        }
        {
            let (endpoint, online) = (endpoint.clone(), online.clone());
            rt.spawn(async move {
                endpoint.online().await;
                online.store(true, Ordering::Relaxed);
            });
        }

        // Local bridge: the video player asks this PC over plain HTTP on the loopback
        // address, and the bridge fetches the bytes from the teammate over iroh.
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let proxy_port = listener.local_addr()?.port();
        let server = Server::from_listener(listener, None).map_err(|e| anyhow!("{e}"))?;
        let proxy_token = random_token();
        let conns = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        {
            let (endpoint, conns, token, handle) = (endpoint.clone(), conns.clone(), proxy_token.clone(), rt.handle().clone());
            std::thread::spawn(move || {
                for req in server.incoming_requests() {
                    let (endpoint, conns, token, handle) = (endpoint.clone(), conns.clone(), token.clone(), handle.clone());
                    std::thread::spawn(move || bridge(req, endpoint, conns, token, handle));
                }
            });
        }
        // Saves teammates' views one at a time, and never during a game.
        let queue: SaveQueue = Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new()));
        let progress: SaveProgress = Arc::new(std::sync::Mutex::new(HashMap::new()));
        let keep = Arc::new(AtomicBool::new(settings.keep_teammate_views));
        {
            let (endpoint, conns, queue, progress, keep) = (endpoint.clone(), conns.clone(), queue.clone(), progress.clone(), keep.clone());
            rt.spawn(async move {
                loop {
                    let job = queue.lock().ok().and_then(|mut q| q.pop_front());
                    let Some(mut job) = job else {
                        tokio::time::sleep(Duration::from_secs(3)).await;
                        continue;
                    };
                    if !keep.load(Ordering::Relaxed) {
                        continue;
                    }
                    if game_running() {
                        enqueue(&queue, job);
                        tokio::time::sleep(Duration::from_secs(20)).await;
                        continue;
                    }
                    let outcome = save_view(&endpoint, &conns, &job, &progress).await;
                    if let Ok(mut p) = progress.lock() {
                        p.remove(&save_key(&job.dir, &job.code));
                    }
                    match outcome {
                        Ok(()) => log(format!("[pov] saved {}'s view of {} for offline use", job.friend, job.card.id)),
                        Err(e) => {
                            job.tries += 1;
                            if job.tries == 1 {
                                log(format!("[pov] could not save {}'s view yet ({e}); will retry", job.friend));
                            }
                            // Give up after a while; the periodic check queues it again later.
                            if job.tries < 20 {
                                enqueue(&queue, job);
                            }
                            tokio::time::sleep(Duration::from_secs(30)).await;
                        }
                    }
                }
            });
        }
        // Fetches the games students send, one at a time, and never during a game.
        {
            let (endpoint, conns, policy, coach) = (endpoint.clone(), conns.clone(), policy.clone(), coach.clone());
            rt.spawn(async move {
                loop {
                    // Ask each student's app what it has sent. Each is asked on its
                    // own, so one who is offline holds nobody else up.
                    let peers: Vec<EndpointId> = coach.ask.lock().map(|mut a| std::mem::take(&mut *a)).unwrap_or_default();
                    for peer in peers {
                        let (known, inbox, me) = {
                            let p = policy.read().unwrap();
                            (p.students.get(&peer).cloned(), p.inbox.clone(), p.name.clone())
                        };
                        let (Some(name), Some(inbox)) = (known, inbox) else { continue };
                        let (endpoint, conns, coach) = (endpoint.clone(), conns.clone(), coach.clone());
                        tokio::spawn(async move {
                            let Ok((head, _)) = ask(&endpoint, &conns, peer, json!({ "op": "shared", "name": me })).await else { return };
                            let code = peer.to_string();
                            let games = head.get("games").and_then(|g| g.as_array()).cloned().unwrap_or_default();
                            for pkg in games.into_iter().take(200).filter(|pkg| crate::sharing::wanted(&inbox, &code, pkg)) {
                                // Not one that is waiting its turn or arriving right now.
                                let id = pkg.get("id").and_then(|x| x.as_str()).unwrap_or("");
                                if coach.progress.lock().map(|p| p.contains_key(&format!("{code}|{id}"))).unwrap_or(true) {
                                    continue;
                                }
                                let Ok(mut jobs) = coach.jobs.lock() else { return };
                                if !jobs.iter().any(|j| j.peer == peer && j.pkg.get("id") == pkg.get("id")) {
                                    jobs.push_back(Receive { peer, code: code.clone(), name: name.clone(), inbox: inbox.clone(), pkg, tries: 0 });
                                }
                            }
                        });
                    }
                    let job = coach.jobs.lock().ok().and_then(|mut q| q.pop_front());
                    let Some(mut job) = job else {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        continue;
                    };
                    // Removed from the list since it was queued: not theirs to send any more.
                    if !policy.read().unwrap().students.contains_key(&job.peer) {
                        continue;
                    }
                    if game_running() {
                        if let Ok(mut q) = coach.jobs.lock() {
                            q.push_back(job);
                        }
                        tokio::time::sleep(Duration::from_secs(20)).await;
                        continue;
                    }
                    let outcome = receive(&endpoint, &conns, &job, &coach).await;
                    let id = job.pkg.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let key = format!("{}|{id}", job.code);
                    // Still listed while it waits to be tried again, with what went wrong.
                    let waiting = outcome.as_ref().err().filter(|e| e.to_string() != "not_found" && job.tries + 1 < 20).map(|e| e.to_string());
                    if let Ok(mut p) = coach.progress.lock() {
                        match (waiting, p.get_mut(&key)) {
                            (Some(why), Some(entry)) => entry["error"] = json!(why),
                            _ => {
                                p.remove(&key);
                            }
                        }
                    }
                    match outcome {
                        Ok(local) => {
                            log(format!("[coach] received {}'s game {id}", job.name));
                            coach.tell("received", json!({ "id": local, "code": job.code, "name": job.name, "game": job.pkg.get("game").map(crate::sharing::clean_summary) }));
                        }
                        // They stopped sharing it: nothing to wait for, and nothing half fetched is kept.
                        Err(e) if e.to_string() == "not_found" => {
                            let dir = job.inbox.join(crate::sharing::folder(&id, &job.code));
                            if valid_id(&id) && !dir.join("match.json").exists() {
                                let _ = tokio::fs::remove_dir_all(&dir).await;
                            }
                        }
                        Err(e) => {
                            job.tries += 1;
                            if job.tries == 1 {
                                log(format!("[coach] could not fetch {}'s game yet ({e}); will retry", job.name));
                            }
                            // Give up after a while; the next look at what they sent queues it again.
                            if job.tries < 20 {
                                if let Ok(mut q) = coach.jobs.lock() {
                                    q.push_back(job);
                                }
                            }
                            tokio::time::sleep(Duration::from_secs(30)).await;
                        }
                    }
                }
            });
        }
        log(format!("[pov] online for teammates as {}", endpoint.id().fmt_short()));
        let sending = Arc::new(std::sync::Mutex::new(HashSet::new()));
        Ok(Engine { rt: Some(rt), endpoint, policy, conns, online, requests, queue, progress, hub, sending, keep, coach, proxy_port, proxy_token })
    }

    fn rt(&self) -> &tokio::runtime::Runtime {
        self.rt.as_ref().expect("the runtime lives as long as the engine")
    }

    pub fn update(&self, settings: &Settings) {
        let next = policy_from(settings);
        // Someone just accepted as a student: fetch what they have been waiting to send.
        let added: Vec<EndpointId> = {
            let now = self.policy.read().unwrap();
            next.students.keys().filter(|p| !now.students.contains_key(*p)).copied().collect()
        };
        *self.policy.write().unwrap() = next;
        self.keep.store(settings.keep_teammate_views, Ordering::Relaxed);
        for peer in added {
            self.coach.ask_soon(peer);
        }
    }

    /// Where news about games sent for coaching is handed to (the app's window):
    /// "offer" (someone wants to send one), "received" (one has arrived) and "share"
    /// (one this PC sent has arrived at the other end).
    pub fn set_coach_notifier(&self, f: Arc<dyn Fn(&str, Value) + Send + Sync>) {
        if let Ok(mut n) = self.coach.notify.lock() {
            *n = Some(f);
        }
    }

    /// Ask every student's app what it has sent. Called now and then, so a game sent
    /// while this PC was off still arrives.
    pub fn sync_students(&self) {
        let students: Vec<EndpointId> = self.policy.read().map(|p| p.students.keys().copied().collect()).unwrap_or_default();
        for peer in students {
            self.coach.ask_soon(peer);
        }
    }

    /// People who want to send a game and have not been accepted yet.
    pub fn offers(&self) -> Vec<Offer> {
        let students = self.policy.read().map(|p| p.students.clone()).unwrap_or_default();
        self.coach
            .offers
            .lock()
            .map(|list| list.iter().filter(|o| parse_code(&o.code).is_some_and(|id| !students.contains_key(&id))).cloned().collect())
            .unwrap_or_default()
    }

    /// Games arriving right now, with the bytes fetched so far and in all.
    pub fn receiving(&self) -> Vec<Value> {
        self.coach.progress.lock().map(|p| p.values().cloned().collect()).unwrap_or_default()
    }

    /// Turn an offer down: it goes from the list, and their app is told no the next
    /// time it asks.
    pub fn decline(&self, settings: &Settings, code: &str, id: &str, at: i64) {
        if let Ok(mut list) = self.coach.offers.lock() {
            list.retain(|o| !(o.code == code && o.id == id));
        }
        if let Some(inbox) = crate::sharing::inbox(settings) {
            crate::sharing::mark_removed(&inbox, &crate::sharing::key(code, id, at));
        }
    }

    /// Tell the person a game was sent to that it is there for them. Returns how
    /// that went, as a share's state: "accepted" (their app is fetching it), "asked"
    /// (they have to say yes first), "declined", "old" (their Rewatch does not know
    /// about this yet) or "offline".
    pub fn offer(&self, share: &crate::sharing::Share, pkg: &Value) -> &'static str {
        let Some(peer) = parse_code(&share.code) else { return "offline" };
        let (endpoint, conns) = (self.endpoint.clone(), self.conns.clone());
        let req = json!({
            "op": "offer",
            "name": self.my_name(),
            "id": share.id,
            "at": share.at,
            "comms": share.comms,
            "message": share.message,
            "game": pkg.get("game"),
            "size": pkg.pointer("/video/size"),
        });
        let flag = |head: &Value, k: &str| head.get(k).and_then(|x| x.as_bool()).unwrap_or(false);
        match self.wait(async move { ask(&endpoint, &conns, peer, req).await.map(|(head, _)| head) }) {
            Some(Ok(head)) if flag(&head, "accepted") => "accepted",
            Some(Ok(head)) if flag(&head, "declined") => "declined",
            Some(Ok(_)) => "asked",
            // Versions before 0.7 answer a request they do not know like this.
            Some(Err(e)) if matches!(e.to_string().as_str(), "not_friend" | "unknown" | "sharing_off") => "old",
            _ => "offline",
        }
    }

    /// Progress of views being saved into one recording folder, by friend code.
    pub fn saving(&self, dir: &Path) -> HashMap<String, (u64, u64)> {
        let prefix = format!("{}|", dir.to_string_lossy());
        self.progress
            .lock()
            .map(|p| p.iter().filter_map(|(k, v)| k.strip_prefix(&prefix).map(|code| (code.to_string(), *v))).collect())
            .unwrap_or_default()
    }

    /// Look through recent recordings for teammates' views that are not saved yet and
    /// queue them. Called now and then, so views arrive without anyone opening a game.
    pub fn sync_recent(&self, settings: &Settings) {
        if !settings.keep_teammate_views {
            return;
        }
        let Some(root) = settings.recordings_path() else { return };
        let now = now_ms();
        let recent: Vec<(PathBuf, GameCard)> = cards_with_dirs(&root, false)
            .into_iter()
            .filter(|(_, c)| now - c.game_start_ms < 3 * 24 * 3600 * 1000)
            .collect();
        for friend in &settings.friends {
            let Some(peer) = parse_code(&friend.code) else { continue };
            let code = friend.code.trim().to_string();
            let missing: Vec<&(PathBuf, GameCard)> = recent
                .iter()
                .filter(|(dir, _)| !dir.join(format!("{}.json", save_prefix(&code))).exists())
                .collect();
            if missing.is_empty() {
                continue;
            }
            let (endpoint, conns, name) = (self.endpoint.clone(), self.conns.clone(), self.my_name());
            let asked = self.wait(async move {
                ask(&endpoint, &conns, peer, json!({ "op": "games", "name": name })).await.map(|(head, _)| head)
            });
            let Some(Ok(head)) = asked else { continue };
            let cards: Vec<GameCard> = serde_json::from_value(head.get("games").cloned().unwrap_or(Value::Null)).unwrap_or_default();
            for (dir, mine) in missing {
                if let Some(card) = cards.iter().find(|c| same_game(c, mine) && c.player != mine.player) {
                    enqueue(&self.queue, SaveJob {
                        dir: dir.clone(),
                        peer,
                        friend: friend.name.clone(),
                        code: code.clone(),
                        card: card.clone(),
                        tries: 0,
                    });
                }
            }
        }
    }

    /// Teammates' notes, drawings and speech times for the game in `mine`. Whatever
    /// a teammate's app answers is kept in the recording's folder, and that copy is
    /// used when they cannot be reached.
    pub fn extras(&self, settings: &Settings, mine: &GameCard, dir: &Path) -> Vec<Extras> {
        // The other side of a game sent for coaching is asked about that game by its
        // id on the PC that recorded it. A game sent to me was not played by my
        // teammates, so they are not asked about it.
        let shares = self.policy.read().map(|p| p.shares.clone()).unwrap_or_default();
        let mut ask_them: Vec<(String, String, Option<String>)> =
            crate::sharing::audience(&shares, dir, &mine.id).into_iter().map(|(name, code, id)| (name, code, Some(id))).collect();
        if crate::sharing::from_of(dir).is_none() {
            for friend in &settings.friends {
                let code = friend.code.trim().to_string();
                if !ask_them.iter().any(|(_, c, _)| *c == code) {
                    ask_them.push((friend.name.clone(), code, None));
                }
            }
        }
        let asked: HashSet<String> = ask_them.iter().map(|(_, code, _)| code.clone()).collect();
        let jobs: Vec<_> = ask_them
            .into_iter()
            .map(|(name, code, shared)| {
                let (endpoint, conns, key, my_offset) = (self.endpoint.clone(), self.conns.clone(), key_of(mine), mine.offset);
                let cache = extras_cache(dir, &code);
                let (tx, rx) = mpsc::channel();
                self.rt().spawn(async move {
                    let mut want = json!({ "op": "extras", "game": key });
                    if let Some(id) = shared {
                        want["shared"] = json!(id);
                    }
                    let fresh = match parse_code(&code) {
                        Some(peer) => ask(&endpoint, &conns, peer, want).await.ok().map(|(head, _)| head),
                        None => None,
                    };
                    let reply = match fresh {
                        Some(reply) => {
                            let keep = json!({ "friend": name, "code": code, "reply": reply });
                            let _ = tokio::fs::write(&cache, keep.to_string()).await;
                            Some(reply)
                        }
                        None => tokio::fs::read_to_string(&cache)
                            .await
                            .ok()
                            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                            .and_then(|v| v.get("reply").cloned()),
                    };
                    let _ = tx.send(reply.map(|r| extras_from_reply(&r, &name, &code, my_offset)));
                });
                rx
            })
            .collect();
        let mut out: Vec<Extras> = jobs.into_iter().filter_map(|rx| rx.recv().ok().flatten()).collect();
        // What was kept from someone who is no longer asked (a coach the game is no
        // longer shared with, a teammate taken off the list) still shows.
        for kept in saved_extras(dir, mine) {
            if !asked.contains(&kept.code) {
                out.push(kept);
            }
        }
        out
    }

    /// Where position reports from teammates are handed to (the app's window).
    pub fn set_notifier(&self, f: Arc<dyn Fn(Value) + Send + Sync>) {
        if let Ok(mut h) = self.hub.lock() {
            h.notify = Some(f);
        }
    }

    /// Tell teammates where my player is. `id` None leaves the session. `control`
    /// marks a deliberate play, pause or seek, which everyone in the session follows;
    /// without it this is the regular "still here, at this moment" report.
    pub fn watch_set(&self, settings: &Settings, id: Option<&str>, t_video: f64, playing: bool, rate: f64, control: bool) -> Result<()> {
        let name = self.my_name();
        let (msg, with, received) = {
            let mut h = self.hub.lock().map_err(|_| anyhow!("busy"))?;
            match id {
                None => {
                    let Some(left) = h.mine.take() else { return Ok(()) };
                    (WatchMsg { stop: true, name, ..Default::default() }, left.with, left.received)
                }
                Some(id) => {
                    if h.mine.as_ref().map(|m| m.id != id).unwrap_or(true) {
                        let root = settings.recordings_path().ok_or_else(|| anyhow!("No recordings folder is set"))?;
                        let dir = crate::sharing::game_dir(&root, id).ok_or_else(|| anyhow!("Recording not found"))?;
                        let card = std::fs::read_to_string(dir.join("match.json"))
                            .ok()
                            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                            .and_then(|doc| card_from_match(&doc))
                            .ok_or_else(|| anyhow!("Only game recordings can be watched together"))?;
                        let shares = self.policy.read().map(|p| p.shares.clone()).unwrap_or_default();
                        let with = crate::sharing::audience(&shares, &dir, id).iter().filter_map(|(_, code, _)| parse_code(code)).collect();
                        h.mine = Some(MyWatch { id: id.to_string(), card, ctl: 0, leader: None, with, received: crate::sharing::from_of(&dir).is_some() });
                    }
                    let mine = h.mine.as_mut().expect("just set");
                    if control {
                        mine.ctl = now_ms().max(mine.ctl + 1);
                        mine.leader = None;
                    }
                    let msg = WatchMsg { game: key_of(&mine.card), t_game: t_video - mine.card.offset, playing, rate, ctl: mine.ctl, name, stop: false };
                    (msg, mine.with.clone(), mine.received)
                }
            }
        };
        let mut req = serde_json::to_value(&msg)?;
        req["op"] = json!("watch");
        // Teammates, and the other side of a game sent for coaching. A game that was
        // sent to me is no business of my teammates.
        let mut friends: Vec<EndpointId> = if received { Vec::new() } else { self.policy.read().map(|p| p.friends.iter().copied().collect()).unwrap_or_default() };
        for peer in with {
            if !friends.contains(&peer) {
                friends.push(peer);
            }
        }
        for peer in friends {
            // One report at a time per teammate; the next one carries the newest state anyway.
            if !self.sending.lock().map(|mut s| s.insert(peer)).unwrap_or(false) {
                continue;
            }
            let (endpoint, conns, req, sending) = (self.endpoint.clone(), self.conns.clone(), req.clone(), self.sending.clone());
            self.rt().spawn(async move {
                let _ = ask(&endpoint, &conns, peer, req).await;
                if let Ok(mut s) = sending.lock() {
                    s.remove(&peer);
                }
            });
        }
        Ok(())
    }

    /// Teammates whose players are open right now, with the matching recording of
    /// mine (if I have one) and the moment they are at in my video's time.
    pub fn watch_peers(&self, settings: &Settings) -> Vec<Value> {
        let peers: Vec<(EndpointId, WatchMsg)> = self
            .hub
            .lock()
            .map(|mut h| {
                h.peers.retain(|_, (_, at)| at.elapsed() < Duration::from_secs(7));
                h.peers.iter().map(|(id, (msg, _))| (*id, msg.clone())).collect()
            })
            .unwrap_or_default();
        if peers.is_empty() {
            return Vec::new();
        }
        let mut cards = settings.recordings_path().map(|r| cached_cards(&r, false)).unwrap_or_default();
        // A student going through the game they sent: here it is one of the received ones.
        if let Some(inbox) = crate::sharing::inbox(settings) {
            cards.extend(received_cards(&inbox));
        }
        peers
            .into_iter()
            .map(|(id, msg)| {
                let found = cards.iter().find(|(_, c)| same_game(c, &msg.game)).map(|(_, c)| c);
                json!({
                    "code": id.to_string(),
                    "name": msg.name,
                    "playing": msg.playing,
                    "rate": msg.rate,
                    "matchId": found.map(|c| c.id.clone()),
                    "t": found.map(|c| msg.t_game + c.offset),
                })
            })
            .collect()
    }

    pub fn code(&self) -> String {
        self.endpoint.id().to_string()
    }

    pub fn online(&self) -> bool {
        self.online.load(Ordering::Relaxed)
    }

    /// People who tried to connect and are not (yet) on the teammates list.
    pub fn requests(&self) -> Vec<PairRequest> {
        let friends = self.policy.read().map(|p| p.friends.clone()).unwrap_or_default();
        self.requests
            .lock()
            .map(|list| {
                list.iter()
                    .filter(|r| parse_code(&r.code).map(|id| !friends.contains(&id)).unwrap_or(false))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    fn my_name(&self) -> String {
        self.policy.read().map(|p| p.name.clone()).unwrap_or_default()
    }

    /// Run a future on the engine's runtime and wait for it from an ordinary thread.
    fn wait<T: Send + 'static>(&self, fut: impl std::future::Future<Output = T> + Send + 'static) -> Option<T> {
        let (tx, rx) = mpsc::channel();
        self.rt().spawn(async move {
            let _ = tx.send(fut.await);
        });
        rx.recv().ok()
    }

    /// Send one request as it is and return the reply's first part, or why it was
    /// refused. For testing what another app answers to whom.
    pub fn ask_raw(&self, code: &str, req: Value) -> Result<Value> {
        let peer = parse_code(code).ok_or_else(|| anyhow!("badcode"))?;
        let (endpoint, conns) = (self.endpoint.clone(), self.conns.clone());
        self.wait(async move { ask(&endpoint, &conns, peer, req).await.map(|(head, _)| head) }).unwrap_or_else(|| Err(anyhow!("offline")))
    }

    /// Check a teammate's code. Returns the name their app reports.
    pub fn ping(&self, code: &str) -> Result<String> {
        let peer = parse_code(code).ok_or_else(|| anyhow!("That does not look like a friend code. Ask them to copy it again."))?;
        if peer == self.endpoint.id() {
            return Err(anyhow!("That is your own code."));
        }
        let (endpoint, conns) = (self.endpoint.clone(), self.conns.clone());
        // Sending our name lets their app show "X wants to connect" if we are not on
        // their list yet.
        let hello = json!({ "op": "hello", "name": self.my_name() });
        let result = self
            .wait(async move { ask(&endpoint, &conns, peer, hello).await.map(|(head, _)| head) })
            .unwrap_or_else(|| Err(anyhow!("offline")));
        match result {
            Ok(head) => {
                log(format!("[pov] check {}: connected", peer.fmt_short()));
                Ok(head.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string())
            }
            Err(e) => {
                let status = status_for(&e);
                log(format!("[pov] check {}: {status} ({e})", peer.fmt_short()));
                Err(anyhow!(match status {
                    "denied" => "Reached them, but you are not on their teammates list yet. You now show up in their Settings under Teammates, where they can add you with one click.",
                    "off" => "Reached them, but they have switched sharing off.",
                    _ => "Could not reach them. Their PC must be on with Rewatch running.",
                }))
            }
        }
    }

    /// Ask every teammate for their recording of the game in `mine`.
    /// Teammates' views of the game in `mine`, whose recording is in `dir`. Views
    /// already saved there are used as they are; the rest are asked for, and queued
    /// for saving if that setting is on.
    pub fn pov_list(&self, settings: &Settings, mine: &GameCard, dir: &Path) -> Vec<Pov> {
        let saved = saved_views(dir);
        let keep = settings.keep_teammate_views;
        let jobs: Vec<_> = settings
            .friends
            .iter()
            .map(|friend| {
                let name = friend.name.clone();
                let code = friend.code.trim().to_string();
                let (tx, rx) = mpsc::channel();
                if let Some(v) = saved.iter().find(|v| v.code == code) {
                    let mut pov = pov_from_saved(v, dir, mine);
                    pov.friend = name;
                    let _ = tx.send(pov);
                    return rx;
                }
                let (endpoint, conns, mine) = (self.endpoint.clone(), self.conns.clone(), mine.clone());
                let my_name = self.my_name();
                let (port, token) = (self.proxy_port, self.proxy_token.clone());
                let (queue, progress, dir) = (self.queue.clone(), self.progress.clone(), dir.to_path_buf());
                self.rt().spawn(async move {
                    let mut pov = Pov { friend: name.clone(), code: code.clone(), ..Default::default() };
                    match parse_code(&code) {
                        None => pov.status = "badcode".into(),
                        Some(peer) => match ask(&endpoint, &conns, peer, json!({ "op": "games", "name": my_name })).await {
                            Err(e) => pov.status = status_for(&e).into(),
                            Ok((head, _)) => {
                                let cards: Vec<GameCard> =
                                    serde_json::from_value(head.get("games").cloned().unwrap_or(Value::Null)).unwrap_or_default();
                                let matches: Vec<&GameCard> = cards.iter().filter(|c| same_game(c, &mine)).collect();
                                match matches.iter().find(|c| c.player != mine.player).or(matches.first()) {
                                    None => pov.status = "none".into(),
                                    Some(card) => {
                                        pov.status = "ready".into();
                                        pov.player = card.player.clone();
                                        pov.champion = card.champion.clone();
                                        pov.champion_key = card.champion_key.clone();
                                        pov.position = card.position.clone();
                                        pov.shift = card.offset - mine.offset;
                                        pov.duration = card.duration;
                                        // Watching live: their smaller copy when it exists,
                                        // which asks far less of their upload.
                                        let file = if card.review == "ready" { crate::copies::FILE } else { "game.mp4" };
                                        pov.video = Some(format!("http://127.0.0.1:{port}/pov/{code}/{}/{file}?k={token}", card.id));
                                        if let Some(offset) = card.mouse_offset {
                                            pov.mouse = Some(format!(
                                                "http://127.0.0.1:{port}/pov/{code}/{}/mouse.csv?k={token}",
                                                card.id
                                            ));
                                            pov.mouse_offset = offset;
                                            pov.mouse_w = card.mouse_w;
                                            pov.mouse_h = card.mouse_h;
                                        }
                                        if keep {
                                            enqueue(&queue, SaveJob {
                                                dir: dir.clone(),
                                                peer,
                                                friend: name,
                                                code: code.clone(),
                                                card: (*card).clone(),
                                                tries: 0,
                                            });
                                        }
                                        pov.saving = progress.lock().ok().and_then(|p| p.get(&save_key(&dir, &code)).copied());
                                    }
                                }
                            }
                        },
                    }
                    let _ = tx.send(pov);
                });
                rx
            })
            .collect();
        let mut out: Vec<Pov> = jobs.into_iter().filter_map(|rx| rx.recv().ok()).collect();
        // Views saved earlier from someone who is no longer on the list still play.
        for v in &saved {
            if !out.iter().any(|p| p.code == v.code) {
                out.push(pov_from_saved(v, dir, mine));
            }
        }
        out
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // Dropping a runtime the ordinary way blocks, which is not allowed on an async
        // thread. Let it wind down in the background instead.
        if let Some(rt) = self.rt.take() {
            rt.shutdown_background();
        }
    }
}

/// Serve one request from the video player by fetching it from the teammate.
fn bridge(
    req: Request,
    endpoint: Endpoint,
    conns: Arc<tokio::sync::Mutex<HashMap<EndpointId, Connection>>>,
    token: String,
    handle: tokio::runtime::Handle,
) {
    let fail = |req: Request, status: u16| {
        let _ = req.respond(Response::empty(StatusCode(status)));
    };
    if *req.method() != Method::Get {
        return fail(req, 405);
    }
    let url = req.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
    if query.split('&').find_map(|kv| kv.strip_prefix("k=")) != Some(token.as_str()) {
        return fail(req, 401);
    }
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let (peer, id, file) = match parts.as_slice() {
        ["pov", code, id, file @ ("game.mp4" | "review.mp4" | "mouse.csv")] if valid_id(id) => match parse_code(code) {
            Some(peer) => (peer, id.to_string(), file.to_string()),
            None => return fail(req, 404),
        },
        _ => return fail(req, 404),
    };
    let mime = if file == "mouse.csv" { "text/csv" } else { "video/mp4" };
    let range = req.headers().iter().find(|h| h.field.equiv("Range")).map(|h| h.value.as_str().to_string());
    let (start, end) = parse_range(range.as_deref());
    let (tx, rx) = mpsc::channel();
    handle.spawn(async move {
        let ask_for = json!({ "op": "file", "id": id, "file": file, "start": start, "end": end });
        let _ = tx.send(ask(&endpoint, &conns, peer, ask_for).await);
    });
    let Ok(Ok((head, recv))) = rx.recv() else { return fail(req, 502) };
    let n = |k: &str| head.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let (total, start, end) = (n("total"), n("start"), n("end"));
    let count = end - start + 1;
    // The app's own page reads the cursor log with a plain request, which needs this
    // header; the token in the address is what keeps other pages out.
    let mut headers = vec![
        header("Content-Type", mime),
        header("Accept-Ranges", "bytes"),
        header("Cache-Control", "no-store"),
        header("Access-Control-Allow-Origin", "*"),
    ];
    if range.is_some() {
        headers.push(header("Content-Range", &format!("bytes {start}-{end}/{total}")));
    }
    let body = BodyReader { handle, recv: Some(recv), left: count };
    let status = StatusCode(if range.is_some() { 206 } else { 200 });
    let _ = req.respond(Response::new(status, headers, body, Some(count as usize), None));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(id: &str, me: &str, game_id: Option<i64>, started: i64, clock: Value) -> Value {
        json!({
            "id": id, "startedEpochMs": started, "duration": 1800.0, "clock": clock,
            "game": {
                "gameId": game_id,
                "me": { "name": me, "champion": "Ahri", "championKey": "Ahri" },
                "players": [ { "name": "Rin", "champion": "Ahri" }, { "name": "Kaja", "champion": "Jinx" } ]
            }
        })
    }

    #[test]
    fn two_recordings_of_one_game_line_up() {
        // Rin's recording began 40 s before the game clock started, Kaja's 55 s before.
        let mine = card_from_match(&doc("a", "Rin", Some(77), 1_000_000, json!([[45.0, 5.0], [50.0, 10.0], [55.0, 15.0]]))).unwrap();
        let theirs = card_from_match(&doc("b", "Kaja", Some(77), 985_000, json!([[60.0, 5.0], [65.0, 10.0]]))).unwrap();
        assert!((mine.offset - 40.0).abs() < 1e-9);
        assert!((theirs.offset - 55.0).abs() < 1e-9);
        assert!(same_game(&mine, &theirs));
        // Minute 2:00 of the game is at 160 s in Rin's video and 175 s in Kaja's.
        let shift = theirs.offset - mine.offset;
        assert!((160.0 + shift - 175.0).abs() < 1e-9);
        assert_eq!(mine.roster, vec!["Kaja|Jinx".to_string(), "Rin|Ahri".to_string()]);
    }

    #[test]
    fn games_match_by_roster_when_riot_id_is_missing() {
        let a = card_from_match(&doc("a", "Rin", None, 1_000_000, json!([[40.0, 0.0]]))).unwrap();
        let b = card_from_match(&doc("b", "Kaja", None, 1_012_000, json!([[28.0, 0.0]]))).unwrap();
        assert!(same_game(&a, &b));
        // Same players an hour later is a different game.
        let c = card_from_match(&doc("c", "Kaja", None, 4_600_000, json!([[28.0, 0.0]]))).unwrap();
        assert!(!same_game(&a, &c));
        // Different Riot ids never match, whatever the roster says.
        let d = card_from_match(&doc("d", "Kaja", Some(1), 1_000_000, json!([[40.0, 0.0]]))).unwrap();
        let e = card_from_match(&doc("e", "Rin", Some(2), 1_000_000, json!([[40.0, 0.0]]))).unwrap();
        assert!(!same_game(&d, &e));
    }

    #[test]
    fn manual_recordings_have_no_card() {
        assert!(card_from_match(&json!({ "id": "m", "clock": [] })).is_none());
    }

    #[test]
    fn ranges_are_parsed_and_clamped() {
        assert_eq!(parse_range(None), (0, None));
        assert_eq!(parse_range(Some("bytes=0-")), (0, None));
        assert_eq!(parse_range(Some("bytes=200-299")), (200, Some(299)));
        assert_eq!(parse_range(Some("nonsense")), (0, None));
        assert_eq!(clamp_range(0, None, 1000), Some((0, 999)));
        assert_eq!(clamp_range(900, Some(5000), 1000), Some((900, 999)));
        assert_eq!(clamp_range(1000, None, 1000), None);
        assert_eq!(clamp_range(5, Some(2), 1000), None);
        assert_eq!(clamp_range(0, None, 0), None);
    }

    /// The app's commands run on an async runtime's threads. Going online from one of
    /// them used to panic ("cannot start a runtime from within a runtime"), which
    /// closed the whole app the moment someone pressed Check on a friend code.
    #[test]
    fn going_online_from_an_async_thread_does_not_panic() {
        let key = std::env::temp_dir().join(format!("rewatch-test-{}.key", std::process::id()));
        let outer = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        let path = key.clone();
        let joined = outer.block_on(async move {
            tokio::spawn(async move { Engine::start(&path, &Settings::default()).map(|e| e.code()) }).await
        });
        let _ = std::fs::remove_file(&key);
        let started = joined.expect("starting must not panic");
        assert_eq!(started.expect("starting must succeed").len(), 64);
    }

    #[test]
    fn saved_views_are_only_listed_when_complete() {
        let dir = std::env::temp_dir().join(format!("rewatch-saved-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let code = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
        let prefix = save_prefix(code);
        assert_eq!(prefix, "pov_ab12cd34ef56");
        let mine = card_from_match(&doc("a", "Rin", Some(77), 1_000_000, json!([[45.0, 5.0]]))).unwrap();
        let theirs = card_from_match(&doc("b", "Kaja", Some(77), 985_000, json!([[60.0, 5.0]]))).unwrap();
        let note = SavedView { friend: "Kaja".into(), code: code.into(), card: theirs };
        // A note without its video is a download that never finished.
        std::fs::write(dir.join(format!("{prefix}.json")), serde_json::to_vec(&note).unwrap()).unwrap();
        assert!(saved_views(&dir).is_empty());
        std::fs::write(dir.join(format!("{prefix}.mp4")), b"video").unwrap();
        let povs = saved_povs(&dir, &mine);
        assert_eq!(povs.len(), 1);
        assert!(povs[0].cached && povs[0].status == "ready" && povs[0].friend == "Kaja");
        assert!((povs[0].shift - 15.0).abs() < 1e-9);
        assert!(povs[0].video.as_deref().unwrap().ends_with("pov_ab12cd34ef56.mp4"));
        assert!(povs[0].mouse.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn teammates_notes_arrive_in_my_time() {
        // Their recording began 15 s before mine, so their times are 15 s larger.
        let reply = json!({
            "ok": true, "offset": 55.0, "player": "Kaja", "champion": "Jinx", "championKey": "Jinx",
            "notes": [ { "id": "n1", "t": 175.0, "text": "Late rotate" }, { "id": "bad" }, { "id": "n2", "t": 176.0, "text": "Agreed", "replyTo": "m7" } ],
            "drawings": [
                { "id": "d1", "t": 100.0, "shapes": [ { "tool": "arrow", "color": "#ff5d5d", "pts": [[0.1, 0.2], [0.3, 0.4]] }, { "tool": "bomb", "color": "red", "pts": [] } ] },
                { "id": "d2", "t": 30.0, "view": "Rin", "shapes": [] }
            ],
            "voice": [[20.0, 22.5]]
        });
        let e = extras_from_reply(&reply, "Kaja", "code", 40.0);
        assert_eq!(e.notes.len(), 2);
        assert_eq!(e.notes[0]["t"], json!(160.0));
        assert!(e.notes[0].get("replyTo").is_none());
        assert_eq!(e.notes[1]["replyTo"], json!("m7"), "a reply keeps the note it answers");
        assert_eq!(e.drawings.len(), 2);
        assert_eq!(e.drawings[0]["view"], json!("Kaja"));
        assert_eq!(e.drawings[0]["shapes"].as_array().unwrap().len(), 1);
        assert_eq!(e.drawings[1]["view"], json!("Rin"));
        assert_eq!(e.voice, vec![[5.0, 7.5]]);
        assert!(e.titles.is_empty() && e.team.is_empty());
        // A team review made on their PC lands on the same fight in my video.
        let shared = extras_from_reply(&json!({ "offset": 55.0, "team": [{ "t": 175.0, "end": 190.0, "summary": "Lost 1 for 3.", "shouldHave": ["Wait."], "players": [], "call": "Back." }, { "summary": "no time" }] }), "Kaja", "code", 40.0);
        assert_eq!(shared.team.len(), 1);
        assert_eq!((shared.team[0]["t"].as_f64(), shared.team[0]["end"].as_f64()), (Some(160.0), Some(175.0)));
        assert_eq!(shared.team[0]["shouldHave"], json!(["Wait."]));
        let with_titles = extras_from_reply(&json!({ "titles": [{ "champion": "Jinx", "title": "The Carry", "why": "9 kills" }, { "champion": "", "title": "x" }] }), "Kaja", "code", 0.0);
        assert_eq!(with_titles.titles, vec![json!({ "champion": "Jinx", "title": "The Carry", "why": "9 kills" })]);
        assert_eq!((e.player.as_str(), e.champion_key.as_str()), ("Kaja", "Jinx"));
        // A reply with nothing in it is not an error.
        assert!(extras_from_reply(&json!({}), "x", "y", 0.0).notes.is_empty());
    }

    #[test]
    fn the_newest_control_is_followed() {
        let a = SecretKey::generate().public();
        let b = SecretKey::generate().public();
        let mut mine = MyWatch { id: "m".into(), card: GameCard::default(), ctl: 0, leader: None, with: Vec::new(), received: false };
        let msg = |ctl: i64| WatchMsg { ctl, ..Default::default() };
        // A joins after someone pressed play: follow them.
        assert_eq!(watch_kind(&mut mine, a, &msg(100)), "control");
        assert_eq!((mine.ctl, mine.leader), (100, Some(a)));
        // The leader's regular reports correct drift; other people's are just presence.
        assert_eq!(watch_kind(&mut mine, a, &msg(100)), "sync");
        assert_eq!(watch_kind(&mut mine, b, &msg(100)), "presence");
        assert_eq!(watch_kind(&mut mine, b, &msg(40)), "presence");
        // B seeks: now B leads.
        assert_eq!(watch_kind(&mut mine, b, &msg(101)), "control");
        assert_eq!(mine.leader, Some(b));
    }

    #[test]
    fn friend_codes_round_trip() {
        let key = SecretKey::generate();
        let code = key.public().to_string();
        assert_eq!(code.len(), 64);
        assert_eq!(parse_code(&format!("  {code} \n")), Some(key.public()));
        assert_eq!(parse_code("not a code"), None);
        assert!(valid_id("2026-11-12_22-45-45") && !valid_id("../x") && !valid_id(""));
    }
}
