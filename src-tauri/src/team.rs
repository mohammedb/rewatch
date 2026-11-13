//! A review of one team fight from every teammate's screen at once (optional; the
//! same switch and key as the rest of the AI review).
//!
//! The same stretch of the game is cut from my recording and from each teammate's
//! view that is available, and sent together with what the event list says about
//! the fight. The model is asked what the team should have done as a group. The
//! answer is kept in `team.json` next to the recording and passed on to teammates
//! like notes are, so the whole team reads the same review.
//!
//! Only pictures are sent: no Discord, no microphone.

use crate::coach;
use crate::insight;
use crate::settings::{log, Settings};
use crate::titles;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::path::Path;

pub const FILE: &str = "team.json";
const VERSION: i64 = 1;
const LEAD: f64 = 8.0;
const TAIL: f64 = 4.0;
const LONGEST: f64 = 40.0;
const MOST_VIEWS: usize = 4;

/// One teammate's view of the game.
#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// A file in the recording's folder, or the local address their view plays from.
    pub source: String,
    /// Seconds to add to a time in my video to get the same moment in theirs.
    pub shift: f64,
    pub champion: String,
}

const SYSTEM: &str = "You are a League of Legends coach reviewing one team fight for a group of friends who played it on the same team. \
You get the facts of the fight and clips of the same seconds from several of their screens. Use the different screens together: what one player could not see, another could. \
Say what the team should have done as a group: whether and when to take the fight, who should have started it, who to focus, where to stand, and whether the objective or the fight came first. \
Be concrete: name champions and what you saw. No blame: put everything as what to do next time. Keep every entry to one or two short sentences, in plain words. \
For each player whose part in the fight you could see, say what they did and the one thing to do differently; leave out players you could not judge. \
If the screens do not let you tell what happened, say so instead of guessing.";

fn clock(secs: f64) -> String {
    let s = secs.max(0.0) as i64;
    format!("{}:{:02}", s / 60, s % 60)
}

/// What the event list says about the fight between `start` and `end` (video time).
pub fn facts(doc: &Value, start: f64, end: f64) -> Value {
    let text = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let ps = titles::numbers(doc);
    let my_team = ps.iter().find(|p| p.is_me).map(|p| p.team.clone()).unwrap_or_default();
    let side = |same: bool| -> Vec<String> {
        ps.iter()
            .filter(|p| (p.team == my_team) == same)
            .map(|p| if p.position.is_empty() { p.champion.clone() } else { format!("{} ({})", p.champion, p.position.to_lowercase()) })
            .collect()
    };
    let mut ours = 0;
    let mut theirs = 0;
    let lines: Vec<String> = doc
        .get("events")
        .and_then(|e| e.as_array())
        .map(|a| {
            a.iter()
                .filter(|e| {
                    let t = e.get("t").and_then(|x| x.as_f64()).unwrap_or(-1.0);
                    // Objectives count from a little before to a while after the fight.
                    t >= start - 20.0 && t <= end + 40.0
                })
                .filter_map(|e| {
                    let at = clock(e.get("gameTime").and_then(|x| x.as_f64()).unwrap_or(0.0));
                    let good = e.get("good").and_then(|g| g.as_bool());
                    match text(e, "kind").as_str() {
                        "ChampionKill" => {
                            match good {
                                Some(true) => ours += 1,
                                Some(false) => theirs += 1,
                                None => {}
                            }
                            let killer = Some(text(e, "killerChamp")).filter(|k| !k.is_empty()).unwrap_or_else(|| "a tower or monster".into());
                            Some(format!("{at} {killer} killed {}", text(e, "victimChamp")))
                        }
                        kind @ ("DragonKill" | "BaronKill" | "HeraldKill" | "HordeKill" | "AtakhanKill" | "TurretKilled" | "InhibKilled") => {
                            let who = match good {
                                Some(true) => "the friends' team",
                                Some(false) => "the enemy team",
                                None => "unknown team",
                            };
                            Some(format!("{at} {kind} {} by {who}", text(e, "detail")).replace("  ", " "))
                        }
                        _ => None,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "friends_team": side(true),
        "enemy_team": side(false),
        "kills_for_the_friends": ours,
        "kills_for_the_enemy": theirs,
        "what_happened": lines,
    })
}

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "summary": { "type": "string", "description": "One or two sentences: how the fight went and why." },
            "turning_point": { "type": "string", "description": "The moment or decision that decided it." },
            "should_have": { "type": "array", "items": { "type": "string" }, "minItems": 2, "maxItems": 3, "description": "What the team should do next time in this situation." },
            "players": { "type": "array", "items": { "type": "object",
                "properties": { "champion": { "type": "string" }, "did": { "type": "string" }, "better": { "type": "string" } },
                "required": ["champion", "did", "better"] } },
            "call": { "type": "string", "description": "The one sentence someone should have said on voice before the fight." }
        },
        "required": ["summary", "turning_point", "should_have", "players", "call"]
    })
}

