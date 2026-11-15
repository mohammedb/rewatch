// The setup guide. It opens on a new PC (and comes back if Rewatch was closed halfway through it), and again
// from Settings. Five short steps leave Rewatch recording the right games to the right place, with the call
// and the mic on their own tracks, and the player's teammates paired by friend code.

import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Bookmark,
  Check,
  CircleX,
  Clapperboard,
  Copy,
  FolderOpen,
  Gamepad2,
  HardDrive,
  Headphones,
  Info,
  ListVideo,
  Lock,
  Mic,
  Play,
  Plus,
  Power,
  RefreshCw,
  Send,
  Swords,
  TriangleAlert,
  Users,
  Wifi,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { api, pickFolder, pickProgram } from "./api";
import { Logo } from "./icons";
import type { Environment, Friend, MicInfo, QueueToggles, Settings, ShareInfo } from "./types";
import { humanError, Select, useToast } from "./ui";

export type SetupStep = "welcome" | "pc" | "record" | "sound" | "team" | "done";

/** The step a first setup is on while it's under way, so closing Rewatch halfway through brings it back there. */
export const SETUP_KEY = "rewatch.setup";

const STEPS: { id: SetupStep; title: string }[] = [
  { id: "welcome", title: "Welcome" },
  { id: "pc", title: "This PC" },
  { id: "record", title: "Recording" },
  { id: "sound", title: "Sound" },
  { id: "team", title: "Teammates" },
  { id: "done", title: "Ready" },
];
const stepAt = (id: SetupStep) => STEPS.findIndex((s) => s.id === id);

/** Where a first setup was left when Rewatch closed, if it was. */
export function leftSetup(): SetupStep | null {
  try {
    const v = localStorage.getItem(SETUP_KEY);
    return v ? (STEPS.find((s) => s.id === v)?.id ?? "welcome") : null;
  } catch {
    return null;
  }
}

const QUEUES: [keyof QueueToggles, string][] = [
  ["rankedSolo", "Ranked Solo/Duo"],
  ["rankedFlex", "Ranked Flex"],
  ["normal", "Normal"],
  ["aram", "ARAM"],
  ["custom", "Custom and Practice Tool"],
  ["other", "Other modes"],
];
/** The same queues inside a sentence. */
const QUEUE_SHORT: Record<keyof QueueToggles, string> = {
  rankedSolo: "Ranked Solo/Duo",
  rankedFlex: "Ranked Flex",
  normal: "Normal",
  aram: "ARAM",
  custom: "Custom/Practice Tool",
  other: "other modes",
};

const LIMITS = [100, 200, 300, 500, 1000];
const GB = 1024 ** 3;
/** What a teammate added by code is called until their app says its name. */
const PLACEHOLDER = "Teammate";
const SITE = "https://rewatch.ggwp.no";

