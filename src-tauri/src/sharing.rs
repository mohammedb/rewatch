//! Sending a game to a coach, and keeping the games students send.
//!
//! A "share" is one game for one person, named by their friend code. Their app then
//! fetches a smaller copy of the video with the game's data over the same direct
//! connection teammates use, and files it under `Coaching` in their recordings folder,
//! apart from their own games. Nobody else can ask for it, and the person it was sent
//! to can ask for nothing but that game. The Discord and microphone tracks only go
//! along when the share says so.
//!
//! This file is the part that needs no connection: what has been shared with whom,
//! which files a share covers, and how a received game is stored.

use crate::settings::{app_dir, Settings};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// The folder inside the recordings folder that holds games received from students.
/// It has no `match.json` of its own, so nothing that walks the recordings sees it.
pub const INBOX: &str = "Coaching";
/// A share nobody fetched is no longer offered after this long.
pub const OFFER_FOR_MS: i64 = 30 * 24 * 3600 * 1000;

/// What a game was learned from, and small enough to always send. Riot's record goes
/// along raw as well as summarized, so a newer app at the other end can summarize it
/// again its own way.
const SMALL: [&str; 11] =
    ["match.json", "postgame.json", "riot.json", "riot_match.json", "riot_timeline.json", "mouse.csv", "keys.csv", "thumb.jpg", "insights.json", "coach.json", "team.json"];
/// The voice call, the microphone and when each spoke: only with the player's say-so.
const COMMS: [&str; 3] = ["discord.m4a", "mic.m4a", "voice.json"];

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn norm(code: &str) -> String {
    code.trim().to_lowercase()
}

/// Text from another PC, made safe to show: no control characters, and not too long.
pub fn clean(text: &str, max: usize) -> String {
    text.chars().filter(|c| !c.is_control() || *c == '\n').take(max).collect::<String>().trim().to_string()
}

fn read_json(path: &Path) -> Option<Value> {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok())
}

// ------------------------------------------------------- what I have shared

/// One game sent to one person.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Share {
    /// The recording.
    pub id: String,
    /// Their friend code.
    pub code: String,
    pub name: String,
    /// When it was sent. A game sent again gets a new time, which is how their app
    /// tells it from the one it already has (or was told to forget).
    pub at: i64,
    /// The Discord and microphone tracks go along.
    pub comms: bool,
    /// What the player wants looked at.
    pub message: String,
    /// "" (just sent) | "preparing" (the smaller copy is being made) | "novideo" |
    /// "offline" (they could not be reached) | "asked" (they have not said yes yet) |
    /// "accepted" (their app is fetching it) | "declined" | "old" (their Rewatch is
    /// too old) | "received"
    pub state: String,
    pub got_at: Option<i64>,
}

/// Reading and writing the list is one step at a time.
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Where this PC keeps what it has shared.
pub fn store() -> PathBuf {
    app_dir().join("shares.json")
}

pub fn load(path: &Path) -> Vec<Share> {
    read_json(path).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

fn change<T>(path: &Path, f: impl FnOnce(&mut Vec<Share>) -> T) -> Result<T> {
    let _one = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = load(path);
    let out = f(&mut all);
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(&all)?)?;
    fs::rename(&tmp, path)?;
    Ok(out)
}

/// Share a game with someone. Sharing it again replaces the earlier share.
pub fn grant(path: &Path, id: &str, code: &str, name: &str, comms: bool, message: &str) -> Result<Share> {
    if !valid_id(id) {
        return Err(anyhow!("Invalid recording id"));
    }
    let share = Share {
        id: id.to_string(),
        code: norm(code),
        name: clean(name, 40),
        at: now_ms(),
        comms,
        message: clean(message, 500),
        state: String::new(),
        got_at: None,
    };
    let kept = share.clone();
    change(path, move |all| {
        all.retain(|s| !(s.id == share.id && s.code == share.code));
        all.push(share);
    })?;
    Ok(kept)
}

/// Stop sharing a game with someone. A copy they already fetched stays with them.
pub fn revoke(path: &Path, id: &str, code: &str) -> Result<()> {
    let code = norm(code);
    change(path, |all| all.retain(|s| !(s.id == id && s.code == code)))
}