/// Tidy the model's answer into what is kept: bounded lengths, and only players who
/// were on the team.
pub fn tidy(reply: &Value, start: f64, end: f64, views: &[String], team: &[String], model: &str) -> Value {
    let short = |v: Option<&Value>, max: usize| v.and_then(|x| x.as_str()).unwrap_or("").trim().chars().take(max).collect::<String>();
    let players: Vec<Value> = reply
        .get("players")
        .and_then(|p| p.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    let champion = short(p.get("champion"), 40);
                    team.contains(&champion).then(|| json!({ "champion": champion, "did": short(p.get("did"), 400), "better": short(p.get("better"), 400) }))
                })
                .take(5)
                .collect()
        })
        .unwrap_or_default();
    json!({
        "t": start,
        "end": end,
        "views": views,
        "model": model,
        "summary": short(reply.get("summary"), 500),
        "turningPoint": short(reply.get("turning_point"), 400),
        "shouldHave": reply.get("should_have").and_then(|x| x.as_array()).map(|a| a.iter().take(4).map(|s| short(Some(s), 400)).filter(|s| !s.is_empty()).collect::<Vec<_>>()).unwrap_or_default(),
        "players": players,
        // The call is shown inside quotation marks; drop any the model added itself.
        "call": short(reply.get("call"), 300).trim_matches(|c| c == '"' || c == '“' || c == '”').to_string(),
    })
}

/// Every team review kept for the recording in `dir`.
pub fn load(dir: &Path) -> Vec<Value> {
    std::fs::read_to_string(dir.join(FILE))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|v| v.get("version").and_then(|x| x.as_i64()) == Some(VERSION))
        .and_then(|v| v.get("reviews").and_then(|r| r.as_array()).cloned())
        .unwrap_or_default()
}

