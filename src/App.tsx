import { BarChart3, Clapperboard, Download, LoaderCircle, RefreshCw, SlidersHorizontal, Square, TriangleAlert, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, onEvent } from "./api";
import { acceptOffer, gameLine } from "./Coaching";
import { clock, toReview } from "./format";
import { Games } from "./Games";
import { Logo } from "./icons";
import { leftSetup, Onboarding, type SetupStep } from "./Onboarding";
import { Player } from "./Player";
import { SettingsPage } from "./SettingsPage";
import { Trends } from "./Trends";
import type { CoachingEvent, MatchSummary, Settings, Status, UpdateInfo, WatchPeer } from "./types";
import { humanError, Popover, useToast } from "./ui";

/** One stop in a walk-through that can go across games, like "every death to no vision". */
export interface PlaylistItem {
  matchId: string;
  t: number;
  start: number;
  end: number;
  label: string;
}

export interface Playlist {
  title: string;
  items: PlaylistItem[];
  index: number;
  /** Arrived here going backwards, so a game that can't be shown is skipped the same way. */
  back?: boolean;
  /** Games skipped in a row on the way here, for one message instead of one each. */
  skipped?: number;
}

type View =
  | { name: "library" }
  | { name: "trends" }
  | { name: "player"; id: string; together?: boolean; playlist?: Playlist | null; start?: "deaths" }
  | { name: "settings" };

// A version that only changes the interface is put in place while the app runs (src-tauri/src/ui.rs), and the
// page reloads to show it. The screen that was open comes back afterwards.
const RELOAD_KEY = "rewatch.reload";

interface Resume {
  view?: View;
  /** The player asked for the update, so it's announced once it shows. */
  updated?: { version: string; notes: string };
}

// Read once per page load.
const resume: Resume = (() => {
  try {
    const saved = sessionStorage.getItem(RELOAD_KEY);
    sessionStorage.removeItem(RELOAD_KEY);
    return saved ? (JSON.parse(saved) as Resume) : {};
  } catch {
    return {};
  }
})();

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  return <span className="num">{clock((Date.now() - since) / 1000)}</span>;
}