const d = (n: number) => ({ "--d": n }) as CSSProperties;
const size = (n: number) => (n >= 1000 * GB ? `${(n / (1024 * GB)).toFixed(1)} TB` : `${Math.round(n / GB)} GB`);
const limitLabel = (gb: number) => (gb === 0 ? "No limit" : gb >= 1000 && gb % 1000 === 0 ? `${gb / 1000} TB` : `${gb} GB`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const initial = (name: string) => (name.trim()[0] ?? "?").toUpperCase();
const listed = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const sameCode = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function reducedMotion(): boolean {
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** About how big a 35-minute game is at these settings: the same rough sum Settings uses for an hour. */
function gameBytes(s: Settings): number {
  const res = s.resolution === "720" ? 0.25 : s.resolution === "1080" ? 0.56 : 1;
  const perHour = 18 * Math.pow(2, (23 - s.quality) / 6) * (s.fps / 60) * (s.codec === "h264" ? 1 : 0.65) * res;
  return (perHour * GB * 35) / 60;
}

/** The friend code in something pasted: on its own, inside an invite, or copied off the screen in groups. */
export function findCode(text: string): string | null {
  const whole = text.match(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i);
  if (whole) return whole[0].toLowerCase();
  const grouped = text.match(/(?<![0-9a-f])[0-9a-f]{8}(?:[\s-]+[0-9a-f]{8}){7}(?![0-9a-f])/i);
  return grouped ? grouped[0].replace(/[\s-]+/g, "").toLowerCase() : null;
}

// ------------------------------------------------------------------ the connection to a teammate

type LinkState = "checking" | "ok" | "waiting" | "offline" | "off" | "bad" | "error";

interface Link {
  state: LinkState;
  /** A check is on its way. */
  busy: boolean;
  /** When the last check came back. */
  at: number;
  text?: string;
}

/** How long to wait before asking a teammate again, by how the last check went. */
const RECHECK: Partial<Record<LinkState, number>> = { waiting: 4000, offline: 15000, error: 20000 };

/** What a failed check means, from the words the app answers with (Engine::ping in pov.rs). */
function linkFrom(e: unknown): Pick<Link, "state" | "text"> {
  const raw = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  if (/not on their teammates list/i.test(raw)) return { state: "waiting" };
  if (/switched sharing off/i.test(raw)) return { state: "off" };
  if (/could not reach/i.test(raw)) return { state: "offline" };
  if (/friend code|own code/i.test(raw)) return { state: "bad", text: humanError(raw) };
  return { state: "error", text: humanError(raw) };
}

const LINK_TEXT: Record<LinkState, string> = {
  checking: "Checking the connection…",
  ok: "Connected. You can watch each other's games.",
  waiting: "Waiting for them to add you back. You show up in their Rewatch as a request.",
  offline: "Can't reach them right now. Rewatch has to be running on their PC.",
  off: "Reached them, but they've switched sharing off.",
  bad: "That code doesn't work.",
  error: "Something went wrong.",
};

// ------------------------------------------------------------------ small moving parts

/** A code shown as if it were being decoded, settling left to right. Returns the text and how much has settled. */
function useScramble(text: string): [string, number] {
  const [state, setState] = useState<[string, number]>(() => (reducedMotion() ? [text, text.length] : ["", 0]));
  useEffect(() => {
    if (!text) return;
    if (reducedMotion()) {
      setState([text, text.length]);
      return;
    }
    const HEX = "0123456789abcdef";
    const t0 = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const t = now - t0;
      const settled = Math.max(0, Math.min(text.length, Math.floor((t - 220) / 12)));
      let s = text.slice(0, settled);
      for (let i = settled; i < text.length; i++) s += t > i * 7 ? HEX[(Math.random() * 16) | 0] : "·";
      setState([s, settled]);
      if (settled < text.length) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [text]);
  return state;
}

/** A number that runs up to its new value instead of jumping there. */
function useCountUp(value: number, ms = 900): number {
  const [shown, setShown] = useState(0);
  const now = useRef(0);
  useEffect(() => {
    if (reducedMotion()) {
      now.current = value;
      setShown(value);
      return;
    }
    const from = now.current;
    const t0 = performance.now();
    let raf = 0;
    const frame = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      now.current = from + (value - from) * (1 - Math.pow(1 - k, 3));
      setShown(now.current);
      if (k < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

/** A tick in a ring, drawing itself. */
function Tick({ size: px = 20 }: { size?: number }) {
  return (
    <svg className="ob-tick" width={px} height={px} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10.5" pathLength={1} />
      <path d="M7.5 12.4l3.1 3.1 6-6.6" pathLength={1} />
    </svg>
  );
}

function Spinner() {
  return <span className="ob-spin" aria-hidden="true" />;
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />;
}

/** The Rewatch mark drawing itself: the ring, then the stem, then the leg. */
function DrawnMark({ size: px }: { size: number }) {
  return (
    <svg className="ob-logo" width={px * 0.79} height={px} viewBox="257 189 510 646" aria-hidden="true">
      <circle className="ring" cx="489" cy="421" r="186" fill="none" stroke="currentColor" strokeWidth="92" pathLength={1} transform="rotate(-90 489 421)" />
      <rect className="stem" x="257" y="421" width="92" height="414" fill="currentColor" />
      <polygon className="leg" points="472,609 595,609 767,835 644,835" fill="currentColor" />
    </svg>
  );
}

function CopyButton({ text, label, icon: Icon = Copy, primary, onCopied }: { text: string; label: string; icon?: LucideIcon; primary?: boolean; onCopied?: () => void }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = window.setTimeout(() => setDone(false), 1800);
    return () => window.clearTimeout(id);
  }, [done]);
  return (
    <button
      className={`btn ${primary ? "primary" : ""} ob-copy ${done ? "done" : ""}`}
      disabled={!text}
      onClick={() =>
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true);
            onCopied?.();
          })
          .catch(() => toast.show({ kind: "error", text: "Couldn't copy that", detail: "Select the code and copy it by hand." }))
      }
    >
      <span className="ob-copy-ic" key={done ? "done" : "copy"}>
        {done ? <Check size={15} strokeWidth={2.6} aria-hidden /> : <Icon size={15} aria-hidden />}
      </span>
      {done ? "Copied" : label}
    </button>
  );
}

/** This PC's friend code in eight groups. The first group is what a teammate checks when you ask to connect. */
function CodeBlock({ code }: { code: string }) {
  const [text, settled] = useScramble(code);
  if (!code) {
    return (
      <div className="ob-codeblock wait">
        <Spinner />
        <span className="muted">Getting your code…</span>
      </div>
    );
  }
  return (
    <div className="ob-codeblock">
      <span className="sr-only">{code}</span>
      {Array.from({ length: 8 }, (_, g) => {
        const from = g * 8;
        const cut = Math.min(from + 8, Math.max(from, settled));
        return (
          <span key={g} className="g" aria-hidden="true">
            {text.slice(from, cut)}
            <span className="scr">{text.slice(cut, from + 8)}</span>
          </span>
        );
      })}
    </div>
  );
}

/** You, a line, and them: how the connection to a teammate stands. */
function LinkLine({ me, them, state }: { me: string; them: string; state: LinkState | "idle" }) {
  return (
    <span className="ob-link" data-state={state} aria-hidden="true">
      <span className="ob-node me">{initial(me)}</span>
      <span className="ob-wire">
        <i />
      </span>
      <span className="ob-node them">
        {them === "?" ? "?" : initial(them)}
        {state === "ok" && (
          <span className="badge">
            <Check size={9} strokeWidth={4} />
          </span>
        )}
      </span>
    </span>
  );
}

const BARS = 22;

/** Loudness as bars, quiet on the left. Takes the peak level Windows reports, 0 to 1. */
function Meter({ level }: { level: number }) {
  // Speech peaks around -30 to -10 dB; the bars cover -54 to 0.
  const db = 20 * Math.log10(Math.max(level, 1e-5));
  const lit = Math.round(Math.max(0, Math.min(1, (db + 54) / 54)) * BARS);
  return (
    <span className="ob-meter" aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => (
        <i key={i} className={i < lit ? (i >= BARS - 3 ? "on hot" : "on") : ""} style={{ "--k": i / (BARS - 1) } as CSSProperties} />
      ))}
    </span>
  );
}

