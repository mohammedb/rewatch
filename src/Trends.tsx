import { ArrowDown, ArrowUp, BarChart3, CalendarClock, Crosshair, Loader2, MapPin, Minus, NotebookPen, Play, RotateCcw, Skull, Swords, Table2, Users, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api } from "./api";
import type { Playlist, PlaylistItem } from "./App";
import { Portrait } from "./ChampIcon";
import { clock, dayLabel, laneName, timeOfDay } from "./format";
import { hasMap, MapView, type MapDot } from "./MapView";
import { LpDelta, RankCard } from "./Rank";
import { Kda, KdaRatio, kdaTier, WinRate } from "./Stats";
import type { FocusCheck, MatchupNote, TrendMatch, TrendSpot } from "./types";
import { humanError, Select, Skeleton, useToast, type Option } from "./ui";

interface Props {
  onOpen: (id: string) => void;
  /** Start a walk-through across games. */
  onPlaylist: (p: Playlist) => void;
  onSettings?: () => void;
  /** Losses in a row after which Rewatch suggests a break; 0 when off. */
  breakAfter?: number;
}

const DAY = 86_400_000;

type Range = "7" | "30" | "90" | "all";
const RANGES: { id: Range; label: string; before: string; last: string }[] = [
  { id: "7", label: "7 days", before: "the week before", last: "in the last 7 days" },
  { id: "30", label: "30 days", before: "the 30 days before", last: "in the last 30 days" },
  { id: "90", label: "90 days", before: "the 90 days before", last: "in the last 90 days" },
  { id: "all", label: "All time", before: "", last: "in all" },
];
const RANGE_KEY = "rewatch.trends.range";

function savedRange(): Range | null {
  try {
    const v = localStorage.getItem(RANGE_KEY);
    return v === "7" || v === "30" || v === "90" || v === "all" ? v : null;
  } catch {
    return null;
  }
}

const CAUSES: Record<string, string> = {
  no_vision: "Caught without vision",
  overextended: "Overextended",
  engage_no_followup: "Engaged without follow-up",
  outnumbered: "Outnumbered",
  tower_dive: "Tower dive",
  lost_even_fight: "Lost an even fight",
  worth_it: "Fair trade",
};

const QUEUES: { id: string; label: string; test: (q?: number | null) => boolean }[] = [
  { id: "420", label: "Ranked Solo/Duo", test: (q) => q === 420 },
  { id: "440", label: "Ranked Flex", test: (q) => q === 440 },
  { id: "normal", label: "Normal", test: (q) => q === 400 || q === 430 || q === 490 },
  { id: "450", label: "ARAM", test: (q) => q === 450 },
];
const ROLES = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];

const FOCUS_WORD: Record<FocusCheck["answer"], string> = { yes: "Did it", partly: "Partly", no: "Not really" };

/** "4 games: did it in 2, partly in 1, not in 1". */
function focusSummary(yes: number, partly: number, n: number): string {
  const parts = [yes && `did it in ${yes}`, partly && `partly in ${partly}`, n - yes - partly && `not in ${n - yes - partly}`].filter(Boolean);
  return `${plural(n, "game")}: ${parts.join(", ")}`;
}

const minutes = (r: TrendMatch) => Math.max(1, r.length / 60);
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

// ------------------------------------------------------------------ numbers

interface Totals {
  n: number;
  wins: number;
  losses: number;
  /** 0 to 100, over the games that had a winner. */
  winRate: number | null;
  kda: number | null;
  k: number;
  d: number;
  a: number;
  cspm: number | null;
  cs10: number | null;
  dead: number | null;
  /** Vision score a minute. */
  vision: number | null;
}

function totals(rows: TrendMatch[]): Totals {
  const n = rows.length;
  const wins = rows.filter((r) => r.result === "Win").length;
  const losses = rows.filter((r) => r.result === "Lose").length;
  const k = rows.reduce((s, r) => s + r.kills, 0);
  const d = rows.reduce((s, r) => s + r.deaths, 0);
  const a = rows.reduce((s, r) => s + r.assists, 0);
  const mins = rows.reduce((s, r) => s + minutes(r), 0);
  const seen = rows.filter((r) => r.wards != null);
  return {
    n,
    wins,
    losses,
    winRate: wins + losses ? (wins / (wins + losses)) * 100 : null,
    kda: n ? (k + a) / Math.max(1, d) : null,
    k: n ? k / n : 0,
    d: n ? d / n : 0,
    a: n ? a / n : 0,
    cspm: n ? rows.reduce((s, r) => s + r.cs, 0) / mins : null,
    cs10: mean(rows.flatMap((r) => (r.cs10 == null ? [] : [r.cs10]))),
    dead: mean(rows.flatMap((r) => (r.deadPct == null ? [] : [r.deadPct]))),
    vision: seen.length ? seen.reduce((s, r) => s + (r.wards ?? 0), 0) / seen.reduce((s, r) => s + minutes(r), 0) : null,
  };
}

interface Tile {
  key: string;
  label: string;
  value: (t: Totals) => number | null;
  fmt: (v: number) => string;
  /** The size of a change, without its sign: "6 pts", "0.40". */
  delta: (d: number) => string;
  better: "up" | "down";
  /** A change smaller than this reads as no change. */
  still: number;
  foot: (t: Totals) => string;
}

const TILES: Tile[] = [
  {
    key: "wr",
    label: "Win rate",
    value: (t) => t.winRate,
    fmt: (v) => `${Math.round(v)}%`,
    delta: (d) => `${Math.round(Math.abs(d))} pts`,
    better: "up",
    still: 1,
    foot: (t) => `${t.wins} won, ${t.losses} lost`,
  },
  {
    key: "kda",
    label: "KDA",
    value: (t) => t.kda,
    fmt: (v) => v.toFixed(2),
    delta: (d) => Math.abs(d).toFixed(2),
    better: "up",
    still: 0.05,
    foot: (t) => `${t.k.toFixed(1)} / ${t.d.toFixed(1)} / ${t.a.toFixed(1)} a game`,
  },
  {
    key: "cspm",
    label: "CS per minute",
    value: (t) => t.cspm,
    fmt: (v) => v.toFixed(1),
    delta: (d) => Math.abs(d).toFixed(1),
    better: "up",
    still: 0.05,
    foot: (t) => (t.cs10 != null ? `${Math.round(t.cs10)} by 10 minutes` : "No early numbers"),
  },
  {
    key: "dead",
    label: "Time spent dead",
    value: (t) => t.dead,
    fmt: (v) => `${Math.round(v)}%`,
    delta: (d) => `${Math.round(Math.abs(d))} pts`,
    better: "down",
    still: 1,
    foot: () => "of each game, on average",
  },
  {
    key: "vision",
    label: "Vision per minute",
    value: (t) => t.vision,
    fmt: (v) => v.toFixed(2),
    delta: (d) => Math.abs(d).toFixed(2),
    better: "up",
    still: 0.02,
    foot: () => "vision score",
  },
];

function KpiTile({ tile, now, before, period }: { tile: Tile; now: Totals; before: Totals | null; period: string }) {
  const v = tile.value(now);
  const pv = before ? tile.value(before) : null;
  const d = v != null && pv != null ? v - pv : null;
  const flat = d != null && Math.abs(d) < tile.still;
  const good = d != null && !flat && d > 0 === (tile.better === "up");
  return (
    <div className="kpi">
      <span className="k-l">{tile.label}</span>
      <b className="k-v">{v != null ? tile.fmt(v) : "—"}</b>
      {d != null && pv != null && (
        <span className={`k-d ${flat ? "flat" : good ? "good" : "bad"}`} title={`${tile.fmt(pv)} in ${period}`}>
          {flat ? <Minus size={13} aria-hidden /> : d > 0 ? <ArrowUp size={13} aria-hidden /> : <ArrowDown size={13} aria-hidden />}
          {flat ? "No change" : <><span className="sr-only">{d > 0 ? "Up" : "Down"}</span>{tile.delta(d)}</>}
          <span className="vs">vs {period}</span>
        </span>
      )}
      <span className="k-f">{tile.foot(now)}</span>
    </div>
  );
}

