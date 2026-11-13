// What sits under the timeline and in the Review tab: who was talking when, the
// numbers of the game as lines, and the lists of deaths and team fights to walk through.

import { ArrowDownWideNarrow, Bookmark, ChevronLeft, ChevronRight, Clapperboard, FolderOpen, Play, RotateCcw, Skull, Sparkles, Swords, Trophy, Users, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Portrait } from "./ChampIcon";
import { clock, laneName } from "./format";
import type { Coach, DeathInsight, GameEvent, Highlight, Insights, PlayerRow, Span, Stats, TeamReview } from "./types";

// ------------------------------------------------------------------- fights

export interface Fight {
  start: number;
  end: number;
  /** Kills for your team and for the enemy. */
  ours: number;
  theirs: number;
  kills: GameEvent[];
}

/** Kills that follow each other closely are one fight. Three or more make a team fight. */
export function fightsOf(events: GameEvent[], gap = 14): Fight[] {
  const kills = events.filter((e) => e.kind === "ChampionKill").sort((a, b) => a.t - b.t);
  const out: Fight[] = [];
  let cur: GameEvent[] = [];
  const flush = () => {
    if (cur.length >= 3) {
      out.push({ start: cur[0].t, end: cur[cur.length - 1].t, ours: cur.filter((e) => e.good === true).length, theirs: cur.filter((e) => e.good === false).length, kills: cur });
    }
    cur = [];
  };
  for (const k of kills) {
    if (cur.length && k.t - cur[cur.length - 1].t > gap) flush();
    cur.push(k);
  }
  flush();
  return out;
}

/** One stop in a walk-through: the stretch to play and what it is. */
export interface QueueItem {
  /** The moment itself, for the label. */
  t: number;
  start: number;
  end: number;
  label: string;
}

export interface Queue {
  title: string;
  items: QueueItem[];
  idx: number;
}

export function deathItems(events: GameEvent[]): QueueItem[] {
  return events
    .filter((e) => e.kind === "ChampionKill" && e.role === "death")
    .map((e) => ({ t: e.t, start: Math.max(0, e.t - 12), end: e.t + 3, label: e.killerChamp ? `${e.killerChamp} killed you` : "You were executed" }));
}

export function fightItems(fights: Fight[]): QueueItem[] {
  return fights.map((f) => ({ t: f.start, start: Math.max(0, f.start - 8), end: f.end + 4, label: `Fight, ${f.ours} for ${f.theirs}` }));
}

const CAUSES: Record<string, string> = {
  no_vision: "caught without vision",
  overextended: "overextended",
  engage_no_followup: "engaged without follow-up",
  outnumbered: "outnumbered",
  tower_dive: "tower dive",
  lost_even_fight: "lost an even fight",
  worth_it: "a fair trade",
};
const FIGHTS: Record<string, string> = { caught_alone: "caught alone", skirmish: "skirmish", teamfight: "team fight" };
const pct = (p?: number | null) => (typeof p === "number" ? `${Math.round(p * 100)}%` : "?");

/** One short line about a death, worded as a hint: the model is often unsure. */
export function hintLine(d: DeathInsight): { text: string; tone: "bad" | "ok" | "" } {
  if (d.error || typeof d.avoidable !== "number") return { text: "No hint for this one", tone: "" };
  const head = d.avoidable >= 0.7 ? `Likely avoidable (${pct(d.avoidable)})` : d.avoidable <= 0.45 ? `Probably forced (${pct(1 - d.avoidable)})` : `Hard to say (${pct(d.avoidable)} avoidable)`;
  const cause = d.cause && (d.causeP ?? 0) >= 0.4 ? CAUSES[d.cause] ?? d.cause : null;
  return { text: cause ? `${head}, ${cause}` : head, tone: d.avoidable >= 0.7 ? "bad" : d.avoidable <= 0.45 ? "ok" : "" };
}

