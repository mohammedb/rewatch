//! Rewatch: personal League of Legends recorder and review tool.

mod audio;
mod coach;
mod copies;
mod highlights;
mod insight;
mod keys;
mod league_cfg;
mod library;
mod liveclient;
mod session;
mod settings;
mod team;
mod titles;
mod pov;
mod riot;
mod ui;
mod update;
mod video;
mod voice;
mod winutil;

use serde::Serialize;
use serde_json::{json, Value};
use session::Session;
use settings::{log, Settings};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// "idle" | "starting" | "recording" | "finalizing"
    state: String,
    mode: Option<String>,
    started_epoch_ms: Option<i64>,
    queue_name: Option<String>,
    game_running: bool,
    discord_running: bool,
    bookmarks: usize,
    last_error: Option<String>,
    last_match_id: Option<String>,
}

pub struct AppState {
    settings: Mutex<Settings>,
    session: Mutex<Option<Session>>,
    status: Mutex<Status>,
    /// Game process that must not be (re)recorded: its queue is switched off, or the
    /// user stopped its recording by hand.
    skip_pid: Mutex<Option<u32>>,
    /// The connection to teammates. Only started once there is someone to talk to.
    pov: Mutex<Option<std::sync::Arc<pov::Engine>>>,
    share_error: Mutex<Option<String>>,
    update: Mutex<UpdateState>,
    /// Held while a newer version is being fetched, so it is fetched once.
    fetching: Mutex<()>,
    /// When the window was last closed (to the tray).
    closed_at: Mutex<Option<std::time::Instant>>,
}

/// What is known about a newer version of the app. `current`, `ready` and `reload` are
/// filled in by `update_snapshot`.
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct UpdateState {
    current: String,
    /// A newer version, not in place yet.
    available: Option<update::Release>,
    checked: bool,
    /// It is being fetched.
    downloading: bool,
    /// Its installer is here and checked, waiting for a quiet moment or a click.
    ready: bool,
    installing: bool,
    /// The version whose interface was put in place while the app ran.
    applied: Option<update::Release>,
    /// That interface is in place, but the window still shows the one before.
    reload: bool,
    error: Option<String>,
    /// The installer behind `ready`.
    #[serde(skip)]
    installer: Option<std::path::PathBuf>,
    /// Fetching or installing failed: not tried by itself again until the next check.
    #[serde(skip)]
    retry_later: bool,
}

const NOT_NOW: &str = "Not while a game is running or being recorded. It will update afterwards.";

/// A Windows notification, if the setting allows. Never shown by this app's own
/// window, so nothing of ours is drawn over the game.
fn notify(app: &AppHandle, text: &str) {
    if !app.state::<AppState>().settings.lock().unwrap().notify {
        return;
    }
    toast(&app.config().identifier, text);
}

fn toast(app_id: &str, text: &str) {
    use tauri_winrt_notification::{Duration as Show, Toast};
    let show = |id: &str| Toast::new(id).title("Rewatch").text1(text).sound(None).duration(Show::Short).show();
    // The app's own identity only exists once it has been installed; a development
    // build borrows PowerShell's.
    if show(app_id).is_err() {
        let _ = show(Toast::POWERSHELL_APP_ID);
    }
}

fn set_tray_tip(app: &AppHandle, text: &str) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(text));
    }
}

fn window_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main").map(|w| w.is_visible().unwrap_or(true)).unwrap_or(false)
}

/// Whether nothing is being played or recorded right now.
fn quiet(app: &AppHandle) -> bool {
    let st = app.state::<AppState>();
    let idle = st.status.lock().unwrap().state == "idle";
    idle && winutil::find_pid_by_name(&winutil::game_exe()).is_none()
}

/// The update state as the window sees it.
fn update_snapshot(app: &AppHandle) -> UpdateState {
    let mut u = app.state::<AppState>().update.lock().unwrap().clone();
    u.current = update::current();
    u.ready = u.installer.is_some();
    u.reload = ui::needs_reload();
    u
}

fn check_for_update(app: &AppHandle) {
    let found = update::check();
    let st = app.state::<AppState>();
    let mut u = st.update.lock().unwrap();
    u.checked = true;
    match found {
        Ok(release) => {
            // The same version as before keeps what is known about it (its installer,
            // say); another one starts afresh.
            if u.available.as_ref().map(|a| &a.version) != release.as_ref().map(|r| &r.version) {
                if let Some(r) = &release {
                    log(format!("[update] version {} is available (this is {})", r.version, update::current()));
                }
                u.available = release;
                u.installer = None;
            }
            u.error = None;
            u.retry_later = false;
        }
        Err(e) => u.error = Some(e.to_string()),
    }
    drop(u);
    let _ = app.emit("update", ());
}

enum Fetched {
    /// The new interface is in place.
    Interface,
    /// The installer, and whether that is because the interface could not be used.
    Installer(std::path::PathBuf, bool),
}

fn fetch_release(release: &update::Release, stop: &dyn Fn() -> bool) -> anyhow::Result<Fetched> {
    let mut fell_back = false;
    if let Some(file) = &release.ui {
        match update::download_ui(release, stop).and_then(|data| ui::install(&data, &file.signature, &release.version)) {
            Ok(()) => return Ok(Fetched::Interface),
            Err(e) if e.is::<update::Stopped>() => return Err(e),
            Err(e) => {
                log(format!("[update] the new interface could not be used, so the installer is fetched instead: {e}"));
                fell_back = true;
            }
        }
    }
    Ok(Fetched::Installer(update::download(release, stop)?, fell_back))
}

/// Fetch the newer version the last check found, while nothing is being played or
/// recorded. When it differs from this app only in its interface, that is put in place
/// at once and shows when the window reloads. Otherwise its installer is kept for a
/// quiet moment.
fn fetch_update(app: &AppHandle) -> Result<(), String> {
    let st = app.state::<AppState>();
    // One at a time: a second caller waits for the first, then finds the work done.
    let _one = st.fetching.lock().unwrap();
    if !quiet(app) {
        return Err(update::Stopped.to_string());
    }
    let release = {
        let mut u = st.update.lock().unwrap();
        match u.available.clone() {
            Some(r) if u.installer.is_none() && !u.installing => {
                u.downloading = true;
                r
            }
            _ => return Ok(()),
        }
    };
    let _ = app.emit("update", ());
    let result = fetch_release(&release, &|| !quiet(app));
    let mut u = st.update.lock().unwrap();
    u.downloading = false;
    // A check may have found a later version in the meantime.
    let still = u.available.as_ref().is_some_and(|a| a.version == release.version);
    let out = match result {
        Ok(Fetched::Interface) => {
            if still {
                u.available = None;
            }
            u.applied = Some(release);
            u.error = None;
            u.retry_later = false;
            Ok(())
        }
        Ok(Fetched::Installer(file, fell_back)) => {
            if let (true, Some(a)) = (still, u.available.as_mut()) {
                if fell_back {
                    a.restart = true;
                    a.ui = None;
                }
                u.installer = Some(file);
            }
            u.error = None;
            u.retry_later = false;
            Ok(())
        }
        Err(e) if e.is::<update::Stopped>() => Err(e.to_string()),
        Err(e) => {
            log(format!("[update] {e}"));
            u.error = Some(e.to_string());
            u.retry_later = true;
            Err(e.to_string())
        }
    };
    drop(u);
    let _ = app.emit("update", ());
    reload_if_hidden(app);
    out
}

