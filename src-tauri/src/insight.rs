//! Hints about each death, from Google's Decisions API (optional, off by default).
//!
//! For every death in a recording a short 720p clip (the 14 seconds before, 3 after,
//! game sound only) is sent with a fixed set of closed questions: was it avoidable,
//! what was the main cause, were the enemies visible beforehand, and so on. The API
//! answers with probabilities, not text. They are kept in `insights.json` next to
//! the recording and shown in the Review tab as hints.
//!
//! Nothing is sent unless the user has entered their own API key and switched this
//! on, and never while a game is running. Discord and microphone sound are never sent.

use crate::settings::{log, Settings};
use crate::video::run_tool;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

pub const FILE: &str = "insights.json";
const MODEL: &str = "gemini-decision-1";
const URL: &str = "https://generativelanguage.googleapis.com/v1beta/decisions";
const LEAD: f64 = 14.0;
const TAIL: f64 = 3.0;
/// Bump when the questions change, so older answers are asked again.
const VERSION: i64 = 1;

pub fn enabled(s: &Settings) -> bool {
    s.ai_review && !s.gemini_key.trim().is_empty()
}

/// Only one recording is analysed at a time.
static RUNNING: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn questions(champion: &str) -> Value {
    json!({
        "avoidable": {
            "type": "noul",
            "instructions": format!("Could the recording player ({champion}) realistically have avoided dying here by making a different decision during the seconds shown?"),
            "criteria": {
                "true_description": "A clearly better option existed (stay back, leave earlier, not engage, wait for teammates) and taking it would very likely have kept the player alive.",
                "false_description": "The death was forced, or was a reasonable price for something the team gained."
            }
        },
        "saw_it_coming": { "type": "noul", "instructions": "Were the enemies who killed the player visible on the screen or the minimap at least three seconds before they started attacking the player?" },
        "ally_close": { "type": "noul", "instructions": "When the fight that killed the player started, was at least one allied champion close enough to help within two seconds?" },
        "main_cause": {
            "type": "choice",
            "instructions": "What is the main reason the recording player died?",
            "criteria": {
                "no_vision": "Walked into an area without vision and was caught by enemies who were not visible beforehand.",
                "overextended": "Stood too far forward or stayed too long with enemies nearby and no safe way out.",
                "engage_no_followup": "Engaged onto the enemy and teammates did not follow up or were too far away.",
                "outnumbered": "Took a fight in which the enemy had more champions present.",
                "tower_dive": "Died under an enemy tower, or to a tower's shots.",
                "lost_even_fight": "The fight was even in numbers and was lost through ability use, positioning or damage.",
                "worth_it": "The death was a deliberate, reasonable trade for kills or an objective."
            }
        },
        "fight_type": {
            "type": "choice",
            "instructions": "What kind of fight is this?",
            "criteria": {
                "caught_alone": "One player is caught by one or more enemies with no real fight.",
                "skirmish": "A small fight with two or three champions on each side.",
                "teamfight": "A full fight with four or five champions on each side."
            }
        },
        "positioning": {
            "type": "score",
            "instructions": "Rate the recording player's positioning in the five seconds before the fight started.",
            "criteria": [
                "Poor: far forward or isolated, in reach of several enemies.",
                "Risky: exposed, but with a plausible way out or with help nearby.",
                "Sound: behind or beside teammates, out of easy reach."
            ]
        }
    })
}