/// Forget every share of a game (it was deleted).
pub fn forget(path: &Path, id: &str) {
    if load(path).iter().any(|s| s.id == id) {
        let _ = change(path, |all| all.retain(|s| s.id != id));
    }
}

/// Note how a share is getting on. A share that has arrived stays arrived. Returns
/// whether anything changed.
pub fn set_state(path: &Path, id: &str, code: &str, at: i64, state: &str) -> bool {
    let code = norm(code);
    let differs = load(path).iter().any(|s| s.id == id && s.code == code && s.at == at && s.state != state && s.state != "received");
    differs
        && change(path, |all| {
            for s in all.iter_mut().filter(|s| s.id == id && s.code == code && s.at == at && s.state != "received") {
                s.state = state.to_string();
            }
        })
        .is_ok()
}

/// Their app says it has the game.
pub fn mark_got(path: &Path, id: &str, code: &str, at: i64) -> bool {
    let code = norm(code);
    change(path, |all| {
        let mut hit = false;
        for s in all.iter_mut().filter(|s| s.id == id && s.code == code && s.at == at) {
            s.state = "received".into();
            s.got_at = Some(now_ms());
            hit = true;
        }
        hit
    })
    .unwrap_or(false)
}

/// The share of game `id` with the person whose code is `code`, if there is one.
pub fn find(path: &Path, code: &str, id: &str) -> Option<Share> {
    let code = norm(code);
    load(path).into_iter().find(|s| s.id == id && s.code == code)
}

pub fn of_game(path: &Path, id: &str) -> Vec<Share> {
    load(path).into_iter().filter(|s| s.id == id).collect()
}

pub fn to_peer(path: &Path, code: &str) -> Vec<Share> {
    let code = norm(code);
    load(path).into_iter().filter(|s| s.code == code).collect()
}

/// Shares their app has not fetched yet and that are still worth offering.
pub fn open(path: &Path) -> Vec<Share> {
    let now = now_ms();
    load(path).into_iter().filter(|s| !matches!(s.state.as_str(), "received" | "declined") && now - s.at < OFFER_FOR_MS).collect()
}

// --------------------------------------------------- what a share covers

/// The video a coach is handed for a recording.
#[derive(Debug, PartialEq)]
pub enum Video {
    /// This file, of this many bytes.
    Ready(String, u64),
    /// The smaller copy has not been made yet.
    Preparing,
    /// The recording has no video any more.
    Gone,
}

/// The smaller copy when there is one, the recording itself when a copy would gain
/// nothing or could not be made, the highlight reel when that is all that is left.
pub fn video_of(dir: &Path) -> Video {
    let size = |name: &str| fs::metadata(dir.join(name)).ok().filter(|m| m.is_file() && m.len() > 0).map(|m| m.len());
    if let Some(n) = size(crate::copies::FILE) {
        return Video::Ready(crate::copies::FILE.into(), n);
    }
    match size("game.mp4") {
        Some(_) if !dir.join(crate::copies::FAILED).exists() => Video::Preparing,
        Some(n) => Video::Ready("game.mp4".into(), n),
        None => match size(crate::highlights::REEL_FILE) {
            Some(n) => Video::Ready(crate::highlights::REEL_FILE.into(), n),
            None => Video::Gone,
        },
    }
}

/// Whether the person a share is with may fetch `name` from the recording in `dir`.
pub fn may_fetch(dir: &Path, share: &Share, name: &str) -> bool {
    SMALL.contains(&name) || (share.comms && COMMS.contains(&name)) || matches!(video_of(dir), Video::Ready(video, _) if video == name)
}

/// The few facts about a game that say which one it is.
pub fn summary(doc: &Value) -> Value {
    let me = doc.pointer("/game/me").cloned().unwrap_or(Value::Null);
    json!({
        "player": me.get("name"),
        "champion": me.get("champion"),
        "championKey": me.get("championKey"),
        "kills": me.get("kills"),
        "deaths": me.get("deaths"),
        "assists": me.get("assists"),
        "queueName": doc.pointer("/game/queueName"),
        "result": doc.pointer("/game/result"),
        "duration": doc.get("duration"),
        "startedEpochMs": doc.get("startedEpochMs"),
    })
}

