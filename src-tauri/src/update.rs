//! Keeping the app up to date without a new installer being passed around by hand.
//!
//! A small file on the web says which version is the newest and where to get it.
//! Whatever is fetched is only used if it carries a signature made with this app's own
//! signing key, so a tampered download is refused. Nothing is fetched or installed
//! while a game is running or being recorded.
//!
//! A version has two parts. The native part (everything in src-tauri: the recorder,
//! the commands, the window) can only be replaced by its installer, which closes the
//! app and starts it again. The interface (the page the window shows) can be swapped
//! while the app runs, see `ui.rs`. Each version is announced with both: an app whose
//! native part is the same as the new version's takes the new interface alone, without
//! a restart; any other app takes the installer.

use crate::settings::log;
use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Where the newest version is announced. `REWATCH_UPDATE_URL` overrides it for tests.
const ENDPOINT: &str = "https://rewatch.ggwp.no/latest.json";
/// Public half of the signing key (the private half never leaves the build PC).
pub const PUBKEY: &str = include_str!("../updater.pub");
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    pub notes: String,
    pub url: String,
    /// Putting it in place restarts the app: its native part differs from this app's,
    /// so it takes the installer.
    pub restart: bool,
    #[serde(skip)]
    pub signature: String,
    /// Its interface on its own. Only there when this app can take it, which is when
    /// the version's native part is the same as this app's.
    #[serde(skip)]
    pub ui: Option<UiFile>,
}

/// Where a version's interface is, and the signature it must carry.
#[derive(Clone, Debug, PartialEq)]
pub struct UiFile {
    pub url: String,
    pub signature: String,
}

/// A download given up because a game started. Not a failure: it is tried again later.
#[derive(Debug)]
pub struct Stopped;

impl std::fmt::Display for Stopped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("A game started; the update waits until it is over.")
    }
}

impl std::error::Error for Stopped {}

/// The version the installer put here.
pub fn built() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// The version this app counts as: the one built in, or that of a newer interface
/// fetched since (the native part being the same, it is that version).
pub fn current() -> String {
    crate::ui::active_version().unwrap_or_else(|| built().to_string())
}

/// Fingerprint of the native part: everything in src-tauri apart from the version
/// number, worked out by scripts/release.mjs when it builds a version. Two builds with
/// the same one differ only in their interface. A build made another way has none, and
/// takes every new version through the installer.
pub fn native_id() -> Option<&'static str> {
    option_env!("REWATCH_NATIVE_ID").filter(|id| !id.is_empty())
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

/// "http://host:port" of a URL.
fn origin(url: &str) -> Option<&str> {
    let start = url.find("://")? + 3;
    Some(&url[..url[start..].find('/').map_or(url.len(), |i| start + i)])
}

/// Files are fetched over https, or from where the announcement itself came from (a
/// test copy of the site on this PC, say).
fn fetchable(url: &str, endpoint: &str) -> bool {
    url.starts_with("https://")
        || matches!((origin(url), origin(endpoint)), (Some(a), Some(b)) if a == b && url[a.len()..].starts_with('/'))
}

/// Pick this platform's release out of the announcement file. `native` is this app's
/// native part, which decides whether the interface alone will do.
pub fn parse_release(doc: &Value, native: Option<&str>, endpoint: &str) -> Option<Release> {
    let text = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let platform = doc.pointer("/platforms/windows-x86_64")?;
    let ui = doc
        .get("ui")
        .filter(|ui| native.is_some_and(|n| n == text(ui, "native")))
        .map(|ui| UiFile { url: text(ui, "url"), signature: text(ui, "signature") })
        .filter(|ui| fetchable(&ui.url, endpoint) && !ui.signature.is_empty());
    let release = Release {
        version: text(doc, "version"),
        notes: text(doc, "notes"),
        url: text(platform, "url"),
        restart: ui.is_none(),
        signature: text(platform, "signature"),
        ui,
    };
    (parts(&release.version).is_some() && fetchable(&release.url, endpoint) && !release.signature.is_empty()).then_some(release)
}

/// The newest release, if it is newer than this app.
pub fn check() -> Result<Option<Release>> {
    let url = std::env::var("REWATCH_UPDATE_URL").unwrap_or_else(|_| ENDPOINT.to_string());
    let doc: Value = agent(20).get(&url).call().map_err(|e| anyhow!("could not ask for the newest version: {e}"))?.body_mut().read_json()?;
    let release = parse_release(&doc, native_id(), &url).ok_or_else(|| anyhow!("the version announcement could not be read"))?;
    Ok(newer(&release.version, &current()).then_some(release))
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

/// Fetch a file and check its signature. `stop` is asked about once a second, and a
/// yes gives the download up.
fn fetch(url: &str, signature: &str, limit: u64, stop: &dyn Fn() -> bool) -> Result<Vec<u8>> {
    let mut resp = agent(600).get(url).call().map_err(|e| anyhow!("download failed: {e}"))?;
    let mut reader = resp.body_mut().with_config().limit(limit).reader();
    let (mut data, mut piece) = (Vec::new(), vec![0u8; 256 * 1024]);
    let mut asked = Instant::now();
    loop {
        if asked.elapsed() > Duration::from_secs(1) {
            asked = Instant::now();
            if stop() {
                return Err(Stopped.into());
            }
        }
        let n = reader.read(&mut piece).map_err(|e| anyhow!("download failed: {e}"))?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&piece[..n]);
    }
    verify(&data, signature, PUBKEY)?;
    Ok(data)
}

fn installer_dir() -> PathBuf {
    std::env::temp_dir().join("rewatch-update")
}