/// What is told about a death alongside its clip: who the player is, who is in the
/// game, and when and by whom the player dies.
pub fn context(doc: &Value, death: &Value) -> String {
    let text = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let me = doc.pointer("/game/me").cloned().unwrap_or(Value::Null);
    let players = doc.pointer("/game/players").and_then(|p| p.as_array()).cloned().unwrap_or_default();
    let side = |same: bool| -> String {
        players
            .iter()
            .filter(|p| (text(p, "team") == text(&me, "team")) == same && p.get("isMe") != Some(&json!(true)))
            .map(|p| text(p, "champion"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let killer = text(death, "killerChamp");
    let game = death.get("gameTime").and_then(|x| x.as_f64()).unwrap_or(0.0) as i64;
    let lane = match text(&me, "position").as_str() {
        "TOP" => " (top lane)",
        "JUNGLE" => " (jungle)",
        "MIDDLE" => " (mid lane)",
        "BOTTOM" => " (bot lane carry)",
        "UTILITY" => " (support)",
        _ => "",
    };
    let mut out = format!(
        "A {:.0}-second clip from a League of Legends game, recorded from the screen of the player on {}{lane}. Allies: {}. Enemies: {}.\n",
        LEAD + TAIL,
        text(&me, "champion"),
        side(true),
        side(false)
    );
    out += &format!("The player dies about {LEAD:.0} seconds into the clip, at {}:{:02} on the game clock, ", game / 60, game % 60);
    // Who else took part is left out on purpose: told how many enemies were involved,
    // the model called every death "outnumbered and avoidable" (tried 2026-11-13).
    out += &if killer.is_empty() { "executed by a tower or monster.".to_string() } else { format!("killed by {killer}.") };
    out + "\n"
}

/// The deaths of the recording player, in video time.
pub fn deaths(doc: &Value) -> Vec<Value> {
    doc.get("events")
        .and_then(|e| e.as_array())
        .map(|a| a.iter().filter(|e| e["kind"] == "ChampionKill" && e["role"] == "death").cloned().collect())
        .unwrap_or_default()
}

/// Cut the stretch around a death (14 seconds before, 3 after) at 720p.
pub fn cut_clip(ffmpeg: &Path, src: &Path, at: f64, out: &Path, fps: u32, sound: bool) -> Result<()> {
    cut_range(ffmpeg, &src.to_string_lossy(), (at - LEAD).max(0.0), LEAD + TAIL, out, fps, sound)
}

/// Cut any stretch of a video (a file, or the local address a teammate's view plays
/// from) at 720p for sending to the model.
pub fn cut_range(ffmpeg: &Path, src: &str, start: f64, len: f64, out: &Path, fps: u32, sound: bool) -> Result<()> {
    let base: Vec<String> = vec![
        "-y".into(), "-hide_banner".into(), "-loglevel".into(), "error".into(),
        "-ss".into(), format!("{:.2}", start.max(0.0)), "-t".into(), format!("{len:.1}"),
        "-i".into(), src.to_string(), "-vf".into(), format!("scale=-2:720,fps={fps}"),
    ];
    let tail: Vec<String> = if sound { vec!["-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"] } else { vec!["-an", "-movflags", "+faststart"] }
        .into_iter()
        .map(String::from)
        .collect();
    let mut last = anyhow!("no encoder");
    for enc in [
        &["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "30", "-b:v", "0"][..],
        &["-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p"][..],
    ] {
        let mut args = base.clone();
        args.extend(enc.iter().map(|x| x.to_string()));
        args.extend(tail.clone());
        args.push(out.to_string_lossy().to_string());
        match run_tool(ffmpeg, &args) {
            Ok(_) => return Ok(()),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// Turn the API's answers for one death into the flat record the Review tab shows.
pub fn summarize(t: f64, answers: &Value) -> Value {
    let noul = |k: &str| answers.pointer(&format!("/{k}/noul")).and_then(|x| x.as_f64());
    let choice = |k: &str| -> (Value, Value) {
        let pick = answers.pointer(&format!("/{k}/choice")).cloned().unwrap_or(Value::Null);
        let p = pick.as_str().and_then(|c| answers.pointer(&format!("/{k}/probabilities/{c}"))).cloned().unwrap_or(Value::Null);
        (pick, p)
    };
    let (cause, cause_p) = choice("main_cause");
    let (fight, fight_p) = choice("fight_type");
    json!({
        "t": t,
        "avoidable": noul("avoidable"),
        "sawItComing": noul("saw_it_coming"),
        "allyClose": noul("ally_close"),
        "cause": cause,
        "causeP": cause_p,
        "fight": fight,
        "fightP": fight_p,
        // 0 poor, 1 risky, 2 sound.
        "positioning": answers.pointer("/positioning/score").and_then(|x| x.as_f64()),
    })
}

fn ask(key: &str, context: &str, clip: &[u8], champion: &str) -> Result<Value> {
    use base64::Engine;
    let body = json!({
        "model": MODEL,
        "input": [
            { "type": "text", "text": context },
            { "type": "video", "data": base64::engine::general_purpose::STANDARD.encode(clip), "mime_type": "video/mp4", "resolution": "high" }
        ],
        "questions": questions(champion),
    });
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(180)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut resp = agent
        .post(URL)
        .header("x-goog-api-key", key)
        .send_json(&body)
        .map_err(|e| anyhow!("could not reach Google: {e}"))?;
    let status = resp.status().as_u16();
    let reply: Value = resp.body_mut().read_json().unwrap_or(Value::Null);
    if status != 200 {
        let why = reply.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("no reason given");
        return Err(anyhow!("Google answered {status}: {}", why.chars().take(200).collect::<String>()));
    }
    reply.get("answers").cloned().ok_or_else(|| anyhow!("the answer had no content"))
}

pub fn load(dir: &Path) -> Option<Value> {
    serde_json::from_str::<Value>(&std::fs::read_to_string(dir.join(FILE)).ok()?)
        .ok()
        .filter(|v| v.get("version").and_then(|x| x.as_i64()) == Some(VERSION))
}

/// Ask about every death in the recording in `dir` and keep the answers there.
/// `stop` is asked before each death; when it says yes the rest waits for later.
pub fn analyze(settings: &Settings, dir: &Path, stop: &dyn Fn() -> bool) -> Result<Value> {
    let _one = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(done) = load(dir) {
        return Ok(done);
    }
    let key = settings.gemini_key.trim();
    if key.is_empty() {
        return Err(anyhow!("No Gemini API key is set. Add one in Settings."));
    }
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("match.json"))?)?;
    let champion = doc.pointer("/game/me/champion").and_then(|c| c.as_str()).unwrap_or("the player").to_string();
    let (ffmpeg, _) = settings.ffmpeg_tools();
    let tmp = std::env::temp_dir().join("rewatch-insight");
    std::fs::create_dir_all(&tmp)?;
    let clip = tmp.join(format!("clip-{}.mp4", std::process::id()));
    let mut out = Vec::new();
    let mut failed = 0;
    for death in deaths(&doc) {
        if stop() {
            let _ = std::fs::remove_file(&clip);
            return Err(anyhow!("A game started; the rest waits until it is over."));
        }
        let t = death.get("t").and_then(|x| x.as_f64()).unwrap_or(0.0);
        let answered = cut_clip(&ffmpeg, &dir.join("game.mp4"), t, &clip, 30, true)
            .and_then(|_| Ok(std::fs::read(&clip)?))
            .and_then(|bytes| ask(key, &context(&doc, &death), &bytes, &champion));
        match answered {
            Ok(answers) => out.push(summarize(t, &answers)),
            Err(e) => {
                // A wrong key or a used-up quota fails every clip the same way: stop
                // at the first rather than sending the rest.
                if out.is_empty() {
                    let _ = std::fs::remove_file(&clip);
                    return Err(e);
                }
                failed += 1;
                out.push(json!({ "t": t, "error": e.to_string() }));
            }
        }
    }
    let _ = std::fs::remove_file(&clip);
    let result = json!({ "version": VERSION, "model": MODEL, "deaths": out });
    std::fs::write(dir.join(FILE), serde_json::to_string_pretty(&result)?)?;
    log(format!(
        "[insight] {}: {} deaths looked at{}",
        dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        out.len(),
        if failed > 0 { format!(", {failed} could not be answered") } else { String::new() }
    ));
    Ok(result)
}

/// The newest recording of the last three days whose deaths have not been looked at.
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
            (now - started < 3 * 24 * 3600 * 1000 && !deaths(&doc).is_empty()).then_some((started, dir))
        })
        .collect();
    found.sort_by_key(|(started, _)| -*started);
    found.into_iter().next().map(|(_, dir)| dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_become_a_flat_record() {
        let answers = json!({
            "avoidable": { "type": "noul", "noul": 0.8, "confidence": 0.8 },
            "saw_it_coming": { "type": "noul", "noul": 0.34 },
            "ally_close": { "type": "noul", "noul": 0.7 },
            "main_cause": { "type": "choice", "choice": "outnumbered", "probabilities": { "outnumbered": 0.34, "overextended": 0.24 } },
            "fight_type": { "type": "choice", "choice": "skirmish", "probabilities": { "skirmish": 0.5 } },
            "positioning": { "type": "score", "score": 1.16 }
        });
        let d = summarize(430.5, &answers);
        assert_eq!(d["avoidable"], json!(0.8));
        assert_eq!((d["cause"].as_str(), d["causeP"].as_f64()), (Some("outnumbered"), Some(0.34)));
        assert_eq!(d["fight"], json!("skirmish"));
        assert_eq!(d["positioning"], json!(1.16));
        // Missing answers stay empty rather than becoming zeros.
        assert!(summarize(1.0, &json!({}))["avoidable"].is_null());
    }

    #[test]
    fn the_clip_comes_with_the_facts_already_known() {
        let doc = json!({ "game": {
            "me": { "name": "Rin", "champion": "Rakan", "team": "CHAOS", "position": "UTILITY" },
            "players": [
                { "name": "Rin", "champion": "Rakan", "team": "CHAOS", "isMe": true },
                { "name": "Kaja", "champion": "Xayah", "team": "CHAOS", "isMe": false },
                { "name": "Navruz", "champion": "Caitlyn", "team": "ORDER", "isMe": false },
                { "name": "Teu pai", "champion": "Alistar", "team": "ORDER", "isMe": false }
            ] } });
        let death = json!({ "t": 430.5, "gameTime": 424.0, "killerChamp": "Caitlyn", "assisters": ["Teu pai"] });
        let text = context(&doc, &death);
        assert!(text.contains("the player on Rakan (support)"), "{text}");
        assert!(text.contains("Allies: Xayah. Enemies: Caitlyn, Alistar."), "{text}");
        assert!(text.contains("at 7:04 on the game clock, killed by Caitlyn.\n"), "{text}");
        assert!(!text.contains("took part"), "{text}");
    }
}
