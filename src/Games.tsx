import { Bookmark, Check, CircleCheck, CircleDashed, CircleDot, Crosshair, Film, HardDrive, LayoutGrid, List, MessageSquare, Play, Search, Skull, Star, Trash2, Video, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { absoluteFileUrl, api, fileUrl, pickFolder } from "./api";
import { Portrait } from "./ChampIcon";
import { ago, bytes, clock, dayLabel, timeOfDay, toReview } from "./format";
import { Logo } from "./icons";
import { STORY_HINT, storyLabel } from "./Insights";
import { LpDelta, queueLabel, standing } from "./Rank";
import { ItemSlots, Kda, KdaRatio } from "./Stats";
import type { Environment, MatchSummary, NextFocus, Review, Settings, Story } from "./types";
import { humanError, ownsKeys, Popover, Select, Skeleton, useToast } from "./ui";

interface Props {
  matches: MatchSummary[] | null;
  settings: Settings | null;
  busy: boolean;
  /** Open a game; "deaths" starts straight on a walk-through of its deaths. */
  onOpen: (id: string, start?: "deaths") => void;
  onRecord: () => void;
  onSaveSettings: (s: Settings) => Promise<void>;
  /** Delete games (the app offers an undo for a few seconds). */
  onDelete: (ids: string[], what?: string) => void;
  /** Reviews were changed here: load the list again. */
  onChanged: () => void;
  onSettings: () => void;
}

type Filter = "all" | "review" | "win" | "lose" | "kept";
type Layout = "grid" | "list";

const LAYOUT_KEY = "rewatch.library.layout";
function loadLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

const gameLength = (m: MatchSummary) => (m.trimmedToHighlights ? (m.reelDuration ?? m.duration) : (m.game?.length ?? m.duration));
const champName = (m: MatchSummary) => m.game?.me?.champion ?? (m.mode === "manual" ? "Screen recording" : "League game");
const queueName = (m: MatchSummary) => m.game?.queueName ?? (m.mode === "manual" ? "Screen recording" : m.game?.mode === "PRACTICETOOL" ? "Practice Tool" : "League game");
const STORIES: Story[] = ["stomp", "comeback", "throw", "close"];
const STORY_FILTER: Record<Story, string> = { stomp: "Stomps", comeback: "Comebacks", throw: "Throws", close: "Close games" };

/** "Comeback", "Stomped"...: what kind of game it was, from Riot's gold numbers. */
function StoryChip({ m }: { m: MatchSummary }) {
  if (!m.story) return null;
  const won = m.game?.result === "Win" ? true : m.game?.result === "Lose" ? false : null;
  return (
    <span className={`story ${m.story}${m.story === "stomp" && won === false ? " lost" : ""}`} title={STORY_HINT[m.story]}>
      {storyLabel(m.story, won)}
    </span>
  );
}
const resultOf = (m: MatchSummary) => (m.game?.result === "Win" ? "win" : m.game?.result === "Lose" ? "lose" : "");

/** Both teams in two small columns, yours first, as in a match history. */
function Teams({ m }: { m: MatchSummary }) {
  const players = m.game?.players ?? [];
  if (players.length < 2) return <span className="lh-teams" />;
  const mine = players.find((p) => p.isMe)?.team ?? players[0].team;
  const sides = [players.filter((p) => p.team === mine), players.filter((p) => p.team !== mine)];
  return (
    <span className="lh-teams" aria-hidden>
      {sides.map((side, i) => (
        <span key={i} className="lh-team">
          {side.slice(0, 5).map((p) => (
            <span key={p.name + p.champion} className={`lh-p ${p.isMe ? "me" : ""}`}>
              <Portrait championKey={p.championKey} name={p.champion} size={16} square />
              <i>{p.isMe ? "You" : p.name || p.champion}</i>
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

/** A thumbnail that plays through the recording as the pointer moves across it. */
function Thumb({ m, flags = true }: { m: MatchSummary; flags?: boolean }) {
  const [live, setLive] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const vid = useRef<HTMLVideoElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const busy = useRef(false);
  const want = useRef<number | null>(null);
  const last = useRef(0);
  const res = resultOf(m);
  const len = gameLength(m);

  const seek = (f: number) => {
    const v = vid.current;
    if (!v || !Number.isFinite(v.duration) || busy.current) {
      want.current = f;
      return;
    }
    busy.current = true;
    v.currentTime = Math.min(Math.max(f, 0), 0.999) * v.duration;
  };
  const next = () => {
    if (want.current === null) return;
    const f = want.current;
    want.current = null;
    seek(f);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <span
      className={`shot ${m.thumb ? "" : "blank"}`}
      onPointerEnter={() => {
        // A short wait, so moving across the page does not open every video on the way.
        timer.current = window.setTimeout(() => setLive(true), 160);
      }}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const f = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
        last.current = f;
        setAt(f);
        seek(f);
      }}
      onPointerLeave={() => {
        window.clearTimeout(timer.current);
        setLive(false);
        setDrawn(false);
        setAt(null);
        busy.current = false;
        want.current = null;
      }}
    >
      {m.thumb && <img src={absoluteFileUrl(m.thumb)} alt="" loading="lazy" />}
      {!m.thumb && (
        <span className="ph" aria-hidden>
          {m.game?.me ? <Portrait championKey={m.game.me.championKey} name={m.game.me.champion} size={44} /> : <Video size={22} />}
        </span>
      )}
      {live && (
        <video
          ref={vid}
          src={fileUrl(m.dir, m.video)}
          muted
          preload="metadata"
          className={drawn ? "on" : ""}
          onLoadedMetadata={() => seek(last.current)}
          onSeeked={() => {
            busy.current = false;
            setDrawn(true);
            next();
          }}
          onError={() => setLive(false)}
        />
      )}
      {flags && (
        <span className="flags">
          {m.keep && (
            <span className="kept" title="Kept: never deleted to make room">
              <Star size={12} fill="currentColor" aria-label="Kept" />
            </span>
          )}
          {m.trimmedToHighlights && (
            <span title="Trimmed to its highlights">
              <Film size={12} aria-hidden />
              Reel
            </span>
          )}
          {m.noteCount > 0 && (
            <span title={`${m.noteCount} ${m.noteCount === 1 ? "note" : "notes"}`}>
              <MessageSquare size={12} aria-hidden />
              {m.noteCount}
            </span>
          )}
          {m.summary.bookmarks > 0 && (
            <span title={`${m.summary.bookmarks} ${m.summary.bookmarks === 1 ? "bookmark" : "bookmarks"}`}>
              <Bookmark size={12} aria-hidden />
              {m.summary.bookmarks}
            </span>
          )}
        </span>
      )}
      {at !== null && live && <i className="scrubline" style={{ left: `${at * 100}%` }} />}
      <span className="len num">{at !== null && live && drawn ? clock(at * (vid.current?.duration || len)) : clock(len)}</span>
      {res && <span className={`edge ${res}`} />}
    </span>
  );
}

/** How much room the recordings take, and what goes first when the limit is reached. */
function Storage({ matches, settings, env, onSettings }: { matches: MatchSummary[]; settings: Settings; env: Environment | null; onSettings: () => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const used = matches.reduce((n, m) => n + m.sizeBytes, 0);
  const limit = settings.quotaGb > 0 ? settings.quotaGb * 1024 ** 3 : null;
  const free = env?.freeBytes ?? null;
  // Without a limit, the drive itself is the limit.
  const cap = limit ?? (free !== null ? used + free : null);
  const pct = cap ? Math.min(1, used / cap) : 0;
  const tone = pct > 0.9 ? "full" : pct > 0.75 ? "high" : "";
  const next = limit ? [...matches].filter((m) => !m.keep).sort((a, b) => a.startedEpochMs - b.startedEpochMs)[0] : undefined;
  const kept = matches.filter((m) => m.keep);
  return (
    <>
      <button ref={btn} className={`storage ${tone}`} aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Storage">
        <HardDrive size={14} aria-hidden />
        <span className="sbar" aria-hidden>
          <i style={{ width: `${Math.max(2, pct * 100)}%` }} />
        </span>
        <span className="num">
          {bytes(used)}
          {limit ? <span className="muted"> of {settings.quotaGb} GB</span> : null}
        </span>
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} placement="bottom-end" label="Storage">
        <div className="pop-pad storagepop">
          <h3>Storage</h3>
          <div className={`sbar big ${tone}`} aria-hidden>
            <i style={{ width: `${Math.max(1, pct * 100)}%` }} />
          </div>
          <p>
            Recordings use <b>{bytes(used)}</b>
            {limit ? ` of the ${settings.quotaGb} GB limit` : ""}.{free !== null ? ` ${bytes(free)} is free on the drive.` : ""}
          </p>
          {limit ? (
            <p>
              Past the limit, the oldest games you have not kept are deleted first.
              {next ? (
                <>
                  {" "}
                  Next to go: <b>{champName(next)}</b>, {new Date(next.startedEpochMs).toLocaleDateString([], { day: "numeric", month: "short" })} ({bytes(next.sizeBytes)}).
                </>
              ) : (
                " Every game is kept, so nothing can be deleted."
              )}
            </p>
          ) : (
            <p>There is no size limit, so nothing is deleted by itself. Recording stops when the drive is full.</p>
          )}
          {kept.length > 0 && (
            <p className="muted">
              {kept.length} kept {kept.length === 1 ? "game uses" : "games use"} {bytes(kept.reduce((n, m) => n + m.sizeBytes, 0))}.
            </p>
          )}
          <div className="pop-acts">
            <button
              className="btn sm"
              onClick={() => {
                setOpen(false);
                onSettings();
              }}
            >
              {limit ? "Change the limit" : "Set a limit"}
            </button>
          </div>
        </div>
      </Popover>
    </>
  );
}

/** What is set up and what is missing, for a library with nothing in it yet. */
function Checklist({ settings, env, busy, onRecord, onSettings }: { settings: Settings; env: Environment | null; busy: boolean; onRecord: () => void; onSettings: () => void }) {
  const items: { ok: boolean | null; label: string; detail: string; optional?: boolean }[] = [
    { ok: !!settings.recordingsDir, label: "Recordings folder", detail: settings.recordingsDir || "Not chosen yet." },
    { ok: env ? !!(env.leagueDir || settings.leagueDir) : null, label: "League of Legends", detail: env?.leagueDir || settings.leagueDir || "Not found. Set its folder in Settings so games are seen starting." },
    { ok: env ? !!env.ffmpegVersion : null, label: "FFmpeg", detail: env?.ffmpegVersion ? env.ffmpegVersion.replace(/^ffmpeg version /, "Version ").split(" Copyright")[0] : "Recording needs it. Set its path in Settings." },
    { ok: settings.recordDiscord || settings.recordMic, label: "Discord and your mic", detail: settings.recordDiscord || settings.recordMic ? "Recorded as their own sound tracks, so you can mute either later." : "Not recorded. Turn them on in Settings to hear your calls back." },
    { ok: settings.friends.length > 0, optional: true, label: "Teammates", detail: settings.friends.length ? `${settings.friends.length} added. You can watch their view of games you played together.` : "Optional. Add a friend's code to watch their view of the same game." },
  ];
  return (
    <div className="checklist">
      <ul>
        {items.map((it) => (
          <li key={it.label} className={it.ok ? "ok" : it.optional ? "opt" : it.ok === null ? "wait" : "todo"}>
            {it.ok ? <CircleCheck size={18} aria-label="Done" /> : <CircleDashed size={18} aria-label={it.optional ? "Optional" : "Not done"} />}
            <span>
              <b>{it.label}</b>
              <small>{it.detail}</small>
            </span>
          </li>
        ))}
      </ul>
      <div className="cl-acts">
        <button className="btn primary" onClick={onRecord} disabled={busy}>
          <CircleDot size={15} aria-hidden />
          Record a test
        </button>
        <button className="btn" onClick={onSettings}>
          Open Settings
        </button>
      </div>
      <p className="muted">A test records your screen until you press Stop at the top. League games are recorded by themselves.</p>
    </div>
  );
}

function FirstRun({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => Promise<void> }) {
  const [dir, setDir] = useState("");
  const [env, setEnv] = useState<Environment | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api
      .environment()
      .then((e) => {
        setEnv(e);
        setDir((d) => d || e.suggestedRecordingsDir);
      })
      .catch(() => {});
  }, []);
  return (
    <div className="welcome">
      <span className="wl-logo">
        <Logo size={30} />
      </span>
      <h1>Welcome to Rewatch</h1>
      <p className="lede">It records your League games by itself, with your Discord call and mic on their own tracks, so you can watch back what happened and why.</p>
      <div className="wl-step">
        <h2>Where should recordings go?</h2>
        <p>A 35-minute game takes about 5 to 15 GB, so pick a drive with room. You can set a size limit later.</p>
        <div className="wl-row">
          <input className="field-input" type="text" value={dir} onChange={(e) => setDir(e.target.value)} aria-label="Recordings folder" />
          <button className="btn" onClick={async () => setDir((await pickFolder(dir)) ?? dir)}>
            Browse
          </button>
        </div>
        <button
          className="btn primary"
          disabled={!dir.trim() || saving}
          onClick={() => {
            setSaving(true);
            onSave({ ...settings, recordingsDir: dir.trim() }).finally(() => setSaving(false));
          }}
        >
          Use this folder
        </button>
      </div>
      {env && (
        <ul className="wl-checks">
          <li className={env.leagueDir ? "ok" : "todo"}>
            {env.leagueDir ? <CircleCheck size={16} aria-hidden /> : <CircleDashed size={16} aria-hidden />}
            {env.leagueDir ? "League of Legends found" : "League of Legends not found yet"}
          </li>
          <li className={env.ffmpegVersion ? "ok" : "todo"}>
            {env.ffmpegVersion ? <CircleCheck size={16} aria-hidden /> : <CircleDashed size={16} aria-hidden />}
            {env.ffmpegVersion ? "FFmpeg found" : "FFmpeg not found. Recording needs it; set its path in Settings."}
          </li>
        </ul>
      )}
    </div>
  );
}

/** The newest game nobody has reviewed: the obvious next thing to do. */
function Recap({ m, focus, onOpen }: { m: MatchSummary; focus: NextFocus | null; onOpen: Props["onOpen"] }) {
  const me = m.game!.me!;
  const mins = Math.max(1, (m.game?.length ?? m.duration) / 60);
  const res = resultOf(m);
  return (
    <section className="recap-hero" aria-label="Your last game">
      <button className="rh-shot" onClick={() => onOpen(m.id)} aria-label={`Review your ${me.champion} game`}>
        <Thumb m={m} flags={false} />
      </button>
      <div className="rh-body">
        <span className="eyebrow">Your last game · {ago(m.startedEpochMs)}</span>
        <div className="rh-title">
          <Portrait championKey={me.championKey} name={me.champion} size={36} />
          <h2>{me.champion}</h2>
          {res && <span className={`res ${res}`}>{res === "win" ? "Victory" : "Defeat"}</span>}
          <LpDelta rank={m.rank} />
        </div>
        <dl className="rh-stats">
          <div>
            <dt>KDA</dt>
            <dd className="num">
              {me.kills} / <span className="d">{me.deaths}</span> / {me.assists}
            </dd>
          </div>
          <div>
            <dt>CS a minute</dt>
            <dd className="num">{(me.cs / mins).toFixed(1)}</dd>
          </div>
          <div>
            <dt>Game</dt>
            <dd className="num">{clock(m.game?.length ?? m.duration)}</dd>
          </div>
          {m.rank?.tier && (
            <div>
              <dt>{queueLabel(m.rank.queue)}</dt>
              <dd className="num">{standing(m.rank)}</dd>
            </div>
          )}
        </dl>
        {focus && (
          <p className="rh-focus">
            <Crosshair size={14} aria-hidden />
            <span>
              Your focus going in: <i>{focus.text}</i>
            </span>
          </p>
        )}
        <div className="rh-acts">
          <button className="btn primary" onClick={() => onOpen(m.id)}>
            <Play size={15} fill="currentColor" aria-hidden />
            Review this game
          </button>
          {me.deaths > 0 && (
            <button className="btn" onClick={() => onOpen(m.id, "deaths")}>
              <Skull size={15} aria-hidden />
              Watch your {me.deaths === 1 ? "death" : `${me.deaths} deaths`}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

const FOCUS_WORD = { yes: "Did it", partly: "Partly", no: "Not really" } as const;

export function Games({ matches, settings, busy, onOpen, onRecord, onSaveSettings, onDelete, onChanged, onSettings }: Props) {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [activeTag, setActiveTag] = useState("");
  const [story, setStory] = useState<Story | "">("");
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const [env, setEnv] = useState<Environment | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const anchor = useRef<string | null>(null);

  useEffect(() => {
    api.environment().then(setEnv).catch(() => setEnv(null));
  }, []);
  const changeLayout = (l: Layout) => {
    setLayout(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* not remembered, that is all */
    }
  };

  const all = useMemo(() => [...(matches ?? [])].sort((a, b) => b.startedEpochMs - a.startedEpochMs), [matches]);
  const pending = useMemo(() => new Set(toReview(all).map((m) => m.id)), [all]);
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of all) for (const t of m.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [all]);
  const storyCounts = useMemo(() => {
    const counts = new Map<Story, number>();
    for (const m of all) if (m.story) counts.set(m.story, (counts.get(m.story) ?? 0) + 1);
    return counts;
  }, [all]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((m) => {
      if (filter === "review" && !pending.has(m.id)) return false;
      if (filter === "win" && m.game?.result !== "Win") return false;
      if (filter === "lose" && m.game?.result !== "Lose") return false;
      if (filter === "kept" && !m.keep) return false;
      if (activeTag && !(m.tags ?? []).includes(activeTag)) return false;
      if (story && m.story !== story) return false;
      if (q) {
        const players = (m.game?.players ?? []).map((p) => `${p.name} ${p.champion}`).join(" ");
        const hay = `${champName(m)} ${queueName(m)} ${(m.tags ?? []).join(" ")} ${m.notesText ?? ""} ${players}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [all, filter, activeTag, story, query, pending]);

  const groups = useMemo(() => {
    const out: { key: string; label: string; items: MatchSummary[] }[] = [];
    for (const m of shown) {
      const key = new Date(m.startedEpochMs).toDateString();
      let g = out[out.length - 1];
      if (!g || g.key !== key) {
        g = { key, label: dayLabel(m.startedEpochMs), items: [] };
        out.push(g);
      }
      g.items.push(m);
    }
    return out;
  }, [shown]);

  // The focus the player is working on now: the newest one chosen in a review.
  const focus = useMemo(() => {
    let best: { f: NextFocus; from: MatchSummary } | null = null;
    for (const m of all) if (m.nextFocus?.text && (!best || m.nextFocus.setAt > best.f.setAt)) best = { f: m.nextFocus, from: m };
    if (!best) return null;
    const checks = all.filter((m) => m.focusCheck?.text === best!.f.text && m.startedEpochMs > best!.f.setAt).map((m) => m.focusCheck!.answer);
    return { ...best, checks };
  }, [all]);
  const recap = useMemo(() => all.find((m) => pending.has(m.id) && m.startedEpochMs >= Date.now() - 24 * 3600e3) ?? null, [all, pending]);
  const recapFocus = useMemo(() => {
    if (!recap) return null;
    let best: NextFocus | null = null;
    for (const m of all) if (m.nextFocus?.text && m.nextFocus.setAt < recap.startedEpochMs && (!best || m.nextFocus.setAt > best.setAt)) best = m.nextFocus;
    return best;
  }, [all, recap]);

  const visibleSel = useMemo(() => selected.filter((id) => shown.some((m) => m.id === id)), [selected, shown]);
  const selecting = visibleSel.length > 0;
  const toggle = (id: string, range: boolean) => {
    if (range && anchor.current) {
      const a = shown.findIndex((m) => m.id === anchor.current);
      const b = shown.findIndex((m) => m.id === id);
      if (a >= 0 && b >= 0) {
        const ids = shown.slice(Math.min(a, b), Math.max(a, b) + 1).map((m) => m.id);
        setSelected((s) => [...new Set([...s, ...ids])]);
        return;
      }
    }
    anchor.current = id;
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !ownsKeys(e.target)) setSelected([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting]);

  const patchReviews = async (ids: string[], patch: (r: Review) => Review, done: string) => {
    setWorking(true);
    try {
      for (const id of ids) {
        const m = await api.getMatch(id);
        await api.saveReview(id, patch(m.review ?? { keep: false, notes: [], drawings: [] }));
      }
      toast.show({ kind: "success", text: done });
      setSelected([]);
    } catch (e) {
      toast.show({ kind: "error", text: `Not every game was changed. ${humanError(e)}` });
    } finally {
      setWorking(false);
      onChanged();
    }
  };
  const games = (n: number) => `${n} ${n === 1 ? "game" : "games"}`;

  if (!settings) return <div className="page" />;
  if (!settings.recordingsDir) {
    return (
      <div className="page">
        <div className="page-inner">
          <FirstRun settings={settings} onSave={onSaveSettings} />
        </div>
      </div>
    );
  }

  const wins = all.filter((m) => m.game?.result === "Win").length;
  const losses = all.filter((m) => m.game?.result === "Lose").length;
  const selMatches = all.filter((m) => visibleSel.includes(m.id));
  const allKept = selMatches.length > 0 && selMatches.every((m) => m.keep);
  const unreviewed = selMatches.filter((m) => m.mode === "game" && !m.reviewed);

  const open = (m: MatchSummary, e: React.MouseEvent) => {
    if (selecting || e.shiftKey || e.ctrlKey || e.metaKey) toggle(m.id, e.shiftKey);
    else onOpen(m.id);
  };
  const pick = (m: MatchSummary) => (
    <button
      className="pick"
      role="checkbox"
      aria-checked={visibleSel.includes(m.id)}
      aria-label={`Select ${champName(m)}, ${dayLabel(m.startedEpochMs)} ${timeOfDay(m.startedEpochMs)}`}
      onClick={(e) => toggle(m.id, e.shiftKey)}
    >
      <Check size={13} strokeWidth={3} />
    </button>
  );

  return (
    <div className="page">
      <div className={`page-inner library ${selecting ? "selecting" : ""}`}>
        <div className="lib-head">
          <div className="lh-title">
            <h1>Games</h1>
            {all.length > 0 && (
              <p>
                {all.length} {all.length === 1 ? "recording" : "recordings"}
                {wins + losses > 0 && `, ${wins} won and ${losses} lost`}
              </p>
            )}
          </div>
          <span className="grow" />
          {all.length > 0 && <Storage matches={all} settings={settings} env={env} onSettings={onSettings} />}
          <button className="btn" onClick={onRecord} disabled={busy} title="Record your main screen now, without a game">
            <CircleDot size={15} aria-hidden />
            Record now
          </button>
        </div>

        {matches !== null && recap && <Recap m={recap} focus={recapFocus} onOpen={onOpen} />}
        {matches !== null && !recap && focus && (
          <div className="focuspin" title={`Chosen after your ${champName(focus.from)} game. Finish a review to choose a new one.`}>
            <Crosshair size={15} aria-hidden />
            <span className="fp-l">Your focus</span>
            <span className="fp-t">{focus.f.text}</span>
            {focus.checks.length > 0 && (
              <span className="fp-dots" aria-label={`How it went: ${focus.checks.map((c) => FOCUS_WORD[c]).join(", ")}`}>
                {focus.checks.slice(0, 8).map((c, i) => (
                  <i key={i} className={c} title={FOCUS_WORD[c]} />
                ))}
              </span>
            )}
          </div>
        )}

        {all.length > 0 && (
          <div className="lib-bar">
            <div className="seg" role="group" aria-label="Show">
              {(
                [
                  ["all", "All", 0],
                  ["review", "To review", pending.size],
                  ["win", "Wins", 0],
                  ["lose", "Losses", 0],
                  ["kept", "Kept", 0],
                ] as [Filter, string, number][]
              ).map(([key, label, n]) => (
                <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>
                  {label}
                  {n > 0 && <span className="count">{n}</span>}
                </button>
              ))}
            </div>
            {allTags.length > 0 && (
              <Select
                small
                label="Filter by tag"
                prefix="Tag"
                value={activeTag}
                onChange={setActiveTag}
                options={[{ value: "", label: "Any" }, ...allTags.map(([t, n]) => ({ value: t, label: `#${t}`, hint: games(n) }))]}
              />
            )}
            {(storyCounts.size > 0 || story) && (
              <Select<Story | "">
                small
                label="Filter by how the game went, from Riot's gold numbers"
                prefix="Game"
                value={story}
                onChange={setStory}
                options={[
                  { value: "", label: "Any" },
                  ...STORIES.filter((s) => storyCounts.has(s) || s === story).map((s) => ({ value: s, label: STORY_FILTER[s], hint: games(storyCounts.get(s) ?? 0) })),
                ]}
              />
            )}
            <span className="grow" />
            <label className="search">
              <Search size={14} aria-hidden />
              <input className="field-input" type="search" placeholder="Champion, player, tag or note" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search games" />
            </label>
            <div className="seg icons" role="group" aria-label="Layout">
              <button aria-pressed={layout === "grid"} aria-label="Grid" title="Grid" onClick={() => changeLayout("grid")}>
                <LayoutGrid size={15} />
              </button>
              <button aria-pressed={layout === "list"} aria-label="List" title="List" onClick={() => changeLayout("list")}>
                <List size={15} />
              </button>
            </div>
          </div>
        )}

        {matches === null ? (
          <div className="cards" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="cardskel">
                <Skeleton className="shotskel" r={8} />
                <div className="info">
                  <Skeleton w={36} h={36} r={18} />
                  <div style={{ display: "grid", gap: 6 }}>
                    <Skeleton w="60%" h={13} />
                    <Skeleton w="40%" h={11} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : all.length === 0 ? (
          <div className="empty-lib">
            <Video size={34} strokeWidth={1.4} aria-hidden />
            <h2>No games recorded yet</h2>
            <p>{settings.autoRecord ? "Start a League game and it is recorded by itself. Keep Rewatch running; closing the window leaves it in the tray." : "Automatic recording is off. Turn it on in Settings, or record a test below."}</p>
            <Checklist settings={settings} env={env} busy={busy} onRecord={onRecord} onSettings={onSettings} />
          </div>
        ) : shown.length === 0 ? (
          <div className="nomatch">
            <p>No games match{query ? ` "${query.trim()}"` : ""}.</p>
            <button
              className="btn sm"
              onClick={() => {
                setFilter("all");
                setQuery("");
                setActiveTag("");
                setStory("");
              }}
            >
              Show all games
            </button>
          </div>
        ) : (
          groups.map((g) => {
            const w = g.items.filter((m) => m.game?.result === "Win").length;
            const l = g.items.filter((m) => m.game?.result === "Lose").length;
            return (
              <section key={g.key} className="day">
                <h2 className="dayhead">
                  {g.label}
                  <small>
                    {games(g.items.length)}
                    {w + l > 0 && (
                      <>
                        {` · ${w} won, ${l} lost`}
                      </>
                    )}
                  </small>
                </h2>
                {layout === "grid" ? (
                  <div className="cards">
                    {g.items.map((m) => {
                      const me = m.game?.me;
                      const res = resultOf(m);
                      const mins = Math.max(1, (m.game?.length ?? m.duration) / 60);
                      const tags = m.tags ?? [];
                      const sel = visibleSel.includes(m.id);
                      return (
                        <div key={m.id} className={`cardwrap ${sel ? "sel" : ""}`}>
                          <button className="card" data-res={res || undefined} onClick={(e) => open(m, e)} aria-label={`${champName(m)}, ${res === "win" ? "victory" : res === "lose" ? "defeat" : queueName(m)}, ${timeOfDay(m.startedEpochMs)}`}>
                            <Thumb m={m} />
                            <span className="info">
                              {me ? (
                                <Portrait championKey={me.championKey} name={me.champion} size={40} square level={me.level} />
                              ) : (
                                <span className="glyph" style={{ width: 40, height: 40 }}>
                                  <Video size={16} aria-hidden />
                                </span>
                              )}
                              <span className="name">
                                {champName(m)}
                                {pending.has(m.id) && <i className="todo" title="Not reviewed yet" />}
                              </span>
                              {me ? <Kda k={me.kills} d={me.deaths} a={me.assists} /> : <span />}
                              <span className="meta">
                                {res && <span className={`res ${res}`}>{res === "win" ? "Victory" : "Defeat"}</span>}
                                <LpDelta rank={m.rank} />
                                <span className="q">
                                  {queueName(m)} · {timeOfDay(m.startedEpochMs)}
                                </span>
                              </span>
                              {me && <KdaRatio k={me.kills} d={me.deaths} a={me.assists} />}
                              {(tags.length > 0 || m.story) && (
                                <span className="card-tags">
                                  <StoryChip m={m} />
                                  {tags.slice(0, 3).map((t) => (
                                    <i key={t}>#{t}</i>
                                  ))}
                                  {tags.length > 3 && <i>+{tags.length - 3}</i>}
                                </span>
                              )}
                              <span className="foot">
                                {me ? (
                                  <span className="cs">
                                    <b className="num">{me.cs}</b> CS <span className="num">({(me.cs / mins).toFixed(1)})</span>
                                  </span>
                                ) : (
                                  <span>
                                    {m.height}p, {bytes(m.sizeBytes)}
                                  </span>
                                )}
                                {me && me.items.length > 0 && <ItemSlots items={me.items} size={20} />}
                              </span>
                            </span>
                          </button>
                          {pick(m)}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="lrows" role="list">
                    {g.items.map((m) => {
                      const me = m.game?.me;
                      const res = resultOf(m);
                      const mins = Math.max(1, (m.game?.length ?? m.duration) / 60);
                      const sel = visibleSel.includes(m.id);
                      return (
                        <div key={m.id} role="listitem" className={`lrow ${sel ? "sel" : ""}`}>
                          {pick(m)}
                          <button className={`lhit ${res}`} onClick={(e) => open(m, e)}>
                            <span className="lh-res">
                              <b>{res === "win" ? "Victory" : res === "lose" ? "Defeat" : m.mode === "game" ? "Game" : "Recording"}</b>
                              <small>{queueName(m)}</small>
                              <small className="num">
                                {clock(gameLength(m))} · {timeOfDay(m.startedEpochMs)}
                              </small>
                            </span>
                            {me ? (
                              <Portrait championKey={me.championKey} name={me.champion} size={44} square level={me.level} />
                            ) : (
                              <span className="glyph" style={{ width: 44, height: 44 }}>
                                <Video size={16} aria-hidden />
                              </span>
                            )}
                            <span className="lc">
                              <b>
                                {champName(m)}
                                {pending.has(m.id) && <i className="todo" title="Not reviewed yet" />}
                              </b>
                              <small>
                                <LpDelta rank={m.rank} />
                                <StoryChip m={m} />
                              </small>
                            </span>
                            <span className="lh-kda">
                              {me && (
                                <>
                                  <Kda k={me.kills} d={me.deaths} a={me.assists} />
                                  <KdaRatio k={me.kills} d={me.deaths} a={me.assists} />
                                </>
                              )}
                            </span>
                            <span className="lh-cs">
                              {me && (
                                <>
                                  <b className="num">{me.cs} CS</b>
                                  <small className="num">{(me.cs / mins).toFixed(1)} a minute</small>
                                </>
                              )}
                            </span>
                            <span className="lh-items">{me && me.items.length > 0 && <ItemSlots items={me.items} size={22} />}</span>
                            <Teams m={m} />
                            <span className="lflags">
                              {m.keep && <Star size={13} fill="currentColor" className="kept" aria-label="Kept" />}
                              {m.noteCount > 0 && (
                                <span title={`${m.noteCount} notes`}>
                                  <MessageSquare size={12} aria-hidden />
                                  {m.noteCount}
                                </span>
                              )}
                            </span>
                            <span className="num muted">{bytes(m.sizeBytes)}</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })
        )}

        {selecting && (
          <div className="selbar" role="toolbar" aria-label="Selected games">
            <b className="num">{visibleSel.length} selected</b>
            {visibleSel.length < shown.length && (
              <button className="btn sm quiet" onClick={() => setSelected(shown.map((m) => m.id))}>
                Select all {shown.length}
              </button>
            )}
            <span className="grow" />
            <button className="btn sm" disabled={working} onClick={() => patchReviews(visibleSel, (r) => ({ ...r, keep: !allKept }), allKept ? `Stopped keeping ${games(visibleSel.length)}` : `Keeping ${games(visibleSel.length)}`)}>
              <Star size={14} fill={allKept ? "none" : "currentColor"} aria-hidden />
              {allKept ? "Stop keeping" : "Keep"}
            </button>
            <button
              className="btn sm"
              disabled={working || unreviewed.length === 0}
              onClick={() =>
                patchReviews(
                  unreviewed.map((m) => m.id),
                  (r) => ({ ...r, reviewedAt: r.reviewedAt ?? Date.now() }),
                  `Marked ${games(unreviewed.length)} as reviewed`,
                )
              }
            >
              <Check size={14} aria-hidden />
              Mark reviewed
            </button>
            <button
              className="btn sm danger"
              disabled={working}
              onClick={() => {
                const ids = visibleSel;
                setSelected([]);
                onDelete(ids, ids.length === 1 ? undefined : games(ids.length));
              }}
            >
              <Trash2 size={14} aria-hidden />
              Delete
            </button>
            <button className="btn sm sq quiet" aria-label="Clear the selection" title="Clear (Esc)" onClick={() => setSelected([])}>
              <X size={15} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
