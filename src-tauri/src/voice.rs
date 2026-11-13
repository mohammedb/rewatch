//! When someone was talking: turns a sound track into a list of "from, to" stretches.
//!
//! Used for the comms rows under the timeline. The microphone track gives the times
//! you spoke; the Discord track gives the times anyone else did. Only these times are
//! ever shared with teammates, never the sound itself.

use crate::video::CREATE_NO_WINDOW;
use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};

const RATE: u32 = 8000;
/// Samples per measuring step (30 ms).
const STEP: usize = 240;

/// Stretches of speech in mono 16-bit sound. `mic` picks the stricter settings a raw
/// microphone needs (room noise, key presses); a Discord track is silent between words.
pub fn segments_from_pcm(samples: &[i16], rate: u32, mic: bool) -> Vec<[f64; 2]> {
    let step = (rate as usize * 30 / 1000).max(1);
    let levels: Vec<f32> = samples
        .chunks(step)
        .map(|c| (c.iter().map(|s| (*s as f32 / 32768.0).powi(2)).sum::<f32>() / c.len() as f32).sqrt())
        .collect();
    if levels.is_empty() {
        return Vec::new();
    }
    // The quiet level of this track: what a tenth of the steps stay under.
    let mut sorted = levels.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let floor = sorted[sorted.len() / 10];
    let threshold = if mic { (floor * 4.0).clamp(0.010, 0.06) } else { (floor * 4.0).clamp(0.004, 0.03) };
    let (join_gap, shortest) = if mic { (0.45, 0.25) } else { (0.35, 0.15) };
    let dt = step as f64 / rate as f64;

    let mut out: Vec<[f64; 2]> = Vec::new();
    let mut open: Option<f64> = None;
    for (i, level) in levels.iter().enumerate() {
        let t = i as f64 * dt;
        match (open, *level > threshold) {
            (None, true) => open = Some(t),
            (Some(start), false) => {
                out.push([start, t]);
                open = None;
            }
            _ => {}
        }
    }
    if let Some(start) = open {
        out.push([start, levels.len() as f64 * dt]);
    }
    // Words in one sentence have short pauses between them: join those.
    let mut joined: Vec<[f64; 2]> = Vec::new();
    for seg in out {
        match joined.last_mut() {
            Some(last) if seg[0] - last[1] <= join_gap => last[1] = seg[1],
            _ => joined.push(seg),
        }
    }
    joined
        .into_iter()
        .filter(|s| s[1] - s[0] >= shortest)
        .map(|s| [(s[0] * 100.0).round() / 100.0, (s[1] * 100.0).round() / 100.0])
        .collect()
}

/// Speech stretches in a sound file, in the file's own time. Empty if it cannot be read.
pub fn analyze(ffmpeg: &Path, file: &Path, mic: bool) -> Vec<[f64; 2]> {
    let out = Command::new(ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(file)
        .args(["-vn", "-ac", "1", "-ar", &RATE.to_string(), "-f", "s16le", "-"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW | 0x0000_4000)
        .output();
    let Ok(out) = out else { return Vec::new() };
    let samples: Vec<i16> = out.stdout.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
    debug_assert_eq!(STEP, RATE as usize * 30 / 1000);
    segments_from_pcm(&samples, RATE, mic)
}

/// Speech times for one recording folder: `{ "mic": [[from, to]...], "discord": [...] }`
/// in video time. Worked out once and kept in `voice.json`.
pub fn for_dir(ffmpeg: &Path, dir: &Path) -> Value {
    let cache = dir.join("voice.json");
    if let Some(v) = std::fs::read_to_string(&cache).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
        return v;
    }
    let track = |name: &str, mic: bool| {
        let file = dir.join(format!("{name}.m4a"));
        if file.exists() { json!(analyze(ffmpeg, &file, mic)) } else { Value::Null }
    };
    let v = json!({ "mic": track("mic", true), "discord": track("discord", false) });
    let _ = std::fs::write(&cache, v.to_string());
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(secs: f64, level: f32) -> Vec<i16> {
        (0..(secs * 8000.0) as usize)
            .map(|i| ((i as f32 * 0.35).sin() * level * 32767.0) as i16)
            .collect()
    }

    #[test]
    fn speech_is_found_between_silences() {
        let mut pcm = tone(2.0, 0.0);
        pcm.extend(tone(1.0, 0.3)); // 2.0 to 3.0
        pcm.extend(tone(0.2, 0.0)); // a breath: joined with what follows
        pcm.extend(tone(0.8, 0.3)); // to 4.0
        pcm.extend(tone(3.0, 0.0));
        pcm.extend(tone(0.05, 0.3)); // a click: too short to count
        pcm.extend(tone(1.0, 0.0));
        let segs = segments_from_pcm(&pcm, 8000, true);
        assert_eq!(segs.len(), 1, "{segs:?}");
        assert!((segs[0][0] - 2.0).abs() < 0.05 && (segs[0][1] - 4.0).abs() < 0.05, "{segs:?}");
    }

    #[test]
    fn a_noisy_room_is_not_speech() {
        // Steady hiss with one loud stretch in it.
        let mut pcm = tone(3.0, 0.004);
        pcm.extend(tone(1.0, 0.2));
        pcm.extend(tone(3.0, 0.004));
        let segs = segments_from_pcm(&pcm, 8000, true);
        assert_eq!(segs.len(), 1, "{segs:?}");
        assert!(segments_from_pcm(&tone(5.0, 0.0), 8000, false).is_empty());
        assert!(segments_from_pcm(&[], 8000, false).is_empty());
    }
}
