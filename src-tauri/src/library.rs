//! The recordings folder: one sub-folder per game, each with match.json. There is no
//! database; the library is whatever folders are on disk.

use crate::settings::{log, Settings};
use crate::video::run_tool;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The folder of a recording: one of the player's own, or one a student sent (those
/// live under `Coaching`, see `sharing`).
fn match_dir(settings: &Settings, id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        return Err(anyhow!("Invalid recording id"));
    }
    let root = settings.recordings_path().ok_or_else(|| anyhow!("No recordings folder is set"))?;
    crate::sharing::game_dir(&root, id).ok_or_else(|| anyhow!("Recording not found"))
}

/// Bytes in a recording's folder: all of it, and the part that is video and sound
/// (what `delete_video` would free).
fn sizes(dir: &Path) -> (u64, u64) {
    let (mut all, mut media) = (0, 0);
    for e in fs::read_dir(dir).into_iter().flatten().flatten() {
        let Some(len) = e.metadata().ok().filter(|m| m.is_file()).map(|m| m.len()) else { continue };
        all += len;
        if is_media(&e.path()) {
            media += len;
        }
    }
    (all, media)
}

fn read_json(path: &Path) -> Option<Value> {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok())
}

fn default_review() -> Value {
    json!({ "keep": false, "notes": [], "drawings": [] })
}

fn read_review(dir: &Path) -> Value {
    read_json(&dir.join("review.json")).unwrap_or_else(default_review)
}

/// A game counts as reviewed once the player marked it so in the app.
fn is_reviewed(review: &Value) -> bool {
    review.get("reviewedAt").and_then(|v| v.as_i64()).is_some()
}

/// The thing the player chose to work on in their next games: the newest "next focus"
/// written into any review, if it is still worded.
pub fn latest_focus(settings: &Settings) -> Option<String> {
    let root = settings.recordings_path()?;
    let mut best: Option<(i64, String)> = None;
    for entry in fs::read_dir(&root).ok()?.flatten() {
        let Some(review) = read_json(&entry.path().join("review.json")) else { continue };
        let Some(focus) = review.get("nextFocus") else { continue };
        let text = focus.get("text").and_then(|v| v.as_str()).map(str::trim).unwrap_or("");
        let set_at = focus.get("setAt").and_then(|v| v.as_i64()).unwrap_or(0);
        if !text.is_empty() && best.as_ref().is_none_or(|(at, _)| set_at > *at) {
            best = Some((set_at, text.to_string()));
        }
    }
    best.map(|(_, text)| text)
}

fn source_video(dir: &Path) -> PathBuf {
    if let Some(doc) = read_json(&dir.join("match.json")) {
        if let Some(name) = doc.get("video").and_then(|v| v.as_str()) {
            let p = dir.join(name);
            if p.exists() {
                return p;
            }
        }
    }
    let game = dir.join("game.mp4");
    if game.exists() {
        return game;
    }
    let reel = dir.join(crate::highlights::REEL_FILE);
    if reel.exists() {
        return reel;
    }
    game
}

/// Whether a recording still has a video to play: the file match.json names, the full
/// game, or its highlight reel. Without one, only its stats, notes and Riot's record are
/// left (see `delete_video`).
fn has_video(dir: &Path, doc: Option<&Value>) -> bool {
    doc.and_then(|d| d.get("video")).and_then(|v| v.as_str()).is_some_and(|name| dir.join(name).exists())
        || dir.join("game.mp4").exists()
        || dir.join(crate::highlights::REEL_FILE).exists()
}

/// The video to cut a clip or an export from, or why there is none.
fn video_to_cut(dir: &Path) -> Result<PathBuf> {
    let video = source_video(dir);
    if video.exists() {
        Ok(video)
    } else {
        Err(anyhow!("This game's video was deleted, so there is nothing to cut from. Its stats are kept."))
    }
}

/// The kinds of file that hold a recording's picture or sound: the full game, the
/// smaller copy for teammates, the highlight reel and clips, the Discord and microphone
/// tracks, teammates' views saved here, an export for editing, and any of those half
/// written. Everything else in the folder is what was learned from the game.
const MEDIA: [&str; 7] = ["mp4", "m4a", "mkv", "wav", "webm", "mov", "part"];

fn is_media(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| MEDIA.iter().any(|m| e.eq_ignore_ascii_case(m)))
}

/// `discord.m4a` or `mic.m4a`, if it exists and still lines up with the video. A game
/// trimmed to its highlight reel has those voices mixed into the reel instead.
fn side_track(dir: &Path, name: &str) -> Option<PathBuf> {
    let trimmed = read_json(&dir.join("match.json"))
        .and_then(|d| d.get("trimmedToHighlights").and_then(|v| v.as_bool()))
        .unwrap_or(false);
    let file = dir.join(format!("{name}.m4a"));
    (!trimmed && file.exists()).then_some(file)
}

/// The player's own recordings, newest first, without the heavy per-event data.
pub fn list(settings: &Settings) -> Vec<Value> {
    let Some(root) = settings.recordings_path() else { return Vec::new() };
    list_in(&root)
}

/// The player's own recordings and the games students sent (marked with `from`),
/// newest first. For the library and the size limit; everything that counts games
/// (Trends, the losing streak, the focus) looks at the player's own only.
pub fn list_all(settings: &Settings) -> Vec<Value> {
    let mut out = list(settings);
    if let Some(inbox) = crate::sharing::inbox(settings) {
        out.extend(list_in(&inbox).into_iter().filter(|m| m.get("from").is_some_and(|f| f.is_object())));
    }
    out.sort_by(|a, b| b["id"].as_str().cmp(&a["id"].as_str()));
    out
}

