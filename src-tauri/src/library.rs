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

fn match_dir(settings: &Settings, id: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        return Err(anyhow!("Invalid recording id"));
    }
    let dir = settings
        .recordings_path()
        .ok_or_else(|| anyhow!("No recordings folder is set"))?
        .join(id);
    if !dir.join("match.json").exists() {
        return Err(anyhow!("Recording not found"));
    }
    Ok(dir)
}

fn dir_size(dir: &Path) -> u64 {
    fs::read_dir(dir)
        .map(|it| it.flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum())
        .unwrap_or(0)
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

/// All recordings, newest first, without the heavy per-event data.
pub fn list(settings: &Settings) -> Vec<Value> {
    let mut out = Vec::new();
    let Some(root) = settings.recordings_path() else { return out };
    let Ok(entries) = fs::read_dir(&root) else { return out };
    for entry in entries.flatten() {
        let dir = entry.path();
        let Some(mut doc) = read_json(&dir.join("match.json")) else { continue };
        let review = read_review(&dir);
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
            o.insert("sizeBytes".into(), json!(dir_size(&dir)));
            o.insert("keep".into(), review.get("keep").cloned().unwrap_or(json!(false)));
            o.insert(
                "noteCount".into(),
                json!(review.get("notes").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0)),
            );
            let thumb = dir.join("thumb.jpg");
            o.insert("thumb".into(), if thumb.exists() { json!(thumb.to_string_lossy()) } else { Value::Null });
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
    if let Some(o) = doc.as_object_mut() {
        o.insert("dir".into(), json!(dir.to_string_lossy()));
        o.insert("sizeBytes".into(), json!(dir_size(&dir)));
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
    }
    Ok(doc)
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

pub fn delete(settings: &Settings, id: &str) -> Result<()> {
    let dir = match_dir(settings, id)?;
    fs::remove_dir_all(dir)?;
    Ok(())
}

/// Delete the oldest recordings until the folder fits the size cap. Recordings marked
/// "keep" and the one named in `protect` are never deleted.
pub fn enforce_quota(settings: &Settings, protect: Option<&str>) -> Vec<String> {
    let mut removed = Vec::new();
    if settings.quota_gb == 0 {
        return removed;
    }
    let cap = settings.quota_gb * 1024 * 1024 * 1024;
    let mut all = list(settings);
    let mut total: u64 = all.iter().map(|m| m["sizeBytes"].as_u64().unwrap_or(0)).sum();
    all.reverse(); // oldest first
    for m in all {
        if total <= cap {
            break;
        }
        let id = m["id"].as_str().unwrap_or("");
        if m["keep"] == json!(true) || Some(id) == protect {
            continue;
        }
        if delete(settings, id).is_ok() {
            total = total.saturating_sub(m["sizeBytes"].as_u64().unwrap_or(0));
            log(format!("[storage] removed {id} to stay under {} GB", settings.quota_gb));
            removed.push(id.to_string());
        }
    }
    removed
}

/// Cut `start..end` (video seconds) into a standalone MP4 with the chosen sound
/// tracks mixed together. Video is copied, not re-encoded, so this is fast.
pub fn export_clip(settings: &Settings, id: &str, start: f64, end: f64, tracks: &[String]) -> Result<String> {
    let dir = match_dir(settings, id)?;
    let (ffmpeg, _) = settings.ffmpeg_tools();
    let len = (end - start).max(0.5);
    let clips = dir.parent().unwrap_or(&dir).join("Clips");
    fs::create_dir_all(&clips)?;
    let s = start.max(0.0) as u64;
    let out = clips.join(format!("{id}_{:02}m{:02}s_{:.0}s.mp4", s / 60, s % 60, len));
    let p = |x: &Path| x.to_string_lossy().to_string();
    let seek = |args: &mut Vec<String>, file: &Path| {
        args.extend(["-ss".into(), format!("{:.3}", start.max(0.0)), "-t".into(), format!("{len:.3}"), "-i".into(), p(file)]);
    };

    let mut args: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error"].map(String::from).to_vec();
    seek(&mut args, &dir.join("game.mp4"));
    let mut labels: Vec<String> = Vec::new();
    if tracks.iter().any(|t| t == "game") {
        labels.push("[0:a]".into());
    }
    let mut next_input = 1;
    for name in ["discord", "mic"] {
        let file = dir.join(format!("{name}.m4a"));
        if tracks.iter().any(|t| t == name) && file.exists() {
            seek(&mut args, &file);
            labels.push(format!("[{next_input}:a]"));
            next_input += 1;
        }
    }
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
    args.push(p(&out));
    run_tool(&ffmpeg, &args)?;
    Ok(p(&out))
}

/// One MP4 holding the video and every sound track as separate, named tracks, for
/// use in an editor.
pub fn export_full(settings: &Settings, id: &str) -> Result<String> {
    let dir = match_dir(settings, id)?;
    let (ffmpeg, _) = settings.ffmpeg_tools();
    let p = |x: &Path| x.to_string_lossy().to_string();
    let out = dir.join(format!("{id}_all-tracks.mp4"));
    let mut args: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error", "-i"].map(String::from).to_vec();
    args.push(p(&dir.join("game.mp4")));
    let mut titles = vec!["Game"];
    for (name, title) in [("discord", "Discord"), ("mic", "Microphone (raw)")] {
        let file = dir.join(format!("{name}.m4a"));
        if file.exists() {
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
pub fn export_split(
    settings: &Settings,
    id: &str,
    start: f64,
    end: f64,
    views: &[SplitView],
    tracks: &[String],
    listen: Option<usize>,
    my_label: &str,
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
    let (ffmpeg, _) = settings.ffmpeg_tools();
    let len = (end - start).clamp(0.5, 600.0);
    let start = start.max(0.0);
    let clips = dir.parent().unwrap_or(&dir).join("Clips");
    fs::create_dir_all(&clips)?;
    let s0 = start as u64;
    let out = clips.join(format!("{id}_{:02}m{:02}s_{:.0}s_split.mp4", s0 / 60, s0 % 60, len));
    let p = |x: &Path| x.to_string_lossy().to_string();

    let mut inputs: Vec<String> = Vec::new();
    let mut add = |at: f64, source: String| {
        inputs.extend(["-ss".into(), format!("{:.3}", at.max(0.0)), "-t".into(), format!("{len:.3}"), "-i".into(), source]);
    };
    add(start, p(&dir.join("game.mp4")));
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
        let file = dir.join(format!("{name}.m4a"));
        if tracks.iter().any(|t| t == name) && file.exists() {
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
    // The graphics card's encoder if there is one, the processor otherwise.
    for enc in [
        &["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "23", "-b:v", "0"][..],
        &["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "23", "-qp_p", "23"][..],
        &["-c:v", "h264_qsv", "-global_quality", "23"][..],
        &["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p"][..],
    ] {
        let mut args: Vec<String> = ["-y", "-hide_banner", "-loglevel", "error"].map(String::from).to_vec();
        args.extend(inputs.iter().cloned());
        args.extend(["-filter_complex".into(), graph.clone(), "-map".into(), "[v]".into()]);
        match sound.len() {
            0 => args.push("-an".into()),
            1 => args.extend(["-map".into(), sound[0].trim_matches(|c| c == '[' || c == ']').to_string()]),
            _ => args.extend(["-map".into(), "[a]".into()]),
        }
        if !sound.is_empty() {
            args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
        }
        args.extend(enc.iter().map(|x| x.to_string()));
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
    use super::split_layout;

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
}
