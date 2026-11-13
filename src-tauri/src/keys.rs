//! Which game keys were held down during a recording, for the key overlay in the
//! review player.
//!
//! Hard rule: this only polls Windows for the state of a fixed list of keys, the same
//! way the mouse buttons and the bookmark key are read. No input hook is installed, so
//! nothing sits between the keyboard and the game.
//!
//! Privacy: only the keys in `KEYS` are looked at, only while League's window is in
//! front, and nothing at all is written while the in-game chat is open (Enter opens
//! and sends it, Esc closes it). Letters typed into chat or into another program never
//! reach the file.

use crate::audio::Clock;
use crate::settings::Settings;
use crate::winutil;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The default keys that are recorded, with their Windows virtual-key codes and row.
pub const KEYS: [(&str, i32, u8); 20] = [
    ("Q", 0x51, 0),
    ("W", 0x57, 0),
    ("E", 0x45, 0),
    ("R", 0x52, 0),
    ("D", 0x44, 0),
    ("F", 0x46, 0),
    ("1", 0x31, 1),
    ("2", 0x32, 1),
    ("3", 0x33, 1),
    ("4", 0x34, 1),
    ("5", 0x35, 1),
    ("6", 0x36, 1),
    ("7", 0x37, 1),
    ("B", 0x42, 1),
    ("A", 0x41, 2),
    ("S", 0x53, 2),
    ("Tab", 0x09, 2),
    ("Space", 0x20, 2),
    ("Ctrl", 0x11, 2),
    ("Shift", 0x10, 2),
];
const VK_RETURN: i32 = 0x0D;
const VK_ESCAPE: i32 = 0x1B;

