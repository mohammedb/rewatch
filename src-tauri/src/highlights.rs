//! The moments of a game worth keeping: multikills, aces, fights over big objectives
//! and team fights won clearly. They are found from the event list alone, shown in
//! the Review tab, and (if the setting is on) saved by themselves as short clips.
//!
//! Clips are 1080p H.264 with game sound, Discord and the microphone mixed, so they
//! can be dropped straight into Discord. They live in the recording's own folder:
//! counted towards the size limit and deleted with the game.

use crate::settings::{log, Settings};
use crate::video::run_tool;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const FILE: &str = "highlights.json";
const VERSION: i64 = 1;
const LEAD: f64 = 8.0;
const TAIL: f64 = 4.0;
const LONGEST: f64 = 45.0;
const MOST: usize = 6;

#[derive(Debug, Clone, PartialEq)]
pub struct Highlight {
    /// The moment itself, in video time.
    pub t: f64,
    pub start: f64,
    pub end: f64,
    /// "multikill" | "ace" | "objective" | "fight"
    pub kind: &'static str,
    pub label: String,
    score: f64,
}

struct Kill {
    t: f64,
    killer: String,
    good: Option<bool>,
}

fn size_name(n: i64) -> &'static str {
    match n {
        2 => "double kill",
        3 => "triple kill",
        4 => "quadra kill",
        _ => "penta kill",
    }
}

/// The highlights of a recording, in order. At most six, none overlapping.
pub fn find(doc: &Value) -> Vec<Highlight> {
    let text = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let num = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
    let events: Vec<Value> = doc.get("events").and_then(|e| e.as_array()).cloned().unwrap_or_default();
    let duration = doc.get("duration").and_then(|x| x.as_f64()).unwrap_or(f64::MAX);
    let mut kills: Vec<Kill> = events
        .iter()
        .filter(|e| e["kind"] == "ChampionKill")
        .map(|e| Kill { t: num(e, "t"), killer: text(e, "killer"), good: e.get("good").and_then(|g| g.as_bool()) })
        .collect();
    kills.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    let window = |first: f64, last: f64| ((first - LEAD).max(0.0), (last + TAIL).min(duration));
    let mut found: Vec<Highlight> = Vec::new();

    for e in &events {
        let t = num(e, "t");
        let good = e.get("good").and_then(|g| g.as_bool());
        match text(e, "kind").as_str() {
            // Your own double kills and better; a teammate's triple and better.
            "Multikill" => {
                let n = text(e, "detail").parse::<i64>().unwrap_or(0);
                let mine = e.get("mine") == Some(&json!(true));
                if !((mine && n >= 2) || (good == Some(true) && n >= 3)) {
                    continue;
                }
                let killer = text(e, "killer");
                let theirs: Vec<f64> = kills.iter().filter(|k| k.killer == killer && k.t <= t + 1.0).map(|k| k.t).collect();
                let first = theirs.iter().rev().take(n as usize).last().copied().unwrap_or(t);
                let (start, end) = window(first.max(t - 30.0), t);
                let who = if mine { "Your".to_string() } else { format!("{}'s", Some(text(e, "killerChamp")).filter(|c| !c.is_empty()).unwrap_or(killer)) };
                found.push(Highlight { t, start, end, kind: "multikill", label: format!("{who} {}", size_name(n)), score: n as f64 * 10.0 + if mine { 15.0 } else { 0.0 } });
            }
            "Ace" if good == Some(true) => {
                let first = kills.iter().filter(|k| k.t >= t - 20.0 && k.t <= t + 1.0).map(|k| k.t).fold(t, f64::min);
                let (start, end) = window(first, t);
                found.push(Highlight { t, start, end, kind: "ace", label: "Ace".into(), score: 35.0 });
            }
            // A big monster taken with a fight around it.
            kind @ ("BaronKill" | "AtakhanKill" | "DragonKill") => {
                let near: Vec<f64> = kills.iter().filter(|k| k.t >= t - 20.0 && k.t <= t + 15.0).map(|k| k.t).collect();
                let elder = text(e, "detail").eq_ignore_ascii_case("Elder");
                if near.len() < 2 {
                    continue;
                }
                let (start, end) = window(near.iter().copied().fold(t, f64::min), near.iter().copied().fold(t, f64::max));
                let what = match kind {
                    "BaronKill" => "Baron".to_string(),
                    "AtakhanKill" => "Atakhan".to_string(),
                    _ if elder => "Elder dragon".to_string(),
                    _ => format!("{} dragon", text(e, "detail")).trim().to_string(),
                };
                let outcome = match good {
                    Some(true) => ", yours",
                    Some(false) => ", lost",
                    None => "",
                };
                let big = kind != "DragonKill" || elder;
                found.push(Highlight { t, start, end, kind: "objective", label: format!("{what} fight{outcome}"), score: if big { 25.0 } else { 14.0 } + near.len() as f64 });
            }
            _ => {}
        }
    }

    // Team fights won clearly: kills within 14 seconds of each other are one fight.
    let mut i = 0;
    while i < kills.len() {
        let mut j = i;
        while j + 1 < kills.len() && kills[j + 1].t - kills[j].t <= 14.0 {
            j += 1;
        }
        let ours = kills[i..=j].iter().filter(|k| k.good == Some(true)).count();
        let theirs = kills[i..=j].iter().filter(|k| k.good == Some(false)).count();
        if ours >= 3 && ours >= theirs + 2 {
            let (start, end) = window(kills[i].t, kills[j].t);
            found.push(Highlight { t: kills[i].t, start, end, kind: "fight", label: format!("Team fight, {ours} for {theirs}"), score: 12.0 + ours as f64 * 3.0 - theirs as f64 });
        }
        i = j + 1;
    }

    // Best first; a moment that overlaps one already kept is folded into it.
    found.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    let mut kept: Vec<Highlight> = Vec::new();
    for h in found {
        match kept.iter().position(|k| h.start < k.end && k.start < h.end) {
            Some(i) => {
                let k = &mut kept[i];
                let (start, end) = (k.start.min(h.start), k.end.max(h.end));
                if end - start <= LONGEST {
                    k.start = start;
                    k.end = end;
                }
            }
            None if kept.len() < MOST => kept.push(h),
            None => {}
        }
    }
    for k in &mut kept {
        if k.end - k.start > LONGEST {
            k.start = k.end - LONGEST;
        }
    }
    kept.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    kept
}