// ------------------------------------------------------------------ game-by-game charts

interface Series {
  key: string;
  label: string;
  better: "up" | "down";
  value: (r: TrendMatch) => number | null;
  fmt: (v: number) => string;
  pct?: boolean;
  /** Only in games with Riot's record of them: hidden until there are some. */
  riot?: boolean;
}

const signedNum = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v)).toLocaleString()}`;

const SERIES: Series[] = [
  { key: "dead", label: "Time spent dead", better: "down", value: (r) => r.deadPct ?? null, fmt: (v) => `${Math.round(v)}%`, pct: true },
  { key: "cs10", label: "CS by 10 minutes", better: "up", value: (r) => r.cs10 ?? null, fmt: (v) => `${Math.round(v)}` },
  { key: "cspm", label: "CS per minute", better: "up", value: (r) => r.cs / minutes(r), fmt: (v) => v.toFixed(1) },
  { key: "vision", label: "Vision per minute", better: "up", value: (r) => (r.wards == null ? null : r.wards / minutes(r)), fmt: (v) => v.toFixed(2) },
  { key: "gold15", label: "Gold lead at 15 minutes", better: "up", value: (r) => r.pg?.gold15 ?? null, fmt: signedNum, riot: true },
  {
    key: "dmg",
    label: "Share of your team's damage",
    better: "up",
    value: (r) => (r.pg?.dmgShare == null ? null : r.pg.dmgShare * 100),
    fmt: (v) => `${Math.round(v)}%`,
    pct: true,
    riot: true,
  },
];

/** The average of the last `win` games that have a number, at each game that has one. */
function rolling(vals: (number | null)[], win: number): (number | null)[] {
  const need = Math.min(3, vals.filter((v) => v != null).length);
  return vals.map((v, i) => {
    if (v == null || need === 0) return null;
    const xs = vals.slice(Math.max(0, i - win + 1), i + 1).filter((x): x is number => x != null);
    return xs.length >= need ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  });
}

/** Round numbers for the y axis that cover lo..hi, about four of them. */
function yScale(lo: number, hi: number): { ticks: number[]; lo: number; hi: number; dec: number } {
  if (!(hi > lo)) {
    const pad = Math.max(1, Math.abs(lo) * 0.1);
    lo -= pad;
    hi += pad;
  }
  const mag = 10 ** Math.floor(Math.log10((hi - lo) / 3));
  const step = [1, 2, 5, 10].map((s) => s * mag).find((s) => (hi - lo) / s <= 3.5) ?? 10 * mag;
  const a = Math.floor(lo / step) * step;
  const b = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = a; v <= b + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return { ticks, lo: a, hi: b, dec: Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) };
}

const PLOT_H = 118;
const TOP = 10;
const AXIS = 24;
const LEFT = 38;
const RIGHT = 46;
const H = TOP + PLOT_H + AXIS;

interface Hover {
  i: number;
  /** The chart the pointer or keyboard is in: only it shows the readout. */
  chart: string;
}

function TrendChart({
  s,
  games,
  win,
  hover,
  onHover,
  onOpen,
}: {
  s: Series;
  /** Oldest first. */
  games: TrendMatch[];
  win: number;
  hover: Hover | null;
  onHover: (h: Hover | null) => void;
  onOpen: (id: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => setW(Math.floor(es[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = games.length;
  const { vals, avg, sc, last } = useMemo(() => {
    const vals = games.map(s.value);
    const avg = rolling(vals, win);
    const known = [...vals, ...avg].filter((v): v is number => v != null);
    const sc = known.length ? yScale(Math.min(...known), Math.max(...known)) : null;
    let last = -1;
    avg.forEach((v, i) => {
      if (v != null) last = i;
    });
    return { vals, avg, sc, last };
  }, [games, s, win]);

  const at = hover ? Math.min(hover.i, n - 1) : null;
  const own = hover?.chart === s.key;
  const plotW = Math.max(10, w - LEFT - RIGHT);
  const x = (i: number) => LEFT + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (v: number) => (sc ? TOP + PLOT_H - ((v - sc.lo) / (sc.hi - sc.lo)) * PLOT_H : TOP + PLOT_H / 2);
  const tick = (v: number) => `${v.toFixed(sc?.dec ?? 0)}${s.pct ? "%" : ""}`;
  const r = n > 60 ? 2.5 : 4;

  const pick = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || n <= 1) return 0;
    return Math.max(0, Math.min(n - 1, Math.round(((clientX - rect.left - LEFT) / plotW) * (n - 1))));
  };

  const onKey = (e: KeyboardEvent) => {
    if (!n) return;
    const cur = at ?? n - 1;
    const go = (i: number) => {
      e.preventDefault();
      onHover({ i, chart: s.key });
    };
    if (e.key === "ArrowLeft") go(Math.max(0, cur - 1));
    else if (e.key === "ArrowRight") go(Math.min(n - 1, cur + 1));
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(n - 1);
    else if (e.key === "Enter" && at != null) {
      e.preventDefault();
      onOpen(games[at].id);
    } else if (e.key === "Escape") onHover(null);
  };

  let path = "";
  avg.forEach((v, i) => {
    if (v != null) path += `${path ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });

  const known = vals.filter((v) => v != null).length;
  const summary =
    last >= 0 && sc ? `${plural(known, "game")}, ${win}-game average now ${s.fmt(avg[last]!)}` : known ? plural(known, "game") : "No numbers yet";
  const g = at != null ? games[at] : null;
  const tipRight = at != null && x(at) > w - 200;

  return (
    <section className="chart">
      <header className="ch-h">
        <h3>{s.label}</h3>
        <small>{s.better === "down" ? "Lower is better" : "Higher is better"}</small>
      </header>
      {!sc ? (
        <p className="ch-none">No numbers for this in these games.</p>
      ) : (
        <div
          ref={box}
          className="plot"
          tabIndex={0}
          role="group"
          aria-label={`${s.label}: ${summary}. Arrow keys go through the games, Enter opens one.`}
          onPointerMove={(e) => onHover({ i: pick(e.clientX), chart: s.key })}
          onPointerLeave={() => onHover(null)}
          onClick={(e) => onOpen(games[pick(e.clientX)].id)}
          onKeyDown={onKey}
          onFocus={() => {
            if (at == null) onHover({ i: n - 1, chart: s.key });
          }}
          onBlur={() => onHover(null)}
        >
          {w > 0 && (
            <svg width={w} height={H} aria-hidden>
              {sc.ticks.map((t) => (
                <line key={`g${t}`} className="grid" x1={LEFT} x2={w - RIGHT + 10} y1={y(t)} y2={y(t)} />
              ))}
              {sc.ticks.map((t) => (
                <text key={`t${t}`} className="ax" x={LEFT - 8} y={y(t) + 3.5} textAnchor="end">
                  {tick(t)}
                </text>
              ))}
              {at != null && <line className="cross" x1={x(at)} x2={x(at)} y1={TOP - 6} y2={TOP + PLOT_H + 4} />}
              {vals.map((v, i) => (v == null ? null : <circle key={games[i].id} className={`dot ${r < 4 ? "dense" : ""}`} cx={x(i)} cy={y(v)} r={r} />))}
              <path className="avg" d={path} />
              {last >= 0 && (
                <>
                  <circle className="end" cx={x(last)} cy={y(avg[last]!)} r={4} />
                  <text className="endl" x={x(last) + 9} y={y(avg[last]!) + 4}>
                    {s.fmt(avg[last]!)}
                  </text>
                </>
              )}
              {at != null && vals[at] != null && <circle className="hot" cx={x(at)} cy={y(vals[at]!)} r={5} />}
              {at != null && avg[at] != null && <circle className="hotavg" cx={x(at)} cy={y(avg[at]!)} r={4} />}
              <text className="ax" x={x(0)} y={H - 6} textAnchor={n > 1 ? "start" : "middle"}>
                {shortDate(games[0].startedEpochMs)}
              </text>
              {n > 1 && (
                <text className="ax" x={x(n - 1)} y={H - 6} textAnchor="end">
                  {shortDate(games[n - 1].startedEpochMs)}
                </text>
              )}
            </svg>
          )}
          {own && g && at != null && (
            <div className="tt" style={tipRight ? { right: w - x(at) + 12 } : { left: x(at) + 12 }} aria-live="polite">
              <div className="tv">
                <b>{vals[at] != null ? s.fmt(vals[at]!) : "—"}</b>
                <span>this game</span>
              </div>
              {avg[at] != null && (
                <div className="tv">
                  <i className="lk" aria-hidden />
                  <b>{s.fmt(avg[at]!)}</b>
                  <span>{win}-game average</span>
                </div>
              )}
              <div className="tg">
                <Portrait championKey={g.championKey ?? undefined} name={g.champion} size={18} />
                <span className="nm">{g.champion}</span>
                {g.result && <span className={`res ${g.result === "Win" ? "win" : "lose"}`}>{g.result === "Win" ? "Won" : "Lost"}</span>}
              </div>
              <div className="tw">
                {dayLabel(g.startedEpochMs)}, {timeOfDay(g.startedEpochMs)} · click to watch
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ where you die

type Phase = "all" | "early" | "mid" | "late";
const PHASES: { id: Phase; label: string; test: (t: number) => boolean }[] = [
  { id: "all", label: "Whole game", test: () => true },
  { id: "early", label: "First 14 min", test: (t) => t < 840 },
  { id: "mid", label: "14 to 25 min", test: (t) => t >= 840 && t < 1500 },
  { id: "late", label: "After 25 min", test: (t) => t >= 1500 },
];
const MAP_NAMES: Record<number, string> = { 11: "Summoner's Rift", 12: "Howling Abyss" };

function spotWords(s: TrendSpot, deaths: boolean): string {
  if (deaths) return s.other ? `${s.other} killed you` : "You were executed";
  return s.other ? `You killed ${s.other}` : "You got a kill";
}

/** Every kill or death of yours in the games shown, on the map. Each plays that moment. */
function SpotsCard({ rows, onPlaylist, onSettings }: { rows: TrendMatch[]; onPlaylist: (p: Playlist) => void; onSettings?: () => void }) {
  const [what, setWhat] = useState<"deaths" | "kills">("deaths");
  const [phase, setPhase] = useState<Phase>("all");
  const [mapPick, setMapPick] = useState<number | null>(null);
  const maps = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of rows) if (r.pg && hasMap(r.pg.mapId)) m.set(r.pg.mapId, (m.get(r.pg.mapId) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }, [rows]);
  const mapId: number | undefined = mapPick != null && maps.includes(mapPick) ? mapPick : maps[0];
  const deaths = what === "deaths";
  const spots = useMemo(() => {
    const test = PHASES.find((p) => p.id === phase)!.test;
    if (mapId == null) return [];
    return rows.flatMap((r) => (r.pg && r.pg.mapId === mapId ? (deaths ? r.pg.deaths : r.pg.kills).filter((s) => test(s.t)).map((s) => ({ r, s })) : []));
  }, [rows, mapId, deaths, phase]);
  const top = useMemo(() => {
    const m = new Map<string, { name: string; key: string | null; n: number }>();
    for (const { s } of spots) {
      const name = s.other ?? (deaths ? "Executed" : "Unknown");
      const e = m.get(name) ?? { name, key: s.otherKey, n: 0 };
      e.n++;
      m.set(name, e);
    }
    return [...m.values()].sort((a, b) => b.n - a.n).slice(0, 5);
  }, [spots, deaths]);

  const title = deaths ? "Where you die" : "Where you get kills";
  const item = ({ r, s }: { r: TrendMatch; s: TrendSpot }): PlaylistItem => ({
    matchId: r.id,
    t: s.v!,
    start: Math.max(0, s.v! - 12),
    end: s.v! + 3,
    label: `${spotWords(s, deaths)}, ${r.champion}, ${dayLabel(r.startedEpochMs)}`,
  });
  const playable = spots.filter((x) => x.s.v != null);
  const watchAll = () => {
    // Newest game first, and in the order they happened within each game.
    const list = [...playable].sort((a, b) => b.r.startedEpochMs - a.r.startedEpochMs || a.s.t - b.s.t);
    if (list.length) onPlaylist({ title, items: list.map(item), index: 0 });
  };
  const dots: MapDot[] = spots.map(({ r, s }, i) => ({
    key: `${r.id}-${i}`,
    x: s.x,
    y: s.y,
    tone: deaths ? "death" : "kill",
    label: spotWords(s, deaths),
    detail: `${r.champion}, ${dayLabel(r.startedEpochMs)}, ${clock(s.t)} into the game`,
    onPick: s.v != null ? () => onPlaylist({ title, items: [item({ r, s })], index: 0 }) : undefined,
  }));
  const games = new Set(spots.map((x) => x.r.id)).size;

  return (
    <section className="tcard spots">
      <header className="tc-h">
        <h2>
          <MapPin size={15} aria-hidden />
          {title}
        </h2>
        {mapId != null && <p>Your {what} in the games shown, from Riot's record of each game. Pick one to watch it.</p>}
      </header>
      {mapId == null ? (
        <div className="tc-empty">
          <p>
            After each game Rewatch reads where every kill happened, from the League client or from Riot with an API key. Once it has some of your games, your deaths show up
            here on the map, and each one plays.
          </p>
          {onSettings && (
            <button className="btn sm" onClick={onSettings}>
              Open Settings
            </button>
          )}
        </div>
      ) : (
        <div className="sp-body">
          <MapView
            mapId={mapId}
            dots={dots}
            label={`${title} on ${MAP_NAMES[mapId] ?? "the map"}: ${plural(spots.length, deaths ? "death" : "kill")}`}
            empty={phase === "all" ? `No ${what} in these games.` : `No ${what} at this point of the game.`}
          />
          <div className="sp-side">
            <div className="seg" role="group" aria-label="Deaths or kills">
              <button aria-pressed={deaths} onClick={() => setWhat("deaths")}>
                Deaths
              </button>
              <button aria-pressed={!deaths} onClick={() => setWhat("kills")}>
                Kills
              </button>
            </div>
            <div className="sp-filters">
              <Select small label="When in the game" value={phase} onChange={setPhase} options={PHASES.map((p) => ({ value: p.id, label: p.label }))} />
              {maps.length > 1 && (
                <Select small label="Map" value={mapId} onChange={setMapPick} options={maps.map((m) => ({ value: m, label: MAP_NAMES[m] ?? `Map ${m}` }))} />
              )}
            </div>
            <p className="sp-count">
              <b className="num">{spots.length}</b> {deaths ? (spots.length === 1 ? "death" : "deaths") : spots.length === 1 ? "kill" : "kills"} in {plural(games, "game")}
            </p>
            {playable.length > 0 && (
              <button className="btn sm" onClick={watchAll}>
                <Play size={13} aria-hidden />
                {playable.length === 1 ? "Watch it" : `Watch all ${playable.length}`}
              </button>
            )}
            {top.length > 0 && (
              <>
                <h3 className="sp-h">{deaths ? "Who kills you most" : "Who you kill most"}</h3>
                <ul className="sp-top">
                  {top.map((e) => (
                    <li key={e.name}>
                      <Portrait championKey={e.key ?? undefined} name={e.name} size={20} />
                      <span>{e.name}</span>
                      <b className="num">{e.n}</b>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ sittings

/** An hour without a game ends a sitting, as for the "stop for today?" notice. */
const SITTING_GAP = 60 * 60_000;
/** A game shorter than this was a remake: no loss. */
const REMAKE = 300;

interface Sitting {
  games: TrendMatch[];
  start: number;
  end: number;
  wins: number;
  losses: number;
  /** LP over the sitting's ranked games, and whether it is known for each of them. */
  lp: number | null;
  lpAll: boolean;
}

const lost = (r: TrendMatch) => r.result === "Lose" && r.length >= REMAKE;

/** Games, oldest first, cut into sittings. */
function sittingsOf(rows: TrendMatch[]): Sitting[] {
  const out: Sitting[] = [];
  for (const r of rows) {
    const end = r.startedEpochMs + r.length * 1000;
    const cur = out[out.length - 1];
    if (cur && r.startedEpochMs - cur.end <= SITTING_GAP) {
      cur.games.push(r);
      cur.end = Math.max(cur.end, end);
    } else {
      out.push({ games: [r], start: r.startedEpochMs, end, wins: 0, losses: 0, lp: null, lpAll: true });
    }
  }
  for (const s of out) {
    s.wins = s.games.filter((g) => g.result === "Win").length;
    s.losses = s.games.filter(lost).length;
    const ranked = s.games.filter((g) => g.rank);
    const known = ranked.filter((g) => g.rank!.delta != null);
    s.lp = known.length ? known.reduce((a, g) => a + g.rank!.delta!, 0) : null;
    s.lpAll = known.length === ranked.length;
  }
  return out;
}

const lpText = (lp: number | null, all = true) => (lp == null ? "—" : `${signedNum(lp)}${all ? "" : "+?"} LP`);
const lpClass = (lp: number | null) => `lp ${lp != null && lp > 0 ? "up" : lp != null && lp < 0 ? "down" : ""}`;

/** Today, LP sitting by sitting, and how games go after two losses in a row. */
function SessionsCard({ rows, breakAfter, onOpen, onSettings }: { rows: TrendMatch[]; breakAfter?: number; onOpen: (id: string) => void; onSettings?: () => void }) {
  const [more, setMore] = useState(false);
  const sittings = useMemo(() => sittingsOf(rows), [rows]);
  const midnight = useMemo(() => new Date().setHours(0, 0, 0, 0), []);
  const today = useMemo(() => {
    const games = rows.filter((r) => r.startedEpochMs >= midnight);
    const known = games.filter((g) => g.rank?.delta != null);
    return {
      games,
      wins: games.filter((g) => g.result === "Win").length,
      losses: games.filter(lost).length,
      lp: known.length ? known.reduce((a, g) => a + g.rank!.delta!, 0) : null,
      lpAll: known.length === games.filter((g) => g.rank).length,
    };
  }, [rows, midnight]);
  // Games right after two losses in a row in the same sitting, against every game.
  const tilt = useMemo(() => {
    let n = 0;
    let w = 0;
    for (const s of sittings) {
      const decided = s.games.filter((g) => g.result === "Win" || lost(g));
      for (let i = 2; i < decided.length; i++) {
        if (lost(decided[i - 1]) && lost(decided[i - 2])) {
          n++;
          if (decided[i].result === "Win") w++;
        }
      }
    }
    const wins = rows.filter((r) => r.result === "Win").length;
    const all = wins + rows.filter(lost).length;
    return { n, w, overall: all ? Math.round((wins / all) * 100) : null };
  }, [sittings, rows]);
  const newest = [...sittings].reverse();
  const shown = more ? newest : newest.slice(0, 6);

  return (
    <section className="tcard sessions">
      <header className="tc-h">
        <h2>
          <CalendarClock size={15} aria-hidden />
          Sessions
        </h2>
        <p>Games with less than an hour between them make one sitting. Pick a game to open it.</p>
      </header>
      <div className="ss-stats">
        <div>
          <span>Today</span>
          <b className="num">{today.games.length ? `${today.wins}–${today.losses}` : "No games yet"}</b>
          {today.games.length > 0 && (
            <small>
              <span className={lpClass(today.lp)}>{lpText(today.lp, today.lpAll)}</span> over {plural(today.games.length, "game")}
            </small>
          )}
        </div>
        <div>
          <span>After two losses in a row</span>
          <b className="num">{tilt.n >= 3 ? `${Math.round((tilt.w / tilt.n) * 100)}% won` : "—"}</b>
          <small>
            {tilt.n >= 3
              ? `${tilt.w} of ${plural(tilt.n, "game")}${tilt.overall != null ? `, against ${tilt.overall}% over all` : ""}`
              : tilt.n
                ? `Only ${plural(tilt.n, "game")} so far`
                : "No game came after two losses in a row"}
          </small>
        </div>
        <div>
          <span>"Stop for today?"</span>
          <b>{breakAfter ? `After ${breakAfter} losses` : "Off"}</b>
          <small>
            {breakAfter ? "in a row, in the notice after the game" : "A notice can suggest a break"}
            {onSettings && (
              <>
                {" · "}
                <button className="btn link" onClick={onSettings}>
                  {breakAfter ? "Change" : "Turn on"}
                </button>
              </>
            )}
          </small>
        </div>
      </div>
      <h3 className="sp-h">LP by sitting</h3>
      <ul className="sittings">
        {shown.map((s) => (
          <li key={s.start}>
            <span className="st-when">
              {dayLabel(s.start)} · {timeOfDay(s.start)} to {timeOfDay(s.end)}
            </span>
            <span className="st-games">
              {s.games.map((g) => (
                <button
                  key={g.id}
                  className={`sgame ${g.result === "Win" ? "w" : lost(g) ? "l" : ""}`}
                  onClick={() => onOpen(g.id)}
                  title={`${g.champion}, ${g.result === "Win" ? "won" : lost(g) ? "lost" : "no result"}${g.rank?.delta != null ? `, ${signedNum(g.rank.delta)} LP` : ""}`}
                  aria-label={`${g.champion}, ${g.result === "Win" ? "won" : lost(g) ? "lost" : "no result"}. Open the game.`}
                >
                  <Portrait championKey={g.championKey ?? undefined} name={g.champion} size={22} />
                </button>
              ))}
            </span>
            <span className="st-rec num">
              {s.wins}–{s.losses}
            </span>
            <span className={`st-lp num ${lpClass(s.lp)}`}>{lpText(s.lp, s.lpAll)}</span>
          </li>
        ))}
      </ul>
      {newest.length > 6 && (
        <button className="btn link more" onClick={() => setMore((v) => !v)}>
          {more ? "Show fewer" : `Show all ${newest.length}`}
        </button>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ matchups

/** Deaths in the first 14 minutes count as early: the laning phase. */
const EARLY = 840;

interface Matchup {
  name: string;
  key: string | null;
  games: TrendMatch[];
  wins: number;
  losses: number;
  lp: number | null;
  gold10: number | null;
  gold15: number | null;
  early: { r: TrendMatch; s: TrendSpot }[];
}

/** A note on one matchup, saved when the box loses focus. */
function NoteBox({ champion, note, onSave }: { champion: string; note?: MatchupNote; onSave: (text: string) => Promise<void> }) {
  const [text, setText] = useState(note?.text ?? "");
  const [state, setState] = useState<"" | "saving" | "saved" | "error">("");
  const id = `mu-note-${champion.replace(/[^A-Za-z0-9]/g, "")}`;
  const commit = () => {
    if (text.trim() === (note?.text ?? "")) return;
    setState("saving");
    onSave(text.trim()).then(
      () => setState("saved"),
      () => setState("error"),
    );
  };
  return (
    <div className="mu-note">
      <label htmlFor={id}>Your notes on {champion}</label>
      <textarea
        id={id}
        className="field-input"
        rows={3}
        maxLength={2000}
        value={text}
        placeholder={`What works against ${champion}: when to trade, their power spikes, where to ward.`}
        onChange={(e) => {
          setText(e.target.value);
          setState("");
        }}
        onBlur={commit}
      />
      <small className={state === "error" ? "down" : "muted"}>
        {state === "saving" ? "Saving" : state === "saved" ? "Saved" : state === "error" ? "Not saved. Click in the box and out again to try again." : note ? `Written ${dayLabel(note.at)}` : "Saved when you click away"}
      </small>
    </div>
  );
}

/** Your record against each lane opponent, with notes and their early deaths to watch. */
function MatchupsCard({ rows, onOpen, onPlaylist }: { rows: TrendMatch[]; onOpen: (id: string) => void; onPlaylist: (p: Playlist) => void }) {
  const toast = useToast();
  // Null until read: a note box opened before then would start empty, and clicking
  // away from it would save the empty text over the note.
  const [notes, setNotes] = useState<Record<string, MatchupNote> | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    api
      .matchupNotes()
      .then(setNotes)
      .catch(() => setNotes({}));
  }, []);
  const list = useMemo<Matchup[]>(() => {
    const m = new Map<string, TrendMatch[]>();
    for (const r of rows) if (r.pg?.opp) m.set(r.pg.opp, [...(m.get(r.pg.opp) ?? []), r]);
    return [...m.entries()]
      .map(([name, games]) => {
        const known = games.filter((g) => g.rank?.delta != null);
        const g10 = games.flatMap((g) => (g.pg?.gold10 != null ? [g.pg.gold10] : []));
        const g15 = games.flatMap((g) => (g.pg?.gold15 != null ? [g.pg.gold15] : []));
        return {
          name,
          key: games.find((g) => g.pg?.oppKey)?.pg?.oppKey ?? null,
          games,
          wins: games.filter((g) => g.result === "Win").length,
          losses: games.filter(lost).length,
          lp: known.length ? known.reduce((a, g) => a + g.rank!.delta!, 0) : null,
          gold10: mean(g10),
          gold15: mean(g15),
          early: games.flatMap((r) => (r.pg?.deaths ?? []).filter((s) => s.t < EARLY).map((s) => ({ r, s }))),
        };
      })
      .sort((a, b) => b.games.length - a.games.length || a.name.localeCompare(b.name));
  }, [rows]);
  const cur = list.find((x) => x.name === pick) ?? list[0];
  const shown = all ? list : list.slice(0, 8);
  if (cur && !shown.includes(cur)) shown.push(cur);
  const anyLp = list.some((x) => x.lp != null);

  const playEarly = (x: Matchup) => {
    const items: PlaylistItem[] = [...x.early]
      .filter(({ s }) => s.v != null)
      .sort((a, b) => b.r.startedEpochMs - a.r.startedEpochMs || a.s.t - b.s.t)
      .map(({ r, s }) => ({
        matchId: r.id,
        t: s.v!,
        start: Math.max(0, s.v! - 12),
        end: s.v! + 3,
        label: `${spotWords(s, true)} at ${clock(s.t)}, ${r.champion} vs ${x.name}, ${dayLabel(r.startedEpochMs)}`,
      }));
    if (items.length) onPlaylist({ title: `Early deaths vs ${x.name}`, items, index: 0 });
  };
  const save = async (champion: string, text: string) => {
    try {
      setNotes(await api.setMatchupNote(champion, text));
    } catch (e) {
      toast.show({ kind: "error", text: `The note was not saved. ${humanError(e)}` });
      throw e;
    }
  };

  return (
    <section className="tcard matchups">
      <header className="tc-h">
        <h2>
          <NotebookPen size={15} aria-hidden />
          Matchups
        </h2>
        {cur && <p>Your games against each lane opponent, from Riot's record of the game. Gold leads are yours over them. Pick one for its notes and early deaths.</p>}
      </header>
      {!cur ? (
        <div className="tc-empty">
          <p>Once Riot's record of your games is in, each lane opponent gets a line here: your record and LP against them, your gold lead at 10 and 15 minutes, and your notes.</p>
        </div>
      ) : (
        <div className="mu-body">
          <div className="tscroll">
            <table className="ttable">
              <thead>
                <tr>
                  <th>Against</th>
                  <th className="n">Games</th>
                  <th className="n">Won</th>
                  {anyLp && <th className="n">LP</th>}
                  <th className="n" title="Your gold lead over them at 10 minutes, on average">Gold @10</th>
                  <th className="n" title="Your gold lead over them at 15 minutes, on average">Gold @15</th>
                  <th className="n" title="Your deaths in the first 14 minutes">Early deaths</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((x) => (
                  <tr key={x.name} className={x === cur ? "on" : ""}>
                    <td>
                      <button className="tlink" onClick={() => setPick(x.name)} aria-pressed={x === cur}>
                        <Portrait championKey={x.key ?? undefined} name={x.name} size={24} />
                        <span>{x.name}</span>
                        {notes?.[x.name] && <NotebookPen size={12} className="muted" aria-label="Has a note" />}
                      </button>
                    </td>
                    <td className="n">{x.games.length}</td>
                    <td className="n">
                      {x.wins}–{x.losses}
                    </td>
                    {anyLp && <td className="n">{x.lp != null ? <span className={lpClass(x.lp)}>{signedNum(x.lp)}</span> : "—"}</td>}
                    <td className="n">{x.gold10 != null ? <span className={x.gold10 >= 0 ? "up" : "down"}>{signedNum(x.gold10)}</span> : "—"}</td>
                    <td className="n">{x.gold15 != null ? <span className={x.gold15 >= 0 ? "up" : "down"}>{signedNum(x.gold15)}</span> : "—"}</td>
                    <td className="n">{x.early.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {list.length > 8 && (
              <button className="btn link more" onClick={() => setAll((v) => !v)}>
                {all ? "Show fewer" : `Show all ${list.length}`}
              </button>
            )}
          </div>
          <div className="mu-side">
            <div className="mu-head">
              <Portrait championKey={cur.key ?? undefined} name={cur.name} size={40} side="enemy" />
              <div>
                <b>vs {cur.name}</b>
                <small>
                  {plural(cur.games.length, "game")}, {cur.wins} won and {cur.losses} lost
                  {cur.lp != null && (
                    <>
                      , <span className={lpClass(cur.lp)}>{signedNum(cur.lp)} LP</span>
                    </>
                  )}
                </small>
              </div>
            </div>
            <dl className="mu-stats">
              <div>
                <dt>Gold lead at 10</dt>
                <dd className={cur.gold10 == null ? "" : cur.gold10 >= 0 ? "up" : "down"}>{cur.gold10 != null ? signedNum(cur.gold10) : "—"}</dd>
              </div>
              <div>
                <dt>at 15</dt>
                <dd className={cur.gold15 == null ? "" : cur.gold15 >= 0 ? "up" : "down"}>{cur.gold15 != null ? signedNum(cur.gold15) : "—"}</dd>
              </div>
              <div>
                <dt>Early deaths</dt>
                <dd>
                  {cur.early.length}
                  <small> in {plural(cur.games.length, "game")}</small>
                </dd>
              </div>
            </dl>
            {cur.early.some(({ s }) => s.v != null) && (
              <button className="btn sm" onClick={() => playEarly(cur)} title="Plays the 12 seconds before each of your deaths in the first 14 minutes of these games, newest game first">
                <Play size={13} aria-hidden />
                Play every early death vs {cur.name}
              </button>
            )}
            {notes && <NoteBox key={cur.name} champion={cur.name} note={notes[cur.name]} onSave={(text) => save(cur.name, text)} />}
            <div className="mu-games" role="list" aria-label={`Games against ${cur.name}`}>
              {[...cur.games].reverse().map((g) => (
                <button key={g.id} role="listitem" className={`mu-game ${g.result === "Win" ? "w" : lost(g) ? "l" : ""}`} onClick={() => onOpen(g.id)} title={`Open this ${g.champion} game`}>
                  <Portrait championKey={g.championKey ?? undefined} name={g.champion} size={18} />
                  <span>{dayLabel(g.startedEpochMs)}</span>
                  <b>{g.result === "Win" ? "Won" : lost(g) ? "Lost" : "—"}</b>
                  {g.rank?.delta != null && <span className={lpClass(g.rank.delta)}>{signedNum(g.rank.delta)}</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ page

/** A game whose video was deleted keeps its numbers, but its kills and deaths can't be played. */
function unplayable(r: TrendMatch): TrendMatch {
  if (r.hasVideo !== false || !r.pg) return r;
  const still = (s: TrendSpot): TrendSpot => ({ ...s, v: null });
  return { ...r, pg: { ...r.pg, deaths: r.pg.deaths.map(still), kills: r.pg.kills.map(still) } };
}

export function Trends({ onOpen, onPlaylist, onSettings, breakAfter }: Props) {
  const toast = useToast();
  const [rows, setRows] = useState<TrendMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range | null>(savedRange);
  const [queue, setQueue] = useState("all");
  const [role, setRole] = useState("all");
  const [champ, setChamp] = useState("all");
  const [tag, setTag] = useState("all");
  const [hover, setHover] = useState<Hover | null>(null);
  const [busyCause, setBusyCause] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [allGames, setAllGames] = useState(false);
  const [allChamps, setAllChamps] = useState(false);
  const [now] = useState(() => Date.now());

  const load = useCallback(() => {
    setError(null);
    api
      .libraryTrends()
      .then((list) => setRows(list.map(unplayable)))
      .catch((e) => setError(humanError(e)));
  }, []);
  useEffect(() => load(), [load]);

  // With nothing chosen yet: the last 30 days, unless that would be empty.
  const shown: Range = range ?? (!rows || rows.some((r) => r.startedEpochMs >= now - 30 * DAY) ? "30" : "all");
  const rangeInfo = RANGES.find((r) => r.id === shown)!;
  const pickRange = (r: Range) => {
    setRange(r);
    setHover(null);
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {
      /* The choice just won't be remembered. */
    }
  };

  const all = useMemo(() => rows ?? [], [rows]);
  const filtered = queue !== "all" || role !== "all" || champ !== "all" || tag !== "all";
  const clear = () => {
    setQueue("all");
    setRole("all");
    setChamp("all");
    setTag("all");
  };

  const scoped = useMemo(() => {
    const q = QUEUES.find((x) => x.id === queue);
    return all.filter(
      (r) =>
        (!q || q.test(r.queueId)) &&
        (role === "all" || r.position.toUpperCase() === role) &&
        (champ === "all" || r.champion === champ) &&
        (tag === "all" || r.tags.includes(tag)),
    );
  }, [all, queue, role, champ, tag]);

  const span = shown === "all" ? null : Number(shown) * DAY;
  const chrono = useMemo(
    () => scoped.filter((r) => span == null || r.startedEpochMs >= now - span).sort((a, b) => a.startedEpochMs - b.startedEpochMs),
    [scoped, span, now],
  );
  const newest = useMemo(() => [...chrono].reverse(), [chrono]);
  const prev = useMemo(
    () => (span == null ? [] : scoped.filter((r) => r.startedEpochMs < now - span && r.startedEpochMs >= now - 2 * span)),
    [scoped, span, now],
  );
  const t = useMemo(() => totals(chrono), [chrono]);
  const before = useMemo(() => (prev.length >= 2 && chrono.length > 0 ? totals(prev) : null), [prev, chrono.length]);

  // Filter choices come from every game, so they don't vanish as other filters narrow things down.
  const queueOpts: Option<string>[] = useMemo(
    () => [{ value: "all", label: "All queues" }, ...QUEUES.filter((q) => all.some((r) => q.test(r.queueId))).map((q) => ({ value: q.id, label: q.label }))],
    [all],
  );
  const roleOpts: Option<string>[] = useMemo(
    () => [
      { value: "all", label: "All roles" },
      ...ROLES.filter((p) => all.some((r) => r.position.toUpperCase() === p)).map((p) => ({ value: p, label: laneName(p) })),
    ],
    [all],
  );
  const champOpts: Option<string>[] = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of all) if (r.champion) counts.set(r.champion, (counts.get(r.champion) ?? 0) + 1);
    const list = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return [{ value: "all", label: "All champions" }, ...list.map(([c, n]) => ({ value: c, label: c, hint: plural(n, "game") }))];
  }, [all]);
  const tagOpts: Option<string>[] = useMemo(() => {
    const set = new Set<string>();
    for (const r of all) for (const x of r.tags) set.add(x);
    return [{ value: "all", label: "Any tag" }, ...[...set].sort().map((x) => ({ value: x, label: `#${x}` }))];
  }, [all]);

  const causes = useMemo(() => {
    const counts = new Map<string, { deaths: number; games: number }>();
    let total = 0;
    let hinted = 0;
    for (const r of chrono) {
      if (r.deathCauses.length) hinted++;
      for (const c of r.deathCauses) {
        const e = counts.get(c) ?? { deaths: 0, games: 0 };
        e.deaths++;
        counts.set(c, e);
        total++;
      }
      for (const c of new Set(r.deathCauses)) counts.get(c)!.games++;
    }
    const items = [...counts.entries()].map(([c, e]) => ({ c, ...e })).sort((a, b) => b.deaths - a.deaths || b.games - a.games);
    const avoid = mean(chrono.flatMap((r) => (r.avgAvoidable == null ? [] : [r.avgAvoidable])));
    return { items, total, hinted, avoid };
  }, [chrono]);

  const focus = useMemo(() => {
    const groups = new Map<string, { text: string; checks: { r: TrendMatch; f: FocusCheck }[]; last: number }>();
    for (const r of chrono) {
      if (!r.focus?.text) continue;
      const key = r.focus.text.trim().toLowerCase();
      const g = groups.get(key) ?? { text: r.focus.text.trim(), checks: [], last: 0 };
      g.checks.push({ r, f: r.focus });
      g.last = Math.max(g.last, r.startedEpochMs);
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) => b.last - a.last);
  }, [chrono]);

  const byChamp = useMemo(() => {
    const m = new Map<string, TrendMatch[]>();
    for (const r of chrono) {
      const k = r.champion || "Unknown";
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.entries()]
      .map(([name, rs]) => {
        const lp = rs.filter((r) => r.rank?.delta != null);
        return { name, key: rs[0].championKey, t: totals(rs), lp: lp.length ? lp.reduce((s, r) => s + r.rank!.delta!, 0) : null };
      })
      .sort((a, b) => b.t.n - a.t.n || (b.t.winRate ?? 0) - (a.t.winRate ?? 0));
  }, [chrono]);

  const allies = useMemo(() => {
    const m = new Map<string, { name: string; games: number; wins: number; losses: number; champs: string[] }>();
    for (const r of chrono) {
      for (const al of r.allies) {
        if (!al.name) continue;
        const e = m.get(al.name) ?? { name: al.name, games: 0, wins: 0, losses: 0, champs: [] };
        e.games++;
        if (r.result === "Win") e.wins++;
        else if (r.result === "Lose") e.losses++;
        if (al.champion && !e.champs.includes(al.champion)) e.champs.push(al.champion);
        m.set(al.name, e);
      }
    }
    return [...m.values()].filter((x) => x.games >= 2).sort((a, b) => b.games - a.games || b.wins - a.wins).slice(0, 8);
  }, [chrono]);

  /** Every death with this cause in the games shown, newest game first, as one walk-through. */
  const watchCause = async (cause: string) => {
    // A game whose video was deleted has nothing to play.
    const games = newest.filter((r) => r.deathCauses.includes(cause) && r.hasVideo !== false);
    if (!games.length) {
      toast.show({ kind: "info", text: "Nothing left to watch", detail: "The videos of the games with these deaths were deleted. Their stats are kept." });
      return;
    }
    setBusyCause(cause);
    try {
      const found = await Promise.all(games.map((g) => api.insights(g.id, false).then((ins) => ({ g, ins }), () => ({ g, ins: null }))));
      // Gone somewhere else while the hints were being read: don't pull the player back.
      if (!alive.current) return;
      const items: PlaylistItem[] = [];
      for (const { g, ins } of found) {
        const deaths = (ins?.deaths ?? []).filter((d) => d.cause === cause && !d.error).sort((a, b) => a.t - b.t);
        for (const d of deaths) items.push({ matchId: g.id, t: d.t, start: Math.max(0, d.t - 12), end: d.t + 3, label: `${g.champion}, ${dayLabel(g.startedEpochMs)}` });
      }
      if (!items.length) {
        toast.show({ kind: "error", text: "Couldn't find those deaths", detail: "The hints for these games may have been cleared. Open a game to get them again." });
        return;
      }
      onPlaylist({ title: CAUSES[cause] ?? cause, items, index: 0 });
    } finally {
      setBusyCause(null);
    }
  };

  const toTable = () => document.getElementById("tr-games")?.scrollIntoView({ behavior: "smooth", block: "start" });

  if (error) {
    return (
      <div className="page">
        <div className="page-inner trends">
          <div className="lib-head">
            <h1>Trends</h1>
          </div>
          <div className="empty">
            <BarChart3 size={40} strokeWidth={1.4} aria-hidden />
            <h2>Trends didn't load</h2>
            <p>{error}</p>
            <button className="btn" onClick={load}>
              <RotateCcw size={14} aria-hidden />
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (rows === null) return <TrendsSkeleton />;

  if (!rows.length) {
    return (
      <div className="page">
        <div className="page-inner trends">
          <div className="lib-head">
            <h1>Trends</h1>
          </div>
          <div className="empty">
            <BarChart3 size={40} strokeWidth={1.4} aria-hidden />
            <h2>Trends start with your first League game</h2>
            <p>Rewatch tracks your farm, deaths, vision and wins game by game, so you can see what is getting better and what isn't.</p>
          </div>
        </div>
      </div>
    );
  }

  const win = chrono.length > 60 ? 10 : 5;
  const series = SERIES.filter((s) => !s.riot || chrono.some((r) => s.value(r) != null));
  const anyLp = chrono.some((r) => r.rank?.delta != null);
  const anyPg = chrono.some((r) => r.pg?.dmgShare != null);
  const games = allGames ? newest : newest.slice(0, 12);
  const champs = allChamps ? byChamp : byChamp.slice(0, 8);
  const maxCause = causes.items[0]?.deaths ?? 1;

  return (
    <div className="page">
      <div className="page-inner trends">
        <div className="lib-head">
          <div className="lh-title">
            <h1>Trends</h1>
            <p>
              {plural(chrono.length, "game")} {rangeInfo.last}
              {chrono.length > 1 && ` · ${shortDate(chrono[0].startedEpochMs)} to ${shortDate(chrono[chrono.length - 1].startedEpochMs)}`}
            </p>
          </div>
        </div>

        <div className="tr-filters">
          <div className="seg" role="group" aria-label="Date range">
            {RANGES.map((r) => (
              <button key={r.id} aria-pressed={shown === r.id} onClick={() => pickRange(r.id)}>
                {r.label}
              </button>
            ))}
          </div>
          {queueOpts.length > 2 && <Select small label="Filter by queue" value={queue} onChange={setQueue} options={queueOpts} />}
          {roleOpts.length > 2 && <Select small label="Filter by role" value={role} onChange={setRole} options={roleOpts} />}
          <Select small label="Filter by champion" value={champ} onChange={setChamp} options={champOpts} />
          {tagOpts.length > 1 && <Select small label="Filter by tag" value={tag} onChange={setTag} options={tagOpts} />}
          {filtered && (
            <button className="btn sm quiet" onClick={clear}>
              <X size={14} aria-hidden />
              Clear filters
            </button>
          )}
        </div>

        {chrono.length === 0 ? (
          <div className="empty tr-none">
            <BarChart3 size={36} strokeWidth={1.4} aria-hidden />
            <h2>No games match</h2>
            <p>
              {filtered ? "None of your games fit these filters" : "You haven't played"}
              {span ? ` ${rangeInfo.last}` : ""}.
            </p>
            <div className="acts">
              {shown !== "all" && (
                <button className="btn" onClick={() => pickRange("all")}>
                  Show all time
                </button>
              )}
              {filtered && (
                <button className="btn" onClick={clear}>
                  Clear filters
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="kpis">
              {TILES.map((tile) => (
                <KpiTile key={tile.key} tile={tile} now={t} before={before} period={rangeInfo.before} />
              ))}
            </div>

            <section className="tr-sec">
              <header className="sec-h">
                <h2>Game by game</h2>
                {chrono.length > 1 && (
                  <div className="tr-legend">
                    <span>
                      <i className="lg-dot" aria-hidden />
                      Each game
                    </span>
                    <span>
                      <i className="lg-line" aria-hidden />
                      {win}-game average
                    </span>
                  </div>
                )}
                <span className="grow" />
                <button className="btn link" onClick={toTable}>
                  <Table2 size={13} aria-hidden />
                  See as a table
                </button>
              </header>
              {chrono.length < 2 ? (
                <p className="tr-few">One game so far {rangeInfo.last}. Play another to start a trend line.</p>
              ) : (
                <div className="charts">
                  {series.map((s) => (
                    <TrendChart key={s.key} s={s} games={chrono} win={win} hover={hover} onHover={setHover} onOpen={onOpen} />
                  ))}
                </div>
              )}
            </section>

            <RankCard rows={chrono} onOpen={onOpen} />
            <SessionsCard rows={chrono} breakAfter={breakAfter} onOpen={onOpen} onSettings={onSettings} />
            <SpotsCard rows={chrono} onPlaylist={onPlaylist} onSettings={onSettings} />
            <MatchupsCard rows={chrono} onOpen={onOpen} onPlaylist={onPlaylist} />

            <div className="tr-two">
              <section className="tcard">
                <header className="tc-h">
                  <h2>
                    <Skull size={15} aria-hidden />
                    Why you died
                  </h2>
                  {causes.total > 0 && (
                    <p>
                      From death hints on {causes.hinted} of {plural(chrono.length, "game")}. Pick one to watch every death like it, one after another.
                    </p>
                  )}
                </header>
                {causes.total === 0 ? (
                  <div className="tc-empty">
                    <p>No death hints in these games yet. They come with the AI review: each death gets a guess at what went wrong, like being caught without vision.</p>
                    {onSettings && (
                      <button className="btn sm" onClick={onSettings}>
                        Open Settings
                      </button>
                    )}
                  </div>
                ) : (
                  <>
                    <ul className="causes">
                      {causes.items.map((c) => (
                        <li key={c.c}>
                          <button
                            className="cause"
                            onClick={() => watchCause(c.c)}
                            disabled={busyCause !== null}
                            aria-busy={busyCause === c.c}
                            aria-label={`${CAUSES[c.c] ?? c.c}: ${plural(c.deaths, "death")} in ${plural(c.games, "game")}. Watch them all.`}
                          >
                            <span className="c-l">{CAUSES[c.c] ?? c.c}</span>
                            <span className="c-n">
                              <b>{c.deaths}</b> {c.deaths === 1 ? "death" : "deaths"}, {plural(c.games, "game")}
                            </span>
                            <span className="c-w" aria-hidden>
                              {busyCause === c.c ? <Loader2 size={14} className="spin" /> : <Play size={13} />}
                            </span>
                            <span className="c-bar" aria-hidden>
                              <i style={{ width: `${Math.max(2, (c.deaths / maxCause) * 100)}%` }} />
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {causes.avoid != null && (
                      <p className="c-avoid">
                        On average, the hints rated a death <b>{Math.round(causes.avoid * 100)}%</b> likely to be avoidable.
                      </p>
                    )}
                  </>
                )}
              </section>

              <section className="tcard">
                <header className="tc-h">
                  <h2>
                    <Crosshair size={15} aria-hidden />
                    Your focus
                  </h2>
                  {focus.length > 0 && <p>What you chose to work on, and how you said each game went. Pick a game to open it.</p>}
                </header>
                {focus.length === 0 ? (
                  <div className="tc-empty">
                    <p>When you finish a review, pick one thing to work on. Reviewing your next games, you say how it went, and it adds up here.</p>
                  </div>
                ) : (
                  <>
                    <ul className="focuslist">
                      {focus.slice(0, 5).map((fg) => {
                        const yes = fg.checks.filter((c) => c.f.answer === "yes").length;
                        const partly = fg.checks.filter((c) => c.f.answer === "partly").length;
                        return (
                          <li key={fg.text} className="fg">
                            <span className="fg-t">{fg.text}</span>
                            <span className="fg-s">{focusSummary(yes, partly, fg.checks.length)}</span>
                            <span className="fg-dots">
                              {fg.checks.map(({ r, f }) => (
                                <button
                                  key={r.id}
                                  className={`fdot ${f.answer}`}
                                  onClick={() => onOpen(r.id)}
                                  title={`${FOCUS_WORD[f.answer]}: ${r.champion}, ${dayLabel(r.startedEpochMs)}`}
                                  aria-label={`${FOCUS_WORD[f.answer]}: ${r.champion}, ${dayLabel(r.startedEpochMs)}. Open the game.`}
                                >
                                  <i />
                                </button>
                              ))}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                    <div className="fkey" aria-hidden>
                      <span>
                        <i className="fdot-i yes" />
                        Did it
                      </span>
                      <span>
                        <i className="fdot-i partly" />
                        Partly
                      </span>
                      <span>
                        <i className="fdot-i no" />
                        Not really
                      </span>
                    </div>
                  </>
                )}
              </section>
            </div>

            <div className="tr-two">
              <section className="tcard">
                <header className="tc-h">
                  <h2>
                    <Swords size={15} aria-hidden />
                    Champions
                  </h2>
                  <p>Pick one to see only its games.</p>
                </header>
                <div className="tscroll">
                  <table className="ttable">
                    <thead>
                      <tr>
                        <th>Champion</th>
                        <th className="n">Games</th>
                        <th className="n">Win rate</th>
                        <th className="n">KDA</th>
                        <th className="n">CS/min</th>
                        <th className="n">Dead</th>
                        {anyLp && <th className="n">LP</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {champs.map((c) => (
                        <tr key={c.name} className={champ === c.name ? "on" : ""}>
                          <td>
                            <button className="tlink" onClick={() => setChamp(champ === c.name ? "all" : c.name)} aria-pressed={champ === c.name}>
                              <Portrait championKey={c.key ?? undefined} name={c.name} size={28} square />
                              <span>{c.name}</span>
                            </button>
                          </td>
                          <td className="n">{c.t.n}</td>
                          <td className="n">{c.t.winRate != null ? <WinRate pct={c.t.winRate} /> : "—"}</td>
                          <td className="n">{c.t.kda != null ? <span className={`kr t${kdaTier(c.t.kda)}`}>{c.t.kda.toFixed(2)}</span> : "—"}</td>
                          <td className="n">{c.t.cspm?.toFixed(1) ?? "—"}</td>
                          <td className="n">{c.t.dead != null ? `${Math.round(c.t.dead)}%` : "—"}</td>
                          {anyLp && (
                            <td className="n">{c.lp != null ? <span className={`lp ${c.lp > 0 ? "up" : c.lp < 0 ? "down" : ""}`}>{signedNum(c.lp)}</span> : "—"}</td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {byChamp.length > 8 && (
                  <button className="btn link more" onClick={() => setAllChamps((v) => !v)}>
                    {allChamps ? "Show fewer" : `Show all ${byChamp.length}`}
                  </button>
                )}
              </section>

              <section className="tcard">
                <header className="tc-h">
                  <h2>
                    <Users size={15} aria-hidden />
                    Who you play with
                  </h2>
                  <p>Teammates from two games or more.</p>
                </header>
                {allies.length === 0 ? (
                  <div className="tc-empty">
                    <p>Nobody shows up in more than one of these games yet.</p>
                  </div>
                ) : (
                  <div className="tscroll">
                    <table className="ttable">
                      <thead>
                        <tr>
                          <th>Player</th>
                          <th className="n">Games</th>
                          <th className="n">Won</th>
                          <th className="n">Win rate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allies.map((al) => {
                          const dec = al.wins + al.losses;
                          return (
                            <tr key={al.name}>
                              <td>
                                <div className="who">
                                  <b>{al.name}</b>
                                  <small>{al.champs.slice(0, 3).join(", ")}</small>
                                </div>
                              </td>
                              <td className="n">{al.games}</td>
                              <td className="n">
                                {al.wins}–{al.losses}
                              </td>
                              <td className="n">{dec ? <WinRate pct={(al.wins / dec) * 100} /> : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>

            <section className="tcard" id="tr-games">
              <header className="tc-h">
                <h2>Every game</h2>
                <p>The numbers behind the charts, newest first. Pick a game to watch it.</p>
              </header>
              <div className="tscroll">
                <table className="ttable games">
                  <thead>
                    <tr>
                      <th>Game</th>
                      <th>Result</th>
                      <th className="n">K / D / A</th>
                      <th className="n">CS/min</th>
                      <th className="n">CS by 10</th>
                      <th className="n">Dead</th>
                      <th className="n">Vision/min</th>
                      {anyPg && <th className="n">Damage share</th>}
                      {anyLp && <th className="n">LP</th>}
                      <th>Focus</th>
                    </tr>
                  </thead>
                  <tbody>
                    {games.map((r) => (
                      <tr key={r.id} className={r.result === "Win" ? "r-win" : r.result === "Lose" ? "r-lose" : ""} onClick={() => onOpen(r.id)}>
                        <td>
                          <button
                            className="tlink"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpen(r.id);
                            }}
                          >
                            <Portrait championKey={r.championKey ?? undefined} name={r.champion} size={28} square />
                            <span className="gm">
                              <b>{r.champion}</b>
                              <small>
                                {dayLabel(r.startedEpochMs)}, {timeOfDay(r.startedEpochMs)}
                                {laneName(r.position) && ` · ${laneName(r.position)}`}
                              </small>
                            </span>
                          </button>
                        </td>
                        <td>{r.result ? <span className={`res ${r.result === "Win" ? "win" : "lose"}`}>{r.result === "Win" ? "Won" : "Lost"}</span> : <span className="muted">—</span>}</td>
                        <td className="n">
                          <span className="kcell">
                            <Kda k={r.kills} d={r.deaths} a={r.assists} />
                            <KdaRatio k={r.kills} d={r.deaths} a={r.assists} unit={false} />
                          </span>
                        </td>
                        <td className="n">{(r.cs / minutes(r)).toFixed(1)}</td>
                        <td className="n">{r.cs10 ?? "—"}</td>
                        <td className="n">{r.deadPct != null ? `${Math.round(r.deadPct)}%` : "—"}</td>
                        <td className="n">{r.wards != null ? (r.wards / minutes(r)).toFixed(2) : "—"}</td>
                        {anyPg && <td className="n">{r.pg?.dmgShare != null ? `${Math.round(r.pg.dmgShare * 100)}%` : "—"}</td>}
                        {anyLp && <td className="n">{r.rank?.delta != null ? <LpDelta rank={r.rank} unit={false} /> : "—"}</td>}
                        <td>{r.focus ? <span className={`fword ${r.focus.answer}`}>{FOCUS_WORD[r.focus.answer]}</span> : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {newest.length > 12 && (
                <button className="btn link more" onClick={() => setAllGames((v) => !v)}>
                  {allGames ? "Show fewer" : `Show all ${newest.length} games`}
                </button>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function TrendsSkeleton() {
  return (
    <div className="page">
      <div className="page-inner trends" aria-busy="true" aria-label="Loading trends">
        <div className="lib-head">
          <div className="lh-title">
            <h1>Trends</h1>
            <Skeleton w={190} h={14} />
          </div>
        </div>
        <div className="tr-filters">
          <Skeleton w={276} h={32} r={8} />
          <Skeleton w={118} h={28} />
          <Skeleton w={132} h={28} />
        </div>
        <div className="kpis">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} h={116} r={12} />
          ))}
        </div>
        <div className="charts">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} h={214} r={12} />
          ))}
        </div>
      </div>
    </div>
  );
}
