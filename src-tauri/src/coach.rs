//! A written review of a game, and a title for every player, from Google's Gemini
//! (optional; the same switch and key as the hints about deaths).
//!
//! One request per game: the scoreboard and timeline as text, plus a short clip of
//! each of the player's deaths (up to six, the most avoidable first when hints are
//! there). The answer is a small JSON document: a headline, what went well, what to
//! work on, one thing for next game, a sentence or two about each death, and a funny
//! title per player. Kept in `coach.json` next to the recording.

use crate::insight;
use crate::settings::{log, Settings};
use crate::titles;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

pub const FILE: &str = "coach.json";
const URL: &str = "https://generativelanguage.googleapis.com/v1beta/interactions";
/// Tried in order; the second is the fallback if the first is not available to the key.
pub const MODELS: [&str; 2] = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];
const MAX_CLIPS: usize = 6;
const VERSION: i64 = 1;

const SYSTEM: &str = "You are a sharp, friendly League of Legends coach reviewing one game for one player, using the game facts and the clips of their deaths. \
Write for the player in the second person. Be concrete: name champions, game times and what you saw in the clips. No generic advice that would fit any game, no filler, and no praise the facts do not support. Plain words: no superlatives such as phenomenal, elite or world-class. \
Judge the player by their role: a support is not expected to farm or get kills. Keep every entry to one or two short sentences. \
For each clip say what happened as you saw it and the one decision that would have changed it; if the death was fine, say so. If you cannot tell what happened in a clip, say that instead of guessing. \
Also give every player in the scoreboard a title for this game: two to four words, funny, in the spirit of an end-of-game award, grounded in that player's numbers in this game. \
Titles tease the play, never the person: nothing about real-life traits, nothing crude or hateful. Every title must be different, and its reason must cite the number or event behind it.";

fn clock(secs: f64) -> String {
    let s = secs.max(0.0) as i64;
    format!("{}:{:02}", s / 60, s % 60)
}

