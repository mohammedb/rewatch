//! Thin wrappers over the Windows calls the recorder needs.
//!
//! Hard rule: nothing here opens a handle to the game process, injects into it or
//! installs an input hook. Processes are found through the system process list,
//! windows through window enumeration, and the mouse through plain polling.

use std::mem::size_of;
use windows::core::BOOL;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
use windows::Win32::Graphics::Gdi::{
    ClientToScreen, GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, HMONITOR, MONITORINFO,
    MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClientRect, GetCursorPos, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsIconic,
    IsWindow, IsWindowVisible,
};

const GAME_EXE: &str = "League of Legends.exe";
/// The League client's interface process, which owns the client's window.
pub const CLIENT_UX_EXE: &str = "LeagueClientUx.exe";

/// Name of the game process to watch for. `REWATCH_GAME_EXE` overrides it so the
/// whole record-and-save flow can be tested with a harmless stand-in process.
pub fn game_exe() -> String {
    std::env::var("REWATCH_GAME_EXE").unwrap_or_else(|_| GAME_EXE.to_string())
}
const DISCORD_EXES: [&str; 3] = ["Discord.exe", "DiscordPTB.exe", "DiscordCanary.exe"];

pub struct ProcInfo {
    pub pid: u32,
    pub parent: u32,
    pub name: String,
}

pub fn list_processes() -> Vec<ProcInfo> {
    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return out;
        };
        let mut e = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let len = e
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(e.szExeFile.len());
                out.push(ProcInfo {
                    pid: e.th32ProcessID,
                    parent: e.th32ParentProcessID,
                    name: String::from_utf16_lossy(&e.szExeFile[..len]),
                });
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}

pub fn find_pid_by_name(name: &str) -> Option<u32> {
    list_processes()
        .into_iter()
        .find(|p| p.name.eq_ignore_ascii_case(name))
        .map(|p| p.pid)
}

pub fn pid_alive(pid: u32) -> bool {
    list_processes().iter().any(|p| p.pid == pid)
}

/// The top-most Discord process: the one whose parent is not itself Discord.
/// Capturing that process "and its tree" covers the voice engine child process.
pub fn find_discord_root_pid() -> Option<u32> {
    let procs = list_processes();
    let is_discord = |n: &str| DISCORD_EXES.iter().any(|d| d.eq_ignore_ascii_case(n));
    let discord: Vec<&ProcInfo> = procs.iter().filter(|p| is_discord(&p.name)).collect();
    discord
        .iter()
        .find(|p| !discord.iter().any(|q| q.pid == p.parent))
        .or(discord.first())
        .map(|p| p.pid)
}

/// Make every helper process this app starts (FFmpeg) end when the app ends, even if
/// the app is killed. Without this a killed app would leave FFmpeg recording forever.
pub fn end_helpers_with_app() {
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let Ok(job) = CreateJobObjectW(None, windows::core::PCWSTR::null()) else {
            return;
        };
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        // Breakaway is allowed so the update installer can be started outside the job:
        // it has to outlive the app it replaces.
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        let _ = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        // The job handle is never closed on purpose: Windows closes it when this
        // process ends, which is what ends the helpers.
        let _ = AssignProcessToJobObject(job, GetCurrentProcess());
    }
}

pub fn set_dpi_aware() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

/// What to capture. For a whole display: which graphics adapter/output it is for
/// FFmpeg, and where it sits on the desktop. For one window: its handle, and where its
/// inside (without title bar or frame) sat on the desktop when recording began, plus the
/// display it was on. Positions are physical pixels, so mouse positions can be made
/// relative to the picture.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CaptureTarget {
    pub adapter_idx: u32,
    pub output_idx: u32,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    /// The window recorded through Windows' window capture, or None when the whole
    /// display is recorded. Recordings made before window capture have none.
    #[serde(default)]
    pub window: Option<u64>,
}