/// Review the fight between `start` and `end` (my video's time) using my recording
/// and the teammates' views given.
pub fn review(settings: &Settings, dir: &Path, start: f64, end: f64, views: &[View], stop: &dyn Fn() -> bool) -> Result<Value> {
    let key = settings.gemini_key.trim();
    if key.is_empty() {
        return Err(anyhow!("No Gemini API key is set. Add one in Settings."));
    }
    // Only this recording's own files and the local address teammates' views play from.
    for v in views {
        let local = Path::new(&v.source).parent().map(|p| p == dir).unwrap_or(false);
        if !local && !v.source.starts_with("http://127.0.0.1:") {
            return Err(anyhow!("That view cannot be used"));
        }
    }
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("match.json"))?)?;
    let ps = titles::numbers(&doc);
    let me = ps.iter().find(|p| p.is_me).ok_or_else(|| anyhow!("This recording has no scoreboard to review."))?;
    let team: Vec<String> = ps.iter().filter(|p| p.team == me.team).map(|p| p.champion.clone()).collect();
    let from = (start - LEAD).max(0.0);
    let len = (end + TAIL - from).clamp(6.0, LONGEST);

    use base64::Engine;
    let (ffmpeg, _) = settings.ffmpeg_tools();
    let clip = insight::temp_clip("team")?;
    let mut blocks = vec![json!({ "type": "text", "text": format!(
        "Facts of the fight (JSON):\n{}\n\nEach clip below shows the same {len:.0} seconds of the game, from a different friend's screen.\n",
        facts(&doc, start, end)
    ) })];
    let mut used: Vec<String> = Vec::new();
    let mine = dir.join("game.mp4").to_string_lossy().to_string();
    let sources = std::iter::once((mine, 0.0, me.champion.clone())).chain(views.iter().take(MOST_VIEWS).map(|v| (v.source.clone(), v.shift, v.champion.clone())));
    for (source, shift, champion) in sources {
        if stop() {
            let _ = std::fs::remove_file(&clip);
            return Err(anyhow!("A game started; try again when it is over."));
        }
        // A teammate whose recording does not cover the fight is simply left out.
        if from + shift < 0.0 || insight::cut_range(&ffmpeg, &source, from + shift, len, &clip, 10, false).is_err() {
            continue;
        }
        let Ok(bytes) = std::fs::read(&clip) else { continue };
        if bytes.len() < 2000 {
            continue;
        }
        blocks.push(json!({ "type": "text", "text": format!("\nClip {}: the screen of the friend playing {champion}.\n", used.len() + 1) }));
        blocks.push(json!({ "type": "video", "data": base64::engine::general_purpose::STANDARD.encode(&bytes), "mime_type": "video/mp4", "resolution": "high" }));
        used.push(champion);
    }
    let _ = std::fs::remove_file(&clip);
    if used.is_empty() {
        return Err(anyhow!("No view of this fight could be read."));
    }
    blocks.push(json!({ "type": "text", "text": "\nWrite the team review now." }));
    let body = json!({
        "system_instruction": SYSTEM,
        "input": blocks,
        "response_format": { "type": "text", "mime_type": "application/json", "schema": schema() },
        "store": false,
    });
    let mut last = anyhow!("no model answered");
    for model in coach::MODELS {
        match coach::request(key, model, &body) {
            Ok(reply) => {
                let out = tidy(&reply, start, end, &used, &team, model);
                // Replaces an earlier review of the same fight.
                let mut all: Vec<Value> = load(dir).into_iter().filter(|r| (r["t"].as_f64().unwrap_or(-99.0) - start).abs() > 3.0).collect();
                all.push(out.clone());
                all.sort_by(|a, b| a["t"].as_f64().partial_cmp(&b["t"].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
                std::fs::write(dir.join(FILE), serde_json::to_string_pretty(&json!({ "version": VERSION, "reviews": all }))?)?;
                log(format!(
                    "[team] {}: fight at {} reviewed by {model} from {} views",
                    dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    clock(start),
                    used.len()
                ));
                return Ok(out);
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fight_is_described_from_the_event_list() {
        let doc = json!({ "game": { "players": [
            { "name": "Rin", "champion": "Rakan", "team": "CHAOS", "isMe": true, "position": "UTILITY" },
            { "name": "K", "champion": "Xayah", "team": "CHAOS", "isMe": false },
            { "name": "E", "champion": "Riven", "team": "ORDER", "isMe": false }
        ] }, "events": [
            { "kind": "ChampionKill", "t": 90.0, "gameTime": 85.0, "killerChamp": "Riven", "victimChamp": "Rakan", "good": false },
            { "kind": "ChampionKill", "t": 100.0, "gameTime": 95.0, "killerChamp": "Xayah", "victimChamp": "Riven", "good": true },
            { "kind": "BaronKill", "t": 130.0, "gameTime": 125.0, "good": true },
            { "kind": "ChampionKill", "t": 400.0, "gameTime": 395.0, "killerChamp": "Xayah", "victimChamp": "Riven", "good": true }
        ] });
        let f = facts(&doc, 90.0, 100.0);
        assert_eq!(f["friends_team"], json!(["Rakan (utility)", "Xayah"]));
        assert_eq!((f["kills_for_the_friends"].as_i64(), f["kills_for_the_enemy"].as_i64()), (Some(1), Some(1)));
        assert_eq!(f["what_happened"], json!(["1:25 Riven killed Rakan", "1:35 Xayah killed Riven", "2:05 BaronKill by the friends' team"]));
    }

    #[test]
    fn only_teammates_are_kept_in_the_answer() {
        let reply = json!({
            "summary": "Lost 1 for 3.", "turning_point": "Rakan went in alone.", "should_have": ["Wait for Xayah.", ""], "call": "\"Wait, wait, I am not there.\"",
            "players": [ { "champion": "Rakan", "did": "Engaged.", "better": "Wait." }, { "champion": "Riven", "did": "x", "better": "y" } ]
        });
        let out = tidy(&reply, 90.0, 100.0, &["Rakan".into(), "Xayah".into()], &["Rakan".into(), "Xayah".into()], "m");
        assert_eq!(out["players"], json!([{ "champion": "Rakan", "did": "Engaged.", "better": "Wait." }]));
        assert_eq!(out["shouldHave"], json!(["Wait for Xayah."]));
        assert_eq!(out["call"], json!("Wait, wait, I am not there."));
        assert_eq!((out["t"].as_f64(), out["views"].as_array().map(|v| v.len())), (Some(90.0), Some(2)));
    }
}
