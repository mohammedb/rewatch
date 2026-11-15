// The controls under the video: sound, what the timeline shows, the clip being cut,
// and the keyboard shortcuts. Each opens a small popover so the row stays short.

import { AudioLines, ChevronDown, Gamepad2, Headphones, Keyboard, Mic, MicOff, MousePointer2, MousePointerClick, Repeat, Scissors, SlidersHorizontal, TrendingUp, VolumeX, X, type LucideIcon } from "lucide-react";
import { useRef, useState } from "react";
import { CATEGORY_LABEL, clock } from "./format";
import { FILTER_ICON } from "./icons";
import type { AudioPrefs, Track, TrackName } from "./types";
import { Popover, Select } from "./ui";

export const TRACKS: { name: TrackName; label: string; icon: LucideIcon; off: LucideIcon; key: string }[] = [
  { name: "game", label: "Game", icon: Gamepad2, off: VolumeX, key: "1" },
  { name: "discord", label: "Discord", icon: Headphones, off: VolumeX, key: "2" },
  { name: "mic", label: "Your mic", icon: Mic, off: MicOff, key: "3" },
];

/** Mute buttons for each track in the row, and a popover with the volumes. */
export function SoundControl({ tracks, audio, onChange }: { tracks: Track[]; audio: AudioPrefs; onChange: (patch: Partial<AudioPrefs>) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const shown = TRACKS.filter((t) => tracks.some((x) => x.name === t.name));
  const canDuck = shown.some((t) => t.name === "game") && shown.some((t) => t.name !== "game");
  if (!shown.length) return null;
  return (
    <div className="sound" ref={anchor} role="group" aria-label="Sound tracks">
      {shown.map(({ name, label, icon: On, off: Off, key }) => {
        const tr = tracks.find((t) => t.name === name)!;
        const muted = audio.muted[name];
        return (
          <button
            key={name}
            className={`btn sq quiet trk ${muted ? "muted" : ""} ${tr.silent ? "silent" : ""}`}
            aria-pressed={!muted}
            aria-label={`${label} sound`}
            title={tr.silent ? `${label}: nothing was heard on this track${tr.note ? ` (${tr.note})` : ""}` : `${muted ? "Unmute" : "Mute"} ${label} (${key})`}
            onClick={() => onChange({ muted: { ...audio.muted, [name]: !muted } })}
          >
            {muted ? <Off size={16} /> : <On size={16} />}
          </button>
        );
      })}
      <button className="btn sq quiet trk-more" aria-label="Volumes" aria-expanded={open} title="Volumes" onClick={() => setOpen((o) => !o)}>
        <ChevronDown size={14} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="top-start" label="Sound tracks">
        <div className="mixpop">
          <h3>Sound</h3>
          {shown.map(({ name, label, icon: On, off: Off, key }) => {
            const tr = tracks.find((t) => t.name === name)!;
            const muted = audio.muted[name];
            return (
              <div key={name} className={`mixrow ${muted ? "muted" : ""}`}>
                <button className="btn sq quiet" aria-pressed={!muted} aria-label={`${label} sound`} title={`${muted ? "Unmute" : "Mute"} (${key})`} onClick={() => onChange({ muted: { ...audio.muted, [name]: !muted } })}>
                  {muted ? <Off size={16} /> : <On size={16} />}
                </button>
                <span className="ml">
                  {label}
                  {tr.silent && <small>Nothing was heard{tr.note ? `: ${tr.note}` : ""}</small>}
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={audio.volume[name]}
                  aria-label={`${label} volume`}
                  onChange={(e) => onChange({ volume: { ...audio.volume, [name]: Number(e.target.value) }, muted: { ...audio.muted, [name]: false } })}
                />
                <span className="num pctv">{Math.round(audio.volume[name] * 100)}</span>
              </div>
            );
          })}
          {canDuck && (
            <label className="mixduck">
              <span>
                <AudioLines size={15} aria-hidden />
                Lower the game when someone talks
              </span>
              <button className="switch" role="switch" aria-checked={!!audio.duck} aria-label="Lower the game when someone talks" onClick={() => onChange({ duck: !audio.duck })} />
            </label>
          )}
        </div>
      </Popover>
    </div>
  );
}

export const FILTERS = ["kill", "death", "assist", "fight", "objective", "structure", "item", "bookmark", "note"] as const;
export const FILTER_COLOR: Record<string, string> = {
  kill: "var(--ally)", death: "var(--enemy)", assist: "var(--ally)", fight: "var(--soft)", objective: "var(--epic)",
  structure: "var(--soft)", item: "var(--gold)", bookmark: "var(--mark)", note: "var(--text)",
};

export interface Overlay {
  key: "trail" | "clicks" | "keys" | "comms" | "graph";
  label: string;
  hint: string;
  on: boolean;
  /** A live number to show next to it, like clicks per minute. */
  extra?: string | null;
}

const OVERLAY_ICON: Record<Overlay["key"], LucideIcon> = { trail: MousePointer2, clicks: MousePointerClick, keys: Keyboard, comms: AudioLines, graph: TrendingUp };

/** What the timeline marks and what is drawn over the video, in one popover. */
export function ShowControl({
  filters,
  counts,
  overlays,
  onFilter,
  onOverlay,
}: {
  filters: Record<string, boolean>;
  counts: Record<string, number>;
  overlays: Overlay[];
  onFilter: (key: string, on: boolean) => void;
  onOverlay: (key: Overlay["key"], on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const hiddenCount = FILTERS.filter((f) => !filters[f] && (counts[f] ?? 0) > 0).length;
  return (
    <>
      <button ref={btn} className="btn sm quiet showbtn" aria-expanded={open} onClick={() => setOpen((o) => !o)} title="What the timeline and the video show">
        <SlidersHorizontal size={15} aria-hidden />
        <span className="w">Show</span>
        {hiddenCount > 0 && <span className="pill" title={`${hiddenCount} kinds of moment hidden`}>{hiddenCount} off</span>}
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} placement="top-end" label="Show on the timeline">
        <div className="showpop">
          <h3>On the timeline</h3>
          <div className="showgrid">
            {FILTERS.map((f) => {
              const Icon = FILTER_ICON[f];
              const n = counts[f] ?? 0;
              return (
                <button key={f} className="showrow" role="switch" aria-checked={!!filters[f]} onClick={() => onFilter(f, !filters[f])} style={{ ["--c" as string]: FILTER_COLOR[f] }}>
                  <Icon size={15} aria-hidden />
                  <span className="l">{CATEGORY_LABEL[f]}</span>
                  <span className="num n">{n}</span>
                  <span className="tog" aria-hidden />
                </button>
              );
            })}
          </div>
          {overlays.length > 0 && (
            <>
              <h3>Over the video and below the timeline</h3>
              <div className="showgrid one">
                {overlays.map((o) => {
                  const Icon = OVERLAY_ICON[o.key];
                  return (
                    <button key={o.key} className="showrow" role="switch" aria-checked={o.on} title={o.hint} onClick={() => onOverlay(o.key, !o.on)}>
                      <Icon size={15} aria-hidden />
                      <span className="l">
                        {o.label}
                        {o.extra && <small>{o.extra}</small>}
                      </span>
                      <span className="tog" aria-hidden />
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </Popover>
    </>
  );
}

/** The bar shown while cutting a clip: its length, the size it should fit, save. */
export function ClipBar({
  range,
  maxMb,
  looping,
  busy,
  split,
  onSize,
  onLoop,
  onPlay,
  onCancel,
  onSave,
}: {
  range: [number, number];
  maxMb: number | null;
  looping: boolean;
  busy: boolean;
  /** Teammates' views are showing: the clip has them side by side. */
  split: boolean;
  onSize: (mb: number | null) => void;
  onLoop: () => void;
  onPlay: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const len = Math.max(0, range[1] - range[0]);
  return (
    <div className="clipbar" role="group" aria-label="Clip">
      <Scissors size={15} aria-hidden className="ci" />
      <span className="cl">
        <b className="num">{clock(len)}</b>
        <span className="muted num">
          {clock(range[0])} to {clock(range[1])}
        </span>
      </span>
      <span className="hint">Drag the gold edges on the timeline, or press [ and ] to set them here.</span>
      <span className="grow" />
      <button className="btn sm quiet" onClick={onPlay} title="Play the clip from its start">
        Preview
      </button>
      <button className={`btn sm sq ${looping ? "on" : ""}`} aria-pressed={looping} aria-label="Loop the clip" title="Loop the clip (R)" onClick={onLoop}>
        <Repeat size={14} />
      </button>
      <Select
        small
        label="File size"
        value={maxMb ?? 0}
        onChange={(v) => onSize(v ? v : null)}
        placement="top-end"
        options={[
          { value: 0, label: "Full quality", hint: "Same quality as the recording" },
          { value: 10, label: "Under 10 MB", hint: "Fits Discord without Nitro" },
          { value: 50, label: "Under 50 MB", hint: "Fits Discord with Nitro Basic" },
        ]}
      />
      <button className="btn sm quiet" onClick={onCancel}>
        <X size={14} aria-hidden />
        Cancel
      </button>
      <button className="btn sm primary" disabled={busy || len < 0.5} onClick={onSave} title={split ? "One video with the views that are showing, side by side" : "Uses the sound tracks that are not muted right now"}>
        {split ? "Save split clip" : "Save clip"}
      </button>
    </div>
  );
}

export const SHORTCUTS: [string, string][] = [
  ["Space", "Play or pause"],
  ["← →", "Back or forward 5 seconds"],
  ["Shift ← →", "1 second"],
  ["J L", "10 seconds"],
  [", .", "One frame"],
  ["P N", "Previous or next moment"],
  ["[ ]", "Clip start and end"],
  ["R", "Loop the clip or moment"],
  ["1 2 3", "Mute game, Discord, mic"],
  ["D", "Draw"],
  ["Ctrl Z", "Undo the last drawing"],
  ["V", "Next teammate's view"],
  ["S", "Split view"],
  ["Shift P", "Share mode, for screen sharing"],
  ["T", "Side panel"],
  ["O", "Scoreboard, both teams in full"],
  ["F", "Full screen"],
  ["?", "These shortcuts"],
];

export function ShortcutsButton({ open, onOpen }: { open: boolean; onOpen: (open: boolean) => void }) {
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={btn} className={`btn sq quiet ${open ? "on" : ""}`} aria-label="Keyboard shortcuts" aria-expanded={open} title="Keyboard shortcuts (?)" onClick={() => onOpen(!open)}>
        <Keyboard size={17} />
      </button>
      <Popover anchor={btn} open={open} onClose={() => onOpen(false)} placement="top-end" label="Keyboard shortcuts">
        <div className="help">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys} className="hrow">
              <span className="hk">
                {keys.split(" ").map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </span>
              <span>{what}</span>
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}
