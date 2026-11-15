//! The interface the window shows: the one built into the program, or a newer one the
//! updater fetched.
//!
//! A version whose native part is the same as this app's differs only in its interface,
//! which comes as one file holding every file of the page (`pack` makes it from a built
//! program). Once its signature is checked it is kept in %APPDATA%\Rewatch\interface\
//! and served instead of the built-in files, and the window reloads to show it. The
//! program, and any recording, carry on throughout. It is served again at the next
//! start, unless an installer has replaced the program since.

use crate::settings::{app_dir, log};
use crate::update;
use anyhow::{anyhow, bail, Result};
use base64::Engine;
use serde::Deserialize;
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, PoisonError, RwLock};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};

/// One version's interface: its files by path, such as "/index.html".
struct Bundle {
    version: String,
    files: HashMap<String, Vec<u8>>,
}

/// The newest interface taken in while the app runs, and the one the window's page was
/// loaded from (none: the built-in one). A page loaded before the newest came still asks
/// for its own files. One that came in between and was never shown is let go.
struct Taken {
    newest: Option<Arc<Bundle>>,
    shown: Option<Arc<Bundle>>,
}

impl Taken {
    fn take(&mut self, bundle: Bundle) {
        self.newest = Some(Arc::new(bundle));
    }

    /// The page loads again, and gets the newest.
    fn page_loading(&mut self) {
        self.shown = self.newest.clone();
    }

    /// A file of the newest interface, else of the one the page was loaded from.
    fn file(&self, path: &str) -> Option<&Vec<u8>> {
        [&self.newest, &self.shown].into_iter().flatten().find_map(|b| b.files.get(path))
    }
}

static TAKEN: RwLock<Taken> = RwLock::new(Taken { newest: None, shown: None });
/// A newer interface is in place, and the window has not loaded its page since.
static RELOAD: AtomicBool = AtomicBool::new(false);

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// The file an interface travels in.
#[derive(Deserialize)]
struct Packed {
    version: String,
    /// The native part it was built with (`update::native_id`).
    native: String,
    /// Each file, base64.
    files: BTreeMap<String, String>,
}

fn pack_files(files: &BTreeMap<String, Vec<u8>>, version: &str, native: &str) -> Vec<u8> {
    let files: BTreeMap<&str, String> = files.iter().map(|(path, data)| (path.as_str(), B64.encode(data))).collect();
    serde_json::to_vec(&serde_json::json!({ "version": version, "native": native, "files": files })).unwrap_or_default()
}

/// A program's built-in interface as one file (`rewatch --ui-bundle`).
pub fn pack(assets: &dyn tauri::Assets<tauri::Wry>, version: &str, native: &str) -> Result<Vec<u8>> {
    let mut files = BTreeMap::new();
    for (path, _) in assets.iter() {
        // `iter` gives each file as it is stored (compressed), `get` the file itself.
        let data = assets.get(&AssetKey::from(path.as_ref())).ok_or_else(|| anyhow!("{path} could not be read"))?;
        files.insert(path.to_string(), data.into_owned());
    }
    if !files.contains_key("/index.html") {
        bail!("the program has no index.html built in");
    }
    Ok(pack_files(&files, version, native))
}

impl Bundle {
    /// Read a packed interface, if it fits a program whose native part is `native` and
    /// is newer than the interface `built` into that program.
    fn read(data: &[u8], native: Option<&str>, built: &str) -> Result<Bundle> {
        let packed: Packed = serde_json::from_slice(data).map_err(|e| anyhow!("the interface could not be read: {e}"))?;
        if native != Some(packed.native.as_str()) {
            bail!("the interface was made for another version of the program");
        }
        if !update::newer(&packed.version, built) {
            bail!("the interface ({}) is not newer than the one built in ({built})", packed.version);
        }
        let files = packed
            .files
            .into_iter()
            .map(|(path, text)| -> Result<(String, Vec<u8>)> { Ok((path, B64.decode(text)?)) })
            .collect::<Result<HashMap<_, _>>>()?;
        if !files.contains_key("/index.html") {
            bail!("the interface has no index.html");
        }
        Ok(Bundle { version: packed.version, files })
    }
}

