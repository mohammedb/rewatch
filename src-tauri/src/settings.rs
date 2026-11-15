//! User settings, stored as JSON in %APPDATA%\Rewatch\settings.json.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QueueToggles {
    pub ranked_solo: bool,
    pub ranked_flex: bool,
    pub normal: bool,
    pub aram: bool,
    pub custom: bool,
    pub other: bool,
}

impl Default for QueueToggles {
    fn default() -> Self {
        Self {
            ranked_solo: true,
            ranked_flex: true,
            normal: true,
            aram: true,
            custom: true,
            other: true,
        }
    }
}

impl QueueToggles {
    /// Whether a game in the given queue should be recorded.
    pub fn allows(&self, queue_id: i64) -> bool {
        match queue_id {
            420 => self.ranked_solo,
            440 => self.ranked_flex,
            400 | 430 | 480 | 490 => self.normal,
            450 | 2400 => self.aram,
            0 | -1 => self.custom,
            _ => self.other,
        }
    }
}

/// A teammate: someone whose view can be watched here, and who may watch this PC's.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Friend {
    pub name: String,
    /// Their friend code, as shown in their app.
    pub code: String,
}

/// One key tracked for the key overlay in the review player.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct KeySlot {
    /// Windows key name ("Q", "Space", "Mouse4", "T"...).
    pub vk: String,
    /// Short label shown on the keycap (defaults to `vk`).
    pub label: String,
    /// Which row of the overlay it sits on (0, 1, or 2).
    pub row: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Folder that holds one sub-folder per recorded game. Empty until first run is done.
    pub recordings_dir: String,
    pub auto_record: bool,
    /// Launch hidden in the tray when Windows starts, so games are recorded without
    /// opening the app first.
    pub start_with_windows: bool,
    pub fps: u32,
    /// "native" | "1440" | "1080" | "720"
    pub resolution: String,
    /// "h264" | "hevc" | "av1"
    pub codec: String,
    /// "auto" | "nvenc" | "amf" | "qsv" | "cpu"
    pub encoder: String,
    /// Constant-quality value for the encoder. Lower is better quality and bigger files.
    pub quality: u32,
    pub record_discord: bool,
    pub record_mic: bool,
    /// Device id of the microphone to record. Empty means the Windows default input.
    pub mic_device: String,
    pub mouse_tracking: bool,
    /// Log which game keys were held, for the key overlay in the player.
    pub key_tracking: bool,
    /// Custom key list for the overlay. Empty uses the standard League key set.
    pub key_map: Vec<KeySlot>,
    /// Read from the League client's local API (read-only): the queue name before a
    /// game, and after it the match details, timeline and rank.
    pub use_client_api: bool,
    pub queues: QueueToggles,
    /// Delete oldest recordings when the folder grows past this. 0 disables the cap.
    pub quota_gb: u64,
    /// Global hotkey that drops a bookmark while recording. Empty disables it.
    pub bookmark_hotkey: String,
    /// Path to ffmpeg.exe. Empty means auto-detect.
    pub ffmpeg_path: String,
    /// League install folder. Empty means auto-detect.
    pub league_dir: String,
    /// Automatically snapshot League's Config folder before a game when settings changed.
    pub auto_backup_league: bool,
    /// Let the teammates listed below watch recordings from this PC.
    pub share_with_friends: bool,
    /// Name shown to teammates.
    pub share_name: String,
    /// Copy teammates' views of shared games into my recording folders, so they
    /// play when the teammate is offline.
    pub keep_teammate_views: bool,
    /// Make a smaller 1080p copy of each recent game for teammates to fetch instead
    /// of the full recording.
    pub review_copies: bool,
    /// Let teammates see the notes and drawings made on games they also recorded.
    pub share_notes: bool,
    /// Show a Windows notification when a recording starts, is saved, or fails.
    pub notify: bool,
    /// Install new versions by itself when no game is running.
    pub auto_update: bool,
    /// Save each game's highlights (multikills, aces, big fights) as short clips.
    pub auto_highlights: bool,
    /// After saving the stitched highlight reel for a non-kept game, remove the full
    /// `game.mp4` to save disk space.
    pub highlights_only: bool,
    /// Send a short clip of each death to Google's Decisions API for hints in the
    /// Review tab. Off unless switched on, and needs the key below.
    pub ai_review: bool,
    /// The user's own Gemini API key. Stays on this PC; sent only to Google.
    pub gemini_key: String,
    /// The user's own Riot API key (developer.riotgames.com). With it, post-game data
    /// comes from Riot's official web API instead of the League client. Stays on this
    /// PC; sent only to Riot.
    pub riot_api_key: String,
    /// After this many losses in a row in one sitting, a notification asks whether
    /// to stop for today. 0 turns it off.
    pub break_after_losses: u32,
    pub friends: Vec<Friend>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            recordings_dir: String::new(),
            auto_record: true,
            start_with_windows: true,
            fps: 60,
            resolution: "native".into(),
            codec: "h264".into(),
            encoder: "auto".into(),
            quality: 23,
            record_discord: true,
            record_mic: true,
            mic_device: String::new(),
            mouse_tracking: true,
            key_tracking: true,
            key_map: Vec::new(),
            use_client_api: true,
            queues: QueueToggles::default(),
            quota_gb: 300,
            bookmark_hotkey: "F8".into(),
            ffmpeg_path: String::new(),
            league_dir: String::new(),
            auto_backup_league: true,
            share_with_friends: true,
            share_name: String::new(),
            keep_teammate_views: true,
            review_copies: true,
            share_notes: true,
            notify: true,
            auto_update: true,
            auto_highlights: true,
            highlights_only: false,
            ai_review: false,
            gemini_key: String::new(),
            riot_api_key: String::new(),
            break_after_losses: 0,
            friends: Vec::new(),
        }
    }
}

