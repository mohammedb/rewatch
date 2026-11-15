import { Loader2, Play, RotateCcw } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api } from "./api";
import { Portrait } from "./ChampIcon";
import { clock } from "./format";
import { hasMap, MapView, type MapDot } from "./MapView";
import { ordinal } from "./Stats";
import type { MatchFull, PgKill, PgPlayer, PostGame } from "./types";
import { humanError, Select, type Option } from "./ui";

// Riot's record of a game, fetched after it (see riot.rs): who did what, where the
// kills were, the gold leads, and what each death was made of.

const num = (n: number) => (Math.abs(n) >= 10_000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n).toLocaleString());
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(Math.round(n)).toLocaleString()}`;
const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);

/** Seconds of game time before a kill to start watching it. */
const LEAD = 8;

interface Props {
  match: MatchFull;
  /** Play the video from a moment of game time. Null when the video's times can't be matched to the game's. */
  onPlay: ((gameT: number) => void) | null;
  onFetched: (pg: PostGame) => void;
}

export function PostGamePanel({ match, onPlay, onFetched }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pg = match.postgame;
  if (match.mode !== "game" || !match.game) return null;

  if (!pg) {
    const get = () => {
      setBusy(true);
      setErr(null);
      api
        .postgameFetch(match.id)
        .then(onFetched)
        .catch((e) => setErr(humanError(e)))
        .finally(() => setBusy(false));
    };
    return (
      <section className="pg-missing">
        <h3 className="sub">Damage, gold and where the kills were</h3>
        <p className="hint-note">
          {err ??
            match.postgameNote ??
            "These come from Riot after the game. Rewatch asks for them a minute or two after it ends, while you're not playing."}
        </p>
        <button className="btn sm" onClick={get} disabled={busy} aria-busy={busy}>
          {busy ? <Loader2 size={14} className="spin" aria-hidden /> : <RotateCcw size={14} aria-hidden />}
          {busy ? "Asking Riot" : "Get them now"}
        </button>
      </section>
    );
  }

  const mine = pg.players.find((p) => p.isMe);
  return (
    <div className="pg">
      {mine && <MyNumbers pg={pg} me={mine} />}
      <Compare pg={pg} />
      {hasMap(pg.mapId) && pg.kills.length > 0 && <KillMap pg={pg} onPlay={onPlay} />}
      {pg.frames && (pg.lane || pg.teamGold) && <Gold pg={pg} onPlay={onPlay} />}
      {mine && <Deaths pg={pg} me={mine} onPlay={onPlay} />}
      {mine?.skills && <Skills order={mine.skills} />}
      <p className="pg-src">
        {pg.source === "riot" ? "From Riot's API" : "From the League client"}
        {pg.patch && ` · patch ${pg.patch}`}
        {pg.matchId && ` · ${pg.matchId}`}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ my numbers

/** Where the player stands on one number: in the game, or in their team. */
interface Place {
  place: number;
  of: number;
  where: "game" | "team";
  /** Whether being first is a good thing; damage taken is neither. */
  good: boolean;
}

function MyNumbers({ pg, me }: { pg: PostGame; me: PgPlayer }) {
  const mins = Math.max(1, pg.duration / 60);
  const x = me.extra;
  const team = pg.players.filter((p) => p.teamId === me.teamId);
  const rank = (among: PgPlayer[], where: Place["where"], f: (p: PgPlayer) => number, good = true): Place => ({
    place: 1 + among.filter((p) => f(p) > f(me)).length,
    of: among.length,
    where,
    good,
  });
  const items: [string, string, string?, Place?][] = [
    ["Kill participation", pct(me.kp), undefined, rank(team, "team", (p) => p.kp ?? 0)],
    ["Damage share", pct(me.dmgShare), "Of your team's damage to champions", rank(team, "team", (p) => p.damage)],
    ["Damage a minute", num(me.damage / mins), undefined, rank(pg.players, "game", (p) => p.damage)],
    ["Gold a minute", num(me.gold / mins), undefined, rank(pg.players, "game", (p) => p.gold)],
    ["Vision score", `${me.vision}`, `${me.wardsPlaced} wards placed, ${me.wardsKilled} destroyed, ${me.controlWards} control wards bought`, rank(pg.players, "game", (p) => p.vision)],
    ["Damage taken", num(me.taken), `${num(me.mitigated)} more blocked or reduced`, rank(pg.players, "game", (p) => p.taken, false)],
  ];
  if (x) {
    items.push(["Solo kills", `${x.soloKills ?? 0}`]);
    items.push(["Skillshots", `${x.skillshotsHit ?? 0} hit`, `${x.skillshotsDodged ?? 0} dodged`]);
    if (x.plates) items.push(["Turret plates", `${x.plates}`]);
    if (x.saves) items.push(["Allies saved", `${x.saves}`, "Saved a teammate from dying"]);
  }
  return (
    <section className="pg-sec">
      <h3 className="sub">Your game</h3>
      <dl className="pg-nums">
        {items.map(([k, v, why, pl]) => (
          <div key={k} title={why} className={pl?.good && pl.place === 1 ? "best" : ""}>
            <dt>{k}</dt>
            <dd>{v}</dd>
            {pl && pl.of > 1 && (
              <small className={`pl ${pl.good && pl.place <= (pl.where === "game" ? 3 : 1) ? "top" : ""}`}>
                {pl.place === 1 ? `Most in the ${pl.where}` : `${ordinal(pl.place)} of ${pl.of} in the ${pl.where}`}
              </small>
            )}
          </div>
        ))}
      </dl>
    </section>
  );
}

// ------------------------------------------------------------------ who did what

interface Metric {
  key: string;
  label: string;
  value: (p: PgPlayer) => number;
}

const METRICS: Metric[] = [
  { key: "damage", label: "Damage to champions", value: (p) => p.damage },
  { key: "taken", label: "Damage taken", value: (p) => p.taken },
  { key: "gold", label: "Gold earned", value: (p) => p.gold },
  { key: "cs", label: "CS", value: (p) => p.cs },
  { key: "vision", label: "Vision score", value: (p) => p.vision },
  { key: "cc", label: "Crowd control score", value: (p) => p.cc },
  { key: "support", label: "Healing and shields on allies", value: (p) => p.allyHeal + p.shield },
  { key: "objectives", label: "Damage to objectives", value: (p) => p.objectives },
];
const METRIC_OPTS: Option<string>[] = METRICS.map((m) => ({ value: m.key, label: m.label }));

function Compare({ pg }: { pg: PostGame }) {
  const [key, setKey] = useState("damage");
  const m = METRICS.find((x) => x.key === key) ?? METRICS[0];
  const myTeam = pg.players.find((p) => p.isMe)?.teamId ?? pg.players[0]?.teamId;
  // Arena's teams are pairs, not sides: there it is one list.
  const groups = pg.mapId === 30 ? [null] : [myTeam, ...new Set(pg.players.map((p) => p.teamId).filter((t) => t !== myTeam))];
  const max = Math.max(1, ...pg.players.map(m.value));
  return (
    <section className="pg-sec">
      <div className="pg-h">
        <h3 className="sub">Who did what</h3>
        <Select small label="What to compare" value={key} onChange={setKey} options={METRIC_OPTS} placement="bottom-end" />
      </div>
      {groups.map((team) => {
        const rows = pg.players.filter((p) => team == null || p.teamId === team).sort((a, b) => m.value(b) - m.value(a));
        const total = rows.reduce((s, p) => s + m.value(p), 0);
        const side = team == null ? "" : team === myTeam ? "ally" : "enemy";
        return (
          <div key={team ?? "all"} className="cmp">
            {team != null && (
              <div className={`cmp-cap ${side}`}>
                {team === myTeam ? "Your team" : "Enemy team"}
                <span>{num(total)}</span>
              </div>
            )}
            {rows.map((p) => {
              const v = m.value(p);
              return (
                <div key={p.id} className={`cmp-row ${p.isMe ? "me" : ""}`}>
                  <Portrait championKey={p.championKey} name={p.champion} size={22} />
                  <span className="cmp-n" title={p.name ? `${p.name}${p.tag ? `#${p.tag}` : ""}` : undefined}>
                    {p.isMe ? "You" : p.champion}
                  </span>
                  <span className="cmp-bar" aria-hidden>
                    <i className={side || (p.isMe ? "ally" : "")} style={{ width: `${(v / max) * 100}%` }} />
                  </span>
                  <b className="cmp-v">{num(v)}</b>
                  <span className="cmp-s" title={team == null ? undefined : "Share of the team's"}>
                    {team != null && total > 0 ? `${Math.round((v / total) * 100)}%` : ""}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </section>
  );
}

// ------------------------------------------------------------------ the map

type MapMode = "mine" | "all" | "where";

function killWords(k: PgKill, me: number | null, name: (id: number) => string): string {
  if (k.victim === me) return k.killer > 0 ? `${name(k.killer)} killed you` : "You were executed";
  if (k.killer === me) return `You killed ${name(k.victim)}`;
  if (me != null && k.assists.includes(me)) return `You helped kill ${name(k.victim)}`;
  return k.killer > 0 ? `${name(k.killer)} killed ${name(k.victim)}` : `${name(k.victim)} was executed`;
}

function KillMap({ pg, onPlay }: { pg: PostGame; onPlay: ((t: number) => void) | null }) {
  const byId = useMemo(() => new Map(pg.players.map((p) => [p.id, p])), [pg]);
  const me = pg.me;
  const myTeam = me != null ? byId.get(me)?.teamId : undefined;
  const frames = pg.frames;
  const [mode, setMode] = useState<MapMode>(me != null ? "mine" : "all");
  const last = (frames?.t.length ?? 1) - 1;
  const [minute, setMinute] = useState(() => Math.min(10, last));
  const name = (id: number) => {
    const p = byId.get(id);
    return p ? (p.id === me ? "you" : p.champion) : "a turret or minions";
  };

  let dots: MapDot[] = [];
  if (mode === "where" && frames) {
    const m = Math.min(minute, last);
    dots = frames.players
      .filter((f) => f.x[m] != null && f.y[m] != null)
      .map((f) => {
        const p = byId.get(f.id);
        return {
          key: `p${f.id}`,
          x: f.x[m],
          y: f.y[m],
          tone: "pos",
          label: p ? (p.isMe ? `You (${p.champion})` : p.champion) : `Player ${f.id}`,
          detail: `Level ${f.level[m] ?? "?"}, ${num(f.gold[m] ?? 0)} gold`,
          championKey: p?.championKey,
          champion: p?.champion,
          side: myTeam == null ? undefined : p?.teamId === myTeam ? "ally" : "enemy",
        } satisfies MapDot;
      });
  } else {
    const shown = mode === "mine" ? pg.kills.filter((k) => me != null && (k.victim === me || k.killer === me || k.assists.includes(me))) : pg.kills;
    dots = shown
      .filter((k) => k.x || k.y)
      .map((k, i) => {
        const victimTeam = byId.get(k.victim)?.teamId;
        let tone: string;
        if (mode === "mine") tone = k.victim === me ? "death" : k.killer === me ? "kill" : "assist";
        else tone = myTeam == null ? "other" : victimTeam === myTeam ? "death" : "kill";
        const extra = [clock(k.t), k.shutdown > 0 ? `${k.shutdown} gold shutdown` : ""].filter(Boolean).join(" · ");
        return {
          key: `k${i}-${k.t}`,
          x: k.x,
          y: k.y,
          tone,
          label: killWords(k, me, name).replace(/^./, (c) => c.toUpperCase()),
          detail: extra,
          onPick: onPlay ? () => onPlay(Math.max(0, k.t - LEAD)) : undefined,
        } satisfies MapDot;
      });
  }

  const label =
    mode === "where"
      ? `Where everyone was at minute ${Math.round((frames?.t[Math.min(minute, last)] ?? 0) / 60)}`
      : mode === "mine"
        ? "Your kills, deaths and assists on the map"
        : "Every kill of the game on the map";

  return (
    <section className="pg-sec">
      <div className="pg-h">
        <h3 className="sub">On the map</h3>
        <div className="seg" role="group" aria-label="What the map shows">
          {me != null && (
            <button aria-pressed={mode === "mine"} onClick={() => setMode("mine")}>
              Yours
            </button>
          )}
          <button aria-pressed={mode === "all"} onClick={() => setMode("all")}>
            All kills
          </button>
          {frames && (
            <button aria-pressed={mode === "where"} onClick={() => setMode("where")}>
              Positions
            </button>
          )}
        </div>
      </div>
      <MapView mapId={pg.mapId} dots={dots} label={label} empty={mode === "mine" ? "No kills or deaths of yours this game." : undefined} />
      {mode === "where" && frames ? (
        <div className="pg-min">
          <input
            type="range"
            min={0}
            max={last}
            value={Math.min(minute, last)}
            onChange={(e) => setMinute(Number(e.target.value))}
            aria-label="Minute"
            aria-valuetext={`Minute ${Math.round(frames.t[Math.min(minute, last)] / 60)}`}
          />
          <span className="num">{clock(frames.t[Math.min(minute, last)] ?? 0)}</span>
          {onPlay && (
            <button className="btn sm quiet" onClick={() => onPlay(frames.t[Math.min(minute, last)] ?? 0)}>
              <Play size={13} aria-hidden />
              Watch
            </button>
          )}
        </div>
      ) : (
        <div className="map-key" aria-hidden>
          {mode === "mine" ? (
            <>
              <span>
                <i className="mk kill" />
                Your kills
              </span>
              <span>
                <i className="mk assist" />
                Assists
              </span>
              <span>
                <i className="mk death" />
                Your deaths
              </span>
            </>
          ) : (
            <>
              <span>
                <i className="mk kill" />
                Your team got the kill
              </span>
              <span>
                <i className="mk death" />
                The enemy did
              </span>
            </>
          )}
          {onPlay && <span className="mk-hint">Pick one to watch it</span>}
        </div>
      )}
      {mode === "where" && <p className="hint-note">Riot notes where everyone is once a minute, so this is a snapshot, not a replay.</p>}
    </section>
  );
}

// ------------------------------------------------------------------ gold

const G_H = 120;
const G_TOP = 8;
const G_LEFT = 44;
const G_RIGHT = 10;
const G_AXIS = 20;

/** Round numbers for a scale centred on zero. */
function goldStep(max: number): number {
  for (const s of [250, 500, 1000, 2000, 2500, 5000, 10000, 20000]) if (max / s <= 2) return s;
  return 50000;
}

function Gold({ pg, onPlay }: { pg: PostGame; onPlay: ((t: number) => void) | null }) {
  const t = pg.frames!.t;
  const opp = pg.lane ? pg.players.find((p) => p.id === pg.lane!.opponent) : undefined;
  const lines = [
    pg.lane ? { key: "lane", label: opp ? `You vs ${opp.champion}` : "You vs your lane opponent", values: pg.lane.gold } : null,
    pg.teamGold ? { key: "team", label: "Your team vs theirs", values: pg.teamGold } : null,
  ].filter((l): l is { key: string; label: string; values: number[] } => l != null);

  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => setW(Math.floor(es[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [at, setAt] = useState<number | null>(null);

  const n = t.length;
  if (n < 2 || !lines.length) return null;
  const peak = Math.max(500, ...lines.flatMap((l) => l.values.map(Math.abs)));
  const step = goldStep(peak);
  const top = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let v = -top; v <= top; v += step) ticks.push(v);
  const plotW = Math.max(10, w - G_LEFT - G_RIGHT);
  const x = (i: number) => G_LEFT + (i * plotW) / (n - 1);
  const y = (v: number) => G_TOP + ((top - v) / (2 * top)) * G_H;
  const path = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const teamVals = lines.find((l) => l.key === "team")?.values;
  const area = (vals: number[]) => `${path(vals)}L${x(vals.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
  const pick = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return 0;
    return Math.max(0, Math.min(n - 1, Math.round(((clientX - r.left - G_LEFT) / plotW) * (n - 1))));
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
    else if (e.key === "Enter" && at != null && onPlay) {
      e.preventDefault();
      onPlay(t[at]);
    } else if (e.key === "Escape") setAt(null);
  };
  const lane = pg.lane;
  const atMin = (arr: number[] | undefined, m: number) => (arr && arr.length > m ? arr[m] : null);
  const lead = (m: number) => {
    const g = atMin(lane?.gold, m);
    if (g == null) return null;
    return [`${signed(g)} gold`, atMin(lane?.cs, m) != null ? `${signed(atMin(lane?.cs, m)!)} CS` : "", atMin(lane?.xp, m) != null ? `${signed(atMin(lane?.xp, m)!)} XP` : ""]
      .filter(Boolean)
      .join(", ");
  };
  const tipRight = at != null && x(at) > w - 170;

  return (
    <section className="pg-sec">
      <h3 className="sub">Gold lead</h3>
      <div
        ref={box}
        className={`plot gold ${onPlay ? "" : "still"}`}
        tabIndex={0}
        role="group"
        aria-label={`Gold lead minute by minute. ${lines.map((l) => `${l.label}: ${signed(l.values[l.values.length - 1])} at the end`).join(". ")}.${onPlay ? " Arrow keys go through the minutes, Enter plays one." : ""}`}
        onPointerMove={(e) => setAt(pick(e.clientX))}
        onPointerLeave={() => setAt(null)}
        onClick={(e) => onPlay?.(t[pick(e.clientX)])}
        onKeyDown={onKey}
        onFocus={() => at == null && setAt(n - 1)}
        onBlur={() => setAt(null)}
      >
        {w > 0 && (
          <svg width={w} height={G_TOP + G_H + G_AXIS} aria-hidden>
            {ticks.map((v) => (
              <line key={`g${v}`} className={`grid ${v === 0 ? "zero" : ""}`} x1={G_LEFT} x2={w - G_RIGHT} y1={y(v)} y2={y(v)} />
            ))}
            {ticks.map((v) => (
              <text key={`t${v}`} className="ax" x={G_LEFT - 6} y={y(v) + 3.5} textAnchor="end">
                {v === 0 ? "0" : `${v > 0 ? "+" : "−"}${Math.abs(v) >= 1000 ? `${Math.abs(v) / 1000}k` : Math.abs(v)}`}
              </text>
            ))}
            {teamVals && (
              <>
                <clipPath id="pg-gold-up">
                  <rect x={G_LEFT} y={0} width={plotW} height={y(0)} />
                </clipPath>
                <clipPath id="pg-gold-down">
                  <rect x={G_LEFT} y={y(0)} width={plotW} height={G_TOP + G_H + 4 - y(0)} />
                </clipPath>
                <path className="ga up" clipPath="url(#pg-gold-up)" d={area(teamVals)} />
                <path className="ga down" clipPath="url(#pg-gold-down)" d={area(teamVals)} />
              </>
            )}
            {at != null && <line className="cross" x1={x(at)} x2={x(at)} y1={G_TOP - 4} y2={G_TOP + G_H + 4} />}
            {lines
              .slice()
              .reverse()
              .map((l) => (
                <path key={l.key} className={`gl ${l.key}`} d={path(l.values)} />
              ))}
            {at != null && lines.map((l) => <circle key={l.key} className={`gh ${l.key}`} cx={x(at)} cy={y(l.values[at] ?? 0)} r={3.5} />)}
            <text className="ax" x={G_LEFT} y={G_TOP + G_H + 15} textAnchor="start">
              0:00
            </text>
            <text className="ax" x={w - G_RIGHT} y={G_TOP + G_H + 15} textAnchor="end">
              {clock(t[n - 1])}
            </text>
          </svg>
        )}
        {at != null && (
          <div className="tt" style={tipRight ? { right: w - x(at) + 10 } : { left: x(at) + 10 }} aria-live="polite">
            <div className="tw">At {clock(t[at])}</div>
            {lines.map((l) => (
              <div key={l.key} className="tv">
                <i className={`lk ${l.key}`} aria-hidden />
                <b>{signed(l.values[at] ?? 0)}</b>
                <span>{l.label}</span>
              </div>
            ))}
            {onPlay && <div className="tw">Click to watch from here</div>}
          </div>
        )}
      </div>
      <div className="map-key" aria-hidden>
        {lines.map((l) => (
          <span key={l.key}>
            <i className={`lk ${l.key}`} />
            {l.label}
          </span>
        ))}
      </div>
      {lane && (lead(10) || lead(15)) && (
        <dl className="pg-lane">
          {[10, 15].map((m) =>
            lead(m) ? (
              <div key={m}>
                <dt>At {m} minutes</dt>
                <dd>{lead(m)}</dd>
              </div>
            ) : null,
          )}
        </dl>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ deaths

const KIND_LABEL: Record<string, string> = { physical: "Physical", magic: "Magic", true: "True" };

function Deaths({ pg, me, onPlay }: { pg: PostGame; me: PgPlayer; onPlay: ((t: number) => void) | null }) {
  const byId = useMemo(() => new Map(pg.players.map((p) => [p.id, p])), [pg]);
  const deaths = pg.kills.filter((k) => k.victim === me.id);
  const recaps = deaths.some((d) => d.recap?.length);
  return (
    <section className="pg-sec">
      <h3 className="sub">Your deaths</h3>
      {deaths.length === 0 ? (
        <p className="hint-note">You didn't die this game.</p>
      ) : (
        <ul className="pg-deaths">
          {deaths.map((d, i) => {
            const killer = byId.get(d.killer);
            const total = (d.recap ?? []).reduce((s, h) => s + h.total, 0);
            const kinds = (["physical", "magic", "true"] as const).map((k) => [k, (d.recap ?? []).reduce((s, h) => s + h[k], 0)] as const);
            return (
              <li key={`${d.t}-${i}`}>
                <button className="pg-death" onClick={() => onPlay?.(Math.max(0, d.t - LEAD - 4))} disabled={!onPlay} title={onPlay ? "Watch the run-up to it" : undefined}>
                  <span className="t num">{clock(d.t)}</span>
                  {killer ? <Portrait championKey={killer.championKey} name={killer.champion} size={22} side="enemy" /> : <span className="pg-exec" aria-hidden />}
                  <span className="who">
                    {killer ? killer.champion : "Executed"}
                    {d.assists.length > 0 && <small> and {d.assists.length === 1 ? "1 more" : `${d.assists.length} more`}</small>}
                  </span>
                  {d.bounty > 0 && <span className="gold num" title="Gold your death gave them">{d.bounty + d.shutdown}g</span>}
                  {onPlay && <Play size={13} className="go" aria-hidden />}
                </button>
                {total > 0 && (
                  <div className="recap">
                    <div className="rc-bar" role="img" aria-label={`${num(total)} damage taken: ${kinds.map(([k, v]) => `${KIND_LABEL[k]} ${num(v)}`).join(", ")}`}>
                      {kinds.map(([k, v]) => (v > 0 ? <i key={k} className={k} style={{ flexGrow: v }} title={`${KIND_LABEL[k]}: ${num(v)}`} /> : null))}
                    </div>
                    <ul className="rc-src">
                      {d.recap!.slice(0, 3).map((h) => {
                        const p = h.id > 0 ? byId.get(h.id) : undefined;
                        return (
                          <li key={`${h.id}-${h.name}`}>
                            <span className="rc-n">{p ? p.champion : h.name || "Unknown"}</span>
                            <span className="rc-h">{h.hits.slice(0, 4).join(", ")}</span>
                            <b className="num">{num(h.total)}</b>
                          </li>
                        );
                      })}
                    </ul>
                    {d.dealt != null && <p className="rc-dealt">You dealt {num(d.dealt)} back.</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {deaths.length > 0 && !recaps && pg.source === "client" && (
        <p className="hint-note">With a Riot API key in Settings, each death also shows what hit you and how hard.</p>
      )}
      {recaps && (
        <div className="map-key" aria-hidden>
          <span>
            <i className="sw physical" />
            Physical
          </span>
          <span>
            <i className="sw magic" />
            Magic
          </span>
          <span>
            <i className="sw true" />
            True damage
          </span>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ skills

function Skills({ order }: { order: string }) {
  const levels = [...order].slice(0, 18);
  return (
    <section className="pg-sec">
      <h3 className="sub">Skill order</h3>
      <div className="skillgrid" style={{ gridTemplateColumns: `18px repeat(${levels.length}, minmax(0, 1fr))` }} role="img" aria-label={`Skill order: ${levels.join(" ")}`}>
        {["Q", "W", "E", "R"].map((k) => (
          <Fragment key={k}>
            <span className="sk-k">{k}</span>
            {levels.map((s, i) => (
              <span key={i} className={`sk-c ${s === k ? `on k${k}` : ""}`}>
                {s === k ? i + 1 : ""}
              </span>
            ))}
          </Fragment>
        ))}
      </div>
    </section>
  );
}
