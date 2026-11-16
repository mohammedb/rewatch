// Bridge to the Rust core. Outside the desktop app (plain browser, used while
// developing the interface) it serves sample data instead.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { mock } from "./mock";
import type { Coach, CoachInbox, Environment, Extras, Highlight, TeamReview, Insights, LeagueBackup, MatchFull, MatchSummary, MatchupNote, MicInfo, PostGame, Pov, Review, Settings, Share, ShareInfo, Status, TrackName, TrendMatch, UpdateInfo, Voice, WatchPeer } from "./types";

export const inApp = "__TAURI_INTERNALS__" in window;

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return inApp ? invoke<T>(cmd, args) : mock<T>(cmd, args);
}

export const api = {
  getSettings: () => call<Settings>("get_settings"),
  saveSettings: (settings: Settings) => call<Settings>("save_settings", { settings }),
  getStatus: () => call<Status>("get_status"),
  environment: () => call<Environment>("environment"),
  /** Put a file on the clipboard, ready to paste into Discord or a folder. */
  copyFile: (path: string) => call<void>("copy_file", { path }),
  /** Save a picture of a game (a PNG data URL) next to it and put it on the clipboard. Returns its path. */
  shareCard: (id: string, png: string) => call<string>("share_card", { id, png }),
  /** The player's notes on playing against each champion, by champion key. */
  matchupNotes: () => call<Record<string, MatchupNote>>("matchup_notes"),
  /** Write the note on one opponent; an empty one removes it. Returns them all. */
  setMatchupNote: (champion: string, text: string) => call<Record<string, MatchupNote>>("set_matchup_note", { champion, text }),
  listMicrophones: () => call<MicInfo[]>("list_microphones"),
  listMatches: () => call<MatchSummary[]>("list_matches"),
  getMatch: (id: string) => call<MatchFull>("get_match", { id }),
  saveReview: (id: string, review: Review) => call<void>("save_review", { id, review }),
  deleteMatch: (id: string) => call<void>("delete_match", { id }),
  /** Delete a game's video and sound and keep its stats. Returns the bytes freed. */
  deleteVideo: (id: string) => call<number>("delete_video", { id }),
  startManualRecording: () => call<void>("start_manual_recording"),
  stopRecording: () => call<string | null>("stop_recording"),
  exportClip: (id: string, start: number, end: number, tracks: TrackName[], maxMb?: number | null) =>
    call<string>("export_clip", { id, start, end, tracks, maxMb: maxMb ?? null }),
  exportFull: (id: string) => call<string>("export_full", { id }),
  shareInfo: () => call<ShareInfo>("share_info"),
  /** Who a game has been sent to for review, and how each sending is getting on. */
  coachShares: (id: string) => call<Share[]>("coach_shares", { id }),
  /** Send a game to someone for review, by their friend code. Returns the game's shares. */
  coachSend: (id: string, code: string, name: string, comms: boolean, message: string) => call<Share[]>("coach_send", { id, code, name, comms, message }),
  /** Stop sharing a game with someone. A copy they already fetched stays with them. */
  coachStop: (id: string, code: string) => call<Share[]>("coach_stop", { id, code }),
  /** Games arriving from students, and people asking to send one. */
  coachInbox: () => call<CoachInbox>("coach_inbox"),
  /** Turn down a game someone asked to send. */
  coachDecline: (code: string, id: string, at: number) => call<void>("coach_decline", { code, id, at }),
  friendPing: (code: string) => call<string>("friend_ping", { code }),
  /** The player's name in League, to suggest as the name teammates see. */
  leagueName: () => call<string | null>("league_name"),
  /** Free space on the drive a folder is on (or would be on). */
  diskFree: (path: string) => call<number | null>("disk_free", { path }),
  /** How loud a microphone is right now, 0 to 1 ("" is the Windows default). Opens it; it closes once the calls stop. */
  micLevel: (device: string) => call<number>("mic_level", { device }),
  micCheckStop: () => call<void>("mic_check_stop"),
  povList: async (id: string) => {
    const list = await call<Pov[]>("pov_list", { id });
    // Saved views are files on this PC; turn their paths into addresses the page can load.
    return list.map((p) => (p.cached ? { ...p, source: p.video, video: p.video && absoluteFileUrl(p.video), mouse: p.mouse && absoluteFileUrl(p.mouse) } : { ...p, source: p.video }));
  },
  povSaving: (id: string) => call<Record<string, [number, number]>>("pov_saving", { id }),
  povExtras: (id: string) => call<Extras[]>("pov_extras", { id }),
  voice: (id: string) => call<Voice>("voice", { id }),
  /** The highlights of a recording; `save` makes their clips now. */
  highlights: (id: string, save: boolean) => call<Highlight[]>("highlights", { id, save }),
  buildHighlightReel: (id: string) => call<string>("build_highlight_reel", { id }),
  libraryTrends: () => call<TrendMatch[]>("library_trends"),
  /** Fetch a game's post-game data from Riot now. */
  postgameFetch: (id: string) => call<PostGame>("postgame_fetch", { id }),
  /** Whether Riot accepts an API key. */
  riotCheck: (key: string) => call<{ ok: boolean; message: string }>("riot_check", { key }),
  listLeagueBackups: () => call<LeagueBackup[]>("list_league_backups"),
  createLeagueBackup: (label: string) => call<LeagueBackup>("create_league_backup", { label }),
  restoreLeagueBackup: (id: string) => call<LeagueBackup>("restore_league_backup", { id }),
  deleteLeagueBackup: (id: string) => call<void>("delete_league_backup", { id }),
  /** A review of one team fight from my view and the teammates' views given. */
  teamReview: (id: string, start: number, end: number, views: { source: string; shift: number; champion: string }[]) =>
    call<TeamReview>("team_review", { id, start, end, views }),
  /** The written review of a recording; `run` has Gemini write it now. */
  coach: (id: string, run: boolean) => call<Coach | null>("coach", { id, run }),
  /** Hints about the deaths in a recording; `run` asks Google for them now. */
  insights: (id: string, run: boolean) => call<Insights | null>("insights", { id, run }),
  /** Watching together: report where this player is. `id` null leaves the session. */
  watchSet: (id: string | null, t: number, playing: boolean, rate: number, control: boolean) =>
    call<void>("watch_set", { id, t, playing, rate, control }),
  watchPeers: () => call<WatchPeer[]>("watch_peers"),
  updateInfo: () => call<UpdateInfo>("update_info"),
  updateCheck: () => call<UpdateInfo>("update_check"),
  /** Fetch the newer version if need be and put it in place. A new interface needs the window reloaded (`reload` in the answer); anything else restarts the app. */
  updateInstall: () => call<UpdateInfo>("update_install"),
  exportSplit: (id: string, start: number, end: number, views: { source: string; shift: number; label: string }[], tracks: TrackName[], listen: number | null, label: string, maxMb?: number | null) =>
    call<string>("export_split", { id, start, end, views, tracks, listen, label, maxMb: maxMb ?? null }),
};