fn list_in(root: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root) else { return out };
    for entry in entries.flatten() {
        let dir = entry.path();
        let Some(mut doc) = read_json(&dir.join("match.json")) else { continue };
        let review = read_review(&dir);
        let video = has_video(&dir, Some(&doc));
        if let Some(o) = doc.as_object_mut() {
            let count = |kind: &str, role: Option<&str>| -> usize {
                o.get("events")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter(|e| e["kind"] == kind && role.map(|r| e["role"] == r).unwrap_or(true))
                            .count()
                    })
                    .unwrap_or(0)
            };
            let bookmarks = o.get("bookmarks").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
            let summary = json!({ "deaths": count("ChampionKill", Some("death")), "bookmarks": bookmarks });
            o.remove("events");
            o.remove("clock");
            o.remove("stats");
            o.insert("summary".into(), summary);
            o.insert("dir".into(), json!(dir.to_string_lossy()));
            let (size, media) = sizes(&dir);
            o.insert("sizeBytes".into(), json!(size));
            o.insert("videoBytes".into(), json!(media));
            o.insert("hasVideo".into(), json!(video));
            o.insert("keep".into(), review.get("keep").cloned().unwrap_or(json!(false)));
            o.insert("tags".into(), review.get("tags").cloned().unwrap_or_else(|| json!([])));
            o.insert("reviewed".into(), json!(is_reviewed(&review)));
            o.insert("nextFocus".into(), review.get("nextFocus").cloned().unwrap_or(Value::Null));
            o.insert("focusCheck".into(), review.get("focusCheck").cloned().unwrap_or(Value::Null));
            let notes_text: String = review
                .get("notes")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|n| n.get("text").and_then(|t| t.as_str()))
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default();
            o.insert("notesText".into(), json!(notes_text));
            o.insert(
                "noteCount".into(),
                json!(review.get("notes").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0)),
            );
            let thumb = dir.join("thumb.jpg");
            o.insert("thumb".into(), if thumb.exists() { json!(thumb.to_string_lossy()) } else { Value::Null });
            let reel = dir.join(crate::highlights::REEL_FILE);
            o.insert("reel".into(), if reel.exists() { json!(reel.to_string_lossy()) } else { Value::Null });
            // LP won or lost, once Riot has it (see `riot`).
            o.insert("rank".into(), crate::riot::status(&dir).0);
            // Stomp, comeback, throw or close, from Riot's gold numbers.
            o.insert("story".into(), json!(crate::riot::story_of(&dir)));
        }
        out.push(doc);
    }
    out.sort_by(|a, b| b["id"].as_str().cmp(&a["id"].as_str()));
    out
}

/// One recording with everything the player needs.
pub fn get(settings: &Settings, id: &str) -> Result<Value> {
    let dir = match_dir(settings, id)?;
    let mut doc = read_json(&dir.join("match.json")).ok_or_else(|| anyhow!("match.json is unreadable"))?;
    let video = has_video(&dir, Some(&doc));
    if let Some(o) = doc.as_object_mut() {
        o.insert("dir".into(), json!(dir.to_string_lossy()));
        let (size, media) = sizes(&dir);
        o.insert("sizeBytes".into(), json!(size));
        o.insert("videoBytes".into(), json!(media));
        o.insert("hasVideo".into(), json!(video));
        o.insert("review".into(), read_review(&dir));
        // A title per player, from the game's own numbers.
        let titles = crate::titles::for_match(&Value::Object(o.clone()));
        o.insert("titles".into(), json!(titles));
        // Speech times, if they have been worked out already (see `voice`).
        o.insert("voice".into(), read_json(&dir.join("voice.json")).unwrap_or(Value::Null));
        // Hints about each death, if they have been asked for (see `insight`).
        o.insert("insights".into(), crate::insight::load(&dir).unwrap_or(Value::Null));
        o.insert("coach".into(), crate::coach::load(&dir).unwrap_or(Value::Null));
        o.insert("team".into(), json!(crate::team::load(&dir)));
        let highlights = crate::highlights::list(&Value::Object(o.clone()), &dir);
        o.insert("highlights".into(), json!(highlights));
        let reel = dir.join(crate::highlights::REEL_FILE);
        o.insert("reel".into(), if reel.exists() { json!(reel.to_string_lossy()) } else { Value::Null });
        // Riot's record of the game, everyone's rank, the LP it won or lost, and why
        // the record is missing if it is (see `riot`). A game a student sent may carry
        // a summary from an older app.
        if o.get("from").is_some_and(|f| f.is_object()) {
            crate::riot::resummarize(&dir);
        }
        let pg = crate::riot::load(&dir);
        o.insert("playerRanks".into(), crate::riot::player_ranks(&dir, pg.as_ref()));
        o.insert("story".into(), json!(pg.as_ref().and_then(crate::riot::story)));
        o.insert("postgame".into(), pg.unwrap_or(Value::Null));
        let (rank, note) = crate::riot::status(&dir);
        o.insert("rank".into(), rank);
        o.insert("postgameNote".into(), note);
    }
    Ok(doc)
}

/// Fetch a game's post-game data from Riot now.
pub fn postgame_fetch(settings: &Settings, id: &str) -> Result<Value> {
    let dir = match_dir(settings, id)?;
    crate::riot::fetch_now(settings, &dir)
}

/// Ask for hints about the deaths in a recording now (or return what is already there).
pub fn insights(settings: &Settings, id: &str, stop: &dyn Fn() -> bool) -> Result<Value> {
    let dir = match_dir(settings, id)?;
    crate::insight::analyze(settings, &dir, stop)
}

/// The highlights of a recording; with `save`, their clips are made now.
pub fn highlights(settings: &Settings, id: &str, save: bool, stop: &dyn Fn() -> bool) -> Result<Vec<Value>> {
    let dir = match_dir(settings, id)?;
    if save {
        return crate::highlights::save(settings, &dir, stop);
    }
    let doc = read_json(&dir.join("match.json")).ok_or_else(|| anyhow!("match.json is unreadable"))?;
    Ok(crate::highlights::list(&doc, &dir))
}

/// Stitch a game's highlights into `highlights_reel.mp4`. In Highlights-only mode the
/// full recording is removed later, by `highlights::trim_due`.
pub fn build_highlight_reel(settings: &Settings, id: &str, stop: &dyn Fn() -> bool) -> Result<String> {
    let dir = match_dir(settings, id)?;
    let out = crate::highlights::build_reel(settings, &dir, stop)?;
    Ok(out.to_string_lossy().to_string())
}

/// When the files a Trends row is made from last changed.
type TrendStamp = [Option<std::time::SystemTime>; 5];

/// Trends rows already worked out, by recording folder, with the stamp they were made at.
static TREND_CACHE: std::sync::Mutex<Option<std::collections::HashMap<PathBuf, (TrendStamp, Value)>>> = std::sync::Mutex::new(None);

fn trend_stamp(dir: &Path) -> TrendStamp {
    let changed = |name: &str| fs::metadata(dir.join(name)).and_then(|m| m.modified()).ok();
    [
        changed("match.json"),
        changed("review.json"),
        changed(crate::insight::FILE),
        changed(crate::riot::FILE),
        changed(crate::riot::RIOT_FILE),
    ]
}