/// Run the installer fetched for the newer version. It closes this app, replaces it and
/// starts it again: hidden in the tray when `quietly`, otherwise with its window.
fn run_installer(app: &AppHandle, quietly: bool) -> Result<(), String> {
    if !quiet(app) {
        return Err(NOT_NOW.into());
    }
    let st = app.state::<AppState>();
    let (file, signature) = {
        let mut u = st.update.lock().unwrap();
        if u.installing {
            return Ok(());
        }
        let (Some(file), Some(release)) = (u.installer.clone(), u.available.as_ref()) else {
            return Err("The new version has not been downloaded yet.".into());
        };
        let signature = release.signature.clone();
        u.installing = true;
        u.error = None;
        (file, signature)
    };
    let _ = app.emit("update", ());
    let result = update::install(&file, &signature, quietly);
    if let Err(e) = &result {
        log(format!("[update] {e}"));
        let mut u = st.update.lock().unwrap();
        u.installing = false;
        // Fetched afresh next time: the file may have been cleaned away.
        u.installer = None;
        u.error = Some(e.to_string());
        u.retry_later = true;
        drop(u);
        let _ = app.emit("update", ());
    }
    result.map_err(|e| e.to_string())
}

/// "Update now": fetch the newer version if that has not happened yet, then put it in
/// place. A new interface shows once the window's page reloads, which the page does
/// itself; anything else goes through the installer.
fn update_now(app: &AppHandle) -> Result<(), String> {
    if !quiet(app) {
        return Err(NOT_NOW.into());
    }
    fetch_update(app)?;
    let ready = app.state::<AppState>().update.lock().unwrap().installer.is_some();
    if ready { run_installer(app, false) } else { Ok(()) }
}

/// How long the window stays closed before its page may reload by itself: edits are
/// saved a moment after the last change (half a second at most), and they get to finish.
const SETTLE: Duration = Duration::from_secs(5);

/// A newer interface is in place: if the window is closed and no game is on, have its
/// page reload to show it. The page may hold off while something of its own is still
/// going on (see App.tsx); it is asked again a minute later.
fn reload_if_hidden(app: &AppHandle) {
    if !ui::needs_reload() || window_visible(app) {
        return;
    }
    let settled = app.state::<AppState>().closed_at.lock().unwrap().is_none_or(|t| t.elapsed() >= SETTLE);
    if settled && quiet(app) {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.eval("window.__rewatchReload ? window.__rewatchReload(false) : location.reload()");
        }
    }
}

fn emit_status(app: &AppHandle) {
    let st = app.state::<AppState>();
    let status = st.status.lock().unwrap().clone();
    let _ = app.emit("status", status);
}

fn allow_recordings_dir(app: &AppHandle, settings: &Settings) {
    if let Some(dir) = settings.recordings_path() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = app.asset_protocol_scope().allow_directory(&dir, true);
    }
}

/// Make the Windows start-up entry match the setting. The entry points at this
/// program with `--minimized`, so it starts hidden in the tray. Skipped in
/// development builds so a debug build never registers itself.
fn apply_autostart(app: &AppHandle, settings: &Settings) {
    if cfg!(debug_assertions) {
        return;
    }
    let auto = app.autolaunch();
    let result = if settings.start_with_windows {
        // Always rewrite it: keeps the path right if the program has moved.
        auto.enable()
    } else if auto.is_enabled().unwrap_or(false) {
        auto.disable()
    } else {
        Ok(())
    };
    if let Err(e) = result {
        log(format!("[autostart] could not update the start-up entry: {e}"));
    }
}

/// The connection to teammates, started on first need.
fn pov_engine(app: &AppHandle) -> Result<std::sync::Arc<pov::Engine>, String> {
    let st = app.state::<AppState>();
    let mut slot = st.pov.lock().unwrap();
    if let Some(engine) = slot.as_ref() {
        return Ok(engine.clone());
    }
    let settings = st.settings.lock().unwrap().clone();
    match pov::Engine::start(&pov::identity_path(), &settings) {
        Ok(engine) => {
            let engine = std::sync::Arc::new(engine);
            let handle = app.clone();
            engine.set_notifier(std::sync::Arc::new(move |event| {
                let _ = handle.emit("watch", event);
            }));
            *slot = Some(engine.clone());
            *st.share_error.lock().unwrap() = None;
            Ok(engine)
        }
        Err(e) => {
            log(format!("[pov] {e}"));
            *st.share_error.lock().unwrap() = Some(e.to_string());
            Err(e.to_string())
        }
    }
}

/// Keep the connection to teammates in line with the settings. The app goes online
/// when sharing with teammates is on (so a teammate's first connection can reach it
/// and show up for pairing) or when teammates are listed. With sharing off and no
/// teammates it stays offline.
fn apply_pov(app: &AppHandle, settings: &Settings) {
    let running = app.state::<AppState>().pov.lock().unwrap().clone();
    match running {
        Some(engine) => engine.update(settings),
        None if !settings.friends.is_empty() || settings.share_with_friends => {
            let _ = pov_engine(app);
        }
        None => {}
    }
}

fn start_session(app: &AppHandle, game_pid: Option<u32>, client: liveclient::ClientInfo) -> Result<(), String> {
    let st = app.state::<AppState>();
    {
        let mut s = st.status.lock().unwrap();
        if s.state != "idle" {
            return Err("A recording is already in progress".into());
        }
        s.state = "starting".into();
    }
    emit_status(app);
    let settings = st.settings.lock().unwrap().clone();
    let result = Session::start(&settings, game_pid, client);
    let mut started: Option<(std::path::PathBuf, Option<i64>)> = None;
    let mut status = st.status.lock().unwrap();
    let out = match result {
        Ok(session) => {
            started = Some((session.dir.clone(), session.meta.game_id));
            status.state = "recording".into();
            status.mode = Some(session.meta.mode.clone());
            status.started_epoch_ms = Some(session.meta.started_epoch_ms);
            status.queue_name = session.meta.queue_name.clone();
            status.bookmarks = 0;
            status.last_error = None;
            *st.session.lock().unwrap() = Some(session);
            let hotkey = settings.bookmark_hotkey.trim();
            if !hotkey.is_empty() && winutil::parse_hotkey(hotkey).is_none() {
                log(format!("[hotkey] '{hotkey}' is not a key Rewatch knows; bookmarks are off"));
            }
            Ok(status.queue_name.clone().unwrap_or_else(|| if game_pid.is_some() { "League game".into() } else { "your screen".into() }))
        }
        Err(e) => {
            status.state = "idle".into();
            status.last_error = Some(e.to_string());
            log(format!("[session] could not start: {e}"));
            Err(e.to_string())
        }
    };
    drop(status);
    emit_status(app);
    if let (Some((dir, game_id)), Some(_)) = (started, game_pid) {
        // Who is playing and their rank, read once while the game loads.
        let settings = settings.clone();
        std::thread::spawn(move || riot::at_game_start(&settings, &dir, game_id));
    }
    match &out {
        Ok(what) => {
            set_tray_tip(app, &format!("Rewatch: recording {what}"));
            // The one thing the player chose to work on, while it can still help.
            match library::latest_focus(&settings) {
                Some(focus) => notify(app, &format!("Recording {what}. Your focus: {focus}")),
                None => notify(app, &format!("Recording {what}")),
            }
        }
        Err(e) => notify(app, &format!("Could not start recording: {e}")),
    }
    out.map(|_| ())
}

