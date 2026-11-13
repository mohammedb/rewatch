// Pieces the review player's video area is built from: the cursor overlay, the
// zoom-and-pan wrapper, a teammate's view in split view, and draggable dividers.

import { Expand, RotateCcw, Shrink, Volume2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Portrait } from "./ChampIcon";
import { laneName } from "./format";
import type { Pov } from "./types";

// ------------------------------------------------------------------ cursor

export interface MouseLog {
  t: Float64Array; // seconds in that recording's video time
  x: Float32Array;
  y: Float32Array;
  clicks: { t: number; x: number; y: number; right: boolean }[];
}

/** Size of the screen the cursor positions were recorded on. */
export interface MouseFrame {
  w: number;
  h: number;
}

export function parseMouse(text: string, offset: number): MouseLog {
  const lines = text.split("\n");
  const n = Math.max(0, lines.length - 1);
  const t = new Float64Array(n);
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const clicks: MouseLog["clicks"] = [];
  let count = 0;
  let prev = 0;
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    if (p.length < 4) continue;
    const at = Number(p[0]) / 1000 - offset;
    const b = Number(p[3]);
    t[count] = at;
    x[count] = Number(p[1]);
    y[count] = Number(p[2]);
    if (b & 1 && !(prev & 1)) clicks.push({ t: at, x: x[count], y: y[count], right: false });
    if (b & 2 && !(prev & 2)) clicks.push({ t: at, x: x[count], y: y[count], right: true });
    prev = b;
    count++;
  }
  return { t: t.subarray(0, count), x: x.subarray(0, count), y: y.subarray(0, count), clicks };
}