/// Compact cross-game metrics for the library Trends view. Each recording is read once
/// and again only when its match, review or insights file changes.
pub fn trends(settings: &Settings) -> Vec<Value> {
    let mut out = Vec::new();
    let Some(root) = settings.recordings_path() else { return out };
    let Ok(entries) = fs::read_dir(&root) else { return out };
    let mut guard = TREND_CACHE.lock().unwrap();
    let cache = guard.get_or_insert_with(Default::default);
    for entry in entries.flatten() {
        let dir = entry.path();
        let stamp = trend_stamp(&dir);
        if let Some((_, row)) = cache.get(&dir).filter(|(seen, _)| *seen == stamp) {
            let mut row = row.clone();
            row["hasVideo"] = json!(has_video(&dir, None));
            out.push(row);
            continue;
        }
        let Some(doc) = read_json(&dir.join("match.json")) else { continue };
        let Some(id) = doc.get("id").and_then(|v| v.as_str()) else { continue };
        let game = doc.get("game").cloned().unwrap_or(Value::Null);
        let me = game.get("me").cloned().unwrap_or(Value::Null);
        let champion = me.get("champion").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if champion.is_empty() {
            continue;
        }
        let my_name = me.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let my_team = me.get("team").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let position = me.get("position").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let kills = me.get("kills").and_then(|v| v.as_i64()).unwrap_or(0);
        let deaths = me.get("deaths").and_then(|v| v.as_i64()).unwrap_or(0);
        let assists = me.get("assists").and_then(|v| v.as_i64()).unwrap_or(0);
        let cs = me.get("cs").and_then(|v| v.as_i64()).unwrap_or(0);
        let wards = me.get("wards").and_then(|v| v.as_f64());
        let length = game
            .get("length")
            .and_then(|v| v.as_f64())
            .or_else(|| doc.get("duration").and_then(|v| v.as_f64()))
            .unwrap_or(0.0);

        let allies: Vec<Value> = game
            .get("players")
            .and_then(|v| v.as_array())
            .map(|ps| {
                ps.iter()
                    .filter(|p| {
                        p.get("isMe").and_then(|v| v.as_bool()) != Some(true)
                            && !my_team.is_empty()
                            && p.get("team").and_then(|v| v.as_str()) == Some(my_team.as_str())
                    })
                    .filter_map(|p| {
                        let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
                        (!name.is_empty()).then(|| {
                            json!({
                                "name": name,
                                "champion": p.get("champion").and_then(|v| v.as_str()).unwrap_or(""),
                            })
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        // CS@10 / CS@15 and dead-time % from stats + clock if present.
        let (mut cs10, mut cs15, mut dead_pct) = (None::<i64>, None::<i64>, None::<f64>);
        if let (Some(stats), Some(clock)) = (doc.get("stats"), doc.get("clock").and_then(|c| c.as_array())) {
            let t_arr = stats.get("t").and_then(|v| v.as_array());
            let my_row = stats.get("players").and_then(|v| v.as_array()).and_then(|ps| {
                ps.iter().find(|p| p.get("name").and_then(|n| n.as_str()) == Some(my_name.as_str()))
            });
            if let (Some(ts), Some(row)) = (t_arr, my_row) {
                let to_game = |vt: f64| -> f64 {
                    if clock.is_empty() {
                        return vt;
                    }
                    // The clock samples are in time order: stop at the first one after `vt`.
                    let best_i = clock
                        .iter()
                        .take_while(|c| c.get(0).and_then(|x| x.as_f64()).unwrap_or(0.0) <= vt)
                        .count()
                        .saturating_sub(1);
                    let c0 = clock[best_i].get(0).and_then(|x| x.as_f64()).unwrap_or(0.0);
                    let g0 = clock[best_i].get(1).and_then(|x| x.as_f64()).unwrap_or(0.0);
                    g0 + (vt - c0)
                };
                if let Some(cs_arr) = row.get("cs").and_then(|v| v.as_array()) {
                    for (i, t) in ts.iter().enumerate() {
                        let Some(vt) = t.as_f64() else { continue };
                        let gt = to_game(vt);
                        let val = cs_arr.get(i).and_then(|x| x.as_i64());
                        if gt >= 600.0 && cs10.is_none() {
                            cs10 = val;
                        }
                        if gt >= 900.0 && cs15.is_none() {
                            cs15 = val;
                        }
                        if cs15.is_some() {
                            break;
                        }
                    }
                }
                if let Some(dead_arr) = row.get("dead").and_then(|v| v.as_array()) {
                    if !dead_arr.is_empty() {
                        let d = dead_arr.iter().filter(|x| x.as_bool() == Some(true)).count();
                        dead_pct = Some((d as f64 / dead_arr.len() as f64) * 100.0);
                    }
                }
            }
        }

        let insights = crate::insight::load(&dir);
        let mut death_causes: Vec<String> = Vec::new();
        let mut avoid_vals: Vec<f64> = Vec::new();
        if let Some(deaths_arr) = insights.as_ref().and_then(|v| v.get("deaths")).and_then(|v| v.as_array()) {
            for d in deaths_arr {
                if let Some(c) = d.get("cause").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) {
                    death_causes.push(c.to_string());
                }
                if let Some(a) = d.get("avoidable").and_then(|x| x.as_f64()) {
                    avoid_vals.push(a);
                }
            }
        }
        let avg_avoidable = (!avoid_vals.is_empty()).then(|| avoid_vals.iter().sum::<f64>() / avoid_vals.len() as f64);

        let review = read_review(&dir);
        // Riot's record: damage share, lane gold, where you died; and the LP.
        let pg = crate::riot::load(&dir)
            .map(|pg| crate::riot::trend_extras(&pg, &crate::riot::clock_of(&doc), doc.get("duration").and_then(|d| d.as_f64()).unwrap_or(0.0)))
            .unwrap_or(Value::Null);
        let row = json!({
            "id": id,
            "startedEpochMs": doc.get("startedEpochMs"),
            "queueId": game.get("queueId"),
            "queueName": game.get("queueName"),
            "result": game.get("result"),
            "champion": champion,
            "championKey": me.get("championKey"),
            "position": position,
            "kills": kills,
            "deaths": deaths,
            "assists": assists,
            "cs": cs,
            "wards": wards,
            "length": length,
            "cs10": cs10,
            "cs15": cs15,
            "deadPct": dead_pct,
            "allies": allies,
            "tags": review.get("tags").cloned().unwrap_or_else(|| json!([])),
            "keep": review.get("keep").cloned().unwrap_or(json!(false)),
            "reviewed": is_reviewed(&review),
            "focus": review.get("focusCheck").cloned().unwrap_or(Value::Null),
            "deathCauses": death_causes,
            "avgAvoidable": avg_avoidable,
            "rank": crate::riot::status(&dir).0,
            "pg": pg,
        });
        let mut shown = row.clone();
        shown["hasVideo"] = json!(has_video(&dir, Some(&doc)));
        cache.insert(dir, (stamp, row));
        out.push(shown);
    }
    out.sort_by(|a, b| b["id"].as_str().cmp(&a["id"].as_str()));
    out
}

/// Review one team fight of a recording from every view given.
pub fn team_review(settings: &Settings, id: &str, start: f64, end: f64, views: &[crate::team::View], stop: &dyn Fn() -> bool) -> Result<Value> {
    let dir = match_dir(settings, id)?;
    crate::team::review(settings, &dir, start, end, views, stop)
}

/// Write the coach's review of a recording now (or return the one already there).
pub fn coach(settings: &Settings, id: &str, stop: &dyn Fn() -> bool) -> Result<Value> {
    let dir = match_dir(settings, id)?;
    crate::coach::review(settings, &dir, stop)
}

/// When someone was talking on the microphone and Discord tracks of a recording.
/// Worked out on first use for recordings made before this existed.
pub fn voice(settings: &Settings, id: &str) -> Result<Value> {
    let dir = match_dir(settings, id)?;
    let (ffmpeg, _) = settings.ffmpeg_tools();
    Ok(crate::voice::for_dir(&ffmpeg, &dir))
}

pub fn save_review(settings: &Settings, id: &str, review: &Value) -> Result<()> {
    let dir = match_dir(settings, id)?;
    fs::write(dir.join("review.json"), serde_json::to_string_pretty(review)?)?;
    Ok(())
}

/// Games further apart than this are separate sittings.
const SITTING_GAP_MS: i64 = 60 * 60 * 1000;

/// Losses in a row at the end of a sitting. `games` is (start, end, result), newest
/// first; games without a result (practice, remakes, recordings outside a game) are
/// passed over, and a gap of an hour ends the sitting.
fn losing_streak_of(games: &[(i64, i64, Option<&str>)]) -> usize {
    let mut streak = 0;
    let mut next_start: Option<i64> = None;
    for (start, end, result) in games {
        if next_start.is_some_and(|n| n - end > SITTING_GAP_MS) {
            break;
        }
        next_start = Some(*start);
        match result {
            Some("Lose") => streak += 1,
            Some(_) => break,
            None => {}
        }
    }
    streak
}

/// How many games in a row the player has lost in this sitting, the newest game
/// included.
pub fn losing_streak(settings: &Settings) -> usize {
    let Some(root) = settings.recordings_path() else { return 0 };
    let Ok(entries) = fs::read_dir(&root) else { return 0 };
    let mut names: Vec<String> = entries.flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().to_string()).collect();
    // Folder names are start times, so this is newest first.
    names.sort_by(|a, b| b.cmp(a));
    let mut games: Vec<(i64, i64, Option<String>)> = Vec::new();
    for name in names.iter().take(30) {
        let Some(doc) = read_json(&root.join(name).join("match.json")) else { continue };
        let start = doc.get("startedEpochMs").and_then(|v| v.as_i64()).unwrap_or(0);
        let end = start + (doc.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0) * 1000.0) as i64;
        // A remake is no loss.
        let long = doc.pointer("/game/length").and_then(|v| v.as_f64()).unwrap_or(f64::MAX) >= 300.0;
        let result = doc.pointer("/game/result").and_then(|v| v.as_str()).filter(|_| long).map(String::from);
        if games.last().is_some_and(|g| g.0 - end > SITTING_GAP_MS) {
            break;
        }
        let won = result.as_deref() == Some("Win");
        games.push((start, end, result));
        if won {
            break;
        }
    }
    let view: Vec<(i64, i64, Option<&str>)> = games.iter().map(|(s, e, r)| (*s, *e, r.as_deref())).collect();
    losing_streak_of(&view)
}

/// One note per opponent champion, written in Trends' matchup list.
fn matchups_file() -> PathBuf {
    crate::settings::app_dir().join("matchups.json")
}

/// Saving one note reads and writes the whole file; one at a time.
static MATCHUPS: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The player's notes on playing against each champion, by champion key.
pub fn matchup_notes() -> Value {
    read_json(&matchups_file()).filter(|v| v.is_object()).unwrap_or_else(|| json!({}))
}

/// Write the note on one opponent champion; an empty note removes it.
pub fn set_matchup_note(champion: &str, text: &str) -> Result<Value> {
    let champion = champion.trim();
    if champion.is_empty() || champion.len() > 64 {
        return Err(anyhow!("No champion was named"));
    }
    let _one = MATCHUPS.lock().unwrap_or_else(|e| e.into_inner());
    let mut all = matchup_notes();
    let map = all.as_object_mut().expect("matchup_notes returns an object");
    let text = text.trim();
    if text.chars().count() > 4000 {
        return Err(anyhow!("A note can be up to 4,000 characters"));
    }
    if text.is_empty() {
        map.remove(champion);
    } else {
        map.insert(champion.to_string(), json!({ "text": text, "at": chrono::Utc::now().timestamp_millis() }));
    }
    let tmp = matchups_file().with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(&all)?)?;
    fs::rename(&tmp, matchups_file())?;
    Ok(all)
}

/// Save a picture of a game, drawn by the app as a PNG, into the game's folder.
pub fn save_share_card(settings: &Settings, id: &str, png_base64: &str) -> Result<PathBuf> {
    use base64::Engine;
    let dir = match_dir(settings, id)?;
    let data = png_base64.trim();
    let data = data.split_once(',').map(|(head, rest)| if head.starts_with("data:") { rest } else { data }).unwrap_or(data);
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| anyhow!("The picture could not be read ({e})"))?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.len() > 20 * 1024 * 1024 {
        return Err(anyhow!("The picture is not a PNG image"));
    }
    let path = dir.join("share.png");
    fs::write(&path, bytes)?;
    Ok(path)
}

pub fn delete(settings: &Settings, id: &str) -> Result<()> {
    let dir = match_dir(settings, id)?;
    let from = crate::sharing::from_of(&dir);
    fs::remove_dir_all(dir)?;
    match (from, crate::sharing::inbox(settings)) {
        // A game a student sent: remember it was deleted, or it would be fetched again.
        (Some(from), Some(inbox)) => crate::sharing::mark_removed(&inbox, &crate::sharing::key(&from.code, &from.id, from.at)),
        // One of mine: nobody it was sent to can fetch it now.
        _ => crate::sharing::forget(&crate::sharing::store(), id),
    }
    Ok(())
}

/// Delete a game's video and sound and keep everything learned from it: match.json (the
/// live feed and its numbers), Riot's record of the game, ranks and LP, the review and
/// notes, the hints, the mouse and key logs and the thumbnail. The game stays in the
/// library and in Trends. Returns the bytes freed.
pub fn delete_video(settings: &Settings, id: &str) -> Result<u64> {
    let dir = match_dir(settings, id)?;
    let freed = delete_video_in(&dir, "you")?;
    log(format!("[storage] {id}: deleted the video ({} MB), kept the stats", freed / 1_000_000));
    Ok(freed)
}

/// `by` is who deleted it, kept in match.json: "you", or "limit" for the size limit.
fn delete_video_in(dir: &Path, by: &str) -> Result<u64> {
    let mut doc = read_json(&dir.join("match.json")).ok_or_else(|| anyhow!("match.json is unreadable"))?;
    let media: Vec<(PathBuf, u64)> = fs::read_dir(dir)?
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok().filter(|m| m.is_file())?;
            is_media(&e.path()).then(|| (e.path(), meta.len()))
        })
        .collect();
    // The video the player shows goes first. If another program has it open, stop
    // there, so a game is never left half deleted.
    let main = source_video(dir);
    let mut freed = 0;
    if let Some((path, size)) = media.iter().find(|(p, _)| *p == main) {
        fs::remove_file(path).map_err(|e| anyhow!("The video is open in another program, so it was not deleted ({e})"))?;
        freed += size;
    }
    let mut stuck = 0;
    for (path, size) in media.iter().filter(|(p, _)| *p != main) {
        match fs::remove_file(path) {
            Ok(()) => freed += size,
            Err(_) => stuck += 1,
        }
    }
    if let Some(o) = doc.as_object_mut().filter(|o| freed > 0 && !o.contains_key("videoDeletedAt")) {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        o.insert("videoDeletedAt".into(), json!(now));
        o.insert("videoDeletedBy".into(), json!(by));
        fs::write(dir.join("match.json"), serde_json::to_string_pretty(&doc)?)?;
    }
    if stuck > 0 {
        log(format!("[storage] {}: {stuck} sound or video files were open elsewhere and stay for now", dir.display()));
    }
    Ok(freed)
}