/// Stop the running recording (if any) and produce its files.
fn finish_session(app: &AppHandle, note: Option<&str>) -> Result<Option<String>, String> {
    let st = app.state::<AppState>();
    let Some(session) = st.session.lock().unwrap().take() else {
        return Ok(None);
    };
    st.status.lock().unwrap().state = "finalizing".into();
    emit_status(app);
    let settings = st.settings.lock().unwrap().clone();
    let result = session.stop_and_finalize(&settings);
    let mut status = st.status.lock().unwrap();
    status.state = "idle".into();
    status.mode = None;
    status.started_epoch_ms = None;
    status.queue_name = None;
    let out = match result {
        Ok(id) => {
            library::enforce_quota(&settings, Some(&id));
            status.last_match_id = Some(id.clone());
            status.last_error = note.map(String::from);
            Ok(Some(id))
        }
        Err(e) => {
            status.last_error = Some(e.to_string());
            log(format!("[session] could not finish: {e}"));
            Err(e.to_string())
        }
    };
    drop(status);
    emit_status(app);
    let _ = app.emit("library-changed", ());
    set_tray_tip(app, "Rewatch");
    match &out {
        Ok(Some(id)) => {
            let doc = library::get(&settings, id).unwrap_or(Value::Null);
            let secs = doc.get("duration").and_then(|d| d.as_f64()).unwrap_or(0.0) as u64;
            let result = match doc.pointer("/game/result").and_then(|r| r.as_str()) {
                Some("Win") => ", victory",
                Some("Lose") => ", defeat",
                _ => "",
            };
            let mine = doc
                .get("titles")
                .and_then(|t| t.as_array())
                .and_then(|t| t.iter().find(|t| t.get("champion") == doc.pointer("/game/me/champion")))
                .and_then(|t| t.get("title").and_then(|x| x.as_str()))
                .map(|t| format!(". Your title: {t}"))
                .unwrap_or_default();
            let saved = format!("Recording saved: {}:{:02}{result}{mine}", secs / 60, secs % 60);
            let lost = doc.pointer("/game/result").and_then(|r| r.as_str()) == Some("Lose");
            let streak = if lost && settings.break_after_losses > 0 { library::losing_streak(&settings) } else { 0 };
            if streak > 0 && streak >= settings.break_after_losses as usize {
                // Its own setting, so it shows even with the other notifications off.
                let nudge = format!("{streak} losses in a row. Stop for today?");
                toast(&app.config().identifier, &if settings.notify { format!("{saved}. {nudge}") } else { nudge });
            } else {
                notify(app, &saved);
            }
        }
        Err(e) => notify(app, &format!("The recording could not be saved: {e}")),
        Ok(None) => {}
    }
    out
}

/// Write any panic to the log before it unwinds, so a failure leaves a trace.
fn log_panics() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log(format!("[crash] {info}"));
        default(info);
    }));
}

/// Background loop: starts a recording when a League game appears and stops it when
/// the game exits.
fn watcher(app: AppHandle) {
    let st = app.state::<AppState>();
    // The recordings folder that has been checked for interrupted recordings.
    let mut checked_root: Option<std::path::PathBuf> = None;
    let mut attempts: (u32, u32) = (0, 0); // (pid, tries)
    let mut backed_pid: Option<u32> = None;
    loop {
        std::thread::sleep(Duration::from_secs(2));
        let game_pid = winutil::find_pid_by_name(&winutil::game_exe());
        let discord = winutil::find_discord_root_pid().is_some();
        let settings = st.settings.lock().unwrap().clone();

        let (recording_pid, alive, bookmarks) = {
            let mut guard = st.session.lock().unwrap();
            match guard.as_mut() {
                Some(s) => (s.game_pid, Some(s.video_alive()), s.bookmark_count()),
                None => (None, None, 0),
            }
        };
        {
            let mut status = st.status.lock().unwrap();
            let changed = status.game_running != game_pid.is_some()
                || status.discord_running != discord
                || status.bookmarks != bookmarks;
            status.game_running = game_pid.is_some();
            status.discord_running = discord;
            status.bookmarks = bookmarks;
            drop(status);
            if changed {
                emit_status(&app);
            }
        }

        if let Some(alive) = alive {
            // A recording is running.
            let game_gone = recording_pid.map(|p| !winutil::pid_alive(p)).unwrap_or(false);
            if game_gone {
                let _ = finish_session(&app, None);
            } else if !alive {
                let _ = finish_session(&app, Some("Video capture stopped unexpectedly; the part before that was saved."));
            }
            continue;
        }

        // Nothing is recording. Finish any recording that was cut short. This runs at
        // start-up and again whenever the recordings folder is first set or changed
        // (a fresh install has no folder yet at start-up).
        if settings.recordings_path() != checked_root {
            checked_root = settings.recordings_path();
            if !session::recover_interrupted(&settings, None).is_empty() {
                let _ = app.emit("library-changed", ());
            }
        }

        // No recording: should one start?
        let Some(pid) = game_pid else {
            *st.skip_pid.lock().unwrap() = None;
            backed_pid = None;
            continue;
        };
        if backed_pid != Some(pid) {
            backed_pid = Some(pid);
            league_cfg::auto_backup(&settings);
        }
        let skipped = *st.skip_pid.lock().unwrap() == Some(pid);
        if !settings.auto_record || settings.recordings_path().is_none() || skipped {
            continue;
        }
        if attempts.0 != pid {
            attempts = (pid, 0);
        }
        if attempts.1 >= 3 {
            continue;
        }
        let client = if settings.use_client_api {
            settings.league_path().and_then(|d| liveclient::client_info(&d)).unwrap_or_default()
        } else {
            liveclient::ClientInfo::default()
        };
        if let Some((id, name)) = &client.queue {
            if !settings.queues.allows(*id) {
                log(format!("[watch] not recording: queue '{name}' is switched off"));
                *st.skip_pid.lock().unwrap() = Some(pid);
                continue;
            }
        }
        attempts.1 += 1;
        let _ = start_session(&app, Some(pid), client);
    }
}

// ---------------------------------------------------------------- commands

type CmdResult<T> = Result<T, String>;
fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(app: AppHandle, state: State<AppState>, mut settings: Settings) -> CmdResult<Settings> {
    for f in &mut settings.friends {
        f.code = f.code.trim().to_lowercase();
        f.name = f.name.trim().to_string();
    }
    settings.friends.retain(|f| !f.code.is_empty());
    settings.save().map_err(err)?;
    allow_recordings_dir(&app, &settings);
    apply_autostart(&app, &settings);
    apply_pov(&app, &settings);
    *state.settings.lock().unwrap() = settings.clone();
    let _ = app.emit("library-changed", ());
    Ok(settings)
}

#[tauri::command]
fn get_status(state: State<AppState>) -> Status {
    state.status.lock().unwrap().clone()
}

/// Facts about this PC the settings screen shows.
#[tauri::command(async)]
fn environment(state: State<AppState>) -> Value {
    let s = state.settings.lock().unwrap().clone();
    let (ffmpeg, ffprobe) = s.ffmpeg_tools();
    let version = video::run_tool(&ffmpeg, &["-version".to_string()])
        .ok()
        .and_then(|o| o.lines().next().map(String::from));
    let videos = std::env::var("USERPROFILE").map(|p| format!("{p}\\Videos\\Rewatch")).unwrap_or_default();
    let free = s
        .recordings_path()
        .or_else(|| (!videos.is_empty()).then(|| std::path::PathBuf::from(&videos)))
        .and_then(|p| winutil::free_bytes(&p));
    json!({
        "ffmpeg": ffmpeg.to_string_lossy(),
        "ffmpegVersion": version,
        "ffprobeFound": video::run_tool(&ffprobe, &["-version".to_string()]).is_ok(),
        "leagueDir": s.league_path().map(|p| p.to_string_lossy().to_string()),
        "suggestedRecordingsDir": videos,
        "freeBytes": free,
    })
}

/// Put a saved clip or export on the clipboard as a file, ready to paste into Discord.
#[tauri::command(async)]
fn copy_file(path: String) -> CmdResult<()> {
    winutil::copy_files_to_clipboard(&[std::path::PathBuf::from(path)]).map_err(err)
}

/// Save the picture of a game the app drew (a PNG, as base64) next to the recording
/// and put it on the clipboard as a file, the way clips are.
#[tauri::command(async)]
fn share_card(state: State<AppState>, id: String, png: String) -> CmdResult<String> {
    let s = state.settings.lock().unwrap().clone();
    let path = library::save_share_card(&s, &id, &png).map_err(err)?;
    winutil::copy_files_to_clipboard(std::slice::from_ref(&path)).map_err(err)?;
    Ok(path.to_string_lossy().to_string())
}

/// The player's notes on playing against each champion, by champion key.
#[tauri::command(async)]
fn matchup_notes() -> Value {
    library::matchup_notes()
}

#[tauri::command(async)]
fn set_matchup_note(champion: String, text: String) -> CmdResult<Value> {
    library::set_matchup_note(&champion, &text).map_err(err)
}

#[tauri::command(async)]
fn list_microphones() -> Vec<audio::MicInfo> {
    audio::list_microphones()
}

