// What sits under the timeline and in the Review tab: who was talking when, the
// numbers of the game as lines, and the lists of deaths and team fights to walk through.

import { ArrowDownWideNarrow, Bookmark, Check, ChevronLeft, ChevronRight, Clapperboard, Crosshair, Film, FolderOpen, MoreHorizontal, Play, Repeat, RotateCcw, Skull, Sparkles, Swords, Trophy, Users, X, Zap } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { Portrait } from "./ChampIcon";
import { clock, gameClockAt, laneName } from "./format";
import type { Coach, DeathInsight, FocusCheck, GameEvent, Highlight, Insights, MatchFull, MatchSummary, NextFocus, PlayerRow, Span, Stats, TeamReview } from "./types";
import { humanError, Menu, Select } from "./ui";
import type { KeyLog } from "./Views";

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
  /** A walk-through across games: where this game's stops sit in the whole list. */
  across?: { base: number; total: number; go: (index: number) => void };
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

function valueAt(ts: number[], vs: number[], t: number): number | null {
  if (!ts.length || !vs.length) return null;
  let i = 0;
  while (i + 1 < ts.length && ts[i + 1] <= t) i++;
  return vs[Math.min(i, vs.length - 1)];
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
  reel?: string | null;
  buildingReel?: boolean;
  onBuildReel?: () => void;
  /** Team reviews of fights, mine and teammates'. */
  team: TeamReview[];
  /** How many screens a team review would use (mine plus teammates' views that are ready). */
  teamViews: number;
  /** The fight being reviewed right now, by its start time. */
  teamBusy: number | null;
  onTeamReview: (fight: Fight) => void;
  stats?: Stats | null;
  players?: PlayerRow[];
  keys?: KeyLog | null;
  cpm?: number[];
  duration?: number;
  /** In-game length in seconds, for per-minute numbers. */
  gameLength?: number | null;
  /** What the player wanted to work on going into this game. */
  focus?: NextFocus | null;
  focusCheck?: FocusCheck | null;
  onFocusCheck?: (answer: FocusCheck["answer"] | null) => void;
  /** Marked as reviewed, and the focus chosen for the next games then. */
  reviewedAt?: number | null;
  nextFocus?: NextFocus | null;
  onFinish?: (nextFocus: string | null) => void;
  onReopen?: () => void;
  /** The player's usual numbers over recent games, to compare this one with. */
  usual?: Usual | null;
}

/** Averages over recent games, for context next to this game's numbers. */
export interface Usual {
  games: number;
  deadPct: number | null;
  csm: number | null;
  visionPm: number | null;
}

const ANSWERS: { key: FocusCheck["answer"]; label: string }[] = [
  { key: "yes", label: "Did it" },
  { key: "partly", label: "Partly" },
  { key: "no", label: "Not really" },
];

