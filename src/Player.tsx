import {
  ArrowLeft, Bookmark, Circle, Download, Eraser, FolderOpen, Grid2x2, HardDriveDownload, ImageDown, LayoutGrid, LayoutPanelLeft, Maximize2, MoreHorizontal, MoveUpRight,
  PanelRightClose, PanelRightOpen, Pause, Pencil, Play, Presentation, Scissors, SkipBack, SkipForward, Skull, Star, Swords, Table2, Trash2, Undo2, Users, VideoOff, Volume2, Wand2, X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Playlist } from "./App";
import { api, fileUrl, onEvent, showInFolder } from "./api";
import { ItemIcon, Portrait, type Side } from "./ChampIcon";
import { ClipBar, FILTERS, ShortcutsButton, ShowControl, SoundControl, type Overlay } from "./Deck";
import { bytes, categorize, clock, describe, gameClockAt, laneName, uid, videoTimeAt, when } from "./format";
import { eventGlyph } from "./icons";
import { deathItems, DISCORD_COLOR, fightsOf, type Fight, Lanes, QueueBar, ReviewTab, VOICE_COLORS, type Metric, type Queue, type QueueItem, type Usual, type VoiceRow } from "./Insights";
import { NotesPanel } from "./Notes";
import { PostGamePanel } from "./PostGame";
import { RankLine } from "./Rank";
import { MatchBoard, TeamBoard } from "./Scoreboard";
import { canShare, shareCardPng } from "./ShareCard";
import { ItemSlots, Kda, KdaRatio, ScoreBadge, scoresOf } from "./Stats";
import { Timeline, type Marker } from "./Timeline";
import type { AudioPrefs, Coach, Drawing, Extras, FocusCheck, Friend, Highlight, Insights, MatchFull, MatchSummary, NextFocus, Pov, Review, Shape, TeamReview, Tool, TrackName, Voice, WatchEvent, WatchPeer } from "./types";
import { humanError, Menu, ownsKeys, Select, Skeleton, useToast } from "./ui";
import { drawKeys, drawMouse, KeyOverlay, parseKeys, parseMouse, ShapeView, SideView, Splitter, TileBar, usePovMouse, ZoomPane, type KeyLog, type MouseLog } from "./Views";

const INKS = ["#ffd23f", "#f2584b", "#4c9dff", "#ffffff"];
const TOOLS: { tool: Tool; label: string; icon: LucideIcon; hint: string }[] = [
  { tool: "pen", label: "Pen", icon: Pencil, hint: "Pen (D)" },
  { tool: "arrow", label: "Arrow", icon: MoveUpRight, hint: "Arrow" },
  { tool: "circle", label: "Circle", icon: Circle, hint: "Circle" },
  { tool: "laser", label: "Laser pointer", icon: Wand2, hint: "Laser pointer: point at things while screen sharing. Not saved." },
];
/** Why a teammate's view cannot be opened: short label, and the longer hint. */
const POV_STATUS: Record<string, [string, string]> = {
  offline: ["offline", "Their PC is off or Rewatch is not running there"],
  denied: ["not paired", "They have not added your friend code yet. Send it to them from Settings."],
  off: ["sharing off", "They have switched off sharing with teammates"],
  none: ["no recording", "They do not have a recording of this game"],
  badcode: ["bad code", "The friend code saved for them is not valid. Fix it in Settings."],
};
const CPM_BUCKET = 5;
const RATES = [0.25, 0.5, 1, 1.5, 2];
/** Seconds a drawing stays on screen either side of the moment it was made. */
const DRAW_WINDOW = 2;
/** How long a laser trail stays visible, in milliseconds. */
const LASER_MS = 700;

function loadPrefs<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function savePrefs(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: preferences just do not persist */
  }
}

interface Prefs {
  volume: Record<TrackName, number>;
  muted: Record<TrackName, boolean>;
  filters: Record<string, boolean>;
  trail: boolean;
  clicks: boolean;
  /** Keycaps over the video showing which keys were held. */
  keys: boolean;
  theater: boolean;
  /** Split view: one big view with the rest in a strip, or equal sizes. */
  layout: "focus" | "grid";
  /** Width of the big view in the focus layout, in percent. */
  mainPct: number;
  /** Width of the side panel in pixels. */
  sideWidth: number;
  /** Rows under the timeline showing who was talking. */
  comms: boolean;
  /** The numbers graph under the timeline, what it shows and who it compares with. */
  graph: boolean;
  metric: Metric;
  versus: string;
}
const DEFAULT_PREFS: Prefs = {
  volume: { game: 1, discord: 1, mic: 1 },
  muted: { game: false, discord: false, mic: false },
  filters: Object.fromEntries(FILTERS.map((f) => [f, f !== "fight"])),
  trail: true,
  clicks: true,
  keys: true,
  theater: false,
  layout: "focus",
  mainPct: 70,
  sideWidth: 348,
  comms: false,
  graph: false,
  metric: "cs",
  versus: "",
};

/** The small picture in front of a moment: who fought whom, what was bought, what fell. */
function MomentPicture({ m, champKey }: { m: Marker; champKey: (n?: string) => string | undefined }) {
  const e = m.e;
  if (m.cat === "bookmark")
    return (
      <span className="glyph mark" style={{ width: 26, height: 26 }}>
        <Bookmark size={14} fill="currentColor" />
      </span>
    );
  if (!e) return null;
  if (e.kind === "ChampionKill") {
    const killerSide: Side = m.side === "neutral" ? "neutral" : m.side;
    const victimSide: Side = m.side === "ally" ? "enemy" : m.side === "enemy" ? "ally" : "neutral";
    return (
      <>
        {e.killerChamp ? (
          <Portrait championKey={champKey(e.killerChamp)} name={e.killerChamp} size={26} side={killerSide} />
        ) : (
          <span className={`glyph ${killerSide}`} style={{ width: 26, height: 26 }}>
            <Skull size={14} />
          </span>
        )}
        <Swords size={12} aria-hidden />
        <Portrait championKey={champKey(e.victimChamp)} name={e.victimChamp ?? "?"} size={26} side={victimSide} />
      </>
    );
  }
  if (e.kind === "ItemPurchased") return <ItemIcon id={e.itemId ?? 0} name={e.detail ?? "Item"} size={28} />;
  const Icon = eventGlyph(e);
  return (
    <span className={`glyph ${m.side}`} style={{ width: 26, height: 26 }}>
      <Icon size={15} strokeWidth={2.2} />
    </span>
  );
}

/** A red pointer trail that fades, for showing things while screen sharing. Never saved. */
function LaserTrail({ feed, w, h }: { feed: React.RefObject<((x: number, y: number) => void) | null>; w: number; h: number }) {
  const [, redraw] = useState(0);
  const pts = useRef<[number, number, number][]>([]);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      pts.current = pts.current.filter((p) => now - p[2] < LASER_MS);
      redraw((n) => n + 1);
      raf = pts.current.length ? requestAnimationFrame(tick) : 0;
    };
    feed.current = (x, y) => {
      pts.current.push([x, y, performance.now()]);
      if (!raf) raf = requestAnimationFrame(tick);
    };
    return () => {
      cancelAnimationFrame(raf);
      feed.current = null;
    };
  }, [feed]);
  const now = performance.now();
  const list = pts.current;
  return (
    <g className="laser" aria-hidden>
      {list.map(([x, y, at], i) => {
        if (i === 0) return null;
        const [px, py] = list[i - 1];
        const a = Math.max(0, 1 - (now - at) / LASER_MS);
        return <line key={i} x1={px * w} y1={py * h} x2={x * w} y2={y * h} stroke="#ff3b3b" strokeWidth={2 + 6 * a} strokeLinecap="round" opacity={a * 0.9} />;
      })}
      {list.length > 0 && <circle cx={list[list.length - 1][0] * w} cy={list[list.length - 1][1] * h} r={7} fill="#ff3b3b" opacity={Math.max(0, 1 - (now - list[list.length - 1][2]) / LASER_MS)} />}
    </g>
  );
}

/** Most views that can be shown next to your own in split view. */
const MAX_SPLIT = 4;

interface PlayerProps {
  id: string;
  onBack: () => void;
  /** The teammates list, for watching together. */
  friends: Friend[];
  /** Library matches, for game comparison and the focus loop. */
  matches?: MatchSummary[];
  /** Opened from a teammate's invitation: start in watch-together. */
  joinTogether?: boolean;
  /** Told whenever watch-together is switched on or off here. */
  onTogether?: (on: boolean) => void;
  /** Hints about deaths are set up in Settings (a key and the switch). */
  hintsOn?: boolean;
  /** Teammates with a game open right now. */
  peers?: WatchPeer[];
  /** A walk-through across games, when this game is one stop of it. */
  playlist?: Playlist | null;
  onPlaylist?: (p: Playlist | null) => void;
  onJoin?: () => void;
  /** Delete this recording (the app offers an undo). */
  onDelete?: (id: string, what: string) => void;
  /** Delete this game's video and keep its stats (the app offers an undo). */
  onDeleteVideo?: (id: string, what: string) => void;
  /** The video is being deleted, with the undo still on offer: show the game without it. */
  videoGone?: boolean;
  /** The review was marked done or reopened. */
  onReviewed?: () => void;
  /** Open straight into a walk-through of this game's deaths. */
  start?: "deaths";
}

/** Where a walk-through goes instead of this game's stops: on to the next game, or to the one before when it was going backwards. */
function otherGame(p: Playlist): { index: number; back: boolean } | null {
  const id = p.items[p.index].matchId;
  let base = p.index;
  while (base > 0 && p.items[base - 1].matchId === id) base--;
  let end = p.index + 1;
  while (end < p.items.length && p.items[end].matchId === id) end++;
  if (p.back && base > 0) return { index: base - 1, back: true };
  return end < p.items.length ? { index: end, back: false } : null;
}

