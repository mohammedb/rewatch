import { Film, LayoutGrid, Pause, Play, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fileUrl } from "./api";
import { Portrait } from "./ChampIcon";
import { SoundControl } from "./Deck";
import { clock } from "./format";
import { SpellIcon, useLookup } from "./Stats";
import type { AudioPrefs, DraftPicks, DraftRecording, PickBan, PickEvent, PickSeat, PickSnapshot, TrackName } from "./types";
import { ownsKeys } from "./ui";

const ROLE: Record<string, string> = { top: "Top", jungle: "Jungle", middle: "Mid", bottom: "Bot", utility: "Support" };

interface Champ {
  name: string;
  /** Data Dragon's key for its picture. */
  key?: string;
}

type Loaded = DraftPicks | "loading" | "missing";

/** The picks file, read once. */
function usePicks(dir: string, file: string | null | undefined): Loaded {
  const [p, setP] = useState<Loaded>(file ? "loading" : "missing");
  useEffect(() => {
    if (!file) {
      setP("missing");
      return;
    }
    let live = true;
    setP("loading");
    fetch(fileUrl(dir, file))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((j: DraftPicks) => live && setP(Array.isArray(j?.snapshots) && j.snapshots.length ? j : "missing"))
      .catch(() => live && setP("missing"));
    return () => {
      live = false;
    };
  }, [dir, file]);
  return p;
}

