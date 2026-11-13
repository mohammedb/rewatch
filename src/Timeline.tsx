import { Bookmark, MessageSquare, Skull, Zap } from "lucide-react";
import { useRef, useState } from "react";
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
  inPt: number | null;
  outPt: number | null;
  looping?: boolean;
  clockSamples: [number, number][];
  champKey: (name?: string) => string | undefined;
  onSeek: (t: number) => void;
}

/** Ruler spacing that keeps labels readable for any recording length. */
function tickPlan(duration: number): { minor: number; major: number } {
  if (duration <= 180) return { minor: 10, major: 30 };
  if (duration <= 900) return { minor: 30, major: 120 };
  if (duration <= 2400) return { minor: 60, major: 300 };
  return { minor: 60, major: 600 };
}

export function Timeline({ duration, time, markers, bands = [], cpm, cpmBucket, inPt, outPt, looping, clockSamples, champKey, onSeek }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const dragging = useRef(false);
  const total = duration || 1;
  const pct = (t: number) => `${(Math.min(Math.max(t, 0), total) / total) * 100}%`;

  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - r.left, 0), r.width);
    return { x, t: (x / r.width) * total };
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

  const plan = tickPlan(total);
  const ticks: number[] = [];
  for (let t = 0; t <= total; t += plan.minor) ticks.push(t);

  const maxCpm = Math.max(120, ...cpm);
  const line = cpm.map((v, i) => `${(((i + 0.5) * cpmBucket) / total) * 1000},${34 - (v / maxCpm) * 30}`);

  const fights = markers.filter((m) => ["kill", "death", "assist", "fight"].includes(m.cat));
  const objectives = markers.filter((m) => m.cat === "objective" || m.cat === "structure");
  const items = markers.filter((m) => m.cat === "item");
  const summoners = markers.filter((m) => m.cat === "summoner");
  const flags = markers.filter((m) => m.cat === "bookmark" || m.cat === "note" || m.cat === "tnote");

  return (
    <div className="tlwrap">
      {hover && tip && (
        <div className="tip" style={{ left: Math.min(Math.max(hover.x, 110), (ref.current?.clientWidth ?? 0) - 110) }}>
          <b>{clock(tip.time)}</b>
          {tip.text}
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
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          onSeek(at(e.clientX).t);
        }}
        onPointerMove={(e) => {
          const p = at(e.clientX);
          setHover(p);
          if (dragging.current) onSeek(p.t);
        }}
        onPointerUp={() => (dragging.current = false)}
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
        {inPt !== null && outPt !== null && outPt > inPt && (
          <div className={`range ${looping ? "loop" : ""}`} style={{ left: pct(inPt), width: `${((outPt - inPt) / total) * 100}%` }} />
        )}
        {cpm.length > 1 && (
          <svg className="cpm" viewBox="0 0 1000 34" preserveAspectRatio="none" aria-hidden>
            <polygon points={`0,34 ${line.join(" ")} 1000,34`} fill="rgba(137,148,162,0.16)" />
            <polyline points={line.join(" ")} fill="none" stroke="rgba(137,148,162,0.6)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </svg>
        )}

        {bands.map((b, i) => (
          <div key={i} className={`band ${b.side}`} style={{ left: pct(b.start - 2), width: `max(10px, ${((b.end - b.start + 4) / total) * 100}%)` }} />
        ))}
        <div className="lane" style={{ top: 25, height: 24 }}>
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
                  <Portrait championKey={champKey(other)} name={other} size={22} side={m.side} />
                ) : (
                  <span className={`glyph ${m.side}`} style={{ width: 22, height: 22 }}><Skull size={13} /></span>
                )}
              </span>
            );
          })}
        </div>
        <div className="lane" style={{ top: 54, height: 22 }}>
          {objectives.map((m, i) => {
            const Icon = eventGlyph(m.e!);
            return (
              <span key={i} className={`glyph ${m.side}`} style={{ left: pct(m.t), width: 21, height: 21 }}>
                <Icon size={13} strokeWidth={2.2} />
              </span>
            );
          })}
        </div>
        <div className="lane" style={{ top: 82, height: 22 }}>
          {items.map((m, i) => (
            <span key={i} style={{ left: pct(m.t) }}>
              <ItemIcon id={m.e?.itemId ?? 0} name={m.e?.detail ?? "Item"} size={21} />
            </span>
          ))}
          {summoners.map((m, i) => (
            <span key={`s-${i}`} className="glyph summ" style={{ left: pct(m.t), width: 16, height: 16, top: 3 }} title={m.label}>
              <Zap size={10} fill="currentColor" />
            </span>
          ))}
        </div>

        {flags.map((m, i) =>
          m.cat === "bookmark" ? (
            <Bookmark key={i} className="flag" size={15} fill="currentColor" style={{ left: pct(m.t) }} />
          ) : (
            <MessageSquare key={i} className={`flag note ${m.cat === "tnote" ? "theirs" : ""}`} size={14} fill="currentColor" style={{ left: pct(m.t) }} />
          ),
        )}
        {hover && <div className="ghost" style={{ left: hover.x }} />}
        <div className="head" style={{ left: pct(time) }} />
      </div>
    </div>
  );
}