/// This PC's friend code and whether the connection to teammates is up.
#[tauri::command(async)]
fn share_info(state: State<AppState>) -> Value {
    let engine = state.pov.lock().unwrap().clone();
    json!({
        "code": pov::my_code(),
        "running": engine.is_some(),
        "online": engine.as_ref().map(|e| e.online()).unwrap_or(false),
        "requests": engine.map(|e| e.requests()).unwrap_or_default(),
        "error": *state.share_error.lock().unwrap(),
    })
}

/// Check a teammate's friend code.
#[tauri::command(async)]
fn friend_ping(app: AppHandle, code: String) -> CmdResult<String> {
    pov_engine(&app)?.ping(&code).map_err(err)
}

/// The player's name in League, suggested in the setup guide as the name teammates see.
/// The League client is only asked while no game is on.
#[tauri::command(async)]
fn league_name(state: State<AppState>) -> Option<String> {
    let in_game = state.status.lock().unwrap().game_running;
    let s = state.settings.lock().unwrap().clone();
    riot::league_name(&s, !in_game)
}

/// Free space on the drive a folder is on, or would be on once made.
#[tauri::command(async)]
fn disk_free(path: String) -> Option<u64> {
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    winutil::free_bytes(std::path::Path::new(path))
}

/// How loud a microphone is right now, for the setup guide's check. The first call
/// opens it, and it is closed again shortly after the calls stop.
#[tauri::command(async)]
fn mic_level(device: String) -> CmdResult<f32> {
    audio::mic_level(&device).map_err(err)
}

#[tauri::command(async)]
fn mic_check_stop() {
    audio::mic_check_stop();
}

/// Teammates' views of the same game as recording `id`: saved ones first, then
/// whatever teammates who are online can offer.
#[tauri::command(async)]
fn pov_list(app: AppHandle, state: State<AppState>, id: String) -> CmdResult<Vec<pov::Pov>> {
    let s = state.settings.lock().unwrap().clone();
    let doc = library::get(&s, &id).map_err(err)?;
    let Some(mine) = pov::card_from_match(&doc) else { return Ok(Vec::new()) };
    let dir = std::path::PathBuf::from(doc.get("dir").and_then(|d| d.as_str()).unwrap_or_default());
    if s.friends.is_empty() {
        return Ok(pov::saved_povs(&dir, &mine));
    }
    match pov_engine(&app) {
        Ok(engine) => Ok(engine.pov_list(&s, &mine, &dir)),
        Err(_) => Ok(pov::saved_povs(&dir, &mine)),
    }
}

/// How far along the saving of teammates' views for recording `id` is, by friend code.
#[tauri::command(async)]
fn pov_saving(state: State<AppState>, id: String) -> CmdResult<std::collections::HashMap<String, (u64, u64)>> {
    let s = state.settings.lock().unwrap().clone();
    let Some(engine) = state.pov.lock().unwrap().clone() else { return Ok(Default::default()) };
    let doc = library::get(&s, &id).map_err(err)?;
    let dir = std::path::PathBuf::from(doc.get("dir").and_then(|d| d.as_str()).unwrap_or_default());
    Ok(engine.saving(&dir))
}

/// What teammates wrote and drew on the same game, and when each of them spoke.
#[tauri::command(async)]
fn pov_extras(app: AppHandle, state: State<AppState>, id: String) -> CmdResult<Vec<pov::Extras>> {
    let s = state.settings.lock().unwrap().clone();
    let doc = library::get(&s, &id).map_err(err)?;
    let Some(mine) = pov::card_from_match(&doc) else { return Ok(Vec::new()) };
    let dir = std::path::PathBuf::from(doc.get("dir").and_then(|d| d.as_str()).unwrap_or_default());
    if s.friends.is_empty() {
        return Ok(pov::saved_extras(&dir, &mine));
    }
    match pov_engine(&app) {
        Ok(engine) => Ok(engine.extras(&s, &mine, &dir)),
        Err(_) => Ok(pov::saved_extras(&dir, &mine)),
    }
}

/// Hints about the deaths in a recording. With `run` they are asked for now, if the
/// user has set that up; otherwise only what is already there is returned.
#[tauri::command(async)]
fn insights(app: AppHandle, state: State<AppState>, id: String, run: bool) -> CmdResult<Value> {
    let s = state.settings.lock().unwrap().clone();
    if !run {
        return library::get(&s, &id).map(|doc| doc.get("insights").cloned().unwrap_or(Value::Null)).map_err(err);
    }
    if !quiet(&app) {
        return Err("Not while a game is running. Try again afterwards.".into());
    }
    let handle = app.clone();
    library::insights(&s, &id, &move || !quiet(&handle)).map_err(err)
}

/// The highlights of a recording. With `save`, their clips are made now.
#[tauri::command(async)]
fn highlights(app: AppHandle, state: State<AppState>, id: String, save: bool) -> CmdResult<Vec<Value>> {
    let s = state.settings.lock().unwrap().clone();
    if save && !quiet(&app) {
        return Err("Not while a game is running. Try again afterwards.".into());
    }
    let handle = app.clone();
    let res = library::highlights(&s, &id, save, &move || !quiet(&handle)).map_err(err)?;
    if save {
        let _ = app.emit("library-changed", ());
    }
    Ok(res)
}

#[tauri::command(async)]
fn build_highlight_reel(app: AppHandle, state: State<AppState>, id: String) -> CmdResult<String> {
    let s = state.settings.lock().unwrap().clone();
    if !quiet(&app) {
        return Err("Not while a game is running. Try again afterwards.".into());
    }
    let handle = app.clone();
    let path = library::build_highlight_reel(&s, &id, &move || !quiet(&handle)).map_err(err)?;
    let _ = app.emit("library-changed", ());
    Ok(path)
}

/// Fetch a game's post-game data (match details, timeline) now, instead of waiting
/// for the background job.
#[tauri::command(async)]
fn postgame_fetch(app: AppHandle, state: State<AppState>, id: String) -> CmdResult<Value> {
    let s = state.settings.lock().unwrap().clone();
    if !quiet(&app) {
        return Err("Not while a game is running. Try again afterwards.".into());
    }
    let pg = library::postgame_fetch(&s, &id).map_err(err)?;
    let _ = app.emit("library-changed", ());
    Ok(pg)
}

/// Whether Riot accepts an API key.
#[tauri::command(async)]
fn riot_check(key: String) -> Value {
    riot::check_key(&key)
}

#[tauri::command(async)]
fn library_trends(state: State<AppState>) -> Vec<Value> {
    let s = state.settings.lock().unwrap().clone();
    library::trends(&s)
}

#[tauri::command(async)]
fn list_league_backups() -> Vec<league_cfg::LeagueBackup> {
    league_cfg::list()
}

#[tauri::command(async)]
fn create_league_backup(state: State<AppState>, label: String) -> CmdResult<league_cfg::LeagueBackup> {
    let s = state.settings.lock().unwrap().clone();
    league_cfg::create(&s, &label).map_err(err)
}

#[tauri::command(async)]
fn restore_league_backup(state: State<AppState>, id: String) -> CmdResult<league_cfg::LeagueBackup> {
    let s = state.settings.lock().unwrap().clone();
    league_cfg::restore(&s, &id).map_err(err)
}

#[tauri::command(async)]
fn delete_league_backup(id: String) -> CmdResult<()> {
    league_cfg::delete(&id).map_err(err)
}

/// A review of one team fight from my view and the teammates' views given.
#[tauri::command(async)]
fn team_review(app: AppHandle, state: State<AppState>, id: String, start: f64, end: f64, views: Vec<team::View>) -> CmdResult<Value> {
    let s = state.settings.lock().unwrap().clone();
    if !quiet(&app) {
        return Err("Not while a game is running. Try again afterwards.".into());
    }
    let handle = app.clone();
    library::team_review(&s, &id, start, end, &views, &move || !quiet(&handle)).map_err(err)
}

