//! Backup and restore of League of Legends configuration files (`PersistedSettings.json`,
//! `input.ini`, `game.cfg`) stored in `%APPDATA%\Rewatch\league-backups\`.
//!
//! Only reads and copies files in the League `Config` folder; never touches the running
//! game process.

use crate::settings::{app_dir, log, Settings};
use crate::winutil;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const CONFIG_FILES: [&str; 3] = ["PersistedSettings.json", "input.ini", "game.cfg"];
const MAX_AUTO_BACKUPS: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LeagueBackup {
    pub id: String,
    pub created_at: String,
    pub label: String,
    pub files: Vec<String>,
    pub size_bytes: u64,
    #[serde(default)]
    pub auto: bool,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn backups_dir() -> PathBuf {
    let dir = app_dir().join("league-backups");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn read_meta(dir: &Path) -> Option<LeagueBackup> {
    fs::read_to_string(dir.join("meta.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn same_as_latest(config_dir: &Path, base_dir: &Path) -> bool {
    let Some(latest) = list_in(base_dir).into_iter().next() else {
        return false;
    };
    let latest_dir = base_dir.join(&latest.id);
    for name in CONFIG_FILES {
        let src = config_dir.join(name);
        let dst = latest_dir.join(name);
        match (fs::read(&src).ok(), fs::read(&dst).ok()) {
            (Some(a), Some(b)) if a == b => {}
            (None, None) => {}
            _ => return false,
        }
    }
    true
}

fn unique_id(base_dir: &Path) -> String {
    let stem = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    if !base_dir.join(&stem).exists() {
        return stem;
    }
    for n in 1..1000 {
        let candidate = format!("{stem}_{n}");
        if !base_dir.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{stem}_{}", chrono::Local::now().timestamp_millis())
}

pub fn create_in(league_dir: &Path, base_dir: &Path, label: &str, auto: bool) -> Result<LeagueBackup> {
    let config_dir = league_dir.join("Config");
    if !config_dir.is_dir() {
        return Err(anyhow!("League Config folder not found at {}", config_dir.display()));
    }
    fs::create_dir_all(base_dir)?;
    let id = unique_id(base_dir);
    let dest = base_dir.join(&id);
    fs::create_dir_all(&dest)?;

    let mut files = Vec::new();
    let mut size_bytes = 0u64;
    for name in CONFIG_FILES {
        let src = config_dir.join(name);
        if src.is_file() {
            let bytes = fs::read(&src)?;
            size_bytes += bytes.len() as u64;
            fs::write(dest.join(name), bytes)?;
            files.push(name.to_string());
        }
    }
    if files.is_empty() {
        let _ = fs::remove_dir_all(&dest);
        return Err(anyhow!("No League config files found in {}", config_dir.display()));
    }

    let backup = LeagueBackup {
        id: id.clone(),
        created_at: chrono::Local::now().to_rfc3339(),
        label: if label.trim().is_empty() { "Manual snapshot".into() } else { label.trim().to_string() },
        files,
        size_bytes,
        auto,
    };
    fs::write(dest.join("meta.json"), serde_json::to_string_pretty(&backup)?)?;

    if auto {
        let autos: Vec<LeagueBackup> = list_in(base_dir).into_iter().filter(|b| b.auto).collect();
        for old in autos.into_iter().skip(MAX_AUTO_BACKUPS) {
            let _ = fs::remove_dir_all(base_dir.join(&old.id));
        }
    }
    Ok(backup)
}

pub fn list_in(base_dir: &Path) -> Vec<LeagueBackup> {
    let Ok(entries) = fs::read_dir(base_dir) else {
        return Vec::new();
    };
    let mut items: Vec<LeagueBackup> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| read_meta(&e.path()))
        .collect();
    items.sort_by(|a, b| b.id.cmp(&a.id));
    items
}

pub fn restore_in(league_dir: &Path, base_dir: &Path, id: &str) -> Result<LeagueBackup> {
    if !valid_id(id) {
        return Err(anyhow!("Invalid backup id"));
    }
    let src_dir = base_dir.join(id);
    let meta = read_meta(&src_dir).ok_or_else(|| anyhow!("Backup not found"))?;
    let config_dir = league_dir.join("Config");
    fs::create_dir_all(&config_dir)?;

    if !same_as_latest(&config_dir, base_dir) {
        let _ = create_in(league_dir, base_dir, "Before restore", true);
    }

    for name in &meta.files {
        let src = src_dir.join(name);
        if src.is_file() {
            fs::copy(&src, config_dir.join(name))?;
        }
    }
    Ok(meta)
}

pub fn delete_in(base_dir: &Path, id: &str) -> Result<()> {
    if !valid_id(id) {
        return Err(anyhow!("Invalid backup id"));
    }
    let dir = base_dir.join(id);
    if !dir.is_dir() {
        return Err(anyhow!("Backup not found"));
    }
    fs::remove_dir_all(dir)?;
    Ok(())
}

pub fn list() -> Vec<LeagueBackup> {
    list_in(&backups_dir())
}

pub fn create(settings: &Settings, label: &str) -> Result<LeagueBackup> {
    let league_dir = settings.league_path().ok_or_else(|| anyhow!("League install folder not found"))?;
    create_in(&league_dir, &backups_dir(), label, false)
}

pub fn restore(settings: &Settings, id: &str) -> Result<LeagueBackup> {
    if winutil::find_pid_by_name(&winutil::game_exe()).is_some() {
        return Err(anyhow!("Close the League game before restoring settings."));
    }
    let league_dir = settings.league_path().ok_or_else(|| anyhow!("League install folder not found"))?;
    let meta = restore_in(&league_dir, &backups_dir(), id)?;
    log(format!("[league-cfg] restored backup {} ({})", meta.id, meta.label));
    Ok(meta)
}

pub fn delete(id: &str) -> Result<()> {
    delete_in(&backups_dir(), id)
}

/// Snapshot League's Config folder automatically when settings changed since the last backup.
pub fn auto_backup(settings: &Settings) {
    if !settings.auto_backup_league {
        return;
    }
    let Some(league_dir) = settings.league_path() else {
        return;
    };
    let config_dir = league_dir.join("Config");
    let base_dir = backups_dir();
    if !config_dir.is_dir() || same_as_latest(&config_dir, &base_dir) {
        return;
    }
    match create_in(&league_dir, &base_dir, "Auto before game", true) {
        Ok(b) => log(format!("[league-cfg] backed up {} ({} files)", b.id, b.files.len())),
        Err(e) => log(format!("[league-cfg] auto-backup failed: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_dedups_and_restores_configs() {
        let tmp = std::env::temp_dir().join(format!("rewatch_cfg_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let league = tmp.join("League");
        let cfg = league.join("Config");
        let store = tmp.join("Backups");
        fs::create_dir_all(&cfg).unwrap();
        fs::write(cfg.join("PersistedSettings.json"), r#"{"a":1}"#).unwrap();
        fs::write(cfg.join("input.ini"), "[GameEvents]\nevtCastSpell1=[q]").unwrap();

        let b1 = create_in(&league, &store, "Main binds", false).unwrap();
        assert_eq!(b1.files, vec!["PersistedSettings.json", "input.ini"]);
        assert!(same_as_latest(&cfg, &store));

        // Modifying a file invalidates dedup and restore brings the original back.
        fs::write(cfg.join("input.ini"), "[GameEvents]\nevtCastSpell1=[a]").unwrap();
        assert!(!same_as_latest(&cfg, &store));

        restore_in(&league, &store, &b1.id).unwrap();
        assert_eq!(
            fs::read_to_string(cfg.join("input.ini")).unwrap(),
            "[GameEvents]\nevtCastSpell1=[q]"
        );
        // Safety snapshot ("Before restore") + original backup should both exist.
        assert_eq!(list_in(&store).len(), 2);

        delete_in(&store, &b1.id).unwrap();
        assert_eq!(list_in(&store).len(), 1);
        let _ = fs::remove_dir_all(&tmp);
    }
}