/** Everything the model answered about a death, for the tooltip. */
export function hintDetail(d: DeathInsight): string {
  if (d.error) return `Could not be answered: ${d.error}`;
  const pos = typeof d.positioning === "number" ? ["poor", "risky", "sound"][Math.min(2, Math.max(0, Math.round(d.positioning)))] : "?";
  return [
    `Avoidable: ${pct(d.avoidable)}`,
    `Main cause: ${d.cause ? CAUSES[d.cause] ?? d.cause : "?"} (${pct(d.causeP)})`,
    `Kind of fight: ${d.fight ? FIGHTS[d.fight] ?? d.fight : "?"} (${pct(d.fightP)})`,
    `Enemies visible beforehand: ${pct(d.sawItComing)}`,
    `An ally close enough to help: ${pct(d.allyClose)}`,
    `Positioning before the fight: ${pos}`,
    "A hint from Google's Decisions API, not a verdict.",
  ].join("\n");
}

interface ReviewTabProps {
  events: GameEvent[];
  fights: Fight[];
  bookmarks: { t: number }[];
  queue: Queue | null;
  champKey: (name?: string) => string | undefined;
  onStart: (title: string, items: QueueItem[], idx: number) => void;
  /** Hints about the deaths, when they have been asked for. */
  insights: Insights | null;
  /** The written review, when there is one. */
  coach: Coach | null;
  /** "ready" to ask, "off" (not set up in Settings), "busy" asking now. */
  hintState: "ready" | "off" | "busy";
  hintError: string | null;
  onAskHints: () => void;
  highlights: Highlight[];
  /** Clips are being made right now. */
  savingClips: boolean;
  onSaveClips: () => void;
  onShowClip: (file: string) => void;
  /** Team reviews of fights, mine and teammates'. */
  team: TeamReview[];
  /** How many screens a team review would use (mine plus teammates' views that are ready). */
  teamViews: number;
  /** The fight being reviewed right now, by its start time. */
  teamBusy: number | null;
  onTeamReview: (fight: Fight) => void;
}

