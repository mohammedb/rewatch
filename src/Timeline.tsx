import { Bookmark, MessageSquare, Skull, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ItemIcon, Portrait, type Side } from "./ChampIcon";
import { clock, gameClockAt } from "./format";
import { eventGlyph } from "./icons";
import type { GameEvent } from "./types";

export interface Marker {
  t: number;
  cat: string;
  side: Side;
  label: string;
  e?: GameEvent;
}

interface Props {
  duration: number;
  time: number;
  markers: Marker[];
  /** Team fights, drawn as bands behind the kills. */
  bands?: { start: number; end: number; side: Side }[];
  /** Clicks per minute, one value per `cpmBucket` seconds. */
  cpm: number[];
  cpmBucket: number;
  /** The clip being cut, with handles to drag; null when not cutting one. */
  clip: [number, number] | null;
  looping?: boolean;
  clockSamples: [number, number][];
  champKey: (name?: string) => string | undefined;
  onSeek: (t: number) => void;
  onClip?: (start: number, end: number) => void;
  /** The video to take hover thumbnails from. */
  previewSrc?: string | null;
  /** Width over height of that video. */
  previewRatio?: number;
}

/** Ruler spacing that keeps labels readable for any recording length. */
function tickPlan(duration: number): { minor: number; major: number } {
  if (duration <= 180) return { minor: 10, major: 30 };
  if (duration <= 900) return { minor: 30, major: 120 };
  if (duration <= 2400) return { minor: 60, major: 300 };
  return { minor: 60, major: 600 };
}

/** A hidden copy of the video that seeks to wherever the pointer is, for a thumbnail. */
function usePreview(src: string | null | undefined) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const want = useRef<number | null>(null);
  const busy = useRef(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(false);
    if (!src) return;
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "metadata";
    v.src = src;
    const draw = () => {
      const c = canvas.current;
      if (!c || !v.videoWidth) return;
      c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
      setReady(true);
    };
    const next = () => {
      if (want.current === null || !Number.isFinite(v.duration)) return;
      busy.current = true;
      v.currentTime = Math.min(Math.max(want.current, 0), Math.max(0, v.duration - 0.1));
      want.current = null;
    };
    const onSeeked = () => {
      draw();
      busy.current = false;
      next();
    };
    const onMeta = () => next();
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("loadedmetadata", onMeta);
    video.current = v;
    return () => {
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeAttribute("src");
      v.load();
      video.current = null;
    };
  }, [src]);
  const request = (t: number) => {
    want.current = t;
    const v = video.current;
    if (v && !busy.current && v.readyState >= 1) {
      busy.current = true;
      v.currentTime = Math.min(Math.max(t, 0), Math.max(0, v.duration - 0.1));
      want.current = null;
    }
  };
  return { canvas, request, ready, enabled: !!src };
}