/// Make the recordings folder fit the size cap, oldest games first, by deleting their
/// videos and keeping their stats (see `delete_video`). A screen recording has no stats
/// to keep, so it is deleted whole. Recordings marked "keep" and the one named in
/// `protect` are never touched. Returns the recordings changed.
pub fn enforce_quota(settings: &Settings, protect: Option<&str>) -> Vec<String> {
    if settings.quota_gb == 0 {
        return Vec::new();
    }
    fit_under(settings, settings.quota_gb * 1024 * 1024 * 1024, protect)
}

/// `enforce_quota` with the cap in bytes.
fn fit_under(settings: &Settings, cap: u64, protect: Option<&str>) -> Vec<String> {
    let mut changed = Vec::new();
    // Games students sent take room too, and are thinned out the same way.
    let mut all = list_all(settings);
    let mut total: u64 = all.iter().map(|m| m["sizeBytes"].as_u64().unwrap_or(0)).sum();
    all.reverse(); // oldest first
    for m in all {
        if total <= cap {
            break;
        }
        let id = m["id"].as_str().unwrap_or("");
        if !valid_id(id) || m["keep"] == json!(true) || Some(id) == protect {
            continue;
        }
        // A screen recording: no game, so no stats to keep.
        if m["mode"] == json!("manual") && m["game"]["me"].is_null() {
            if delete(settings, id).is_ok() {
                total = total.saturating_sub(m["sizeBytes"].as_u64().unwrap_or(0));
                log(format!("[storage] removed the screen recording {id} to stay under the size limit"));
                changed.push(id.to_string());
            }
        } else {
            let Ok(dir) = match_dir(settings, id) else { continue };
            match delete_video_in(&dir, "limit") {
                // Only the stats were left: nothing to free here.
                Ok(0) => {}
                Ok(freed) => {
                    total = total.saturating_sub(freed);
                    log(format!("[storage] deleted the video of {id} ({} MB) to stay under the size limit; its stats stay", freed / 1_000_000));
                    changed.push(id.to_string());
                }
                Err(e) => log(format!("[storage] {id}: {e}")),
            }
        }
    }
    changed
}