impl CaptureTarget {
    /// The whole display this target is on, for when its window cannot be captured.
    pub fn display(&self) -> CaptureTarget {
        if self.window.is_none() {
            return *self;
        }
        // Found from where the window's middle was, which holds even if it has closed.
        let middle = POINT { x: self.x + self.w / 2, y: self.y + self.h / 2 };
        let hmon = unsafe { MonitorFromPoint(middle, MONITOR_DEFAULTTONEAREST) };
        target_for_monitor(hmon).unwrap_or_else(|| fallback_target(hmon))
    }

    /// "window" or "display", as match.json and the log say it.
    pub fn kind(&self) -> &'static str {
        if self.window.is_some() { "window" } else { "display" }
    }
}

fn window_handle(handle: Option<u64>) -> Option<HWND> {
    handle.filter(|h| *h != 0).map(|h| HWND(h as usize as *mut core::ffi::c_void))
}

/// Whether a window still exists. Only asks Windows; the window's process is not opened.
pub fn window_exists(handle: u64) -> bool {
    window_handle(Some(handle)).is_some_and(|h| unsafe { IsWindow(Some(h)) }.as_bool())
}

/// Windows' build number: 22000 and up is Windows 11.
pub fn windows_build() -> u32 {
    use windows::Wdk::System::SystemServices::RtlGetVersion;
    use windows::Win32::System::SystemInformation::OSVERSIONINFOW;
    let mut v = OSVERSIONINFOW { dwOSVersionInfoSize: size_of::<OSVERSIONINFOW>() as u32, ..Default::default() };
    unsafe {
        let _ = RtlGetVersion(&mut v);
    }
    v.dwBuildNumber
}

/// Whether one window can be captured without anything being drawn on the screen.
/// Windows 10 puts a yellow frame around a window while it is captured, over the game,
/// and only Windows 11 lets a recorder leave it out.
pub fn window_capture_possible() -> bool {
    windows_build() >= 22000
}

struct EnumState {
    pid: u32,
    best: Option<HWND>,
    best_area: i64,
}

unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    unsafe {
        let state = &mut *(lparam.0 as *mut EnumState);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == state.pid && IsWindowVisible(hwnd).as_bool() {
            let mut r = RECT::default();
            if GetWindowRect(hwnd, &mut r).is_ok() {
                let area = (r.right - r.left) as i64 * (r.bottom - r.top) as i64;
                if area > state.best_area {
                    state.best_area = area;
                    state.best = Some(hwnd);
                }
            }
        }
        BOOL(1)
    }
}

/// The largest visible window of the given process: its main window.
fn main_window(pid: u32) -> Option<HWND> {
    let mut state = EnumState {
        pid,
        best: None,
        best_area: 0,
    };
    unsafe {
        let _ = EnumWindows(Some(enum_cb), LPARAM(&mut state as *mut _ as isize));
    }
    state.best
}

/// Whether the process shows a window right now.
pub fn has_window(pid: u32) -> bool {
    main_window(pid).is_some()
}

/// Monitor that shows the largest visible window of the given process, if it has one.
fn monitor_of_process_window(pid: u32) -> Option<HMONITOR> {
    main_window(pid).map(|h| unsafe { MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST) })
}

/// The inside of a window (no title bar or frame) in desktop pixels. None while the
/// window is minimized, since it then has no picture to capture.
fn client_area(hwnd: HWND) -> Option<RECT> {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            return None;
        }
        let mut r = RECT::default();
        GetClientRect(hwnd, &mut r).ok()?;
        let mut origin = POINT { x: 0, y: 0 };
        if !ClientToScreen(hwnd, &mut origin).as_bool() {
            return None;
        }
        Some(RECT { left: origin.x, top: origin.y, right: origin.x + r.right, bottom: origin.y + r.bottom })
    }
}