/** URL the page can load a file on disk from. */
export function fileUrl(dir: string, name: string): string {
  if (!inApp) return `${dir}/${name}`;
  return convertFileSrc(`${dir}\\${name}`);
}

export function absoluteFileUrl(path: string): string {
  return inApp ? convertFileSrc(path) : path;
}

export function onEvent<T = unknown>(name: string, handler: (payload: T) => void): () => void {
  if (!inApp) return () => {};
  let off: (() => void) | undefined;
  let cancelled = false;
  listen<T>(name, (e) => handler(e.payload)).then((un) => {
    if (cancelled) un();
    else off = un;
  });
  return () => {
    cancelled = true;
    off?.();
  };
}

export async function pickFolder(current?: string): Promise<string | null> {
  if (!inApp) return window.prompt("Folder", current ?? "") || null;
  const picked = await open({ directory: true, defaultPath: current || undefined });
  return typeof picked === "string" ? picked : null;
}

/** Choose one program, like ffmpeg.exe. */
export async function pickProgram(name: string, current?: string): Promise<string | null> {
  if (!inApp) return window.prompt(name, current ?? "") || null;
  const picked = await open({ defaultPath: current || undefined, filters: [{ name, extensions: ["exe"] }] });
  return typeof picked === "string" ? picked : null;
}

export function showInFolder(path: string) {
  if (inApp) revealItemInDir(path).catch(() => {});
}
