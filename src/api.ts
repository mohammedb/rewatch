// Bridge to the Rust core. Outside the desktop app (plain browser, used while
// developing the interface) it serves sample data instead.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { mock } from "./mock";
import type { Coach, Environment, Extras, Highlight, TeamReview, Insights, MatchFull, MatchSummary, MicInfo, Pov, Review, Settings, ShareInfo, Status, TrackName, UpdateInfo, Voice, WatchPeer } from "./types";

export const inApp = "__TAURI_INTERNALS__" in window;

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return inApp ? invoke<T>(cmd, args) : mock<T>(cmd, args);
}

export const api = {
  getSettings: () => call<Settings>("get_settings"),
  saveSettings: (settings: Settings) => call<Settings>("save_settings", { settings }),
  getStatus: () => call<Status>("get_status"),
  environment: () => call<Environment>("environment"),
  listMicrophones: () => call<MicInfo[]>("list_microphones"),
  listMatches: () => call<MatchSummary[]>("list_matches"),
  getMatch: (id: string) => call<MatchFull>("get_match", { id }),
  saveReview: (id: string, review: Review) => call<void>("save_review", { id, review }),
  deleteMatch: (id: string) => call<void>("delete_match", { id }),
  startManualRecording: () => call<void>("start_manual_recording"),
  stopRecording: () => call<string | null>("stop_recording"),
  exportClip: (id: string, start: number, end: number, tracks: TrackName[]) =>
    call<string>("export_clip", { id, start, end, tracks }),
  exportFull: (id: string) => call<string>("export_full", { id }),
  shareInfo: () => call<ShareInfo>("share_info"),
  friendPing: (code: string) => call<string>("friend_ping", { code }),
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
  updateInstall: () => call<void>("update_install"),
  exportSplit: (id: string, start: number, end: number, views: { source: string; shift: number; label: string }[], tracks: TrackName[], listen: number | null, label: string) =>
    call<string>("export_split", { id, start, end, views, tracks, listen, label }),
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

export function showInFolder(path: string) {
  if (inApp) revealItemInDir(path).catch(() => {});
}