/** Opens the microphone for a few seconds and shows how loud it is, to be sure it's the one you talk into. */
function MicTest({ device }: { device: string }) {
  const [on, setOn] = useState(false);
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(false);
  const [quiet, setQuiet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!on) return;
    let alive = true;
    let timer = 0;
    const started = Date.now();
    const tick = () =>
      api.micLevel(device).then(
        (v) => {
          if (!alive) return;
          setLevel(v);
          // About -30 dB: a word, not the hiss of a quiet room.
          if (v > 0.03) setHeard(true);
          const t = Date.now() - started;
          if (t > 5000) setQuiet(true);
          if (t > 15000) return setOn(false);
          timer = window.setTimeout(tick, 60);
        },
        (e) => {
          if (!alive) return;
          setError(humanError(e));
          setOn(false);
        },
      );
    tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      setLevel(0);
      api.micCheckStop().catch(() => {});
    };
  }, [on, device]);
  const start = () => {
    setHeard(false);
    setQuiet(false);
    setError(null);
    setOn(true);
  };
  return (
    <div className={`ob-mictest ${on ? "on" : ""}`}>
      <Meter level={on ? level : 0} />
      <span className={`ob-mic-note ${error ? "bad" : heard ? "ok" : ""}`} role="status">
        {error ? (
          error
        ) : heard ? (
          <>
            <Tick size={16} />
            {on ? "Rewatch hears you." : "Rewatch heard you."}
          </>
        ) : on ? (
          quiet ? "Nothing yet. Is it muted, or is it another microphone?" : "Say something…"
        ) : (
          "Check that this is the one you talk into."
        )}
      </span>
      <button className="btn sm" onClick={() => (on ? setOn(false) : start())}>
        {on ? "Stop" : heard ? "Test again" : "Test"}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ steps

interface Ctx {
  /** The settings as the guide has them; saved when moving between steps, and right away where it matters. */
  s: Settings;
  change: (patch: Partial<Settings>) => void;
  persist: () => Promise<boolean>;
  env: Environment | null;
  envError: string | null;
  /** Ask what this PC has again, and show the check running. */
  recheck: () => void;
  /** Goes up on every check of this PC, so its results come in again. */
  scan: number;
  share: ShareInfo | null;
  head: RefObject<HTMLHeadingElement | null>;
}

function Head({ ctx, n, title, children }: { ctx: Ctx; n?: number; title: ReactNode; children?: ReactNode }) {
  return (
    <header className="ob-head">
      {n != null && (
        <span className="ob-eyebrow ob-rise" style={d(0)}>
          Step {n} of 4
        </span>
      )}
      <h1 ref={ctx.head} tabIndex={-1} className="ob-rise" style={d(1)}>
        {title}
      </h1>
      {children && (
        <p className="ob-lede ob-rise" style={d(2)}>
          {children}
        </p>
      )}
    </header>
  );
}

const TILES: { icon: LucideIcon; tone: string; title: string; text: string }[] = [
  { icon: Clapperboard, tone: "rec", title: "Every game, by itself", text: "Recording starts and stops with League. Nothing to press." },
  { icon: AudioLines, tone: "", title: "Comms on their own tracks", text: "Turn the call down while you share a review in Discord." },
  { icon: Users, tone: "team", title: "Your teammates' view", text: "Swap friend codes, then switch to their screen in games you played together." },
];

function Welcome({ firstRun, onStart }: { firstRun: boolean; onStart: () => void }) {
  return (
    <div className="ob-welcome">
      <div className="ob-mark">
        <DrawnMark size={96} />
      </div>
      <h1 className="ob-rise" style={d(4)}>
        {firstRun ? "Welcome to Rewatch" : "Set up Rewatch"}
      </h1>
      <p className="ob-lede ob-rise" style={d(5)}>
        Rewatch records your League games by itself, with your Discord call and your mic on their own tracks. Afterwards you can watch back what happened, on your own or with
        your team.
      </p>
      <ul className="ob-tiles">
        {TILES.map((t, i) => (
          <li key={t.title} className="ob-tile ob-rise" style={d(6 + i)}>
            <span className={`ic ${t.tone}`}>
              <t.icon size={18} aria-hidden />
            </span>
            <b>{t.title}</b>
            <small>{t.text}</small>
          </li>
        ))}
      </ul>
      <button className="btn primary ob-cta ob-rise" style={d(10)} onClick={onStart} autoFocus>
        {firstRun ? "Set up Rewatch" : "Start"}
        <ArrowRight size={16} aria-hidden />
      </button>
      <p className="ob-fine ob-rise" style={d(11)}>
        Takes about two minutes. You can change all of it later in Settings.
      </p>
    </div>
  );
}

type Level = "ok" | "warn" | "bad";

interface CheckRow {
  key: string;
  icon: LucideIcon;
  title: string;
  /** Null while it's still being looked at. */
  level: Level | null;
  detail: ReactNode;
  action?: { label: string; run: () => void };
}

function PcStep({ ctx }: { ctx: Ctx }) {
  const { env, envError, share, s } = ctx;
  // The answers come in one at a time, so the check reads as a check even when they are instant.
  const [shown, setShown] = useState(0);
  const ready = !!env || !!envError;
  useEffect(() => {
    if (!ready) return;
    if (reducedMotion()) {
      setShown(9);
      return;
    }
    setShown(0);
    const ids = [0, 1, 2, 3].map((i) => window.setTimeout(() => setShown(i + 1), 300 + i * 320));
    return () => ids.forEach((id) => window.clearTimeout(id));
  }, [ready, ctx.scan]);
  // Going online takes a moment; only after a while is it worth a word.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setSlow(true), 10000);
    return () => window.clearTimeout(id);
  }, []);

  const chooseLeague = async () => {
    const p = await pickFolder(s.leagueDir || "C:\\Riot Games\\League of Legends");
    if (!p) return;
    ctx.change({ leagueDir: p });
    if (await ctx.persist()) ctx.recheck();
  };
  const chooseFfmpeg = async () => {
    const p = await pickProgram("FFmpeg", s.ffmpegPath);
    if (!p) return;
    ctx.change({ ffmpegPath: p });
    if (await ctx.persist()) ctx.recheck();
  };

  const free = env?.freeBytes ?? null;
  const games = free != null ? Math.floor(free / gameBytes(s)) : null;
  const drive = (s.recordingsDir || env?.suggestedRecordingsDir || "").match(/^[a-z]:/i)?.[0].toUpperCase();
  const version = env?.ffmpegVersion?.replace(/^ffmpeg version\s*/i, "").split(/[\s-]/)[0];
  const rows: CheckRow[] = [
    {
      key: "league",
      icon: Gamepad2,
      title: "League of Legends",
      level: envError ? "warn" : !env ? null : env.leagueDir ? "ok" : "warn",
      detail: env?.leagueDir ? <span className="path">{env.leagueDir}</span> : envError ? envError : "Not found. Rewatch needs to know where it is to see a game start.",
      action: env && !env.leagueDir ? { label: "Choose its folder", run: chooseLeague } : undefined,
    },
    {
      key: "ffmpeg",
      icon: Clapperboard,
      title: "Recorder",
      level: envError ? "warn" : !env ? null : env.ffmpegVersion ? "ok" : "bad",
      detail: env?.ffmpegVersion ? `FFmpeg ${version}, recording on your graphics card so the game keeps its frames` : "FFmpeg is missing, so nothing can be recorded. Reinstall Rewatch, or show it where ffmpeg.exe is.",
      action: env && !env.ffmpegVersion ? { label: "Choose ffmpeg.exe", run: chooseFfmpeg } : undefined,
    },
    {
      key: "disk",
      icon: HardDrive,
      title: "Space for recordings",
      level: !ready ? null : free == null ? "warn" : free < 20 * GB ? "bad" : free < 60 * GB ? "warn" : "ok",
      detail:
        free == null
          ? "Couldn't tell how much space is free."
          : `${size(free)} free${drive ? ` on ${drive}` : ""}, room for about ${plural(games ?? 0, "game")}.${free < 60 * GB ? " Pick a bigger drive in the next step if you have one." : ""}`,
    },
    {
      key: "net",
      icon: Wifi,
      title: "Connection for teammates",
      level: share?.error ? "warn" : share?.online ? "ok" : share && !share.running ? "ok" : slow ? "warn" : null,
      detail: share?.error
        ? share.error
        : share?.online
          ? "Online. Teammates you add can reach this PC."
          : share && !share.running
            ? "Starts when you add a teammate."
            : slow
              ? "Not online yet. Teammates can't reach this PC until it is, so check the internet connection."
              : "Connecting…",
    },
  ];
  const settledRows = rows.map((r, i) => ({ ...r, level: i < shown ? r.level : null }));
  const problems = settledRows.filter((r) => r.level === "bad" || r.level === "warn").length;
  const allIn = settledRows.every((r) => r.level !== null);

  return (
    <>
      <Head ctx={ctx} n={1} title="Checking this PC">
        Rewatch watches for League starting, and records with your graphics card so the game doesn't slow down.
      </Head>
      <ul className="ob-card ob-checks ob-rise" style={d(3)}>
        {settledRows.map((r) => (
          <li key={`${r.key}-${ctx.scan}`} className={`ob-check ${r.level ?? "wait"}`}>
            <span className="ic">
              <r.icon size={17} aria-hidden />
            </span>
            <span className="tx">
              <b>{r.title}</b>
              <small>{r.level === null ? "Looking…" : r.detail}</small>
            </span>
            <span className="st">
              {r.level === null ? (
                <Spinner />
              ) : (
                <>
                  {r.action && (
                    <button className="btn sm" onClick={r.action.run}>
                      <FolderOpen size={14} aria-hidden />
                      {r.action.label}
                    </button>
                  )}
                  {r.level === "ok" ? (
                    <Tick />
                  ) : r.level === "warn" ? (
                    <TriangleAlert className="ob-pop warn" size={19} aria-label="Needs a look" />
                  ) : (
                    <CircleX className="ob-pop bad" size={19} aria-label="Not working" />
                  )}
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="ob-after ob-rise" style={d(4)}>
        <p className="ob-fine" role="status">
          {!allIn ? "" : problems ? `${plural(problems, "thing")} to look at. You can carry on and fix ${problems === 1 ? "it" : "them"} later in Settings.` : "Everything Rewatch needs is here."}
        </p>
        <button className="btn sm quiet" onClick={ctx.recheck} disabled={!allIn}>
          <RefreshCw size={13} aria-hidden />
          Check again
        </button>
      </div>
    </>
  );
}

function RecordStep({ ctx }: { ctx: Ctx }) {
  const { s, change } = ctx;
  const dir = s.recordingsDir;
  const [free, setFree] = useState<number | null>(null);
  useEffect(() => {
    const path = dir.trim();
    if (!path) return setFree(null);
    let alive = true;
    const id = window.setTimeout(() => {
      api
        .diskFree(path)
        .then((n) => alive && setFree(n ?? null))
        .catch(() => alive && setFree(null));
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [dir]);
  const shownFree = useCountUp(free ?? 0);
  const per = gameBytes(s);
  const drive = dir.match(/^[a-z]:/i)?.[0].toUpperCase();
  const limit = s.quotaGb * GB;
  const over = s.quotaGb > 0 && free != null && limit > free;
  const fill = free == null || free <= 0 ? 0 : s.quotaGb === 0 || over ? 100 : Math.max(3, (limit / free) * 100);
  const options = [...new Set([...LIMITS, ...(s.quotaGb > 0 ? [s.quotaGb] : [])])].sort((a, b) => a - b).concat(0);
  const clientOff = !s.useClientApi;

  return (
    <>
      <Head ctx={ctx} n={2} title="Where recordings go">
        Every game gets a folder of its own, with the video, its sound tracks and its stats.
      </Head>
      <section className="ob-card ob-rise" style={d(3)}>
        <div className="ob-folder">
          <FolderOpen size={17} aria-hidden />
          <input
            className="ob-folder-in"
            value={dir}
            spellCheck={false}
            placeholder="Choose a folder"
            aria-label="Recordings folder"
            onChange={(e) => change({ recordingsDir: e.target.value })}
          />
          <button
            className="btn"
            onClick={async () => {
              const p = await pickFolder(dir);
              if (p) change({ recordingsDir: p });
            }}
          >
            Browse
          </button>
        </div>
        <div className="ob-drive">
          <div className="ob-drive-top">
            <span className="big">{free == null ? "–" : size(shownFree)}</span>
            <span className="soft">
              free{drive ? ` on ${drive}` : ""}
              {free != null && `, room for about ${plural(Math.floor(free / per), "game")}`}
            </span>
          </div>
          <div className={`ob-bar ${s.quotaGb === 0 ? "nolimit" : over ? "over" : ""}`} aria-hidden="true">
            <i style={{ "--w": `${fill}%` } as CSSProperties} />
          </div>
          <div className="ob-limits">
            <span className="soft">Keep up to</span>
            <div className="seg" role="group" aria-label="Size limit">
              {options.map((gb) => (
                <button key={gb} aria-pressed={s.quotaGb === gb} onClick={() => change({ quotaGb: gb })}>
                  {limitLabel(gb)}
                </button>
              ))}
            </div>
          </div>
          <p className={`ob-fine ${over ? "warn" : ""}`}>
            {s.quotaGb === 0
              ? "No limit: Rewatch keeps everything, until the drive is full."
              : over
                ? `That's more than the ${size(free ?? 0)} free, so the drive could fill up first. A smaller limit is safer.`
                : `About ${plural(Math.max(1, Math.floor(limit / per)), "game")}. Past that, the videos of your oldest games are deleted first. Their stats stay, and games you keep are never touched.`}
          </p>
        </div>
      </section>
      <section className="ob-card ob-rise" style={d(4)}>
        <div className="ob-row">
          <span className="ic">
            <Power size={17} aria-hidden />
          </span>
          <span className="tx">
            <b>Start with Windows</b>
            <small>Rewatch waits in the tray, so every game is recorded even when you forget to open it.</small>
          </span>
          <Switch label="Start with Windows" checked={s.startWithWindows} onChange={(v) => change({ startWithWindows: v })} />
        </div>
        <div className="ob-row top">
          <span className="ic">
            <ListVideo size={17} aria-hidden />
          </span>
          <span className="tx">
            <b>Which games</b>
            <small>{clientOff ? "Every game is recorded while Ask the League client is off in Settings." : "Rewatch asks the League client which queue a game is in. It only ever reads."}</small>
            <span className="qchips" role="group" aria-label="Queues to record">
              {QUEUES.map(([key, label]) => {
                const on = clientOff || s.queues[key];
                return (
                  <button key={key} className="qchip" disabled={clientOff} aria-pressed={on} onClick={() => change({ queues: { ...s.queues, [key]: !s.queues[key] } })}>
                    {on && <Check size={13} strokeWidth={2.5} aria-hidden />}
                    {label}
                  </button>
                );
              })}
            </span>
          </span>
        </div>
      </section>
    </>
  );
}

function SoundStep({ ctx }: { ctx: Ctx }) {
  const { s, change } = ctx;
  const [mics, setMics] = useState<MicInfo[] | null>(null);
  const [discord, setDiscord] = useState<boolean | null>(null);
  useEffect(() => {
    api.listMicrophones().then(setMics, () => setMics([]));
    const load = () => api.getStatus().then((st) => setDiscord(st.discordRunning), () => {});
    load();
    const iv = window.setInterval(load, 3000);
    return () => window.clearInterval(iv);
  }, []);
  const options = [
    { value: "", label: "Windows default" },
    ...(mics ?? []).map((m) => ({ value: m.id, label: m.name, hint: m.isDefault ? "Default" : m.isDefaultComms ? "Default for calls" : undefined })),
  ];
  if (s.micDevice && mics && !mics.some((m) => m.id === s.micDevice)) options.push({ value: s.micDevice, label: "Not connected", hint: undefined });

  return (
    <>
      <Head ctx={ctx} n={3} title="Your call and your mic">
        Game sound, your Discord call and your microphone are kept as three tracks, so you can turn any of them down while you review.
      </Head>
      <section className="ob-card ob-rise" style={d(3)}>
        <div className="ob-row">
          <span className="ic">
            <Headphones size={17} aria-hidden />
          </span>
          <span className="tx">
            <b>Record your Discord call</b>
            <small>Your teammates' voices, on their own track. Mute it while you share a review in a call.</small>
          </span>
          {discord != null && (
            <span className={`ob-pill ${discord ? "on" : ""}`} title={discord ? undefined : "Its track is picked up as soon as Discord opens."}>
              <i />
              {discord ? "Discord is open" : "Discord isn't open"}
            </span>
          )}
          <Switch label="Record your Discord call" checked={s.recordDiscord} onChange={(v) => change({ recordDiscord: v })} />
        </div>
        <div className="ob-row">
          <span className="ic">
            <Mic size={17} aria-hidden />
          </span>
          <span className="tx">
            <b>Record your microphone</b>
            <small>All game long, even while you're muted in Discord.</small>
          </span>
          <Switch label="Record your microphone" checked={s.recordMic} onChange={(v) => change({ recordMic: v })} />
        </div>
        {s.recordMic && (
          <div className="ob-row sub">
            <span className="ic blank" />
            <div className="ob-micpick">
              <Select label="Microphone" value={s.micDevice} onChange={(v) => change({ micDevice: v })} options={options} className="ob-micsel" />
              <MicTest device={s.micDevice} />
            </div>
          </div>
        )}
      </section>
      <aside className="ob-note ob-rise" style={d(4)}>
        <Info size={16} aria-hidden />
        <p>
          <b>Tell the people you play with.</b> The Discord track has their voices on it, so let them know your calls are recorded.
        </p>
      </aside>
    </>
  );
}

function MateRow({ f, link, me, onRename, onRemove, onRetry }: { f: Friend; link?: Link; me: string; onRename: (name: string) => void; onRemove: () => void; onRetry: () => void }) {
  const [name, setName] = useState(f.name);
  // Their app's own name can arrive while the row is open.
  useEffect(() => setName(f.name), [f.name]);
  const state = link?.state ?? "checking";
  const text = (state === "bad" || state === "error") && link?.text ? link.text : LINK_TEXT[state];
  return (
    <li className={`ob-mate ${state}`}>
      <LinkLine me={me} them={name || PLACEHOLDER} state={state} />
      <span className="who">
        <input
          className="nm"
          value={name}
          maxLength={40}
          spellCheck={false}
          aria-label="Teammate's name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const next = name.trim() || PLACEHOLDER;
            setName(next);
            if (next !== f.name) onRename(next);
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <small role="status">
          {link?.busy && state !== "checking" && <Spinner />}
          {text}
        </small>
      </span>
      <code title={f.code}>{f.code.slice(0, 8)}</code>
      <span className="acts">
        {(state === "offline" || state === "error" || state === "off") && !link?.busy && (
          <button className="btn sm" onClick={onRetry}>
            <RefreshCw size={13} aria-hidden />
            Try again
          </button>
        )}
        <button className="btn sm sq quiet danger" aria-label={`Remove ${f.name || PLACEHOLDER}`} title="Remove" onClick={onRemove}>
          <X size={15} />
        </button>
      </span>
    </li>
  );
}

function TeamStep({
  ctx,
  links,
  suggested,
  onAdd,
  onRemove,
  onRename,
  onRetry,
}: {
  ctx: Ctx;
  links: Record<string, Link>;
  suggested: string | null;
  onAdd: (code: string, name: string) => void;
  onRemove: (code: string) => void;
  onRename: (code: string, name: string) => void;
  onRetry: (code: string) => void;
}) {
  const { s, change, persist, share } = ctx;
  const code = share?.code ?? "";
  const [paste, setPaste] = useState("");
  const [shake, setShake] = useState(0);
  const [sent, setSent] = useState(false);
  const me = s.shareName.trim() || "You";

  const found = findCode(paste);
  const mine = !!found && !!code && sameCode(found, code);
  const known = found ? s.friends.find((f) => sameCode(f.code, found)) : undefined;
  const hint: { bad: boolean; text: string } | null = !paste.trim()
    ? null
    : !found
      ? { bad: true, text: "That isn't a whole friend code. Ask them to copy it again: it's 64 letters and numbers." }
      : mine
        ? { bad: true, text: "That's your own code. Paste a teammate's." }
        : known
          ? { bad: true, text: `${known.name || PLACEHOLDER} is on your list already.` }
          : { bad: false, text: "That's a friend code. Add them to check the connection." };
  const usable = (c: string | null): c is string => !!c && !(code && sameCode(c, code)) && !s.friends.some((f) => sameCode(f.code, c));
  const add = () => {
    if (!usable(found)) return setShake((n) => n + 1);
    onAdd(found, "");
    setPaste("");
  };

  const requests = (share?.requests ?? []).filter((r) => !s.friends.some((f) => sameCode(f.code, r.code)));
  const connected = s.friends.filter((f) => links[f.code]?.state === "ok").length;
  const invite = code
    ? `Add me as a teammate in Rewatch, so we can watch each other's view of the games we play together.\n\nMy friend code: ${code}\n\nGet Rewatch at ${SITE}, then paste the code under Teammates.`
    : "";
  const how = [
    { done: sent || s.friends.length > 0, title: "Send them your code", text: "Copy the invite and send it in Discord." },
    { done: s.friends.length > 0, title: "Add theirs", text: "Paste their code here, or accept their request." },
    { done: connected > 0, title: "Connected", text: "Each of you can watch the other's view." },
  ];

  return (
    <>
      <Head ctx={ctx} n={4} title="Watch your teammates' view">
        Swap friend codes with the people you play with. In games you both recorded, you can switch to their screen, watch together and see their notes.
      </Head>

      <section className="ob-card ob-you ob-rise" style={d(3)}>
        <div className="ob-you-id">
          <span className="ob-avatar" key={initial(me)}>
            {initial(me)}
          </span>
          <label className="ob-namefield">
            <span>Your name</span>
            <input
              value={s.shareName}
              maxLength={40}
              spellCheck={false}
              placeholder="What teammates see"
              onChange={(e) => change({ shareName: e.target.value })}
              onBlur={() => {
                change({ shareName: s.shareName.trim() });
                void persist();
              }}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
          </label>
          {suggested && s.shareName.trim() === suggested && <span className="ob-tag">From League</span>}
          <span className={`ob-pill ${share?.online ? "on" : ""}`} title={share?.error ?? undefined}>
            <i />
            {share?.error ? "Can't connect" : share?.online ? "Online" : "Connecting"}
          </span>
        </div>
        <div className="ob-code">
          <span className="ob-label">Your friend code</span>
          <CodeBlock code={code} />
          <div className="ob-code-acts">
            <CopyButton text={invite} label="Copy invite for Discord" icon={Send} primary onCopied={() => setSent(true)} />
            <CopyButton text={code} label="Copy code" onCopied={() => setSent(true)} />
          </div>
          {code && (
            <p className="ob-fine">
              When you ask to connect, a teammate sees your name and the start of your code, <b className="mono">{code.slice(0, 8)}</b>.
            </p>
          )}
        </div>
      </section>

      <section className="ob-pair ob-rise" style={d(4)}>
        <ol className="ob-how">
          {how.map((h, i) => (
            <li key={h.title} className={h.done ? "done" : ""}>
              <span className="n">{h.done ? <Check size={13} strokeWidth={3} aria-label="Done" /> : i + 1}</span>
              <b>{h.title}</b>
              <small>{h.text}</small>
            </li>
          ))}
        </ol>

        <form
          className={`ob-paste ${hint ? (hint.bad ? "invalid" : "valid") : ""}`}
          key={shake}
          data-shake={shake > 0 || undefined}
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Plus size={16} aria-hidden />
          <input
            value={paste}
            spellCheck={false}
            placeholder="Paste a teammate's friend code, or their whole invite"
            aria-label="A teammate's friend code"
            autoFocus={shake > 0}
            onChange={(e) => setPaste(e.target.value)}
            onPaste={(e) => {
              // A whole code goes straight in; anything else stays in the box to be fixed.
              const c = findCode(e.clipboardData.getData("text"));
              if (!usable(c)) return;
              e.preventDefault();
              onAdd(c, "");
              setPaste("");
            }}
          />
          <button className={`btn ${hint && !hint.bad ? "primary" : ""}`} type="submit" disabled={!paste.trim()}>
            Add
          </button>
        </form>
        {hint && (
          <p className={`ob-hint ${hint.bad ? "bad" : "ok"}`} role="status">
            {hint.text}
          </p>
        )}

        {requests.length > 0 || s.friends.length > 0 ? (
          <ul className="ob-mates">
            {requests.map((r) => (
              <li key={`ask-${r.code}`} className="ob-req">
                <span className="ob-node them">{initial(r.name || "?")}</span>
                <span className="who">
                  <b>{r.name || "Someone"} wants to connect</b>
                  <small>
                    Their code starts <b className="mono">{r.code.slice(0, 8)}</b>. Only add people you know.
                  </small>
                </span>
                <button className="btn primary sm" onClick={() => onAdd(r.code, r.name)}>
                  <Plus size={14} aria-hidden />
                  Add {r.name || "them"}
                </button>
              </li>
            ))}
            {s.friends.map((f) => (
              <MateRow
                key={f.code}
                f={f}
                link={links[f.code]}
                me={me}
                onRename={(name) => onRename(f.code, name)}
                onRemove={() => onRemove(f.code)}
                onRetry={() => onRetry(f.code)}
              />
            ))}
          </ul>
        ) : (
          <div className="ob-empty">
            <LinkLine me={me} them="?" state="idle" />
            <p>No teammates yet. Paste a code above, or send yours and their request shows up here.</p>
          </div>
        )}
      </section>

      <section className="ob-card ob-rise" style={d(5)}>
        <div className="ob-row">
          <span className="ic">
            <Lock size={17} aria-hidden />
          </span>
          <span className="tx">
            <b>Let teammates watch my games</b>
            <small>The video with game sound and your cursor. Never your Discord call or your mic.</small>
          </span>
          <Switch label="Let teammates watch my games" checked={s.shareWithFriends} onChange={(v) => change({ shareWithFriends: v })} />
        </div>
      </section>
    </>
  );
}

/** Bits that fly out of the tick at the end: green, the colour of done, with a little white. */
const BURST = Array.from({ length: 18 }, (_, i) => {
  const a = (i / 18) * Math.PI * 2 + (i % 2 ? 0.17 : -0.09);
  const r = 74 + (i % 3) * 20;
  return {
    x: Math.round(Math.cos(a) * r),
    y: Math.round(Math.sin(a) * r),
    c: i % 3 === 0 ? "var(--text)" : "var(--up)",
    t: (i % 5) * 35,
    r: (i * 67) % 360,
  };
});

function DoneStep({ ctx, links, firstRun }: { ctx: Ctx; links: Record<string, Link>; firstRun: boolean }) {
  const { s } = ctx;
  const on = QUEUES.filter(([k]) => s.queues[k]).map(([k]) => QUEUE_SHORT[k]);
  const off = QUEUES.filter(([k]) => !s.queues[k]).map(([k]) => QUEUE_SHORT[k]);
  const games = !s.useClientApi || off.length === 0 ? "Every League game" : off.length <= 2 ? `Every game but ${listed(off)}` : `${listed(on)} games`;
  const connected = s.friends.filter((f) => links[f.code]?.state === "ok");
  const key = s.bookmarkHotkey.trim();
  const items: { ok: boolean; icon: LucideIcon; title: string; detail: ReactNode }[] = [
    {
      ok: on.length > 0 || !s.useClientApi,
      icon: Clapperboard,
      title: on.length > 0 || !s.useClientApi ? `${games}, recorded by itself` : "No queues are on, so nothing is recorded",
      detail: (
        <>
          To <span className="path">{s.recordingsDir || "your Videos folder"}</span>
          {s.quotaGb ? `, keeping up to ${limitLabel(s.quotaGb)}.` : ", with no size limit."}
        </>
      ),
    },
    {
      ok: s.recordDiscord || s.recordMic,
      icon: AudioLines,
      title: s.recordDiscord && s.recordMic ? "Your call and your mic, on their own tracks" : s.recordDiscord ? "Your Discord call, on its own track" : s.recordMic ? "Your mic, on its own track" : "Game sound only",
      detail: s.recordDiscord || s.recordMic ? "Turn either down while you review." : "Discord and your mic can be switched on in Settings.",
    },
    {
      ok: connected.length > 0,
      icon: Users,
      title: connected.length
        ? `Connected to ${listed(connected.map((f) => f.name || PLACEHOLDER))}`
        : s.friends.length
          ? `${plural(s.friends.length, "teammate")} added, not connected yet`
          : "No teammates yet",
      detail: connected.length
        ? "In games you both recorded, their view is one click away."
        : s.friends.length
          ? "It connects once they add you back, with Rewatch open on their PC."
          : "Add them any time in Settings, under Teammates.",
    },
    {
      ok: s.startWithWindows,
      icon: Power,
      title: s.startWithWindows ? "Starts with Windows" : "Open Rewatch before you play",
      detail: s.startWithWindows ? "Closing the window keeps it running in the tray." : "It only records while it's running. Closing the window keeps it in the tray.",
    },
  ];
  const tips: { icon: LucideIcon; title: string; text: string }[] = [
    { icon: Play, title: "Play", text: "Recording starts as the game loads, and the dot at the top of Rewatch turns red." },
    { icon: Bookmark, title: "Mark", text: key ? `Press ${key} in game to bookmark a moment to look at later.` : "Set a bookmark key in Settings to mark moments in game." },
    { icon: Swords, title: "Review", text: "Afterwards every kill, death and objective is on the timeline, and your deaths are one click away." },
  ];
  return (
    <div className="ob-done">
      <div className="ob-done-mark" aria-hidden="true">
        <span className="ripple" />
        <span className="ripple" style={{ animationDelay: "160ms" }} />
        <span className="ripple" style={{ animationDelay: "320ms" }} />
        <span className="ob-burst">
          {BURST.map((b, i) => (
            <i key={i} style={{ "--x": `${b.x}px`, "--y": `${b.y}px`, "--c": b.c, "--t": `${b.t}ms`, "--r": `${b.r}deg` } as CSSProperties} />
          ))}
        </span>
        <Tick size={70} />
      </div>
      <h1 ref={ctx.head} tabIndex={-1} className="ob-rise" style={d(2)}>
        {firstRun ? "You're set" : "All set"}
      </h1>
      <p className="ob-lede ob-rise" style={d(3)}>
        Start a League game and Rewatch records it by itself.
      </p>
      <ul className="ob-card ob-sum">
        {items.map((it, i) => (
          <li key={it.title} className={`ob-rise ${it.ok ? "ok" : "todo"}`} style={d(4 + i)}>
            <span className="ic">
              <it.icon size={17} aria-hidden />
            </span>
            <span className="tx">
              <b>{it.title}</b>
              <small>{it.detail}</small>
            </span>
            {it.ok ? <Tick size={19} /> : <span className="ob-dash" aria-label="Not yet" />}
          </li>
        ))}
      </ul>
      <ol className="ob-tips">
        {tips.map((t, i) => (
          <li key={t.title} className="ob-rise" style={d(8 + i)}>
            <span className="ic">
              <t.icon size={16} aria-hidden />
            </span>
            <b>{t.title}</b>
            <small>{t.text}</small>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ------------------------------------------------------------------ the guide

export function Onboarding({
  settings,
  firstRun,
  start,
  onSave,
  onClose,
}: {
  settings: Settings;
  /** A new PC: the guide can only be left with a recordings folder chosen. */
  firstRun: boolean;
  start?: SetupStep;
  onSave: (s: Settings) => Promise<void>;
  onClose: () => void;
}) {
  const toast = useToast();
  // The guide's copy is the one being edited. What comes back from a save is not copied back in, so typing
  // is never disturbed.
  const [draft, setDraft] = useState(settings);
  const latest = useRef(settings);
  const [at, setAt] = useState(() => Math.max(0, start ? stepAt(start) : firstRun ? 0 : 1));
  const [reached, setReached] = useState(at);
  const [dir, setDir] = useState<1 | -1>(1);
  const [leaving, setLeaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [env, setEnv] = useState<Environment | null>(null);
  const [envError, setEnvError] = useState<string | null>(null);
  const [scan, setScan] = useState(0);
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [suggested, setSuggested] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, Link>>({});
  const linksNow = useRef(links);
  linksNow.current = links;
  const pinging = useRef(new Set<string>());
  const head = useRef<HTMLHeadingElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  const step = STEPS[at];

  const change = useCallback((patch: Partial<Settings>) => {
    latest.current = { ...latest.current, ...patch };
    setDraft(latest.current);
  }, []);

  // Saves run one after another, each with the newest copy; one with nothing new is skipped.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const chain = useRef<Promise<void>>(Promise.resolve());
  const saved = useRef(JSON.stringify(settings));
  const persist = useCallback((): Promise<boolean> => {
    const run = chain.current.then(async () => {
      const copy = latest.current;
      const json = JSON.stringify(copy);
      if (json === saved.current) return;
      await onSaveRef.current(copy);
      saved.current = json;
    });
    chain.current = run.catch(() => {});
    return run.then(
      () => {
        toast.dismiss("setup-save");
        return true;
      },
      (e) => {
        toast.show({ id: "setup-save", kind: "error", text: "Your settings weren't saved", detail: humanError(e) });
        return false;
      },
    );
  }, [toast]);

  const recheck = useCallback(() => {
    setScan((n) => n + 1);
    return api.environment().then(
      (e) => {
        setEnv(e);
        setEnvError(null);
        return e;
      },
      (e) => {
        setEnvError(humanError(e));
        return null;
      },
    );
  }, []);

  // A half-done first setup comes back the next time Rewatch opens, on the step it was left on.
  useEffect(() => {
    if (!firstRun || closing) return;
    try {
      localStorage.setItem(SETUP_KEY, step.id);
    } catch {
      // Then it isn't brought back, that is all.
    }
  }, [firstRun, closing, step.id]);

  useEffect(() => {
    recheck().then((e) => {
      if (e?.suggestedRecordingsDir && !latest.current.recordingsDir.trim()) change({ recordingsDir: e.suggestedRecordingsDir });
    });
    // Teammates know each other by their names in League, so that's the name to suggest.
    api
      .leagueName()
      .then((n) => {
        const name = n?.trim();
        if (!name) return;
        setSuggested(name);
        if (!latest.current.shareName.trim()) change({ shareName: name });
      })
      .catch(() => {});
    return () => window.clearTimeout(timer.current);
  }, [recheck, change]);

  // This PC's code and whether it's online; who asks to connect, while that is on screen.
  const live = step.id === "pc" || step.id === "team";
  useEffect(() => {
    let alive = true;
    const load = () => api.shareInfo().then((x) => alive && setShare(x), () => {});
    load();
    if (!live) {
      return () => {
        alive = false;
      };
    }
    const iv = window.setInterval(load, 2000);
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, [live]);

  /** Ask a teammate's app whether we're connected. `loud` shows it as a new check rather than a quiet repeat. */
  const check = useCallback(
    async (code: string, loud = false) => {
      if (pinging.current.has(code)) return;
      pinging.current.add(code);
      setLinks((l) => {
        const was = l[code] as Link | undefined;
        return { ...l, [code]: { at: was?.at ?? 0, text: was?.text, state: loud || !was ? "checking" : was.state, busy: true } };
      });
      let result: Pick<Link, "state" | "text">;
      try {
        const name = (await api.friendPing(code)).trim();
        result = { state: "ok" };
        // Their app says what they're called; better than the stand-in.
        const f = latest.current.friends.find((x) => x.code === code);
        if (name && f && (!f.name.trim() || f.name === PLACEHOLDER)) {
          change({ friends: latest.current.friends.map((x) => (x.code === code ? { ...x, name } : x)) });
          void persist();
        }
      } catch (e) {
        result = linkFrom(e);
      } finally {
        pinging.current.delete(code);
      }
      setLinks((l) => {
        const next = { ...l };
        if (latest.current.friends.some((x) => x.code === code)) next[code] = { ...result, busy: false, at: Date.now() };
        else delete next[code];
        return next;
      });
    },
    [change, persist],
  );

  // On the teammates step: everyone is checked on arrival, then again while they haven't added you back or
  // can't be reached, so the line lights up the moment they do.
  const onTeam = step.id === "team";
  useEffect(() => {
    if (!onTeam) return;
    const tick = () => {
      if (document.hidden) return;
      const now = Date.now();
      for (const f of latest.current.friends) {
        const l = linksNow.current[f.code];
        if (!l) {
          void check(f.code);
          continue;
        }
        const again = RECHECK[l.state];
        if (!l.busy && again && now - l.at >= again) void check(f.code);
      }
    };
    tick();
    const iv = window.setInterval(tick, 1000);
    return () => window.clearInterval(iv);
  }, [onTeam, check]);

  const addFriend = (code: string, name: string) => {
    const c = code.trim().toLowerCase();
    if (!c || latest.current.friends.some((f) => sameCode(f.code, c))) return;
    change({ friends: [...latest.current.friends, { name: name.trim() || PLACEHOLDER, code: c }] });
    setLinks((l) => ({ ...l, [c]: { state: "checking", busy: true, at: 0 } }));
    // Only a saved teammate may connect back, so the check waits for the save.
    void persist().then((ok) => {
      if (ok) return check(c, true);
      setLinks((l) => ({ ...l, [c]: { state: "error", busy: false, at: Date.now(), text: "Not saved, so not checked yet." } }));
    });
  };
  const removeFriend = (code: string) => {
    change({ friends: latest.current.friends.filter((f) => f.code !== code) });
    setLinks((l) => {
      const next = { ...l };
      delete next[code];
      return next;
    });
    void persist();
  };
  const renameFriend = (code: string, name: string) => {
    change({ friends: latest.current.friends.map((f) => (f.code === code ? { ...f, name } : f)) });
    void persist();
  };

  const go = (next: number) => {
    if (next < 0 || next >= STEPS.length || next === at || leaving || closing) return;
    void persist();
    setDir(next > at ? 1 : -1);
    const land = () => {
      setAt(next);
      setReached((r) => Math.max(r, next));
      setLeaving(false);
    };
    if (reducedMotion()) return land();
    setLeaving(true);
    timer.current = window.setTimeout(land, 170);
  };

  // A new step starts at its top, with its heading focused for screen readers.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
    head.current?.focus({ preventScroll: true });
  }, [at]);

  const finish = async () => {
    if (closing) return;
    const folder = latest.current.recordingsDir.trim() || env?.suggestedRecordingsDir || "";
    if (!folder) {
      toast.show({ kind: "error", text: "Choose where recordings go first" });
      go(stepAt("record"));
      return;
    }
    change({ recordingsDir: folder });
    setClosing(true);
    if (!(await persist())) {
      setClosing(false);
      return;
    }
    if (firstRun) {
      try {
        localStorage.removeItem(SETUP_KEY);
      } catch {
        // It would only open once more.
      }
    }
    api.micCheckStop().catch(() => {});
    timer.current = window.setTimeout(onClose, reducedMotion() ? 0 : 440);
  };

  const ctx: Ctx = { s: draft, change, persist, env, envError, recheck, scan, share, head };
  const canNext = step.id !== "record" || !!draft.recordingsDir.trim();
  const nextLabel = step.id === "team" && draft.friends.length === 0 ? "Skip for now" : "Continue";

  return (
    <div
      className={`ob ${closing ? "closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Set up Rewatch"
      // Keys pressed in here are the guide's, not the shortcuts of the page under it.
      data-own-keys=""
      onKeyDown={(e) => {
        // Opened from Settings it closes like any dialog; a first setup is left with "Skip setup".
        if (e.key !== "Escape" || firstRun || e.defaultPrevented) return;
        e.preventDefault();
        void finish();
      }}
    >
      <aside className="ob-rail">
        <div className="ob-brand">
          <Logo size={19} />
          <b>Rewatch</b>
          <span>{firstRun ? "Setup" : "Setup guide"}</span>
        </div>
        <nav className="ob-steps" aria-label="Setup steps" style={{ "--at": at } as CSSProperties}>
          <span className="ob-track" aria-hidden="true">
            <i />
          </span>
          <span className="ob-ind" aria-hidden="true" />
          <ol>
            {STEPS.map((x, i) => {
              const done = i < reached && i !== at;
              return (
                <li key={x.id}>
                  <button className={done ? "done" : ""} aria-current={i === at ? "step" : undefined} disabled={i > reached} onClick={() => go(i)}>
                    <span className="ob-dot">{done ? <Check size={12} strokeWidth={3.2} aria-hidden /> : i + 1}</span>
                    {x.title}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <div className="ob-rail-foot">
          <p>
            <Lock size={13} aria-hidden />
            Recordings stay on this PC. Teammates you add fetch them straight from it, encrypted.
          </p>
          <button className="btn sm quiet" onClick={finish} disabled={closing}>
            {firstRun ? "Skip setup" : "Close"}
          </button>
        </div>
      </aside>

      <div className="ob-main" data-step={step.id}>
        <div className="ob-aura" aria-hidden="true" />
        <div className="ob-scroll" ref={scroller}>
          <div key={step.id} className={`ob-step ${step.id} ${dir < 0 ? "back" : ""} ${leaving ? "leaving" : ""}`}>
            {step.id === "welcome" ? (
              <Welcome firstRun={firstRun} onStart={() => go(at + 1)} />
            ) : step.id === "pc" ? (
              <PcStep ctx={ctx} />
            ) : step.id === "record" ? (
              <RecordStep ctx={ctx} />
            ) : step.id === "sound" ? (
              <SoundStep ctx={ctx} />
            ) : step.id === "team" ? (
              <TeamStep
                ctx={ctx}
                links={links}
                suggested={suggested}
                onAdd={addFriend}
                onRemove={removeFriend}
                onRename={renameFriend}
                onRetry={(code) => void check(code, true)}
              />
            ) : (
              <DoneStep ctx={ctx} links={links} firstRun={firstRun} />
            )}
          </div>
        </div>
        {step.id !== "welcome" && (
          <footer className="ob-foot">
            <div className="ob-foot-in">
              <button className="btn quiet" onClick={() => go(at - 1)} disabled={leaving || closing}>
                <ArrowLeft size={15} aria-hidden />
                Back
              </button>
              <span className="grow" />
              {step.id === "done" ? (
                <button className="btn primary ob-next" onClick={finish} disabled={closing}>
                  {firstRun ? "Open Rewatch" : "Done"}
                  <ArrowRight size={15} aria-hidden />
                </button>
              ) : (
                <button className="btn primary ob-next" onClick={() => go(at + 1)} disabled={!canNext || leaving}>
                  {nextLabel}
                  <ArrowRight size={15} aria-hidden />
                </button>
              )}
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