/// Turn a user-friendly key name ("Q", "Space", "Mouse4", "T", "F1"...) into its
/// Windows virtual-key code.
pub fn resolve_vk(name: &str) -> Option<i32> {
    let up = name.trim().to_ascii_uppercase();
    if up.is_empty() {
        return None;
    }
    if up.len() == 1 {
        let b = up.as_bytes()[0];
        if b.is_ascii_alphanumeric() {
            return Some(b as i32);
        }
    }
    if let Some(n) = up.strip_prefix('F').and_then(|s| s.parse::<i32>().ok()).filter(|n| (1..=24).contains(n)) {
        return Some(0x70 + n - 1);
    }
    if let Some(n) = up.strip_prefix("NUMPAD").and_then(|s| s.parse::<i32>().ok()).filter(|n| (0..=9).contains(n)) {
        return Some(0x60 + n);
    }
    match up.as_str() {
        "TAB" => Some(0x09),
        "SPACE" => Some(0x20),
        "CTRL" | "CONTROL" => Some(0x11),
        "SHIFT" => Some(0x10),
        "ALT" => Some(0x12),
        "CAPSLOCK" | "CAPS" => Some(0x14),
        "MOUSE3" | "MBUTTON" => Some(0x04),
        "MOUSE4" | "XBUTTON1" | "M4" => Some(0x05),
        "MOUSE5" | "XBUTTON2" | "M5" => Some(0x06),
        "TILDE" | "`" | "~" => Some(0xC0),
        "MINUS" | "-" => Some(0xBD),
        "EQUALS" | "=" => Some(0xBB),
        "INSERT" => Some(0x2D),
        "DELETE" => Some(0x2E),
        "HOME" => Some(0x24),
        "END" => Some(0x23),
        "PAGEUP" => Some(0x21),
        "PAGEDOWN" => Some(0x22),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackedKey {
    pub label: String,
    pub vk: i32,
    pub row: u8,
}

/// The key list for a recording: the user's custom list if configured, otherwise the
/// standard League key set. Capped at 32 so every key fits in a `u32` bitmask.
pub fn active_keys(settings: &Settings) -> Vec<TrackedKey> {
    if !settings.key_map.is_empty() {
        let custom: Vec<TrackedKey> = settings
            .key_map
            .iter()
            .filter_map(|slot| {
                let vk = resolve_vk(&slot.vk)?;
                let label = if slot.label.trim().is_empty() { slot.vk.trim().to_string() } else { slot.label.trim().to_string() };
                Some(TrackedKey { label, vk, row: slot.row.min(2) })
            })
            .take(32)
            .collect();
        if !custom.is_empty() {
            return custom;
        }
    }
    KEYS.iter()
        .map(|(label, vk, row)| TrackedKey { label: (*label).to_string(), vk: *vk, row: *row })
        .collect()
}

pub fn names(keys: &[TrackedKey]) -> Vec<String> {
    keys.iter().map(|k| k.label.clone()).collect()
}

pub fn rows(keys: &[TrackedKey]) -> Vec<Vec<String>> {
    let mut out = vec![Vec::new(), Vec::new(), Vec::new()];
    for k in keys {
        out[(k.row as usize).min(2)].push(k.label.clone());
    }
    out.into_iter().filter(|r| !r.is_empty()).collect()
}

/// What `keys.csv` says about a moment besides the keys themselves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Playing = 0,
    /// The in-game chat is open; keys are not recorded.
    Chat = 1,
    /// Another window is in front of the game; keys are not recorded.
    Away = 2,
}

/// Turns raw key states into what may be written, keeping track of the chat.
#[derive(Default)]
pub struct Filter {
    chat: bool,
    enter_was_down: bool,
    esc_was_down: bool,
}

impl Filter {
    /// `focused`: the game's window is in front. `held`: bit mask over the tracked keys.
    pub fn step(&mut self, focused: bool, enter: bool, esc: bool, held: u32) -> (u32, State) {
        let (enter_pressed, esc_pressed) = (enter && !self.enter_was_down, esc && !self.esc_was_down);
        self.enter_was_down = enter;
        self.esc_was_down = esc;
        if !focused {
            // Chat does not stay open in a way we can follow once the game loses focus.
            self.chat = false;
            return (0, State::Away);
        }
        if enter_pressed {
            self.chat = !self.chat;
        } else if esc_pressed {
            self.chat = false;
        }
        // The press of Enter that sends a message still counts as chat, so the keys
        // held at that instant are never written.
        if self.chat || enter_pressed {
            (0, State::Chat)
        } else {
            (held, State::Playing)
        }
    }
}

/// Poll the keys until `stop`, writing a row to `path` whenever something changes.
pub fn record_loop(path: PathBuf, game_pid: u32, keys: Vec<TrackedKey>, clock: Clock, stop: Arc<AtomicBool>) {
    let Ok(file) = fs::File::create(&path) else { return };
    let mut w = std::io::BufWriter::new(file);
    let _ = writeln!(w, "t_ms,keys,state");
    let mut filter = Filter::default();
    let mut last: Option<(u32, State)> = None;
    let mut last_flush = Instant::now();
    let mut focused = false;
    let mut focus_checked = Instant::now() - Duration::from_secs(1);
    while !stop.load(Ordering::Relaxed) {
        // Which window is in front changes rarely; asking ten times a second is plenty.
        if focus_checked.elapsed() >= Duration::from_millis(100) {
            focused = winutil::foreground_pid() == Some(game_pid);
            focus_checked = Instant::now();
        }
        let held = if focused {
            keys.iter().enumerate().fold(0u32, |m, (i, k)| if winutil::key_down(k.vk) { m | (1 << i) } else { m })
        } else {
            0
        };
        let now = filter.step(focused, focused && winutil::key_down(VK_RETURN), focused && winutil::key_down(VK_ESCAPE), held);
        if last != Some(now) {
            let t = (clock.secs() * 1000.0) as i64;
            let _ = writeln!(w, "{t},{},{}", now.0, now.1 as u8);
            last = Some(now);
        }
        if last_flush.elapsed() > Duration::from_secs(2) {
            let _ = w.flush();
            last_flush = Instant::now();
        }
        std::thread::sleep(Duration::from_millis(8));
    }
    let _ = w.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_pass_through_while_playing() {
        let mut f = Filter::default();
        assert_eq!(f.step(true, false, false, 0b101), (0b101, State::Playing));
    }

    #[test]
    fn nothing_is_written_while_chat_is_open() {
        let mut f = Filter::default();
        assert_eq!(f.step(true, true, false, 0b1), (0, State::Chat)); // Enter opens chat
        assert_eq!(f.step(true, false, false, 0b1111), (0, State::Chat)); // typing
        assert_eq!(f.step(true, true, false, 0b1), (0, State::Chat)); // Enter sends
        assert_eq!(f.step(true, false, false, 0b1), (0b1, State::Playing));
    }

    #[test]
    fn holding_enter_does_not_toggle_twice() {
        let mut f = Filter::default();
        f.step(true, true, false, 0);
        assert_eq!(f.step(true, true, false, 0b10), (0, State::Chat));
        assert_eq!(f.step(true, false, false, 0b10), (0, State::Chat));
    }

    #[test]
    fn escape_closes_chat() {
        let mut f = Filter::default();
        f.step(true, true, false, 0);
        f.step(true, false, false, 0);
        assert_eq!(f.step(true, false, true, 0b1), (0b1, State::Playing));
    }

    #[test]
    fn losing_focus_records_nothing_and_closes_chat() {
        let mut f = Filter::default();
        f.step(true, true, false, 0);
        assert_eq!(f.step(false, false, false, 0b111), (0, State::Away));
        assert_eq!(f.step(true, false, false, 0b1), (0b1, State::Playing));
    }

    #[test]
    fn key_list_fits_the_mask() {
        assert!(KEYS.len() <= 32);
    }

    #[test]
    fn custom_keys_resolve_and_group_by_row() {
        assert_eq!(resolve_vk("q"), Some(0x51));
        assert_eq!(resolve_vk("Mouse4"), Some(0x05));
        assert_eq!(resolve_vk("Space"), Some(0x20));
        assert_eq!(resolve_vk("invalid_key"), None);
        let mut s = Settings::default();
        s.key_map = vec![
            crate::settings::KeySlot { vk: "T".into(), label: "Ward".into(), row: 0 },
            crate::settings::KeySlot { vk: "Mouse4".into(), label: "M4".into(), row: 2 },
            crate::settings::KeySlot { vk: "bogus".into(), label: "".into(), row: 0 },
        ];
        let k = active_keys(&s);
        assert_eq!(k.len(), 2);
        assert_eq!(k[0].label, "Ward");
        assert_eq!(k[1].vk, 0x05);
        assert_eq!(rows(&k), vec![vec!["Ward".to_string()], vec!["M4".to_string()]]);
    }
}
