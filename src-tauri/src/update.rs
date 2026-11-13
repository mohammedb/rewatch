//! Keeping the app up to date without a new installer being passed around by hand.
//!
//! A small file on the web says which version is the newest and where its installer
//! is. The installer is only run if it carries a signature made with this app's own
//! signing key, so a tampered download is refused. Nothing is installed while a game
//! is running or being recorded.

use crate::settings::log;
use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Where the newest version is announced. `REWATCH_UPDATE_URL` overrides it for tests.
const ENDPOINT: &str = "https://rewatch.ggwp.no/latest.json";
/// Public half of the signing key (the private half never leaves the build PC).
const PUBKEY: &str = include_str!("../updater.pub");
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    pub notes: String,
    pub url: String,
    #[serde(skip)]
    pub signature: String,
}

pub fn current() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn parts(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.trim().trim_start_matches('v').split('.').map(|p| p.parse::<u64>().ok());
    Some((it.next()??, it.next()??, it.next().unwrap_or(Some(0))?))
}

/// Whether version `a` is newer than version `b`.
pub fn newer(a: &str, b: &str) -> bool {
    matches!((parts(a), parts(b)), (Some(x), Some(y)) if x > y)
}

fn agent(secs: u64) -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(secs))).build().into()
}

/// Pick this platform's release out of the announcement file.
pub fn parse_release(doc: &Value) -> Option<Release> {
    let text = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let platform = doc.pointer("/platforms/windows-x86_64")?;
    let release = Release {
        version: text(doc, "version"),
        notes: text(doc, "notes"),
        url: text(platform, "url"),
        signature: text(platform, "signature"),
    };
    (parts(&release.version).is_some() && release.url.starts_with("https://") && !release.signature.is_empty()).then_some(release)
}

/// The newest release, if it is newer than this app.
pub fn check() -> Result<Option<Release>> {
    let url = std::env::var("REWATCH_UPDATE_URL").unwrap_or_else(|_| ENDPOINT.to_string());
    let doc: Value = agent(20).get(&url).call().map_err(|e| anyhow!("could not ask for the newest version: {e}"))?.body_mut().read_json()?;
    let release = parse_release(&doc).ok_or_else(|| anyhow!("the version announcement could not be read"))?;
    Ok(newer(&release.version, current()).then_some(release))
}

/// Check that `data` was signed with the key whose public half is `pubkey`. Both the
/// key and the signature are in the form Tauri's signing tool writes.
pub fn verify(data: &[u8], signature: &str, pubkey: &str) -> Result<()> {
    use base64::Engine;
    let unwrap = |s: &str| -> Result<String> {
        Ok(String::from_utf8(base64::engine::general_purpose::STANDARD.decode(s.trim())?)?)
    };
    let key = minisign_verify::PublicKey::decode(&unwrap(pubkey)?).map_err(|e| anyhow!("bad signing key: {e}"))?;
    let sig = minisign_verify::Signature::decode(&unwrap(signature)?).map_err(|e| anyhow!("bad signature: {e}"))?;
    key.verify(data, &sig, true).map_err(|_| anyhow!("the download's signature does not match"))
}

/// Download the installer and check its signature. Returns where it was put.
pub fn download(release: &Release) -> Result<PathBuf> {
    let mut resp = agent(600).get(&release.url).call().map_err(|e| anyhow!("download failed: {e}"))?;
    let data = resp.body_mut().with_config().limit(400 * 1024 * 1024).read_to_vec()?;
    verify(&data, &release.signature, PUBKEY)?;
    let dir = std::env::temp_dir().join("rewatch-update");
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("Rewatch_{}_setup.exe", release.version.replace(|c: char| !c.is_ascii_alphanumeric() && c != '.', "")));
    std::fs::write(&file, &data)?;
    Ok(file)
}

/// Start the installer. It replaces the program files and starts the app again, so
/// the caller must exit right after this returns. `minimized` brings the app back
/// hidden in the tray.
pub fn install(installer: &Path, minimized: bool) -> Result<()> {
    let mut cmd = std::process::Command::new(installer);
    // /P: no questions asked, just a progress window. /R: start the app afterwards.
    cmd.args(["/P", "/R", "/UPDATE"]);
    if minimized {
        cmd.args(["/ARGS", "--minimized"]);
    }
    // Helper processes are tied to this app so they end with it; the installer must
    // outlive it.
    cmd.creation_flags(CREATE_BREAKAWAY_FROM_JOB);
    cmd.spawn().map_err(|e| anyhow!("could not start the installer: {e}"))?;
    log(format!("[update] installer started: {}", installer.display()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn versions_are_compared_by_number() {
        assert!(newer("0.2.0", "0.1.9"));
        assert!(newer("0.10.0", "0.9.5"));
        assert!(newer("1.0", "0.9.9"));
        assert!(!newer("0.2.0", "0.2.0"));
        assert!(!newer("0.1.0", "0.2.0"));
        assert!(!newer("nonsense", "0.2.0"));
    }

    #[test]
    fn the_announcement_is_read() {
        let doc = json!({ "version": "0.3.1", "notes": "Fixes", "platforms": { "windows-x86_64": { "url": "https://example.test/a.exe", "signature": "abc" } } });
        let r = parse_release(&doc).unwrap();
        assert_eq!((r.version.as_str(), r.url.as_str(), r.notes.as_str()), ("0.3.1", "https://example.test/a.exe", "Fixes"));
        // Not over plain http, and not without a signature.
        assert!(parse_release(&json!({ "version": "0.3.1", "platforms": { "windows-x86_64": { "url": "http://example.test/a.exe", "signature": "abc" } } })).is_none());
        assert!(parse_release(&json!({ "version": "0.3.1", "platforms": { "windows-x86_64": { "url": "https://example.test/a.exe" } } })).is_none());
        assert!(parse_release(&json!({ "version": "0.3.1" })).is_none());
    }

    #[test]
    fn a_wrong_signature_is_refused() {
        assert!(verify(b"data", "not base64 !!", PUBKEY).is_err());
        assert!(verify(b"data", "aGVsbG8=", PUBKEY).is_err());
    }
}
