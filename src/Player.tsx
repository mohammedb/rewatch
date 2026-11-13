import {
  ArrowLeft, AudioLines, Bookmark, TrendingUp, Users, Grid2x2, HardDriveDownload, LayoutGrid, LayoutPanelLeft, Volume2, ChevronLeft, ChevronRight, Circle, Download, Eraser, FolderOpen, Gamepad2, Headphones, Keyboard,
  Maximize2, Mic, MicOff, MousePointer2, MousePointerClick, MoveUpRight, PanelRightClose, PanelRightOpen, Pause, Pencil,
  Play, Repeat, Scissors, SkipBack, SkipForward, Skull, Star, Swords, Trash2, VolumeX, X, type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fileUrl, onEvent, showInFolder } from "./api";
import { ItemIcon, Portrait, type Side } from "./ChampIcon";
import { bytes, categorize, CATEGORY_LABEL, clock, describe, gameClockAt, laneName, uid, when } from "./format";
import { eventGlyph, FILTER_ICON } from "./icons";
import { DISCORD_COLOR, fightsOf, type Fight, Lanes, QueueBar, ReviewTab, VOICE_COLORS, type Metric, type Queue, type QueueItem, type VoiceRow } from "./Insights";
import { Timeline, type Marker } from "./Timeline";
import { drawKeys, drawMouse, KeyOverlay, parseKeys, parseMouse, ShapeView, SideView, Splitter, TileBar, usePovMouse, ZoomPane, type KeyLog, type MouseLog } from "./Views";
import type { AudioPrefs, Coach, Drawing, Extras, Friend, Highlight, Insights, MatchFull, MatchSummary, PlayerTitle, TeamReview, PlayerRow, Pov, Review, Shape, Tool, TrackName, Voice, WatchEvent } from "./types";

const INKS = ["#ffd23f", "#f2584b", "#4c9dff", "#ffffff"];
const FILTERS = ["kill", "death", "assist", "fight", "objective", "structure", "item", "bookmark", "note"] as const;
const FILTER_COLOR: Record<string, string> = {
  kill: "var(--ally)", death: "var(--enemy)", assist: "var(--ally)", fight: "var(--soft)", objective: "var(--epic)",
  structure: "var(--soft)", item: "var(--gold)", bookmark: "var(--mark)", note: "var(--text)",
};
const TRACKS: { name: TrackName; label: string; icon: LucideIcon; off: LucideIcon }[] = [
  { name: "game", label: "Game", icon: Gamepad2, off: VolumeX },
  { name: "discord", label: "Discord", icon: Headphones, off: VolumeX },
  { name: "mic", label: "Mic", icon: Mic, off: MicOff },
];
const TOOLS: { tool: Tool; label: string; icon: LucideIcon }[] = [
  { tool: "pen", label: "Pen", icon: Pencil },
  { tool: "arrow", label: "Arrow", icon: MoveUpRight },
  { tool: "circle", label: "Circle", icon: Circle },
];
const SHORTCUTS: [string, string][] = [
  ["Space", "Play or pause"], ["← →", "Back or forward 5 seconds"], ["Shift ← →", "1 second"], ["J L", "10 seconds"],
  [", .", "One frame"], ["P N", "Previous or next moment"], ["1 2 3", "Mute game, Discord, mic"], ["D", "Draw"],
  ["[ ]", "Mark clip start and end"], ["R", "Loop clip or moment"], ["V", "Next teammate's view"], ["S", "Split view on or off"], ["T", "Hide or show the side panel"], ["F", "Full screen"],
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
/** Seconds a drawing stays on screen either side of the moment it was made. */
const DRAW_WINDOW = 2;

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
  comms: true,
  graph: true,
  metric: "cs",
  versus: "",
};