/// What to capture for the main window of a process: its inside, on the display it
/// is on. Waits up to `wait_secs` for the process to show a window and for that
/// window's size to hold still (League may size its window as it opens). None if no
/// usable window turned up: no window, a minimized one, or a tiny one.
pub fn window_target(pid: u32, wait_secs: u32) -> Option<CaptureTarget> {
    let mut seen: Option<(HWND, RECT)> = None;
    for _ in 0..(wait_secs * 4).max(2) {
        let found = main_window(pid).and_then(|h| client_area(h).map(|r| (h, r)));
        if let Some((hwnd, r)) = found.filter(|(_, r)| r.right - r.left >= 320 && r.bottom - r.top >= 200) {
            let size = |r: &RECT| (r.right - r.left, r.bottom - r.top);
            if seen.is_some_and(|(h, before)| h == hwnd && size(&before) == size(&r)) {
                let hmon = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
                let display = target_for_monitor(hmon).unwrap_or_else(|| fallback_target(hmon));
                return Some(CaptureTarget {
                    x: r.left,
                    y: r.top,
                    w: r.right - r.left,
                    h: r.bottom - r.top,
                    window: Some(hwnd.0 as usize as u64),
                    ..display
                });
            }
            seen = Some((hwnd, r));
        } else if !pid_alive(pid) {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    None
}

fn primary_monitor() -> HMONITOR {
    unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) }
}

fn target_for_monitor(hmon: HMONITOR) -> Option<CaptureTarget> {
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
        let mut a = 0u32;
        while let Ok(adapter) = factory.EnumAdapters1(a) {
            let mut o = 0u32;
            while let Ok(output) = adapter.EnumOutputs(o) {
                if let Ok(desc) = output.GetDesc() {
                    if desc.Monitor == hmon {
                        let r = desc.DesktopCoordinates;
                        return Some(CaptureTarget {
                            adapter_idx: a,
                            output_idx: o,
                            x: r.left,
                            y: r.top,
                            w: r.right - r.left,
                            h: r.bottom - r.top,
                            window: None,
                        });
                    }
                }
                o += 1;
            }
            a += 1;
        }
    }
    None
}

fn fallback_target(hmon: HMONITOR) -> CaptureTarget {
    let mut mi = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    let (mut w, mut h, mut x, mut y) = (1920, 1080, 0, 0);
    unsafe {
        if GetMonitorInfoW(hmon, &mut mi).as_bool() {
            x = mi.rcMonitor.left;
            y = mi.rcMonitor.top;
            w = mi.rcMonitor.right - mi.rcMonitor.left;
            h = mi.rcMonitor.bottom - mi.rcMonitor.top;
        }
    }
    CaptureTarget {
        adapter_idx: 0,
        output_idx: 0,
        x,
        y,
        w,
        h,
        window: None,
    }
}

/// Capture target for the display the game window is on. Waits up to `wait_secs`
/// for the window to appear, then falls back to the primary display.
pub fn capture_target(game_pid: Option<u32>, wait_secs: u32) -> CaptureTarget {
    let mut hmon = None;
    if let Some(pid) = game_pid {
        for _ in 0..(wait_secs * 4).max(1) {
            hmon = monitor_of_process_window(pid);
            if hmon.is_some() || !pid_alive(pid) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    }
    let hmon = hmon.unwrap_or_else(primary_monitor);
    target_for_monitor(hmon).unwrap_or_else(|| fallback_target(hmon))
}

/// Cursor position in physical desktop pixels plus left/right button state.
pub fn mouse_state() -> Option<(i32, i32, u8)> {
    unsafe {
        let mut p = POINT::default();
        GetCursorPos(&mut p).ok()?;
        let l = (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0;
        let r = (GetAsyncKeyState(VK_RBUTTON.0 as i32) as u16 & 0x8000) != 0;
        Some((p.x, p.y, (l as u8) | ((r as u8) << 1)))
    }
}

/// Whether a key is held down right now (polled; no hook).
pub fn key_down(vk: i32) -> bool {
    unsafe { (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 }
}

/// The process that owns the window in front. Only asks Windows which window that is;
/// the process itself is not opened.
pub fn foreground_pid() -> Option<u32> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        (pid != 0).then_some(pid)
    }
}

/// A key, with optional modifiers, that the user presses to drop a bookmark.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hotkey {
    pub vk: i32,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
}