pub fn app_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("Rewatch");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn settings_path() -> PathBuf {
    app_dir().join("settings.json")
}

impl Settings {
    pub fn load() -> Settings {
        fs::read_to_string(settings_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> anyhow::Result<()> {
        fs::write(settings_path(), serde_json::to_string_pretty(self)?)?;
        Ok(())
    }

    pub fn recordings_path(&self) -> Option<PathBuf> {
        if self.recordings_dir.trim().is_empty() {
            None
        } else {
            Some(PathBuf::from(self.recordings_dir.trim()))
        }
    }

    /// Resolve ffmpeg.exe and ffprobe.exe. Chocolatey's `bin` entries are shims that
    /// spawn the real program, which breaks stdin control and priority, so prefer the
    /// real files under `lib`.
    pub fn ffmpeg_tools(&self) -> (PathBuf, PathBuf) {
        let explicit = self.ffmpeg_path.trim();
        if !explicit.is_empty() {
            let ff = PathBuf::from(explicit);
            let probe = ff.with_file_name("ffprobe.exe");
            return (ff, probe);
        }
        // The copy that ships with the app, next to the program.
        if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
            for sub in ["bin", "resources\\bin", ""] {
                let ff = dir.join(sub).join("ffmpeg.exe");
                if ff.exists() {
                    let probe = ff.with_file_name("ffprobe.exe");
                    return (ff, probe);
                }
            }
        }
        let candidates = [
            r"C:\ProgramData\chocolatey\lib\ffmpeg-full\tools\ffmpeg\bin",
            r"C:\ProgramData\chocolatey\lib\ffmpeg\tools\ffmpeg\bin",
            r"C:\ffmpeg\bin",
            r"C:\Program Files\ffmpeg\bin",
        ];
        for c in candidates {
            let ff = PathBuf::from(c).join("ffmpeg.exe");
            if ff.exists() {
                return (ff, PathBuf::from(c).join("ffprobe.exe"));
            }
        }
        (PathBuf::from("ffmpeg"), PathBuf::from("ffprobe"))
    }

    /// League install folder (the one that contains `lockfile` while the client runs).
    pub fn league_path(&self) -> Option<PathBuf> {
        let explicit = self.league_dir.trim();
        if !explicit.is_empty() {
            return Some(PathBuf::from(explicit));
        }
        // Riot records where League is installed. Trust that over guessing: an old
        // copy on another drive would otherwise be picked and its stale lockfile used.
        if let Some(p) = riot_install_path() {
            return Some(p);
        }
        for letter in b'C'..=b'Z' {
            let p = PathBuf::from(format!(
                "{}:\\Riot Games\\League of Legends",
                letter as char
            ));
            if p.join("Game").exists() {
                return Some(p);
            }
        }
        None
    }
}

/// League's install folder as written by the Riot Client in its own settings file.
fn riot_install_path() -> Option<PathBuf> {
    let base = std::env::var_os("PROGRAMDATA")?;
    let file = PathBuf::from(base)
        .join("Riot Games")
        .join("Metadata")
        .join("league_of_legends.live")
        .join("league_of_legends.live.product_settings.yaml");
    let text = fs::read_to_string(file).ok()?;
    parse_install_path(&text).filter(|p| p.exists())
}

fn parse_install_path(yaml: &str) -> Option<PathBuf> {
    yaml.lines()
        .find_map(|l| l.trim().strip_prefix("product_install_full_path:"))
        .map(|v| v.trim().trim_matches('"').replace('/', "\\"))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_path_is_read_from_riot_settings() {
        let yaml = "locale_data:\n    default_locale: \"en_US\"\nproduct_install_full_path: \"Z:/Riot/Riot Games/League of Legends\"\nproduct_install_root: \"Z:/Riot/Riot Games\"\n";
        assert_eq!(
            parse_install_path(yaml),
            Some(PathBuf::from("Z:\\Riot\\Riot Games\\League of Legends"))
        );
        assert_eq!(parse_install_path("nothing: here"), None);
    }
}

/// Append a line to %APPDATA%\Rewatch\rewatch.log and echo it to stderr.
pub fn log(msg: impl AsRef<str>) {
    use std::io::Write;
    let line = format!(
        "{} {}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
        msg.as_ref()
    );
    eprint!("{line}");
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(app_dir().join("rewatch.log"))
    {
        let _ = f.write_all(line.as_bytes());
    }
}