/// The game as text: scoreboard with the numbers behind the titles, and a timeline.
pub fn facts(doc: &Value) -> Value {
    let text = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let ps = titles::numbers(doc);
    let my_team = ps.iter().find(|p| p.is_me).map(|p| p.team.clone()).unwrap_or_default();
    let board: Vec<Value> = ps
        .iter()
        .map(|p| {
            let mut row = json!({
                "champion": p.champion,
                "team": if p.team == my_team { "player's team" } else { "enemy team" },
                "is_the_player": p.is_me,
                "kills": p.kills, "deaths": p.deaths, "assists": p.assists,
                "kill_participation_pct": (p.kp * 100.0).round(),
                "cs": p.cs, "cs_per_min": (p.cs_per_min * 10.0).round() / 10.0, "level": p.level,
                "items": p.items,
                "towers_taken": p.towers, "epic_monsters_taken": p.epic, "first_blood": p.first_blood,
                "best_multikill": p.best_multikill, "deaths_to_towers_or_monsters": p.executed,
            });
            if !p.position.is_empty() {
                row["lane"] = json!(p.position);
            }
            if let Some(w) = p.wards {
                row["ward_score"] = json!(w.round());
            }
            row
        })
        .collect();
    let timeline: Vec<String> = doc
        .get("events")
        .and_then(|e| e.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|e| {
                    let at = clock(e.get("gameTime").and_then(|x| x.as_f64()).unwrap_or(0.0));
                    match text(e, "kind").as_str() {
                        "ChampionKill" => {
                            let killer = Some(text(e, "killerChamp")).filter(|k| !k.is_empty()).unwrap_or_else(|| "a tower or monster".into());
                            Some(format!("{at} {killer} killed {}", text(e, "victimChamp")))
                        }
                        kind @ ("DragonKill" | "BaronKill" | "HeraldKill" | "HordeKill" | "AtakhanKill" | "TurretKilled" | "InhibKilled") => {
                            let side = match e.get("good").and_then(|g| g.as_bool()) {
                                Some(true) => "player's team",
                                Some(false) => "enemy team",
                                None => "unknown team",
                            };
                            let detail = if kind == "DragonKill" { format!(" {}", text(e, "detail")) } else { String::new() };
                            Some(format!("{at} {kind}{detail} by {side}"))
                        }
                        _ => None,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "player_champion": doc.pointer("/game/me/champion"),
        "result_for_player": doc.pointer("/game/result"),
        "game_length": clock(titles::minutes(doc) * 60.0),
        "queue": doc.pointer("/game/queueName"),
        "scoreboard": board,
        "timeline": timeline,
    })
}

fn schema(players: usize) -> Value {
    let lines = json!({ "type": "array", "items": { "type": "string" }, "minItems": 2, "maxItems": 3 });
    json!({
        "type": "object",
        "properties": {
            "headline": { "type": "string", "description": "One sentence: how the game went for the player." },
            "went_well": lines,
            "work_on": lines,
            "next_game": { "type": "string", "description": "The single thing to focus on next game." },
            "deaths": { "type": "array", "items": { "type": "object",
                "properties": { "clip": { "type": "integer" }, "what_happened": { "type": "string" }, "better": { "type": "string" } },
                "required": ["clip", "what_happened", "better"] } },
            "titles": { "type": "array", "minItems": players, "maxItems": players, "items": { "type": "object",
                "properties": { "champion": { "type": "string" }, "title": { "type": "string" }, "why": { "type": "string" } },
                "required": ["champion", "title", "why"] } }
        },
        "required": ["headline", "went_well", "work_on", "next_game", "deaths", "titles"]
    })
}

/// Tidy what came back into what the app keeps: bounded lengths, deaths tied to their
/// moment in the video, titles only for champions that were in the game.
pub fn tidy(reply: &Value, clip_times: &[f64], champions: &[String], model: &str) -> Value {
    let short = |v: Option<&Value>, max: usize| v.and_then(|x| x.as_str()).unwrap_or("").trim().chars().take(max).collect::<String>();
    let list = |k: &str| -> Vec<String> {
        reply.get(k).and_then(|x| x.as_array()).map(|a| a.iter().take(4).map(|s| short(Some(s), 400)).filter(|s| !s.is_empty()).collect()).unwrap_or_default()
    };
    let deaths: Vec<Value> = reply
        .get("deaths")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|d| {
                    let clip = d.get("clip")?.as_i64()?;
                    let t = *clip_times.get((clip - 1).max(0) as usize)?;
                    Some(json!({ "t": t, "whatHappened": short(d.get("what_happened"), 400), "better": short(d.get("better"), 400) }))
                })
                .collect()
        })
        .unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let titles: Vec<Value> = reply
        .get("titles")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|t| {
                    let champion = short(t.get("champion"), 40);
                    let title = short(t.get("title"), 40);
                    (champions.contains(&champion) && !title.is_empty() && seen.insert(champion.clone()))
                        .then(|| json!({ "champion": champion, "title": title, "why": short(t.get("why"), 240) }))
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "version": VERSION,
        "model": model,
        "headline": short(reply.get("headline"), 400),
        "wentWell": list("went_well"),
        "workOn": list("work_on"),
        "nextGame": short(reply.get("next_game"), 400),
        "deaths": deaths,
        "titles": titles,
    })
}

