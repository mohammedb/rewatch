import { Clapperboard, Download, SlidersHorizontal, Square, TriangleAlert, Users, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, onEvent } from "./api";
import { clock } from "./format";
import { Games } from "./Games";
import { Player } from "./Player";
import { SettingsPage } from "./SettingsPage";
import type { MatchSummary, Settings, Status, UpdateInfo, WatchPeer } from "./types";

type View = { name: "library" } | { name: "player"; id: string; together?: boolean } | { name: "settings" };

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  return <span className="num">{clock((Date.now() - since) / 1000)}</span>;
}

export default function App() {
  const [view, setView] = useState<View>({ name: "library" });
  const [status, setStatus] = useState<Status | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [matches, setMatches] = useState<MatchSummary[] | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateLater, setUpdateLater] = useState<string | null>(null);
  const [peers, setPeers] = useState<WatchPeer[]>([]);
  const [declined, setDeclined] = useState<string[]>([]);
  /** The recording being watched together right now, if any. */
  const [session, setSession] = useState<string | null>(null);

  const refreshMatches = useCallback(() => {
    api.listMatches().then(setMatches).catch(() => setMatches([]));
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

  const recording = status?.state === "recording" || status?.state === "starting";
  const saving = status?.state === "finalizing";
  const stop = async () => {
    await api.stopRecording().catch(() => {});
    refreshStatus();
    refreshMatches();
  };
  const startManual = async () => {
    await api.startManualRecording().catch(() => {});
    refreshStatus();
  };

  const state = recording ? "rec" : status?.gameRunning ? "game" : "";
  const stateText = recording ? "Recording" : status?.gameRunning ? "In game" : settings?.autoRecord ? "Ready to record" : "Auto-record is off";
  const error = status?.lastError && status.lastError !== dismissed ? status.lastError : null;
  const newer = update?.available && update.available.version !== updateLater ? update.available : null;
  // A teammate is reviewing a game I also recorded, and I am not in it with them yet.
  const invite = peers.find((p) => p.matchId && !declined.includes(p.code + p.matchId) && p.matchId !== session);
  const inviteName = invite ? settings?.friends.find((f) => f.code === invite.code)?.name || invite.name || "A teammate" : "";
  const inviteGame = invite ? matches?.find((m) => m.id === invite.matchId) : undefined;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><b>REWATCH</b><span>v{update?.current ?? ""}</span></div>
        <nav className="tabsbar" aria-label="Main">
          <button className="tab" aria-current={view.name !== "settings" ? "page" : undefined} onClick={() => setView({ name: "library" })}>
            <Clapperboard size={17} aria-hidden />Games
          </button>
          <button className="tab" aria-current={view.name === "settings" ? "page" : undefined} onClick={() => setView({ name: "settings" })}>
            <SlidersHorizontal size={17} aria-hidden />Settings
          </button>
        </nav>
        <div className="right">
          <div className={`state ${state}`} role="status" title={settings?.autoRecord ? "Games are recorded automatically" : "Turn automatic recording on in Settings"}>
            <i aria-hidden />
            {stateText}
            {recording && status?.startedEpochMs && <Elapsed since={status.startedEpochMs} />}
          </div>
        </div>
      </header>

      <div className={`main ${view.name === "player" ? "" : "wash"}`}>
        {recording && status && (
          <div className="recbar" role="status">
            <span className="live" aria-hidden />
            <strong>Recording</strong>
            <span className="grow">
              {status.mode === "manual" ? "Your main screen" : status.queueName ?? "League game"}
              {status.bookmarks > 0 && `, ${status.bookmarks} bookmark${status.bookmarks === 1 ? "" : "s"}`}
              {settings?.recordDiscord && !status.discordRunning && ". Discord is not running, so its track will be silent"}
            </span>
            <button className="btn" onClick={stop}><Square size={12} fill="currentColor" aria-hidden />Stop and save</button>
          </div>
        )}
        {saving && <div className="recbar saving" role="status">Saving the recording…</div>}
        {error && (
          <div className="alert" role="alert">
            <TriangleAlert size={17} aria-hidden />
            <span>{error}</span>
            <button className="btn quiet sq" aria-label="Dismiss" onClick={() => setDismissed(error)}><X size={16} /></button>
          </div>
        )}

        {update?.installing ? (
          <div className="alert info" role="status">
            <Download size={17} aria-hidden />
            <span>Updating to version {update.available?.version}. Rewatch closes and opens again by itself in a moment.</span>
          </div>
        ) : newer ? (
          <div className="alert info" role="status">
            <Download size={17} aria-hidden />
            <span>
              Version {newer.version} is ready.{newer.notes ? ` ${newer.notes}` : ""}
              {update?.error ? ` (${update.error})` : ""}
            </span>
            <button className="btn mark" disabled={recording || saving || !!status?.gameRunning} title={status?.gameRunning || recording ? "Not while a game is running" : "Takes about half a minute; the app restarts by itself"} onClick={() => api.updateInstall().then(() => api.updateInfo().then(setUpdate)).catch(() => api.updateInfo().then(setUpdate))}>Update now</button>
            <button className="btn quiet" onClick={() => setUpdateLater(newer.version)}>Later</button>
          </div>
        ) : null}
        {invite && (
          <div className="alert info" role="status">
            <Users size={17} aria-hidden />
            <span>
              <b>{inviteName}</b> is reviewing {inviteGame?.game?.me?.champion ? `your ${inviteGame.game.me.champion} game` : "a game you both recorded"}
              {inviteGame?.game?.queueName ? ` (${inviteGame.game.queueName})` : ""}.
            </span>
            <button className="btn mark" onClick={() => setView({ name: "player", id: invite.matchId!, together: true })}>Watch together</button>
            <button className="btn quiet sq" aria-label="Dismiss" onClick={() => setDeclined((d) => [...d, invite.code + invite.matchId])}><X size={16} /></button>
          </div>
        )}

        {view.name === "player" ? (
          <Player
            key={view.id + (view.together ? "-together" : "")}
            id={view.id}
            friends={settings?.friends ?? []}
            joinTogether={view.together}
            hintsOn={!!settings?.aiReview && !!settings.geminiKey.trim()}
            onTogether={(on) => setSession(on ? view.id : null)}
            onBack={() => {
              setView({ name: "library" });
              refreshMatches();
            }}
          />
        ) : view.name === "settings" ? (
          settings && <SettingsPage settings={settings} onSave={saveSettings} />
        ) : (
          <Games
            matches={matches}
            settings={settings}
            busy={recording || saving}
            onOpen={(id) => setView({ name: "player", id })}
            onRecord={startManual}
            onSaveSettings={saveSettings}
          />
        )}
      </div>
    </div>
  );
}
