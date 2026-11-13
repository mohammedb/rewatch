import {
  AlertTriangle,
  Archive,
  AudioLines,
  Check,
  CircleCheck,
  CircleDot,
  CircleX,
  Copy,
  Download,
  FolderOpen,
  HeartPulse,
  ListVideo,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
  Users,
  Video,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { api, pickFolder, showInFolder } from "./api";
import { bytes } from "./format";
import type { Environment, Friend, KeySlot, LeagueBackup, MatchSummary, MicInfo, QueueToggles, Settings, ShareInfo, UpdateInfo } from "./types";
import { humanError, Select, Skeleton, useConfirm, useToast } from "./ui";

const QUEUES: [keyof QueueToggles, string][] = [
  ["rankedSolo", "Ranked Solo/Duo"],
  ["rankedFlex", "Ranked Flex"],
  ["normal", "Normal"],
  ["aram", "ARAM"],
  ["custom", "Custom and Practice Tool"],
  ["other", "Other modes"],
];

const DEFAULT_KEY_SLOTS: KeySlot[] = [
  { vk: "Q", label: "Q", row: 0 },
  { vk: "W", label: "W", row: 0 },
  { vk: "E", label: "E", row: 0 },
  { vk: "R", label: "R", row: 0 },
  { vk: "D", label: "D", row: 0 },
  { vk: "F", label: "F", row: 0 },
  { vk: "1", label: "1", row: 1 },
  { vk: "2", label: "2", row: 1 },
  { vk: "3", label: "3", row: 1 },
  { vk: "4", label: "4", row: 1 },
  { vk: "5", label: "5", row: 1 },
  { vk: "6", label: "6", row: 1 },
  { vk: "7", label: "7", row: 1 },
  { vk: "B", label: "B", row: 1 },
  { vk: "Shift", label: "Shift", row: 2 },
  { vk: "Ctrl", label: "Ctrl", row: 2 },
  { vk: "A", label: "A", row: 2 },
  { vk: "S", label: "S", row: 2 },
  { vk: "Tab", label: "Tab", row: 2 },
  { vk: "Space", label: "Space", row: 2 },
];

const SECTIONS: { id: string; title: string; icon: LucideIcon }[] = [
  { id: "set-status", title: "Status", icon: HeartPulse },
  { id: "set-recording", title: "Recording", icon: CircleDot },
  { id: "set-games", title: "Which games", icon: ListVideo },
  { id: "set-video", title: "Video", icon: Video },
  { id: "set-sound", title: "Sound and input", icon: AudioLines },
  { id: "set-team", title: "Teammates", icon: Users },
  { id: "set-ai", title: "AI review", icon: Sparkles },
  { id: "set-backup", title: "League backups", icon: Archive },
  { id: "set-updates", title: "Updates", icon: Download },
  { id: "set-advanced", title: "Advanced", icon: Wrench },
];

const GB = 1024 ** 3;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortCode = (code: string) => (code.length > 18 ? `${code.slice(0, 10)}…${code.slice(-6)}` : code);

/** What lowering the size limit would delete, the way the recorder does it: oldest first, kept games never. */
function overLimit(matches: MatchSummary[], gb: number): { count: number; bytes: number } {
  const cap = gb * GB;
  let total = matches.reduce((s, m) => s + m.sizeBytes, 0);
  let count = 0;
  let freed = 0;
  for (const m of [...matches].sort((a, b) => a.startedEpochMs - b.startedEpochMs)) {
    if (total <= cap) break;
    if (m.keep) continue;
    total -= m.sizeBytes;
    freed += m.sizeBytes;
    count++;
  }
  return { count, bytes: freed };
}

// ------------------------------------------------------------------ pieces

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

function Section({ id, icon: Icon, title, intro, children }: { id: string; icon: LucideIcon; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section className="set" id={id} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>
        <Icon size={17} aria-hidden />
        {title}
      </h2>
      {intro}
      <div className="rows">{children}</div>
    </section>
  );
}

function Opt({ title, hint, children, wide, id }: { title: ReactNode; hint?: ReactNode; children?: ReactNode; wide?: boolean; id?: string }) {
  return (
    <div className={`opt ${wide ? "wide" : ""}`} id={id}>
      <div className="ol">
        {title}
        {hint && <small>{hint}</small>}
      </div>
      {children && <div className="ctl">{children}</div>}
    </div>
  );
}

/**
 * A text box that hands its value over when you leave it or press Enter, not on every
 * key: settings save by themselves, and half a path or half a hotkey should never be saved.
 */
function Field({ value, onCommit, className = "", ...rest }: { value: string; onCommit: (v: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [draft, setDraft] = useState(value);
  const live = useRef({ draft: value, value, focused: false, onCommit });
  live.current.value = value;
  live.current.onCommit = onCommit;
  useEffect(() => {
    if (!live.current.focused) {
      setDraft(value);
      live.current.draft = value;
    }
  }, [value]);
  const commit = () => {
    const l = live.current;
    if (l.draft !== l.value) l.onCommit(l.draft);
  };
  // Leaving the page while still typing keeps what was typed.
  useEffect(
    () => () => {
      if (live.current.focused) commit();
    },
    [],
  );
  return (
    <input
      {...rest}
      className={`field-input ${className}`}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        live.current.draft = e.target.value;
      }}
      onFocus={() => (live.current.focused = true)}
      onBlur={() => {
        live.current.focused = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          // Without this, the same key press can land on a dialog the commit opens.
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          live.current.draft = live.current.value;
          setDraft(live.current.value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

type Level = "ok" | "warn" | "bad";
interface Check {
  key: string;
  level: Level;
  title: string;
  detail: ReactNode;
  action?: { label: string; run: () => void };
}

function Health({ checks }: { checks: Check[] | null }) {
  if (!checks) {
    return (
      <div className="health">
        <Skeleton h={18} w={220} />
        <Skeleton h={14} w="70%" />
        <Skeleton h={14} w="55%" />
      </div>
    );
  }
  const bad = checks.filter((c) => c.level === "bad").length;
  const warn = checks.filter((c) => c.level === "warn").length;
  const head = bad ? "Rewatch can't record yet" : warn ? `Ready, with ${plural(warn, "thing")} to look at` : "Everything is ready";
  const Icon = bad ? CircleX : warn ? AlertTriangle : CircleCheck;
  return (
    <div className={`health ${bad ? "bad" : warn ? "warn" : "ok"}`}>
      <div className="hh">
        <Icon size={18} aria-hidden />
        <b>{head}</b>
      </div>
      <ul>
        {checks.map((c) => {
          const I = c.level === "bad" ? CircleX : c.level === "warn" ? AlertTriangle : Check;
          return (
            <li key={c.key} className={c.level}>
              <I size={15} aria-hidden className="hi" />
              <span className="ht">
                <b>{c.title}</b>
                <small>{c.detail}</small>
              </span>
              {c.action && (
                <button className="btn sm" onClick={c.action.run}>
                  {c.action.label}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** One teammate already on the list: their name can change; the code is who they are. */
function FriendRow({ friend, onRename, onRemove, beforeCheck }: { friend: Friend; onRename: (name: string) => void; onRemove: () => void; beforeCheck: () => Promise<void> }) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      // A teammate only counts once saved: checking first would be refused on their side.
      await beforeCheck();
      const name = await api.friendPing(friend.code);
      setResult({ ok: true, text: `Connected${name ? ` to ${name}` : ""}. Their view shows up in games you both recorded.` });
    } catch (e) {
      setResult({ ok: false, text: humanError(e) });
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="friend">
      <Field value={friend.name} placeholder="Name" aria-label="Teammate's name" onCommit={onRename} />
      <code className="fcode" title={friend.code}>
        {shortCode(friend.code)}
      </code>
      <button className="btn sm" disabled={testing} onClick={test}>
        {testing && <Loader2 size={13} className="spin" aria-hidden />}
        {testing ? "Checking" : "Check"}
      </button>
      <button className="btn sm sq quiet danger" aria-label={`Remove ${friend.name || "teammate"}`} title="Remove" onClick={onRemove}>
        <X size={15} />
      </button>
      {result && (
        <span className={`fres ${result.ok ? "ok" : "bad"}`} role="status">
          {result.text}
        </span>
      )}
    </div>
  );
}

function AddFriend({ onAdd }: { onAdd: (f: Friend) => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  return (
    <form
      className="friend add"
      onSubmit={(e) => {
        e.preventDefault();
        if (!code.trim()) return;
        onAdd({ name: name.trim() || "Teammate", code: code.trim() });
        setName("");
        setCode("");
      }}
    >
      <input className="field-input" type="text" placeholder="Their name" aria-label="New teammate's name" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="field-input" type="text" placeholder="Paste their friend code" aria-label="New teammate's friend code" value={code} onChange={(e) => setCode(e.target.value)} />
      <button className="btn" type="submit" disabled={!code.trim()}>
        <Plus size={14} aria-hidden />
        Add
      </button>
    </form>
  );
}

// ------------------------------------------------------------------ page

type SaveState = "idle" | "saving" | "saved" | "error";

// Saving is shared by every visit to the page. Saves run one after another, and the newest copy handed
// to a save that hasn't gone through yet is kept: a page opened while it's on its way (or after it
// failed) starts from it, not from the older settings the app still holds.
let unsaved: Settings | null = null;
let saves: Promise<void> = Promise.resolve();
/** "Try again" on a failed save goes through the open page, so the page shows how it went. */
let retryOpen: (() => void) | null = null;

export function SettingsPage({ settings, onSave, matches }: { settings: Settings; onSave: (s: Settings) => Promise<void>; matches: MatchSummary[] | null }) {
  const toast = useToast();
  const confirm = useConfirm();
  // The page's copy is the one being edited. It saves itself; what comes back from a save
  // (names trimmed, codes lower-cased) is not copied back in, so typing is never disturbed.
  const [s, setS] = useState(() => unsaved ?? settings);
  const latest = useRef(s);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const timer = useRef<number | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  /** Undo offers for removed teammates: they only work while this page is open. */
  const undos = useRef<string[]>([]);

  const [env, setEnv] = useState<Environment | null>(null);
  const [envError, setEnvError] = useState<string | null>(null);
  const [mics, setMics] = useState<MicInfo[] | null>(null);
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [backups, setBackups] = useState<LeagueBackup[] | null>(null);
  const [backupLabel, setBackupLabel] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [quotaKey, setQuotaKey] = useState(0);
  const [active, setActive] = useState(SECTIONS[0].id);
  const page = useRef<HTMLDivElement>(null);

  /** Save the newest unsaved copy, after any save already on its way; `mine` hands over this page's copy first. */
  const save = useCallback(
    (mine: boolean): Promise<void> => {
      if (timer.current != null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      if (mine) unsaved = latest.current;
      setSaveState("saving");
      const retry = () => (retryOpen ? retryOpen() : void save(false).catch(() => {}));
      const run = saves.then(async () => {
        // Null when a save before this one already took the newest copy.
        const copy = unsaved;
        try {
          if (copy) {
            await onSaveRef.current(copy);
            if (unsaved === copy) unsaved = null;
            toast.dismiss("settings-save");
          }
          if (timer.current == null) setSaveState("saved");
        } catch (e) {
          setSaveState("error");
          toast.show({
            id: "settings-save",
            kind: "error",
            text: "Your settings weren't saved",
            detail: humanError(e),
            actions: [{ label: "Try again", run: retry }],
          });
          throw e;
        }
      });
      saves = run.catch(() => {});
      return run;
    },
    [toast],
  );
  const flush = useCallback(() => save(true), [save]);
  useEffect(() => {
    // This page's copy started from the one that failed, so saving it covers that too.
    const retry = () => void save(true).catch(() => {});
    retryOpen = retry;
    return () => {
      if (retryOpen === retry) retryOpen = null;
    };
  }, [save]);

  /** Change the settings and save them a moment later, so quick changes go together. */
  const change = useCallback(
    (next: Settings, delay = 350) => {
      latest.current = next;
      setS(next);
      if (timer.current != null) window.clearTimeout(timer.current);
      setSaveState("saving");
      timer.current = window.setTimeout(() => {
        timer.current = null;
        flush().catch(() => {});
      }, delay);
    },
    [flush],
  );
  const set = <K extends keyof Settings>(key: K, value: Settings[K], delay?: number) => change({ ...latest.current, [key]: value }, delay);

  // Leaving the page with a change still waiting saves it straight away.
  useEffect(
    () => () => {
      if (timer.current != null) flush().catch(() => {});
      undos.current.forEach((x) => toast.dismiss(x));
    },
    [flush, toast],
  );

  const loadBackups = useCallback(() => api.listLeagueBackups().then(setBackups).catch(() => setBackups([])), []);
  useEffect(() => {
    api.listMicrophones().then(setMics).catch(() => setMics([]));
    api.updateInfo().then(setUpdate).catch(() => {});
    loadBackups();
    // People asking to connect can turn up at any time while the page is open.
    const loadShare = () => api.shareInfo().then(setShare).catch(() => setShare(null));
    loadShare();
    const iv = window.setInterval(loadShare, 3000);
    return () => window.clearInterval(iv);
  }, [loadBackups]);

  // What this PC has: again whenever a path it depends on was changed and saved.
  const firstEnv = useRef(true);
  useEffect(() => {
    const load = () =>
      api
        .environment()
        .then((e) => {
          setEnv(e);
          setEnvError(null);
        })
        .catch((e) => setEnvError(humanError(e)));
    if (firstEnv.current) {
      firstEnv.current = false;
      load();
      return;
    }
    const id = window.setTimeout(() => saves.then(load), 400);
    return () => window.clearTimeout(id);
  }, [s.ffmpegPath, s.leagueDir, s.recordingsDir]);

  // Which section is in view, for the list on the left.
  useEffect(() => {
    const root = page.current;
    if (!root) return;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const line = root.getBoundingClientRect().top + 110;
        let cur = SECTIONS[0].id;
        for (const x of SECTIONS) {
          const el = document.getElementById(x.id);
          if (el && el.getBoundingClientRect().top <= line) cur = x.id;
        }
        if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) cur = SECTIONS[SECTIONS.length - 1].id;
        setActive(cur);
      });
    };
    onScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  const go = (id: string, focus?: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    if (focus) window.setTimeout(() => document.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true }), 350);
  };

  const used = useMemo(() => (matches ?? []).reduce((n, m) => n + m.sizeBytes, 0), [matches]);
  const resFactor = s.resolution === "720" ? 0.25 : s.resolution === "1080" ? 0.56 : 1;
  // Rough size of an hour at this quality and resolution, to make the slider mean something.
  const perHour = Math.max(1, Math.round(18 * Math.pow(2, (23 - s.quality) / 6) * (s.fps / 60) * (s.codec === "h264" ? 1 : 0.65) * resFactor));

  // ---- what needs attention

  const checks: Check[] | null = useMemo(() => {
    if (envError && !env) return [{ key: "env", level: "warn", title: "Couldn't check this PC", detail: envError }];
    if (!env || !mics) return null;
    const out: Check[] = [];
    out.push(
      env.ffmpegVersion
        ? { key: "ff", level: "ok", title: "Recording works", detail: `FFmpeg ${env.ffmpegVersion.replace(/^ffmpeg version\s*/i, "").split(/\s/)[0]}` }
        : {
            key: "ff",
            level: "bad",
            title: "FFmpeg is missing",
            detail: "Recording needs it. Install FFmpeg, or tell Rewatch where ffmpeg.exe is.",
            action: { label: "Set its location", run: () => go("set-advanced", "#opt-ffmpeg input") },
          },
    );
    out.push(
      s.autoRecord
        ? { key: "auto", level: "ok", title: "Games record by themselves", detail: "Recording starts and stops with each League game." }
        : {
            key: "auto",
            level: "warn",
            title: "Games don't record by themselves",
            detail: "You have to start each recording yourself.",
            action: { label: "Switch on", run: () => set("autoRecord", true, 0) },
          },
    );
    out.push(
      env.leagueDir
        ? { key: "lol", level: "ok", title: "League found", detail: env.leagueDir }
        : {
            key: "lol",
            level: "warn",
            title: "League wasn't found",
            detail: "Without it Rewatch can't tell ranked from normal, or back up your League settings.",
            action: { label: "Set the folder", run: () => go("set-advanced", "#opt-league input") },
          },
    );
    if (env.freeBytes != null) {
      const room = s.quotaGb > 0 ? s.quotaGb * GB - used : null;
      if (env.freeBytes < 20 * GB) {
        out.push({ key: "disk", level: "bad", title: "The drive is almost full", detail: `${bytes(env.freeBytes)} free where recordings go. A game takes a few GB.` });
      } else if (room != null && room > env.freeBytes) {
        out.push({
          key: "disk",
          level: "warn",
          title: "The size limit is more than the free space",
          detail: `${bytes(env.freeBytes)} free, but the limit allows ${bytes(room)} more. The drive can fill up first.`,
          action: { label: "Change the limit", run: () => go("set-recording", "#opt-quota input") },
        });
      } else {
        out.push({ key: "disk", level: "ok", title: `${bytes(env.freeBytes)} free`, detail: `Recordings use ${bytes(used)}${s.quotaGb > 0 ? ` of the ${s.quotaGb} GB limit` : ", with no limit set"}.` });
      }
    }
    if (s.recordMic) {
      const chosen = s.micDevice ? mics.find((m) => m.id === s.micDevice) : mics.find((m) => m.isDefault);
      out.push(
        s.micDevice && !chosen
          ? {
              key: "mic",
              level: "warn",
              title: "Your microphone isn't connected",
              detail: "The one chosen under Sound and input isn't plugged in.",
              action: { label: "Use the Windows default", run: () => set("micDevice", "", 0) },
            }
          : { key: "mic", level: "ok", title: "Microphone", detail: chosen ? chosen.name : "The Windows default" },
      );
    }
    if (s.friends.length && share?.error) out.push({ key: "share", level: "warn", title: "Sharing with teammates isn't working", detail: share.error });
    return out;
    // `set` and `go` only touch refs and the DOM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, envError, mics, s.autoRecord, s.recordMic, s.micDevice, s.quotaGb, s.friends.length, share?.error, used]);
  const issues = checks?.filter((c) => c.level !== "ok").length ?? 0;

  // ---- changes that need a word first

  const changeFolder = async () => {
    const old = latest.current.recordingsDir;
    const d = await pickFolder(old);
    if (!d || d === old) return;
    if (matches?.length) {
      const ok = await confirm({
        title: "Record to this folder?",
        body: (
          <>
            <p>
              New games go to <b className="path">{d}</b>.
            </p>
            <p>
              The {plural(matches.length, "game")} in <b className="path">{old}</b> stay there, and won't show in Rewatch unless you move them into the new folder.
            </p>
          </>
        ),
        confirm: "Use this folder",
      });
      if (!ok) return;
    }
    set("recordingsDir", d, 0);
  };

  const commitQuota = async (text: string) => {
    const gb = Math.max(0, Math.round(Number(text) || 0));
    if (gb === latest.current.quotaGb) {
      setQuotaKey((k) => k + 1);
      return;
    }
    const doomed = gb > 0 && matches ? overLimit(matches, gb) : { count: 0, bytes: 0 };
    if (doomed.count > 0) {
      const ok = await confirm({
        title: `Lower the limit to ${gb} GB?`,
        body: (
          <p>
            After your next game, Rewatch deletes your oldest games until the folder fits: about <b>{plural(doomed.count, "game")}</b>, {bytes(doomed.bytes)}. Games you keep are never
            deleted.
          </p>
        ),
        confirm: "Lower the limit",
        danger: true,
      });
      if (!ok) {
        setQuotaKey((k) => k + 1);
        return;
      }
    }
    set("quotaGb", gb, 0);
  };

  const setHighlightsOnly = async (on: boolean) => {
    if (on) {
      const ok = await confirm({
        title: "Keep only the highlights?",
        body: <p>From now on, a day after each game its full recording is deleted and only the highlight reel stays. Games you keep are never touched.</p>,
        confirm: "Keep only highlights",
        danger: true,
      });
      if (!ok) return;
    }
    set("highlightsOnly", on, 0);
  };

  // ---- teammates

  const addFriend = (f: Friend) => {
    const code = f.code.trim();
    const friends = [...latest.current.friends.filter((x) => x.code.trim().toLowerCase() !== code.toLowerCase()), { ...f, code }];
    change({ ...latest.current, friends }, 0);
    flush()
      .then(() => api.friendPing(code))
      .then(
        (name) => toast.show({ kind: "success", text: `Connected to ${name || f.name}`, detail: "Their view shows up in games you both recorded." }),
        (e) =>
          toast.show({
            text: `Added ${f.name}`,
            detail: `Not connected yet: ${humanError(e)} They need Rewatch open, with your code added too.`,
          }),
      );
  };

  const removeFriend = (i: number) => {
    const f = latest.current.friends[i];
    change({ ...latest.current, friends: latest.current.friends.filter((_, j) => j !== i) }, 0);
    const id = `friend-undo-${f.code}`;
    undos.current = [...undos.current.filter((x) => x !== id), id];
    toast.show({
      id,
      text: `Removed ${f.name || "teammate"}`,
      actions: [
        {
          label: "Undo",
          run: () => {
            const code = f.code.trim().toLowerCase();
            const rest = latest.current.friends.filter((x) => x.code.trim().toLowerCase() !== code);
            change({ ...latest.current, friends: [...rest.slice(0, i), f, ...rest.slice(i)] }, 0);
          },
        },
      ],
    });
  };

  // ---- League backups

  const createBackup = async () => {
    setBackupBusy(true);
    try {
      const b = await api.createLeagueBackup(backupLabel.trim());
      setBackupLabel("");
      toast.show({ kind: "success", text: `Backed up ${b.label ? `"${b.label}"` : "your League settings"}`, detail: b.files.join(", ") });
      await loadBackups();
    } catch (e) {
      toast.show({ kind: "error", text: "Couldn't back up your League settings", detail: humanError(e) });
    } finally {
      setBackupBusy(false);
    }
  };

  const restoreBackup = async (b: LeagueBackup) => {
    const ok = await confirm({
      title: "Restore these League settings?",
      body: (
        <p>
          <b>{b.label || "This backup"}</b> from {new Date(b.createdAt).toLocaleString()} replaces {b.files.join(", ")} in League's Config folder. Your current files are backed up first, as
          "Before restore".
        </p>
      ),
      confirm: "Restore",
    });
    if (!ok) return;
    setBackupBusy(true);
    try {
      const restored = await api.restoreLeagueBackup(b.id);
      toast.show({ kind: "success", text: "League settings restored", detail: `${restored.files.join(", ")}. Restart League if it's open.` });
      await loadBackups();
    } catch (e) {
      toast.show({ kind: "error", text: "Couldn't restore that backup", detail: humanError(e) });
    } finally {
      setBackupBusy(false);
    }
  };

  const removeBackup = async (b: LeagueBackup) => {
    const ok = await confirm({
      title: "Delete this backup?",
      body: (
        <p>
          <b>{b.label || (b.auto ? "Automatic backup" : "Backup")}</b>, {new Date(b.createdAt).toLocaleString()}. This can't be undone.
        </p>
      ),
      confirm: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBackupBusy(true);
    try {
      await api.deleteLeagueBackup(b.id);
      await loadBackups();
    } catch (e) {
      toast.show({ kind: "error", text: "Couldn't delete that backup", detail: humanError(e) });
    } finally {
      setBackupBusy(false);
    }
  };

  const status = (live: boolean) => (
    <span className={`savestate ${saveState}`} role={live ? "status" : undefined} aria-live={live ? "polite" : undefined} aria-hidden={live ? undefined : true}>
      {saveState === "saving" ? (
        <>
          <Loader2 size={14} className="spin" aria-hidden />
          Saving
        </>
      ) : saveState === "saved" ? (
        <>
          <Check size={14} aria-hidden />
          Saved
        </>
      ) : saveState === "error" ? (
        <>
          <AlertTriangle size={14} aria-hidden />
          Not saved
          {live && (
            <button className="btn link" onClick={() => flush().catch(() => {})}>
              Try again
            </button>
          )}
        </>
      ) : (
        "Changes save by themselves"
      )}
    </span>
  );

  const micOptions = [
    { value: "", label: "Windows default" },
    ...(mics ?? []).map((m) => ({ value: m.id, label: m.name, hint: m.isDefault ? "Default" : m.isDefaultComms ? "Default for calls" : undefined })),
  ];
  if (s.micDevice && mics && !mics.some((m) => m.id === s.micDevice)) micOptions.push({ value: s.micDevice, label: "Not connected", hint: undefined });

  return (
    <div className="page" ref={page}>
      <div className="sets-wrap">
        <nav className="setnav" aria-label="Settings sections">
          {SECTIONS.map((x) => (
            <a
              key={x.id}
              href={`#${x.id}`}
              className={active === x.id ? "on" : ""}
              aria-current={active === x.id ? "true" : undefined}
              onClick={(e) => {
                e.preventDefault();
                setActive(x.id);
                go(x.id);
              }}
            >
              <x.icon size={15} aria-hidden />
              {x.title}
              {x.id === "set-status" && issues > 0 && <span className="ndot" aria-label={`${plural(issues, "thing")} to look at`} />}
            </a>
          ))}
          <div className="navsave">{status(false)}</div>
        </nav>

        <div className="sets">
          <div className="set-head">
            <h1>Settings</h1>
            {status(true)}
          </div>

          <Section id="set-status" icon={HeartPulse} title="Status">
            <Health checks={checks} />
          </Section>

          <Section id="set-recording" icon={CircleDot} title="Recording">
            <Opt title="Record games automatically" hint="Starts and stops with each League game. Nothing to press.">
              <Switch label="Record games automatically" checked={s.autoRecord} onChange={(v) => set("autoRecord", v)} />
            </Opt>
            <Opt title="Start with Windows" hint="Waits in the tray, so it's already running when you queue up.">
              <Switch label="Start with Windows" checked={s.startWithWindows} onChange={(v) => set("startWithWindows", v)} />
            </Opt>
            <Opt title="Recordings folder" hint={<span className="path">{s.recordingsDir || "Not set"}</span>}>
              {s.recordingsDir && (
                <button className="btn sq quiet" title="Show in File Explorer" aria-label="Show the folder in File Explorer" onClick={() => showInFolder(s.recordingsDir)}>
                  <FolderOpen size={15} />
                </button>
              )}
              <button className="btn" onClick={changeFolder}>
                Change
              </button>
            </Opt>
            <Opt
              id="opt-quota"
              title="Size limit"
              hint={`Past this, the oldest games go first. Kept games never do. 0 means no limit. Recordings use ${bytes(used)} now.`}
            >
              <Field key={quotaKey} className="num quota" type="number" min={0} inputMode="numeric" value={String(s.quotaGb)} aria-label="Size limit in GB" onCommit={commitQuota} />
              <span className="muted">GB</span>
            </Opt>
            <Opt title="Tell me when recording starts" hint="A Windows notice when a recording starts, is saved, or fails.">
              <Switch label="Tell me when recording starts" checked={s.notify} onChange={(v) => set("notify", v)} />
            </Opt>
            <Opt title="Save highlights as clips" hint="Multikills, aces and big fights, saved as short clips after the game. Up to six a game.">
              <Switch label="Save highlights as clips" checked={s.autoHighlights} onChange={(v) => set("autoHighlights", v)} />
            </Opt>
            <Opt title="Keep only the highlights" hint="A day after each game, the full recording is deleted and its highlight reel stays. Kept games are left alone.">
              <Switch label="Keep only the highlights" checked={s.highlightsOnly} onChange={setHighlightsOnly} />
            </Opt>
            <Opt title="Bookmark key" hint="Press it in game to mark a moment, like F8. League still gets the key, so pick one it doesn't use.">
              <Field className="hotkey" type="text" value={s.bookmarkHotkey} placeholder="Off" aria-label="Bookmark key" onCommit={(v) => set("bookmarkHotkey", v.trim(), 0)} />
            </Opt>
          </Section>

          <Section id="set-games" icon={ListVideo} title="Which games">
            <Opt title="Ask League which queue it is" hint="One read-only question to the League client as a game starts. Without it, every game is recorded.">
              <Switch label="Ask League which queue it is" checked={s.useClientApi} onChange={(v) => set("useClientApi", v)} />
            </Opt>
            <Opt title="Queues to record" hint={s.useClientApi ? undefined : "Every queue is recorded while the question above is off."} wide>
              <div className="qchips" role="group" aria-label="Queues to record">
                {QUEUES.map(([key, label]) => {
                  const on = s.useClientApi ? s.queues[key] : true;
                  return (
                    <button key={key} className="qchip" disabled={!s.useClientApi} aria-pressed={on} onClick={() => set("queues", { ...latest.current.queues, [key]: !latest.current.queues[key] })}>
                      {on && <Check size={13} strokeWidth={2.5} aria-hidden />}
                      {label}
                    </button>
                  );
                })}
              </div>
            </Opt>
          </Section>

          <Section id="set-video" icon={Video} title="Video">
            <Opt title="Resolution" hint="Scaled down on the graphics card while recording.">
              <div className="seg" role="group" aria-label="Resolution">
                {(
                  [
                    ["native", "Native"],
                    ["1440", "1440p"],
                    ["1080", "1080p"],
                    ["720", "720p"],
                  ] as const
                ).map(([v, label]) => (
                  <button key={v} aria-pressed={s.resolution === v} onClick={() => set("resolution", v)}>
                    {label}
                  </button>
                ))}
              </div>
            </Opt>
            <Opt title="Frame rate" hint="More frames step more smoothly and take more space.">
              <div className="seg" role="group" aria-label="Frame rate">
                {[30, 60, 120].map((f) => (
                  <button key={f} aria-pressed={s.fps === f} onClick={() => set("fps", f)}>
                    {f} fps
                  </button>
                ))}
              </div>
            </Opt>
            <Opt title="Format" hint="H.264 plays everywhere. The others are smaller but don't play on every device.">
              <div className="seg" role="group" aria-label="Format">
                {(
                  [
                    ["h264", "H.264"],
                    ["hevc", "H.265"],
                    ["av1", "AV1"],
                  ] as const
                ).map(([v, label]) => (
                  <button key={v} aria-pressed={s.codec === v} onClick={() => set("codec", v)}>
                    {label}
                  </button>
                ))}
              </div>
            </Opt>
            <Opt title="Encoder" hint="Automatic uses your graphics card, which costs the game almost nothing.">
              <Select
                label="Encoder"
                value={s.encoder}
                onChange={(v) => set("encoder", v)}
                placement="bottom-end"
                options={[
                  { value: "auto", label: "Automatic" },
                  { value: "nvenc", label: "NVIDIA" },
                  { value: "amf", label: "AMD" },
                  { value: "qsv", label: "Intel" },
                  { value: "cpu", label: "Processor", hint: "Slow, takes real processor time" },
                ]}
              />
            </Opt>
            <Opt title="Quality" hint={`Lower is sharper and bigger. About ${perHour} GB an hour at ${s.resolution === "native" ? "1440p" : `${s.resolution}p`}.`}>
              <input type="range" min={18} max={32} value={s.quality} aria-label="Quality" onChange={(e) => set("quality", Number(e.target.value), 600)} />
              <span className="num qval">{s.quality}</span>
            </Opt>
          </Section>

          <Section id="set-sound" icon={AudioLines} title="Sound and input">
            <Opt title="Record Discord" hint="On its own track, so you can mute it while reviewing.">
              <Switch label="Record Discord" checked={s.recordDiscord} onChange={(v) => set("recordDiscord", v)} />
            </Opt>
            <Opt title="Record your microphone" hint="The whole game, even while you're muted in Discord.">
              <Switch label="Record your microphone" checked={s.recordMic} onChange={(v) => set("recordMic", v)} />
            </Opt>
            {s.recordMic && (
              <Opt title="Microphone">
                <Select label="Microphone" value={s.micDevice} onChange={(v) => set("micDevice", v)} placement="bottom-end" options={micOptions} className="micsel" />
              </Opt>
            )}
            <Opt title="Record the mouse" hint="For the cursor trail and clicks a minute.">
              <Switch label="Record the mouse" checked={s.mouseTracking} onChange={(v) => set("mouseTracking", v)} />
            </Opt>
            <Opt title="Record game keys" hint="Which keys you held while League was in front, never while chat is open. Stays on this PC.">
              <Switch label="Record game keys" checked={s.keyTracking} onChange={(v) => set("keyTracking", v)} />
            </Opt>
            {s.keyTracking && (
              <div className="keymap">
                <div className="keymap-head">
                  <div>
                    <b>Keys on the overlay</b>
                    <small>{s.keyMap.length === 0 ? "The standard 20: Q W E R D F, 1 to 7 and B, Shift Ctrl A S Tab Space." : `${plural(s.keyMap.length, "key")} of your own, up to 32.`}</small>
                  </div>
                  {s.keyMap.length === 0 ? (
                    <button className="btn" onClick={() => set("keyMap", DEFAULT_KEY_SLOTS.map((k) => ({ ...k })))}>
                      Choose keys
                    </button>
                  ) : (
                    <div className="ctl">
                      <button className="btn" disabled={s.keyMap.length >= 32} onClick={() => set("keyMap", [...latest.current.keyMap, { vk: "T", label: "T", row: 0 }])}>
                        <Plus size={14} aria-hidden />
                        Add a key
                      </button>
                      <button className="btn quiet" onClick={() => set("keyMap", [])}>
                        Back to the standard keys
                      </button>
                    </div>
                  )}
                </div>
                {s.keyMap.length > 0 && (
                  <div className="keymap-grid">
                    {s.keyMap.map((slot, i) => (
                      <div className="keymap-row" key={i}>
                        <Field
                          type="text"
                          value={slot.vk}
                          placeholder="Key, like T or Mouse4"
                          aria-label="Key"
                          onCommit={(v) => set("keyMap", latest.current.keyMap.map((x, j) => (j === i ? { ...x, vk: v.trim() } : x)), 0)}
                        />
                        <Field
                          type="text"
                          value={slot.label}
                          placeholder="Label"
                          aria-label="Label on the overlay"
                          onCommit={(v) => set("keyMap", latest.current.keyMap.map((x, j) => (j === i ? { ...x, label: v } : x)), 0)}
                        />
                        <Select
                          small
                          label="Overlay row"
                          value={slot.row}
                          onChange={(row) => set("keyMap", latest.current.keyMap.map((x, j) => (j === i ? { ...x, row } : x)))}
                          options={[
                            { value: 0, label: "Row 1" },
                            { value: 1, label: "Row 2" },
                            { value: 2, label: "Row 3" },
                          ]}
                        />
                        <button
                          className="btn sm sq quiet danger"
                          aria-label={`Remove ${slot.label || slot.vk}`}
                          onClick={() => set("keyMap", latest.current.keyMap.filter((_, j) => j !== i))}
                        >
                          <X size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Section>

          <Section id="set-team" icon={Users} title="Teammates">
            <div className="pairing first">
              <div className="line">
                <span>Your friend code</span>
                <code>{share?.code ? shortCode(share.code) : "…"}</code>
                <button
                  className="btn"
                  disabled={!share?.code}
                  onClick={() => {
                    navigator.clipboard
                      ?.writeText(share!.code)
                      .then(() => setCopied(true))
                      .catch(() => toast.show({ kind: "error", text: "Couldn't copy the code" }));
                  }}
                >
                  {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="muted">
                Send it to a teammate. When one of you adds the other's code, the other sees a request here. After that, each of you can watch the other's view of games you both
                recorded.
              </p>
              {share?.error && <p className="fres bad">{share.error}</p>}
            </div>
            {(share?.requests ?? [])
              .filter((r) => !s.friends.some((f) => f.code.trim().toLowerCase() === r.code.toLowerCase()))
              .map((r) => (
                <div className="pairing request" key={r.code}>
                  <div className="line">
                    <span>
                      <b>{r.name || "Someone"}</b> wants to connect <span className="muted">(code {shortCode(r.code)})</span>
                    </span>
                    <button className="btn primary" onClick={() => addFriend({ name: r.name || "Teammate", code: r.code })}>
                      <Plus size={14} aria-hidden />
                      Add as teammate
                    </button>
                  </div>
                  <p className="muted">Only add people you know. Check that the start of the code matches what their app shows.</p>
                </div>
              ))}
            <Opt title="Your teammates" hint="Only they can watch your recordings: the video with game sound and your cursor, never your Discord or microphone." wide />
            {s.friends.map((f, i) => (
              <FriendRow
                key={`${i}:${f.code}`}
                friend={f}
                onRename={(name) => change({ ...latest.current, friends: latest.current.friends.map((x, j) => (j === i ? { ...x, name } : x)) }, 0)}
                onRemove={() => removeFriend(i)}
                beforeCheck={flush}
              />
            ))}
            <AddFriend onAdd={addFriend} />
            <Opt title="Let teammates watch my recordings" hint="Switch off to keep watching theirs without sharing yours.">
              <Switch label="Let teammates watch my recordings" checked={s.shareWithFriends} onChange={(v) => set("shareWithFriends", v)} />
            </Opt>
            <Opt title="Make smaller copies for teammates" hint="A 1080p copy, about a fifth of the size, made while no game is running. Yours stays as it is.">
              <Switch label="Make smaller copies for teammates" checked={s.reviewCopies} onChange={(v) => set("reviewCopies", v)} />
            </Opt>
            <Opt title="Keep teammates' views on this PC" hint="So they play when teammates are offline. Counts towards your size limit.">
              <Switch label="Keep teammates' views on this PC" checked={s.keepTeammateViews} onChange={(v) => set("keepTeammateViews", v)} />
            </Opt>
            <Opt title="Share my notes and drawings" hint="With teammates who recorded the same game, along with when you were talking (never the sound).">
              <Switch label="Share my notes and drawings" checked={s.shareNotes} onChange={(v) => set("shareNotes", v)} />
            </Opt>
            <Opt title="Your name" hint="What teammates see when they check the connection.">
              <Field className="namefield" type="text" value={s.shareName} aria-label="Your name" onCommit={(v) => set("shareName", v.trim(), 0)} />
            </Opt>
          </Section>

          <Section
            id="set-ai"
            icon={Sparkles}
            title="AI review"
            intro={
              <div className="promise">
                <p>
                  <b>Off until you switch it on.</b> After a game, the scoreboard and a short clip of each of your deaths go to Google's Gemini. Back come a written review, a hint for each
                  death about what went wrong, and a title for every player. Your microphone and Discord are never sent.
                </p>
                <details>
                  <summary>What exactly is sent, and what it costs</summary>
                  <p>
                    Each death is a 17-second clip at 720p with game sound only. A team review of a fight sends the same seconds from your view and each teammate's. It runs after the game,
                    never during one, and costs a cent or two a game on a paid key. On Google's free tier, Google may use what is sent to improve its products.
                  </p>
                  <p>Every player gets a title from the game's own numbers even with this off.</p>
                </details>
              </div>
            }
          >
            <Opt title="Gemini API key" hint="Your own key, from aistudio.google.com. Kept on this PC and sent only to Google." wide>
              <Field
                type="password"
                autoComplete="off"
                value={s.geminiKey}
                placeholder="Paste your key"
                aria-label="Gemini API key"
                onCommit={(v) => change({ ...latest.current, geminiKey: v.trim(), aiReview: v.trim() ? latest.current.aiReview : false }, 0)}
              />
            </Opt>
            <Opt title="Review my games with AI" hint={s.geminiKey.trim() ? "After each game by itself, and from the Review tab for older ones." : "Add a key above first."}>
              <Switch label="Review my games with AI" checked={s.aiReview} disabled={!s.geminiKey.trim()} onChange={(v) => set("aiReview", v)} />
            </Opt>
          </Section>

          <Section id="set-backup" icon={Archive} title="League backups">
            <Opt title="Back up when a game starts" hint="Saves League's key bindings and settings when they've changed. The last 20 are kept.">
              <Switch label="Back up when a game starts" checked={s.autoBackupLeague} onChange={(v) => set("autoBackupLeague", v)} />
            </Opt>
            <form
              className="opt wide backupnow"
              onSubmit={(e) => {
                e.preventDefault();
                createBackup();
              }}
            >
              <div className="ol">
                Back up now
                <small>Handy before a patch, or when you switch accounts.</small>
              </div>
              <div className="ctl">
                <input
                  className="field-input"
                  type="text"
                  placeholder="Name it, like Main account before patch"
                  value={backupLabel}
                  onChange={(e) => setBackupLabel(e.target.value)}
                  aria-label="Name for the backup"
                />
                <button className="btn" type="submit" disabled={backupBusy}>
                  {backupBusy && <Loader2 size={14} className="spin" aria-hidden />}
                  Back up
                </button>
              </div>
            </form>
            <div className="backups">
              {backups === null ? (
                <Skeleton h={52} r={8} />
              ) : backups.length === 0 ? (
                <p className="muted">No backups yet.</p>
              ) : (
                backups.map((b) => (
                  <div className="backup-row" key={b.id}>
                    <div className="backup-info">
                      <b>
                        {b.label || (b.auto ? "Automatic backup" : "Backup")}
                        {b.auto && <span className="badge">Auto</span>}
                      </b>
                      <small>
                        {new Date(b.createdAt).toLocaleString()} · {b.files.join(", ")} · {bytes(b.sizeBytes)}
                      </small>
                    </div>
                    <button className="btn sm" disabled={backupBusy} onClick={() => restoreBackup(b)} title="Copy these files back into League's Config folder">
                      <RotateCcw size={13} aria-hidden />
                      Restore
                    </button>
                    <button className="btn sm sq quiet danger" disabled={backupBusy} aria-label="Delete backup" title="Delete" onClick={() => removeBackup(b)}>
                      <X size={15} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </Section>

          <Section id="set-updates" icon={Download} title="Updates">
            <Opt
              title={`Version ${update?.current ?? "…"}`}
              hint={
                update?.installing
                  ? "Updating now. The app restarts by itself."
                  : update?.available
                    ? `Version ${update.available.version} is ready. ${update.available.notes}`
                    : update?.error
                      ? `Couldn't check: ${update.error}`
                      : update?.checked
                        ? "This is the newest version."
                        : "Not checked yet."
              }
            >
              {update?.available && !update.installing && (
                <button
                  className="btn primary"
                  onClick={() =>
                    api
                      .updateInstall()
                      .catch((e) => toast.show({ kind: "error", text: "The update didn't install", detail: humanError(e) }))
                      .then(() => api.updateInfo().then(setUpdate))
                  }
                >
                  Update now
                </button>
              )}
              <button
                className="btn"
                disabled={checking}
                onClick={() => {
                  setChecking(true);
                  api
                    .updateCheck()
                    .then(setUpdate)
                    .catch((e) => toast.show({ kind: "error", text: "Couldn't check for updates", detail: humanError(e) }))
                    .finally(() => setChecking(false));
                }}
              >
                {checking && <Loader2 size={14} className="spin" aria-hidden />}
                {checking ? "Checking" : "Check now"}
              </button>
            </Opt>
            <Opt title="Update by itself" hint="Installs while the window is closed and no game is running. Off: you're only told when one is ready.">
              <Switch label="Update by itself" checked={s.autoUpdate} onChange={(v) => set("autoUpdate", v)} />
            </Opt>
          </Section>

          <Section
            id="set-advanced"
            icon={Wrench}
            title="Advanced"
            intro={
              <div className="promise">
                <p>
                  <b>It stays out of the game's way.</b> The picture goes straight from the screen to the graphics card's encoder, the recorder runs at low priority, and nothing is drawn
                  over the game.
                </p>
                <p>
                  <b>Safe with anti-cheat.</b> The game is never opened, injected into or hooked. Rewatch reads the screen, the sound Windows already mixes per app, the cursor, and the
                  live game data Riot provides for tools.
                </p>
              </div>
            }
          >
            <Opt id="opt-ffmpeg" title="FFmpeg" hint={env ? (env.ffmpegVersion ? `Using ${env.ffmpeg}` : "Not found. Recording needs it.") : "Looking…"} wide>
              <Field type="text" value={s.ffmpegPath} placeholder={env?.ffmpeg ? `Found by itself: ${env.ffmpeg}` : "Path to ffmpeg.exe"} aria-label="FFmpeg path" onCommit={(v) => set("ffmpegPath", v.trim(), 0)} />
            </Opt>
            <Opt id="opt-league" title="League folder" hint={env?.leagueDir ? `Using ${env.leagueDir}` : "Not found. Enter the folder League is installed in."} wide>
              <Field
                type="text"
                value={s.leagueDir}
                placeholder={env?.leagueDir ? `Found by itself: ${env.leagueDir}` : "Like C:\\Riot Games\\League of Legends"}
                aria-label="League folder"
                onCommit={(v) => set("leagueDir", v.trim(), 0)}
              />
              <button
                className="btn"
                onClick={async () => {
                  const d = await pickFolder(latest.current.leagueDir || env?.leagueDir || undefined);
                  if (d) set("leagueDir", d, 0);
                }}
              >
                Browse
              </button>
            </Opt>
          </Section>
        </div>
      </div>
    </div>
  );
}