/// Compute a video bitrate (in kbps) so a clip of `len_secs` with `audio_kbps` audio
/// stays safely under `max_mb` MB (with ~7% margin for MP4 container overhead).
pub fn target_video_kbps(len_secs: f64, max_mb: f64, audio_kbps: u32) -> u32 {
    let total_bits = max_mb.max(0.5) * 1_000_000.0 * 8.0 * 0.93;
    let total_kbps = total_bits / len_secs.max(1.0) / 1000.0;
    (total_kbps - audio_kbps as f64).max(180.0).round() as u32
}

/// Video and audio bitrates (kbps) for a clip that must fit in `max_mb`, or an error
/// saying how long the clip may be when even the lowest usable bitrate would not fit.
fn capped_rates(len_secs: f64, max_mb: f64, has_audio: bool) -> Result<(u32, u32)> {
    const MIN_VIDEO_KBPS: f64 = 180.0;
    let budget_kbps = max_mb.max(0.5) * 8000.0 * 0.93 / len_secs.max(1.0);
    let audio = if !has_audio { 0 } else if budget_kbps < 1028.0 { 96 } else { 128 };
    if budget_kbps - (audio as f64) < MIN_VIDEO_KBPS {
        let longest = (max_mb.max(0.5) * 8000.0 * 0.93 / (MIN_VIDEO_KBPS + audio as f64)).floor();
        return Err(anyhow!("A clip under {max_mb:.0} MB can be at most {longest:.0} seconds long. Mark a shorter stretch."));
    }
    Ok((target_video_kbps(len_secs, max_mb, audio), audio))
}