export function Timeline({ duration, time, markers, bands = [], cpm, cpmBucket, clip, looping, clockSamples, champKey, onSeek, onClip, previewSrc, previewRatio = 16 / 9 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const dragging = useRef<"seek" | "l" | "r" | null>(null);
  const preview = usePreview(previewSrc);
  const total = duration || 1;
  const pct = (t: number) => `${(Math.min(Math.max(t, 0), total) / total) * 100}%`;

  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - r.left, 0), r.width);
    return { x, t: (x / r.width) * total };
  };
  const moveEdge = (edge: "l" | "r", t: number) => {
    if (!clip || !onClip) return;
    const minLen = 1;
    if (edge === "l") onClip(Math.min(Math.max(0, t), clip[1] - minLen), clip[1]);
    else onClip(clip[0], Math.max(Math.min(total, t), clip[0] + minLen));
    onSeek(t);
  };

  let tip: { time: number; text: string } | null = null;
  if (hover) {
    const width = ref.current?.getBoundingClientRect().width ?? 1;
    const near = markers
      .map((m) => ({ m, d: Math.abs((m.t / total) * width - hover.x) }))
      .filter((x) => x.d < 11)
      .sort((a, b) => a.d - b.d)[0];
    const game = gameClockAt(clockSamples, hover.t);
    tip = near ? { time: near.m.t, text: near.m.label } : { time: hover.t, text: game !== null ? `${clock(game)} in game` : "" };
  }
  useEffect(() => {
    if (hover && preview.enabled) preview.request(hover.t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover?.t, preview.enabled]);

  const plan = tickPlan(total);
  const ticks: number[] = [];
  for (let t = 0; t <= total; t += plan.minor) ticks.push(t);

  const maxCpm = Math.max(120, ...cpm);
  const line = cpm.map((v, i) => `${(((i + 0.5) * cpmBucket) / total) * 1000},${28 - (v / maxCpm) * 25}`);

  const fights = markers.filter((m) => ["kill", "death", "assist", "fight"].includes(m.cat));
  const objectives = markers.filter((m) => m.cat === "objective" || m.cat === "structure");
  const items = markers.filter((m) => m.cat === "item");
  const summoners = markers.filter((m) => m.cat === "summoner");
  const flags = markers.filter((m) => m.cat === "bookmark" || m.cat === "note" || m.cat === "tnote");
  const tipW = preview.enabled ? 176 : 220;
  const width = ref.current?.clientWidth ?? 0;

  return (
    <div className="tlwrap">
      {hover && tip && (
        <div className={`tip ${preview.enabled ? "withpic" : ""}`} style={{ left: Math.min(Math.max(hover.x, tipW / 2), Math.max(tipW / 2, width - tipW / 2)) }}>
          {preview.enabled && <canvas ref={preview.canvas} width={176} height={Math.round(176 / previewRatio)} className={preview.ready ? "" : "blank"} />}
          <div className="tiptext">
            <b>{clock(tip.time)}</b>
            <span>{tip.text}</span>
          </div>
        </div>
      )}
      <div
        ref={ref}
        className="tl"
        role="slider"
        aria-label="Position in recording"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(time)}
        aria-valuetext={clock(time)}
        tabIndex={0}
        onPointerDown={(e) => {
          dragging.current = "seek";
          e.currentTarget.setPointerCapture(e.pointerId);
          onSeek(at(e.clientX).t);
        }}
        onPointerMove={(e) => {
          const p = at(e.clientX);
          setHover(p);
          if (dragging.current === "seek") onSeek(p.t);
          else if (dragging.current) moveEdge(dragging.current, p.t);
        }}
        onPointerUp={() => (dragging.current = null)}
        onPointerCancel={() => (dragging.current = null)}
        onPointerLeave={() => !dragging.current && setHover(null)}
      >
        <div className="ruler">
          {ticks.map((t) => {
            const major = t % plan.major === 0;
            return (
              <i key={t} className={`tick ${major ? "major" : ""}`} style={{ left: pct(t) }}>
                {major && t < total - plan.minor && <span>{clock(t)}</span>}
              </i>
            );
          })}
        </div>
        <div className="played" style={{ width: pct(time) }} />
        {cpm.length > 1 && (
          <svg className="cpm" viewBox="0 0 1000 28" preserveAspectRatio="none" aria-hidden>
            <polygon points={`0,28 ${line.join(" ")} 1000,28`} fill="rgba(137,148,162,0.13)" />
            <polyline points={line.join(" ")} fill="none" stroke="rgba(137,148,162,0.45)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </svg>
        )}

        {bands.map((b, i) => (
          <div key={i} className={`band ${b.side}`} style={{ left: pct(b.start - 2), width: `max(10px, ${((b.end - b.start + 4) / total) * 100}%)` }} />
        ))}
        <div className="lane" style={{ top: 19, height: 22 }}>
          {fights.map((m, i) => {
            const e = m.e;
            if (!e || e.kind !== "ChampionKill" || m.cat === "fight") {
              return <span key={i} className={`dot ${m.side}`} style={{ left: pct(m.t) }} />;
            }
            // Show who you fought: the victim for your kills, the killer for your deaths.
            const other = m.cat === "death" ? e.killerChamp : e.victimChamp;
            return (
              <span key={i} style={{ left: pct(m.t) }}>
                {other ? (
                  <Portrait championKey={champKey(other)} name={other} size={20} side={m.side} />
                ) : (
                  <span className={`glyph ${m.side}`} style={{ width: 20, height: 20 }}>
                    <Skull size={12} />
                  </span>
                )}
              </span>
            );
          })}
        </div>
        <div className="lane" style={{ top: 43, height: 18 }}>
          {objectives.map((m, i) => {
            const Icon = eventGlyph(m.e!);
            return (
              <span key={i} className={`glyph ${m.side}`} style={{ left: pct(m.t), width: 18, height: 18 }}>
                <Icon size={11} strokeWidth={2.2} />
              </span>
            );
          })}
        </div>
        <div className="lane" style={{ top: 63, height: 18 }}>
          {items.map((m, i) => (
            <span key={i} style={{ left: pct(m.t) }}>
              <ItemIcon id={m.e?.itemId ?? 0} name={m.e?.detail ?? "Item"} size={18} />
            </span>
          ))}
          {summoners.map((m, i) => (
            <span key={`s-${i}`} className="glyph summ" style={{ left: pct(m.t), width: 14, height: 14, top: 2 }} title={m.label}>
              <Zap size={9} fill="currentColor" />
            </span>
          ))}
        </div>

        {flags.map((m, i) =>
          m.cat === "bookmark" ? (
            <Bookmark key={i} className="flag" size={13} fill="currentColor" style={{ left: pct(m.t) }} />
          ) : (
            <MessageSquare key={i} className={`flag note ${m.cat === "tnote" ? "theirs" : ""}`} size={12} fill="currentColor" style={{ left: pct(m.t) }} />
          ),
        )}
        {clip && (
          <div className={`range ${looping ? "loop" : ""}`} style={{ left: pct(clip[0]), width: `${((Math.min(clip[1], total) - clip[0]) / total) * 100}%` }}>
            {(["l", "r"] as const).map((edge) => (
              <span
                key={edge}
                className={`h ${edge}`}
                role="slider"
                tabIndex={0}
                aria-label={edge === "l" ? "Clip start" : "Clip end"}
                aria-valuemin={0}
                aria-valuemax={Math.round(total)}
                aria-valuenow={Math.round(edge === "l" ? clip[0] : clip[1])}
                aria-valuetext={clock(edge === "l" ? clip[0] : clip[1])}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  dragging.current = edge;
                  ref.current?.setPointerCapture(e.pointerId);
                }}
                onKeyDown={(e) => {
                  const d = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
                  if (!d) return;
                  e.preventDefault();
                  e.stopPropagation();
                  moveEdge(edge, (edge === "l" ? clip[0] : clip[1]) + d * (e.shiftKey ? 5 : 1));
                }}
              />
            ))}
          </div>
        )}
        {hover && <div className="ghost" style={{ left: hover.x }} />}
        <div className="head" style={{ left: pct(time) }} />
      </div>
    </div>
  );
}