function Scoreboard({ players, titles }: { players: PlayerRow[]; titles: Map<string, PlayerTitle> }) {
  const myTeam = players.find((p) => p.isMe)?.team;
  const teams = [...new Set(players.map((p) => p.team))].sort((a) => (a === myTeam ? -1 : 1));
  return (
    <>
      {teams.map((team) => (
        <table className="score-t" key={team}>
          <caption className={team === myTeam ? "ally" : "enemy"}>{team === myTeam ? "Your team" : "Enemy team"}</caption>
          <tbody>
            {players.filter((p) => p.team === team).map((p) => (
              <tr key={p.name + p.champion} className={p.isMe ? "me" : ""}>
                <td style={{ width: 38 }}><Portrait championKey={p.championKey} name={p.champion} size={30} /></td>
                <td>
                  {p.champion}<small>{p.name}</small>
                  {titles.get(p.champion) && <em className="ptitle" title={titles.get(p.champion)!.why}>{titles.get(p.champion)!.title}</em>}
                </td>
                <td className="n">{p.kills} / {p.deaths} / {p.assists}</td>
                <td className="n" title="Creep score">{p.cs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </>
  );
}

/** The small picture in front of a moment: who fought whom, what was bought, what fell. */
function MomentPicture({ m, champKey }: { m: Marker; champKey: (n?: string) => string | undefined }) {
  const e = m.e;
  if (m.cat === "bookmark") return <span className="glyph mark" style={{ width: 26, height: 26 }}><Bookmark size={14} fill="currentColor" /></span>;
  if (!e) return null;
  if (e.kind === "ChampionKill") {
    const killerSide: Side = m.side === "neutral" ? "neutral" : m.side;
    const victimSide: Side = m.side === "ally" ? "enemy" : m.side === "enemy" ? "ally" : "neutral";
    return (
      <>
        {e.killerChamp ? (
          <Portrait championKey={champKey(e.killerChamp)} name={e.killerChamp} size={26} side={killerSide} />
        ) : (
          <span className={`glyph ${killerSide}`} style={{ width: 26, height: 26 }}><Skull size={14} /></span>
        )}
        <Swords size={12} aria-hidden />
        <Portrait championKey={champKey(e.victimChamp)} name={e.victimChamp ?? "?"} size={26} side={victimSide} />
      </>
    );
  }
  if (e.kind === "ItemPurchased") return <ItemIcon id={e.itemId ?? 0} name={e.detail ?? "Item"} size={28} />;
  const Icon = eventGlyph(e);
  return <span className={`glyph ${m.side}`} style={{ width: 26, height: 26 }}><Icon size={15} strokeWidth={2.2} /></span>;
}

/** Most views that can be shown next to your own in split view. */
const MAX_SPLIT = 4;

interface PlayerProps {
  id: string;
  onBack: () => void;
  /** The teammates list, for watching together. */
  friends: Friend[];
  /** Library matches, for side-by-side game comparison in the graph. */
  matches?: MatchSummary[];
  /** Opened from a teammate's invitation: start in watch-together. */
  joinTogether?: boolean;
  /** Told whenever watch-together is switched on or off here. */
  onTogether?: (on: boolean) => void;
  /** Hints about deaths are set up in Settings (a key and the switch). */
  hintsOn?: boolean;
}

export function Player({ id, onBack, friends, matches, joinTogether, onTogether, hintsOn }: PlayerProps) {
  const [match, setMatch] = useState<MatchFull | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [review, setReview] = useState<Review>({ keep: false, notes: [], drawings: [] });
  const [time, setTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [tab, setTab] = useState<"moments" | "review" | "notes" | "players">("moments");
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
  const [inPt, setInPt] = useState<number | null>(null);
  const [outPt, setOutPt] = useState<number | null>(null);
  const [looping, setLooping] = useState(false);
  const [maxMb, setMaxMb] = useState<number | null>(null);
  const [buildingReel, setBuildingReel] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [noteText, setNoteText] = useState("");
  const [toast, setToast] = useState<{ text: string; path?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const [mouse, setMouse] = useState<MouseLog | null>(null);
  const [keys, setKeys] = useState<KeyLog | null>(null);
  const keysElRef = useRef<HTMLDivElement>(null);
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
  const inPtRef = useRef<number | null>(null);
  inPtRef.current = inPt;
  const outPtRef = useRef<number | null>(null);
  outPtRef.current = outPt;
  const loopingRef = useRef(false);
  loopingRef.current = looping;
  const voiceRef = useRef<Voice | null>(null);
  voiceRef.current = voice;
  const extrasRef = useRef<Extras[]>([]);
  extrasRef.current = extras;
  const listenRef = useRef<string | null>(null);
  listenRef.current = listen;

  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs("rewatch.player", next);
      return next;
    });
  }, []);

  /** Effective audio settings for this match: per-match override in review.json, or user defaults. */
  const audio: AudioPrefs = useMemo(
    () => review.audio ?? { volume: prefs.volume, muted: prefs.muted, duck: false },
    [review.audio, prefs.volume, prefs.muted],
  );
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
    api.getMatch(id).then((m) => {
      setMatch(m);
      setReview(m.review ?? { keep: false, notes: [], drawings: [] });
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
      if (!m.trimmedToHighlights) api.povList(id).then(setPovs).catch(() => setPovs([]));
    }).catch((e) => setLoadError(String(e)));
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
    const iv = setInterval(load, 20000);
    return () => clearInterval(iv);
  }, [id, trimmed]);

  // ---- hints about deaths arrive in the background a while after a game
  useEffect(() => onEvent<string | null>("insights", (which) => {
    if (which !== id) return;
    api.insights(id, false).then((v) => v && setInsights(v)).catch(() => {});
    api.coach(id, false).then((v) => v && setCoach(v)).catch(() => {});
  }), [id]);
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
      setHintError(String(e));
    } finally {
      setHintBusy(false);
    }
  }, [id]);
  // Highlight clips are made in the background a little after a game.
  useEffect(() => onEvent<string | null>("highlights", (which) => {
    if (which === id) api.highlights(id, false).then(setHighlights).catch(() => {});
  }), [id]);
  const saveClips = useCallback(() => {
    setSavingClips(true);
    api.highlights(id, true).then(setHighlights).catch((e) => setToast({ text: String(e) })).finally(() => setSavingClips(false));
  }, [id]);
  const buildReel = useCallback(() => {
    setBuildingReel(true);
    api.buildHighlightReel(id)
      .then((path) => {
        setMatch((m) => (m ? { ...m, reel: path } : m));
        setToast({ text: `Saved highlight reel to ${path}`, path });
      })
      .catch((e) => setToast({ text: String(e) }))
      .finally(() => setBuildingReel(false));
  }, [id]);
  /** Teammates' views that could go into a team review: ready and with a usable source. */
  const reviewViews = useMemo(() => povs.filter((p) => p.status === "ready" && p.source && p.champion).slice(0, 4), [povs]);
  const askTeam = useCallback((fight: Fight) => {
    setTeamBusy(fight.start);
    setHintError(null);
    api.teamReview(id, fight.start, fight.end, reviewViews.map((p) => ({ source: p.source!, shift: p.shift, champion: p.champion })))
      .then((r) => setMyTeam((cur) => [...cur.filter((x) => Math.abs(x.t - r.t) > 3), r]))
      .catch((e) => setHintError(String(e)))
      .finally(() => setTeamBusy(null));
  }, [id, reviewViews]);
  // My own team reviews first; a teammate's review of a fight I have not reviewed is shown too.
  const teamReviews = useMemo(() => {
    const all = [...myTeam];
    for (const e of extras) for (const r of e.team ?? []) if (!all.some((x) => Math.abs(x.t - r.t) < 6)) all.push(r);
    return all;
  }, [myTeam, extras]);
  // A title per player: from my own AI review, else a teammate's, else the built-in ones.
  const titles = useMemo(() => {
    const list = coach?.titles?.length ? coach.titles : extras.find((e) => e.titles?.length)?.titles ?? match?.titles ?? [];
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
    else if (!match.trimmedToHighlights && match.tracks.some((t) => t.name !== "game")) api.voice(match.id).then(setVoice).catch(() => {});
  }, [match]);

  // ---- follow the saving of teammates' views, and refresh the list when one lands
  useEffect(() => {
    let last = "";
    const iv = setInterval(() => {
      api.povSaving(id).then((m) => {
        const now = Object.keys(m).sort().join(",");
        setSaving(m);
        if (last && last !== now) api.povList(id).then(setPovs).catch(() => {});
        last = now;
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(iv);
  }, [id]);

  // ---- save notes, drawings and the keep flag shortly after each change
  useEffect(() => {
    if (!match) return;
    if (!reviewLoaded.current) {
      reviewLoaded.current = true;
      return;
    }
    const h = setTimeout(() => api.saveReview(match.id, review).catch(() => {}), 500);
    return () => clearTimeout(h);
  }, [review, match]);

  const duration = match?.trimmedToHighlights ? (videoDuration || match.reelDuration || match.duration) : (match?.duration ?? 0);
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
    const onPlay = () => { setPlaying(true); sync(true); };
    const onPause = () => { setPlaying(false); sync(true); setTime(v.currentTime - shiftRef.current); };
    const onSeeked = () => { sync(true); setTime(v.currentTime - shiftRef.current); };
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

  // ---- one animation loop: time readout, A-B looping, voice ducking, mouse & key overlays
  useEffect(() => {
    let raf = 0;
    let lastShown = -1;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const v = videoRef.current;
      const c = canvasRef.current;
      if (!v) return;
      let now = v.currentTime - shiftRef.current;

      // A-B loop playback
      if (loopingRef.current && !v.paused) {
        const q = queueRef.current;
        const a = inPtRef.current !== null && outPtRef.current !== null && outPtRef.current > inPtRef.current + 0.1
          ? inPtRef.current
          : q ? q.items[q.idx].start : null;
        const b = inPtRef.current !== null && outPtRef.current !== null && outPtRef.current > inPtRef.current + 0.1
          ? outPtRef.current
          : q ? q.items[q.idx].end : null;
        if (a !== null && b !== null && now >= b - 0.04) {
          const target = Math.max(0, a + shiftRef.current);
          v.currentTime = target;
          now = a;
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
  const announce = useCallback((control: boolean) => {
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
  }, [id]);
  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    const clamped = Math.min(Math.max(t + shiftRef.current, 0), Math.max(0, (v.duration || duration) - 0.05));
    v.currentTime = clamped;
    setTime(clamped - shiftRef.current);
    announce(true);
  }, [duration, announce]);
  const toggleLoop = useCallback(() => {
    setLooping((prev) => {
      const next = !prev;
      if (next && !(inPtRef.current !== null && outPtRef.current !== null && outPtRef.current > inPtRef.current) && !queueRef.current) {
        const now = refNow();
        setInPt(Math.max(0, now - 5));
        setOutPt(Math.min(duration || now + 5, now + 5));
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
  const step = useCallback((frames: number) => {
    const v = videoRef.current;
    if (!v || !match) return;
    v.pause();
    seek(refNow() + frames / (match.fps || 60));
  }, [match, seek, refNow]);
  const changeRate = (r: number) => {
    setRate(r);
    if (videoRef.current) videoRef.current.playbackRate = r;
    announce(true);
  };
  /** Start, or move within, a walk-through: jump to the stretch and play it. */
  const startQueue = useCallback((title: string, items: QueueItem[], idx: number) => {
    if (idx < 0 || idx >= items.length) return;
    queueDone.current = false;
    setQueue({ title, items, idx });
    seek(items[idx].start);
    videoRef.current?.play().catch(() => {});
    announce(true);
  }, [seek, announce]);
  /** Jump to the moment before or after the current position. */
  const jump = useCallback((dir: 1 | -1) => {
    const v = videoRef.current;
    if (!v) return;
    const q = queueRef.current;
    if (q) {
      startQueue(q.title, q.items, q.idx + dir);
      return;
    }
    const now = refNow();
    const list = listedRef.current;
    const lead = (m: Marker) => Math.max(0, m.t - (m.cat === "item" ? 2 : 6));
    const target = dir === 1 ? list.find((m) => lead(m) > now + 0.5) : [...list].reverse().find((m) => lead(m) < now - 1.5);
    if (target) seek(lead(target));
  }, [seek, refNow, startQueue]);

  // ---- a walk-through stops at the end of each stretch (unless looping)
  useEffect(() => {
    if (!queue || !playing || looping) return;
    const item = queue.items[queue.idx];
    if (queueDone.current || time < item.start - 2) {
      // Played on past the stop, or went somewhere else: back to ordinary playback.
      queueDone.current = false;
      setQueue(null);
    } else if (time >= item.end) {
      videoRef.current?.pause();
      queueDone.current = true;
      announce(true);
    }
  }, [time, queue, playing, looping, announce]);

  // ---- watching together
  useEffect(() => {
    togetherRef.current = together;
    onTogether?.(together);
    if (!together) return;
    let live = true;
    // Join where the others are if a session is already going; otherwise lead.
    api.watchPeers()
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

  // ---- notes, tags and drawings
  const addNote = () => {
    const text = noteText.trim();
    if (!text) return;
    setReview((r) => ({ ...r, notes: [...r.notes, { id: uid(), t: time, text }].sort((a, b) => a.t - b.t) }));
    setNoteText("");
  };
  const addTag = () => {
    const tag = tagDraft.trim().toLowerCase();
    if (!tag) return;
    setReview((r) => ({ ...r, tags: (r.tags ?? []).includes(tag) ? r.tags : [...(r.tags ?? []), tag] }));
    setTagDraft("");
  };
  const removeTag = (tag: string) => {
    setReview((r) => ({ ...r, tags: (r.tags ?? []).filter((t) => t !== tag) }));
  };
  // A drawing belongs to the recording it was drawn over, named by that player.
  const myName = match?.game?.me?.name ?? "";
  const viewName = pov ? pov.player : myName;
  const drawnFor = (d: Drawing, target: string) => (d.view ?? myName) === target;
  const commitShape = (shape: Shape, targetView?: string) => {
    const target = targetView ?? viewName;
    setReview((r) => {
      const existing = r.drawings.find((d) => drawnFor(d, target) && Math.abs(d.t - time) < 0.3);
      const drawings: Drawing[] = existing
        ? r.drawings.map((d) => (d === existing ? { ...d, shapes: [...d.shapes, shape] } : d))
        : [...r.drawings, { id: uid(), t: time, shapes: [shape], ...(target !== myName ? { view: target } : {}) }];
      return { ...r, drawings };
    });
  };
  const visibleDrawings = review.drawings.filter((d) => drawnFor(d, viewName) && Math.abs(d.t - time) <= DRAW_WINDOW);
  /** What teammates drew over the recording that is showing. */
  const sharedDrawings = extras.flatMap((e) => e.drawings.filter((d) => d.view === viewName && Math.abs(d.t - time) <= DRAW_WINDOW));
  const visibleViews = [viewName, ...split.map((p) => p.player)];
  const anyVisibleDrawings = review.drawings.some((d) => visibleViews.includes(d.view ?? myName) && Math.abs(d.t - time) <= DRAW_WINDOW);
  const clearDrawings = () =>
    setReview((r) => ({
      ...r,
      drawings: r.drawings.filter((d) => !visibleViews.includes(d.view ?? myName) || Math.abs(d.t - time) > DRAW_WINDOW),
    }));
  const pointIn = (e: React.PointerEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    return [Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1), Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1)];
  };

  // ---- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT") return;
      const v = videoRef.current;
      if (!v || e.ctrlKey || e.altKey || e.metaKey) return;
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
        case "[": setInPt(refNow()); break;
        case "]": setOutPt(refNow()); break;
        case "r": toggleLoop(); break;
        case "v": if (splitRef.current.length === 0) cyclePov(); break;
        case "s": toggleSplitMode(); break;
        case "1": mute("game"); break;
        case "2": mute("discord"); break;
        case "3": mute("mic"); break;
        case "d": setTool((t) => (t ? null : "pen")); break;
        case "t": updatePrefs({ theater: !p.theater }); break;
        case "f": fullscreen(); break;
        case "Escape": setTool(null); setHelp(false); setQueue(null); setLooping(false); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seek, step, toggle, jump, fullscreen, updatePrefs, setTrackAudio, toggleLoop, refNow, cyclePov, toggleSplitMode]);

  // ---- timeline data
  const champKeys = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of match?.game?.players ?? []) map.set(p.champion, p.championKey);
    return map;
  }, [match]);
  const champKey = useCallback((name?: string) => (name ? champKeys.get(name) : undefined), [champKeys]);

  const markers = useMemo<Marker[]>(() => {
    if (!match || match.trimmedToHighlights) return [];
    const out: Marker[] = [];
    for (const e of match.events) {
      const cat = categorize(e);
      if (!cat || !prefs.filters[cat]) continue;
      const side: Side = cat === "death" ? "enemy" : cat === "kill" || cat === "assist" ? "ally"
        : e.good === true ? "ally" : e.good === false ? "enemy" : "neutral";
      out.push({ t: e.t, cat, side, label: describe(e), e });
    }
    if (prefs.filters.bookmark) for (const b of match.bookmarks) out.push({ t: b.t, cat: "bookmark", side: "neutral", label: "Bookmark" });
    if (prefs.filters.note) for (const n of review.notes) out.push({ t: n.t, cat: "note", side: "neutral", label: n.text.slice(0, 70) });
    if (prefs.filters.note) for (const e of extras) for (const n of e.notes) out.push({ t: n.t, cat: "tnote", side: "ally", label: `${e.friend}: ${n.text.slice(0, 60)}` });
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
  }, [keys, Math.floor(time / CPM_BUCKET)]);

  if (loadError) {
    return (
      <div className="page">
        <button className="btn" onClick={onBack}><ArrowLeft size={16} aria-hidden />Games</button>
        <p className="enemy" style={{ marginTop: 16 }}>{loadError}</p>
      </div>
    );
  }
  if (!match) return <div className="page" />;

  const me = match.game?.me;
  const result = match.game?.result;
  const game = gameClockAt(match.clock, time);
  let currentIdx = -1;
  listed.forEach((m, i) => { if (m.t <= time + 0.5) currentIdx = i; });
  const audible = TRACKS.map((t) => t.name).filter((n) => hasTrack(n) && !audio.muted[n]);
  const marked = inPt !== null && outPt !== null && outPt > inPt;
  const clipRange: [number, number] = marked ? [inPt!, outPt!] : [Math.max(0, time - 30), Math.max(1, time)];

  const run = async (label: string, job: () => Promise<string>) => {
    setBusy(true);
    setToast({ text: label });
    try {
      const path = await job();
      setToast({ text: `Saved to ${path}`, path });
    } catch (e) {
      setToast({ text: String(e) });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm("Delete this recording and its notes? This cannot be undone.")) return;
    await api.deleteMatch(match.id).catch(() => {});
    onBack();
  };
  const drawH = Math.round((1000 * match.height) / match.width);
  const ratio = `${match.width} / ${match.height}`;

  return (
    <div className="player">
      <div className="ptop">
        <button className="btn quiet" onClick={onBack}><ArrowLeft size={17} aria-hidden />Games</button>
        {me && <Portrait championKey={me.championKey} name={me.champion} size={34} />}
        <span className="title">{me?.champion ?? (match.mode === "manual" ? "Screen recording" : "League game")}</span>
        {result && <span className={`res ${result === "Win" ? "ally" : "enemy"}`}>{result === "Win" ? "Victory" : "Defeat"}</span>}
        {me && <span className="num kda">{me.kills} / {me.deaths} / {me.assists}</span>}
        {me && titles.get(me.champion) && <span className="mytitle" title={titles.get(me.champion)!.why}>{titles.get(me.champion)!.title}</span>}
        <div className="facts">
          {match.game?.queueName && <span>{match.game.queueName}</span>}
          {match.trimmedToHighlights && <span>Highlights reel</span>}
          <span>{when(match.startedEpochMs)}</span>
          <span>{bytes(match.sizeBytes)}</span>
        </div>
        {friends.length > 0 && match.clock.length > 0 && (
          <button
            className={`btn ${together ? "on" : ""}`}
            aria-pressed={together}
            onClick={() => setTogether((v) => !v)}
            title={together ? "Everyone in the session sees the same moment. Anyone can play, pause or seek. Click to leave." : "Keep this player on the same moment as your teammates' while you review together. They need the same game open."}
          >
            <Users size={15} aria-hidden />
            {together ? (mates.length ? `With ${mates.join(", ")}` : "Waiting for teammates") : "Watch together"}
          </button>
        )}
        <button className={`btn ${review.keep ? "on" : ""}`} aria-pressed={review.keep} onClick={() => setReview((r) => ({ ...r, keep: !r.keep }))} title="Kept games are never deleted by the size limit">
          <Star size={15} fill={review.keep ? "currentColor" : "none"} aria-hidden />{review.keep ? "Kept" : "Keep"}
        </button>
        <button className="btn" disabled={busy} onClick={() => run("Writing one file with every sound track…", () => api.exportFull(match.id))} title="One MP4 with game, Discord and microphone as separate tracks, for a video editor">
          <Download size={15} aria-hidden />Export for editing
        </button>
        <button className="btn sq" aria-label="Open folder" title="Open folder" onClick={() => showInFolder(`${match.dir}\\${match.video}`)}><FolderOpen size={16} /></button>
        <button className="btn sq danger" aria-label="Delete recording" title="Delete recording" onClick={remove}><Trash2 size={16} /></button>
        <button className="btn sq" aria-label={prefs.theater ? "Show side panel" : "Hide side panel"} title={prefs.theater ? "Show side panel (T)" : "Hide side panel (T)"} onClick={() => updatePrefs({ theater: !prefs.theater })}>
          {prefs.theater ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
        </button>
      </div>

      <div className={`pbody ${prefs.theater ? "theater" : ""}`} style={prefs.theater ? undefined : { gridTemplateColumns: `minmax(0, 1fr) 8px ${prefs.sideWidth}px` }}>
        <div className="stagecol">
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
                src={pov?.video ?? fileUrl(match.dir, match.video)}
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
                  if (!povRef.current) return;
                  setToast({ text: `Could not play ${povRef.current.friend}'s view. Their app may have closed or the connection dropped.` });
                  switchPov(null);
                }}
              />
              <canvas ref={canvasRef} />
              {/* My own keys only: teammates' key logs are not shared. */}
              {match.keys && keys && prefs.keys && !pov && !match.trimmedToHighlights && (
                <KeyOverlay names={match.keys.names} rows={match.keys.rows} ref={keysElRef} />
              )}
              <svg
                ref={svgRef}
                className={`draw ${tool ? "active" : ""}`}
                viewBox={`0 0 1000 ${drawH}`}
                onPointerDown={(e) => {
                  if (!tool) return;
                  videoRef.current?.pause();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDraft({ tool, color: ink, pts: [pointIn(e)] });
                }}
                onPointerMove={(e) => {
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
                  setToast({ text: `Could not play ${p.friend}'s view. Their app may have closed or the connection dropped.` });
                  toggleInSplit(p);
                }}
              />
            ))}
            {split.length > 0 && prefs.layout === "focus" && (
              <Splitter label="Size of the big view" onMove={(x, r) => updatePrefs({ mainPct: Math.round(Math.min(Math.max(((x - r.left) / r.width) * 100, 35), 88)) })} />
            )}
            </div>
            {game !== null && !match.trimmedToHighlights && <div className="gclock">{clock(game)}<small>in game</small></div>}
            {queue && (
              <QueueBar
                queue={queue}
                looping={looping}
                onToggleLoop={toggleLoop}
                onGo={(i) => startQueue(queue.title, queue.items, i)}
                onReplay={() => startQueue(queue.title, queue.items, queue.idx)}
                onClose={() => setQueue(null)}
              />
            )}
            {povs.length > 0 && (
              <div className="povs" role="group" aria-label={split.length > 0 ? "Views shown side by side" : "Whose view"}>
                <button className="pov" aria-pressed={split.length > 0 || pov === null} disabled={split.length > 0} onClick={() => switchPov(null)} title={split.length > 0 ? "Your own recording is always shown in split view" : "Your own recording"}>
                  {me ? <Portrait championKey={me.championKey} name={me.champion} size={28} /> : <span className="glyph" style={{ width: 28, height: 28 }} />}
                  You
                  {laneName(me?.position) && <small>{laneName(me?.position)}</small>}
                </button>
                {povs.map((p) => {
                  const lane = laneName(p.position);
                  const shown = split.some((x) => x.friend === p.friend);
                  const pct = saving[p.code] ? Math.floor((saving[p.code][0] / Math.max(1, saving[p.code][1])) * 100) : null;
                  const full = split.length >= MAX_SPLIT && !shown;
                  const [short, why] = POV_STATUS[p.status] ?? [lane, split.length > 0 ? (shown ? `Hide ${p.friend}'s view` : full ? "Split view is full" : `Show ${p.friend}'s view too`) : `${p.friend}'s view (V)`];
                  return (
                    <button
                      key={p.friend}
                      className="pov"
                      aria-pressed={split.length > 0 ? shown : pov?.friend === p.friend}
                      disabled={p.status !== "ready" || full}
                      onClick={() => (split.length > 0 ? toggleInSplit(p) : switchPov(p))}
                      title={p.cached ? `${why}. Saved on this PC, so it plays when they are offline.` : pct !== null ? `${why}. Saving a copy to this PC (${pct}%).` : why}
                    >
                      {p.status === "ready" ? <Portrait championKey={p.championKey} name={p.champion} size={28} /> : <span className="glyph" style={{ width: 28, height: 28 }} />}
                      {p.friend}
                      {short && <small>{short}</small>}
                      {p.cached ? <HardDriveDownload size={13} aria-label="Saved on this PC" /> : pct !== null ? <small>{pct}%</small> : null}
                    </button>
                  );
                })}
                {povs.some((p) => p.status === "ready") && (
                  <button className="pov icon" aria-pressed={split.length > 0} onClick={toggleSplitMode} title="Show several views side by side (S)">
                    <LayoutGrid size={16} aria-hidden />Split
                  </button>
                )}
                {split.length > 0 && (
                  <button className="pov icon" onClick={() => updatePrefs({ layout: prefs.layout === "focus" ? "grid" : "focus" })} title="Switch between one big view with the others beside it, and equal sizes">
                    {prefs.layout === "focus" ? <Grid2x2 size={16} aria-hidden /> : <LayoutPanelLeft size={16} aria-hidden />}
                    {prefs.layout === "focus" ? "Equal sizes" : "One big"}
                  </button>
                )}
              </div>
            )}
            <div className="palette" role="toolbar" aria-label="Draw on the video">
              {TOOLS.map(({ tool: t, label, icon: Icon }) => (
                <button key={t} className={`btn sq ${tool === t ? "on" : ""}`} aria-pressed={tool === t} aria-label={label} title={`${label}${t === "pen" ? " (D)" : ""}`} onClick={() => setTool(tool === t ? null : t)}>
                  <Icon size={17} />
                </button>
              ))}
              <hr />
              {INKS.map((c) => (
                <button key={c} className="ink" style={{ background: c }} aria-label={`Colour ${c}`} aria-pressed={ink === c} onClick={() => setInk(c)} />
              ))}
              <hr />
              <button className="btn sq" aria-label="Erase drawings at this moment" title="Erase drawings at this moment" disabled={!anyVisibleDrawings} onClick={clearDrawings}><Eraser size={17} /></button>
            </div>
          </div>

          <div className="deck">
            <Timeline duration={duration} time={time} markers={markers} bands={prefs.filters.fight || prefs.filters.kill || prefs.filters.death ? bands : []} cpm={match.trimmedToHighlights ? [] : cpm} cpmBucket={CPM_BUCKET} inPt={inPt} outPt={outPt} looping={looping} clockSamples={match.clock} champKey={champKey} onSeek={seek} />
            <Lanes
              duration={duration}
              time={time}
              voice={voiceRows}
              showVoice={prefs.comms}
              stats={match.trimmedToHighlights ? null : (match.stats ?? null)}
              showStats={prefs.graph && !match.trimmedToHighlights}
              players={match.game?.players ?? []}
              metric={prefs.metric}
              versus={prefs.versus}
              gameAt={gameAt}
              cpm={match.trimmedToHighlights ? [] : cpm}
              cpmBucket={CPM_BUCKET}
              keys={match.trimmedToHighlights ? null : keys}
              currentId={match.id}
              compareGames={matches}
              onMetric={(metric) => updatePrefs({ metric })}
              onVersus={(versus) => updatePrefs({ versus })}
              onSeek={seek}
            />

            <div className="row">
              <button className="btn sq" onClick={() => jump(-1)} aria-label="Previous moment" title="Previous moment (P)" disabled={listed.length === 0}><SkipBack size={16} /></button>
              <button className="btn" onClick={() => seek(time - 10)} title="Back 10 seconds (J)">−10</button>
              <button className="btn lg mark" onClick={toggle} aria-label={playing ? "Pause" : "Play"} title="Play or pause (Space)">
                {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" style={{ marginLeft: 2 }} />}
              </button>
              <button className="btn" onClick={() => seek(time + 10)} title="Forward 10 seconds (L)">+10</button>
              <button className="btn sq" onClick={() => jump(1)} aria-label="Next moment" title="Next moment (N)" disabled={listed.length === 0}><SkipForward size={16} /></button>
              <span className="gap" />
              <button className="btn sq" onClick={() => step(-1)} aria-label="Previous frame" title="Previous frame (,)"><ChevronLeft size={17} /></button>
              <button className="btn sq" onClick={() => step(1)} aria-label="Next frame" title="Next frame (.)"><ChevronRight size={17} /></button>
              <select className="field-input" value={rate} onChange={(e) => changeRate(Number(e.target.value))} aria-label="Playback speed">
                {[0.25, 0.5, 1, 1.5, 2].map((r) => <option key={r} value={r}>{r}×</option>)}
              </select>
              <span className="tc"><span className="now">{clock(time)}</span><span className="of">/ {clock(duration)}</span></span>
              <span className="grow" />
              <div className="mixer" role="group" aria-label="Sound tracks">
                {TRACKS.filter((t) => hasTrack(t.name)).map(({ name, label, icon: On, off: Off }, i) => {
                  const tr = tracks.find((t) => t.name === name)!;
                  const muted = audio.muted[name];
                  const hint = tr.silent ? `Nothing was heard on this track${tr.note ? ` (${tr.note})` : ""}` : `${muted ? "Unmute" : "Mute"} ${label} (${i + 1})`;
                  return (
                    <div key={name} className={`mix ${muted ? "off" : ""} ${tr.silent ? "silent" : ""}`} title={hint}>
                      <button className="btn" aria-pressed={!muted} aria-label={`${label} sound`} onClick={() => setTrackAudio({ muted: { ...audio.muted, [name]: !muted } })}>
                        {muted ? <Off size={15} /> : <On size={15} />}<span className="w">{label}</span>
                      </button>
                      <input type="range" min={0} max={1} step={0.05} value={audio.volume[name]} aria-label={`${label} volume`} onChange={(e) => setTrackAudio({ volume: { ...audio.volume, [name]: Number(e.target.value) } })} />
                    </div>
                  );
                })}
                {hasTrack("game") && (hasTrack("discord") || hasTrack("mic")) && (
                  <button
                    className={`btn duck ${audio.duck ? "on" : ""}`}
                    aria-pressed={!!audio.duck}
                    title="Auto-duck game audio whenever someone speaks on Discord or microphone"
                    onClick={() => setTrackAudio({ duck: !audio.duck })}
                  >
                    <AudioLines size={13} aria-hidden /><span className="w">Duck</span>
                  </button>
                )}
              </div>
            </div>

            <div className="row" style={{ position: "relative" }}>
              <div className="chips" role="group" aria-label="Show on the timeline">
                {FILTERS.map((f) => {
                  const Icon = FILTER_ICON[f];
                  return (
                    <button key={f} className="chip" aria-pressed={!!prefs.filters[f]} aria-label={CATEGORY_LABEL[f]} title={CATEGORY_LABEL[f]} style={{ ["--c" as string]: FILTER_COLOR[f] }} onClick={() => updatePrefs({ filters: { ...prefs.filters, [f]: !prefs.filters[f] } })}>
                      <Icon size={15} aria-hidden /><span className="w">{CATEGORY_LABEL[f]}</span>
                    </button>
                  );
                })}
                {match.mouse && !match.trimmedToHighlights && (
                  <>
                    <button className="chip" aria-pressed={prefs.trail} style={{ ["--c" as string]: "var(--mark)" }} aria-label="Cursor trail" title="Cursor trail" onClick={() => updatePrefs({ trail: !prefs.trail })}><MousePointer2 size={15} aria-hidden /><span className="w">Cursor trail</span></button>
                    <button className="chip" aria-pressed={prefs.clicks} aria-label="Clicks" title="Clicks, with clicks per minute around this moment" onClick={() => updatePrefs({ clicks: !prefs.clicks })}>
                      <MousePointerClick size={15} aria-hidden /><span className="w">Clicks</span>{cpmNow !== null && <span className="num">{Math.round(cpmNow)}/min</span>}
                    </button>
                  </>
                )}
                {match.keys && !match.trimmedToHighlights && (
                  <button className="chip" aria-pressed={prefs.keys} aria-label="Keys" title="Which keys were held, over the video, with key presses per minute around this moment" onClick={() => updatePrefs({ keys: !prefs.keys })}>
                    <Keyboard size={15} aria-hidden /><span className="w">Keys</span>{kpmNow !== null && <span className="num">{kpmNow}/min</span>}
                  </button>
                )}
                {voiceRows.length > 0 && (
                  <button className="chip" aria-pressed={prefs.comms} aria-label="Who was talking" title="Rows under the timeline showing who was talking when" onClick={() => updatePrefs({ comms: !prefs.comms })}><AudioLines size={15} aria-hidden /><span className="w">Comms</span></button>
                )}
                {match.stats && !match.trimmedToHighlights && (
                  <button className="chip" aria-pressed={prefs.graph} aria-label="Graph" title="CS, level and gold over the game, under the timeline" onClick={() => updatePrefs({ graph: !prefs.graph })}><TrendingUp size={15} aria-hidden /><span className="w">Graph</span></button>
                )}
              </div>
              <span className="grow" />
              <button className={`btn ${inPt !== null ? "on" : ""}`} onClick={() => setInPt(time)} title="Mark where the clip starts ([)">Start{inPt !== null ? ` ${clock(inPt)}` : ""}</button>
              <button className={`btn ${outPt !== null ? "on" : ""}`} onClick={() => setOutPt(time)} title="Mark where the clip ends (])">End{outPt !== null ? ` ${clock(outPt)}` : ""}</button>
              <button className={`btn sq ${looping ? "on" : ""}`} aria-pressed={looping} aria-label="Loop A-B range" title="Loop A-B range or current moment (R)" onClick={toggleLoop}>
                <Repeat size={14} />
              </button>
              {(inPt !== null || outPt !== null) && (
                <button className="btn sq quiet" aria-label="Clear loop marks" title="Clear Start/End marks" onClick={() => { setInPt(null); setOutPt(null); setLooping(false); }}>
                  <X size={14} />
                </button>
              )}
              <select className="field-input" value={maxMb ?? ""} onChange={(e) => setMaxMb(e.target.value ? Number(e.target.value) : null)} aria-label="Export file size target" title="Target file size for exported clip">
                <option value="">Original</option>
                <option value="10">10 MB Discord</option>
                <option value="50">50 MB Nitro</option>
              </select>
              {split.length > 0 ? (
                <button
                  className="btn"
                  disabled={busy}
                  title="One video with the views that are showing, side by side on the same moment. Uses the sound that is playing now."
                  onClick={() => {
                    const views = split.filter((p) => p.source).map((p) => ({ source: p.source!, shift: p.shift, label: p.friend }));
                    const heard = listen === null ? -1 : views.findIndex((v) => v.label === listen);
                    run("Making the split-view clip…", () => api.exportSplit(match.id, clipRange[0], clipRange[1], views, audible, heard < 0 ? null : heard, "You", maxMb));
                  }}
                >
                  <Scissors size={15} aria-hidden />{marked ? `Save split clip, ${clock(clipRange[1] - clipRange[0])} long` : "Save last 30 seconds, split"}
                </button>
              ) : (
                <button className="btn" disabled={busy} onClick={() => run("Cutting the clip…", () => api.exportClip(match.id, clipRange[0], clipRange[1], audible, maxMb))} title="Uses the sound tracks that are not muted right now">
                  <Scissors size={15} aria-hidden />{marked ? `Save clip, ${clock(clipRange[1] - clipRange[0])} long` : "Save last 30 seconds"}
                </button>
              )}
              <button className={`btn sq quiet ${help ? "on" : ""}`} aria-label="Keyboard shortcuts" aria-expanded={help} title="Keyboard shortcuts" onClick={() => setHelp((h) => !h)}><Keyboard size={17} /></button>
              <button className="btn sq quiet" aria-label="Full screen" title="Full screen (F)" onClick={fullscreen}><Maximize2 size={16} /></button>
              {help && (
                <div className="help" role="dialog" aria-label="Keyboard shortcuts">
                  {SHORTCUTS.map(([keys, what]) => (
                    <div key={keys} style={{ display: "contents" }}>
                      <div>{keys.split(" ").map((k) => <kbd key={k} style={{ marginRight: 4 }}>{k}</kbd>)}</div>
                      <span>{what}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {!prefs.theater && (
          <Splitter label="Width of the side panel" onMove={(x, r) => updatePrefs({ sideWidth: Math.round(Math.min(Math.max(r.right - x, 280), 640)) })} />
        )}
        <aside className="side">
          <div className="tabs" role="tablist">
            {(["moments", "review", "notes", "players"] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                {t === "moments" ? `Moments ${listed.length}` : t === "review" ? "Review" : t === "notes" ? `Notes ${review.notes.length + teamNotes.length}` : "Players"}
              </button>
            ))}
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
              stats={match.trimmedToHighlights ? null : (match.stats ?? null)}
              players={match.game?.players ?? []}
              keys={match.trimmedToHighlights ? null : keys}
              cpm={match.trimmedToHighlights ? [] : cpm}
              duration={duration}
            />
          )}

          {tab === "moments" && (
            <div className="sidebody">
              {listed.length === 0 && (
                <p>{match.events.length === 0 ? "No game events were recorded for this one." : "Nothing matches the filters that are switched on below the timeline."}</p>
              )}
              {listed.map((m, i) => (
                <button key={i} className={`moment ${i === currentIdx ? "now" : ""}`} onClick={() => seek(m.t - (m.cat === "item" ? 2 : 6))}>
                  <span className="t">{clock(m.t)}</span>
                  <span className="pic"><MomentPicture m={m} champKey={champKey} /></span>
                  <span className="txt">{m.label}</span>
                </button>
              ))}
            </div>
          )}

          {tab === "notes" && (
            <>
              <div className="tagrow">
                <div className="tags">
                  {(review.tags ?? []).map((t) => (
                    <span className="tag" key={t}>
                      #{t}
                      <button type="button" aria-label={`Remove tag ${t}`} onClick={() => removeTag(t)}><X size={11} /></button>
                    </span>
                  ))}
                </div>
                <form className="tagadd" onSubmit={(e) => { e.preventDefault(); addTag(); }}>
                  <input
                    className="field-input"
                    type="text"
                    value={tagDraft}
                    placeholder="Add a tag (e.g. vod, macro, duo)…"
                    aria-label="New game tag"
                    onChange={(e) => setTagDraft(e.target.value)}
                    onFocus={() => videoRef.current?.pause()}
                  />
                  <button className="btn" type="submit" disabled={!tagDraft.trim()}>Tag</button>
                </form>
              </div>
              <div className="sidebody">
                {review.notes.length === 0 && teamNotes.length === 0 && <p>Pause on a moment and write what you see. Notes show on the timeline, and teammates who recorded this game see them too.</p>}
                {review.notes.map((n) => (
                  <article className="note" key={n.id}>
                    <header>
                      <button className="btn num" onClick={() => seek(n.t - 3)} title="Go to this moment">{clock(n.t)}</button>
                      <span className="grow" />
                      <button className="btn quiet danger" aria-label="Delete note" onClick={() => setReview((r) => ({ ...r, notes: r.notes.filter((x) => x.id !== n.id) }))}><X size={14} /></button>
                    </header>
                    <p>{n.text}</p>
                  </article>
                ))}
                {teamNotes.length > 0 && <h3 className="sub">From teammates</h3>}
                {teamNotes.map((n) => (
                  <article className="note theirs" key={n.code + n.id}>
                    <header>
                      <button className="btn num" onClick={() => seek(n.t - 3)} title="Go to this moment">{clock(n.t)}</button>
                      <Portrait championKey={n.championKey} name={n.champion} size={22} side="ally" />
                      <b>{n.friend}</b>
                    </header>
                    <p>{n.text}</p>
                  </article>
                ))}
              </div>
              <div className="noteadd">
                <textarea
                  value={noteText}
                  placeholder="What happened here?"
                  aria-label="New note"
                  onChange={(e) => setNoteText(e.target.value)}
                  onFocus={() => videoRef.current?.pause()}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) addNote(); }}
                />
                <button className="btn mark" disabled={!noteText.trim()} onClick={addNote} title="Ctrl + Enter">Add note at {clock(time)}</button>
              </div>
            </>
          )}

          {tab === "players" && (
            <div className="sidebody">
              {me && me.items.length > 0 && (
                <>
                  <h3 style={{ padding: "4px 6px 8px" }}>Your final build</h3>
                  <div className="finalbuild">{me.items.map((it, i) => <ItemIcon key={i} id={it.id} name={it.name} size={34} />)}</div>
                </>
              )}
              {match.game?.players?.length ? <Scoreboard players={match.game.players} titles={titles} /> : <p>No scoreboard for this recording.</p>}
            </div>
          )}
        </aside>
      </div>

      {hasTrack("discord") && <audio ref={discordRef} src={fileUrl(match.dir, "discord.m4a")} preload="auto" />}
      {hasTrack("mic") && <audio ref={micRef} src={fileUrl(match.dir, "mic.m4a")} preload="auto" />}

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.path && <button className="btn" onClick={() => showInFolder(toast.path!)}><FolderOpen size={15} aria-hidden />Show</button>}
          <button className="btn quiet sq" onClick={() => setToast(null)} aria-label="Dismiss"><X size={15} /></button>
        </div>
      )}
    </div>
  );
}