/** Side-panel tab with the things worth walking through after a game. */
export function ReviewTab({
  events,
  fights,
  bookmarks,
  queue,
  champKey,
  onStart,
  insights,
  coach,
  hintState,
  hintError,
  onAskHints,
  highlights,
  savingClips,
  onSaveClips,
  onShowClip,
  reel: reelFile,
  buildingReel,
  onBuildReel,
  team,
  teamViews,
  teamBusy,
  onTeamReview,
  stats,
  players = [],
  keys,
  cpm = [],
  duration = 0,
  gameLength,
  focus,
  focusCheck,
  onFocusCheck,
  reviewedAt,
  nextFocus,
  onFinish,
  onReopen,
  usual,
}: ReviewTabProps) {
  const [focusDraft, setFocusDraft] = useState<string | null>(null);
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

  const me = players.find((p) => p.isMe);
  const opponent = me?.position ? players.find((p) => p.team !== me.team && p.position === me.position) : undefined;

  const summaryStats = useMemo(() => {
    const meRow = me && stats ? stats.players.find((p) => p.name === me.name) : undefined;
    const deadSamples = meRow?.dead?.filter(Boolean).length ?? 0;
    const deadTotal = meRow?.dead?.length ?? 0;
    const deadSec = deadSamples * 10;
    const deadPct = deadTotal > 0 ? Math.round((deadSamples / deadTotal) * 100) : null;
    const avgGold = stats?.gold.length ? Math.round(stats.gold.reduce((a, b) => a + b, 0) / stats.gold.length) : null;
    const lastWard = meRow?.wardScore?.length ? meRow.wardScore[meRow.wardScore.length - 1] : null;
    const avgCpm = cpm.length ? Math.round(cpm.reduce((a, b) => a + b, 0) / cpm.length) : null;
    const avgKpm = keys && duration > 10 ? Math.round((keys.presses.length / duration) * 60) : null;
    const avgApm = avgCpm !== null || avgKpm !== null ? (avgCpm ?? 0) + (avgKpm ?? 0) : null;
    return { deadSec, deadPct, avgGold, lastWard, avgApm };
  }, [me, stats, cpm, keys, duration]);
  const minutes = (gameLength ?? 0) / 60;
  const csm = me && minutes > 1 ? me.cs / minutes : null;
  const visionPm = summaryStats.lastWard !== null && minutes > 1 ? summaryStats.lastWard / minutes : null;
  /** "8% · usually 12%" with a colour for better or worse; lower is better when `lowGood`. */
  const versus = (now: number | null, was: number | null | undefined, fmt: (v: number) => string, lowGood = false) => {
    if (now === null || was === null || was === undefined || !usual || usual.games < 3) return null;
    const better = lowGood ? now < was * 0.92 : now > was * 1.08;
    const worse = lowGood ? now > was * 1.08 : now < was * 0.92;
    return <small className={better ? "up" : worse ? "down" : ""}>usually {fmt(was)}</small>;
  };

  const preFightBits = (at: number, targetPlayerName?: string): string[] => {
    const t0 = Math.max(0, at - 8);
    const bits: string[] = [];
    if (stats && me) {
      const myRow = stats.players.find((p) => p.name === me.name);
      const otherRow = targetPlayerName
        ? stats.players.find((p) => p.name === targetPlayerName)
        : opponent
          ? stats.players.find((p) => p.name === opponent.name)
          : undefined;
      const myLv = myRow ? valueAt(stats.t, myRow.level, t0) : null;
      const otherLv = otherRow ? valueAt(stats.t, otherRow.level, t0) : null;
      if (myLv !== null) bits.push(otherLv !== null ? `Lv ${myLv} vs ${otherLv}` : `Lv ${myLv}`);
      const unspent = valueAt(stats.t, stats.gold, t0);
      if (unspent !== null && unspent >= 800) bits.push(`${Math.round(unspent)}g unspent`);
    }
    const recentBuy = [...events]
      .reverse()
      .find((e) => e.kind === "ItemPurchased" && e.mine && e.t <= at && e.t >= at - 75 && e.detail);
    if (recentBuy) bits.push(`Bought ${recentBuy.detail}`);
    if (keys) {
      const summs = keys.summonerPresses.filter((s) => s.t >= at - 6 && s.t <= at + 0.5);
      if (summs.length) {
        const last = summs[summs.length - 1];
        const dt = at - last.t;
        bits.push(dt >= 0 ? `Used ${last.key} ${dt.toFixed(1)}s before` : `Used ${last.key} right after`);
      }
    }
    return bits;
  };

  const hasSummary =
    summaryStats.deadPct !== null ||
    summaryStats.avgGold !== null ||
    csm !== null ||
    visionPm !== null ||
    summaryStats.avgApm !== null ||
    (keys?.spaceHoldPct !== null && keys?.spaceHoldPct !== undefined);

  const watchTime = (items: QueueItem[]) => clock(items.reduce((s, d) => s + (d.end - d.start), 0));
  const startHere =
    deaths.length > 0
      ? { label: `Watch your ${deaths.length} ${deaths.length === 1 ? "death" : "deaths"}`, sub: `${watchTime(deaths)} in all`, run: () => onStart("Deaths", deaths, 0) }
      : fightList.length > 0
        ? { label: `Watch the ${fightList.length} team ${fightList.length === 1 ? "fight" : "fights"}`, sub: `${watchTime(fightList)} in all`, run: () => onStart("Fights", fightList, 0) }
        : highlights.length > 0
          ? { label: "Watch the highlights", sub: `${watchTime(reel)} in all`, run: () => onStart("Highlights", reel, 0) }
          : null;
  const suggested = focusDraft ?? nextFocus?.text ?? coach?.nextGame ?? "";
  const highlightMenu = [
    unsaved
      ? { label: savingClips ? "Saving the clips" : "Save each as a clip", hint: "1080p, with game sound, Discord and your mic", icon: <Clapperboard size={15} />, disabled: savingClips, onSelect: onSaveClips }
      : { label: "Show the clips", icon: <FolderOpen size={15} />, onSelect: () => onShowClip(highlights[0].file!) },
    ...(onBuildReel
      ? [
          reelFile
            ? { label: "Show the highlight reel", icon: <Film size={15} />, onSelect: () => onShowClip(reelFile) }
            : { label: buildingReel ? "Making the reel" : "Make a highlight reel", hint: "Every highlight in one video", icon: <Film size={15} />, disabled: !!buildingReel, onSelect: onBuildReel },
        ]
      : []),
  ];

  return (
    <div className="sidebody review">
      {(focus || startHere) && (
        <section className="recap">
          {focus && (
            <div className="focuscheck">
              <span className="fl">
                <Crosshair size={14} aria-hidden />
                Your focus going into this game
              </span>
              <p className="ft">{focus.text}</p>
              {onFocusCheck && (
                <div className="answers" role="group" aria-label="How did it go?">
                  {ANSWERS.map((a) => (
                    <button
                      key={a.key}
                      className={`btn sm ${focusCheck?.answer === a.key ? `picked ${a.key}` : ""}`}
                      aria-pressed={focusCheck?.answer === a.key}
                      onClick={() => onFocusCheck(focusCheck?.answer === a.key ? null : a.key)}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {startHere && (
            <button className="starthere" onClick={startHere.run}>
              <span className="sh-ic">
                <Play size={15} fill="currentColor" />
              </span>
              <span className="sh-t">
                <b>{startHere.label}</b>
                <small>{startHere.sub}. It stops after each one so you can think about it.</small>
              </span>
            </button>
          )}
        </section>
      )}

      {hasSummary && (
        <section className="statstrip" aria-label="This game's numbers">
          {summaryStats.deadPct !== null && (
            <div title={`${clock(summaryStats.deadSec)} on the grey screen`}>
              <span>Time dead</span>
              <b>{summaryStats.deadPct}%</b>
              {versus(summaryStats.deadPct, usual?.deadPct, (v) => `${Math.round(v)}%`, true) ?? <small>{clock(summaryStats.deadSec)} in all</small>}
            </div>
          )}
          {csm !== null && (
            <div>
              <span>CS a minute</span>
              <b>{csm.toFixed(1)}</b>
              {versus(csm, usual?.csm, (v) => v.toFixed(1)) ?? <small>{me?.cs} in all</small>}
            </div>
          )}
          {visionPm !== null && (
            <div>
              <span>Vision a minute</span>
              <b>{visionPm.toFixed(2)}</b>
              {versus(visionPm, usual?.visionPm, (v) => v.toFixed(2)) ?? <small>score {Math.round(summaryStats.lastWard!)}</small>}
            </div>
          )}
          {summaryStats.avgGold !== null && (
            <div>
              <span>Gold left unspent</span>
              <b>{summaryStats.avgGold}g</b>
              <small className={summaryStats.avgGold > 1200 ? "down" : ""}>{summaryStats.avgGold > 1200 ? "on average: shop sooner" : "on average"}</small>
            </div>
          )}
          {summaryStats.avgApm !== null && (
            <div>
              <span>Actions a minute</span>
              <b>{summaryStats.avgApm}</b>
              <small>clicks and key presses</small>
            </div>
          )}
          {keys && keys.spaceHoldPct !== null && (
            <div>
              <span>Camera locked</span>
              <b>{keys.spaceHoldPct}%</b>
              <small>of the game, holding Space</small>
            </div>
          )}
          {keys && keys.aPresses > 0 && (
            <div>
              <span>Attack-move</span>
              <b>{keys.aPresses}×</b>
              <small>presses of A</small>
            </div>
          )}
        </section>
      )}

      {coach && (
        <section className="coach">
          <h3>
            <Sparkles size={15} aria-hidden />
            Coach's review
          </h3>
          <p className="headline">{coach.headline}</p>
          {coach.wentWell.length > 0 && (
            <>
              <h4>Went well</h4>
              <ul>
                {coach.wentWell.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          )}
          {coach.workOn.length > 0 && (
            <>
              <h4>Work on</h4>
              <ul>
                {coach.workOn.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </>
          )}
          {coach.nextGame && (
            <p className="next">
              <b>Next game</b>
              {coach.nextGame}
            </p>
          )}
          <small>Written by Gemini from the scoreboard and clips of your deaths. It can be wrong about what it saw.</small>
        </section>
      )}
      {wanted && hintState !== "off" && (
        <div className="ai-bar">
          <button
            className="btn"
            disabled={hintState === "busy"}
            onClick={onAskHints}
            title="Sends the scoreboard and a 17-second clip of each death to Google's Gemini. You get a written review, a hint on each death and a title for every player."
          >
            <Sparkles size={13} aria-hidden className={hintState === "busy" ? "spin" : ""} />
            {hintState === "busy" ? "Reviewing, about half a minute" : "Get the AI review"}
          </button>
        </div>
      )}
      {wanted && hintState === "off" && <p className="hint-note">A written review of the game and hints on each death can be switched on in Settings, under AI review.</p>}
      {hintError && <p className="down hint-note">{humanError(hintError)}</p>}
      {nothing && !coach && <p className="hint-note">No deaths, team fights or bookmarks in this recording.</p>}

      {deaths.length > 0 && (
        <section className="rv">
          <header>
            <h3>
              <Skull size={15} aria-hidden />
              Your deaths<span className="num">{deaths.length}</span>
            </h3>
            <span className="grow" />
            {hasHints && (
              <button className={`btn sm sq ${worstFirst ? "on" : ""}`} aria-pressed={worstFirst} aria-label="Most avoidable first" title="Most avoidable first" onClick={() => setWorstFirst((v) => !v)}>
                <ArrowDownWideNarrow size={14} />
              </button>
            )}
            <button className="btn sm" onClick={() => onStart("Deaths", deaths, 0)} title="Plays the 12 seconds before each death, then stops so you can think">
              <Play size={12} fill="currentColor" aria-hidden />
              Play all
            </button>
          </header>

          {deaths.map((d, i) => {
            const e = deathEvents[i];
            const pre = preFightBits(d.t, e?.killer);
            const lateSumm = keys?.summonerPresses.find((s) => s.t >= d.t - 3.5 && s.t <= d.t + 0.3);
            return (
              <button key={i} className={`moment ${active("Deaths", i) ? "now" : ""}`} onClick={() => onStart("Deaths", deaths, i)}>
                <span className="t">{clock(d.t)}</span>
                <span className="pic">
                  {e?.killerChamp ? (
                    <Portrait championKey={champKey(e.killerChamp)} name={e.killerChamp} size={26} side="enemy" />
                  ) : (
                    <span className="glyph enemy" style={{ width: 26, height: 26 }}>
                      <Skull size={14} />
                    </span>
                  )}
                  {(e?.assisters?.length ?? 0) > 0 && <small>+{e!.assisters!.length}</small>}
                </span>
                <span className="txt" title={rows[i].hint ? hintDetail(rows[i].hint!) : undefined}>
                  {d.label}
                  {lateSumm && (
                    <small className="hint bad">
                      <Zap size={11} aria-hidden />
                      {lateSumm.key} pressed {(d.t - lateSumm.t).toFixed(1)}s before death
                    </small>
                  )}
                  {pre.length > 0 && <small className="prefight">{pre.join(" · ")}</small>}
                  {rows[i].hint && (
                    <small className={`hint ${hintLine(rows[i].hint!).tone}`}>
                      <Sparkles size={11} aria-hidden />
                      {hintLine(rows[i].hint!).text}
                    </small>
                  )}
                  {(() => {
                    const said = coach?.deaths.find((c) => Math.abs(c.t - rows[i].e.t) < 1.5);
                    return said ? (
                      <small className="said">
                        {said.whatHappened}
                        {said.better && (
                          <>
                            <br />
                            <b>Better:</b> {said.better}
                          </>
                        )}
                      </small>
                    ) : null;
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
            <h3>
              <Swords size={15} aria-hidden />
              Team fights<span className="num">{fightList.length}</span>
            </h3>
            <span className="grow" />
            <button className="btn sm" onClick={() => onStart("Fights", fightList, 0)}>
              <Play size={12} fill="currentColor" aria-hidden />
              Play all
            </button>
          </header>
          {fights.map((f, i) => {
            const won = f.ours > f.theirs;
            const even = f.ours === f.theirs;
            const pre = preFightBits(f.start);
            const said = team.find((r) => Math.abs(r.t - f.start) < 6);
            return (
              <div key={i}>
                <button className={`moment ${active("Fights", i) ? "now" : ""}`} onClick={() => onStart("Fights", fightList, i)}>
                  <span className="t">{clock(f.start)}</span>
                  <span className="pic">
                    <b className={`tally ${even ? "" : won ? "ally" : "enemy"}`}>
                      {f.ours} : {f.theirs}
                    </b>
                  </span>
                  <span className="txt">
                    {even ? "Even trade" : won ? "Won" : "Lost"}, {Math.max(1, Math.round(f.end - f.start))} s{f.kills.some((k) => k.role === "death") ? ", you died" : ""}
                    {pre.length > 0 && <small className="prefight">{pre.join(" · ")}</small>}
                  </span>
                </button>
                {said ? (
                  <div className="teamrev">
                    <h4>
                      <Users size={13} aria-hidden />
                      Team review
                      <small>
                        from {said.views.length} {said.views.length === 1 ? "screen" : "screens"}: {said.views.join(", ")}
                      </small>
                    </h4>
                    <p>{said.summary}</p>
                    {said.turningPoint && (
                      <p>
                        <b>Turning point:</b> {said.turningPoint}
                      </p>
                    )}
                    {said.shouldHave.length > 0 && (
                      <ul>
                        {said.shouldHave.map((s, k) => (
                          <li key={k}>{s}</li>
                        ))}
                      </ul>
                    )}
                    {said.players.map((p, k) => (
                      <p key={k} className="who">
                        <Portrait championKey={champKey(p.champion)} name={p.champion} size={20} side="ally" />
                        <span>
                          <b>{p.champion}:</b> {p.did} <i>{p.better}</i>
                        </span>
                      </p>
                    ))}
                    {said.call && <p className="call">“{said.call}”</p>}
                  </div>
                ) : hintState !== "off" ? (
                  <button
                    className="btn sm quiet teamask"
                    disabled={teamBusy !== null}
                    onClick={() => onTeamReview(f)}
                    title="Sends this fight from your screen and every teammate's view that is ready to Google's Gemini, and asks what the team should have done. Pictures only: no Discord, no microphone."
                  >
                    <Users size={13} aria-hidden />
                    {teamBusy === f.start ? "Reviewing, about half a minute" : `Team review from ${teamViews} ${teamViews === 1 ? "screen" : "screens"}`}
                  </button>
                ) : null}
              </div>
            );
          })}
        </section>
      )}
      {highlights.length > 0 && (
        <section className="rv">
          <header>
            <h3>
              <Trophy size={15} aria-hidden />
              Highlights<span className="num">{highlights.length}</span>
            </h3>
            <span className="grow" />
            <button className="btn sm" onClick={() => onStart("Highlights", reel, 0)}>
              <Play size={12} fill="currentColor" aria-hidden />
              Play all
            </button>
            <Menu label="More for highlights" className="btn sm sq quiet" items={highlightMenu}>
              <MoreHorizontal size={15} />
            </Menu>
          </header>
          {highlights.map((h, i) => (
            <button key={i} className={`moment ${active("Highlights", i) ? "now" : ""}`} onClick={() => onStart("Highlights", reel, i)}>
              <span className="t">{clock(h.t)}</span>
              <span className="pic">
                <span className="glyph mark" style={{ width: 26, height: 26 }}>
                  {h.kind === "fight" || h.kind === "objective" ? <Swords size={14} /> : <Trophy size={14} />}
                </span>
              </span>
              <span className="txt">
                {h.label}
                <small className="hint">
                  {Math.round(h.end - h.start)} s{h.file ? ", clip saved" : ""}
                </small>
              </span>
            </button>
          ))}
        </section>
      )}
      {marks.length > 0 && (
        <section className="rv">
          <header>
            <h3>
              <Bookmark size={15} aria-hidden />
              Bookmarks<span className="num">{marks.length}</span>
            </h3>
            <span className="grow" />
            <button className="btn sm" onClick={() => onStart("Bookmarks", marks, 0)}>
              <Play size={12} fill="currentColor" aria-hidden />
              Play all
            </button>
          </header>
          {marks.map((m, i) => (
            <button key={i} className={`moment ${active("Bookmarks", i) ? "now" : ""}`} onClick={() => onStart("Bookmarks", marks, i)}>
              <span className="t">{clock(m.t)}</span>
              <span className="pic">
                <span className="glyph mark" style={{ width: 26, height: 26 }}>
                  <Bookmark size={14} fill="currentColor" />
                </span>
              </span>
              <span className="txt">Bookmark</span>
            </button>
          ))}
        </section>
      )}

      {onFinish && (
        <section className="finish">
          {reviewedAt ? (
            <div className="done">
              <span className="okmark">
                <Check size={15} aria-hidden />
              </span>
              <div className="dt">
                <b>Reviewed</b>
                {nextFocus?.text ? (
                  <p>
                    Next games, work on: <i>{nextFocus.text}</i>
                  </p>
                ) : (
                  <p>No focus set for the next games.</p>
                )}
              </div>
              <button className="btn sm quiet" onClick={onReopen}>
                Change
              </button>
            </div>
          ) : (
            <>
              <h3>Finish the review</h3>
              <label className="fl" htmlFor="nextfocus">
                One thing to work on next game
              </label>
              <textarea
                id="nextfocus"
                className="field-input"
                rows={2}
                value={suggested}
                placeholder="For example: ward the river before crossing it"
                onChange={(e) => setFocusDraft(e.target.value)}
              />
              <small className="muted">Rewatch reminds you of it when your next game starts, then asks how it went.</small>
              <button className="btn primary" onClick={() => onFinish(suggested.trim() || null)}>
                <Check size={15} aria-hidden />
                Mark as reviewed
              </button>
            </>
          )}
        </section>
      )}
    </div>
  );
}

/** The strip over the video while a walk-through is running. */
export function QueueBar({
  queue,
  looping,
  onToggleLoop,
  onGo,
  onReplay,
  onClose,
}: {
  queue: Queue;
  looping: boolean;
  onToggleLoop: () => void;
  onGo: (idx: number) => void;
  onReplay: () => void;
  onClose: () => void;
}) {
  const item = queue.items[queue.idx];
  const total = queue.across?.total ?? queue.items.length;
  const at = (queue.across?.base ?? 0) + queue.idx;
  return (
    <div className="queuebar" role="group" aria-label={`${queue.title} walk-through`}>
      <span className="qprog" aria-hidden>
        <i style={{ width: `${((at + 1) / total) * 100}%` }} />
      </span>
      <b>
        {queue.title} <span className="num">{at + 1}</span> of <span className="num">{total}</span>
      </b>
      <span className="ql">
        {clock(item.t)} · {item.label}
      </span>
      <button className="btn sm sq" disabled={at === 0} onClick={() => onGo(queue.idx - 1)} aria-label="Previous" title="Previous (P)">
        <ChevronLeft size={16} />
      </button>
      <button className="btn sm sq" onClick={onReplay} aria-label="Play this one again" title="Play this one again">
        <RotateCcw size={14} />
      </button>
      <button className={`btn sm sq ${looping ? "on" : ""}`} aria-pressed={looping} onClick={onToggleLoop} aria-label="Loop this moment" title="Loop this moment (R)">
        <Repeat size={14} />
      </button>
      <button className="btn sm sq" disabled={at >= total - 1} onClick={() => onGo(queue.idx + 1)} aria-label="Next" title="Next (N)">
        <ChevronRight size={16} />
      </button>
      <button className="btn sm sq quiet" onClick={onClose} aria-label="Stop the walk-through" title="Stop (Esc)">
        <X size={15} />
      </button>
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

export type Metric = "cs" | "cspm" | "level" | "gold" | "itemGold" | "goldDiff" | "killDiff" | "wards" | "apm";
const METRICS: { key: Metric; label: string }[] = [
  { key: "cs", label: "CS" },
  { key: "cspm", label: "CS per minute" },
  { key: "level", label: "Level" },
  { key: "gold", label: "Unspent gold" },
  { key: "itemGold", label: "Item gold" },
  { key: "goldDiff", label: "Team gold diff" },
  { key: "killDiff", label: "Team kill diff" },
  { key: "wards", label: "Vision score" },
  { key: "apm", label: "APM (clicks + keys)" },
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
  cpm?: number[];
  cpmBucket?: number;
  keys?: KeyLog | null;
  currentId?: string;
  compareGames?: MatchSummary[];
  onMetric: (m: Metric) => void;
  onVersus: (name: string) => void;
  onSeek: (t: number) => void;
}

/** Comms rows and the numbers graph, on the same time scale as the timeline above them. */
export function Lanes({
  duration,
  time,
  voice,
  showVoice,
  stats,
  showStats,
  players,
  metric: wantedMetric,
  versus,
  gameAt,
  cpm = [],
  cpmBucket = 5,
  keys,
  currentId,
  compareGames = [],
  onMetric,
  onVersus,
  onSeek,
}: LanesProps) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [compareId, setCompareId] = useState("");
  const [compareMatch, setCompareMatch] = useState<MatchFull | null>(null);
  const compareCache = useRef(new Map<string, MatchFull>());

  useEffect(() => {
    if (!compareId) {
      setCompareMatch(null);
      return;
    }
    const cached = compareCache.current.get(compareId);
    if (cached) {
      setCompareMatch(cached);
      return;
    }
    let live = true;
    api.getMatch(compareId).then((m) => {
      compareCache.current.set(compareId, m);
      if (live) setCompareMatch(m);
    }).catch(() => {
      if (live) setCompareMatch(null);
    });
    return () => {
      live = false;
    };
  }, [compareId]);

  const total = duration || 1;
  const pct = (t: number) => (Math.min(Math.max(t, 0), total) / total) * 100;

  const me = players.find((p) => p.isMe);
  const opponent = me?.position ? players.find((p) => p.team !== me.team && p.position === me.position) : undefined;
  const other = players.find((p) => p.name === versus && !p.isMe) ?? opponent;

  const hasItemGold = !!stats?.players.some((p) => (p.itemGold?.length ?? 0) > 0);
  const hasWards = !!stats?.players.some((p) => (p.wardScore?.length ?? 0) > 0);
  const hasApm = cpm.length > 0 || (keys?.presses.length ?? 0) > 0;

  const availableMetrics = useMemo(
    () =>
      METRICS.filter((m) => {
        if (m.key === "itemGold" || m.key === "goldDiff") return hasItemGold;
        if (m.key === "wards") return hasWards;
        if (m.key === "apm") return hasApm;
        return true;
      }),
    [hasItemGold, hasWards, hasApm],
  );
  // The chosen metric is remembered across games; older recordings lack some of them.
  const metric: Metric = availableMetrics.some((m) => m.key === wantedMetric) ? wantedMetric : "cs";

  const extractSeries = (st: Stats, ps: PlayerRow[], m: Metric, targetName: string | undefined, gAt: (t: number) => number | null): number[] | null => {
    const myPlayer = ps.find((p) => p.isMe);
    if (!myPlayer) return null;
    if (m === "gold") return st.gold;
    if (m === "goldDiff" || m === "killDiff") {
      return st.t.map((_, i) => {
        let ours = 0;
        let theirs = 0;
        for (const row of st.players) {
          const pInfo = ps.find((p) => p.name === row.name);
          const val = m === "goldDiff" ? (row.itemGold?.[i] ?? 0) : (row.kills[i] ?? 0);
          if (pInfo?.team === myPlayer.team) ours += val;
          else theirs += val;
        }
        return ours - theirs;
      });
    }
    const pick = (name: string | undefined): number[] | null => {
      const row = st.players.find((p) => p.name === name);
      if (!row) return null;
      if (m === "level") return row.level;
      if (m === "cs") return row.cs;
      if (m === "itemGold") return row.itemGold ?? null;
      if (m === "wards") return row.wardScore ?? null;
      if (m === "cspm") {
        return row.cs.map((v, i) => {
          const g = gAt(st.t[i]);
          return g !== null && g >= 60 ? Math.round((v / (g / 60)) * 10) / 10 : 0;
        });
      }
      return null;
    };
    return pick(targetName);
  };

  const series = useMemo(() => {
    const ts = stats?.t ?? (metric === "apm" && hasApm ? Array.from({ length: Math.max(2, cpm.length) }, (_, i) => i * cpmBucket) : null);
    if (!ts || !ts.length) return null;

    let mine: number[] | null = null;
    let theirs: number[] | null = null;
    if (metric === "apm") {
      if (!hasApm) return null;
      mine = ts.map((t) => {
        const b = Math.floor(t / cpmBucket);
        const clickRate = cpm[b] ?? 0;
        const keyRate = keys ? keys.presses.filter((p) => p >= b * cpmBucket && p < (b + 1) * cpmBucket).length * (60 / cpmBucket) : 0;
        return Math.round(clickRate + keyRate);
      });
    } else if (stats && me) {
      mine = extractSeries(stats, players, metric, me.name, gameAt);
      if (metric !== "gold" && metric !== "goldDiff" && metric !== "killDiff") {
        theirs = extractSeries(stats, players, metric, other?.name, gameAt);
      }
    }
    if (!mine || !mine.length) return null;

    // Cross-game comparison aligned by in-game clock.
    let comp: number[] | null = null;
    if (compareMatch?.stats && metric !== "apm") {
      const cStats = compareMatch.stats;
      const cPlayers = compareMatch.game?.players ?? [];
      const cMe = compareMatch.game?.me;
      const cGameAt = (t: number) => gameClockAt(compareMatch.clock ?? [], t);
      const rawComp = extractSeries(cStats, cPlayers, metric, cMe?.name, cGameAt);
      if (rawComp && rawComp.length) {
        const cGameTimes = cStats.t.map((t) => cGameAt(t) ?? t);
        comp = ts.map((t) => {
          const g = gameAt(t) ?? t;
          return valueAt(cGameTimes, rawComp, g) ?? rawComp[0];
        });
      }
    }

    const allVals = [...mine, ...(theirs ?? []), ...(comp ?? [])];
    const minVal = Math.min(0, ...allVals);
    const maxVal = Math.max(1, ...allVals);
    let lo = 0;
    let hi = maxVal;
    if (minVal < 0) {
      const span = Math.max(1, Math.abs(minVal), Math.abs(maxVal));
      lo = -span;
      hi = span;
    }
    return { ts, mine, theirs, comp, lo, hi };
  }, [stats, me, other, players, metric, gameAt, hasApm, cpm, cpmBucket, keys, compareMatch]);

  // CS@10 and CS@15 benchmarks
  const benchmarks = useMemo(() => {
    if (!stats || !me) return null;
    const myRow = stats.players.find((p) => p.name === me.name);
    if (!myRow) return null;
    const oppRow = opponent ? stats.players.find((p) => p.name === opponent.name) : undefined;
    const atMin = (sec: number) => {
      for (let i = 0; i < stats.t.length; i++) {
        const g = gameAt(stats.t[i]);
        if (g !== null && g >= sec) {
          const myCs = myRow.cs[i];
          const oppCs = oppRow?.cs[i];
          return { cs: myCs, diff: oppCs !== undefined ? myCs - oppCs : null };
        }
      }
      return null;
    };
    const cs10 = atMin(600);
    const cs15 = atMin(900);
    if (!cs10 && !cs15) return null;
    return { cs10, cs15 };
  }, [stats, me, opponent, gameAt]);

  const voiceOn = showVoice && voice.length > 0;
  const statsOn = showStats && !!series;
  if (!voiceOn && !statsOn) return null;

  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const x = Math.min(Math.max(clientX - r.left, 0), r.width);
    return { x, t: (x / r.width) * total };
  };
  const shown = hover?.t ?? time;
  const yOf = (v: number, lo: number, hi: number) => 58 - ((v - lo) / Math.max(1e-6, hi - lo)) * 52;
  const path = (ts: number[], vs: number[], lo: number, hi: number) => ts.map((t, i) => `${(pct(t) * 10).toFixed(1)},${yOf(vs[i], lo, hi).toFixed(1)}`).join(" ");
  const talking = voiceOn ? voice.filter((r) => r.spans.some((s) => s[0] <= shown && shown <= s[1])).map((r) => r.label) : [];
  const fmt = (v: number | null) => {
    if (v === null) return "–";
    if (metric === "cspm") return v.toFixed(1);
    if ((metric === "goldDiff" || metric === "killDiff") && v > 0) return `+${Math.round(v)}`;
    return String(Math.round(v));
  };
  const zeroY = series ? yOf(0, series.lo, series.hi) : 32;
  const otherGames = compareGames.filter((g) => g.id !== currentId && g.mode !== "manual" && g.game?.me);

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
        {benchmarks && (
          <div className="bench" title="CS benchmarks at 10 and 15 in-game minutes">
            {benchmarks.cs10 && (
              <span>CS@10 <b>{benchmarks.cs10.cs}</b>{benchmarks.cs10.diff !== null && <i className={benchmarks.cs10.diff >= 0 ? "ally" : "enemy"}> ({benchmarks.cs10.diff >= 0 ? "+" : ""}{benchmarks.cs10.diff})</i>}</span>
            )}
            {benchmarks.cs15 && (
              <span>CS@15 <b>{benchmarks.cs15.cs}</b>{benchmarks.cs15.diff !== null && <i className={benchmarks.cs15.diff >= 0 ? "ally" : "enemy"}> ({benchmarks.cs15.diff >= 0 ? "+" : ""}{benchmarks.cs15.diff})</i>}</span>
            )}
          </div>
        )}
        <span className="grow" />
        {statsOn && (
          <div className="stat-ctl">
            <span className="read">
              <b style={{ color: "var(--mark)" }}>You {fmt(valueAt(series!.ts, series!.mine, shown))}</b>
              {series!.theirs && other && <b className={other.team === me?.team ? "ally" : "enemy"}>{other.champion} {fmt(valueAt(series!.ts, series!.theirs, shown))}</b>}
              {series!.comp && compareMatch?.game?.me && (
                <b style={{ color: "var(--epic)" }}>{compareMatch.game.me.champion} (prev) {fmt(valueAt(series!.ts, series!.comp, shown))}</b>
              )}
              <span className="muted">at {clock(shown)}</span>
            </span>
            <Select small className="ghost" label="What the graph shows" value={metric} onChange={onMetric} placement="top-end" options={availableMetrics.map((m) => ({ value: m.key, label: m.label }))} />
            {metric !== "gold" && metric !== "goldDiff" && metric !== "killDiff" && metric !== "apm" && (
              <Select
                small
                className="ghost"
                label="Compare with"
                prefix="vs"
                value={other?.name ?? ""}
                onChange={onVersus}
                placement="top-end"
                options={[
                  ...(!other ? [{ value: "", label: "Nobody" }] : []),
                  ...players
                    .filter((p) => !p.isMe)
                    .map((p) => ({ value: p.name, label: p.champion, hint: [laneName(p.position), p === opponent ? "your lane" : "", p.team === me?.team ? "your team" : "enemy"].filter(Boolean).join(", ") })),
                ]}
              />
            )}
            {otherGames.length > 0 && metric !== "apm" && (
              <Select
                small
                className="ghost"
                label="Compare with another of your games"
                value={compareId}
                onChange={setCompareId}
                placement="top-end"
                options={[
                  { value: "", label: "No other game" },
                  ...otherGames.slice(0, 20).map((g) => ({
                    value: g.id,
                    label: `${g.game.me?.champion ?? "Game"}, ${new Date(g.startedEpochMs).toLocaleDateString([], { month: "short", day: "numeric" })}`,
                    hint: g.game.result === "Win" ? "Victory" : g.game.result === "Lose" ? "Defeat" : undefined,
                  })),
                ]}
              />
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
            <line x1="0" x2="1000" y1={zeroY} y2={zeroY} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            {series!.theirs && <polyline points={path(series!.ts, series!.theirs, series!.lo, series!.hi)} fill="none" stroke={other?.team === me?.team ? "var(--ally)" : "var(--enemy)"} strokeWidth="2" vectorEffect="non-scaling-stroke" />}
            {series!.comp && <polyline points={path(series!.ts, series!.comp, series!.lo, series!.hi)} fill="none" stroke="var(--epic)" strokeWidth="2" strokeDasharray="5 3" vectorEffect="non-scaling-stroke" />}
            <polyline points={path(series!.ts, series!.mine, series!.lo, series!.hi)} fill="none" stroke="var(--mark)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </svg>
        )}
        {statsOn && <span className="ymax">{fmt(series!.hi)}</span>}
        {hover && <div className="ghost" style={{ left: hover.x }} />}
        <div className="head" style={{ left: `${pct(time)}%` }} />
      </div>
    </div>
  );
}