/// Read "F8", "Ctrl+Shift+B", "Numpad0" and the like. None if it names no key.
pub fn parse_hotkey(text: &str) -> Option<Hotkey> {
    let mut key = Hotkey { vk: 0, ctrl: false, shift: false, alt: false };
    for part in text.split('+').map(|p| p.trim().to_ascii_uppercase()).filter(|p| !p.is_empty()) {
        match part.as_str() {
            "CTRL" | "CONTROL" => key.ctrl = true,
            "SHIFT" => key.shift = true,
            "ALT" => key.alt = true,
            name => {
                key.vk = match name {
                    "INSERT" => 0x2D,
                    "DELETE" => 0x2E,
                    "HOME" => 0x24,
                    "END" => 0x23,
                    "PAGEUP" => 0x21,
                    "PAGEDOWN" => 0x22,
                    "PAUSE" => 0x13,
                    "SCROLLLOCK" => 0x91,
                    _ if name.len() == 1 && name.as_bytes()[0].is_ascii_alphanumeric() => name.as_bytes()[0] as i32,
                    _ => {
                        if let Some(n) = name.strip_prefix("NUMPAD").and_then(|n| n.parse::<i32>().ok()).filter(|n| (0..=9).contains(n)) {
                            0x60 + n
                        } else if let Some(n) = name.strip_prefix('F').and_then(|n| n.parse::<i32>().ok()).filter(|n| (1..=24).contains(n)) {
                            0x70 + n - 1
                        } else {
                            return None;
                        }
                    }
                }
            }
        }
    }
    (key.vk != 0).then_some(key)
}

/// Whether the hotkey is held right now. This asks Windows for the key's state; it
/// installs nothing, does not swallow the key, and works while a game has focus
/// (registered hotkeys do not: League tells Windows to ignore them).
pub fn hotkey_down(key: &Hotkey) -> bool {
    let down = |vk: i32| unsafe { (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 };
    down(key.vk) && down(0x11) == key.ctrl && down(0x10) == key.shift && down(0x12) == key.alt
}

/// Bytes free for this user on the drive holding `path`. The folder itself need not
/// exist yet: the nearest folder above it that does is asked instead.
pub fn free_bytes(path: &std::path::Path) -> Option<u64> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let existing = path.ancestors().find(|p| !p.as_os_str().is_empty() && p.exists())?;
    let mut free = 0u64;
    unsafe { GetDiskFreeSpaceExW(&HSTRING::from(existing.as_os_str()), Some(&mut free), None, None) }.ok()?;
    Some(free)
}

/// The clipboard's "files" format (CF_HDROP): a DROPFILES header, then every path as
/// UTF-16 with its own terminator, then one more terminator.
fn drop_list(paths: &[std::path::PathBuf]) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    const HEADER: u32 = 20; // DROPFILES: pFiles, pt.x, pt.y, fNC, fWide
    let mut out = Vec::new();
    out.extend_from_slice(&HEADER.to_le_bytes());
    out.extend_from_slice(&[0u8; 12]); // drop point and fNC
    out.extend_from_slice(&1u32.to_le_bytes()); // fWide: the paths are UTF-16
    for p in paths {
        for unit in p.as_os_str().encode_wide().chain([0]) {
            out.extend_from_slice(&unit.to_le_bytes());
        }
    }
    out.extend_from_slice(&[0, 0]);
    out
}