/** Index of the last sample at or before `t`, or -1. */
export function lastAtOrBefore(arr: Float64Array, t: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Draw the cursor trail and click rings for time `t` onto a canvas laid over the video. */
export function drawMouse(
  c: HTMLCanvasElement,
  log: MouseLog | null,
  frame: MouseFrame | null,
  t: number,
  show: { trail: boolean; clicks: boolean },
) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr);
  const h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  if (!log || !frame || !frame.w || !frame.h || (!show.trail && !show.clicks)) return;
  const sx = w / frame.w;
  const sy = h / frame.h;
  const i = lastAtOrBefore(log.t, t);
  if (show.trail && i >= 0) {
    const span = 0.7;
    ctx.lineWidth = 2.5 * dpr;
    ctx.lineCap = "round";
    for (let k = i; k > 0 && log.t[k] > t - span; k--) {
      const alpha = 1 - (t - log.t[k]) / span;
      ctx.strokeStyle = `rgba(242,201,76,${(alpha * 0.9).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(log.x[k - 1] * sx, log.y[k - 1] * sy);
      ctx.lineTo(log.x[k] * sx, log.y[k] * sy);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(242,201,76,0.95)";
    ctx.beginPath();
    ctx.arc(log.x[i] * sx, log.y[i] * sy, 4 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }
  if (show.clicks) {
    const life = 0.6;
    for (const cl of log.clicks) {
      if (cl.t > t) break;
      const age = t - cl.t;
      if (age > life) continue;
      ctx.strokeStyle = cl.right ? `rgba(91,141,239,${1 - age / life})` : `rgba(255,255,255,${1 - age / life})`;
      ctx.lineWidth = 2.5 * dpr;
      ctx.beginPath();
      ctx.arc(cl.x * sx, cl.y * sy, (6 + (age / life) * 18) * dpr, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

// ------------------------------------------------------------------ keys

export interface KeyLog {
  /** Key names; key i is bit i of `mask`. */
  names: string[];
  t: Float64Array; // seconds in video time
  mask: Uint32Array;
  /** 0 playing, 1 chat open, 2 another window in front (nothing recorded then). */
  state: Uint8Array;
  /** Times at which any key went down, for keys per minute. */
  presses: number[];
}

export function parseKeys(text: string, offset: number, names: string[]): KeyLog {
  const lines = text.split(/\r?\n/);
  const n = Math.max(0, lines.length - 1);
  const t = new Float64Array(n);
  const mask = new Uint32Array(n);
  const state = new Uint8Array(n);
  const presses: number[] = [];
  let count = 0;
  let prev = 0;
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    if (p.length < 3) continue;
    const at = Number(p[0]) / 1000 - offset;
    const m = Number(p[1]) >>> 0;
    t[count] = at;
    mask[count] = m;
    state[count] = Number(p[2]);
    if (m & ~prev) presses.push(at);
    prev = m;
    count++;
  }
  return { names, t: t.subarray(0, count), mask: mask.subarray(0, count), state: state.subarray(0, count), presses };
}

/** How the keycaps are laid out; names a recording does not have are left out. */
export const KEY_ROWS: string[][] = [
  ["Q", "W", "E", "R", "D", "F"],
  ["1", "2", "3", "4", "5", "6", "7", "B"],
  ["Shift", "Ctrl", "A", "S", "Tab", "Space"],
];
/** A tap stays lit at least this long, so short presses are seen at normal speed. */
const KEY_GLOW = 0.15;

/** Light the keycaps inside `el` for time `t`. Called every frame, so it only touches attributes. */
export function drawKeys(el: HTMLElement | null, log: KeyLog | null, t: number) {
  if (!el || !log) return;
  const i = lastAtOrBefore(log.t, t);
  let lit = i >= 0 ? log.mask[i] : 0;
  // Keys that went down a moment ago stay lit even if already released.
  for (let k = i; k > 0 && log.t[k] > t - KEY_GLOW; k--) lit |= log.mask[k] & ~log.mask[k - 1];
  const state = i >= 0 ? log.state[i] : 2;
  el.dataset.state = state === 1 ? "chat" : state === 2 ? "away" : "play";
  for (const cap of el.querySelectorAll<HTMLElement>("[data-k]")) {
    const on = (lit >>> Number(cap.dataset.k)) & 1;
    if ((cap.dataset.on === "1") !== !!on) cap.dataset.on = on ? "1" : "0";
  }
}

/** Keycaps shown over the video; lit by `drawKeys`. */
export function KeyOverlay({ names, ref }: { names: string[]; ref: Ref<HTMLDivElement> }) {
  return (
    <div className="keys" ref={ref} aria-hidden data-state="play">
      {KEY_ROWS.map((row, r) => {
        const caps = row.map((name) => ({ name, k: names.indexOf(name) })).filter((c) => c.k >= 0);
        return caps.length ? (
          <div className="krow" key={r}>
            {caps.map((c) => <span key={c.name} className={`kcap ${c.name.length > 1 ? "wide" : ""}`} data-k={c.k}>{c.name}</span>)}
          </div>
        ) : null;
      })}
      <span className="knote chat">Chat open</span>
      <span className="knote away">Game not in front</span>
    </div>
  );
}

const mouseCache = new Map<string, Promise<MouseLog | null>>();

/** A teammate's cursor log, fetched once per recording. */
export function usePovMouse(pov: Pov | null): MouseLog | null {
  const [log, setLog] = useState<MouseLog | null>(null);
  const url = pov?.mouse ?? null;
  const offset = pov?.mouseOffset ?? 0;
  useEffect(() => {
    setLog(null);
    if (!url) return;
    let live = true;
    let job = mouseCache.get(url);
    if (!job) {
      job = fetch(url)
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
        .then((text) => parseMouse(text, offset))
        .catch(() => null);
      mouseCache.set(url, job);
    }
    job.then((l) => live && setLog(l));
    return () => {
      live = false;
    };
  }, [url, offset]);
  return log;
}

// -------------------------------------------------------------------- zoom

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

interface ZoomPaneProps {
  children: ReactNode;
  /** Dragging is needed for something else (drawing), so do not pan. */
  panDisabled?: boolean;
}

/**
 * Wheel to zoom towards the cursor (up to 6×), drag to move around while zoomed,
 * double-click or the badge to go back to the whole picture.
 */
export function ZoomPane({ children, panDisabled }: ZoomPaneProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [z, setZ] = useState({ k: 1, x: 0, y: 0 });
  const zr = useRef(z);
  zr.current = z;
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

  const bounded = (k: number, x: number, y: number, r: DOMRect) => {
    const mx = (r.width * (k - 1)) / 2;
    const my = (r.height * (k - 1)) / 2;
    return { k, x: clamp(x, -mx, mx), y: clamp(y, -my, my) };
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const cur = zr.current;
      const k = clamp(cur.k * (e.deltaY < 0 ? 1.25 : 0.8), 1, 6);
      // Keep the point under the cursor where it is.
      const px = e.clientX - r.left - r.width / 2;
      const py = e.clientY - r.top - r.height / 2;
      const next = k <= 1.001 ? { k: 1, x: 0, y: 0 } : bounded(k, px - ((px - cur.x) * k) / cur.k, py - ((py - cur.y) * k) / cur.k, r);
      // Update the ref at once: a fast wheel sends several steps before the next render.
      zr.current = next;
      setZ(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const reset = () => setZ({ k: 1, x: 0, y: 0 });

  return (
    <div
      ref={ref}
      className={`zoom ${z.k > 1 ? "zoomed" : ""}`}
      onPointerDown={(e) => {
        if (e.button !== 0 || z.k === 1 || panDisabled) return;
        drag.current = { sx: e.clientX, sy: e.clientY, ox: z.x, oy: z.y, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.sx;
        const dy = e.clientY - d.sy;
        if (!d.moved && Math.abs(dx) + Math.abs(dy) > 4) {
          d.moved = true;
          // Capture only once it is clearly a drag, so a plain click still reaches the video.
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* the pointer is already gone; panning still works while it stays over the view */
          }
        }
        if (d.moved) setZ(bounded(zr.current.k, d.ox + dx, d.oy + dy, e.currentTarget.getBoundingClientRect()));
      }}
      onPointerUp={() => {
        // Leave `moved` set for the click that follows, then clear.
        setTimeout(() => (drag.current = null), 0);
      }}
      onClickCapture={(e) => {
        if (drag.current?.moved) e.stopPropagation();
      }}
      onDoubleClickCapture={(e) => {
        if (z.k > 1) {
          e.stopPropagation();
          reset();
        }
      }}
    >
      <div className="zoom-inner" style={{ transform: `translate(${z.x}px, ${z.y}px) scale(${z.k})` }}>
        {children}
      </div>
      {z.k > 1 && (
        <button className="zoom-badge" onClick={reset} title="Back to the whole picture (double-click)">
          {z.k.toFixed(1)}×<RotateCcw size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- dividers

/** A vertical divider the user drags. `onMove` gets the pointer's x and the parent's box. */
export function Splitter({ label, onMove }: { label: string; onMove: (clientX: number, parent: DOMRect) => void }) {
  const dragging = useRef(false);
  const parentRect = (el: HTMLElement) => (el.parentElement ?? el).getBoundingClientRect();
  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      title="Drag to resize"
      onPointerDown={(e) => {
        dragging.current = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* the pointer is already gone */
        }
      }}
      onPointerMove={(e) => dragging.current && onMove(e.clientX, parentRect(e.currentTarget))}
      onPointerUp={() => (dragging.current = false)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        onMove(r.left + r.width / 2 + (e.key === "ArrowLeft" ? -24 : 24), parentRect(e.currentTarget));
      }}
    />
  );
}

// ---------------------------------------------------------------- side view

/** Buttons in a view's corner: make it the big one, or take it out of split view. */
export function TileBar({ big, onBig, onRemove }: { big: boolean; onBig?: () => void; onRemove?: () => void }) {
  return (
    <div className="tile-bar">
      {onBig && (
        <button className="btn sq" onClick={onBig} aria-label={big ? "Make this view small again" : "Make this the big view"} title={big ? "Back to equal sizes" : "Make this the big view"}>
          {big ? <Shrink size={15} /> : <Expand size={15} />}
        </button>
      )}
      {onRemove && (
        <button className="btn sq" onClick={onRemove} aria-label="Remove this view" title="Remove this view">
          <X size={15} />
        </button>
      )}
    </div>
  );
}

interface SideViewProps {
  pov: Pov;
  /** The video everything else follows: your own recording. */
  masterRef: React.RefObject<HTMLVideoElement | null>;
  muted: boolean;
  volume: number;
  listening: boolean;
  big: boolean;
  show: { trail: boolean; clicks: boolean };
  onListen: () => void;
  onBig: () => void;
  onRemove: () => void;
  onToggle: () => void;
  onFail: () => void;
}

/** One teammate's view in split view, kept on the same game moment as your own video. */
export function SideView({ pov, masterRef, muted, volume, listening, big, show, onListen, onBig, onRemove, onToggle, onFail }: SideViewProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"loading" | "ok" | "outside">("loading");
  const [ratio, setRatio] = useState("16 / 9");
  const mouse = usePovMouse(pov);
  const showRef = useRef(show);
  showRef.current = show;

  useEffect(() => {
    const follow = (hard: boolean) => {
      const v = ref.current;
      const m = masterRef.current;
      if (!v || !m || v.readyState < 1) return;
      const t = m.currentTime + pov.shift;
      const end = Number.isFinite(v.duration) ? v.duration : Infinity;
      if (t < 0 || t > end - 0.05) {
        // Their recording does not cover this moment (they started later or stopped earlier).
        if (!v.paused) v.pause();
        setState("outside");
        return;
      }
      setState((s) => (s === "outside" ? "ok" : s));
      if (hard || Math.abs(v.currentTime - t) > 0.2) v.currentTime = t;
      if (v.playbackRate !== m.playbackRate) v.playbackRate = m.playbackRate;
      if (m.paused && !v.paused) v.pause();
      if (!m.paused && v.paused) v.play().catch(() => {});
    };
    const v = ref.current;
    const onMeta = () => {
      if (v && v.videoWidth && v.videoHeight) setRatio(`${v.videoWidth} / ${v.videoHeight}`);
      follow(true);
    };
    v?.addEventListener("loadedmetadata", onMeta);
    // Checked often rather than wired to the main video's events: the main video
    // element is replaced when the view changes, and a timer cannot go stale.
    const iv = setInterval(() => follow(false), 120);
    return () => {
      clearInterval(iv);
      v?.removeEventListener("loadedmetadata", onMeta);
    };
  }, [pov.video, pov.shift, masterRef]);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.muted = muted;
    ref.current.volume = volume;
  }, [muted, volume]);

  // Their cursor, drawn against their own video's clock.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const v = ref.current;
      const c = canvasRef.current;
      if (v && c) drawMouse(c, mouse, { w: pov.mouseW, h: pov.mouseH }, v.currentTime, showRef.current);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [mouse, pov.mouseW, pov.mouseH]);

  const lane = laneName(pov.position);
  return (
    <div className={`tile ${listening ? "listening" : ""} ${big ? "big" : ""}`}>
      <ZoomPane>
        <div className="frame" style={{ aspectRatio: ratio, width: `min(100cqw, calc(100cqh * ${ratio}))` }}>
          <video
            ref={ref}
            src={pov.video ?? undefined}
            preload="auto"
            muted
            onClick={onToggle}
            onError={onFail}
            onWaiting={() => setState((s) => (s === "outside" ? s : "loading"))}
            onCanPlay={() => setState((s) => (s === "outside" ? s : "ok"))}
          />
          <canvas ref={canvasRef} />
        </div>
      </ZoomPane>
      <TileBar big={big} onBig={onBig} onRemove={onRemove} />
      <button className="tile-label" aria-pressed={listening} onClick={onListen} title={listening ? "You are hearing this view's game sound" : "Hear this view's game sound"}>
        <Portrait championKey={pov.championKey} name={pov.champion} size={22} />
        {pov.friend}
        {lane && <small>{lane}</small>}
        {listening && <Volume2 size={13} aria-label="Sound on" />}
      </button>
      {state !== "ok" && <span className="tile-note">{state === "loading" ? "Loading" : "Their recording does not cover this moment"}</span>}
    </div>
  );
}