/// Remove installers fetched before. One that is still running stays until next time.
pub fn clear_installers() {
    if let Ok(list) = std::fs::read_dir(installer_dir()) {
        for file in list.flatten() {
            let _ = std::fs::remove_file(file.path());
        }
    }
}

/// Download the installer and check its signature. Returns where it was put.
pub fn download(release: &Release, stop: &dyn Fn() -> bool) -> Result<PathBuf> {
    let data = fetch(&release.url, &release.signature, 400 * 1024 * 1024, stop)?;
    // Only the newest is kept.
    clear_installers();
    let dir = installer_dir();
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("Rewatch_{}_setup.exe", release.version.replace(|c: char| !c.is_ascii_alphanumeric() && c != '.', "")));
    std::fs::write(&file, &data)?;
    Ok(file)
}

/// Download the version's interface on its own and check its signature.
pub fn download_ui(release: &Release, stop: &dyn Fn() -> bool) -> Result<Vec<u8>> {
    let ui = release.ui.as_ref().ok_or_else(|| anyhow!("version {} has no interface this app can take", release.version))?;
    fetch(&ui.url, &ui.signature, 64 * 1024 * 1024, stop)
}

/// Start the installer, once its signature is checked again (it may have waited on
/// disk for a while). It replaces the program files and starts the app again; the app
/// is closed by the installer. `quietly`: nothing shows at all and the app comes back
/// hidden in the tray, for when nobody is looking. Otherwise a progress bar, and the
/// app comes back with its window.
pub fn install(installer: &Path, signature: &str, quietly: bool) -> Result<()> {
    let data = std::fs::read(installer).map_err(|e| anyhow!("the downloaded installer is gone: {e}"))?;
    verify(&data, signature, PUBKEY)?;
    let mut cmd = std::process::Command::new(installer);
    // /S: silent, /P: just a progress bar; neither asks anything. /R: start the app afterwards.
    cmd.args([if quietly { "/S" } else { "/P" }, "/R", "/UPDATE"]);
    if quietly {
        cmd.args(["/ARGS", "--minimized"]);
    }
    // Helper processes are tied to this app so they end with it; the installer must
    // outlive it.
    cmd.creation_flags(CREATE_BREAKAWAY_FROM_JOB);
    cmd.spawn().map_err(|e| anyhow!("could not start the installer: {e}"))?;
    log(format!("[update] installer started{}: {}", if quietly { " quietly" } else { "" }, installer.display()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SITE: &str = "https://rewatch.ggwp.no/latest.json";

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
        let r = parse_release(&doc, None, SITE).unwrap();
        assert_eq!((r.version.as_str(), r.url.as_str(), r.notes.as_str()), ("0.3.1", "https://example.test/a.exe", "Fixes"));
        assert!(r.restart && r.ui.is_none());
        // Not over plain http, and not without a signature.
        assert!(parse_release(&json!({ "version": "0.3.1", "platforms": { "windows-x86_64": { "url": "http://example.test/a.exe", "signature": "abc" } } }), None, SITE).is_none());
        assert!(parse_release(&json!({ "version": "0.3.1", "platforms": { "windows-x86_64": { "url": "https://example.test/a.exe" } } }), None, SITE).is_none());
        assert!(parse_release(&json!({ "version": "0.3.1" }), None, SITE).is_none());
    }

    #[test]
    fn the_interface_alone_only_for_the_same_native_part() {
        let doc = json!({
            "version": "0.7.1",
            "platforms": { "windows-x86_64": { "url": "https://example.test/a.exe", "signature": "abc" } },
            "ui": { "native": "n1", "url": "https://example.test/ui.json", "signature": "def" },
        });
        let same = parse_release(&doc, Some("n1"), SITE).unwrap();
        assert!(!same.restart);
        assert_eq!(same.ui, Some(UiFile { url: "https://example.test/ui.json".into(), signature: "def".into() }));
        // Another native part, or a build without a fingerprint: the installer.
        for native in [Some("n2"), None] {
            let other = parse_release(&doc, native, SITE).unwrap();
            assert!(other.restart && other.ui.is_none());
        }
        // An announcement without the interface is read as before.
        let mut plain = doc.clone();
        plain.as_object_mut().unwrap().remove("ui");
        assert!(parse_release(&plain, Some("n1"), SITE).unwrap().restart);
        // An interface without a signature, or over plain http, is not taken.
        let mut unsigned = doc.clone();
        unsigned["ui"]["signature"] = json!("");
        assert!(parse_release(&unsigned, Some("n1"), SITE).unwrap().restart);
        let mut http = doc.clone();
        http["ui"]["url"] = json!("http://example.test/ui.json");
        assert!(parse_release(&http, Some("n1"), SITE).unwrap().restart);
    }

    #[test]
    fn files_come_over_https_or_from_where_the_announcement_came_from() {
        let local = "http://127.0.0.1:8787/latest.json";
        assert!(fetchable("https://example.test/a.exe", SITE));
        assert!(fetchable("http://127.0.0.1:8787/download/a.exe", local));
        assert!(!fetchable("http://127.0.0.1:8787/download/a.exe", SITE));
        assert!(!fetchable("http://127.0.0.1:9999/download/a.exe", local));
        assert!(!fetchable("http://127.0.0.1:8787.evil.test/a.exe", local));
        assert!(!fetchable("http://127.0.0.1:8787", local));
        assert!(!fetchable("ftp://example.test/a.exe", SITE));
    }

    #[test]
    fn a_wrong_signature_is_refused() {
        assert!(verify(b"data", "not base64 !!", PUBKEY).is_err());
        assert!(verify(b"data", "aGVsbG8=", PUBKEY).is_err());
    }
}