/// Cut `start..end` (video seconds) into a standalone MP4 with the chosen sound
/// tracks mixed together. Without `max_mb`, video is stream-copied (fast). With
/// `max_mb` (e.g. 10 MB or 50 MB for Discord), video is bitrate-capped to fit.
pub fn export_clip(
    settings: &Settings,
    id: &str,
    start: f64,
    end: f64,
    tracks: &[String],
    max_mb: Option<f64>,
) -> Result<String> {
    let dir = match_dir(settings, id)?;
    let (ffmpeg, _) = settings.ffmpeg_tools();
    let len = (end - start).max(0.5);
    let clips = dir.parent().unwrap_or(&dir).join("Clips");
    fs::create_dir_all(&clips)?;
    let s = start.max(0.0) as u64;
    let suffix = max_mb.map(|mb| format!("_{}mb", mb.round() as u32)).unwrap_or_default();
    let out = clips.join(format!("{id}_{:02}m{:02}s_{:.0}s{suffix}.mp4", s / 60, s % 60, len));
    let p = |x: &Path| x.to_string_lossy().to_string();
    let seek = |args: &mut Vec<String>, file: &Path| {
        args.extend(["-ss".into(), format!("{:.3}", start.max(0.0)), "-t".into(), format!("{len:.3}"), "-i".into(), p(file)]);
    };

    let mut inputs: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error"].map(String::from).to_vec();
    seek(&mut inputs, &video_to_cut(&dir)?);
    let mut labels: Vec<String> = Vec::new();
    if tracks.iter().any(|t| t == "game") {
        labels.push("[0:a]".into());
    }
    let mut next_input = 1;
    for name in ["discord", "mic"] {
        let Some(file) = side_track(&dir, name) else { continue };
        if tracks.iter().any(|t| t == name) {
            seek(&mut inputs, &file);
            labels.push(format!("[{next_input}:a]"));
            next_input += 1;
        }
    }

    let Some(mb) = max_mb.filter(|m| *m > 0.0) else {
        let mut args = inputs;
        args.extend(["-map".into(), "0:v".into(), "-c:v".into(), "copy".into()]);
        match labels.len() {
            0 => args.push("-an".into()),
            1 => args.extend(["-map".into(), labels[0].trim_matches(|c| c == '[' || c == ']').to_string()]),
            n => args.extend([
                "-filter_complex".into(),
                format!("{}amix=inputs={n}:normalize=0[a]", labels.join("")),
                "-map".into(),
                "[a]".into(),
            ]),
        }
        if !labels.is_empty() {
            args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
        }
        args.extend(["-movflags".into(), "+faststart".into(), p(&out)]);
        run_tool(&ffmpeg, &args)?;
        return Ok(p(&out));
    };

    // Target-size Discord encode: bitrate-capped H.264.
    let (v_kbps, audio_kbps) = capped_rates(len, mb, !labels.is_empty())?;
    let max_h = if v_kbps < 1800 { 720 } else { 1080 };

    let mut graph = format!("[0:v]scale=-2:'min({max_h},ih)',format=yuv420p[v]");
    if labels.len() > 1 {
        graph += &format!(";{}amix=inputs={}:normalize=0[a]", labels.join(""), labels.len());
    }

    let mut last = anyhow!("no encoder");
    for enc in crate::video::h264_ladder(crate::video::Rate::Kbps(v_kbps)) {
        let mut args = inputs.clone();
        args.extend(["-filter_complex".into(), graph.clone(), "-map".into(), "[v]".into()]);
        match labels.len() {
            0 => args.push("-an".into()),
            1 => args.extend(["-map".into(), labels[0].trim_matches(|c| c == '[' || c == ']').to_string()]),
            _ => args.extend(["-map".into(), "[a]".into()]),
        }
        if !labels.is_empty() {
            args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), format!("{audio_kbps}k")]);
        }
        args.extend(enc);
        args.extend(["-movflags".into(), "+faststart".into(), p(&out)]);
        match run_tool(&ffmpeg, &args) {
            Ok(_) => return Ok(p(&out)),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// One MP4 holding the video and every sound track as separate, named tracks, for
/// use in an editor.
pub fn export_full(settings: &Settings, id: &str) -> Result<String> {
    let dir = match_dir(settings, id)?;
    let (ffmpeg, _) = settings.ffmpeg_tools();
    let p = |x: &Path| x.to_string_lossy().to_string();
    let out = dir.join(format!("{id}_all-tracks.mp4"));
    let mut args: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error", "-i"].map(String::from).to_vec();
    args.push(p(&video_to_cut(&dir)?));
    let mut titles = vec!["Game"];
    for (name, title) in [("discord", "Discord"), ("mic", "Microphone (raw)")] {
        if let Some(file) = side_track(&dir, name) {
            args.extend(["-i".into(), p(&file)]);
            titles.push(title);
        }
    }
    args.extend(["-map".into(), "0".into()]);
    for i in 1..titles.len() {
        args.extend(["-map".into(), format!("{i}:a")]);
    }
    args.extend(["-c".into(), "copy".into()]);
    for (i, t) in titles.iter().enumerate() {
        // MP4 keeps a track's name in its handler name; editors show that.
        args.extend([format!("-metadata:s:a:{i}"), format!("title={t}")]);
        args.extend([format!("-metadata:s:a:{i}"), format!("handler_name={t}")]);
    }
    args.push(p(&out));
    run_tool(&ffmpeg, &args)?;
    Ok(p(&out))
}

/// One of the other views in a split-view clip.
#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SplitView {
    /// A file in the recordings folder, or the local address a teammate's view plays from.
    pub source: String,
    /// Seconds to add to a time in my video to get the same moment in this one.
    pub shift: f64,
    pub label: String,
}

/// Where each view goes in a split-view clip: tile size, the picture's size, and the
/// position list FFmpeg's `xstack` wants.
pub fn split_layout(n: usize) -> (u32, u32, u32, u32, String) {
    match n {
        0..=2 => (960, 540, 1920, 540, "0_0|960_0".into()),
        3 => (960, 540, 1920, 1080, "0_0|960_0|0_540".into()),
        4 => (960, 540, 1920, 1080, "0_0|960_0|0_540|960_540".into()),
        _ => (640, 360, 1920, 720, "0_0|640_0|1280_0|0_360|640_360".into()),
    }
}

