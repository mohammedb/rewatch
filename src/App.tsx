import { BarChart3, Clapperboard, Download, LoaderCircle, SlidersHorizontal, Square, TriangleAlert, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, onEvent } from "./api";
import { clock, toReview } from "./format";
import { Games } from "./Games";
import { Logo } from "./icons";
import { Player } from "./Player";
import { SettingsPage } from "./SettingsPage";
import { Trends } from "./Trends";
import type { MatchSummary, Settings, Status, UpdateInfo, WatchPeer } from "./types";
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
  const [view, setView] = useState<View>({ name: "library" });
  const [status, setStatus] = useState<Status | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [allMatches, setMatches] = useState<MatchSummary[] | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateLater, setUpdateLater] = useState<string | null>(null);
  const [peers, setPeers] = useState<WatchPeer[]>([]);
  const [declined, setDeclined] = useState<string[]>([]);
  /** Games deleted a moment ago, hidden while their "Undo" is still offered. */
  const [hidden, setHidden] = useState<string[]>([]);
  /** The recording being watched together right now, if any. */
  const [session, setSession] = useState<string | null>(null);
  const [updOpen, setUpdOpen] = useState(false);
  const [invOpen, setInvOpen] = useState(false);
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
    api.getSettings().then(setSettings);
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

  const matches = useMemo(() => (allMatches ? allMatches.filter((m) => !hidden.includes(m.id)) : null), [allMatches, hidden]);
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
  }, [allMatches]);

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

  // A newer version: a quiet chip in the bar, and one toast the first time.
  const newer = update?.available && update.available.version !== updateLater ? update.available : null;
  const busyNow = recording || saving || !!status?.gameRunning;
  const install = () => {
    setUpdOpen(false);
    api
      .updateInstall()
      .then(() => api.updateInfo().then(setUpdate))
      .catch((e) => {
        toast.show({ kind: "error", text: `The update did not install. ${humanError(e)}` });
        api.updateInfo().then(setUpdate);
      });
  };

  // A teammate reviewing a game I also recorded, and I am not in it with them yet.
  const invite = peers.find((p) => p.matchId && !declined.includes(p.code + p.matchId) && p.matchId !== session);
  const inviteName = invite ? settings?.friends.find((f) => f.code === invite.code)?.name || invite.name || "A teammate" : "";
  const inviteGame = invite ? matches?.find((m) => m.id === invite.matchId) : undefined;
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
    if (announced.current.includes(key)) return;
    announced.current.push(key);
    toast.show({
      id: `invite-${key}`,
      kind: "info",
      text: `${inviteName} is reviewing ${inviteGame?.game?.me?.champion ? `your ${inviteGame.game.me.champion} game` : "a game you both recorded"}`,
      detail: "Watch it together: you pause, play and jump around as one.",
      ms: 15000,
      actions: [{ label: "Watch together", run: () => watchTogether(invite.matchId!) }],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invite?.code, invite?.matchId, inviteHere]);

  const reviewCount = toReview(matches).length;
  const state = saving ? "saving" : recording ? "rec" : status?.gameRunning ? "game" : settings?.autoRecord === false ? "off" : "";
  const stateText = saving
    ? "Saving the recording"
    : recording
      ? status?.mode === "manual"
        ? "Recording your screen"
        : `Recording ${status?.queueName ?? "the game"}`
      : status?.gameRunning
        ? "In game"
        : settings?.autoRecord === false
          ? "Auto-record is off"
          : "Ready to record";
  const goTo = (name: "library" | "trends" | "settings") => setView({ name } as View);

  return (
    <div className="shell">
      <header className="topbar">
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
                    {inviteName} is reviewing {inviteGame?.game?.me?.champion ? `your ${inviteGame.game.me.champion} game` : "a game you both recorded"}
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
          {update?.installing ? (
            <span className="chipbtn" role="status">
              <LoaderCircle size={14} className="spin" aria-hidden />
              Updating
            </span>
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
                    <p className="muted">{busyNow ? "It installs once the game and recording are done." : "Takes about half a minute. Rewatch closes and opens again by itself."}</p>
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
            {recording && (
              <button className="st-stop" onClick={stop} title="Stop and save the recording" aria-label="Stop and save the recording">
                <Square size={9} fill="currentColor" aria-hidden />
                Stop
              </button>
            )}
          </div>
        </div>
      </header>

      <main className={`main ${view.name === "player" ? "" : "wash"}`}>
        {view.name === "player" ? (
          <Player
            key={view.id + (view.together ? "-together" : "")}
            id={view.id}
            friends={settings?.friends ?? []}
            matches={matches ?? undefined}
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
          settings && <SettingsPage settings={settings} onSave={saveSettings} matches={matches} />
        ) : (
          <Games
            matches={matches}
            settings={settings}
            busy={recording || saving}
            onOpen={(id, start) => setView({ name: "player", id, start })}
            onRecord={startManual}
            onSaveSettings={saveSettings}
            onDelete={removeGames}
            onChanged={refreshMatches}
            onSettings={() => goTo("settings")}
          />
        )}
      </main>
    </div>
  );
}