/** The last look at champion select at or before `t` (the first, before it began). */
function snapshotAt(snaps: PickSnapshot[], t: number): PickSnapshot {
  let lo = 0;
  let hi = snaps.length - 1;
  let at = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (snaps[mid].t <= t) {
      at = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return snaps[at];
}

/** The seats whose turn it is. Files from the first test builds also listed everyone while planning. */
const turnOf = (s: PickSnapshot) => new Set(s.phase === "BAN_PICK" ? s.turn : []);

function phaseName(s: PickSnapshot): string {
  if (s.phase === "PLANNING") return "Planning";
  if (s.phase === "FINALIZATION") return "Final look";
  if (s.phase === "GAME_STARTING") return "Game starting";
  if (s.phase !== "BAN_PICK") return "Champion select";
  const turn = turnOf(s);
  if (s.bans.some((b) => !b.done && turn.has(b.cell))) return "Banning";
  if (turn.size) return "Picking";
  return s.bans.length && s.bans.every((b) => b.done) && !s.seats.some((x) => x.locked) ? "Bans revealed" : "Bans and picks";
}

const PHASE_EVENT: Record<string, string> = {
  PLANNING: "Planning: everyone shows what they'd like",
  BAN_PICK: "Bans and picks",
  FINALIZATION: "Final look: runes, spells and trades",
  GAME_STARTING: "Game starting",
};

/** Who a seat is, in words: "You", the role on your side, "Enemy" on theirs. */
function who(seat: PickSeat | undefined, ally: boolean | undefined): string {
  if (seat?.me) return "You";
  if (seat ? seat.ally : ally) return seat && ROLE[seat.position] ? ROLE[seat.position] : "Ally";
  return "Enemy";
}

/**
 * Champion select before the game: rebuilt from what the League client reported
 * (picks, bans, hovers, roles, spells and the timer), with Discord, the microphone and
 * the client's sound in step. A video of the client's window, when there is one, can
 * be shown instead of the board. The sound follows the same mixer as the game.
 */
export function DraftView({ dir, draft, audio, onAudio, onClose }: { dir: string; draft: DraftRecording; audio: AudioPrefs; onAudio: (patch: Partial<AudioPrefs>) => void; onClose: () => void }) {
  const picks = usePicks(dir, draft.picks);
  const board = typeof picks === "object" ? picks : null;
  const [view, setView] = useState<"board" | "video">(draft.picks ? "board" : "video");
  // Without picks to show, the video is all there is.
  const showVideo = !!draft.video && (view === "video" || picks === "missing");
  const offset = draft.offset ?? 0;
  const duration = Math.max(draft.duration || 0, board ? board.snapshots[board.snapshots.length - 1].t - offset + 1 : 0);

  // ---- one clock for everything: the sound and the video follow it
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const clk = useRef({ base: 0, at: 0, playing: false });
  const media = useRef(new Map<string, HTMLMediaElement>());
  const now = useCallback(() => {
    const c = clk.current;
    return c.playing ? Math.min(duration, c.base + (performance.now() - c.at) / 1000) : c.base;
  }, [duration]);
  /** Bring each sound (and the video) to the clock; `hard` puts them exactly on it. */
  const follow = useCallback(
    (hard: boolean) => {
      const t = now();
      for (const el of media.current.values()) {
        const end = Number.isFinite(el.duration) ? el.duration : Infinity;
        if (!clk.current.playing || t >= end - 0.05) {
          if (!el.paused) el.pause();
          if (hard && t < end) el.currentTime = t;
          continue;
        }
        if (hard || (!el.seeking && Math.abs(el.currentTime - t) > 0.3)) el.currentTime = t;
        if (el.paused) el.play().catch(() => {});
      }
    },
    [now],
  );
  const play = useCallback(() => {
    const c = clk.current;
    if (c.base >= duration - 0.05) c.base = 0;
    c.at = performance.now();
    c.playing = true;
    setPlaying(true);
    setTime(c.base);
    follow(true);
  }, [duration, follow]);
  const pause = useCallback(() => {
    const c = clk.current;
    c.base = now();
    c.playing = false;
    setPlaying(false);
    setTime(c.base);
    follow(true);
  }, [now, follow]);
  const seek = useCallback(
    (to: number) => {
      const c = clk.current;
      c.base = Math.min(Math.max(to, 0), duration);
      c.at = performance.now();
      setTime(c.base);
      follow(true);
    },
    [duration, follow],
  );
  useEffect(() => {
    if (!playing) return;
    const iv = setInterval(() => {
      const t = now();
      setTime(t);
      if (t >= duration) pause();
      else follow(false);
    }, 100);
    return () => clearInterval(iv);
  }, [playing, now, duration, pause, follow]);
  // It plays as it opens, and nothing keeps sounding once it closes.
  useEffect(() => {
    play();
    const all = media.current;
    return () => all.forEach((el) => el.pause());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A sound that loads late, or the video when it is shown, joins in where the clock is.
  const followRef = useRef(follow);
  followRef.current = follow;
  const joins = useRef(new Map<string, (el: HTMLMediaElement | null) => void>());
  const join = (key: string) => {
    let f = joins.current.get(key);
    if (!f) {
      f = (el) => {
        if (el) {
          media.current.set(key, el);
          el.onloadedmetadata = () => followRef.current(true);
        } else media.current.delete(key);
      };
      joins.current.set(key, f);
    }
    return f;
  };

  // The mixer: "game" is the client's sound here, in its own file or in the video.
  useEffect(() => {
    for (const [key, el] of media.current) {
      const n = (key === "video" ? "game" : key) as TrackName;
      if (!(n in audio.volume)) continue;
      el.volume = audio.volume[n];
      el.muted = audio.muted[n];
    }
  }, [audio, showVideo]);

  // Space and the arrows play champion select while it shows (Esc is the player's: it closes this).
  const keys = useRef({ play, pause, seek, now });
  keys.current = { play, pause, seek, now };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ownsKeys(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
      const k = keys.current;
      if (e.key === " ") {
        e.preventDefault();
        if (clk.current.playing) k.pause();
        else k.play();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        k.seek(k.now() + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 5));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const videoTrack = draft.tracks.find((tr) => tr.name === "game" && !tr.file);
  const t = time + offset;
  const snap = board ? snapshotAt(board.snapshots, t) : null;
  const side = snap?.side === 1 ? "Blue side" : snap?.side === 2 ? "Red side" : null;

  return (
    <div className="dv" role="region" aria-label="Champion select">
      <header className="dv-h">
        <b>Champion select</b>
        <span className="num">{clock(duration)}</span>
        {side && <span className={`cs-sidetag s${snap!.side}`}>{side}</span>}
        <span className="grow" />
        {draft.video && draft.picks && picks !== "missing" && (
          <div className="seg" role="group" aria-label="Show">
            <button aria-pressed={!showVideo} onClick={() => setView("board")} title="Picks and bans, as the League client reported them">
              <LayoutGrid size={14} aria-hidden /> Picks
            </button>
            <button aria-pressed={showVideo} onClick={() => setView("video")} title="The League client's window, as recorded">
              <Film size={14} aria-hidden /> Client
            </button>
          </div>
        )}
        <SoundControl tracks={draft.tracks} audio={audio} onChange={onAudio} />
        <button className="btn sq quiet" onClick={onClose} aria-label="Close champion select" title="Back to the game (Esc)">
          <X size={18} />
        </button>
      </header>
      <div className="cs-body">
        <div className="cs-main">
          {showVideo ? (
            <video ref={join("video")} className="cs-video" src={fileUrl(dir, draft.video!)} preload="auto" disablePictureInPicture playsInline onClick={() => (clk.current.playing ? pause() : play())} />
          ) : snap && board ? (
            <Board snap={snap} t={t} picks={board} />
          ) : (
            <p className="cs-note">{picks === "loading" ? "Reading champion select…" : "The picks of this champion select couldn't be read. Its sound still plays."}</p>
          )}
          <Transport time={time} duration={duration} playing={playing} offset={offset} events={board?.events ?? []} snaps={board?.snapshots ?? []} onPlay={play} onPause={pause} onSeek={seek} />
        </div>
        {board && (
          <Events
            picks={board}
            t={t}
            offset={offset}
            onSeek={(at) => {
              seek(at - offset - 1.5);
              if (!clk.current.playing) play();
            }}
          />
        )}
      </div>
      {/* The client's sound sits in the video when there is one; it plays even while the board shows. */}
      {videoTrack && draft.video && !showVideo && <video ref={join("video")} src={fileUrl(dir, draft.video)} preload="auto" hidden />}
      {draft.tracks
        .filter((tr) => tr.file)
        .map((tr) => (
          <audio key={tr.name} ref={join(tr.name)} src={fileUrl(dir, tr.file!)} preload="auto" />
        ))}
    </div>
  );
}

/** A champion's name and picture key, from the file's own names and Data Dragon's. */
function useChamp(picks: DraftPicks): (id: number) => Champ | null {
  const dd = useLookup("champions");
  return useCallback(
    (id: number) => {
      if (!id) return null;
      const own = picks.champions[String(id)];
      const d = dd?.get(id);
      return { name: own?.name || d?.name || `Champion ${id}`, key: d?.icon || own?.alias?.replace(/^Jade_/, "") || undefined };
    },
    [picks, dd],
  );
}

function Board({ snap, t, picks }: { snap: PickSnapshot; t: number; picks: DraftPicks }) {
  const champ = useChamp(picks);
  const turn = turnOf(snap);
  const left = snap.left == null ? null : Math.max(0, snap.left - Math.max(0, t - snap.t));
  const share = left != null && snap.total ? Math.min(1, left / snap.total) : null;
  const team = (ally: boolean) => snap.seats.filter((x) => x.ally === ally);
  const bans = (ally: boolean) => snap.bans.filter((b) => b.ally === ally);
  const banning = new Set(snap.bans.filter((b) => !b.done && turn.has(b.cell)).map((b) => b.cell));
  const doing = (cell: number) => (!turn.has(cell) ? null : banning.has(cell) ? "ban" : "pick");
  return (
    <div className="cs-board">
      <div className="cs-top">
        <Bans bans={bans(true)} champ={champ} side="ally" />
        <div className="cs-clock" aria-live="off">
          <b>{phaseName(snap)}</b>
          {left != null && <span className={`num ${left <= 5 && snap.phase === "BAN_PICK" ? "hurry" : ""}`}>{Math.ceil(left)}</span>}
          {share != null && (
            <span className="cs-bar" aria-hidden>
              <i style={{ width: `${share * 100}%` }} />
            </span>
          )}
        </div>
        <Bans bans={bans(false)} champ={champ} side="enemy" />
      </div>
      <div className="cs-teams">
        <ol className="cs-team ally" aria-label="Your team">
          {team(true).map((x) => (
            <Seat key={x.cell} seat={x} doing={doing(x.cell)} champ={champ} />
          ))}
        </ol>
        <ol className="cs-team enemy" aria-label="Enemy team">
          {team(false).map((x) => (
            <Seat key={x.cell} seat={x} doing={doing(x.cell)} champ={champ} />
          ))}
        </ol>
      </div>
    </div>
  );
}

function Seat({ seat, doing, champ }: { seat: PickSeat; doing: "ban" | "pick" | null; champ: (id: number) => Champ | null }) {
  // The other team's hovers aren't shown: the client doesn't show them either.
  const shown = seat.locked ? seat.champion : seat.ally ? seat.intent : 0;
  const c = champ(shown);
  const state = seat.locked && c ? "locked" : c ? "hover" : "open";
  const role = ROLE[seat.position];
  const spells = seat.ally && (seat.spells[0] || seat.spells[1]);
  return (
    <li className={`cs-seat st-${state} ${doing ? "turn" : ""} ${seat.me ? "me" : ""}`}>
      {c ? <Portrait championKey={c.key} name={c.name} size={52} square /> : <span className="cs-blank" aria-hidden />}
      <span className="cs-who">
        <small>
          {seat.me && <em className="you">You</em>}
          {role ?? ""}
        </small>
        <b>{c ? c.name : doing === "ban" ? "Banning…" : doing === "pick" ? "Picking…" : ""}</b>
        {state === "hover" && <i>{doing === "pick" ? "Hovering" : doing === "ban" ? "Wants to play" : "Would like"}</i>}
      </span>
      {spells ? (
        <span className="cs-sp">
          <SpellIcon id={seat.spells[0]} size={20} />
          <SpellIcon id={seat.spells[1]} size={20} />
        </span>
      ) : null}
    </li>
  );
}

function Bans({ bans, champ, side }: { bans: PickBan[]; champ: (id: number) => Champ | null; side: "ally" | "enemy" }) {
  return (
    <div className={`cs-bans ${side}`} aria-label={side === "ally" ? "Your team's bans" : "Enemy bans"}>
      {bans.map((b) => {
        const c = champ(b.champion);
        const state = c ? (b.done ? "done" : "hover") : "open";
        return (
          <span key={b.id} className={`cs-ban st-${state}`} title={c ? `${b.done ? "Banned" : "Hovering"}: ${c.name}` : b.done ? "No ban" : "Not banned yet"}>
            {c && <Portrait championKey={c.key} name={c.name} size={30} square />}
          </span>
        );
      })}
    </div>
  );
}

/** Play, the position, and what happened where on it. */
function Transport({ time, duration, playing, offset, events, snaps, onPlay, onPause, onSeek }: { time: number; duration: number; playing: boolean; offset: number; events: PickEvent[]; snaps: PickSnapshot[]; onPlay: () => void; onPause: () => void; onSeek: (t: number) => void }) {
  const at = (t: number) => `${Math.min(100, Math.max(0, ((t - offset) / (duration || 1)) * 100))}%`;
  // The phases as bands under the marks.
  const bands = useMemo(() => {
    const out: { phase: string; from: number; to: number }[] = [];
    for (const s of snaps) {
      const last = out[out.length - 1];
      if (last && last.phase === s.phase) continue;
      if (last) last.to = s.t;
      out.push({ phase: s.phase, from: s.t, to: offset + duration });
    }
    return out;
  }, [snaps, offset, duration]);
  return (
    <div className="cs-tr">
      <button className="btn sq" onClick={playing ? onPause : onPlay} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space)" : "Play (Space)"}>
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <div className="cs-track">
        <div className="cs-bands" aria-hidden>
          {bands.map((b) => (
            <i key={b.from} className={`p-${b.phase.toLowerCase()}`} style={{ left: at(b.from), width: `calc(${at(b.to)} - ${at(b.from)})` }} />
          ))}
        </div>
        <div className="cs-marks" aria-hidden>
          {events
            .filter((e) => e.kind === "ban" || e.kind === "pick" || e.kind === "swap")
            .map((e, i) => (
              <i key={i} className={`k-${e.kind} ${e.ally === false ? "them" : "us"}`} style={{ left: at(e.t) }} />
            ))}
        </div>
        <input type="range" min={0} max={duration} step={0.1} value={Math.min(time, duration)} onChange={(e) => onSeek(Number(e.target.value))} aria-label="Position in champion select" />
      </div>
      <span className="num">
        {clock(time)} / {clock(duration)}
      </span>
    </div>
  );
}

/** What happened, in order; a click plays it from just before. */
function Events({ picks, t, offset, onSeek }: { picks: DraftPicks; t: number; offset: number; onSeek: (t: number) => void }) {
  const champ = useChamp(picks);
  const list = picks.events;
  let current = -1;
  for (let i = 0; i < list.length && list[i].t <= t; i++) current = i;
  const ref = useRef<HTMLOListElement>(null);
  // Keep what just happened in sight, scrolling the list alone (not the player around it).
  useEffect(() => {
    const ol = ref.current;
    const li = ol?.querySelector<HTMLElement>(".now");
    if (!ol || !li) return;
    if (li.offsetTop < ol.scrollTop || li.offsetTop + li.offsetHeight > ol.scrollTop + ol.clientHeight) {
      ol.scrollTop = Math.max(0, li.offsetTop - ol.clientHeight / 2);
    }
  }, [current]);
  return (
    <aside className="cs-ev" aria-label="What happened">
      <h3>What happened</h3>
      <ol ref={ref}>
        {list.map((e, i) => {
          const c = champ(e.champion ?? 0);
          const seat = e.cell != null ? snapshotAt(picks.snapshots, e.t).seats.find((x) => x.cell === e.cell) : undefined;
          const name = c?.name ?? "";
          const text =
            e.kind === "phase"
              ? PHASE_EVENT[e.phase ?? ""] ?? "Champion select"
              : `${who(seat, e.ally)} ${{ ban: "banned", hover: "hovered", pick: "locked", swap: "swapped to" }[e.kind]} ${name}`;
          return (
            <li key={i} className={`k-${e.kind} ${e.ally === false ? "them" : "us"} ${i <= current ? "past" : ""} ${i === current ? "now" : ""}`}>
              <button onClick={() => onSeek(e.t)} title="Play from here">
                <span className="num">{clock(Math.max(0, e.t - offset))}</span>
                {c ? <Portrait championKey={c.key} name={name} size={22} side={e.ally === false ? "enemy" : "ally"} /> : <span className="cs-dot" aria-hidden />}
                <span className="tx">{text}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