export function Player({ id, onBack, friends, matches, joinTogether, onTogether, hintsOn, peers = [], playlist, onPlaylist, onDelete, onDeleteVideo, videoGone, onReviewed, start }: PlayerProps) {
  const toast = useToast();
  const [match, setMatch] = useState<MatchFull | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [review, setReview] = useState<Review>({ keep: false, notes: [], drawings: [] });
  const reviewRef = useRef(review);
  reviewRef.current = review;
  const [time, setTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [tab, setTab] = useState<"review" | "moments" | "notes" | "players">("review");
  /** What teammates wrote and drew on this game, and when each of them spoke. */
  const [extras, setExtras] = useState<Extras[]>([]);
  const [voice, setVoice] = useState<Voice | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [coach, setCoach] = useState<Coach | null>(null);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [savingClips, setSavingClips] = useState(false);
  /** Team reviews made on this PC; teammates' come with their notes. */
  const [myTeam, setMyTeam] = useState<TeamReview[]>([]);
  const [teamBusy, setTeamBusy] = useState<number | null>(null);
  const [hintBusy, setHintBusy] = useState(false);
  const [hintError, setHintError] = useState<string | null>(null);
  const [usual, setUsual] = useState<Usual | null>(null);
  /** A walk-through of deaths, fights or bookmarks, one stretch at a time. */
  const [queue, setQueue] = useState<Queue | null>(null);
  const queueRef = useRef<Queue | null>(null);
  queueRef.current = queue;
  /** The current stretch has played to its end; pressing play again leaves the walk-through. */
  const queueDone = useRef(false);
  // Watching together: every teammate in the session sees the same moment.
  const [together, setTogether] = useState(!!joinTogether);
  const togetherRef = useRef(false);
  const [mates, setMates] = useState<string[]>([]);
  const friendsRef = useRef(friends);
  friendsRef.current = friends;
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs("rewatch.player", DEFAULT_PREFS));
  const [tool, setTool] = useState<Tool | null>(null);
  const [ink, setInk] = useState(INKS[0]);
  const [draft, setDraft] = useState<Shape | null>(null);
  /** The clip being cut, start and end in seconds; null when not cutting one. */
  const [clip, setClip] = useState<[number, number] | null>(null);
  const clipRef = useRef<[number, number] | null>(null);
  clipRef.current = clip;
  const [looping, setLooping] = useState(false);
  const [maxMb, setMaxMb] = useState<number | null>(null);
  const [buildingReel, setBuildingReel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  // The whole scoreboard over the video (O).
  const [board, setBoard] = useState(false);
  /** Share mode: a clean, large view for screen sharing in Discord. */
  const [share, setShare] = useState(false);
  const [mouse, setMouse] = useState<MouseLog | null>(null);
  const [keys, setKeys] = useState<KeyLog | null>(null);
  const keysElRef = useRef<HTMLDivElement>(null);
  const laserFeed = useRef<((x: number, y: number) => void) | null>(null);
  /** Earlier versions of the drawings, for Ctrl+Z. */
  const undoStack = useRef<Drawing[][]>([]);
  // Teammates' views of this game. `pov` null means my own recording is showing.
  const [povs, setPovs] = useState<Pov[]>([]);
  const [pov, setPov] = useState<Pov | null>(null);
  /** Copies being saved to this PC right now: bytes done and total, by friend code. */
  const [saving, setSaving] = useState<Record<string, [number, number]>>({});
  /** Seconds to add to a time in my video to get the video element's own time. */
  const shiftRef = useRef(0);
  /** Where to resume once a newly chosen view has loaded. */
  const pendingRef = useRef<{ t: number; play: boolean } | null>(null);
  const povRef = useRef<Pov | null>(null);
  povRef.current = pov;
  // Split view: teammates shown next to my own recording. Empty means a single view.
  const [split, setSplit] = useState<Pov[]>([]);
  const splitRef = useRef<Pov[]>([]);
  splitRef.current = split;
  /** Whose game sound plays in split view: a teammate's name, or null for mine. */
  const [listen, setListen] = useState<string | null>(null);
  /** Which view is the big one in the focus layout: a teammate's name, or null for mine. */
  const [big, setBig] = useState<string | null>(null);
  // The cursor log of the teammate whose single view is showing.
  const povMouse = usePovMouse(pov);
  const povMouseRef = useRef<MouseLog | null>(null);
  povMouseRef.current = povMouse;

  const videoRef = useRef<HTMLVideoElement>(null);
  const discordRef = useRef<HTMLAudioElement>(null);
  const micRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const reviewLoaded = useRef(false);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const listedRef = useRef<Marker[]>([]);
  const loopingRef = useRef(false);
  loopingRef.current = looping;
  const voiceRef = useRef<Voice | null>(null);
  voiceRef.current = voice;
  const extrasRef = useRef<Extras[]>([]);
  extrasRef.current = extras;
  const listenRef = useRef<string | null>(null);
  listenRef.current = listen;
  const playlistRef = useRef(playlist);
  playlistRef.current = playlist;
  const goneRef = useRef(videoGone);
  goneRef.current = videoGone;
  /** This game can't be a stop of the walk-through: go on to the next game in it (or back, the way it came), or end it. */
  const leaveStop = (p: Playlist, why: string) => {
    const next = otherGame(p);
    const label = p.items[p.index].label;
    // One message for a run of skipped games, each replacing the one before.
    const n = (p.skipped ?? 0) + 1;
    if (!next) {
      toast.show({ id: "walk-skip", kind: "info", text: `The walk-through ends here. Its last game ${why} (${label}).` });
      onPlaylist?.(null);
      return;
    }
    toast.show({ id: "walk-skip", kind: "info", text: n === 1 ? `Skipped a game that ${why} (${label}).` : `Skipped ${n} games that couldn't be shown. The last ${why} (${label}).` });
    onPlaylist?.({ ...p, ...next, skipped: n });
  };

  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs("rewatch.player", next);
      return next;
    });
  }, []);

  /** Effective audio settings for this match: per-match override in review.json, or user defaults. */
  const audio: AudioPrefs = useMemo(() => review.audio ?? { volume: prefs.volume, muted: prefs.muted, duck: false }, [review.audio, prefs.volume, prefs.muted]);
  const audioRef = useRef(audio);
  audioRef.current = audio;

  const setTrackAudio = useCallback(
    (patch: Partial<AudioPrefs>) => {
      const cur = audioRef.current;
      const next: AudioPrefs = {
        volume: patch.volume ?? cur.volume,
        muted: patch.muted ?? cur.muted,
        duck: patch.duck ?? cur.duck,
      };
      setReview((r) => ({ ...r, audio: next }));
      if (patch.volume || patch.muted) {
        updatePrefs({ volume: next.volume, muted: next.muted });
      }
    },
    [updatePrefs],
  );

  // ---- load
  useEffect(() => {
    // Only the current load acts (a walk-through moves on, a toast shows), not one already undone.
    let live = true;
    api
      .getMatch(id)
      .then((m) => {
        if (!live) return;
        setMatch(m);
        setReview(m.review ?? { keep: false, notes: [], drawings: [] });
        // Its video was deleted: the stats are all there is.
        const novid = m.hasVideo === false || !!goneRef.current;
        if (m.mouse && !m.trimmedToHighlights) {
          fetch(fileUrl(m.dir, m.mouse.file))
            .then((r) => r.text())
            .then((text) => setMouse(parseMouse(text, m.mouse!.offset)))
            .catch(() => setMouse(null));
        }
        if (m.keys && !m.trimmedToHighlights) {
          fetch(fileUrl(m.dir, m.keys.file))
            .then((r) => r.text())
            .then((text) => setKeys(parseKeys(text, m.keys!.offset, m.keys!.names)))
            .catch(() => setKeys(null));
        }
        // A game trimmed to its highlight reel no longer lines up with teammates' views.
        if (!m.trimmedToHighlights && !novid) api.povList(id).then(setPovs).catch(() => setPovs([]));
        // A screen recording has nothing to review: start on its moments.
        if (m.mode === "manual") setTab("moments");
        // Opened as one stop of a walk-through across games: go straight to it.
        const p = playlistRef.current;
        if (p && p.items[p.index]?.matchId === m.id && novid) {
          leaveStop(p, "has no video any more");
        } else if (p && p.items[p.index]?.matchId === m.id && m.trimmedToHighlights) {
          // The stops' times are in the full recording, which is gone.
          leaveStop(p, "was trimmed to its highlights");
        } else if (p && p.items[p.index]?.matchId === m.id) {
          // Only the run of stops in this game that holds the current one belongs to this visit.
          let base = p.index;
          while (base > 0 && p.items[base - 1].matchId === m.id) base--;
          let end = p.index + 1;
          while (end < p.items.length && p.items[end].matchId === m.id) end++;
          const items: QueueItem[] = p.items.slice(base, end).map((it) => ({ t: it.t, start: it.start, end: it.end, label: it.label }));
          const idx = p.index - base;
          pendingRef.current = { t: items[idx].start, play: true };
          setQueue({ title: p.title, items, idx, across: { base, total: p.items.length, go: (index) => onPlaylist?.({ ...p, index, back: index < p.index, skipped: 0 }) } });
        } else if (start === "deaths" && !m.trimmedToHighlights && !novid) {
          // Opened from "Watch your deaths": play the run-up to each one.
          const items = deathItems(m.events);
          if (items.length) {
            pendingRef.current = { t: items[0].start, play: true };
            setQueue({ title: "Deaths", items, idx: 0 });
            setTab("review");
          }
        }
      })
      .catch((e) => {
        if (!live) return;
        setLoadError(humanError(e));
        // A game deleted since the walk-through was made: carry on without it.
        const p = playlistRef.current;
        if (p && p.items[p.index]?.matchId === id) leaveStop(p, "could not be opened");
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ---- the player's usual numbers, for context next to this game's
  useEffect(() => {
    api
      .libraryTrends()
      .then((rows) => {
        const me = rows.find((r) => r.id === id);
        const others = rows.filter((r) => r.id !== id && r.length > 300);
        const sameRole = me?.position ? others.filter((r) => r.position === me.position) : [];
        const pool = (sameRole.length >= 3 ? sameRole : others).slice(0, 20);
        const avg = (vals: number[]) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
        setUsual({
          games: pool.length,
          deadPct: avg(pool.flatMap((r) => (typeof r.deadPct === "number" ? [r.deadPct] : []))),
          csm: avg(pool.map((r) => r.cs / (r.length / 60))),
          visionPm: avg(pool.flatMap((r) => (typeof r.wards === "number" ? [r.wards / (r.length / 60)] : []))),
        });
      })
      .catch(() => setUsual(null));
  }, [id]);

  const trimmed = !!match?.trimmedToHighlights;

  // ---- teammates' notes, drawings and speech times; asked again now and then so a
  // note someone writes during a shared review shows up for everyone
  useEffect(() => {
    if (trimmed) {
      setExtras([]);
      return;
    }
    const load = () => api.povExtras(id).then(setExtras).catch(() => {});
    load();
    const iv = setInterval(load, together ? 5000 : 20000);
    return () => clearInterval(iv);
  }, [id, trimmed, together]);

  // ---- hints about deaths arrive in the background a while after a game
  useEffect(
    () =>
      onEvent<string | null>("insights", (which) => {
        if (which !== id) return;
        api.insights(id, false).then((v) => v && setInsights(v)).catch(() => {});
        api.coach(id, false).then((v) => v && setCoach(v)).catch(() => {});
      }),
    [id],
  );
  const askHints = useCallback(async () => {
    setHintBusy(true);
    setHintError(null);
    try {
      // The hints first: the written review uses them to pick which deaths to look at.
      const hints = await api.insights(id, true);
      if (hints) setInsights(hints);
      const written = await api.coach(id, true);
      if (written) setCoach(written);
    } catch (e) {
      setHintError(humanError(e));
    } finally {
      setHintBusy(false);
    }
  }, [id]);
  // Riot's record of the game and the LP it moved arrive in the background after it.
  useEffect(
    () =>
      onEvent<string>("postgame", (which) => {
        if (which !== id) return;
        api
          .getMatch(id)
          .then((m) => setMatch((cur) => (cur && cur.id === m.id ? { ...cur, postgame: m.postgame, rank: m.rank, postgameNote: m.postgameNote } : cur)))
          .catch(() => {});
      }),
    [id],
  );
  // Highlight clips are made in the background a little after a game.
  useEffect(
    () =>
      onEvent<string | null>("highlights", (which) => {
        if (which === id) api.highlights(id, false).then(setHighlights).catch(() => {});
      }),
    [id],
  );
  const saveClips = useCallback(() => {
    setSavingClips(true);
    toast
      .job(
        "Saving the highlight clips",
        () => api.highlights(id, true),
        (list) => ({ kind: "success", text: `Saved ${list.length} highlight ${list.length === 1 ? "clip" : "clips"}`, path: list.find((h) => h.file)?.file ?? null }),
      )
      .then((list) => list && setHighlights(list))
      .finally(() => setSavingClips(false));
  }, [id, toast]);
  const buildReel = useCallback(() => {
    setBuildingReel(true);
    toast
      .job(
        "Making the highlight reel",
        () => api.buildHighlightReel(id),
        (path) => ({ kind: "success", text: "Made the highlight reel", path }),
      )
      .then((path) => path && setMatch((m) => (m ? { ...m, reel: path } : m)))
      .finally(() => setBuildingReel(false));
  }, [id, toast]);
  /** Teammates' views that could go into a team review: ready and with a usable source. */
  const reviewViews = useMemo(() => povs.filter((p) => p.status === "ready" && p.source && p.champion).slice(0, 4), [povs]);
  const askTeam = useCallback(
    (fight: Fight) => {
      setTeamBusy(fight.start);
      setHintError(null);
      api
        .teamReview(
          id,
          fight.start,
          fight.end,
          reviewViews.map((p) => ({ source: p.source!, shift: p.shift, champion: p.champion })),
        )
        .then((r) => setMyTeam((cur) => [...cur.filter((x) => Math.abs(x.t - r.t) > 3), r]))
        .catch((e) => setHintError(humanError(e)))
        .finally(() => setTeamBusy(null));
    },
    [id, reviewViews],
  );
  // My own team reviews first; a teammate's review of a fight I have not reviewed is shown too.
  const teamReviews = useMemo(() => {
    const all = [...myTeam];
    for (const e of extras) for (const r of e.team ?? []) if (!all.some((x) => Math.abs(x.t - r.t) < 6)) all.push(r);
    return all;
  }, [myTeam, extras]);
  // A title per player: from my own AI review, else a teammate's, else the built-in ones.
  const titles = useMemo(() => {
    const list = coach?.titles?.length ? coach.titles : (extras.find((e) => e.titles?.length)?.titles ?? match?.titles ?? []);
    return new Map(list.map((t) => [t.champion, t] as const));
  }, [coach, extras, match]);

  // ---- when someone was talking; worked out on first use for older recordings
  useEffect(() => {
    if (!match) return;
    if (match.insights) setInsights(match.insights);
    if (match.coach) setCoach(match.coach);
    setHighlights(match.highlights ?? []);
    setMyTeam(match.team ?? []);
    if (match.voice) setVoice(match.voice);
    else if (!match.trimmedToHighlights && match.hasVideo !== false && match.tracks.some((t) => t.name !== "game")) api.voice(match.id).then(setVoice).catch(() => {});
  }, [match]);

  // ---- follow the saving of teammates' views, and refresh the list when one lands
  useEffect(() => {
    let last = "";
    const iv = setInterval(() => {
      api
        .povSaving(id)
        .then((m) => {
          const now = Object.keys(m).sort().join(",");
          setSaving(m);
          if (last && last !== now) api.povList(id).then(setPovs).catch(() => {});
          last = now;
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(iv);
  }, [id]);

  // ---- save notes, drawings and the keep flag shortly after each change
  const unsaved = useRef<{ id: string; review: Review } | null>(null);
  useEffect(() => {
    if (!match) return;
    if (!reviewLoaded.current) {
      reviewLoaded.current = true;
      return;
    }
    unsaved.current = { id: match.id, review };
    const h = setTimeout(() => {
      unsaved.current = null;
      api.saveReview(match.id, review).catch((e) => toast.show({ id: "review-save", kind: "error", text: `Your notes were not saved. ${humanError(e)}` }));
    }, 500);
    return () => clearTimeout(h);
  }, [review, match, toast]);
  // Leaving the game (or moving on in a walk-through) within that half second still saves.
  useEffect(
    () => () => {
      const last = unsaved.current;
      if (last) api.saveReview(last.id, last.review).catch((e) => toast.show({ id: "review-save", kind: "error", text: `Your notes were not saved. ${humanError(e)}` }));
      // An undo for a deleted note can't reach this game once it's closed.
      toast.dismiss(`note-undo-${id}`);
    },
    [id, toast],
  );
  const deleteNote = (nid: string) => {
    const gone = reviewRef.current.notes.filter((x) => x.id === nid || x.replyTo === nid);
    if (!gone.length) return;
    const ids = new Set(gone.map((x) => x.id));
    setReview((r) => ({ ...r, notes: r.notes.filter((x) => !ids.has(x.id)) }));
    const replies = gone.length - 1;
    toast.show({
      id: `note-undo-${id}`,
      kind: "info",
      text: replies ? `Deleted the note and ${replies === 1 ? "its reply" : `${replies} replies`}` : "Deleted the note",
      ms: 7000,
      actions: [{ label: "Undo", run: () => setReview((r) => ({ ...r, notes: [...r.notes, ...gone.filter((g) => !r.notes.some((x) => x.id === g.id))] })) }],
    });
  };

  const duration = match?.trimmedToHighlights ? videoDuration || match.reelDuration || match.duration : (match?.duration ?? 0);
  // A trimmed game's reel already has Discord and the mic mixed into its own sound.
  const tracks = (match?.tracks ?? []).filter((t) => !trimmed || t.name === "game");
  const hasTrack = (n: TrackName) => tracks.some((t) => t.name === n);

  // ---- keep the separate sound tracks locked to the video
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !match) return;
    const extras = () => [discordRef.current, micRef.current].filter((a): a is HTMLAudioElement => !!a);
    const sync = (hard: boolean) => {
      const mine = Math.max(0, v.currentTime - shiftRef.current);
      for (const a of extras()) {
        if (hard || Math.abs(a.currentTime - mine) > 0.08) a.currentTime = mine;
        a.playbackRate = v.playbackRate;
        if (v.paused && !a.paused) a.pause();
        if (!v.paused && a.paused) a.play().catch(() => {});
      }
    };
    const onPlay = () => {
      setPlaying(true);
      sync(true);
    };
    const onPause = () => {
      setPlaying(false);
      sync(true);
      setTime(v.currentTime - shiftRef.current);
    };
    const onSeeked = () => {
      sync(true);
      setTime(v.currentTime - shiftRef.current);
    };
    const onWaiting = () => extras().forEach((a) => a.pause());
    const onPlaying = () => sync(true);
    const onRate = () => sync(false);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("playing", onPlaying);
    v.addEventListener("ratechange", onRate);
    const iv = setInterval(() => sync(false), 1000);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("ratechange", onRate);
      clearInterval(iv);
    };
  }, [match, pov]);

  // ---- mixer
  useEffect(() => {
    const apply = (el: HTMLMediaElement | null, name: TrackName) => {
      if (!el) return;
      el.volume = audio.volume[name];
      el.muted = audio.muted[name];
    };
    apply(videoRef.current, "game");
    apply(discordRef.current, "discord");
    apply(micRef.current, "mic");
    // In split view only one view's game sound plays at a time.
    if (videoRef.current && listen !== null) videoRef.current.muted = true;
  }, [audio.volume, audio.muted, match, pov, listen]);

  // ---- one animation loop: time readout, looping, voice ducking, mouse & key overlays
  useEffect(() => {
    let raf = 0;
    let lastShown = -1;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const v = videoRef.current;
      const c = canvasRef.current;
      if (!v) return;
      let now = v.currentTime - shiftRef.current;

      // Loop the clip being cut, or else the walk-through stop.
      if (loopingRef.current && !v.paused) {
        const q = queueRef.current;
        const cl = clipRef.current;
        const span = cl && cl[1] > cl[0] + 0.1 ? cl : q ? ([q.items[q.idx].start, q.items[q.idx].end] as [number, number]) : null;
        if (span && now >= span[1] - 0.04) {
          v.currentTime = Math.max(0, span[0] + shiftRef.current);
          now = span[0];
        }
      }

      // Smooth voice ducking on game audio when someone is speaking
      const aud = audioRef.current;
      if (!aud.muted.game && listenRef.current === null) {
        let speaking = false;
        if (aud.duck && !v.paused) {
          const vc = voiceRef.current;
          const hit = (spans?: [number, number][] | null) => !!spans?.some((s) => s[0] <= now && now <= s[1]);
          speaking = hit(vc?.mic) || hit(vc?.discord) || extrasRef.current.some((ex) => hit(ex.voice));
        }
        const targetVol = aud.volume.game * (speaking ? 0.3 : 1);
        if (Math.abs(v.volume - targetVol) > 0.01) {
          v.volume = v.volume + (targetVol - v.volume) * 0.25;
        }
      }

      if (!v.paused && Math.abs(now - lastShown) > 0.066) {
        lastShown = now;
        setTime(now);
      }
      if (!c || !match) return;
      // On a teammate's view, show their cursor, timed against their own video.
      const theirs = povRef.current;
      if (theirs) drawMouse(c, povMouseRef.current, { w: theirs.mouseW, h: theirs.mouseH }, v.currentTime, prefsRef.current);
      else drawMouse(c, mouse, match.mouse, now, prefsRef.current);
      drawKeys(keysElRef.current, keys, now);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [match, mouse, keys]);

  // ---- transport
  /** Position on my recording's timeline, whichever view is showing. */
  const refNow = useCallback(() => (videoRef.current?.currentTime ?? 0) - shiftRef.current, []);
  /** Watching together: tell teammates where this player is. `control` marks a
   *  deliberate play, pause or seek, which everyone follows. */
  const announceAt = useRef(0);
  const announceTimer = useRef<number | undefined>(undefined);
  const announce = useCallback(
    (control: boolean) => {
      if (!togetherRef.current) return;
      const send = () => {
        const v = videoRef.current;
        if (!v || !togetherRef.current) return;
        announceAt.current = Date.now();
        api.watchSet(id, v.currentTime - shiftRef.current, !v.paused, v.playbackRate, control).catch(() => {});
      };
      // Dragging the timeline seeks many times a second; send at most a few of those.
      const wait = control ? 150 - (Date.now() - announceAt.current) : 0;
      window.clearTimeout(announceTimer.current);
      if (wait > 0) announceTimer.current = window.setTimeout(send, wait);
      else send();
    },
    [id],
  );
  const seek = useCallback(
    (t: number) => {
      const v = videoRef.current;
      if (!v) return;
      const clamped = Math.min(Math.max(t + shiftRef.current, 0), Math.max(0, (v.duration || duration) - 0.05));
      v.currentTime = clamped;
      setTime(clamped - shiftRef.current);
      announce(true);
    },
    [duration, announce],
  );
  /** Start cutting a clip: by default the 30 seconds up to now. */
  const startClip = useCallback(() => {
    const now = refNow();
    const end = Math.max(now, Math.min(duration || 30, 30));
    setClip([Math.max(0, end - 30), end]);
  }, [refNow, duration]);
  const setClipEdge = useCallback(
    (edge: 0 | 1) => {
      const now = refNow();
      setClip((c) => {
        if (!c) return edge === 0 ? [now, Math.min(duration || now + 30, now + 30)] : [Math.max(0, now - 30), now];
        return edge === 0 ? [Math.min(now, c[1] - 1), c[1]] : [c[0], Math.max(now, c[0] + 1)];
      });
    },
    [refNow, duration],
  );
  const toggleLoop = useCallback(() => {
    setLooping((prev) => {
      const next = !prev;
      // Nothing to loop yet: loop ten seconds around the current moment.
      if (next && !clipRef.current && !queueRef.current) {
        const now = refNow();
        setClip([Math.max(0, now - 5), Math.min(duration || now + 5, now + 5)]);
      }
      return next;
    });
  }, [refNow, duration]);
  /** Show another view (or mine, with null) at the same moment of the game. */
  const switchPov = useCallback((next: Pov | null) => {
    const v = videoRef.current;
    if (!v || (next?.friend ?? null) === (povRef.current?.friend ?? null)) return;
    pendingRef.current = { t: v.currentTime - shiftRef.current, play: !v.paused };
    shiftRef.current = next?.shift ?? 0;
    setPov(next);
  }, []);
  const cyclePov = useCallback(() => {
    const ready = povs.filter((p) => p.status === "ready");
    if (ready.length === 0) return;
    const i = povRef.current ? ready.findIndex((p) => p.friend === povRef.current!.friend) : -1;
    switchPov(i + 1 < ready.length ? ready[i + 1] : null);
  }, [povs, switchPov]);
  const toggleSplitMode = useCallback(() => {
    if (splitRef.current.length > 0) {
      setSplit([]);
      setListen(null);
      setBig(null);
      return;
    }
    const ready = povs.filter((p) => p.status === "ready");
    if (ready.length === 0) return;
    // My own recording is always the main tile, so leave a teammate's single view first.
    const current = povRef.current;
    if (current) switchPov(null);
    setSplit(current && ready.some((p) => p.friend === current.friend) ? [current] : ready.slice(0, 3));
  }, [povs, switchPov]);
  const toggleInSplit = useCallback((p: Pov) => {
    setSplit((cur) => (cur.some((x) => x.friend === p.friend) ? cur.filter((x) => x.friend !== p.friend) : cur.length >= MAX_SPLIT ? cur : [...cur, p]));
    setListen((l) => (l === p.friend ? null : l));
    setBig((b) => (b === p.friend ? null : b));
  }, []);
  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
    announce(true);
  }, [announce]);
  const step = useCallback(
    (frames: number) => {
      const v = videoRef.current;
      if (!v || !match) return;
      v.pause();
      seek(refNow() + frames / (match.fps || 60));
    },
    [match, seek, refNow],
  );
  const changeRate = (r: number) => {
    setRate(r);
    if (videoRef.current) videoRef.current.playbackRate = r;
    announce(true);
  };
  /** Play from a moment of game time, as Riot's record of the game gives it. */
  const playGame = useMemo(() => {
    const samples = match?.clock ?? [];
    if (trimmed || !samples.length) return null;
    return (g: number) => {
      const v = videoTimeAt(samples, g);
      if (v == null) return;
      seek(v);
      videoRef.current?.play().catch(() => {});
    };
  }, [match?.clock, trimmed, seek]);
  /** Start a walk-through in this game: jump to the stretch and play it. */
  const startQueue = useCallback(
    (title: string, items: QueueItem[], idx: number) => {
      if (idx < 0 || idx >= items.length) return;
      queueDone.current = false;
      setQueue({ title, items, idx });
      seek(items[idx].start);
      videoRef.current?.play().catch(() => {});
      announce(true);
    },
    [seek, announce],
  );
  /** Move within the running walk-through; past either end, on to the next game in it. */
  const goQueue = useCallback(
    (i: number) => {
      const q = queueRef.current;
      if (!q) return;
      if (i < 0 || i >= q.items.length) {
        const g = (q.across?.base ?? 0) + i;
        if (q.across && g >= 0 && g < q.across.total) q.across.go(g);
        return;
      }
      queueDone.current = false;
      setQueue({ ...q, idx: i });
      seek(q.items[i].start);
      videoRef.current?.play().catch(() => {});
      announce(true);
    },
    [seek, announce],
  );
  const closeQueue = useCallback(() => {
    if (queueRef.current?.across) onPlaylist?.(null);
    setQueue(null);
  }, [onPlaylist]);
  /** Jump to the moment before or after the current position. */
  const jump = useCallback(
    (dir: 1 | -1) => {
      const v = videoRef.current;
      if (!v) return;
      const q = queueRef.current;
      if (q) {
        goQueue(q.idx + dir);
        return;
      }
      const now = refNow();
      const list = listedRef.current;
      const lead = (m: Marker) => Math.max(0, m.t - (m.cat === "item" ? 2 : 6));
      const target = dir === 1 ? list.find((m) => lead(m) > now + 0.5) : [...list].reverse().find((m) => lead(m) < now - 1.5);
      if (target) seek(lead(target));
    },
    [seek, refNow, goQueue],
  );

  // ---- a walk-through stops at the end of each stretch (unless looping)
  useEffect(() => {
    if (!queue || !playing || looping) return;
    // Paused at the end of a stop, before "playing" has caught up: nothing to do yet.
    if (videoRef.current?.paused) return;
    const item = queue.items[queue.idx];
    if (queueDone.current || time < item.start - 2) {
      // Played on past the stop, or went somewhere else: back to ordinary playback.
      queueDone.current = false;
      closeQueue();
    } else if (time >= item.end) {
      videoRef.current?.pause();
      queueDone.current = true;
      announce(true);
    }
  }, [time, queue, playing, looping, announce, closeQueue]);

  // ---- watching together
  useEffect(() => {
    togetherRef.current = together;
    onTogether?.(together);
    if (!together) return;
    let live = true;
    // Join where the others are if a session is already going; otherwise lead.
    api
      .watchPeers()
      .then((peers) => live && announce(!peers.some((p) => p.matchId === id)))
      .catch(() => live && announce(true));
    const beat = setInterval(() => announce(false), 2000);
    const seen = new Map<string, { name: string; at: number }>();
    const show = () => {
      for (const [code, s] of seen) if (Date.now() - s.at > 7000) seen.delete(code);
      setMates([...seen.values()].map((s) => s.name));
    };
    const off = onEvent<WatchEvent>("watch", (e) => {
      const name = friendsRef.current.find((f) => f.code === e.code)?.name || e.name || "Teammate";
      if (e.kind === "left") seen.delete(e.code);
      else if (e.matchId === id) seen.set(e.code, { name, at: Date.now() });
      show();
      const v = videoRef.current;
      if (!v || e.matchId !== id || e.t === undefined) return;
      const target = Math.max(0, e.t + shiftRef.current + (e.playing ? 0.15 : 0));
      if (e.kind === "control") {
        if (e.rate && v.playbackRate !== e.rate) {
          v.playbackRate = e.rate;
          setRate(e.rate);
        }
        if (Math.abs(v.currentTime - target) > 0.3) v.currentTime = target;
        if (e.playing && v.paused) v.play().catch(() => {});
        if (!e.playing && !v.paused) v.pause();
        setTime(v.currentTime - shiftRef.current);
      } else if (e.kind === "sync") {
        // The regular report from whoever pressed last: only correct real drift.
        if (e.playing && v.paused) v.play().catch(() => {});
        if (!e.playing && !v.paused) v.pause();
        if (Math.abs(v.currentTime - target) > 0.8) v.currentTime = target;
      }
    });
    const prune = setInterval(show, 1500);
    return () => {
      live = false;
      clearInterval(beat);
      clearInterval(prune);
      off();
      togetherRef.current = false;
      setMates([]);
      onTogether?.(false);
      api.watchSet(null, 0, false, 1, false).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [together, id, announce]);
  const fullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }, []);

  // ---- notes and drawings
  const addNote = (text: string, replyTo?: string) => {
    setReview((r) => ({ ...r, notes: [...r.notes, { id: uid(), t: replyTo ? (r.notes.find((n) => n.id === replyTo)?.t ?? time) : time, text, ...(replyTo ? { replyTo } : {}) }].sort((a, b) => a.t - b.t) }));
  };
  /** Change the drawings, keeping the old ones for Ctrl+Z. */
  const changeDrawings = useCallback((fn: (d: Drawing[]) => Drawing[]) => {
    undoStack.current.push(reviewRef.current.drawings);
    if (undoStack.current.length > 60) undoStack.current.shift();
    setReview((r) => ({ ...r, drawings: fn(r.drawings) }));
  }, []);
  const undoDrawing = useCallback(() => {
    const prev = undoStack.current.pop();
    if (prev) setReview((r) => ({ ...r, drawings: prev }));
  }, []);
  // A drawing belongs to the recording it was drawn over, named by that player.
  const myName = match?.game?.me?.name ?? "";
  const viewName = pov ? pov.player : myName;
  const drawnFor = (d: Drawing, target: string) => (d.view ?? myName) === target;
  const commitShape = (shape: Shape, targetView?: string) => {
    const target = targetView ?? viewName;
    changeDrawings((all) => {
      const existing = all.find((d) => drawnFor(d, target) && Math.abs(d.t - time) < 0.3);
      return existing
        ? all.map((d) => (d === existing ? { ...d, shapes: [...d.shapes, shape] } : d))
        : [...all, { id: uid(), t: time, shapes: [shape], ...(target !== myName ? { view: target } : {}) }];
    });
  };
  const visibleDrawings = review.drawings.filter((d) => drawnFor(d, viewName) && Math.abs(d.t - time) <= DRAW_WINDOW);
  /** What teammates drew over the recording that is showing. */
  const sharedDrawings = extras.flatMap((e) => e.drawings.filter((d) => d.view === viewName && Math.abs(d.t - time) <= DRAW_WINDOW));
  const visibleViews = [viewName, ...split.map((p) => p.player)];
  const anyVisibleDrawings = review.drawings.some((d) => visibleViews.includes(d.view ?? myName) && Math.abs(d.t - time) <= DRAW_WINDOW);
  const clearDrawings = () => changeDrawings((all) => all.filter((d) => !visibleViews.includes(d.view ?? myName) || Math.abs(d.t - time) > DRAW_WINDOW));
  const pointIn = (e: React.PointerEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    return [Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1), Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1)];
  };

  // ---- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ownsKeys(e.target)) return;
      const v = videoRef.current;
      if (!v) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undoDrawing();
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "P" && e.shiftKey) {
        setShare((s) => !s);
        return;
      }
      if (e.key === "?") {
        setHelp((h) => !h);
        return;
      }
      const a = audioRef.current;
      const mute = (n: TrackName) => setTrackAudio({ muted: { ...a.muted, [n]: !a.muted[n] } });
      const p = prefsRef.current;
      switch (e.key.length === 1 ? e.key.toLowerCase() : e.key) {
        case " ": e.preventDefault(); toggle(); break;
        case "ArrowLeft": e.preventDefault(); seek(refNow() - (e.shiftKey ? 1 : 5)); break;
        case "ArrowRight": e.preventDefault(); seek(refNow() + (e.shiftKey ? 1 : 5)); break;
        case "j": seek(refNow() - 10); break;
        case "l": seek(refNow() + 10); break;
        case ",": step(-1); break;
        case ".": step(1); break;
        case "n": jump(1); break;
        case "p": jump(-1); break;
        case "[": setClipEdge(0); break;
        case "]": setClipEdge(1); break;
        case "r": toggleLoop(); break;
        case "v": if (splitRef.current.length === 0) cyclePov(); break;
        case "s": toggleSplitMode(); break;
        case "1": mute("game"); break;
        case "2": mute("discord"); break;
        case "3": mute("mic"); break;
        case "d": setTool((t) => (t ? null : "pen")); break;
        case "t": updatePrefs({ theater: !p.theater }); break;
        case "f": fullscreen(); break;
        case "o": setBoard((b) => !b); break;
        case "Escape":
          // One thing at a time, the most recent first.
          if (board) setBoard(false);
          else if (help) setHelp(false);
          else if (tool) setTool(null);
          else if (clipRef.current) {
            setClip(null);
            setLooping(false);
          } else if (queueRef.current) closeQueue();
          else if (share) setShare(false);
          else setLooping(false);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seek, step, toggle, jump, fullscreen, updatePrefs, setTrackAudio, toggleLoop, refNow, cyclePov, toggleSplitMode, setClipEdge, undoDrawing, closeQueue, help, tool, share, board]);

  // ---- timeline data
  const champKeys = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of match?.game?.players ?? []) map.set(p.champion, p.championKey);
    return map;
  }, [match]);
  const champKey = useCallback((name?: string) => (name ? champKeys.get(name) : undefined), [champKeys]);

  /** How many moments of each kind the game has, whether shown or not. */
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    if (!match || match.trimmedToHighlights) return c;
    for (const e of match.events) {
      const cat = categorize(e);
      if (cat) c[cat] = (c[cat] ?? 0) + 1;
    }
    c.bookmark = match.bookmarks.length;
    c.note = review.notes.length + extras.reduce((n, e) => n + e.notes.length, 0);
    return c;
  }, [match, review.notes, extras]);

  const markers = useMemo<Marker[]>(() => {
    if (!match || match.trimmedToHighlights) return [];
    const out: Marker[] = [];
    for (const e of match.events) {
      const cat = categorize(e);
      if (!cat || !prefs.filters[cat]) continue;
      const side: Side = cat === "death" ? "enemy" : cat === "kill" || cat === "assist" ? "ally" : e.good === true ? "ally" : e.good === false ? "enemy" : "neutral";
      out.push({ t: e.t, cat, side, label: describe(e), e });
    }
    if (prefs.filters.bookmark) for (const b of match.bookmarks) out.push({ t: b.t, cat: "bookmark", side: "neutral", label: "Bookmark" });
    if (prefs.filters.note) for (const n of review.notes) if (!n.replyTo) out.push({ t: n.t, cat: "note", side: "neutral", label: n.text.slice(0, 70) });
    if (prefs.filters.note) for (const e of extras) for (const n of e.notes) if (!n.replyTo) out.push({ t: n.t, cat: "tnote", side: "ally", label: `${e.friend}: ${n.text.slice(0, 60)}` });
    if (prefs.keys && keys) {
      for (const s of keys.summonerPresses) {
        out.push({ t: s.t, cat: "summoner", side: "neutral", label: `Pressed ${s.key}` });
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }, [match, review.notes, extras, prefs.filters, prefs.keys, keys]);
  const listed = useMemo(() => markers.filter((m) => m.cat !== "note" && m.cat !== "tnote" && m.cat !== "summoner"), [markers]);
  listedRef.current = listed;

  // Events are on the full game's clock, so a game trimmed to its reel shows none.
  const fights = useMemo(() => (match?.trimmedToHighlights ? [] : fightsOf(match?.events ?? [])), [match]);
  const bands = useMemo(() => fights.map((f) => ({ start: f.start, end: f.end, side: (f.ours > f.theirs ? "ally" : f.ours < f.theirs ? "enemy" : "neutral") as Side })), [fights]);
  const teamNotes = useMemo(
    () => extras.flatMap((e) => e.notes.map((n) => ({ ...n, friend: e.friend, champion: e.champion, championKey: e.championKey, code: e.code }))).sort((a, b) => a.t - b.t),
    [extras],
  );
  const voiceRows = useMemo<VoiceRow[]>(() => {
    const rows: VoiceRow[] = [];
    if (trimmed) return rows;
    if (voice?.mic?.length) rows.push({ key: "me", label: "You", color: VOICE_COLORS[0], spans: voice.mic });
    extras.forEach((e, i) => {
      if (e.voice.length) rows.push({ key: e.code, label: e.friend || e.player, color: VOICE_COLORS[1 + (i % (VOICE_COLORS.length - 1))], spans: e.voice });
    });
    if (voice?.discord?.length) rows.push({ key: "discord", label: rows.length > 1 ? "Discord (everyone)" : "Discord", color: DISCORD_COLOR, spans: voice.discord });
    return rows;
  }, [voice, extras, trimmed]);
  const gameAt = useCallback((t: number) => gameClockAt(match?.clock ?? [], t), [match]);

  const cpm = useMemo(() => {
    if (!mouse || !duration) return [];
    const buckets = new Array(Math.ceil(duration / CPM_BUCKET)).fill(0);
    for (const c of mouse.clicks) {
      const i = Math.floor(c.t / CPM_BUCKET);
      if (i >= 0 && i < buckets.length) buckets[i] += 60 / CPM_BUCKET;
    }
    return buckets as number[];
  }, [mouse, duration]);
  const cpmNow = cpm.length ? cpm[Math.min(cpm.length - 1, Math.floor(time / CPM_BUCKET))] : null;
  /** Key presses per minute around this moment, over the same window as clicks. */
  const kpmNow = useMemo(() => {
    if (!keys) return null;
    const from = Math.floor(time / CPM_BUCKET) * CPM_BUCKET;
    return keys.presses.filter((p) => p >= from && p < from + CPM_BUCKET).length * (60 / CPM_BUCKET);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, Math.floor(time / CPM_BUCKET)]);

  /** The focus the player had going into this game: the newest one chosen before it began. */
  const activeFocus = useMemo<NextFocus | null>(() => {
    if (!match) return null;
    if (review.focusCheck?.text) return { text: review.focusCheck.text, setAt: 0 };
    let best: NextFocus | null = null;
    for (const m of matches ?? []) {
      const f = m.nextFocus;
      if (m.id !== match.id && f?.text && f.setAt < match.startedEpochMs && (!best || f.setAt > best.setAt)) best = f;
    }
    return best;
  }, [matches, match, review.focusCheck]);

  if (loadError) {
    return (
      <div className="page">
        <div className="page-inner">
          <button className="btn" onClick={onBack}>
            <ArrowLeft size={16} aria-hidden />
            Games
          </button>
          <div className="empty">
            <h2>This recording could not be opened</h2>
            <p>{loadError}</p>
          </div>
        </div>
      </div>
    );
  }
  if (!match) {
    return (
      <div className="player loading" aria-busy="true">
        <div className="ptop">
          <Skeleton w={32} h={32} r={8} />
          <Skeleton w={32} h={32} r={16} />
          <div style={{ display: "grid", gap: 6 }}>
            <Skeleton w={180} h={14} />
            <Skeleton w={240} h={11} />
          </div>
        </div>
        <div className="pbody" style={{ gridTemplateColumns: `minmax(0, 1fr) ${prefs.theater ? 0 : prefs.sideWidth + 8}px` }}>
          <div className="stagecol">
            <div className="stage" />
            <div className="deck">
              <Skeleton h={84} r={8} />
              <Skeleton h={32} w="60%" />
            </div>
          </div>
          {!prefs.theater && (
            <div className="side" style={{ padding: 12, display: "grid", gap: 10, alignContent: "start" }}>
              <Skeleton h={34} />
              <Skeleton h={64} />
              <Skeleton h={120} />
            </div>
          )}
        </div>
      </div>
    );
  }

  const me = match.game?.me;
  const result = match.game?.result;
  const game = gameClockAt(match.clock, time);
  let currentIdx = -1;
  listed.forEach((m, i) => {
    if (m.t <= time + 0.5) currentIdx = i;
  });
  const audible = (["game", "discord", "mic"] as TrackName[]).filter((n) => hasTrack(n) && !audio.muted[n]);
  const champName = me?.champion ?? (match.mode === "manual" ? "Screen recording" : "League game");
  const what = me?.champion ? `your ${me.champion} game` : "the recording";

  const saveClip = () => {
    if (!clip) return;
    const [a, b] = clip;
    const len = clock(b - a);
    setBusy(true);
    const work =
      split.length > 0
        ? () => {
            const views = split.filter((p) => p.source).map((p) => ({ source: p.source!, shift: p.shift, label: p.friend }));
            const heard = listen === null ? -1 : views.findIndex((v) => v.label === listen);
            return api.exportSplit(match.id, a, b, views, audible, heard < 0 ? null : heard, "You", maxMb);
          }
        : () => api.exportClip(match.id, a, b, audible, maxMb);
    toast
      .job(split.length > 0 ? `Making a ${len} split-view clip` : `Cutting a ${len} clip`, work, (path) => ({
        kind: "success",
        text: `Saved a ${len} clip`,
        detail: maxMb ? `Under ${maxMb} MB, ready for Discord.` : undefined,
        path,
      }))
      .finally(() => setBusy(false));
    setClip(null);
    setLooping(false);
  };
  const exportFull = () => {
    setBusy(true);
    toast
      .job("Writing one file with every sound track", () => api.exportFull(match.id), (path) => ({ kind: "success", text: "Saved the file for editing", detail: "Game, Discord and your mic are separate tracks in it.", path }))
      .finally(() => setBusy(false));
  };
  const copyCard = () => {
    toast.job(
      "Drawing a picture of the game",
      async () => api.shareCard(match.id, await shareCardPng(match)),
      (path) => ({ kind: "success", text: "Picture of the game copied", detail: "Paste it in Discord. It is also saved with the recording.", path }),
    );
  };
  const setFocusCheck = (answer: FocusCheck["answer"] | null) => {
    if (!activeFocus) return;
    setReview((r) => ({ ...r, focusCheck: answer ? { text: activeFocus.text, answer } : null }));
  };
  const finishReview = (text: string | null) => {
    const now = Date.now();
    const next: Review = { ...reviewRef.current, reviewedAt: now, nextFocus: text ? { text, setAt: reviewRef.current.nextFocus?.text === text ? reviewRef.current.nextFocus.setAt : now } : null };
    setReview(next);
    api
      .saveReview(match.id, next)
      .then(() => {
        onReviewed?.();
        toast.show({ kind: "success", text: "Marked as reviewed", detail: text ? `Rewatch reminds you when your next game starts: ${text}` : undefined });
      })
      .catch((e) => toast.show({ kind: "error", text: `The review was not saved. ${humanError(e)}` }));
  };
  const reopenReview = () => {
    const next: Review = { ...reviewRef.current, reviewedAt: null };
    setReview(next);
    api.saveReview(match.id, next).then(() => onReviewed?.()).catch(() => {});
  };

  const pgMe = match.postgame?.players.find((p) => p.isMe) ?? null;
  const myScore = pgMe && match.postgame ? (scoresOf(match.postgame).get(pgMe.id) ?? null) : null;
  const canBoard = match.mode === "game" && !!(match.postgame?.players.length || match.game?.players?.length);
  /** Who played, how it went, and a line of details, for the top bar. */
  const pid = (details: (string | null | undefined)[]) => (
    <div className="pid">
      {me && <Portrait championKey={me.championKey} name={me.champion} size={36} square level={me.level} />}
      <div className="pid-t">
        <div className="pid-l1">
          <span className="title">{champName}</span>
          {result && <span className={`res ${result === "Win" ? "ally" : "enemy"}`}>{result === "Win" ? "Victory" : "Defeat"}</span>}
          {me && <Kda k={me.kills} d={me.deaths} a={me.assists} />}
          {me && <KdaRatio k={me.kills} d={me.deaths} a={me.assists} />}
          {myScore && <ScoreBadge s={myScore} size="sm" />}
          {me && titles.get(me.champion) && (
            <span className="mytitle" title={titles.get(me.champion)!.why}>
              {titles.get(me.champion)!.title}
            </span>
          )}
        </div>
        <div className="pid-l2">{details.filter(Boolean).join(" · ")}</div>
      </div>
    </div>
  );
  const keepBtn = (
    <button className={`btn sm ${review.keep ? "on" : ""}`} aria-pressed={review.keep} onClick={() => setReview((r) => ({ ...r, keep: !r.keep }))} title="Kept games are never deleted to make room">
      <Star size={15} fill={review.keep ? "currentColor" : "none"} aria-hidden />
      <span className="w">{review.keep ? "Kept" : "Keep"}</span>
    </button>
  );
  const deleteItem = {
    label: match.mode === "game" ? "Delete the whole game" : "Delete recording",
    hint: match.mode === "game" ? "The video, stats and notes" : undefined,
    icon: <Trash2 size={15} />,
    danger: true,
    onSelect: () => onDelete?.(match.id, what),
  };
  const finalBuild = (pgMe?.items.some((x) => x > 0) || (me && me.items.length > 0)) && (
    <>
      <h3 className="sub">Your final build</h3>
      <div className="finalbuild">
        <ItemSlots items={pgMe?.items.some((x) => x > 0) ? pgMe.items : me!.items} size={32} />
      </div>
    </>
  );
  const onFetched = (pg: NonNullable<MatchFull["postgame"]>) => setMatch((m) => (m && m.id === match.id ? { ...m, postgame: pg, postgameNote: null } : m));

  // The library's entry for this game: it knows first when the video was deleted while the game is open.
  const entry = matches?.find((m) => m.id === match.id);
  // The video was deleted, or its file is missing: the game's numbers, review and notes, with nothing to play.
  if (match.hasVideo === false || videoGone || entry?.hasVideo === false) {
    const deletedAt = match.videoDeletedAt ?? entry?.videoDeletedAt;
    const deletedBy = match.videoDeletedBy ?? entry?.videoDeletedBy;
    const on = deletedAt ? new Date(deletedAt).toLocaleDateString([], { day: "numeric", month: "long" }) : "";
    const why =
      videoGone && !deletedAt
        ? "Deleting this game's video."
        : deletedBy === "limit"
          ? `The size limit deleted this game's video${on ? ` on ${on}` : ""} to make room.`
          : deletedAt
            ? `You deleted this game's video${on ? ` on ${on}` : ""}.`
            : "This game's video file is missing. It may have been moved or deleted outside Rewatch.";
    const side = tab === "moments" ? "review" : tab;
    return (
      <div className="player novid">
        <div className="ptop">
          <button className="btn quiet sq" onClick={onBack} aria-label="Back to games" title="Back to games">
            <ArrowLeft size={18} />
          </button>
          {pid([match.game?.queueName, when(match.startedEpochMs), "No video", bytes(entry?.sizeBytes ?? match.sizeBytes)])}
          <span className="grow" />
          {keepBtn}
          <Menu
            label="More"
            items={[
              { label: "Show in folder", icon: <FolderOpen size={15} />, onSelect: () => showInFolder(`${match.dir}\\match.json`) },
              ...(canShare(match)
                ? [{ label: "Copy a picture of the game", hint: "Result, LP, KDA, damage share and where you died, to paste in Discord", icon: <ImageDown size={15} />, onSelect: copyCard }]
                : []),
              "-",
              deleteItem,
            ]}
          >
            <MoreHorizontal size={17} />
          </Menu>
        </div>
        <div className="pbody" style={{ gridTemplateColumns: `minmax(0, 1fr) 8px ${prefs.sideWidth}px` }}>
          <div className="nv-main">
            <p className="nv-note">
              <VideoOff size={16} aria-hidden />
              <span>
                {why} Its stats, notes and LP are kept{match.mode === "game" ? ", and it still counts in Trends" : ""}.
                {deletedBy === "limit" && <small>Keep a game with the star and the size limit leaves its video alone.</small>}
              </span>
            </p>
            {canBoard && <MatchBoard match={match} titles={titles} />}
          </div>
          <Splitter label="Width of the side panel" onMove={(x, r) => updatePrefs({ sideWidth: Math.round(Math.min(Math.max(r.right - x, 300), 640)) })} />
          <aside className="side">
            <div className="tabs" role="tablist">
              {(["review", "notes", "players"] as const).map((t) => {
                const n = t === "notes" ? review.notes.length + teamNotes.length : 0;
                return (
                  <button key={t} role="tab" aria-selected={side === t} onClick={() => setTab(t)}>
                    {t === "review" ? "Review" : t === "notes" ? "Notes" : "Players"}
                    {n > 0 && <span className="cnt num">{n}</span>}
                    {t === "review" && !review.reviewedAt && match.mode === "game" && <span className="dot" title="Not reviewed yet" />}
                  </button>
                );
              })}
            </div>
            {side === "review" && (
              <ReviewTab
                noVideo
                events={match.events}
                fights={fights}
                bookmarks={[]}
                queue={null}
                champKey={champKey}
                onStart={() => {}}
                insights={insights}
                coach={coach}
                hintState="off"
                hintError={null}
                onAskHints={() => {}}
                highlights={[]}
                savingClips={false}
                onSaveClips={() => {}}
                onShowClip={showInFolder}
                team={teamReviews}
                teamViews={1}
                teamBusy={null}
                onTeamReview={() => {}}
                stats={match.stats ?? null}
                players={match.game?.players ?? []}
                keys={keys}
                cpm={cpm}
                duration={duration}
                gameLength={match.game?.length ?? null}
                focus={match.mode === "game" ? activeFocus : null}
                focusCheck={review.focusCheck ?? null}
                onFocusCheck={setFocusCheck}
                reviewedAt={review.reviewedAt ?? null}
                nextFocus={review.nextFocus ?? null}
                onFinish={match.mode === "game" ? finishReview : undefined}
                onReopen={reopenReview}
                usual={usual}
                postgame={match.postgame ?? null}
                clockSamples={match.clock}
                story={match.story ?? null}
              />
            )}
            {side === "notes" && (
              <NotesPanel
                noVideo
                notes={review.notes}
                drawings={review.drawings}
                team={extras.map((e) => ({ friend: e.friend, code: e.code, champion: e.champion, championKey: e.championKey, notes: e.notes, drawings: e.drawings }))}
                me={me}
                time={0}
                tags={review.tags ?? []}
                onTags={(tags) => setReview((r) => ({ ...r, tags }))}
                onSeek={() => {}}
                onAdd={addNote}
                onDelete={deleteNote}
                onPause={() => {}}
              />
            )}
            {side === "players" && (
              <div className="sidebody">
                {match.rank && <RankLine rank={match.rank} />}
                {finalBuild}
                <PostGamePanel key={match.id} match={match} onPlay={null} onFetched={onFetched} />
              </div>
            )}
          </aside>
        </div>
      </div>
    );
  }

  const drawH = Math.round((1000 * match.height) / match.width);
  const ratio = `${match.width} / ${match.height}`;
  const videoSrc = fileUrl(match.dir, match.video);
  const here = peers.filter((p) => p.matchId === id);
  const nameOf = (p: WatchPeer) => friends.find((f) => f.code === p.code)?.name || p.name || "Teammate";
  const readyPovs = povs.filter((p) => p.status === "ready");
  const awayPovs = povs.filter((p) => p.status !== "ready");
  const captions =
    share && !trimmed
      ? [
          ...review.notes.map((n) => ({ key: "m" + n.id, who: "You", t: n.t, text: n.text })),
          ...teamNotes.map((n) => ({ key: n.code + n.id, who: n.friend, t: n.t, text: n.text })),
        ].filter((n) => time >= n.t - 0.5 && time <= n.t + 6)
      : [];
  const overlays: Overlay[] = [
    ...(match.mouse && !trimmed
      ? [
          { key: "trail" as const, label: "Cursor trail", hint: "Where your cursor went over the last moments", on: prefs.trail },
          { key: "clicks" as const, label: "Clicks", hint: "Your clicks, with clicks per minute around this moment", on: prefs.clicks, extra: cpmNow !== null ? `${Math.round(cpmNow)} a minute right now` : null },
        ]
      : []),
    ...(match.keys && !trimmed ? [{ key: "keys" as const, label: "Keys held", hint: "Which game keys were held, over the video", on: prefs.keys, extra: kpmNow !== null ? `${kpmNow} presses a minute right now` : null }] : []),
    ...(voiceRows.length > 0 ? [{ key: "comms" as const, label: "Who was talking", hint: "Rows under the timeline showing who spoke when", on: prefs.comms }] : []),
    ...((match.stats || match.postgame?.teamGold) && !trimmed ? [{ key: "graph" as const, label: "Graph", hint: "CS, level, gold leads and more over the game, under the timeline", on: prefs.graph }] : []),
  ];

  return (
    <div className={`player ${share ? "share" : ""}`}>
      <div className="ptop">
        <button className="btn quiet sq" onClick={onBack} aria-label="Back to games" title="Back to games">
          <ArrowLeft size={18} />
        </button>
        {pid([match.game?.queueName, trimmed ? "Highlights reel" : null, when(match.startedEpochMs), bytes(match.sizeBytes)])}
        <span className="grow" />
        {!together && here.length > 0 && (
          <button className="btn sm presence" onClick={() => setTogether(true)} title="They have this game open. Join to watch in step: pausing and jumping moves you both.">
            <span className="avs" aria-hidden>
              {here.slice(0, 3).map((p) => (
                <i key={p.code}>{nameOf(p).slice(0, 1).toUpperCase()}</i>
              ))}
            </span>
            {here.map(nameOf).join(", ")} {here.length === 1 ? "is" : "are"} here
            <b>Join</b>
          </button>
        )}
        {friends.length > 0 && match.clock.length > 0 && (together || here.length === 0) && (
          <button
            className={`btn sm ${together ? "on" : ""}`}
            aria-pressed={together}
            onClick={() => setTogether((v) => !v)}
            title={together ? "Everyone in the session sees the same moment. Anyone can play, pause or seek. Click to leave." : "Keep this player on the same moment as your teammates' while you review together. They need the same game open."}
          >
            <Users size={15} aria-hidden />
            <span className="w">{together ? (mates.length ? `With ${mates.join(", ")}` : "Waiting for teammates") : "Watch together"}</span>
          </button>
        )}
        {keepBtn}
        {canBoard && (
          <button className={`btn sm ${board ? "on" : ""}`} aria-pressed={board} onClick={() => setBoard((b) => !b)} title="Both teams in full: score, KDA, damage, gold, vision, runes and items (O)">
            <Table2 size={15} aria-hidden />
            <span className="w">Scoreboard</span>
          </button>
        )}
        <button className={`btn sm ${share ? "on" : ""}`} aria-pressed={share} onClick={() => setShare((s) => !s)} title="Share mode: a clean, large view for sharing this window in Discord (Shift+P)">
          <Presentation size={15} aria-hidden />
          <span className="w">Share mode</span>
        </button>
        <Menu
          label="More"
          items={[
            { label: "Show in folder", icon: <FolderOpen size={15} />, onSelect: () => showInFolder(`${match.dir}\\${match.video}`) },
            { label: "Export for editing", hint: "One file, every sound track separate", icon: <Download size={15} />, disabled: busy, onSelect: exportFull },
            ...(canShare(match)
              ? [{ label: "Copy a picture of the game", hint: "Result, LP, KDA, damage share and where you died, to paste in Discord", icon: <ImageDown size={15} />, onSelect: copyCard }]
              : []),
            "-",
            ...(match.mode === "game" && onDeleteVideo
              ? [
                  {
                    label: "Delete the video, keep the stats",
                    hint: `Frees ${bytes(match.videoBytes ?? match.sizeBytes)}. The game stays in your library and Trends.`,
                    icon: <VideoOff size={15} />,
                    danger: true,
                    onSelect: () => onDeleteVideo?.(match.id, what),
                  },
                ]
              : []),
            deleteItem,
          ]}
        >
          <MoreHorizontal size={17} />
        </Menu>
        <button className="btn sq quiet" aria-label={prefs.theater ? "Show side panel" : "Hide side panel"} title={prefs.theater ? "Show side panel (T)" : "Hide side panel (T)"} onClick={() => updatePrefs({ theater: !prefs.theater })}>
          {prefs.theater ? <PanelRightOpen size={17} /> : <PanelRightClose size={17} />}
        </button>
      </div>

      <div className={`pbody ${prefs.theater || share ? "theater" : ""}`} style={prefs.theater || share ? undefined : { gridTemplateColumns: `minmax(0, 1fr) 8px ${prefs.sideWidth}px` }}>
        <div className="stagecol">
          {board && canBoard && <MatchBoard match={match} titles={titles} onClose={() => setBoard(false)} />}
          <div className="stage">
            <div
              className={`tiles n${1 + split.length} ${split.length > 0 ? prefs.layout : ""}`}
              style={split.length > 0 && prefs.layout === "focus" ? { ["--main" as string]: `${prefs.mainPct}%`, gridTemplateRows: `repeat(${split.length}, minmax(0, 1fr))` } : undefined}
            >
              <div className={`tile ${split.length > 0 && listen === null ? "listening" : ""} ${big === null ? "big" : ""}`}>
                <ZoomPane panDisabled={!!tool}>
                  <div className="frame" style={{ aspectRatio: ratio, width: `min(100cqw, calc(100cqh * ${ratio}))` }}>
                    <video
                      // A new element per view, so every switch loads cleanly and resumes at the right moment.
                      key={pov ? `pov-${pov.friend}` : "mine"}
                      ref={videoRef}
                      src={pov?.video ?? videoSrc}
                      preload="auto"
                      onClick={() => !tool && toggle()}
                      onDoubleClick={fullscreen}
                      onLoadedMetadata={() => {
                        const v = videoRef.current;
                        if (!v) return;
                        setVideoDuration(v.duration);
                        const resume = pendingRef.current;
                        pendingRef.current = null;
                        if (resume) {
                          // A different view just loaded: go to the same moment and carry on.
                          v.currentTime = Math.min(Math.max(resume.t + shiftRef.current, 0), Math.max(0, v.duration - 0.05));
                          v.playbackRate = rate;
                          if (resume.play) v.play().catch(() => {});
                        }
                        setTime(v.currentTime - shiftRef.current);
                      }}
                      onError={() => {
                        if (!povRef.current) {
                          toast.show({ id: "video-error", kind: "error", text: "The video could not be played", detail: "The file may have been moved, or it is still being written." });
                          return;
                        }
                        toast.show({ kind: "error", text: `Could not play ${povRef.current.friend}'s view`, detail: "Their app may have closed or the connection dropped." });
                        switchPov(null);
                      }}
                    />
                    <canvas ref={canvasRef} />
                    {/* My own keys only: teammates' key logs are not shared. */}
                    {match.keys && keys && prefs.keys && !pov && !trimmed && <KeyOverlay names={match.keys.names} rows={match.keys.rows} ref={keysElRef} />}
                    <svg
                      ref={svgRef}
                      className={`draw ${tool ? "active" : ""} ${tool === "laser" ? "laser" : ""}`}
                      viewBox={`0 0 1000 ${drawH}`}
                      onPointerDown={(e) => {
                        if (!tool) return;
                        if (tool === "laser") {
                          const [x, y] = pointIn(e);
                          laserFeed.current?.(x, y);
                          return;
                        }
                        videoRef.current?.pause();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        setDraft({ tool, color: ink, pts: [pointIn(e)] });
                      }}
                      onPointerMove={(e) => {
                        if (tool === "laser") {
                          const [x, y] = pointIn(e);
                          laserFeed.current?.(x, y);
                          return;
                        }
                        if (!draft) return;
                        const p = pointIn(e);
                        setDraft((d) => d && { ...d, pts: d.tool === "pen" ? [...d.pts, p] : [d.pts[0], p] });
                      }}
                      onPointerUp={() => {
                        if (draft && draft.pts.length > 1) commitShape(draft);
                        setDraft(null);
                      }}
                    >
                      {sharedDrawings.flatMap((d) => d.shapes.map((s, i) => <ShapeView key={"t" + d.id + i} s={s} w={1000} h={drawH} />))}
                      {visibleDrawings.flatMap((d) => d.shapes.map((s, i) => <ShapeView key={d.id + i} s={s} w={1000} h={drawH} />))}
                      {draft && <ShapeView s={draft} w={1000} h={drawH} />}
                      {tool === "laser" && <LaserTrail feed={laserFeed} w={1000} h={drawH} />}
                    </svg>
                  </div>
                </ZoomPane>
                {split.length > 0 && prefs.layout === "focus" && big !== null && <TileBar big={false} onBig={() => setBig(null)} />}
                {split.length > 0 && (
                  <button className="tile-label" aria-pressed={listen === null} onClick={() => setListen(null)} title={listen === null ? "You are hearing your own game sound" : "Hear your own game sound"}>
                    {me && <Portrait championKey={me.championKey} name={me.champion} size={22} />}
                    You
                    {laneName(me?.position) && <small>{laneName(me?.position)}</small>}
                    {listen === null && <Volume2 size={13} aria-label="Sound on" />}
                  </button>
                )}
              </div>
              {split.map((p) => (
                <SideView
                  key={p.friend}
                  pov={p}
                  masterRef={videoRef}
                  muted={audio.muted.game || listen !== p.friend}
                  volume={audio.volume.game}
                  listening={listen === p.friend}
                  big={prefs.layout === "focus" && big === p.friend}
                  show={prefs}
                  drawings={review.drawings.filter((d) => drawnFor(d, p.player) && Math.abs(d.t - time) <= DRAW_WINDOW)}
                  sharedDrawings={extras.flatMap((e) => e.drawings.filter((d) => d.view === p.player && Math.abs(d.t - time) <= DRAW_WINDOW))}
                  tool={tool}
                  ink={ink}
                  onCommitShape={(shape, v) => commitShape(shape, v)}
                  onListen={() => setListen(p.friend)}
                  onBig={() => {
                    if (prefs.layout === "focus" && big === p.friend) setBig(null);
                    else {
                      updatePrefs({ layout: "focus" });
                      setBig(p.friend);
                    }
                  }}
                  onRemove={() => toggleInSplit(p)}
                  onToggle={toggle}
                  onFail={() => {
                    toast.show({ kind: "error", text: `Could not play ${p.friend}'s view`, detail: "Their app may have closed or the connection dropped." });
                    toggleInSplit(p);
                  }}
                />
              ))}
              {split.length > 0 && prefs.layout === "focus" && (
                <Splitter label="Size of the big view" onMove={(x, r) => updatePrefs({ mainPct: Math.round(Math.min(Math.max(((x - r.left) / r.width) * 100, 35), 88)) })} />
              )}
            </div>
            {game !== null && !trimmed && (
              <div className="gclock">
                {clock(game)}
                <small>in game</small>
              </div>
            )}
            {captions.length > 0 && (
              <div className="captions" aria-live="polite">
                {captions.slice(-2).map((c) => (
                  <p key={c.key}>
                    <b>{c.who}</b> {c.text}
                  </p>
                ))}
              </div>
            )}
            {queue && <QueueBar queue={queue} looping={looping} onToggleLoop={toggleLoop} onGo={goQueue} onReplay={() => goQueue(queue.idx)} onClose={closeQueue} />}
            {povs.length > 0 && !share && (
              <div className="povs" role="group" aria-label={split.length > 0 ? "Views shown side by side" : "Whose view"}>
                <button className="pov" aria-pressed={split.length > 0 || pov === null} disabled={split.length > 0} onClick={() => switchPov(null)} title={split.length > 0 ? "Your own recording is always shown in split view" : "Your own recording"}>
                  {me ? <Portrait championKey={me.championKey} name={me.champion} size={26} /> : <span className="glyph" style={{ width: 26, height: 26 }} />}
                  You
                </button>
                {readyPovs.map((p) => {
                  const lane = laneName(p.position);
                  const shown = split.some((x) => x.friend === p.friend);
                  const pct = saving[p.code] ? Math.floor((saving[p.code][0] / Math.max(1, saving[p.code][1])) * 100) : null;
                  const full = split.length >= MAX_SPLIT && !shown;
                  const why = split.length > 0 ? (shown ? `Hide ${p.friend}'s view` : full ? "Split view is full" : `Show ${p.friend}'s view too`) : `${p.friend}'s view (V)`;
                  return (
                    <button
                      key={p.friend}
                      className="pov"
                      aria-pressed={split.length > 0 ? shown : pov?.friend === p.friend}
                      disabled={full}
                      onClick={() => (split.length > 0 ? toggleInSplit(p) : switchPov(p))}
                      title={`${why}${lane ? `, ${lane}` : ""}. ${p.cached ? "Saved on this PC, so it plays when they are offline." : pct !== null ? `Saving a copy to this PC (${pct}%).` : ""}`}
                    >
                      <Portrait championKey={p.championKey} name={p.champion} size={26} />
                      {p.friend}
                      {p.cached ? <HardDriveDownload size={13} aria-label="Saved on this PC" /> : pct !== null ? <small>{pct}%</small> : null}
                    </button>
                  );
                })}
                {awayPovs.length > 0 && (
                  <span className="pov away" title={awayPovs.map((p) => `${p.friend}: ${(POV_STATUS[p.status] ?? ["unavailable", ""]).join(". ")}`).join("\n")}>
                    {awayPovs.length === 1 ? `${awayPovs[0].friend} ${(POV_STATUS[awayPovs[0].status] ?? ["unavailable"])[0]}` : `${awayPovs.length} unavailable`}
                  </span>
                )}
                {readyPovs.length > 0 && (
                  <button className="pov icon" aria-pressed={split.length > 0} onClick={toggleSplitMode} title="Show several views side by side (S)">
                    <LayoutGrid size={15} aria-hidden />
                    Split
                  </button>
                )}
                {split.length > 0 && (
                  <button className="pov icon" onClick={() => updatePrefs({ layout: prefs.layout === "focus" ? "grid" : "focus" })} title="Switch between one big view with the others beside it, and equal sizes">
                    {prefs.layout === "focus" ? <Grid2x2 size={15} aria-hidden /> : <LayoutPanelLeft size={15} aria-hidden />}
                    {prefs.layout === "focus" ? "Equal" : "One big"}
                  </button>
                )}
              </div>
            )}
            <div className={`palette ${tool ? "open" : ""}`} role="toolbar" aria-label="Draw on the video">
              {!tool ? (
                <button className="btn sq" aria-label="Draw" title="Draw on the video (D)" onClick={() => setTool("pen")}>
                  <Pencil size={17} />
                </button>
              ) : (
                <>
                  {TOOLS.map(({ tool: t, label, icon: Icon, hint }) => (
                    <button key={t} className={`btn sq ${tool === t ? "on" : ""}`} aria-pressed={tool === t} aria-label={label} title={hint} onClick={() => setTool(t)}>
                      <Icon size={17} />
                    </button>
                  ))}
                  {tool !== "laser" && (
                    <div className="inks">
                      {INKS.map((c) => (
                        <button key={c} className="ink" style={{ background: c }} aria-label={`Colour ${c}`} aria-pressed={ink === c} onClick={() => setInk(c)} />
                      ))}
                    </div>
                  )}
                  <hr />
                  <button className="btn sq" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={undoStack.current.length === 0} onClick={undoDrawing}>
                    <Undo2 size={16} />
                  </button>
                  <button className="btn sq" aria-label="Erase drawings at this moment" title="Erase drawings at this moment" disabled={!anyVisibleDrawings} onClick={clearDrawings}>
                    <Eraser size={16} />
                  </button>
                  <button className="btn sq" aria-label="Stop drawing" title="Stop drawing (Esc)" onClick={() => setTool(null)}>
                    <X size={16} />
                  </button>
                </>
              )}
            </div>
            {share && (
              <button className="btn sm share-exit" onClick={() => setShare(false)} title="Leave share mode (Esc)">
                <X size={14} aria-hidden />
                Leave share mode
              </button>
            )}
          </div>

          <div className="deck">
            {clip && !share && (
              <ClipBar
                range={clip}
                maxMb={maxMb}
                looping={looping}
                busy={busy}
                split={split.length > 0}
                onSize={setMaxMb}
                onLoop={toggleLoop}
                onPlay={() => {
                  seek(clip[0]);
                  videoRef.current?.play().catch(() => {});
                }}
                onCancel={() => {
                  setClip(null);
                  setLooping(false);
                }}
                onSave={saveClip}
              />
            )}
            <Timeline
              duration={duration}
              time={time}
              markers={markers}
              bands={prefs.filters.fight || prefs.filters.kill || prefs.filters.death ? bands : []}
              cpm={trimmed ? [] : cpm}
              cpmBucket={CPM_BUCKET}
              clip={clip}
              looping={looping}
              clockSamples={match.clock}
              champKey={champKey}
              onSeek={seek}
              onClip={(a, b) => setClip([a, b])}
              previewSrc={pov || split.length > 0 ? null : videoSrc}
              previewRatio={match.width / match.height}
            />
            {!share && (
              <Lanes
                duration={duration}
                time={time}
                voice={voiceRows}
                showVoice={prefs.comms}
                stats={trimmed ? null : (match.stats ?? null)}
                showStats={prefs.graph && !trimmed}
                players={match.game?.players ?? []}
                metric={prefs.metric}
                versus={prefs.versus}
                gameAt={gameAt}
                cpm={trimmed ? [] : cpm}
                cpmBucket={CPM_BUCKET}
                keys={trimmed ? null : keys}
                currentId={match.id}
                compareGames={matches}
                postgame={trimmed ? null : (match.postgame ?? null)}
                clockSamples={match.clock}
                onMetric={(metric) => updatePrefs({ metric })}
                onVersus={(versus) => updatePrefs({ versus })}
                onSeek={seek}
              />
            )}

            <div className="transport">
              <div className="tgroup">
                <button className="btn sq quiet" onClick={() => jump(-1)} aria-label="Previous moment" title="Previous moment (P)" disabled={listed.length === 0 && !queue}>
                  <SkipBack size={16} />
                </button>
                <button className="btn sm quiet num skip" onClick={() => seek(time - 10)} title="Back 10 seconds (J)">
                  −10
                </button>
                <button className="btn lg play" onClick={toggle} aria-label={playing ? "Pause" : "Play"} title="Play or pause (Space)">
                  {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" style={{ marginLeft: 2 }} />}
                </button>
                <button className="btn sm quiet num skip" onClick={() => seek(time + 10)} title="Forward 10 seconds (L)">
                  +10
                </button>
                <button className="btn sq quiet" onClick={() => jump(1)} aria-label="Next moment" title="Next moment (N)" disabled={listed.length === 0 && !queue}>
                  <SkipForward size={16} />
                </button>
                <span className="fstep">
                  <button className="btn sm sq quiet" onClick={() => step(-1)} aria-label="Previous frame" title="Previous frame (,)">
                    ‹
                  </button>
                  <button className="btn sm sq quiet" onClick={() => step(1)} aria-label="Next frame" title="Next frame (.)">
                    ›
                  </button>
                </span>
                <span className="tc">
                  <span className="now">{clock(time)}</span>
                  <span className="of">/ {clock(duration)}</span>
                </span>
              </div>
              <span className="grow" />
              <div className="tgroup">
                <Select
                  small
                  className={`ghost num ${rate !== 1 ? "on" : ""}`}
                  value={rate}
                  options={RATES.map((r) => ({ value: r, label: `${r}×`, hint: r === 1 ? "Normal" : undefined }))}
                  onChange={changeRate}
                  label="Playback speed"
                  placement="top-start"
                />
                {!share && <SoundControl tracks={tracks} audio={audio} onChange={setTrackAudio} />}
                {!share && (
                  <ShowControl
                    filters={prefs.filters}
                    counts={counts}
                    overlays={overlays}
                    onFilter={(k, on) => updatePrefs({ filters: { ...prefs.filters, [k]: on } })}
                    onOverlay={(k, on) => updatePrefs({ [k]: on } as Partial<Prefs>)}
                  />
                )}
                {!share && !clip && (
                  <button className="btn sm clipbtn" onClick={startClip} title="Cut a clip to save or send. Starts with the last 30 seconds; press [ and ] to set its edges.">
                    <Scissors size={15} aria-hidden />
                    <span className="w">Clip</span>
                  </button>
                )}
                <ShortcutsButton open={help} onOpen={setHelp} />
                <button className="btn sq quiet" aria-label="Full screen" title="Full screen (F)" onClick={fullscreen}>
                  <Maximize2 size={16} />
                </button>
              </div>
            </div>
          </div>
        </div>

        {!prefs.theater && !share && <Splitter label="Width of the side panel" onMove={(x, r) => updatePrefs({ sideWidth: Math.round(Math.min(Math.max(r.right - x, 300), 640)) })} />}
        <aside className="side">
          <div className="tabs" role="tablist">
            {(["review", "moments", "notes", "players"] as const).map((t) => {
              const n = t === "moments" ? listed.length : t === "notes" ? review.notes.length + teamNotes.length : 0;
              return (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                  {t === "review" ? "Review" : t === "moments" ? "Moments" : t === "notes" ? "Notes" : "Players"}
                  {n > 0 && <span className="cnt num">{n}</span>}
                  {t === "review" && !review.reviewedAt && match.mode === "game" && <span className="dot" title="Not reviewed yet" />}
                </button>
              );
            })}
          </div>

          {tab === "review" && (
            <ReviewTab
              events={trimmed ? [] : match.events}
              fights={fights}
              bookmarks={trimmed ? [] : match.bookmarks}
              queue={queue}
              champKey={champKey}
              onStart={startQueue}
              insights={insights}
              coach={coach}
              hintState={hintBusy ? "busy" : hintsOn ? "ready" : "off"}
              hintError={hintError}
              onAskHints={askHints}
              highlights={trimmed ? [] : highlights}
              savingClips={savingClips}
              onSaveClips={saveClips}
              onShowClip={showInFolder}
              reel={match.reel}
              buildingReel={buildingReel}
              onBuildReel={buildReel}
              team={teamReviews}
              teamViews={1 + reviewViews.length}
              teamBusy={teamBusy}
              onTeamReview={askTeam}
              stats={trimmed ? null : (match.stats ?? null)}
              players={match.game?.players ?? []}
              keys={trimmed ? null : keys}
              cpm={trimmed ? [] : cpm}
              duration={duration}
              gameLength={match.game?.length ?? null}
              focus={match.mode === "game" ? activeFocus : null}
              focusCheck={review.focusCheck ?? null}
              onFocusCheck={setFocusCheck}
              reviewedAt={review.reviewedAt ?? null}
              nextFocus={review.nextFocus ?? null}
              onFinish={match.mode === "game" ? finishReview : undefined}
              onReopen={reopenReview}
              usual={usual}
              postgame={trimmed ? null : (match.postgame ?? null)}
              clockSamples={match.clock}
              story={match.story ?? null}
            />
          )}

          {tab === "moments" && (
            <div className="sidebody">
              {listed.length === 0 && (
                <div className="side-empty">
                  <p>{match.events.length === 0 ? "No game events were recorded for this one." : "Nothing matches what the timeline is set to show. Change it under Show, below the video."}</p>
                </div>
              )}
              {listed.map((m, i) => (
                <button key={i} className={`moment ${i === currentIdx ? "now" : ""}`} onClick={() => seek(m.t - (m.cat === "item" ? 2 : 6))}>
                  <span className="t">{clock(m.t)}</span>
                  <span className="pic">
                    <MomentPicture m={m} champKey={champKey} />
                  </span>
                  <span className="txt">{m.label}</span>
                </button>
              ))}
            </div>
          )}

          {tab === "notes" && (
            <NotesPanel
              notes={review.notes}
              drawings={review.drawings}
              team={extras.map((e) => ({ friend: e.friend, code: e.code, champion: e.champion, championKey: e.championKey, notes: e.notes, drawings: e.drawings }))}
              me={me}
              time={time}
              tags={review.tags ?? []}
              onTags={(tags) => setReview((r) => ({ ...r, tags }))}
              onSeek={seek}
              onAdd={addNote}
              onDelete={deleteNote}
              onPause={() => videoRef.current?.pause()}
            />
          )}

          {tab === "players" && (
            <div className="sidebody">
              {match.rank && <RankLine rank={match.rank} />}
              {finalBuild}
              <TeamBoard match={match} titles={titles} onOpenFull={canBoard ? () => setBoard(true) : undefined} />
              <PostGamePanel
                key={match.id}
                match={match}
                onPlay={playGame}
                onFetched={onFetched}
              />
            </div>
          )}
        </aside>
      </div>

      {hasTrack("discord") && <audio ref={discordRef} src={fileUrl(match.dir, "discord.m4a")} preload="auto" />}
      {hasTrack("mic") && <audio ref={micRef} src={fileUrl(match.dir, "mic.m4a")} preload="auto" />}
    </div>
  );
}