fn file_name(h: &Highlight) -> String {
    let s = h.t.max(0.0) as u64;
    let slug: String = h.label.to_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let slug = slug.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    format!("highlight_{:02}m{:02}s_{slug}.mp4", s / 60, s % 60)
}

fn as_json(h: &Highlight, dir: &Path) -> Value {
    let file = dir.join(file_name(h));
    json!({
        "t": h.t, "start": h.start, "end": h.end, "kind": h.kind, "label": h.label,
        "file": if file.exists() { json!(file.to_string_lossy()) } else { Value::Null },
    })
}

/// The highlights of the recording in `dir`, each with its clip if it has been saved.
pub fn list(doc: &Value, dir: &Path) -> Vec<Value> {
    find(doc).iter().map(|h| as_json(h, dir)).collect()
}

/// One clip: 1080p H.264 with every sound track of the recording mixed in.
fn cut(ffmpeg: &Path, dir: &Path, h: &Highlight, out: &Path) -> Result<()> {
    let p = |x: &Path| x.to_string_lossy().to_string();
    let len = (h.end - h.start).max(1.0);
    let mut inputs: Vec<String> = Vec::new();
    let mut add = |file: &Path| inputs.extend(["-ss".into(), format!("{:.3}", h.start), "-t".into(), format!("{len:.3}"), "-i".into(), p(file)]);
    add(&dir.join("game.mp4"));
    let mut sound = vec!["[0:a]".to_string()];
    for name in ["discord", "mic"] {
        let file = dir.join(format!("{name}.m4a"));
        if file.exists() {
            add(&file);
            sound.push(format!("[{}:a]", sound.len()));
        }
    }
    let part = out.with_extension("part");
    let mut last = anyhow!("no encoder");
    for enc in [
        &["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "27", "-b:v", "0"][..],
        &["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "27", "-qp_p", "27"][..],
        &["-c:v", "h264_qsv", "-global_quality", "27"][..],
        &["-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-pix_fmt", "yuv420p"][..],
    ] {
        let mut args: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error"].map(String::from).to_vec();
        args.extend(inputs.iter().cloned());
        let mut graph = "[0:v]scale=-2:'min(1080,ih)'[v]".to_string();
        if sound.len() > 1 {
            graph += &format!(";{}amix=inputs={}:normalize=0[a]", sound.join(""), sound.len());
        }
        args.extend(["-filter_complex".into(), graph, "-map".into(), "[v]".into(), "-map".into(), if sound.len() > 1 { "[a]".into() } else { "0:a?".into() }]);
        args.extend(enc.iter().map(|x| x.to_string()));
        args.extend(["-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-f", "mp4"].map(String::from));
        args.push(p(&part));
        match run_tool(ffmpeg, &args) {
            Ok(_) => {
                std::fs::rename(&part, out)?;
                return Ok(());
            }
            Err(e) => last = e,
        }
    }
    let _ = std::fs::remove_file(&part);
    Err(last)
}

/// Save every highlight of the recording in `dir` that has no clip yet. `stop` is
/// asked before each one. A small note file marks the recording as done.
pub fn save(settings: &Settings, dir: &Path, stop: &dyn Fn() -> bool) -> Result<Vec<Value>> {
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("match.json"))?)?;
    let (ffmpeg, _) = settings.ffmpeg_tools();
    let found = find(&doc);
    let mut made = 0;
    for h in &found {
        let out = dir.join(file_name(h));
        if out.exists() {
            continue;
        }
        if stop() {
            return Err(anyhow!("A game started; the rest of the clips wait until it is over."));
        }
        cut(&ffmpeg, dir, h, &out)?;
        made += 1;
    }
    std::fs::write(dir.join(FILE), json!({ "version": VERSION, "count": found.len() }).to_string())?;
    if made > 0 {
        log(format!("[highlights] {}: {made} clips saved", dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()));
    }
    Ok(found.iter().map(|h| as_json(h, dir)).collect())
}