/// The coach's written review of a recording. With `run` it is written now, if the
/// user has set that up; otherwise only what is already there is returned.
#[tauri::command(async)]
fn coach(app: AppHandle, state: State<AppState>, id: String, run: bool) -> CmdResult<Value> {
    let s = state.settings.lock().unwrap().clone();
    if !run {
        return library::get(&s, &id).map(|doc| doc.get("coach").cloned().unwrap_or(Value::Null)).map_err(err);
    }
    if !quiet(&app) {
        return Err("Not while a game is running. Try again afterwards.".into());
    }
    let handle = app.clone();
    library::coach(&s, &id, &move || !quiet(&handle)).map_err(err)
}

/// When someone was talking on this recording's microphone and Discord tracks.
#[tauri::command(async)]
fn voice(state: State<AppState>, id: String) -> CmdResult<Value> {
    let s = state.settings.lock().unwrap().clone();
    library::voice(&s, &id).map_err(err)
}

/// Watching together: tell teammates where this player is (`id` null leaves).
#[tauri::command(async)]
fn watch_set(app: AppHandle, state: State<AppState>, id: Option<String>, t: f64, playing: bool, rate: f64, control: bool) -> CmdResult<()> {
    let s = state.settings.lock().unwrap().clone();
    if id.is_none() && state.pov.lock().unwrap().is_none() {
        return Ok(());
    }
    pov_engine(&app)?.watch_set(&s, id.as_deref(), t, playing, rate, control).map_err(err)
}

/// Teammates who have a game open in their player right now.
#[tauri::command(async)]
fn watch_peers(state: State<AppState>) -> Vec<Value> {
    let s = state.settings.lock().unwrap().clone();
    let engine = state.pov.lock().unwrap().clone();
    engine.map(|e| e.watch_peers(&s)).unwrap_or_default()
}

#[tauri::command]
fn update_info(app: AppHandle) -> UpdateState {
    update_snapshot(&app)
}

#[tauri::command(async)]
fn update_check(app: AppHandle) -> UpdateState {
    check_for_update(&app);
    // With "Update by itself" on, fetch it now rather than within the minute.
    if app.state::<AppState>().settings.lock().unwrap().auto_update {
        let handle = app.clone();
        std::thread::spawn(move || {
            let _ = fetch_update(&handle);
        });
    }
    update_snapshot(&app)
}

#[tauri::command(async)]
fn update_install(app: AppHandle) -> CmdResult<UpdateState> {
    update_now(&app)?;
    Ok(update_snapshot(&app))
}

#[tauri::command(async)]
fn list_matches(state: State<AppState>) -> Vec<Value> {
    let s = state.settings.lock().unwrap().clone();
    library::list(&s)
}

#[tauri::command(async)]
fn get_match(state: State<AppState>, id: String) -> CmdResult<Value> {
    let s = state.settings.lock().unwrap().clone();
    library::get(&s, &id).map_err(err)
}

#[tauri::command(async)]
fn save_review(state: State<AppState>, id: String, review: Value) -> CmdResult<()> {
    let s = state.settings.lock().unwrap().clone();
    library::save_review(&s, &id, &review).map_err(err)
}

