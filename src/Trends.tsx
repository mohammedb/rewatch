import { ArrowDown, ArrowUp, BarChart3, Crosshair, Loader2, Minus, Play, RotateCcw, Skull, Swords, Table2, Users, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api } from "./api";
import type { Playlist, PlaylistItem } from "./App";
import { Portrait } from "./ChampIcon";
import { dayLabel, laneName, timeOfDay } from "./format";
import type { FocusCheck, TrendMatch } from "./types";
import { humanError, Select, Skeleton, useToast, type Option } from "./ui";

interface Props {
  onOpen: (id: string) => void;
  /** Start a walk-through across games. */
  onPlaylist: (p: Playlist) => void;
  onSettings?: () => void;
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
}

const SERIES: Series[] = [
  { key: "dead", label: "Time spent dead", better: "down", value: (r) => r.deadPct ?? null, fmt: (v) => `${Math.round(v)}%`, pct: true },
  { key: "cs10", label: "CS by 10 minutes", better: "up", value: (r) => r.cs10 ?? null, fmt: (v) => `${Math.round(v)}` },
  { key: "cspm", label: "CS per minute", better: "up", value: (r) => r.cs / minutes(r), fmt: (v) => v.toFixed(1) },
  { key: "vision", label: "Vision per minute", better: "up", value: (r) => (r.wards == null ? null : r.wards / minutes(r)), fmt: (v) => v.toFixed(2) },
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

// ------------------------------------------------------------------ page

export function Trends({ onOpen, onPlaylist, onSettings }: Props) {
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
      .then(setRows)
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
      .map(([name, rs]) => ({ name, key: rs[0].championKey, t: totals(rs) }))
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
    const games = newest.filter((r) => r.deathCauses.includes(cause));
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
                  {SERIES.map((s) => (
                    <TrendChart key={s.key} s={s} games={chrono} win={win} hover={hover} onHover={setHover} onOpen={onOpen} />
                  ))}
                </div>
              )}
            </section>

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
                      </tr>
                    </thead>
                    <tbody>
                      {champs.map((c) => (
                        <tr key={c.name} className={champ === c.name ? "on" : ""}>
                          <td>
                            <button className="tlink" onClick={() => setChamp(champ === c.name ? "all" : c.name)} aria-pressed={champ === c.name}>
                              <Portrait championKey={c.key ?? undefined} name={c.name} size={24} />
                              <span>{c.name}</span>
                            </button>
                          </td>
                          <td className="n">{c.t.n}</td>
                          <td className="n">{c.t.winRate != null ? `${Math.round(c.t.winRate)}%` : "—"}</td>
                          <td className="n">{c.t.kda?.toFixed(2) ?? "—"}</td>
                          <td className="n">{c.t.cspm?.toFixed(1) ?? "—"}</td>
                          <td className="n">{c.t.dead != null ? `${Math.round(c.t.dead)}%` : "—"}</td>
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
                              <td className="n">{dec ? `${Math.round((al.wins / dec) * 100)}%` : "—"}</td>
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
                      <th>Focus</th>
                    </tr>
                  </thead>
                  <tbody>
                    {games.map((r) => (
                      <tr key={r.id} onClick={() => onOpen(r.id)}>
                        <td>
                          <button
                            className="tlink"
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpen(r.id);
                            }}
                          >
                            <Portrait championKey={r.championKey ?? undefined} name={r.champion} size={24} />
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
                          {r.kills} / {r.deaths} / {r.assists}
                        </td>
                        <td className="n">{(r.cs / minutes(r)).toFixed(1)}</td>
                        <td className="n">{r.cs10 ?? "—"}</td>
                        <td className="n">{r.deadPct != null ? `${Math.round(r.deadPct)}%` : "—"}</td>
                        <td className="n">{r.wards != null ? (r.wards / minutes(r)).toFixed(2) : "—"}</td>
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
