import { Bookmark, CircleDot, MessageSquare, Search, Star, Video } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { absoluteFileUrl, api, pickFolder } from "./api";
import { ItemIcon, Portrait } from "./ChampIcon";
import { bytes, clock, when } from "./format";
import type { Environment, MatchSummary, Settings } from "./types";

interface Props {
  matches: MatchSummary[] | null;
  settings: Settings | null;
  busy: boolean;
  onOpen: (id: string) => void;
  onRecord: () => void;
  onSaveSettings: (s: Settings) => Promise<void>;
}

type Filter = "all" | "win" | "lose" | "kept";
const FILTERS: [Filter, string][] = [["all", "All"], ["win", "Wins"], ["lose", "Losses"], ["kept", "Kept"]];

function FirstRun({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => Promise<void> }) {
  const [dir, setDir] = useState("");
  const [env, setEnv] = useState<Environment | null>(null);
  useEffect(() => {
    api.environment().then((e) => {
      setEnv(e);
      setDir((d) => d || e.suggestedRecordingsDir);
    });
  }, []);
  return (
    <div className="setup">
      <h2>Where should recordings go?</h2>
      <p>
        A 35-minute game takes roughly 5 to 15 GB depending on your screen, so pick a drive with room. You can change
        the folder and set a size limit later in Settings.
      </p>
      <div className="row">
        <input className="field-input" type="text" value={dir} onChange={(e) => setDir(e.target.value)} aria-label="Recordings folder" />
        <button className="btn" onClick={async () => setDir((await pickFolder(dir)) ?? dir)}>Browse</button>
      </div>
      <div className="row">
        <button className="btn mark" disabled={!dir.trim()} onClick={() => onSave({ ...settings, recordingsDir: dir.trim() })}>
          Use this folder
        </button>
      </div>
      {env && !env.ffmpegVersion && (
        <p className="enemy">FFmpeg was not found on this PC. Recording needs it. Set its path in Settings.</p>
      )}
    </div>
  );
}

export function Games({ matches, settings, busy, onOpen, onRecord, onSaveSettings }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (matches ?? []).filter((m) => {
      if (filter === "win" && m.game?.result !== "Win") return false;
      if (filter === "lose" && m.game?.result !== "Lose") return false;
      if (filter === "kept" && !m.keep) return false;
      if (q && !`${m.game?.me?.champion ?? ""} ${m.game?.queueName ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [matches, filter, query]);

  if (!settings) return <div className="page" />;
  const all = matches ?? [];
  const wins = all.filter((m) => m.game?.result === "Win").length;
  const losses = all.filter((m) => m.game?.result === "Lose").length;
  const total = all.reduce((n, m) => n + m.sizeBytes, 0);

  if (!settings.recordingsDir) {
    return <div className="page"><div className="page-inner"><FirstRun settings={settings} onSave={onSaveSettings} /></div></div>;
  }

  return (
    <div className="page">
      <div className="page-inner">
        <div className="lib-head">
          <h1>Games</h1>
          {all.length > 0 && (
            <p>
              {all.length} recording{all.length === 1 ? "" : "s"}
              {wins + losses > 0 && `, ${wins} won and ${losses} lost`}. Using {bytes(total)}
              {settings.quotaGb ? ` of ${settings.quotaGb} GB` : ""}.
            </p>
          )}
          <span className="grow" />
          <div className="lib-tools">
            {all.length > 0 && (
              <>
                <div className="seg" role="group" aria-label="Show">
                  {FILTERS.map(([key, label]) => (
                    <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>
                  ))}
                </div>
                <label className="search">
                  <Search size={14} aria-hidden />
                  <input className="field-input" type="text" placeholder="Find a champion" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a champion" />
                </label>
              </>
            )}
            <button className="btn" onClick={onRecord} disabled={busy} title="Record your main screen now, without a game">
              <CircleDot size={15} aria-hidden />Record now
            </button>
          </div>
        </div>

        {matches === null ? null : all.length === 0 ? (
          <div className="empty">
            <Video size={40} strokeWidth={1.4} aria-hidden />
            <h2>No games recorded yet</h2>
            <p>
              {settings.autoRecord
                ? "Start a League game and it is recorded by itself. Keep this app running; closing the window leaves it in the tray."
                : "Automatic recording is off. Turn it on in Settings, or press Record now."}
            </p>
          </div>
        ) : shown.length === 0 ? (
          <p className="muted">Nothing matches. Clear the search or choose All.</p>
        ) : (
          <div className="cards">
            {shown.map((m) => {
              const me = m.game?.me;
              const result = m.game?.result;
              const cls = result === "Win" ? "win" : result === "Lose" ? "lose" : "";
              const mins = Math.max(1, (m.game?.length ?? m.duration) / 60);
              const manual = m.mode === "manual";
              const queue = m.game?.queueName ?? (manual ? "Screen recording" : m.game?.mode === "PRACTICETOOL" ? "Practice Tool" : "League game");
              return (
                <button key={m.id} className="card" onClick={() => onOpen(m.id)}>
                  <span className={`shot ${m.thumb ? "" : "blank"}`}>
                    {m.thumb && <img src={absoluteFileUrl(m.thumb)} alt="" />}
                    {result && <span className={`res ${cls}`}>{result === "Win" ? "Victory" : "Defeat"}</span>}
                    <span className="flags">
                      {m.keep && <span className="kept" title="Kept: never deleted by the size limit"><Star size={12} fill="currentColor" aria-label="Kept" /></span>}
                      {m.noteCount > 0 && <span title={`${m.noteCount} note${m.noteCount === 1 ? "" : "s"}`}><MessageSquare size={12} aria-hidden />{m.noteCount}</span>}
                      {m.summary.bookmarks > 0 && <span title={`${m.summary.bookmarks} bookmark${m.summary.bookmarks === 1 ? "" : "s"}`}><Bookmark size={12} aria-hidden />{m.summary.bookmarks}</span>}
                    </span>
                    <span className="len">{clock(m.duration)}</span>
                    {cls && <span className={`edge ${cls}`} />}
                  </span>
                  <span className="info">
                    {me ? <Portrait championKey={me.championKey} name={me.champion} size={40} /> : <span className="glyph" style={{ width: 40, height: 40 }}><Video size={18} aria-hidden /></span>}
                    <span className="name">{me?.champion ?? (manual ? "Screen recording" : "League game")}</span>
                    <span className="kda">{me && <>{me.kills}<i>/</i><span className="d">{me.deaths}</span><i>/</i>{me.assists}</>}</span>
                    <span className="when caps">{when(m.startedEpochMs)}{me ? `  ·  ${queue}` : ""}</span>
                    <span className="foot">
                      <span>{me ? `${me.cs} CS, ${(me.cs / mins).toFixed(1)} a minute` : `${m.height}p, ${bytes(m.sizeBytes)}`}</span>
                      <span className="build">
                        {me?.items.slice(0, 7).map((it, i) => <ItemIcon key={i} id={it.id} name={it.name} size={22} />)}
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