#[tauri::command(async)]
fn delete_match(app: AppHandle, state: State<AppState>, id: String) -> CmdResult<()> {
    let s = state.settings.lock().unwrap().clone();
    library::delete(&s, &id).map_err(err)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

/// Delete a game's video and sound and keep its stats, notes and Riot's record.
#[tauri::command(async)]
fn delete_video(app: AppHandle, state: State<AppState>, id: String) -> CmdResult<u64> {
    let s = state.settings.lock().unwrap().clone();
    let freed = library::delete_video(&s, &id).map_err(err)?;
    let _ = app.emit("library-changed", ());
    Ok(freed)
}

#[tauri::command(async)]
fn start_manual_recording(app: AppHandle) -> CmdResult<()> {
    start_session(&app, None, liveclient::ClientInfo::default())
}

#[tauri::command(async)]
fn stop_recording(app: AppHandle, state: State<AppState>) -> CmdResult<Option<String>> {
    // Stopped by hand: do not start recording the same game again.
    let pid = state.session.lock().unwrap().as_ref().and_then(|s| s.game_pid);
    if pid.is_some() {
        *state.skip_pid.lock().unwrap() = pid;
    }
    finish_session(&app, None)
}

#[tauri::command]
fn add_bookmark(app: AppHandle, state: State<AppState>) -> usize {
    let n = state.session.lock().unwrap().as_ref().map(|s| s.add_bookmark()).unwrap_or(0);
    state.status.lock().unwrap().bookmarks = n;
    emit_status(&app);
    n
}

#[tauri::command(async)]
fn export_clip(state: State<AppState>, id: String, start: f64, end: f64, tracks: Vec<String>, max_mb: Option<f64>) -> CmdResult<String> {
    let s = state.settings.lock().unwrap().clone();
    library::export_clip(&s, &id, start, end, &tracks, max_mb).map_err(err)
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
fn export_split(
    state: State<AppState>,
    id: String,
    start: f64,
    end: f64,
    views: Vec<library::SplitView>,
    tracks: Vec<String>,
    listen: Option<usize>,
    label: String,
    max_mb: Option<f64>,
) -> CmdResult<String> {
    let s = state.settings.lock().unwrap().clone();
    library::export_split(&s, &id, start, end, &views, &tracks, listen, &label, max_mb).map_err(err)
}

#[tauri::command(async)]
fn export_full(state: State<AppState>, id: String) -> CmdResult<String> {
    let s = state.settings.lock().unwrap().clone();
    library::export_full(&s, &id).map_err(err)
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// The app's configuration and its built-in interface.
fn context() -> tauri::Context {
    tauri::generate_context!()
}

pub fn run() {
    log_panics();
    winutil::set_dpi_aware();
    winutil::end_helpers_with_app();
    // A newer interface fetched before, if it still fits this program.
    ui::load_saved();
    let mut context = context();
    ui::serve(&mut context);
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Rewatch")
                .args(["--minimized"])
                .build(),
        )
        .manage(AppState {
            settings: Mutex::new(Settings::load()),
            session: Mutex::new(None),
            status: Mutex::new(Status {
                state: "idle".into(),
                ..Default::default()
            }),
            skip_pid: Mutex::new(None),
            pov: Mutex::new(None),
            share_error: Mutex::new(None),
            update: Mutex::new(UpdateState { current: update::current(), ..Default::default() }),
            fetching: Mutex::new(()),
            closed_at: Mutex::new(None),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = handle.state::<AppState>().settings.lock().unwrap().clone();
            allow_recordings_dir(&handle, &settings);
            apply_autostart(&handle, &settings);
            {
                // Going online can take a moment; do not hold up the window for it.
                let (handle, settings) = (handle.clone(), settings.clone());
                std::thread::spawn(move || apply_pov(&handle, &settings));
            }
            // Started by Windows at sign-in: stay in the tray. Otherwise show the window.
            if !std::env::args().any(|a| a == "--minimized") {
                show_main(&handle);
            }

            // Tray icon: the app keeps running (and recording) with its window closed.
            let open = MenuItem::with_id(app, "open", "Open Rewatch", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main")
                .tooltip("Rewatch")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => {
                        let _ = finish_session(app, None);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            {
                // Now and then, fetch teammates' views of recent shared games so they
                // are there when the teammate has gone offline. Never during a recording.
                let handle = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(45));
                    loop {
                        let st = handle.state::<AppState>();
                        let settings = st.settings.lock().unwrap().clone();
                        let engine = st.pov.lock().unwrap().clone();
                        let recording = st.session.lock().unwrap().is_some();
                        if let (Some(engine), false) = (engine, recording) {
                            engine.sync_recent(&settings);
                        }
                        std::thread::sleep(Duration::from_secs(240));
                    }
                });
            }
            {
                // Smaller copies of recent games for teammates, made only while nothing
                // is being played or recorded.
                let (a, b) = (handle.clone(), handle.clone());
                std::thread::spawn(move || {
                    copies::worker(move || a.state::<AppState>().settings.lock().unwrap().clone(), move || !quiet(&b));
                });
            }
            {
                // Highlight clips of recent games, made while nothing is being played.
                let handle = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(25));
                    let mut failed: std::collections::HashSet<std::path::PathBuf> = Default::default();
                    loop {
                        let s = handle.state::<AppState>().settings.lock().unwrap().clone();
                        let job = if s.auto_highlights && quiet(&handle) {
                            s.recordings_path().and_then(|root| highlights::next_wanted(&root)).filter(|d| !failed.contains(d))
                        } else {
                            None
                        };
                        // Highlights-only: drop full recordings whose grace period is over.
                        if s.highlights_only && quiet(&handle) {
                            if let Some(root) = s.recordings_path() {
                                if highlights::trim_due(&s, &root) > 0 {
                                    let _ = handle.emit("library-changed", ());
                                }
                            }
                        }
                        if let Some(dir) = job {
                            let h = handle.clone();
                            match highlights::save(&s, &dir, &move || !quiet(&h)) {
                                Ok(_) => {
                                    let _ = handle.emit("highlights", dir.file_name().map(|n| n.to_string_lossy().to_string()));
                                    let _ = handle.emit("library-changed", ());
                                    continue;
                                }
                                Err(e) => {
                                    log(format!("[highlights] {e}"));
                                    failed.insert(dir);
                                }
                            }
                        }
                        std::thread::sleep(Duration::from_secs(30));
                    }
                });
            }
            {
                // Hints about deaths in recent games, if the user has switched that on.
                // Like the copies: only while nothing is being played or recorded.
                let handle = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(90));
                    let mut failed: std::collections::HashSet<std::path::PathBuf> = Default::default();
                    loop {
                        let s = handle.state::<AppState>().settings.lock().unwrap().clone();
                        let on = insight::enabled(&s) && quiet(&handle);
                        let root = s.recordings_path().filter(|_| on);
                        // Hints first (the review uses them to pick which deaths to
                        // look at), then the written review.
                        let hints = root.as_ref().and_then(|r| insight::next_wanted(r)).filter(|d| !failed.contains(d));
                        let written = root.as_ref().and_then(|r| coach::next_wanted(r)).filter(|d| !failed.contains(d));
                        if let Some(dir) = hints.clone().or(written) {
                            let h = handle.clone();
                            let stop = move || !quiet(&h);
                            let done = if hints.is_some() {
                                insight::analyze(&s, &dir, &stop).map(|_| ())
                            } else {
                                coach::review(&s, &dir, &stop).map(|_| ())
                            };
                            match done {
                                Ok(()) => {
                                    let _ = handle.emit("insights", dir.file_name().map(|n| n.to_string_lossy().to_string()));
                                    // Straight on to the next piece of work.
                                    continue;
                                }
                                Err(e) => {
                                    log(format!("[insight] {e}"));
                                    // Not again until the app restarts: a bad key or an
                                    // empty quota would otherwise be retried every minute.
                                    failed.insert(dir);
                                }
                            }
                        }
                        std::thread::sleep(Duration::from_secs(60));
                    }
                });
            }
            {
                // Post-game data from Riot (match details, timeline, LP) for new games,
                // and older ones that do not have it yet. Only while nothing is played.
                let handle = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(15));
                    loop {
                        let s = handle.state::<AppState>().settings.lock().unwrap().clone();
                        if quiet(&handle) && (s.use_client_api || !s.riot_api_key.trim().is_empty()) {
                            let h = handle.clone();
                            let changed = riot::work(&s, &move || !quiet(&h));
                            for id in &changed {
                                let _ = handle.emit("postgame", id);
                            }
                            if !changed.is_empty() {
                                let _ = handle.emit("library-changed", ());
                            }
                        }
                        std::thread::sleep(Duration::from_secs(30));
                    }
                });
            }
            {
                // Look for a newer version shortly after start and every six hours. With
                // "Update by itself" on it is fetched straight away, while no game is on.
                // A new interface is put in place there and then, and the window shows
                // it after a reload (at once if the window is closed). An installer runs
                // quietly once the window is closed.
                let handle = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(if cfg!(debug_assertions) { 3600 } else { 20 }));
                    // The installer that brought this version has finished by now.
                    update::clear_installers();
                    let mut last_check: Option<std::time::Instant> = None;
                    loop {
                        if last_check.map(|t| t.elapsed() > Duration::from_secs(6 * 3600)).unwrap_or(true) {
                            last_check = Some(std::time::Instant::now());
                            check_for_update(&handle);
                        }
                        let st = handle.state::<AppState>();
                        let auto = st.settings.lock().unwrap().auto_update;
                        let (installing, retry_later) = {
                            let u = st.update.lock().unwrap();
                            (u.installing, u.retry_later)
                        };
                        if installing {
                            // The installer closes this app within a minute. Still here
                            // after several: it did not go through.
                            std::thread::sleep(Duration::from_secs(240));
                            let mut u = st.update.lock().unwrap();
                            u.installing = false;
                            u.error = Some("The update did not finish. It will be tried again later.".into());
                            log("[update] the installer did not replace the app");
                            drop(u);
                            let _ = handle.emit("update", ());
                            std::thread::sleep(Duration::from_secs(3600));
                        } else if auto && !retry_later && quiet(&handle) {
                            let _ = fetch_update(&handle);
                            let ready = st.update.lock().unwrap().installer.is_some();
                            if ready && !window_visible(&handle) {
                                let _ = run_installer(&handle, true);
                            }
                        }
                        reload_if_hidden(&handle);
                        std::thread::sleep(Duration::from_secs(60));
                    }
                });
            }
            std::thread::spawn(move || watcher(handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
                // A newer interface waiting for the window to go comes in once the
                // page's last edits are saved.
                let app = window.app_handle().clone();
                *app.state::<AppState>().closed_at.lock().unwrap() = Some(std::time::Instant::now());
                if ui::needs_reload() {
                    std::thread::spawn(move || {
                        std::thread::sleep(SETTLE + Duration::from_millis(500));
                        reload_if_hidden(&app);
                    });
                }
            }
        })
        .on_page_load(|_, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                ui::page_loading();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            get_status,
            environment,
            copy_file,
            share_card,
            matchup_notes,
            set_matchup_note,
            list_microphones,
            share_info,
            friend_ping,
            league_name,
            disk_free,
            mic_level,
            mic_check_stop,
            pov_list,
            pov_saving,
            pov_extras,
            insights,
            highlights,
            build_highlight_reel,
            library_trends,
            postgame_fetch,
            riot_check,
            list_league_backups,
            create_league_backup,
            restore_league_backup,
            delete_league_backup,
            team_review,
            coach,
            voice,
            watch_set,
            watch_peers,
            update_info,
            update_check,
            update_install,
            export_split,
            list_matches,
            get_match,
            save_review,
            delete_match,
            delete_video,
            start_manual_recording,
            stop_recording,
            add_bookmark,
            export_clip,
            export_full
        ])
        .run(context)
        .expect("error while running Rewatch");
}