/** Side-panel tab with the things worth walking through after a game. */
export function ReviewTab({ events, fights, bookmarks, queue, champKey, onStart, insights, coach, hintState, hintError, onAskHints, highlights, savingClips, onSaveClips, onShowClip, team, teamViews, teamBusy, onTeamReview }: ReviewTabProps) {
  const reel = useMemo<QueueItem[]>(() => highlights.map((h) => ({ t: h.t, start: h.start, end: h.end, label: h.label })), [highlights]);
  const unsaved = highlights.some((h) => !h.file);
  const [worstFirst, setWorstFirst] = useState(false);
  // Deaths with their hints, in game order or with the most avoidable first.
  const rows = useMemo(() => {
    const list = events
      .filter((e) => e.kind === "ChampionKill" && e.role === "death")
      .map((e) => ({ e, hint: insights?.deaths.find((d) => Math.abs(d.t - e.t) < 1.5) ?? null }));
    return worstFirst ? [...list].sort((a, b) => (b.hint?.avoidable ?? -1) - (a.hint?.avoidable ?? -1)) : list;
  }, [events, insights, worstFirst]);
  const deaths = useMemo(() => deathItems(rows.map((r) => r.e)), [rows]);
  const deathEvents = useMemo(() => rows.map((r) => r.e), [rows]);
  const hasHints = rows.some((r) => r.hint);
  const fightList = useMemo(() => fightItems(fights), [fights]);
  const marks = useMemo<QueueItem[]>(() => bookmarks.map((b) => ({ t: b.t, start: Math.max(0, b.t - 10), end: b.t + 5, label: "Bookmark" })), [bookmarks]);
  const active = (title: string, i: number) => queue?.title === title && queue.idx === i;
  const nothing = deaths.length + fightList.length + marks.length + highlights.length === 0;
  const wanted = !coach || (deaths.length > 0 && !hasHints);
  return (
    <div className="sidebody">
      {coach && (
        <section className="coach">
          <h3><Sparkles size={15} aria-hidden />Coach's review</h3>
          <p className="headline">{coach.headline}</p>
          {coach.wentWell.length > 0 && <><h4>Went well</h4><ul>{coach.wentWell.map((s, i) => <li key={i}>{s}</li>)}</ul></>}
          {coach.workOn.length > 0 && <><h4>Work on</h4><ul>{coach.workOn.map((s, i) => <li key={i}>{s}</li>)}</ul></>}
          {coach.nextGame && <p className="next"><b>Next game</b>{coach.nextGame}</p>}
          <small>Written by Gemini from the scoreboard and clips of your deaths. It can be wrong about what it saw.</small>
        </section>
      )}
      {wanted && hintState !== "off" && (
        <div className="ai-bar">
          <button className="btn" disabled={hintState === "busy"} onClick={onAskHints} title="Sends the scoreboard and a 17-second clip of each death to Google's Gemini. You get a written review, a hint on each death and a title for every player."><Sparkles size={13} aria-hidden />{hintState === "busy" ? "Reviewing, about half a minute" : "Get the AI review"}</button>
        </div>
      )}
      {wanted && hintState === "off" && <p className="hint-note">A written review of the game and hints on each death can be switched on in Settings, under AI review.</p>}
      {hintError && <p className="enemy hint-note">{hintError}</p>}
      {nothing && !coach && <p>No deaths, team fights or bookmarks in this recording.</p>}
      {highlights.length > 0 && (
        <section className="rv">
          <header>
            <h3><Trophy size={15} aria-hidden />Highlights<span className="num">{highlights.length}</span></h3>
            <span className="grow" />
            {unsaved ? (
              <button className="btn" disabled={savingClips} onClick={onSaveClips} title="Saves each highlight as a 1080p clip with game sound, Discord and your microphone, next to the recording"><Clapperboard size={13} aria-hidden />{savingClips ? "Saving" : "Save clips"}</button>
            ) : (
              <button className="btn sq" aria-label="Show the clips in their folder" title="Show the clips in their folder" onClick={() => onShowClip(highlights[0].file!)}><FolderOpen size={14} /></button>
            )}
            <button className="btn" onClick={() => onStart("Highlights", reel, 0)}><Play size={13} fill="currentColor" aria-hidden />Play all</button>
          </header>
          {highlights.map((h, i) => (
            <button key={i} className={`moment ${active("Highlights", i) ? "now" : ""}`} onClick={() => onStart("Highlights", reel, i)}>
              <span className="t">{clock(h.t)}</span>
              <span className="pic"><span className="glyph mark" style={{ width: 26, height: 26 }}>{h.kind === "fight" || h.kind === "objective" ? <Swords size={14} /> : <Trophy size={14} />}</span></span>
              <span className="txt">{h.label}<small className="hint">{Math.round(h.end - h.start)} s{h.file ? ", clip saved" : ""}</small></span>
            </button>
          ))}
        </section>
      )}
      {deaths.length > 0 && (
        <section className="rv">
          <header>
            <h3><Skull size={15} aria-hidden />Your deaths<span className="num">{deaths.length}</span></h3>
            <span className="grow" />
            {hasHints && (
              <button className={`btn sq ${worstFirst ? "on" : ""}`} aria-pressed={worstFirst} aria-label="Most avoidable first" title="Most avoidable first" onClick={() => setWorstFirst((v) => !v)}><ArrowDownWideNarrow size={14} /></button>
            )}
            <button className="btn" onClick={() => onStart("Deaths", deaths, 0)} title="Plays the 12 seconds before each death, then stops so you can think"><Play size={13} fill="currentColor" aria-hidden />Play all</button>
          </header>

          {deaths.map((d, i) => {
            const e = deathEvents[i];
            return (
              <button key={i} className={`moment ${active("Deaths", i) ? "now" : ""}`} onClick={() => onStart("Deaths", deaths, i)}>
                <span className="t">{clock(d.t)}</span>
                <span className="pic">
                  {e?.killerChamp ? <Portrait championKey={champKey(e.killerChamp)} name={e.killerChamp} size={26} side="enemy" /> : <span className="glyph enemy" style={{ width: 26, height: 26 }}><Skull size={14} /></span>}
                  {(e?.assisters?.length ?? 0) > 0 && <small>+{e!.assisters!.length}</small>}
                </span>
                <span className="txt" title={rows[i].hint ? hintDetail(rows[i].hint!) : undefined}>
                  {d.label}
                  {rows[i].hint && <small className={`hint ${hintLine(rows[i].hint!).tone}`}><Sparkles size={11} aria-hidden />{hintLine(rows[i].hint!).text}</small>}
                  {(() => {
                    const said = coach?.deaths.find((c) => Math.abs(c.t - rows[i].e.t) < 1.5);
                    return said ? <small className="said">{said.whatHappened}{said.better && <><br /><b>Better:</b> {said.better}</>}</small> : null;
                  })()}
                </span>
              </button>
            );
          })}
        </section>
      )}
      {fightList.length > 0 && (
        <section className="rv">
          <header>
            <h3><Swords size={15} aria-hidden />Team fights<span className="num">{fightList.length}</span></h3>
            <button className="btn" onClick={() => onStart("Fights", fightList, 0)}><Play size={13} fill="currentColor" aria-hidden />Play all</button>
          </header>
          {fights.map((f, i) => {
            const won = f.ours > f.theirs;
            const even = f.ours === f.theirs;
            const row = (
              <button className={`moment ${active("Fights", i) ? "now" : ""}`} onClick={() => onStart("Fights", fightList, i)}>
                <span className="t">{clock(f.start)}</span>
                <span className="pic"><b className={`tally ${even ? "" : won ? "ally" : "enemy"}`}>{f.ours} : {f.theirs}</b></span>
                <span className="txt">{even ? "Even trade" : won ? "Won" : "Lost"}, {Math.max(1, Math.round(f.end - f.start))} s{f.kills.some((k) => k.role === "death") ? ", you died" : ""}</span>
              </button>
            );
            const said = team.find((r) => Math.abs(r.t - f.start) < 6);
            return (
              <div key={i}>
                {row}
                {said ? (
                  <div className="teamrev">
                    <h4><Users size={13} aria-hidden />Team review<small>from {said.views.length} {said.views.length === 1 ? "screen" : "screens"}: {said.views.join(", ")}</small></h4>
                    <p>{said.summary}</p>
                    {said.turningPoint && <p><b>Turning point:</b> {said.turningPoint}</p>}
                    {said.shouldHave.length > 0 && <ul>{said.shouldHave.map((s, k) => <li key={k}>{s}</li>)}</ul>}
                    {said.players.map((p, k) => (
                      <p key={k} className="who"><Portrait championKey={champKey(p.champion)} name={p.champion} size={20} side="ally" /><span><b>{p.champion}:</b> {p.did} <i>{p.better}</i></span></p>
                    ))}
                    {said.call && <p className="call">“{said.call}”</p>}
                  </div>
                ) : hintState !== "off" ? (
                  <button className="btn teamask" disabled={teamBusy !== null} onClick={() => onTeamReview(f)} title="Sends this fight from your screen and every teammate's view that is ready to Google's Gemini, and asks what the team should have done. Pictures only: no Discord, no microphone.">
                    <Users size={13} aria-hidden />{teamBusy === f.start ? "Reviewing, about half a minute" : `Team review from ${teamViews} ${teamViews === 1 ? "screen" : "screens"}`}
                  </button>
                ) : null}
              </div>
            );
          })}
        </section>
      )}
      {marks.length > 0 && (
        <section className="rv">
          <header>
            <h3><Bookmark size={15} aria-hidden />Bookmarks<span className="num">{marks.length}</span></h3>
            <button className="btn" onClick={() => onStart("Bookmarks", marks, 0)}><Play size={13} fill="currentColor" aria-hidden />Play all</button>
          </header>
          {marks.map((m, i) => (
            <button key={i} className={`moment ${active("Bookmarks", i) ? "now" : ""}`} onClick={() => onStart("Bookmarks", marks, i)}>
              <span className="t">{clock(m.t)}</span>
              <span className="pic"><span className="glyph mark" style={{ width: 26, height: 26 }}><Bookmark size={14} fill="currentColor" /></span></span>
              <span className="txt">Bookmark</span>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

/** The strip over the video while a walk-through is running. */
export function QueueBar({ queue, onGo, onReplay, onClose }: { queue: Queue; onGo: (idx: number) => void; onReplay: () => void; onClose: () => void }) {
  const item = queue.items[queue.idx];
  return (
    <div className="queuebar" role="group" aria-label={`${queue.title} walk-through`}>
      <b>{queue.title} {queue.idx + 1} of {queue.items.length}</b>
      <span>{clock(item.t)} · {item.label}</span>
      <button className="btn sq" disabled={queue.idx === 0} onClick={() => onGo(queue.idx - 1)} aria-label="Previous" title="Previous (P)"><ChevronLeft size={16} /></button>
      <button className="btn sq" onClick={onReplay} aria-label="Play this one again" title="Play this one again"><RotateCcw size={14} /></button>
      <button className="btn sq" disabled={queue.idx >= queue.items.length - 1} onClick={() => onGo(queue.idx + 1)} aria-label="Next" title="Next (N)"><ChevronRight size={16} /></button>
      <button className="btn sq quiet" onClick={onClose} aria-label="Stop the walk-through" title="Stop (Esc)"><X size={15} /></button>
    </div>
  );
}

// ----------------------------------------------------------- under the timeline

/** One row of the comms display: a person and the stretches they were talking. */
export interface VoiceRow {
  key: string;
  label: string;
  color: string;
  spans: Span[];
}

/** Colours for the comms rows, in order: you, then teammates. Discord's row is grey. */
export const VOICE_COLORS = ["#f2c94c", "#5b8def", "#4fd1a5", "#c084fc", "#f59e6b"];
export const DISCORD_COLOR = "#8a93a3";

export type Metric = "cs" | "cspm" | "level" | "gold";
const METRICS: { key: Metric; label: string }[] = [
  { key: "cs", label: "CS" },
  { key: "cspm", label: "CS per minute" },
  { key: "level", label: "Level" },
  { key: "gold", label: "Your gold" },
];

interface LanesProps {
  duration: number;
  time: number;
  voice: VoiceRow[];
  showVoice: boolean;
  stats: Stats | null;
  showStats: boolean;
  players: PlayerRow[];
  metric: Metric;
  /** Name of the player to compare with, or "" for your lane opponent. */
  versus: string;
  /** In-game seconds at a video time. */
  gameAt: (t: number) => number | null;
  onMetric: (m: Metric) => void;
  onVersus: (name: string) => void;
  onSeek: (t: number) => void;
}

function valueAt(ts: number[], vs: number[], t: number): number | null {
  if (!ts.length || !vs.length) return null;
  let i = 0;
  while (i + 1 < ts.length && ts[i + 1] <= t) i++;
  return vs[Math.min(i, vs.length - 1)];
}

/** Comms rows and the numbers graph, on the same time scale as the timeline above them. */
export function Lanes({ duration, time, voice, showVoice, stats, showStats, players, metric, versus, gameAt, onMetric, onVersus, onSeek }: LanesProps) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const total = duration || 1;
  const pct = (t: number) => (Math.min(Math.max(t, 0), total) / total) * 100;

  const me = players.find((p) => p.isMe);
  const opponent = me?.position ? players.find((p) => p.team !== me.team && p.position === me.position) : undefined;
  const other = players.find((p) => p.name === versus && !p.isMe) ?? opponent;
  const series = useMemo(() => {
    if (!stats || !me) return null;
    const pick = (name: string | undefined): number[] | null => {
      const row = stats.players.find((p) => p.name === name);
      if (!row) return null;
      if (metric === "level") return row.level;
      if (metric === "cs") return row.cs;
      if (metric === "cspm") {
        return row.cs.map((v, i) => {
          const g = gameAt(stats.t[i]);
          return g !== null && g >= 60 ? Math.round((v / (g / 60)) * 10) / 10 : 0;
        });
      }
      return null;
    };
    const mine = metric === "gold" ? stats.gold : pick(me.name);
    const theirs = metric === "gold" ? null : pick(other?.name);
    if (!mine) return null;
    const top = Math.max(1, ...mine, ...(theirs ?? []));
    return { mine, theirs, top };
  }, [stats, me, other, metric, gameAt]);

  const voiceOn = showVoice && voice.length > 0;
  const statsOn = showStats && !!series && !!stats;
  if (!voiceOn && !statsOn) return null;

  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - r.left, 0), r.width);
    return { x, t: (x / r.width) * total };
  };
  const shown = hover?.t ?? time;
  const path = (vs: number[], top: number) => stats!.t.map((t, i) => `${(pct(t) * 10).toFixed(1)},${(58 - (vs[i] / top) * 52).toFixed(1)}`).join(" ");
  const talking = voiceOn ? voice.filter((r) => r.spans.some((s) => s[0] <= shown && shown <= s[1])).map((r) => r.label) : [];
  const fmt = (v: number | null) => (v === null ? "–" : metric === "cspm" ? v.toFixed(1) : String(Math.round(v)));

  return (
    <div className="lanes">
      <div className="lanes-head">
        {voiceOn && (
          <div className="legend" aria-label="Who was talking">
            {voice.map((r) => (
              <span key={r.key} className={talking.includes(r.label) ? "on" : ""}><i style={{ background: r.color }} aria-hidden />{r.label}</span>
            ))}
          </div>
        )}
        <span className="grow" />
        {statsOn && (
          <div className="stat-ctl">
            <span className="read">
              <b style={{ color: "var(--mark)" }}>You {fmt(valueAt(stats!.t, series!.mine, shown))}</b>
              {series!.theirs && other && <b className={other.team === me?.team ? "ally" : "enemy"}>{other.champion} {fmt(valueAt(stats!.t, series!.theirs, shown))}</b>}
              <span className="muted">at {clock(shown)}</span>
            </span>
            <select className="field-input" value={metric} aria-label="What the graph shows" onChange={(e) => onMetric(e.target.value as Metric)}>
              {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
            {metric !== "gold" && (
              <select className="field-input" value={other?.name ?? ""} aria-label="Compare with" onChange={(e) => onVersus(e.target.value)}>
                {!other && <option value="">Compare with…</option>}
                {players.filter((p) => !p.isMe).map((p) => (
                  <option key={p.name} value={p.name}>{p.champion}{laneName(p.position) ? ` (${laneName(p.position)})` : ""}{p === opponent ? ", your lane" : ""}</option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>
      <div
        ref={ref}
        className="lanes-body"
        onPointerDown={(e) => {
          dragging.current = true;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* the pointer is already gone */
          }
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
        {voiceOn && (
          <div className="voice" role="img" aria-label={`Who was talking. At ${clock(shown)}: ${talking.length ? talking.join(", ") : "nobody"}`}>
            {voice.map((r) => (
              <div className="vrow" key={r.key} title={r.label}>
                {r.spans.map((s, i) => (
                  <i key={i} style={{ left: `${pct(s[0])}%`, width: `max(2px, ${pct(s[1]) - pct(s[0])}%)`, background: r.color }} />
                ))}
              </div>
            ))}
          </div>
        )}
        {statsOn && (
          <svg className="statgraph" viewBox="0 0 1000 60" preserveAspectRatio="none" role="img" aria-label={`${METRICS.find((m) => m.key === metric)?.label} over the game`}>
            <line x1="0" x2="1000" y1="32" y2="32" stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            {series!.theirs && <polyline points={path(series!.theirs, series!.top)} fill="none" stroke={other?.team === me?.team ? "var(--ally)" : "var(--enemy)"} strokeWidth="2" vectorEffect="non-scaling-stroke" />}
            <polyline points={path(series!.mine, series!.top)} fill="none" stroke="var(--mark)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
        )}
        {statsOn && <span className="ymax">{fmt(series!.top)}</span>}
        {hover && <div className="ghost" style={{ left: hover.x }} />}
        <div className="head" style={{ left: `${pct(time)}%` }} />
      </div>
    </div>
  );
}
