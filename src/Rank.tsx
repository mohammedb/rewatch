import { Trophy } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Portrait } from "./ChampIcon";
import { dayLabel, timeOfDay } from "./format";
import type { RankChange, TrendMatch } from "./types";

// Ranked standings and LP, as Riot reports them after each game (see riot.rs).

const TIER_NAMES: Record<string, string> = {
  IRON: "Iron",
  BRONZE: "Bronze",
  SILVER: "Silver",
  GOLD: "Gold",
  PLATINUM: "Platinum",
  EMERALD: "Emerald",
  DIAMOND: "Diamond",
  MASTER: "Master",
  GRANDMASTER: "Grandmaster",
  CHALLENGER: "Challenger",
};
const TIER_ORDER = Object.keys(TIER_NAMES);
const DIVISIONS = ["IV", "III", "II", "I"];
/** Where Master starts on the ladder: 7 tiers of 400. */
const MASTER = 2800;

const tierName = (tier: string) => TIER_NAMES[tier] ?? tier;

/** "Gold II", or "Master"; "Unranked" until placements are done. */
export function rankName(r: { tier: string; division: string }): string {
  if (!r.tier) return "Unranked";
  return r.division ? `${tierName(r.tier)} ${r.division}` : tierName(r.tier);
}

/** "Gold II, 45 LP". */
export function standing(r: { tier: string; division: string; lp: number }): string {
  return r.tier ? `${rankName(r)}, ${r.lp} LP` : "Unranked";
}