/// `rewatch --pov-serve <folder> --identity <file> --allow <friend code>`: stand in
/// for a teammate's PC, serving the recordings in a folder to one friend. For testing.
pub fn cli_pov_serve(dir: String, identity: String, allow: String, watch: Option<String>) -> i32 {
    let mut s = Settings::default();
    s.recordings_dir = dir;
    s.share_with_friends = true;
    s.share_name = "Test teammate".into();
    s.friends = vec![settings::Friend { name: "viewer".into(), code: allow }];
    match pov::Engine::start(std::path::Path::new(&identity), &s) {
        Ok(engine) => {
            println!("CODE {}", engine.code());
            engine.set_notifier(std::sync::Arc::new(|event| println!("WATCH {event}")));
            loop {
                std::thread::sleep(Duration::from_secs(1));
                if engine.online() {
                    println!("ONLINE");
                    break;
                }
            }
            // With `--watch <recording id>` the stand-in sits in a watch-together
            // session for that recording, so what it is told to do can be seen.
            if let Some(id) = watch {
                println!("JOINED {:?}", engine.watch_set(&s, Some(&id), 0.0, false, 1.0, false).map_err(|e| e.to_string()));
            }
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// `rewatch --pov-ping <friend code> --identity <file>`: check whether a teammate's
/// app can be reached, from a throwaway identity. For diagnosis.
pub fn cli_pov_ping(code: String, identity: String) -> i32 {
    let mut s = Settings::default();
    s.share_name = "connection test".into();
    match pov::Engine::start(std::path::Path::new(&identity), &s) {
        Ok(engine) => {
            for _ in 0..20 {
                if engine.online() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            println!("online: {}", engine.online());
            match engine.ping(&code) {
                Ok(name) => println!("RESULT connected (name: {name})"),
                Err(e) => println!("RESULT {e}"),
            }
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// `rewatch --pov-code --identity <file>`: print the friend code of an identity file,
/// creating it if needed. For testing.
pub fn cli_pov_code(identity: String) -> i32 {
    println!("{}", pov::load_identity(std::path::Path::new(&identity)).public());
    0
}

/// `rewatch --pov-fetch <friend code> --identity <file> --game-dir <recording folder>`:
/// save that teammate's view of the recording in the folder, as the app would in
/// the background. For testing.
pub fn cli_pov_fetch(code: String, identity: String, dir: String) -> i32 {
    let dir = std::path::PathBuf::from(dir);
    let mut s = Settings::default();
    s.recordings_dir = dir.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    s.share_name = "fetch test".into();
    s.friends = vec![settings::Friend { name: "Teammate".into(), code: code.clone() }];
    let Some(mine) = std::fs::read_to_string(dir.join("match.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|doc| pov::card_from_match(&doc))
    else {
        eprintln!("no usable match.json in that folder");
        return 2;
    };
    let engine = match pov::Engine::start(std::path::Path::new(&identity), &s) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    for p in engine.pov_list(&s, &mine, &dir) {
        println!("LISTED {} status={} cached={} shift={:.2}", p.friend, p.status, p.cached, p.shift);
    }
    for _ in 0..180 {
        std::thread::sleep(Duration::from_secs(1));
        for (_, (got, total)) in engine.saving(&dir) {
            println!("SAVING {got} of {total}");
        }
        let saved = pov::saved_povs(&dir, &mine);
        if let Some(p) = saved.first() {
            println!("SAVED {} cached={} shift={:.2} video={} mouse={}", p.friend, p.cached, p.shift, p.video.is_some(), p.mouse.is_some());
            return 0;
        }
    }
    println!("TIMEOUT nothing saved");
    3
}

/// `rewatch --list-mics`: print the microphones Windows offers and their live level.
pub fn cli_list_mics() -> i32 {
    for m in audio::list_microphones() {
        println!(
            "{}{} level={:.3}  {}",
            if m.is_default { "[default] " } else { "" },
            if m.is_default_comms { "[comms] " } else { "" },
            m.level,
            m.name
        );
    }
    0
}

/// Headless capture test: `rewatch --test-record <seconds> [--out <folder>]`.
/// Records the primary display with all sound tracks and prints what was produced.
pub fn cli_test_record(secs: u64, out: Option<String>, encoder: Option<String>, hotkey: Option<String>, codec: Option<String>) -> i32 {
    winutil::set_dpi_aware();
    winutil::end_helpers_with_app();
    let mut settings = Settings::load();
    if let Some(c) = codec {
        settings.codec = c;
    }
    if let Some(e) = encoder {
        settings.encoder = e;
    }
    if let Some(h) = hotkey {
        settings.bookmark_hotkey = h;
    }
    if let Some(dir) = out {
        settings.recordings_dir = dir;
    }
    if settings.recordings_path().is_none() {
        eprintln!("No recordings folder: pass --out <folder>");
        return 2;
    }
    let session = match Session::start(&settings, None, liveclient::ClientInfo::default()) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Could not start: {e}");
            return 1;
        }
    };
    let dir = session.dir.clone();
    println!("Recording {secs}s into {}", dir.display());
    std::thread::sleep(Duration::from_secs(secs / 2));
    session.add_bookmark();
    std::thread::sleep(Duration::from_secs(secs - secs / 2));
    match session.stop_and_finalize(&settings) {
        Ok(id) => {
            println!("Saved {id}");
            println!("{}", dir.display());
            0
        }
        Err(e) => {
            eprintln!("Could not finish: {e}");
            1
        }
    }
}

/// `rewatch --pov-extras <friend code> --identity <file> --game-dir <recording folder>`:
/// fetch that teammate's notes, drawings and speech times for the recording, then
/// send them two watch-together reports. For testing.
pub fn cli_pov_extras(code: String, identity: String, dir: String) -> i32 {
    let dir = std::path::PathBuf::from(dir);
    let mut s = Settings::default();
    s.recordings_dir = dir.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    s.share_name = "extras test".into();
    s.friends = vec![settings::Friend { name: "Teammate".into(), code }];
    let Some(mine) = std::fs::read_to_string(dir.join("match.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|doc| pov::card_from_match(&doc))
    else {
        eprintln!("no usable match.json in that folder");
        return 2;
    };
    let engine = match pov::Engine::start(std::path::Path::new(&identity), &s) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    for e in engine.extras(&s, &mine, &dir) {
        println!(
            "EXTRAS {} player={} notes={} drawings={} voice={} first_note={}",
            e.friend,
            e.player,
            e.notes.len(),
            e.drawings.len(),
            e.voice.len(),
            e.notes.first().map(|n| n.to_string()).unwrap_or_default()
        );
    }
    let id = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    for (t, playing, control) in [(100.0, true, true), (102.0, true, false)] {
        match engine.watch_set(&s, Some(&id), t, playing, 1.0, control) {
            Ok(()) => println!("SENT t={t} control={control}"),
            Err(e) => println!("SEND FAILED {e}"),
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    let _ = engine.watch_set(&s, None, 0.0, false, 1.0, false);
    std::thread::sleep(Duration::from_secs(2));
    0
}

/// `rewatch --ui-bundle <file>`: write this program's built-in interface as one file,
/// for installed apps with the same native part to take without a restart. Used by
/// scripts/release.mjs, which signs and publishes it.
pub fn cli_ui_bundle(out: String) -> i32 {
    let Some(native) = update::native_id() else {
        println!("REFUSED this build has no native fingerprint (only builds made by scripts/release.mjs have one)");
        return 1;
    };
    let context = context();
    match ui::pack(context.assets(), update::built(), native).and_then(|data| Ok(std::fs::write(&out, &data).map(|()| data.len())?)) {
        Ok(size) => {
            println!("WROTE {out}: version {}, native part {native}, {size} bytes", update::built());
            0
        }
        Err(e) => {
            println!("FAILED {e}");
            1
        }
    }
}

/// `rewatch --update-check [--download]`: say what the updater sees, and with
/// `--download` fetch what the app would and check its signature (nothing is put in
/// place or run).
pub fn cli_update_check(download: bool) -> i32 {
    // Counts a newer interface fetched before, as the app would.
    ui::load_saved();
    println!("this version: {} (built: {}, native part: {})", update::current(), update::built(), update::native_id().unwrap_or("none"));
    match update::check() {
        Ok(None) => {
            println!("RESULT up to date");
            0
        }
        Ok(Some(r)) => {
            let how = if r.restart { "the installer, with a restart" } else { "the interface alone, without a restart" };
            println!("RESULT newer version {} at {} (taken as {how})", r.version, r.url);
            if download {
                if r.ui.is_some() {
                    match update::download_ui(&r, &|| false).and_then(|data| ui::inspect(&data, &r.version)) {
                        Ok(what) => println!("VERIFIED interface: {what}"),
                        Err(e) => {
                            println!("REFUSED interface: {e}");
                            return 1;
                        }
                    }
                }
                match update::download(&r, &|| false) {
                    Ok(file) => println!("VERIFIED {} ({} bytes)", file.display(), std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0)),
                    Err(e) => {
                        println!("REFUSED {e}");
                        return 1;
                    }
                }
            }
            0
        }
        Err(e) => {
            println!("RESULT failed: {e}");
            1
        }
    }
}

/// `rewatch --make-copy <recording folder>`: make the smaller copy for teammates now.
pub fn cli_make_copy(dir: String) -> i32 {
    let s = Settings::load();
    let (ffmpeg, _) = s.ffmpeg_tools();
    match copies::make(&ffmpeg, std::path::Path::new(&dir), &|| false) {
        Ok(done) => {
            println!("RESULT made={done}");
            0
        }
        Err(e) => {
            println!("RESULT failed: {e}");
            1
        }
    }
}

/// `rewatch --voice <recording folder>`: print when someone was talking on its tracks.
pub fn cli_voice(dir: String) -> i32 {
    let s = Settings::load();
    let (ffmpeg, _) = s.ffmpeg_tools();
    let v = voice::for_dir(&ffmpeg, std::path::Path::new(&dir));
    for track in ["mic", "discord"] {
        let segs: Vec<[f64; 2]> = serde_json::from_value(v.get(track).cloned().unwrap_or(Value::Null)).unwrap_or_default();
        let total: f64 = segs.iter().map(|s| s[1] - s[0]).sum();
        println!("{track}: {} stretches, {total:.0}s of speech, first {:?}", segs.len(), segs.iter().take(3).collect::<Vec<_>>());
    }
    0
}

/// `rewatch --split-clip <recordings folder> <id> <start> <end> <view file> <shift>`:
/// export a two-view clip. For testing.
pub fn cli_split_clip(root: String, id: String, start: f64, end: f64, source: String, shift: f64) -> i32 {
    let mut s = Settings::load();
    s.recordings_dir = root;
    let views = vec![library::SplitView { source, shift, label: "Teammate".into() }];
    match library::export_split(&s, &id, start, end, &views, &["game".to_string()], None, "You", None) {
        Ok(path) => {
            println!("RESULT {path}");
            0
        }
        Err(e) => {
            println!("RESULT failed: {e}");
            1
        }
    }
}

/// `rewatch --test-notify`: show the "recording started" notification.
pub fn cli_test_notify() -> i32 {
    toast("app.rewatch.desktop", "Recording Ranked Flex");
    std::thread::sleep(Duration::from_secs(2));
    0
}

/// `rewatch --insights <recording folder> --key-file <file>`: ask Google's Decisions
/// API about the deaths in that recording, as the app would. For testing.
pub fn cli_insights(dir: String, key_file: String) -> i32 {
    let mut s = Settings::load();
    s.ai_review = true;
    s.gemini_key = std::fs::read_to_string(&key_file).unwrap_or_default().trim().to_string();
    match insight::analyze(&s, std::path::Path::new(&dir), &|| false) {
        Ok(v) => {
            for d in v.get("deaths").and_then(|d| d.as_array()).cloned().unwrap_or_default() {
                println!("{d}");
            }
            0
        }
        Err(e) => {
            println!("RESULT failed: {e}");
            1
        }
    }
}

/// `rewatch --coach <recording folder> --key-file <file>`: write the coach's review of
/// that recording, as the app would. For testing.
pub fn cli_coach(dir: String, key_file: String) -> i32 {
    let mut s = Settings::load();
    s.ai_review = true;
    s.gemini_key = std::fs::read_to_string(&key_file).unwrap_or_default().trim().to_string();
    match coach::review(&s, std::path::Path::new(&dir), &|| false) {
        Ok(v) => {
            println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            0
        }
        Err(e) => {
            println!("RESULT failed: {e}");
            1
        }
    }
}

/// `rewatch --postgame <recording folder> [--key-file <file>]`: fetch that game's
/// post-game data now, as the app would, and print a summary. For testing.
pub fn cli_postgame(dir: String, key_file: Option<String>) -> i32 {
    let mut s = Settings::load();
    if let Some(file) = key_file {
        s.riot_api_key = std::fs::read_to_string(&file).unwrap_or_default().trim().to_string();
    }
    match riot::fetch_now(&s, std::path::Path::new(&dir)) {
        Ok(pg) => {
            println!("source {}  match {}  map {}  {} s", pg["source"], pg["matchId"], pg["mapId"], pg["duration"]);
            for p in pg["players"].as_array().cloned().unwrap_or_default() {
                println!(
                    "{:>2} {:<16} {:<12} {:<8} {}/{}/{}  dmg {:>6} ({})  gold {:>6}  vision {:>3}{}",
                    p["id"], p["name"].as_str().unwrap_or(""), p["champion"].as_str().unwrap_or(""), p["position"].as_str().unwrap_or(""),
                    p["kills"], p["deaths"], p["assists"], p["damage"], p["dmgShare"], p["gold"], p["vision"],
                    if p["isMe"] == json!(true) { "  <- me" } else { "" }
                );
            }
            println!("kills {}  objectives {}  lane {}", pg["kills"].as_array().map(|a| a.len()).unwrap_or(0), pg["objectives"].as_array().map(|a| a.len()).unwrap_or(0), pg["lane"]["opponent"]);
            0
        }
        Err(e) => {
            println!("RESULT failed: {e}");
            1
        }
    }
}

/// `rewatch --riot-probe`: what the League client says about the logged-in account.
pub fn cli_riot_probe() -> i32 {
    println!("{}", serde_json::to_string_pretty(&riot::probe(&Settings::load())).unwrap_or_default());
    0
}

/// `rewatch --titles <recording folder>`: print the built-in title of every player.
pub fn cli_titles(dir: String) -> i32 {
    let doc: Value = std::fs::read_to_string(std::path::Path::new(&dir).join("match.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    for t in titles::for_match(&doc) {
        println!("{:<14} {:<28} {}", t["champion"].as_str().unwrap_or(""), t["title"].as_str().unwrap_or(""), t["why"].as_str().unwrap_or(""));
    }
    0
}

/// `rewatch --highlights <recording folder> [--save]`: list the highlights of a
/// recording and, with `--save`, make their clips. For testing.
pub fn cli_highlights(dir: String, save: bool) -> i32 {
    let s = Settings::load();
    let path = std::path::Path::new(&dir);
    let list = if save {
        highlights::save(&s, path, &|| false)
    } else {
        std::fs::read_to_string(path.join("match.json"))
            .map_err(anyhow::Error::from)
            .and_then(|t| Ok(serde_json::from_str::<Value>(&t)?))
            .map(|doc| highlights::list(&doc, path))
    };
    match list {
        Ok(items) => {
            for h in items {
                println!(
                    "{:>7.1}  {:>5.1}s  {:<10} {:<28} {}",
                    h["t"].as_f64().unwrap_or(0.0),
                    h["end"].as_f64().unwrap_or(0.0) - h["start"].as_f64().unwrap_or(0.0),
                    h["kind"].as_str().unwrap_or(""),
                    h["label"].as_str().unwrap_or(""),
                    h["file"].as_str().map(|f| f.rsplit(['\\', '/']).next().unwrap_or("").to_string()).unwrap_or_default()
                );
            }
            0
        }
        Err(e) => {
            println!("RESULT failed: {e}");
            1
        }
    }
}

/// `rewatch --team <recording folder> <start> <end> --key-file <file> [--view <file or
/// address> <shift> <champion>]`: review a team fight from my view and, optionally,
/// one teammate's. For testing.
pub fn cli_team(dir: String, start: f64, end: f64, key_file: String, view: Option<(String, f64, String)>) -> i32 {
    let mut s = Settings::load();
    s.gemini_key = std::fs::read_to_string(&key_file).unwrap_or_default().trim().to_string();
    let views: Vec<team::View> = view.into_iter().map(|(source, shift, champion)| team::View { source, shift, champion }).collect();
    match team::review(&s, std::path::Path::new(&dir), start, end, &views, &|| false) {
        Ok(v) => {
            println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            0
        }
        Err(e) => {
            println!("RESULT failed: {e}");
            1
        }
    }
}