/// Put files on the clipboard the way Explorer's Copy does, so they can be pasted
/// into Discord or a folder.
pub fn copy_files_to_clipboard(paths: &[std::path::PathBuf]) -> anyhow::Result<()> {
    use windows::Win32::Foundation::{GlobalFree, HANDLE};
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    const CF_HDROP: u32 = 15;
    anyhow::ensure!(!paths.is_empty(), "nothing to copy");
    for p in paths {
        anyhow::ensure!(p.exists(), "{} no longer exists", p.display());
    }
    let bytes = drop_list(paths);
    unsafe {
        let mem = GlobalAlloc(GMEM_MOVEABLE, bytes.len())?;
        let dst = GlobalLock(mem) as *mut u8;
        if dst.is_null() {
            let _ = GlobalFree(Some(mem));
            anyhow::bail!("could not prepare the clipboard");
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), dst, bytes.len());
        let _ = GlobalUnlock(mem);
        // Another program may hold the clipboard for a moment; try a few times.
        let mut opened = false;
        for _ in 0..10 {
            if OpenClipboard(None).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        if !opened {
            let _ = GlobalFree(Some(mem));
            anyhow::bail!("the clipboard is busy; try again");
        }
        let _ = EmptyClipboard();
        // Once handed over, the clipboard owns the memory.
        let set = SetClipboardData(CF_HDROP, Some(HANDLE(mem.0)));
        let _ = CloseClipboard();
        if set.is_err() {
            let _ = GlobalFree(Some(mem));
            anyhow::bail!("could not put the file on the clipboard");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hotkeys_are_parsed() {
        assert_eq!(parse_hotkey("F8"), Some(Hotkey { vk: 0x77, ctrl: false, shift: false, alt: false }));
        assert_eq!(parse_hotkey(" f24 "), Some(Hotkey { vk: 0x87, ctrl: false, shift: false, alt: false }));
        assert_eq!(parse_hotkey("Ctrl+Shift+B"), Some(Hotkey { vk: 0x42, ctrl: true, shift: true, alt: false }));
        assert_eq!(parse_hotkey("alt + numpad0"), Some(Hotkey { vk: 0x60, ctrl: false, shift: false, alt: true }));
        assert_eq!(parse_hotkey("Insert"), Some(Hotkey { vk: 0x2D, ctrl: false, shift: false, alt: false }));
        assert_eq!(parse_hotkey(""), None);
        assert_eq!(parse_hotkey("Ctrl"), None);
        assert_eq!(parse_hotkey("F99"), None);
        assert_eq!(parse_hotkey("banana"), None);
    }

    #[test]
    fn drop_list_is_a_wide_double_terminated_list() {
        let paths = [std::path::PathBuf::from(r"C:\a.mp4"), std::path::PathBuf::from(r"D:\b c.mp4")];
        let bytes = drop_list(&paths);
        assert_eq!(&bytes[0..4], &20u32.to_le_bytes(), "pFiles points past the header");
        assert_eq!(&bytes[16..20], &1u32.to_le_bytes(), "fWide is set");
        let units: Vec<u16> = bytes[20..].chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let text = String::from_utf16(&units).unwrap();
        assert_eq!(text, "C:\\a.mp4\0D:\\b c.mp4\0\0");
    }

    #[test]
    fn free_bytes_finds_an_existing_folder_above() {
        let missing = std::env::temp_dir().join("rewatch-not-made-yet").join("deeper");
        assert!(free_bytes(&missing).unwrap_or(0) > 0);
    }
}

/// High-resolution counter in 100-nanosecond units (same unit as sound packet timestamps).
pub fn qpc_100ns() -> u64 {
    unsafe {
        let mut c = 0i64;
        let mut f = 0i64;
        let _ = QueryPerformanceCounter(&mut c);
        let _ = QueryPerformanceFrequency(&mut f);
        if f <= 0 {
            return 0;
        }
        ((c as u128) * 10_000_000u128 / (f as u128)) as u64
    }
}