fn dir() -> PathBuf {
    app_dir().join("interface")
}

/// Keep a fetched interface for the next start. Each file is written beside the old one
/// and then swapped in, so a crash never leaves half a file. (A crash between the two
/// leaves a pair whose signature does not match, which the next start throws away.)
fn save(data: &[u8], signature: &str) -> Result<()> {
    let dir = dir();
    std::fs::create_dir_all(&dir)?;
    for (name, bytes) in [("bundle.json", data), ("bundle.json.sig", signature.as_bytes())] {
        let part = dir.join(format!("{name}.part"));
        std::fs::write(&part, bytes)?;
        std::fs::rename(&part, dir.join(name))?;
    }
    Ok(())
}

fn take(bundle: Bundle) {
    TAKEN.write().unwrap_or_else(PoisonError::into_inner).take(bundle);
}

/// At start-up: serve the interface fetched before, if it still fits this program.
/// Once an installer has replaced the program it no longer does, and it is removed.
pub fn load_saved() {
    // A build without a fingerprint (made by hand, not by release.mjs) leaves the folder
    // alone: it is shared with the installed app.
    let Some(native) = update::native_id() else { return };
    let dir = dir();
    let Ok(data) = std::fs::read(dir.join("bundle.json")) else { return };
    let checked = std::fs::read_to_string(dir.join("bundle.json.sig"))
        .map_err(anyhow::Error::from)
        .and_then(|signature| update::verify(&data, &signature, update::PUBKEY))
        .and_then(|()| Bundle::read(&data, Some(native), update::built()));
    match checked {
        Ok(bundle) => {
            log(format!("[update] showing the interface of version {}", bundle.version));
            take(bundle);
        }
        Err(e) => {
            log(format!("[update] the interface fetched before is no longer used: {e}"));
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

fn open(data: &[u8], version: &str) -> Result<Bundle> {
    let bundle = Bundle::read(data, update::native_id(), update::built())?;
    if bundle.version != version {
        bail!("the interface is version {}, not {version}", bundle.version);
    }
    Ok(bundle)
}

/// Put a fetched interface in place: kept for the next start and served from now on.
/// The window shows it when it next loads its page.
pub fn install(data: &[u8], signature: &str, version: &str) -> Result<()> {
    update::verify(data, signature, update::PUBKEY)?;
    let bundle = open(data, version)?;
    save(data, signature)?;
    take(bundle);
    RELOAD.store(true, Ordering::SeqCst);
    log(format!("[update] the interface of version {version} is in place"));
    Ok(())
}

/// What a fetched interface holds, without putting it in place (`--update-check`).
pub fn inspect(data: &[u8], version: &str) -> Result<String> {
    let bundle = open(data, version)?;
    Ok(format!("{} files, {} bytes", bundle.files.len(), bundle.files.values().map(Vec::len).sum::<usize>()))
}

/// The version of the interface being served, when it is a fetched one.
pub fn active_version() -> Option<String> {
    TAKEN.read().unwrap_or_else(PoisonError::into_inner).newest.as_ref().map(|b| b.version.clone())
}

/// A newer interface is in place and the window still shows the one before.
pub fn needs_reload() -> bool {
    RELOAD.load(Ordering::SeqCst)
}

/// The window started loading its page, which gets the newest interface.
pub fn page_loading() {
    TAKEN.write().unwrap_or_else(PoisonError::into_inner).page_loading();
    RELOAD.store(false, Ordering::SeqCst);
}

/// Serves the window's page: from the newest interface taken in, then the one the page
/// was loaded from, then the one built in.
struct Assets(Box<dyn tauri::Assets<tauri::Wry>>);

impl tauri::Assets<tauri::Wry> for Assets {
    fn setup(&self, app: &tauri::App) {
        self.0.setup(app)
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        // Apart from index.html (always the newest), a version's files are named after
        // their contents, so a page loaded earlier still gets its own.
        let found = TAKEN.read().unwrap_or_else(PoisonError::into_inner).file(key.as_ref()).cloned();
        match found {
            Some(file) => Some(Cow::Owned(file)),
            None => self.0.get(key),
        }
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.0.iter()
    }

    // The window has no content security policy (tauri.conf.json), so these go unused.
    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.0.csp_hashes(html_path)
    }
}

/// Stands in for a moment while the built-in files change hands.
struct Nothing;

impl tauri::Assets<tauri::Wry> for Nothing {
    fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

/// Have the window's page served through here, so a fetched interface can take the
/// built-in one's place.
pub fn serve(context: &mut tauri::Context) {
    let built_in = context.set_assets(Box::new(Nothing));
    context.set_assets(Box::new(Assets(built_in)));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(index: &str) -> BTreeMap<String, Vec<u8>> {
        BTreeMap::from([("/index.html".to_string(), index.as_bytes().to_vec()), ("/assets/a-1.js".to_string(), vec![0, 159, 146, 150])])
    }

    #[test]
    fn an_interface_survives_the_trip() {
        let data = pack_files(&files("<p>new</p>"), "0.7.1", "n1");
        let bundle = Bundle::read(&data, Some("n1"), "0.7.0").unwrap();
        assert_eq!(bundle.version, "0.7.1");
        assert_eq!(bundle.files.len(), 2);
        assert_eq!(bundle.files["/index.html"], b"<p>new</p>");
        assert_eq!(bundle.files["/assets/a-1.js"], [0, 159, 146, 150]);
    }

    #[test]
    fn an_interface_that_does_not_fit_is_refused() {
        let data = pack_files(&files("x"), "0.7.1", "n1");
        // Made for another native part, or this build has none.
        assert!(Bundle::read(&data, Some("n2"), "0.7.0").is_err());
        assert!(Bundle::read(&data, None, "0.7.0").is_err());
        // Not newer than what is built in: the installer brought this or a later one.
        assert!(Bundle::read(&data, Some("n1"), "0.7.1").is_err());
        assert!(Bundle::read(&data, Some("n1"), "0.8.0").is_err());
        // No page, or not an interface at all.
        let mut no_page = files("x");
        no_page.remove("/index.html");
        assert!(Bundle::read(&pack_files(&no_page, "0.7.1", "n1"), Some("n1"), "0.7.0").is_err());
        assert!(Bundle::read(b"MZ\x90\x00", Some("n1"), "0.7.0").is_err());
    }

    #[test]
    fn a_page_keeps_its_own_files_while_newer_interfaces_come() {
        let bundle = |version: &str, file: &str| Bundle {
            version: version.into(),
            files: HashMap::from([("/index.html".to_string(), version.as_bytes().to_vec()), (file.to_string(), version.as_bytes().to_vec())]),
        };
        let mut taken = Taken { newest: None, shown: None };
        // Nothing taken in: the built-in files serve.
        assert!(taken.file("/index.html").is_none());
        taken.take(bundle("0.7.1", "/assets/a-1.js"));
        taken.page_loading();
        // Two newer ones come while the window keeps its page.
        taken.take(bundle("0.7.2", "/assets/a-2.js"));
        taken.take(bundle("0.7.3", "/assets/a-3.js"));
        assert_eq!(taken.file("/index.html").unwrap(), b"0.7.3");
        assert_eq!(taken.file("/assets/a-3.js").unwrap(), b"0.7.3");
        // The page still gets its own files. The one in between was never shown.
        assert_eq!(taken.file("/assets/a-1.js").unwrap(), b"0.7.1");
        assert!(taken.file("/assets/a-2.js").is_none());
        // Reloaded, it shows the newest, and its old files go.
        taken.page_loading();
        assert!(taken.file("/assets/a-1.js").is_none());
        assert_eq!(taken.file("/assets/a-3.js").unwrap(), b"0.7.3");
    }
}