/** "Solo/Duo", "Flex", or Riot's own name for another ranked queue. */
export function queueLabel(queue: string): string {
  if (queue === "RANKED_SOLO_5x5") return "Solo/Duo";
  if (queue === "RANKED_FLEX_SR") return "Flex";
  const words = queue.replace(/^RANKED_/, "").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A point on the ladder as a rank: 1250 is "Gold IV, 50 LP". */
function ladderName(v: number): string {
  if (v >= MASTER) return v === MASTER ? "Master" : `Master +${v - MASTER}`;
  const t = Math.max(0, Math.floor(v / 400));
  const d = Math.min(3, Math.floor((v - t * 400) / 100));
  return `${tierName(TIER_ORDER[t])} ${DIVISIONS[d]}`;
}

const signed = (d: number) => `${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d)}`;
const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** "+21 LP" or "−18 LP", coloured. Nothing when the change is not known. */
export function LpDelta({ rank, unit = true }: { rank?: RankChange | null; unit?: boolean }) {
  if (!rank || rank.delta == null) return null;
  const d = rank.delta;
  const from = rank.before ? `${standing(rank.before)} to ` : "";
  return (
    <span className={`lp ${d > 0 ? "up" : d < 0 ? "down" : ""}`} title={`${queueLabel(rank.queue)}: ${from}${standing(rank)}`}>
      {signed(d)}
      {unit && " LP"}
    </span>
  );
}

/** The standing after a game and the LP it won or lost, above the scoreboard. */
export function RankLine({ rank }: { rank: RankChange }) {
  return (
    <div className="rankline">
      <Trophy size={15} aria-hidden />
      <span className="rl-q">{queueLabel(rank.queue)}</span>
      <b>{standing(rank)}</b>
      <LpDelta rank={rank} />
      {rank.provisional && <span className="muted">in placements</span>}
    </div>
  );
}

const PLOT_H = 132;
const TOP = 12;
const AXIS = 22;
const LEFT = 84;
const RIGHT = 20;
const H = TOP + PLOT_H + AXIS;

/** Rank over the games shown, one ranked queue at a time. Pick a game to open it. */
export function RankCard({ rows, onOpen }: { rows: TrendMatch[]; onOpen: (id: string) => void }) {
  const queues = useMemo(() => {
    const m = new Map<string, TrendMatch[]>();
    for (const r of rows) {
      if (r.rank?.ladder == null) continue;
      m.set(r.rank.queue, [...(m.get(r.rank.queue) ?? []), r]);
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [rows]);
  const [pick, setPick] = useState<string | null>(null);
  const queue = queues.find(([q]) => q === pick) ?? queues[0];

  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => setW(Math.floor(es[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [queue]);
  const [at, setAt] = useState<number | null>(null);

  if (!queue) return null;
  const games = queue[1];
  const n = games.length;
  const last = games[n - 1].rank!;
  const vals = games.map((g) => g.rank!.ladder!);
  const known = games.filter((g) => g.rank!.delta != null);
  const net = known.reduce((s, g) => s + g.rank!.delta!, 0);

  // A gridline per division, or per tier when the games cover a lot of ground.
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const step = hi - lo > 700 ? 400 : 100;
  const a = Math.floor((lo - 10) / step) * step;
  const b = Math.max(a + step, Math.ceil((hi + 10) / step) * step);
  const ticks: number[] = [];
  for (let v = a; v <= b; v += step) ticks.push(v);
  const plotW = Math.max(10, w - LEFT - RIGHT);
  const x = (i: number) => LEFT + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (v: number) => TOP + PLOT_H - ((v - a) / (b - a)) * PLOT_H;
  const path = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const pickAt = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || n <= 1) return 0;
    return Math.max(0, Math.min(n - 1, Math.round(((clientX - rect.left - LEFT) / plotW) * (n - 1))));
  };
  const onKey = (e: KeyboardEvent) => {
    const cur = at ?? n - 1;
    const go = (i: number) => {
      e.preventDefault();
      setAt(i);
    };
    if (e.key === "ArrowLeft") go(Math.max(0, cur - 1));
    else if (e.key === "ArrowRight") go(Math.min(n - 1, cur + 1));
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(n - 1);
    else if (e.key === "Enter" && at != null) {
      e.preventDefault();
      onOpen(games[at].id);
    } else if (e.key === "Escape") setAt(null);
  };
  const g = at != null ? games[at] : null;
  const tipRight = at != null && x(at) > w - 220;

  return (
    <section className="tcard rankcard">
      <header className="tc-h rk-h">
        <h2>
          <Trophy size={15} aria-hidden />
          Rank
        </h2>
        {queues.length > 1 && (
          <div className="seg" role="group" aria-label="Ranked queue">
            {queues.map(([q, gs]) => (
              <button key={q} aria-pressed={q === queue[0]} onClick={() => setPick(q)}>
                {queueLabel(q)}
                <span className="count">{gs.length}</span>
              </button>
            ))}
          </div>
        )}
      </header>
      <div className="rk-now">
        <b>{standing(last)}</b>
        <span className="muted">
          {queueLabel(last.queue)} · {last.wins} won, {last.losses} lost this season
        </span>
        {known.length > 0 && (
          <span className={`rk-net ${net > 0 ? "up" : net < 0 ? "down" : "muted"}`}>
            {signed(net)} LP over {known.length === 1 ? "1 game" : `${known.length} games`}
          </span>
        )}
      </div>
      <div
        ref={box}
        className="plot"
        tabIndex={0}
        role="group"
        aria-label={`Rank in ${queueLabel(queue[0])} over ${n} games, now ${standing(last)}. Arrow keys go through the games, Enter opens one.`}
        onPointerMove={(e) => setAt(pickAt(e.clientX))}
        onPointerLeave={() => setAt(null)}
        onClick={(e) => onOpen(games[pickAt(e.clientX)].id)}
        onKeyDown={onKey}
        onFocus={() => at == null && setAt(n - 1)}
        onBlur={() => setAt(null)}
      >
        {w > 0 && (
          <svg width={w} height={H} aria-hidden>
            {ticks.map((t) => (
              <line key={`g${t}`} className={`grid ${t % 400 === 0 ? "tier" : ""}`} x1={LEFT} x2={w - RIGHT + 8} y1={y(t)} y2={y(t)} />
            ))}
            {ticks.map((t) => (
              <text key={`t${t}`} className="ax" x={LEFT - 8} y={y(t) + 3.5} textAnchor="end">
                {ladderName(t)}
              </text>
            ))}
            {at != null && <line className="cross" x1={x(at)} x2={x(at)} y1={TOP - 6} y2={TOP + PLOT_H + 4} />}
            <path className="avg" d={path} />
            {games.map((gm, i) => {
              const d = gm.rank!.delta;
              return <circle key={gm.id} className={`rk-dot ${d == null ? "" : d > 0 ? "up" : d < 0 ? "down" : ""}`} cx={x(i)} cy={y(vals[i])} r={n > 60 ? 2.5 : 4} />;
            })}
            {at != null && <circle className="hot" cx={x(at)} cy={y(vals[at])} r={5} />}
            <text className="ax" x={x(0)} y={H - 4} textAnchor={n > 1 ? "start" : "middle"}>
              {shortDate(games[0].startedEpochMs)}
            </text>
            {n > 1 && (
              <text className="ax" x={x(n - 1)} y={H - 4} textAnchor="end">
                {shortDate(games[n - 1].startedEpochMs)}
              </text>
            )}
          </svg>
        )}
        {g && at != null && (
          <div className="tt" style={tipRight ? { right: w - x(at) + 12 } : { left: x(at) + 12 }} aria-live="polite">
            <div className="tv">
              <b>{standing(g.rank!)}</b>
            </div>
            {g.rank!.delta != null && (
              <div className="tv">
                <LpDelta rank={g.rank} />
                <span>this game</span>
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
    </section>
  );
}