/// The newest recording of the last three days whose highlights have not been saved.
pub fn next_wanted(root: &Path) -> Option<PathBuf> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let mut waiting: Vec<(i64, PathBuf)> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let dir = e.path();
            if dir.join(FILE).exists() || !dir.join("game.mp4").exists() {
                return None;
            }
            let doc: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("match.json")).ok()?).ok()?;
            let started = doc.get("startedEpochMs").and_then(|x| x.as_i64()).unwrap_or(0);
            (now - started < 3 * 24 * 3600 * 1000 && !find(&doc).is_empty()).then_some((started, dir))
        })
        .collect();
    waiting.sort_by_key(|(started, _)| -*started);
    waiting.into_iter().next().map(|(_, dir)| dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kill(t: f64, killer: &str, good: bool) -> Value {
        json!({ "kind": "ChampionKill", "t": t, "killer": killer, "killerChamp": killer, "good": good })
    }

    #[test]
    fn the_moments_worth_keeping_are_found() {
        let doc = json!({ "duration": 1800.0, "events": [
            // A lone kill: nothing.
            kill(100.0, "Rin", true),
            // My triple: the double inside it is the same moment, kept once.
            kill(300.0, "Rin", true), kill(303.0, "Rin", true),
            { "kind": "Multikill", "t": 303.0, "killer": "Rin", "killerChamp": "Ahri", "detail": "2", "mine": true, "good": true },
            kill(308.0, "Rin", true),
            { "kind": "Multikill", "t": 308.0, "killer": "Rin", "killerChamp": "Ahri", "detail": "3", "mine": true, "good": true },
            // A teammate's double is not a highlight; an enemy's triple is not either.
            kill(500.0, "Kaja", true), kill(502.0, "Kaja", true),
            { "kind": "Multikill", "t": 502.0, "killer": "Kaja", "killerChamp": "Jinx", "detail": "2", "mine": false, "good": true },
            // Baron with a fight around it, lost.
            kill(900.0, "Zed", false), kill(905.0, "Zed", false),
            { "kind": "BaronKill", "t": 910.0, "killer": "Vi", "good": false },
            // A dragon nobody fought over: nothing.
            { "kind": "DragonKill", "t": 1200.0, "detail": "Fire", "good": true },
            // A fight won four for one, ending in an ace.
            kill(1500.0, "Kaja", true), kill(1504.0, "Zed", false), kill(1507.0, "Rin", true), kill(1510.0, "Tor", true), kill(1515.0, "Kaja", true),
            { "kind": "Ace", "t": 1515.0, "good": true }
        ] });
        let found = find(&doc);
        let labels: Vec<&str> = found.iter().map(|h| h.label.as_str()).collect();
        assert_eq!(labels, vec!["Your triple kill", "Baron fight, lost", "Ace"]);
        // The triple starts before its first kill and ends after its last.
        assert!((found[0].start - 292.0).abs() < 1e-9 && (found[0].end - 312.0).abs() < 1e-9, "{:?}", found[0]);
        // The ace and the fight it ended are one clip covering both.
        assert!((found[2].start - 1492.0).abs() < 1e-9 && (found[2].end - 1519.0).abs() < 1e-9, "{:?}", found[2]);
        assert_eq!(file_name(&found[1]), "highlight_15m10s_baron-fight-lost.mp4");
        assert!(find(&json!({})).is_empty());
    }

    #[test]
    fn no_clip_is_longer_than_the_limit_and_there_are_at_most_six() {
        let mut events = Vec::new();
        for g in 0..10 {
            let base = 100.0 + g as f64 * 120.0;
            for k in 0..4 {
                events.push(kill(base + k as f64 * 13.0, "Kaja", true));
            }
        }
        let found = find(&json!({ "duration": 3000.0, "events": events }));
        assert_eq!(found.len(), 6);
        assert!(found.iter().all(|h| h.end - h.start <= LONGEST + 1e-9 && h.end > h.start));
        assert!(found.windows(2).all(|w| w[0].t < w[1].t));
    }
}