/// Send one request and return the JSON document the model wrote.
pub fn request(key: &str, model: &str, body: &Value) -> Result<Value> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(300)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut body = body.clone();
    body["model"] = json!(model);
    let mut resp = agent.post(URL).header("x-goog-api-key", key).send_json(&body).map_err(|e| anyhow!("could not reach Google: {e}"))?;
    let status = resp.status().as_u16();
    let reply: Value = resp.body_mut().with_config().limit(8 * 1024 * 1024).read_json().unwrap_or(Value::Null);
    if status != 200 {
        let why = reply.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("no reason given");
        return Err(anyhow!("Google answered {status}: {}", why.chars().take(200).collect::<String>()));
    }
    // The written answer is the text of the "model_output" step.
    let text: String = reply
        .get("steps")
        .and_then(|s| s.as_array())
        .map(|steps| {
            steps
                .iter()
                .filter(|s| s.get("type").and_then(|t| t.as_str()) == Some("model_output"))
                .flat_map(|s| s.get("content").and_then(|c| c.as_array()).cloned().unwrap_or_default())
                .filter_map(|c| c.get("text").and_then(|t| t.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    serde_json::from_str(&text).map_err(|_| anyhow!("the review came back in a form that could not be read"))
}

pub fn load(dir: &Path) -> Option<Value> {
    serde_json::from_str::<Value>(&std::fs::read_to_string(dir.join(FILE)).ok()?)
        .ok()
        .filter(|v| v.get("version").and_then(|x| x.as_i64()) == Some(VERSION))
}

/// Write the review for the recording in `dir` and keep it there.
pub fn review(settings: &Settings, dir: &Path, stop: &dyn Fn() -> bool) -> Result<Value> {
    if let Some(done) = load(dir) {
        return Ok(done);
    }
    let key = settings.gemini_key.trim();
    if key.is_empty() {
        return Err(anyhow!("No Gemini API key is set. Add one in Settings."));
    }
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("match.json"))?)?;
    let champions: Vec<String> = titles::numbers(&doc).into_iter().map(|p| p.champion).collect();
    if champions.is_empty() {
        return Err(anyhow!("This recording has no scoreboard to review."));
    }
    // The deaths to show: the most avoidable first when hints exist, then in game order.
    let hints = insight::load(dir);
    let avoidable = |t: f64| -> f64 {
        hints
            .as_ref()
            .and_then(|h| h.get("deaths")?.as_array()?.iter().find(|d| (d["t"].as_f64().unwrap_or(-9.0) - t).abs() < 1.5)?.get("avoidable")?.as_f64())
            .unwrap_or(0.0)
    };
    let mut deaths = insight::deaths(&doc);
    deaths.sort_by(|a, b| avoidable(b["t"].as_f64().unwrap_or(0.0)).partial_cmp(&avoidable(a["t"].as_f64().unwrap_or(0.0))).unwrap_or(std::cmp::Ordering::Equal));
    deaths.truncate(MAX_CLIPS);
    deaths.sort_by(|a, b| a["t"].as_f64().partial_cmp(&b["t"].as_f64()).unwrap_or(std::cmp::Ordering::Equal));

    use base64::Engine;
    let (ffmpeg, _) = settings.ffmpeg_tools();
    let clip = insight::temp_clip("coach")?;
    let mut blocks = vec![json!({ "type": "text", "text": format!(
        "Game facts (JSON):\n{}\n\nClips of the player's deaths follow. Each shows the 14 seconds before the death and 3 after.\n",
        facts(&doc)
    ) })];
    let mut clip_times = Vec::new();
    for death in &deaths {
        if stop() {
            let _ = std::fs::remove_file(&clip);
            return Err(anyhow!("A game started; the review waits until it is over."));
        }
        let t = death["t"].as_f64().unwrap_or(0.0);
        // Ten frames a second and no sound: plenty for the model, and small to send.
        if insight::cut_clip(&ffmpeg, &dir.join("game.mp4"), t, &clip, 10, false).is_err() {
            continue;
        }
        let Ok(bytes) = std::fs::read(&clip) else { continue };
        clip_times.push(t);
        let killer = death.get("killerChamp").and_then(|k| k.as_str()).filter(|k| !k.is_empty()).unwrap_or("a tower or monster");
        blocks.push(json!({ "type": "text", "text": format!(
            "\nClip {}: the player dies at {}, killed by {killer}.\n",
            clip_times.len(),
            clock(death.get("gameTime").and_then(|x| x.as_f64()).unwrap_or(0.0))
        ) }));
        blocks.push(json!({ "type": "video", "data": base64::engine::general_purpose::STANDARD.encode(&bytes), "mime_type": "video/mp4", "resolution": "high" }));
    }
    let _ = std::fs::remove_file(&clip);
    blocks.push(json!({ "type": "text", "text": "\nWrite the review now." }));
    let body = json!({
        "system_instruction": SYSTEM,
        "input": blocks,
        "response_format": { "type": "text", "mime_type": "application/json", "schema": schema(champions.len()) },
        "store": false,
    });
    let mut last = anyhow!("no model answered");
    for model in MODELS {
        match request(key, model, &body) {
            Ok(reply) => {
                let out = tidy(&reply, &clip_times, &champions, model);
                std::fs::write(dir.join(FILE), serde_json::to_string_pretty(&out)?)?;
                log(format!(
                    "[coach] {}: review written by {model} from {} clips",
                    dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
                    clip_times.len()
                ));
                return Ok(out);
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// The newest game of the last three days that has no review yet.
pub fn next_wanted(root: &Path) -> Option<std::path::PathBuf> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let mut found: Vec<(i64, std::path::PathBuf)> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let dir = e.path();
            if load(&dir).is_some() || !dir.join("game.mp4").exists() {
                return None;
            }
            let doc: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("match.json")).ok()?).ok()?;
            let started = doc.get("startedEpochMs").and_then(|x| x.as_i64()).unwrap_or(0);
            let players = doc.pointer("/game/players").and_then(|p| p.as_array()).map(|a| a.len()).unwrap_or(0);
            // Only finished games: a result is known and the game ran a while.
            let finished = doc.pointer("/game/result").map(|r| !r.is_null()).unwrap_or(false);
            (now - started < 3 * 24 * 3600 * 1000 && players >= 2 && finished).then_some((started, dir))
        })
        .collect();
    found.sort_by_key(|(started, _)| -*started);
    found.into_iter().next().map(|(_, dir)| dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reply_is_tidied_before_it_is_kept() {
        let reply = json!({
            "headline": "  You enabled every fight.  ",
            "went_well": ["First blood at 1:10.", ""],
            "work_on": ["Leave after the charm lands."],
            "next_game": "Use E as your exit.",
            "deaths": [ { "clip": 2, "what_happened": "Stood in Riven's combo.", "better": "E out." }, { "clip": 9, "what_happened": "x", "better": "y" } ],
            "titles": [
                { "champion": "Rakan", "title": "Wingman Of The Year", "why": "36 assists" },
                { "champion": "Rakan", "title": "Second One", "why": "dup" },
                { "champion": "Teemo", "title": "Not In This Game", "why": "" },
                { "champion": "Riven", "title": "", "why": "empty" }
            ]
        });
        let out = tidy(&reply, &[430.5, 1243.8], &["Rakan".to_string(), "Riven".to_string()], "m");
        assert_eq!(out["headline"], json!("You enabled every fight."));
        assert_eq!(out["wentWell"], json!(["First blood at 1:10."]));
        // Clip 2 is the second death; a clip number that was never sent is dropped.
        assert_eq!(out["deaths"], json!([{ "t": 1243.8, "whatHappened": "Stood in Riven's combo.", "better": "E out." }]));
        assert_eq!(out["titles"], json!([{ "champion": "Rakan", "title": "Wingman Of The Year", "why": "36 assists" }]));
    }

    #[test]
    fn the_game_is_described_in_words_the_model_can_use() {
        let doc = json!({
            "duration": 600.0,
            "game": { "result": "Win", "queueName": "Ranked Flex", "me": { "champion": "Rakan" }, "players": [
                { "name": "Rin", "champion": "Rakan", "team": "CHAOS", "isMe": true, "kills": 1, "deaths": 0, "assists": 3, "cs": 20, "level": 9, "position": "UTILITY", "items": [{ "id": 1, "name": "Boots" }] },
                { "name": "E", "champion": "Riven", "team": "ORDER", "isMe": false, "kills": 0, "deaths": 1, "assists": 0, "cs": 80, "level": 10, "items": [] }
            ] },
            "events": [
                { "kind": "ChampionKill", "gameTime": 70.0, "killer": "Rin", "killerChamp": "Rakan", "victim": "E", "victimChamp": "Riven" },
                { "kind": "DragonKill", "gameTime": 400.0, "detail": "Fire", "good": true },
                { "kind": "ItemPurchased", "gameTime": 30.0 }
            ]
        });
        let f = facts(&doc);
        assert_eq!(f["timeline"], json!(["1:10 Rakan killed Riven", "6:40 DragonKill Fire by player's team"]));
        assert_eq!(f["scoreboard"][0]["team"], json!("player's team"));
        assert_eq!(f["scoreboard"][0]["lane"], json!("UTILITY"));
        assert_eq!(f["scoreboard"][1]["team"], json!("enemy team"));
        assert_eq!(f["game_length"], json!("10:00"));
    }
}
