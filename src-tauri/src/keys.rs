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
use crate::winutil;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The keys that are recorded, with their Windows virtual-key codes. The order fixes
/// each key's bit in `keys.csv`; the names are stored in `match.json` with it, so the
/// list can change later without breaking older recordings.
pub const KEYS: [(&str, i32); 20] = [
    ("Q", 0x51),
    ("W", 0x57),
    ("E", 0x45),
    ("R", 0x52),
    ("D", 0x44),
    ("F", 0x46),
    ("1", 0x31),
    ("2", 0x32),
    ("3", 0x33),
    ("4", 0x34),
    ("5", 0x35),
    ("6", 0x36),
    ("7", 0x37),
    ("B", 0x42),
    ("A", 0x41),
    ("S", 0x53),
    ("Tab", 0x09),
    ("Space", 0x20),
    ("Ctrl", 0x11),
    ("Shift", 0x10),
];
const VK_RETURN: i32 = 0x0D;
const VK_ESCAPE: i32 = 0x1B;

pub fn names() -> Vec<&'static str> {
    KEYS.iter().map(|k| k.0).collect()
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
    /// `focused`: the game's window is in front. `held`: bit mask over `KEYS`.
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
pub fn record_loop(path: PathBuf, game_pid: u32, clock: Clock, stop: Arc<AtomicBool>) {
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
            KEYS.iter().enumerate().fold(0u32, |m, (i, k)| if winutil::key_down(k.1) { m | (1 << i) } else { m })
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
}