/// The same facts as they arrive from another PC: only the fields known here, each
/// of the kind and length expected.
pub fn clean_summary(v: &Value) -> Value {
    let text = |k: &str, max: usize| v.get(k).and_then(|x| x.as_str()).map(|s| clean(s, max)).filter(|s| !s.is_empty());
    let int = |k: &str| v.get(k).and_then(|x| x.as_i64());
    json!({
        "player": text("player", 60),
        "champion": text("champion", 40),
        "championKey": text("championKey", 40),
        "kills": int("kills"),
        "deaths": int("deaths"),
        "assists": int("assists"),
        "queueName": text("queueName", 60),
        "result": text("result", 10),
        "duration": v.get("duration").and_then(|x| x.as_f64()).filter(|d| d.is_finite() && *d >= 0.0),
        "startedEpochMs": int("startedEpochMs"),
    })
}

/// What their app is told about a share: the video to fetch and the files that go
/// with it. None while the video is not ready, or when there is none.
pub fn package(root: &Path, share: &Share) -> Option<Value> {
    if !valid_id(&share.id) {
        return None;
    }
    let dir = root.join(&share.id);
    let doc = read_json(&dir.join("match.json"))?;
    let Video::Ready(video, size) = video_of(&dir) else { return None };
    let files: Vec<Value> = SMALL
        .iter()
        .chain(COMMS.iter().filter(|_| share.comms))
        .filter_map(|name| {
            let len = fs::metadata(dir.join(name)).ok().filter(|m| m.is_file())?.len();
            Some(json!({ "name": name, "size": len }))
        })
        .collect();
    Some(json!({
        "id": share.id,
        "at": share.at,
        "comms": share.comms,
        "message": share.message,
        "video": { "file": video, "size": size },
        "files": files,
        "game": summary(&doc),
    }))
}

// ----------------------------------------------------- what I have received

/// Who a received game came from. Kept in the game's `match.json` under `from`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct From {
    pub name: String,
    pub code: String,
    /// The recording's id on their PC.
    pub id: String,
    /// When they sent it.
    pub at: i64,
    pub comms: bool,
    pub message: String,
    pub received_at: i64,
}

pub fn inbox(settings: &Settings) -> Option<PathBuf> {
    settings.recordings_path().map(|root| root.join(INBOX))
}

/// The folder of a recording, wherever it lives: one of mine, or one sent to me.
pub fn game_dir(root: &Path, id: &str) -> Option<PathBuf> {
    if !valid_id(id) {
        return None;
    }
    [root.join(id), root.join(INBOX).join(id)].into_iter().find(|dir| dir.join("match.json").exists())
}

/// The name a received game is filed under: their id for it, and the start of their
/// code so two students' games never collide. It is this PC's id for the game.
pub fn folder(id: &str, code: &str) -> String {
    format!("{id}_{}", code.chars().filter(|c| c.is_ascii_alphanumeric()).take(6).collect::<String>().to_lowercase())
}

/// Who the game in `dir` came from, if it was sent to me.
pub fn from_of(dir: &Path) -> Option<From> {
    let doc = read_json(&dir.join("match.json"))?;
    serde_json::from_value(doc.get("from")?.clone()).ok().filter(|f: &From| !f.code.is_empty())
}

/// Every game received, complete ones only: `match.json` is written last.
pub fn received(inbox: &Path) -> Vec<(PathBuf, From)> {
    let Ok(entries) = fs::read_dir(inbox) else { return Vec::new() };
    entries.flatten().filter_map(|e| Some((e.path(), from_of(&e.path())?))).collect()
}

/// The game `id` (their id) received from the person with this code.
pub fn find_received(inbox: &Path, code: &str, id: &str) -> Option<(PathBuf, From)> {
    if !valid_id(id) {
        return None;
    }
    let dir = inbox.join(folder(id, code));
    let from = from_of(&dir)?;
    (from.code == norm(code) && from.id == id).then_some((dir, from))
}

/// What names one sending of one game by one person.
pub fn key(code: &str, id: &str, at: i64) -> String {
    format!("{}|{id}|{at}", norm(code))
}

fn removed_file(inbox: &Path) -> PathBuf {
    inbox.join("removed.json")
}