export default function App() {
  const toast = useToast();
  const [view, setView] = useState<View>(() => resume.view ?? { name: "library" });
  const [status, setStatus] = useState<Status | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [allMatches, setMatches] = useState<MatchSummary[] | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateLater, setUpdateLater] = useState<string | null>(null);
  /** "Update now" or "Reload now" was pressed and is under way. */
  const [updating, setUpdating] = useState(false);
  const [peers, setPeers] = useState<WatchPeer[]>([]);
  const [declined, setDeclined] = useState<string[]>([]);
  /** Games deleted a moment ago, hidden while their "Undo" is still offered. */
  const [hidden, setHidden] = useState<string[]>([]);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  /** Games whose video was deleted a moment ago, shown without it while their "Undo" is still offered. */
  const [videoGone, setVideoGone] = useState<string[]>([]);
  /** The recording being watched together right now, if any. */
  const [session, setSession] = useState<string | null>(null);
  const [updOpen, setUpdOpen] = useState(false);
  const [invOpen, setInvOpen] = useState(false);
  /** The setup guide while it's open: a first setup, or opened again from Settings or the library. */
  const [setup, setSetup] = useState<{ first: boolean; step?: SetupStep } | null>(null);
  const openSetup = useCallback((step?: SetupStep) => setSetup({ first: false, step }), []);
  /** Goes up as the guide closes: Settings keeps its own copy of the settings, so it starts again from what the guide saved. */
  const [settingsRev, setSettingsRev] = useState(0);
  const updBtn = useRef<HTMLButtonElement>(null);
  const invBtn = useRef<HTMLButtonElement>(null);

  // Only the newest request may set the list, so a slow answer can't bring back a game deleted since.
  const listSeq = useRef(0);
  const refreshMatches = useCallback(() => {
    const n = ++listSeq.current;
    return api.listMatches().then(
      (list) => {
        if (n === listSeq.current) setMatches(list);
      },
      () => {
        if (n === listSeq.current) setMatches((m) => m ?? []);
      },
    );
  }, []);
  const refreshStatus = useCallback(() => {
    api.getStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    api.getSettings().then((s) => {
      // A new PC starts with the setup guide, and so does one where it was left halfway the last time. It opens
      // together with the settings arriving, so nothing meant for the app shows up first.
      const left = leftSetup();
      if (left || !s.recordingsDir) setSetup({ first: true, step: left ?? undefined });
      setSettings(s);
    });
    refreshMatches();
    refreshStatus();
    const iv = setInterval(refreshStatus, 1500);
    const offA = onEvent("status", refreshStatus);
    const offB = onEvent("library-changed", refreshMatches);
    const loadUpdate = () => api.updateInfo().then(setUpdate).catch(() => {});
    loadUpdate();
    const offC = onEvent("update", loadUpdate);
    const slow = setInterval(loadUpdate, 60000);
    // Teammates who have a game open: offered as "watch together".
    const loadPeers = () => api.watchPeers().then(setPeers).catch(() => {});
    loadPeers();
    const mid = setInterval(loadPeers, 3000);
    return () => {
      clearInterval(iv);
      clearInterval(slow);
      clearInterval(mid);
      offA();
      offB();
      offC();
    };
  }, [refreshMatches, refreshStatus]);

  const saveSettings = async (next: Settings) => {
    const saved = await api.saveSettings(next);
    setSettings(saved);
    refreshMatches();
  };
  /** A change to the settings made outside the Settings page, which keeps its own copy: it starts again from this one. */
  const saveFromElsewhere = async (next: Settings) => {
    await saveSettings(next);
    setSettingsRev((n) => n + 1);
  };
  const settingsNow = useRef(settings);
  settingsNow.current = settings;
  const saveNow = useRef(saveFromElsewhere);
  saveNow.current = saveFromElsewhere;

  // Games sent for review: someone asking to send one, one arriving here, one of mine arriving at a coach's.
  useEffect(
    () =>
      onEvent<CoachingEvent>("coaching", ({ kind, what }) => {
        const who = what.name || "Someone";
        if (kind === "offer" && what.code) {
          const code = what.code;
          toast.show({
            id: `offer-${code}`,
            kind: "info",
            text: `${who} wants to send you a game to review`,
            detail: `${gameLine(what.game)}. Only accept people you know.`,
            ms: 20000,
            actions: [
              {
                label: "Accept",
                run: () => {
                  const s = settingsNow.current;
                  if (s) saveNow.current(acceptOffer(s, { code, name: what.name ?? "" })).catch((e) => toast.show({ kind: "error", text: `That did not go through. ${humanError(e)}` }));
                },
              },
              { label: "See it", run: () => setView({ name: "library" }) },
            ],
          });
        } else if (kind === "received" && what.id) {
          const id = what.id;
          toast.show({ id: `got-${id}`, kind: "success", text: `${who} sent you a game to review`, detail: gameLine(what.game), ms: 15000, actions: [{ label: "Open", run: () => setView({ name: "player", id }) }] });
        } else if (kind === "share" && what.state === "received") {
          const coach = settingsNow.current?.coaches.find((f) => f.code === what.code)?.name || settingsNow.current?.friends.find((f) => f.code === what.code)?.name;
          toast.show({ kind: "success", text: `${coach || "Your coach"} has your game`, detail: "What they write and draw on it shows up in your recording." });
        }
      }),
    [toast],
  );

  const matches = useMemo(
    () =>
      allMatches
        ? allMatches
            .filter((m) => !hidden.includes(m.id))
            .map((m) => (videoGone.includes(m.id) && m.hasVideo !== false ? { ...m, hasVideo: false, videoBytes: 0, sizeBytes: m.sizeBytes - (m.videoBytes ?? 0), videoDeletedBy: "you" as const } : m))
        : null,
    [allMatches, hidden, videoGone],
  );
  // The player's own games, and the games students sent. Only the first count as theirs anywhere.
  const own = useMemo(() => (matches ? matches.filter((m) => !m.from) : null), [matches]);
  const sent = useMemo(() => (matches ?? []).filter((m) => !!m.from), [matches]);
  const recording = status?.state === "recording" || status?.state === "starting";
  const saving = status?.state === "finalizing";
  const stop = async () => {
    await api.stopRecording().catch((e) => toast.show({ kind: "error", text: humanError(e) }));
    refreshStatus();
    refreshMatches();
  };
  const startManual = async () => {
    await api.startManualRecording().catch((e) => toast.show({ kind: "error", text: humanError(e) }));
    refreshStatus();
  };

  /** Delete games after a few seconds, unless "Undo" is pressed first. Closing the app in between keeps them. */
  const removeGames = useCallback(
    (ids: string[], what?: string) => {
      if (!ids.length) return;
      setHidden((h) => [...h, ...ids]);
      let undone = false;
      toast.show({
        text: what ? `Deleted ${what}` : ids.length === 1 ? "Deleted the game" : `Deleted ${ids.length} games`,
        kind: "info",
        ms: 7000,
        actions: [
          {
            label: "Undo",
            run: () => {
              undone = true;
              setHidden((h) => h.filter((x) => !ids.includes(x)));
            },
          },
        ],
        onClose: async () => {
          if (undone) return;
          const failed: string[] = [];
          for (const id of ids) {
            await api.deleteMatch(id).catch((e) => {
              failed.push(id);
              toast.show({ kind: "error", text: `Could not delete a game. ${humanError(e)}` });
            });
          }
          // A game that could not be deleted comes back; the rest stay hidden until the list no longer has them.
          if (failed.length) setHidden((h) => h.filter((x) => !failed.includes(x)));
          refreshMatches();
        },
      });
    },
    [toast, refreshMatches],
  );
  useEffect(() => {
    if (!allMatches) return;
    setHidden((h) => {
      const next = h.filter((x) => allMatches.some((m) => m.id === x));
      return next.length === h.length ? h : next;
    });
    // Once the list itself has a game without its video, it no longer needs marking here.
    setVideoGone((g) => {
      const next = g.filter((x) => allMatches.some((m) => m.id === x && m.hasVideo !== false));
      return next.length === g.length ? g : next;
    });
  }, [allMatches]);

  /** Delete games' videos after a few seconds, unless "Undo" is pressed first. Their stats, notes and LP stay. */
  const removeVideos = useCallback(
    (ids: string[], what?: string) => {
      if (!ids.length) return;
      setVideoGone((g) => [...g, ...ids]);
      let undone = false;
      toast.show({
        text: what ? `Deleted the video of ${what}` : ids.length === 1 ? "Deleted the video" : `Deleted ${ids.length} videos`,
        detail: ids.length === 1 ? "The game's stats, notes and LP stay." : "The games' stats, notes and LP stay.",
        kind: "info",
        ms: 7000,
        actions: [
          {
            label: "Undo",
            run: () => {
              undone = true;
              setVideoGone((g) => g.filter((x) => !ids.includes(x)));
            },
          },
        ],
        onClose: async () => {
          if (undone) return;
          const back: string[] = [];
          for (const id of ids) {
            // Being deleted whole right now, video and all; if that is undone, the video is still there.
            if (hiddenRef.current.includes(id)) {
              back.push(id);
              continue;
            }
            await api.deleteVideo(id).catch((e) => {
              back.push(id);
              toast.show({ kind: "error", text: `Could not delete a video. ${humanError(e)}` });
            });
          }
          // A video that is still there shows again; the rest stay marked until the list has them without.
          if (back.length) setVideoGone((g) => g.filter((x) => !back.includes(x)));
          refreshMatches();
        },
      });
    },
    [toast, refreshMatches],
  );

  /** The walk-through moved on to another game, or ended. Stable, so the player doesn't redo its work on every redraw. */
  const onPlaylist = useCallback((p: Playlist | null) => {
    setView((v) => {
      if (v.name !== "player") return v;
      if (!p) return { name: "player", id: v.id, together: v.together };
      return { name: "player", id: p.items[p.index].matchId, playlist: p };
    });
  }, []);

  // A problem the recorder ran into: once per distinct message.
  const lastError = status?.lastError ?? null;
  const shownError = useRef<string | null>(null);
  useEffect(() => {
    if (!lastError || lastError === shownError.current) return;
    shownError.current = lastError;
    const text = humanError(lastError);
    toast.show({ id: "recorder-error", kind: "error", text, detail: text.replace(/\.$/, "") === lastError.replace(/\.$/, "") ? undefined : lastError });
  }, [lastError, toast]);

  // Discord not running while its track is being recorded: say so once per recording.
  const warnedDiscord = useRef<number | null>(null);
  const discordSilent = recording && !!settings?.recordDiscord && status?.discordRunning === false;
  useEffect(() => {
    if (!discordSilent || !status?.startedEpochMs || warnedDiscord.current === status.startedEpochMs) return;
    warnedDiscord.current = status.startedEpochMs;
    toast.show({ kind: "info", text: "Discord is not running", detail: "Its track in this recording will be silent. Open Discord and it is picked up from then on." });
  }, [discordSilent, status?.startedEpochMs, toast]);

  // The page reloads for a newer interface. The app asks while the window is closed, and the page says not yet
  // while a job or an Undo is still running (it's asked again a minute later). Asked by the player, it goes ahead.
  const viewNow = useRef(view);
  viewNow.current = view;
  const updateNow = useRef(update);
  updateNow.current = update;
  useEffect(() => {
    window.__rewatchReload = (asked) => {
      if (!asked && toast.pending()) return false;
      const v = viewNow.current;
      // Back to the same screen, but watching together isn't rejoined by itself.
      const keep: View = v.name === "player" ? { name: "player", id: v.id, playlist: v.playlist ?? null } : v;
      const applied = updateNow.current?.applied;
      const updated = asked && applied ? { version: applied.version, notes: applied.notes } : undefined;
      try {
        sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ view: keep, updated } satisfies Resume));
      } catch {
        // Then it opens on the library.
      }
      // Edits are saved half a second after the last change; those get to go through. (When the app asks, the
      // window has been closed for a few seconds already.)
      window.setTimeout(() => location.reload(), asked ? 800 : 0);
      return true;
    };
    return () => {
      delete window.__rewatchReload;
    };
  }, [toast]);
  useEffect(() => {
    if (resume.updated) toast.show({ id: "updated", kind: "success", text: `Updated to version ${resume.updated.version}`, detail: resume.updated.notes || undefined });
  }, [toast]);

  // A newer version: a quiet chip in the bar. One whose interface is in place already offers a reload instead.
  const newer = update?.available && update.available.version !== updateLater ? update.available : null;
  const inPlace = update?.reload && update.applied && update.applied.version !== updateLater ? update.applied : null;
  const busyNow = recording || saving || !!status?.gameRunning;
  const reloadNow = () => {
    setUpdOpen(false);
    setUpdating(true);
    if (!window.__rewatchReload?.(true)) location.reload();
  };
  const install = () => {
    setUpdOpen(false);
    setUpdating(true);
    api
      .updateInstall()
      .then((info) => {
        setUpdate(info);
        // Only the interface changed, and it's in place: a reload shows it. Otherwise the installer is running.
        if (info.reload) reloadNow();
        else setUpdating(false);
      })
      .catch((e) => {
        setUpdating(false);
        toast.show({ kind: "error", text: `The update did not install. ${humanError(e)}` });
        api.updateInfo().then(setUpdate);
      });
  };

  // A teammate reviewing a game I also recorded, and I am not in it with them yet.
  const invite = peers.find((p) => p.matchId && !declined.includes(p.code + p.matchId) && p.matchId !== session);
  const inviteName = invite ? settings?.friends.find((f) => f.code === invite.code)?.name || invite.name || "A teammate" : "";
  const inviteGame = invite ? matches?.find((m) => m.id === invite.matchId) : undefined;
  // Mine, or one a student sent me: then it is theirs, and usually they are the one going through it.
  const inviteChamp = inviteGame?.game?.me?.champion;
  const inviteWhat = inviteGame?.from
    ? `the ${inviteChamp ? `${inviteChamp} ` : ""}game ${inviteGame.from.code === invite?.code ? "they" : inviteGame.from.name || "a student"} sent you`
    : inviteChamp
      ? `your ${inviteChamp} game`
      : "a game you both recorded";
  // Inside that same game the player offers joining in its own header.
  const inviteHere = !!invite && view.name === "player" && view.id === invite.matchId;
  const watchTogether = (id: string) => {
    setInvOpen(false);
    setView({ name: "player", id, together: true });
  };
  const announced = useRef<string[]>([]);
  useEffect(() => {
    if (!invite) return;
    const key = invite.code + invite.matchId;
    // Already looking at that game: its header offers joining, so the toast can go.
    if (inviteHere) return toast.dismiss(`invite-${key}`);
    // Not over the setup guide, where "Watch together" would open a game behind it, nor before the settings say
    // whether the guide opens: it's said once the guide is closed.
    if (!settings || setup || announced.current.includes(key)) return;
    announced.current.push(key);
    toast.show({
      id: `invite-${key}`,
      kind: "info",
      text: `${inviteName} is reviewing ${inviteWhat}`,
      detail: "Watch it together: you pause, play and jump around as one.",
      ms: 15000,
      actions: [{ label: "Watch together", run: () => watchTogether(invite.matchId!) }],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invite?.code, invite?.matchId, inviteHere, !!settings, !!setup]);

  const reviewCount = toReview(own).length;
  const state = saving ? "saving" : recording ? "rec" : status?.gameRunning ? "game" : settings?.autoRecord === false ? "off" : "";
  const stateText = saving
    ? "Saving the recording"
    : recording
      ? status?.mode === "manual"
        ? "Recording your screen"
        : status?.mode === "draft"
          ? "Recording champion select"
          : `Recording ${status?.queueName ?? "the game"}`
      : status?.gameRunning
        ? "In game"
        : settings?.autoRecord === false
          ? "Auto-record is off"
          : "Ready to record";
  const goTo = (name: "library" | "trends" | "settings") => setView({ name } as View);

  return (
    <div className="shell">
      <header className="topbar" inert={!!setup}>
        <div className="brand">
          <Logo size={19} />
          <b>Rewatch</b>
          {update?.current && <span className="ver">{update.current}</span>}
        </div>
        <nav className="tabsbar" aria-label="Main">
          <button className="tab" aria-current={view.name === "library" || view.name === "player" ? "page" : undefined} onClick={() => goTo("library")}>
            <Clapperboard size={16} aria-hidden />
            Games
            {reviewCount > 0 && (
              <span className="count" title={`${reviewCount} game${reviewCount === 1 ? "" : "s"} from this week to review`}>
                {reviewCount > 9 ? "9+" : reviewCount}
              </span>
            )}
          </button>
          <button className="tab" aria-current={view.name === "trends" ? "page" : undefined} onClick={() => goTo("trends")}>
            <BarChart3 size={16} aria-hidden />
            Trends
          </button>
          <button className="tab" aria-current={view.name === "settings" ? "page" : undefined} onClick={() => goTo("settings")}>
            <SlidersHorizontal size={16} aria-hidden />
            Settings
          </button>
        </nav>
        <div className="right">
          {invite && !inviteHere && (
            <>
              <button ref={invBtn} className="chipbtn invite" aria-expanded={invOpen} aria-label={`${inviteName} is reviewing`} onClick={() => setInvOpen((o) => !o)}>
                <Users size={14} aria-hidden />
                <span>
                  {inviteName}
                  <span className="long"> is reviewing</span>
                </span>
              </button>
              <Popover anchor={invBtn} open={invOpen} onClose={() => setInvOpen(false)} placement="bottom-end" label="Watch together">
                <div className="pop-pad">
                  <h3>
                    {inviteName} is reviewing {inviteWhat}
                  </h3>
                  <p>
                    {inviteGame?.game?.queueName ? `${inviteGame.game.queueName}. ` : ""}Watch it together: you see each other's place in the game, and pausing or jumping
                    moves you both.
                  </p>
                  <div className="pop-acts">
                    <button
                      className="btn quiet"
                      onClick={() => {
                        setInvOpen(false);
                        setDeclined((d) => [...d, invite.code + invite.matchId]);
                      }}
                    >
                      Not now
                    </button>
                    <button className="btn primary" onClick={() => watchTogether(invite.matchId!)}>
                      Watch together
                    </button>
                  </div>
                </div>
              </Popover>
            </>
          )}
          {update?.installing || updating ? (
            <span className="chipbtn" role="status">
              <LoaderCircle size={14} className="spin" aria-hidden />
              Updating
            </span>
          ) : inPlace ? (
            <>
              <button ref={updBtn} className="chipbtn update" aria-expanded={updOpen} aria-label={`Reload to show version ${inPlace.version}`} title={`Version ${inPlace.version} is ready`} onClick={() => setUpdOpen((o) => !o)}>
                <RefreshCw size={14} aria-hidden />
                <span>Reload</span>
              </button>
              <Popover anchor={updBtn} open={updOpen} onClose={() => setUpdOpen(false)} placement="bottom-end" label="Update">
                <div className="pop-pad">
                  <h3>Version {inPlace.version} is ready</h3>
                  {inPlace.notes && <p>{inPlace.notes}</p>}
                  <p className="muted">It's in place: reload the window to see it. That takes a moment, and recording carries on. Otherwise it's there the next time you open the window.</p>
                  <div className="pop-acts">
                    <button
                      className="btn quiet"
                      onClick={() => {
                        setUpdOpen(false);
                        setUpdateLater(inPlace.version);
                      }}
                    >
                      Later
                    </button>
                    <button className="btn primary" onClick={reloadNow}>
                      Reload now
                    </button>
                  </div>
                </div>
              </Popover>
            </>
          ) : (
            newer && (
              <>
                <button ref={updBtn} className="chipbtn update" aria-expanded={updOpen} aria-label={`Update to ${newer.version}`} title={`Version ${newer.version} is ready`} onClick={() => setUpdOpen((o) => !o)}>
                  <Download size={14} aria-hidden />
                  <span>Update</span>
                </button>
                <Popover anchor={updBtn} open={updOpen} onClose={() => setUpdOpen(false)} placement="bottom-end" label="Update">
                  <div className="pop-pad">
                    <h3>Version {newer.version} is ready</h3>
                    {newer.notes && <p>{newer.notes}</p>}
                    {update?.error && <p className="down">{humanError(update.error)}</p>}
                    <p className="muted">
                      {busyNow
                        ? "It installs once the game and recording are done."
                        : !newer.restart
                          ? "Only the interface changes, so it takes a moment and Rewatch keeps running: just the window reloads."
                          : update?.ready
                            ? "It's downloaded. Rewatch closes and opens again by itself, in a few seconds."
                            : "Takes about half a minute. Rewatch closes and opens again by itself."}
                    </p>
                    <div className="pop-acts">
                      <button
                        className="btn quiet"
                        onClick={() => {
                          setUpdOpen(false);
                          setUpdateLater(newer.version);
                        }}
                      >
                        Later
                      </button>
                      <button className="btn primary" disabled={busyNow} onClick={install}>
                        Update now
                      </button>
                    </div>
                  </div>
                </Popover>
              </>
            )
          )}
          <div className={`state ${state}`} role="status" title={recording ? undefined : settings?.autoRecord ? "Games are recorded automatically" : "Turn automatic recording on in Settings"}>
            {saving ? <LoaderCircle size={13} className="spin" aria-hidden /> : <i aria-hidden />}
            <span className="st-text">{stateText}</span>
            {recording && status?.startedEpochMs && <Elapsed since={status.startedEpochMs} />}
            {recording && status && status.bookmarks > 0 && (
              <span className="st-extra" title="Bookmarks made with the hotkey">
                {status.bookmarks} bookmark{status.bookmarks === 1 ? "" : "s"}
              </span>
            )}
            {discordSilent && (
              <span className="st-warn" title="Discord is not running, so its track will be silent">
                <TriangleAlert size={13} aria-label="Discord is not running" />
              </span>
            )}
            {recording && status?.mode === "draft" ? (
              <button className="st-stop" onClick={stop} title="Stop recording this champion select. It isn't kept." aria-label="Stop recording champion select">
                <Square size={9} fill="currentColor" aria-hidden />
                Stop
              </button>
            ) : recording && (
              <button className="st-stop" onClick={stop} title="Stop and save the recording" aria-label="Stop and save the recording">
                <Square size={9} fill="currentColor" aria-hidden />
                Stop
              </button>
            )}
          </div>
        </div>
      </header>

      <main className={`main ${view.name === "player" ? "" : "wash"}`} inert={!!setup}>
        {view.name === "player" ? (
          <Player
            key={view.id + (view.together ? "-together" : "")}
            id={view.id}
            friends={settings?.friends ?? []}
            settings={settings}
            onSaveSettings={saveFromElsewhere}
            matches={own ?? undefined}
            joinTogether={view.together}
            hintsOn={!!settings?.aiReview && !!settings.geminiKey.trim()}
            peers={peers}
            playlist={view.playlist ?? null}
            start={view.start}
            onPlaylist={onPlaylist}
            onTogether={(on) => setSession(on ? view.id : null)}
            onJoin={() => setView({ name: "player", id: view.id, together: true })}
            onDelete={(id, what) => {
              setView({ name: "library" });
              removeGames([id], what);
            }}
            videoGone={videoGone.includes(view.id)}
            onDeleteVideo={(id, what) => removeVideos([id], what)}
            onReviewed={refreshMatches}
            onBack={() => {
              setView({ name: "library" });
              refreshMatches();
            }}
          />
        ) : view.name === "trends" ? (
          <Trends
            onOpen={(id) => setView({ name: "player", id })}
            onPlaylist={(p) => setView({ name: "player", id: p.items[p.index].matchId, playlist: p })}
            onSettings={() => goTo("settings")}
            breakAfter={settings?.breakAfterLosses ?? 0}
          />
        ) : view.name === "settings" ? (
          settings && <SettingsPage key={settingsRev} settings={settings} onSave={saveSettings} matches={matches} onSetup={openSetup} />
        ) : (
          <Games
            matches={own}
            sent={sent}
            settings={settings}
            onSaveSettings={saveFromElsewhere}
            busy={recording || saving}
            onOpen={(id, start) => setView({ name: "player", id, start })}
            onRecord={startManual}
            onSetup={openSetup}
            onDelete={removeGames}
            onDeleteVideo={removeVideos}
            onChanged={refreshMatches}
            onSettings={() => goTo("settings")}
          />
        )}
      </main>
      {setup && settings && (
        <Onboarding
          settings={settings}
          firstRun={setup.first}
          start={setup.step}
          onSave={saveSettings}
          onClose={() => {
            setSetup(null);
            setSettingsRev((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