/// Cut `start..end` (my video's seconds) into one MP4 showing my view and up to four
/// teammates' views side by side, each on the same game moment and labelled.
/// `listen` picks whose game sound is used: None for mine, or an index into `views`.
#[allow(clippy::too_many_arguments)]
pub fn export_split(
    settings: &Settings,
    id: &str,
    start: f64,
    end: f64,
    views: &[SplitView],
    tracks: &[String],
    listen: Option<usize>,
    my_label: &str,
    max_mb: Option<f64>,
) -> Result<String> {
    let dir = match_dir(settings, id)?;
    if views.is_empty() || views.len() > 4 {
        return Err(anyhow!("A split-view clip needs one to four other views"));
    }
    // Only this recording's own files and the local address teammates' views play from.
    for v in views {
        let local = Path::new(&v.source).parent().map(|p| p == dir).unwrap_or(false);
        if !local && !v.source.starts_with("http://127.0.0.1:") {
            return Err(anyhow!("That view cannot be used in a clip"));
        }
    }
    let mine = video_to_cut(&dir)?;
    let (ffmpeg, _) = settings.ffmpeg_tools();
    let len = (end - start).clamp(0.5, 600.0);
    let start = start.max(0.0);
    let clips = dir.parent().unwrap_or(&dir).join("Clips");
    fs::create_dir_all(&clips)?;
    let s0 = start as u64;
    let suffix = max_mb.map(|mb| format!("_{}mb", mb.round() as u32)).unwrap_or_default();
    let out = clips.join(format!("{id}_{:02}m{:02}s_{:.0}s_split{suffix}.mp4", s0 / 60, s0 % 60, len));
    let p = |x: &Path| x.to_string_lossy().to_string();

    let mut inputs: Vec<String> = Vec::new();
    let mut add = |at: f64, source: String| {
        inputs.extend(["-ss".into(), format!("{:.3}", at.max(0.0)), "-t".into(), format!("{len:.3}"), "-i".into(), source]);
    };
    add(start, p(&mine));
    for v in views {
        add(start + v.shift, v.source.clone());
    }
    let n = 1 + views.len();
    let mut sound: Vec<String> = Vec::new();
    if tracks.iter().any(|t| t == "game") {
        sound.push(format!("[{}:a]", listen.filter(|i| *i < views.len()).map(|i| i + 1).unwrap_or(0)));
    }
    let mut next = n;
    for name in ["discord", "mic"] {
        let Some(file) = side_track(&dir, name) else { continue };
        if tracks.iter().any(|t| t == name) {
            add(start, p(&file));
            sound.push(format!("[{next}:a]"));
            next += 1;
        }
    }

    let (tw, th, _, _, layout) = split_layout(n);
    let clean = |label: &str| -> String {
        label.chars().filter(|c| c.is_alphanumeric() || " _-.".contains(*c)).take(24).collect()
    };
    let labels: Vec<String> = std::iter::once(clean(my_label)).chain(views.iter().map(|v| clean(&v.label))).collect();
    let font = "C\\:/Windows/Fonts/segoeuib.ttf";
    let has_font = Path::new("C:/Windows/Fonts/segoeuib.ttf").exists();
    let mut graph = String::new();
    for (i, label) in labels.iter().enumerate() {
        graph += &format!(
            "[{i}:v]fps=60,scale={tw}:{th}:force_original_aspect_ratio=decrease,pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2:black,setsar=1"
        );
        if has_font && !label.is_empty() {
            graph += &format!(
                ",drawtext=fontfile='{font}':text='{label}':x=14:y=h-th-14:fontsize={}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8",
                if th >= 540 { 24 } else { 18 }
            );
        }
        graph += &format!("[v{i}];");
    }
    graph += &(0..n).map(|i| format!("[v{i}]")).collect::<String>();
    graph += &format!("xstack=inputs={n}:layout={layout}:fill=black[v]");
    if sound.len() > 1 {
        graph += &format!(";{}amix=inputs={}:normalize=0[a]", sound.join(""), sound.len());
    }

    let mut last = anyhow!("no encoder");
    let capped = match max_mb.filter(|m| *m > 0.0) {
        Some(mb) => Some(capped_rates(len, mb, !sound.is_empty())?),
        None => None,
    };

    let encoders = crate::video::h264_ladder(match capped {
        Some((vk, _)) => crate::video::Rate::Kbps(vk),
        None => crate::video::Rate::Quality(23),
    });
    let audio_kbps = capped.map(|(_, a)| a).unwrap_or(192);

    // The graphics card's encoder if there is one, the processor otherwise.
    for enc in encoders {
        let mut args: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error"].map(String::from).to_vec();
        args.extend(inputs.iter().cloned());
        args.extend(["-filter_complex".into(), graph.clone(), "-map".into(), "[v]".into()]);
        match sound.len() {
            0 => args.push("-an".into()),
            1 => args.extend(["-map".into(), sound[0].trim_matches(|c| c == '[' || c == ']').to_string()]),
            _ => args.extend(["-map".into(), "[a]".into()]),
        }
        if !sound.is_empty() {
            args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), format!("{audio_kbps}k")]);
        }
        args.extend(enc);
        args.extend(["-movflags".into(), "+faststart".into(), p(&out)]);
        match run_tool(&ffmpeg, &args) {
            Ok(_) => return Ok(p(&out)),
            Err(e) => last = e,
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::{capped_rates, delete_video, enforce_quota, fit_under, has_video, list, losing_streak_of, split_layout, target_video_kbps};
    use crate::settings::Settings;
    use serde_json::{json, Value};
    use std::path::{Path, PathBuf};

    /// A recordings folder of its own for one test.
    fn folder(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("rewatch_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// A game folder: match.json, Riot's record, a review, and a video of `video_bytes`
    /// with Discord, microphone and a highlight clip.
    fn game(root: &Path, id: &str, mode: &str, video_bytes: usize, keep: bool) -> PathBuf {
        let dir = root.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        let doc = json!({ "id": id, "mode": mode, "video": "game.mp4", "startedEpochMs": 1, "duration": 1800.0, "game": { "me": { "champion": "Ahri", "kills": 7 } } });
        std::fs::write(dir.join("match.json"), doc.to_string()).unwrap();
        std::fs::write(dir.join("review.json"), json!({ "keep": keep, "notes": [{ "id": "a", "t": 61.0, "text": "ward first" }], "drawings": [] }).to_string()).unwrap();
        std::fs::write(dir.join("riot_match.json"), b"{}").unwrap();
        std::fs::write(dir.join("postgame.json"), b"{}").unwrap();
        std::fs::write(dir.join("mouse.csv"), b"t,x,y").unwrap();
        std::fs::write(dir.join("thumb.jpg"), b"jpg").unwrap();
        std::fs::write(dir.join("game.mp4"), vec![0u8; video_bytes]).unwrap();
        std::fs::write(dir.join("discord.m4a"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.join("mic.m4a"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.join("highlight_05m00s_your-double-kill.mp4"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.join("pov_ab12cd34ef56.mp4.part"), vec![0u8; 50]).unwrap();
        dir
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut all: Vec<String> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        all.sort();
        all
    }

    #[test]
    fn deleting_the_video_keeps_the_stats() {
        let root = folder("delete_video");
        let dir = game(&root, "2026-11-01_20-00-00", "game", 1000, false);
        let mut s = Settings::default();
        s.recordings_dir = root.to_string_lossy().to_string();
        assert!(has_video(&dir, None));
        assert_eq!(list(&s)[0]["videoBytes"], 1000 + 100 + 100 + 100 + 50);

        let freed = delete_video(&s, "2026-11-01_20-00-00").unwrap();
        assert_eq!(freed, 1000 + 100 + 100 + 100 + 50);
        assert_eq!(names(&dir), ["match.json", "mouse.csv", "postgame.json", "review.json", "riot_match.json", "thumb.jpg"]);
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("match.json")).unwrap()).unwrap();
        assert!(doc["videoDeletedAt"].as_i64().unwrap() > 0);
        assert_eq!(doc["videoDeletedBy"], "you");
        assert_eq!(doc["game"]["me"]["kills"], 7);

        // Still in the library, with its notes, and saying it has no video.
        let all = list(&s);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0]["hasVideo"], false);
        assert_eq!(all[0]["videoBytes"], 0);
        assert_eq!(all[0]["noteCount"], 1);
        // Again: nothing left to free, and the first time is remembered.
        assert_eq!(delete_video(&s, "2026-11-01_20-00-00").unwrap(), 0);
        let again: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("match.json")).unwrap()).unwrap();
        assert_eq!(again["videoDeletedAt"], doc["videoDeletedAt"]);
        // An id that tries to leave the recordings folder is refused.
        assert!(delete_video(&s, "..").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_size_limit_deletes_old_videos_and_keeps_their_games() {
        let root = folder("quota_videos");
        let mut s = Settings::default();
        s.recordings_dir = root.to_string_lossy().to_string();
        // Oldest first: a kept game, a screen recording, two games, and the newest game,
        // just recorded.
        let kept = game(&root, "2026-11-01_10-00-00", "game", 1000, true);
        let screen = game(&root, "2026-11-02_10-00-00", "manual", 1000, false);
        std::fs::write(screen.join("match.json"), json!({ "id": "2026-11-02_10-00-00", "mode": "manual", "video": "game.mp4" }).to_string()).unwrap();
        let old = game(&root, "2026-11-03_10-00-00", "game", 1000, false);
        let mid = game(&root, "2026-11-04_10-00-00", "game", 1000, false);
        let new = game(&root, "2026-11-05_10-00-00", "game", 1000, false);
        let total = || list(&s).iter().map(|m| m["sizeBytes"].as_u64().unwrap()).sum::<u64>();
        let newest = Some("2026-11-05_10-00-00");

        // Without a limit set, nothing happens.
        assert!(enforce_quota(&s, newest).is_empty());
        // 1,000 bytes over: the kept game is passed over and the screen recording goes
        // whole, which is enough.
        assert_eq!(fit_under(&s, total() - 1000, newest), ["2026-11-02_10-00-00"]);
        assert!(!screen.exists());
        assert!(kept.join("game.mp4").exists() && old.join("game.mp4").exists());

        // As small as can be: every video that may go goes, the games stay.
        assert_eq!(fit_under(&s, 0, newest), ["2026-11-03_10-00-00", "2026-11-04_10-00-00"]);
        for d in [&old, &mid] {
            assert!(!d.join("game.mp4").exists() && !d.join("discord.m4a").exists());
            let doc: Value = serde_json::from_str(&std::fs::read_to_string(d.join("match.json")).unwrap()).unwrap();
            assert_eq!(doc["videoDeletedBy"], "limit");
            assert!(d.join("match.json").exists() && d.join("review.json").exists() && d.join("riot_match.json").exists());
        }
        assert!(new.join("game.mp4").exists() && kept.join("game.mp4").exists());
        // Nothing more to free, so nothing changes the second time.
        assert!(fit_under(&s, 0, newest).is_empty());
        let left = list(&s);
        assert_eq!(left.len(), 4);
        assert_eq!(left.iter().filter(|m| m["hasVideo"] == false).count(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_losing_streak_ends_with_a_win_or_a_break() {
        const MIN: i64 = 60_000;
        // (start, end, result), newest first, games 35 minutes long with 5 between.
        let at = |n: i64, r: Option<&'static str>| (1_000 * MIN - n * 40 * MIN, 1_000 * MIN - n * 40 * MIN + 35 * MIN, r);
        let three = [at(0, Some("Lose")), at(1, Some("Lose")), at(2, None), at(3, Some("Lose")), at(4, Some("Win")), at(5, Some("Lose"))];
        assert_eq!(losing_streak_of(&three), 3);
        assert_eq!(losing_streak_of(&[at(0, Some("Win")), at(1, Some("Lose"))]), 0);
        // Two hours between games: yesterday's losses are not part of this sitting.
        let mut apart = vec![at(0, Some("Lose"))];
        apart.push((at(0, None).0 - 3 * 60 * MIN, at(0, None).0 - 2 * 60 * MIN, Some("Lose")));
        assert_eq!(losing_streak_of(&apart), 1);
        assert_eq!(losing_streak_of(&[]), 0);
    }

    #[test]
    fn every_view_gets_a_place() {
        for n in 2..=5 {
            let (tw, th, w, h, layout) = split_layout(n);
            let spots: Vec<(u32, u32)> = layout
                .split('|')
                .map(|s| {
                    let (x, y) = s.split_once('_').unwrap();
                    (x.parse().unwrap(), y.parse().unwrap())
                })
                .collect();
            assert_eq!(spots.len(), n);
            // No two views overlap and none sticks out of the picture.
            for (i, a) in spots.iter().enumerate() {
                assert!(a.0 + tw <= w && a.1 + th <= h, "view {i} of {n}");
                assert!(spots.iter().skip(i + 1).all(|b| b != a));
            }
        }
    }

    #[test]
    fn discord_target_bitrate_fits_budget() {
        let kbps = target_video_kbps(30.0, 10.0, 128);
        // 30s at (kbps + 128) kbps should stay below 10 MB.
        let bytes = ((kbps + 128) as f64 * 1000.0 / 8.0) * 30.0;
        assert!(bytes < 9_600_000.0 && kbps > 1500, "kbps={kbps}, bytes={bytes}");
        assert_eq!(target_video_kbps(600.0, 10.0, 128), 180);
    }

    #[test]
    fn a_clip_too_long_for_the_size_is_refused() {
        let (v, a) = capped_rates(30.0, 10.0, true).unwrap();
        assert_eq!(a, 128);
        assert!(((v + a) as f64 * 1000.0 / 8.0) * 30.0 < 10_000_000.0);
        // 10 minutes cannot fit in 10 MB at a watchable bitrate.
        let err = capped_rates(600.0, 10.0, true).unwrap_err().to_string();
        assert!(err.contains("at most"), "{err}");
        assert!(capped_rates(600.0, 50.0, true).is_ok());
    }
}