/// Sendings turned down or deleted here, which are not to be fetched again.
pub fn removed(inbox: &Path) -> Vec<String> {
    read_json(&removed_file(inbox)).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

pub fn mark_removed(inbox: &Path, key: &str) {
    let _one = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = removed(inbox);
    if all.iter().any(|k| k == key) {
        return;
    }
    all.push(key.to_string());
    // Old entries can go: a sending is offered for a month at most.
    if all.len() > 2000 {
        all.drain(..all.len() - 2000);
    }
    let _ = fs::create_dir_all(inbox);
    let _ = fs::write(removed_file(inbox), serde_json::to_vec(&all).unwrap_or_default());
}

/// Whether what a student offers should be fetched: not turned down or deleted here,
/// and not here already.
pub fn wanted(inbox: &Path, code: &str, pkg: &Value) -> bool {
    let (Some(id), Some(at)) = (pkg.get("id").and_then(|x| x.as_str()), pkg.get("at").and_then(|x| x.as_i64())) else { return false };
    if !valid_id(id) || removed(inbox).contains(&key(code, id, at)) {
        return false;
    }
    !find_received(inbox, code, id).is_some_and(|(_, from)| from.at == at)
}

/// A student's `match.json` as it is kept here: under this PC's id for it, marked
/// with who sent it, naming the video as it is stored here, and listing only the
/// sound tracks that came along.
pub fn localize(mut doc: Value, local_id: &str, from: &From, video: &str) -> Result<Value> {
    let o = doc.as_object_mut().ok_or_else(|| anyhow!("their match.json is not a game"))?;
    o.insert("id".into(), json!(local_id));
    o.insert("from".into(), serde_json::to_value(from)?);
    o.insert("video".into(), json!(video));
    // File names are this app's own, whatever theirs says: nothing it names can point
    // outside the game's folder.
    if let Some(tracks) = o.get_mut("tracks").and_then(|t| t.as_array_mut()) {
        tracks.retain(|t| match t.get("name").and_then(|n| n.as_str()) {
            Some("game") => true,
            Some("discord" | "mic") => from.comms,
            _ => false,
        });
        for t in tracks.iter_mut() {
            let file = match t.get("name").and_then(|n| n.as_str()) {
                Some("discord") => json!("discord.m4a"),
                Some("mic") => json!("mic.m4a"),
                _ => Value::Null,
            };
            t["file"] = file;
        }
    }
    for (log, file) in [("mouse", "mouse.csv"), ("keys", "keys.csv")] {
        if let Some(meta) = o.get_mut(log).and_then(|m| m.as_object_mut()) {
            meta.insert("file".into(), json!(file));
        }
    }
    Ok(doc)
}

/// Whose notes to ask for on the game in `dir`, besides teammates': the person it
/// came from, or the people it was sent to. Each as (name, code, the game's id on the
/// PC that recorded it).
pub fn audience(store: &Path, dir: &Path, id: &str) -> Vec<(String, String, String)> {
    match from_of(dir) {
        Some(from) => vec![(from.name, from.code, from.id)],
        None => of_game(store, id).into_iter().map(|s| (s.name, s.code, s.id)).collect(),
    }
}

/// The names of files a share may carry besides the video, for the receiving side to
/// check what it is told against.
pub fn carried(name: &str, comms: bool) -> bool {
    SMALL.contains(&name) || (comms && COMMS.contains(&name))
}

#[cfg(test)]
mod tests {
    use super::*;

    const COACH: &str = "c4e19d2a7b3f5061a8d4e2c9b7f1a3d5e6c8b0a2f4d6e8c1a3b5d7f9e0c2a4b6";
    const OTHER: &str = "9d41c7e2a0b3f5648c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b";

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rewatch-share-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn game(root: &Path, id: &str) -> PathBuf {
        let dir = root.join(id);
        fs::create_dir_all(&dir).unwrap();
        let doc = json!({
            "id": id, "video": "game.mp4", "duration": 1800.0, "startedEpochMs": 5,
            "tracks": [{ "name": "game", "file": null }, { "name": "discord", "file": "discord.m4a" }, { "name": "mic", "file": "mic.m4a" }],
            "game": { "queueName": "Ranked Solo", "result": "Win", "me": { "name": "Rin", "champion": "Ahri", "championKey": "Ahri", "kills": 7 } }
        });
        fs::write(dir.join("match.json"), doc.to_string()).unwrap();
        for name in ["game.mp4", "review.mp4", "discord.m4a", "mic.m4a", "voice.json", "mouse.csv", "review.json", "session.json"] {
            fs::write(dir.join(name), b"data").unwrap();
        }
        dir
    }

    #[test]
    fn a_share_is_one_game_for_one_person() {
        let root = temp("grant");
        let store = root.join("shares.json");
        let dir = game(&root, "2026-11-12_22-45-45");
        game(&root, "2026-11-13_00-42-08");
        let share = grant(&store, "2026-11-12_22-45-45", &format!("  {} ", COACH.to_uppercase()), "Coach K", false, "Look at my recalls\u{7}").unwrap();
        assert_eq!((share.code.as_str(), share.message.as_str()), (COACH, "Look at my recalls"));

        // The coach finds that game and no other; anyone else finds nothing.
        assert!(find(&store, COACH, "2026-11-12_22-45-45").is_some());
        assert!(find(&store, COACH, "2026-11-13_00-42-08").is_none());
        assert!(find(&store, OTHER, "2026-11-12_22-45-45").is_none());
        assert!(to_peer(&store, OTHER).is_empty());

        // The video with game sound, the cursor log and the game's data: yes. The voice
        // call, the microphone, the player's own review file and anything else: no.
        for name in ["review.mp4", "match.json", "mouse.csv"] {
            assert!(may_fetch(&dir, &share, name), "{name}");
        }
        for name in ["discord.m4a", "mic.m4a", "voice.json", "review.json", "session.json", "game.mp4", "..\\settings.json"] {
            assert!(!may_fetch(&dir, &share, name), "{name}");
        }
        let pkg = package(&root, &share).unwrap();
        assert_eq!(pkg["video"], json!({ "file": "review.mp4", "size": 4 }));
        let names: Vec<&str> = pkg["files"].as_array().unwrap().iter().filter_map(|f| f["name"].as_str()).collect();
        assert_eq!(names, ["match.json", "mouse.csv"]);
        assert_eq!(pkg["game"]["champion"], "Ahri");

        // Sharing again with the voices replaces the first share and covers them too.
        let again = grant(&store, "2026-11-12_22-45-45", COACH, "Coach K", true, "").unwrap();
        assert_eq!(load(&store).len(), 1);
        assert!(may_fetch(&dir, &again, "discord.m4a") && may_fetch(&dir, &again, "voice.json"));
        assert!(!may_fetch(&dir, &again, "review.json"));

        revoke(&store, "2026-11-12_22-45-45", COACH).unwrap();
        assert!(find(&store, COACH, "2026-11-12_22-45-45").is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_video_handed_out_is_the_smaller_copy_when_there_is_one() {
        let root = temp("video");
        let dir = game(&root, "g");
        assert_eq!(video_of(&dir), Video::Ready("review.mp4".into(), 4));
        // No copy yet: wait for it rather than send several gigabytes.
        fs::remove_file(dir.join("review.mp4")).unwrap();
        assert_eq!(video_of(&dir), Video::Preparing);
        assert!(package(&root, &Share { id: "g".into(), ..Default::default() }).is_none());
        // A copy that would gain nothing: the recording itself.
        fs::write(dir.join(crate::copies::FAILED), b"x").unwrap();
        assert_eq!(video_of(&dir), Video::Ready("game.mp4".into(), 4));
        // Trimmed to its highlights, then deleted.
        fs::remove_file(dir.join("game.mp4")).unwrap();
        fs::write(dir.join(crate::highlights::REEL_FILE), b"reel!").unwrap();
        assert_eq!(video_of(&dir), Video::Ready(crate::highlights::REEL_FILE.into(), 5));
        fs::remove_file(dir.join(crate::highlights::REEL_FILE)).unwrap();
        assert_eq!(video_of(&dir), Video::Gone);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn states_move_forward_and_arrival_sticks() {
        let root = temp("state");
        let store = root.join("shares.json");
        let s = grant(&store, "g", COACH, "K", false, "").unwrap();
        assert_eq!(open(&store).len(), 1);
        assert!(set_state(&store, "g", COACH, s.at, "asked"));
        assert!(!set_state(&store, "g", COACH, s.at, "asked"), "nothing to write when nothing changed");
        // An answer about an earlier sending of the same game changes nothing.
        assert!(!mark_got(&store, "g", COACH, s.at - 1));
        assert!(mark_got(&store, "g", COACH, s.at));
        assert!(!set_state(&store, "g", COACH, s.at, "offline"));
        let now = find(&store, COACH, "g").unwrap();
        assert!(now.state == "received" && now.got_at.is_some());
        assert!(open(&store).is_empty());
        forget(&store, "g");
        assert!(load(&store).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_received_game_is_kept_apart_and_not_fetched_twice() {
        let root = temp("inbox");
        let inbox = root.join(INBOX);
        let pkg = json!({ "id": "2026-11-12_22-45-45", "at": 100 });
        assert!(wanted(&inbox, COACH, &pkg));
        assert!(!wanted(&inbox, COACH, &json!({ "id": "../x", "at": 1 })));

        let local = folder("2026-11-12_22-45-45", COACH);
        assert_eq!(local, "2026-11-12_22-45-45_c4e19d");
        assert!(valid_id(&local));
        let from = From { name: "Rin".into(), code: COACH.into(), id: "2026-11-12_22-45-45".into(), at: 100, comms: false, message: "recalls".into(), received_at: 7 };
        let theirs = json!({
            "id": "2026-11-12_22-45-45", "video": "video.mkv", "mouse": { "file": "..\\..\\settings.json", "w": 2560 },
            "tracks": [{ "name": "game" }, { "name": "discord", "file": "C:\\x.m4a" }, { "name": "mic" }, { "name": "other", "file": "x" }]
        });
        let doc = localize(theirs.clone(), &local, &from, "game.mp4").unwrap();
        assert_eq!((doc["id"].as_str(), doc["video"].as_str()), (Some(local.as_str()), Some("game.mp4")));
        assert_eq!(doc["tracks"].as_array().unwrap().len(), 1, "the voices did not come along, so their tracks are not listed");
        assert_eq!(doc["mouse"], json!({ "file": "mouse.csv", "w": 2560 }), "a file name of theirs is never taken as it is");
        let with_voices = localize(theirs, &local, &From { comms: true, ..from.clone() }, "game.mp4").unwrap();
        let files: Vec<&Value> = with_voices["tracks"].as_array().unwrap().iter().map(|t| &t["file"]).collect();
        assert_eq!(files, [&Value::Null, &json!("discord.m4a"), &json!("mic.m4a")]);
        assert!(localize(json!([1]), &local, &from, "game.mp4").is_err());

        // Half fetched (no match.json yet) is not there; whole is.
        fs::create_dir_all(inbox.join(&local)).unwrap();
        assert!(received(&inbox).is_empty() && wanted(&inbox, COACH, &pkg));
        fs::write(inbox.join(&local).join("match.json"), doc.to_string()).unwrap();
        assert_eq!(received(&inbox).len(), 1);
        assert!(!wanted(&inbox, COACH, &pkg));
        assert!(wanted(&inbox, COACH, &json!({ "id": "2026-11-12_22-45-45", "at": 200 })), "sent again: fetch the new one");
        assert!(find_received(&inbox, OTHER, "2026-11-12_22-45-45").is_none());
        assert_eq!(game_dir(&root, &local), Some(inbox.join(&local)));
        assert_eq!(game_dir(&root, "nope"), None);
        // It is asked for its sender's notes, not teammates'.
        assert_eq!(audience(&root.join("shares.json"), &inbox.join(&local), &local), vec![("Rin".to_string(), COACH.to_string(), "2026-11-12_22-45-45".to_string())]);

        // Deleted here: the same sending is not fetched again.
        fs::remove_dir_all(inbox.join(&local)).unwrap();
        mark_removed(&inbox, &key(COACH, "2026-11-12_22-45-45", 100));
        assert!(!wanted(&inbox, COACH, &pkg));
        assert!(wanted(&inbox, COACH, &json!({ "id": "2026-11-12_22-45-45", "at": 200 })));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn what_arrives_from_another_pc_is_cut_to_size() {
        let v = clean_summary(&json!({ "champion": "Ahri\u{0}\u{1b}[31m", "queueName": "x".repeat(500), "kills": "many", "duration": -4.0, "extra": { "deep": true } }));
        assert_eq!(v["champion"], "Ahri[31m");
        assert_eq!(v["queueName"].as_str().unwrap().len(), 60);
        assert!(v["kills"].is_null() && v["duration"].is_null() && v.get("extra").is_none());
        assert_eq!(clean("  a\tb\r\nc  ", 10), "ab\nc");
    }
}
