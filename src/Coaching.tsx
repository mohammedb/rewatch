// Sending a game to a coach, and the games students send to this PC.
//
// The player picks a game and a person (by friend code). That person's Rewatch fetches a smaller copy of the
// video with the game's data and keeps it apart from their own games; their notes and drawings come back
// into the player's own recording.

import { Check, GraduationCap, Loader2, Send, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, onEvent } from "./api";
import { Portrait } from "./ChampIcon";
import { findCode } from "./Onboarding";
import type { CoachInbox, CoachOffer, Friend, MatchFull, OfferedGame, Settings, Share } from "./types";
import { humanError, useToast } from "./ui";

const SITE = "rewatch.ggwp.no";

const short = (code: string) => (code.length > 18 ? `${code.slice(0, 8)}…${code.slice(-4)}` : code);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** How a sending is getting on, in words, and whether that is good, bad or still open. */
export function shareStatus(s: Share): { text: string; tone: "ok" | "bad" | "wait" } {
  switch (s.state) {
    case "received":
      return { text: `Received${s.gotAt ? ` ${new Date(s.gotAt).toLocaleDateString([], { day: "numeric", month: "short" })}` : ""}`, tone: "ok" };
    case "accepted":
      return { text: "Their Rewatch is fetching it", tone: "wait" };
    case "asked":
      return { text: "Waiting for them to accept. Your request shows in their Rewatch.", tone: "wait" };
    case "offline":
      return { text: "Waiting for them to come online. It is sent once both PCs are on with Rewatch running.", tone: "wait" };
    case "preparing":
      return { text: "Making a smaller copy to send. This waits while a game is running.", tone: "wait" };
    case "declined":
      return { text: "They turned it down", tone: "bad" };
    case "old":
      return { text: "Their Rewatch is too old to receive games. Ask them to update it.", tone: "bad" };
    case "novideo":
      return { text: "This game has no video to send", tone: "bad" };
    default:
      return { text: "Getting it ready", tone: "wait" };
  }
}

/** One line that says which game it is. */
export function gameLine(g: OfferedGame | null | undefined): string {
  if (!g) return "a game";
  const kda = g.kills != null && g.deaths != null && g.assists != null ? `${g.kills}/${g.deaths}/${g.assists}` : null;
  const res = g.result === "Win" ? "victory" : g.result === "Lose" ? "defeat" : null;
  const len = g.duration ? `${Math.round(g.duration / 60)} min` : null;
  return [g.champion || "A game", kda, res, g.queueName, len].filter(Boolean).join(", ");
}

// ------------------------------------------------------------------ sending

interface SendProps {
  match: Pick<MatchFull, "id" | "tracks" | "game">;
  settings: Settings;
  onSaveSettings: (next: Settings) => Promise<void>;
  onClose: () => void;
}

/** The dialog behind "Send to a coach": who to send this game to, what goes along, and how each sending is going. */
export function SendToCoach({ match, settings, onSaveSettings, onClose }: SendProps) {
  const toast = useToast();
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [comms, setComms] = useState(false);
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api.coachShares(match.id).then(setShares).catch(() => setShares((s) => s ?? [])), [match.id]);
  useEffect(() => {
    load();
    const iv = setInterval(load, 3000);
    const off = onEvent("coaching", load);
    return () => {
      clearInterval(iv);
      off();
    };
  }, [load]);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>("input, button")?.focus();
  }, []);

  // Coaches first, then teammates: a teammate can be sent a game they did not play in.
  const people: (Friend & { coach: boolean })[] = [
    ...settings.coaches.map((f) => ({ ...f, coach: true })),
    ...settings.friends.filter((f) => !settings.coaches.some((c) => same(c.code, f.code))).map((f) => ({ ...f, coach: false })),
  ];
  // Someone a game was sent to and who was since taken off the lists still shows, so the sending can be stopped.
  for (const s of shares ?? []) if (!people.some((p) => same(p.code, s.code))) people.push({ name: s.name, code: s.code, coach: true });

  const hasVoices = match.tracks.some((t) => t.name !== "game");
  const code = findCode(pasted);
  const pastedNote = !pasted.trim()
    ? null
    : !code
      ? "That isn't a whole friend code. It's 64 letters and numbers: ask them to copy it again."
      : people.some((p) => same(p.code, code))
        ? "They're on the list above already."
        : null;

  const send = async (to: Friend) => {
    setBusy(to.code);
    setError(null);
    try {
      setShares(await api.coachSend(match.id, to.code, to.name, comms && hasVoices, message));
      return true;
    } catch (e) {
      setError(humanError(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const stop = async (to: Friend) => {
    setBusy(to.code);
    try {
      setShares(await api.coachStop(match.id, to.code));
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  };
  const addAndSend = async () => {
    if (!code || pastedNote) return;
    const coach: Friend = { name: name.trim() || "Coach", code };
    if (!(await send(coach))) return;
    setName("");
    setPasted("");
    // Remembered for the next game. If that fails the game is still on its way.
    onSaveSettings({ ...settings, coaches: [...settings.coaches, coach] }).catch((e) => toast.show({ kind: "error", text: `The coach was not saved to your list. ${humanError(e)}` }));
  };

  return createPortal(
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        className="modal send"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-own-keys=""
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onClose();
        }}
      >
        <h2 id={titleId}>Send this game to a coach</h2>
        <div className="modal-body">
          <p>
            They get this one game in their Rewatch: a smaller copy of the video with game sound, the timeline and stats, your cursor and keys, and your notes. What they write and draw on it
            shows up here, in your own recording.
          </p>

          {people.length > 0 && (
            <ul className="send-list">
              {people.map((p) => {
                const s = shares?.find((x) => same(x.code, p.code));
                const st = s ? shareStatus(s) : null;
                return (
                  <li key={p.code}>
                    <span className="send-who">
                      <b>{p.name || "Coach"}</b>
                      <small>{p.coach ? `code ${short(p.code)}` : "teammate"}</small>
                    </span>
                    {s ? (
                      <>
                        <button className="btn sm" disabled={!!busy} onClick={() => send(p)} title="Send it again with the choices below">
                          Send again
                        </button>
                        <button className="btn sm quiet" disabled={!!busy} onClick={() => stop(p)} title="They can no longer fetch it. A copy they already have stays with them.">
                          Stop sharing
                        </button>
                      </>
                    ) : (
                      <button className="btn sm primary" disabled={!!busy || shares === null} onClick={() => send(p)}>
                        {busy === p.code ? <Loader2 size={13} className="spin" aria-hidden /> : <Send size={13} aria-hidden />}
                        Send
                      </button>
                    )}
                    {st && (
                      <span className={`send-st ${st.tone}`} role="status">
                        {st.tone === "ok" ? <Check size={13} aria-hidden /> : st.tone === "wait" ? <Loader2 size={13} className="spin" aria-hidden /> : <X size={13} aria-hidden />}
                        {st.text}
                        {s!.comms ? " With the voice call and your microphone." : ""}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <form
            className="send-add"
            onSubmit={(e) => {
              e.preventDefault();
              addAndSend();
            }}
          >
            <label className="send-label" htmlFor={`${titleId}-code`}>
              {people.length > 0 ? "Someone else" : "Your coach"}
            </label>
            <div className="send-row">
              <input className="field-input" type="text" placeholder="Their name" aria-label="The coach's name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
              <input id={`${titleId}-code`} className="field-input" type="text" placeholder="Paste their friend code" value={pasted} onChange={(e) => setPasted(e.target.value)} />
              <button className="btn primary" type="submit" disabled={!code || !!pastedNote || !!busy}>
                <Send size={14} aria-hidden />
                Send
              </button>
            </div>
            {pastedNote ? (
              <p className="fres bad">{pastedNote}</p>
            ) : (
              <p className="muted">
                Their code is in their Rewatch under Settings, Teammates. No Rewatch yet? It's free at {SITE}, for Windows.
              </p>
            )}
          </form>

          <div className="send-opts">
            <label className="send-label" htmlFor={`${titleId}-msg`}>
              What should they look at? <span className="muted">Optional</span>
            </label>
            <textarea id={`${titleId}-msg`} className="field-input" rows={2} maxLength={500} placeholder="My recalls, and the fight at 14 minutes" value={message} onChange={(e) => setMessage(e.target.value)} />
            {hasVoices && (
              <label className="send-check">
                <input type="checkbox" checked={comms} onChange={(e) => setComms(e.target.checked)} />
                <span>
                  Include the voice call and my microphone
                  <small>Off, they hear the game only. On, they also hear everyone who was in your Discord call.</small>
                </span>
              </label>
            )}
          </div>
          {error && (
            <p className="fres bad" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="modal-acts">
          <button type="button" className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- receiving

/** People asking to send a game, and games on their way in. Asked for every few seconds while something shows it. */
export function useCoachInbox(): [CoachInbox, () => void] {
  const [inbox, setInbox] = useState<CoachInbox>({ offers: [], receiving: [] });
  const load = useCallback(() => {
    api
      .coachInbox()
      .then((x) => setInbox(x ?? { offers: [], receiving: [] }))
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const iv = setInterval(load, 3000);
    const off = onEvent("coaching", load);
    return () => {
      clearInterval(iv);
      off();
    };
  }, [load]);
  return [inbox, load];
}

/** Take games from the person behind an offer from now on: they go on the students list. */
export function acceptOffer(settings: Settings, offer: Pick<CoachOffer, "code" | "name">): Settings {
  if (settings.students.some((f) => same(f.code, offer.code))) return settings;
  return { ...settings, students: [...settings.students, { name: offer.name || "Student", code: offer.code }] };
}

/** At the top of the library: requests to send a game, and games arriving. Nothing when there are none. */
export function CoachInboxStrip({ settings, onSaveSettings }: { settings: Settings; onSaveSettings: (next: Settings) => Promise<void> }) {
  const toast = useToast();
  const [inbox, reload] = useCoachInbox();
  const [working, setWorking] = useState<string | null>(null);
  // Their first offer speaks for the person; the rest arrive with it once they're accepted.
  const asking = inbox.offers.filter((o, i, all) => all.findIndex((x) => x.code === o.code) === i && !settings.students.some((f) => same(f.code, o.code)));
  if (asking.length === 0 && inbox.receiving.length === 0) return null;

  const accept = (o: CoachOffer) => {
    setWorking(o.code);
    onSaveSettings(acceptOffer(settings, o))
      .then(reload)
      .catch((e) => toast.show({ kind: "error", text: `That did not go through. ${humanError(e)}` }))
      .finally(() => setWorking(null));
  };
  const decline = (o: CoachOffer) => {
    setWorking(o.code);
    Promise.all(inbox.offers.filter((x) => x.code === o.code).map((x) => api.coachDecline(x.code, x.id, x.at)))
      .then(reload)
      .catch(() => {})
      .finally(() => setWorking(null));
  };

  return (
    <div className="coachbox">
      {asking.map((o) => {
        const more = inbox.offers.filter((x) => x.code === o.code).length - 1;
        return (
          <div key={o.code} className="coach-ask">
            {o.game.championKey ? <Portrait championKey={o.game.championKey} name={o.game.champion ?? ""} size={40} square /> : <GraduationCap size={22} aria-hidden />}
            <div className="coach-t">
              <b>{o.name || "Someone"} wants to send you a game to review</b>
              <span>
                {gameLine(o.game)}
                {more > 0 ? `, and ${more} more` : ""}
              </span>
              {o.message && <q>{o.message}</q>}
              <small>
                Only accept people you know (their code starts {o.code.slice(0, 8)}). Accepting lets them send you games; they see none of yours. You can take them off again in Settings.
              </small>
            </div>
            <button className="btn quiet" disabled={working === o.code} onClick={() => decline(o)}>
              No thanks
            </button>
            <button className="btn primary" disabled={working === o.code} onClick={() => accept(o)}>
              Accept
            </button>
          </div>
        );
      })}
      {inbox.receiving.map((r) => {
        const pct = r.total > 0 ? Math.min(100, Math.round((r.got / r.total) * 100)) : 0;
        if (r.error) {
          const why = /room on the drive/.test(r.error)
            ? "There is not enough room on the drive with your recordings. Free some up and it carries on."
            : /game/.test(r.error) || r.error === "busy"
              ? "It waits while a game is running, here or on their PC."
              : "Their PC could not be reached. It carries on once they are online.";
          return (
            <div key={r.code + r.id} className="coach-in stuck" role="status">
              <X size={15} aria-hidden />
              <span>
                <b>{r.name || "A student"}</b>'s game ({gameLine(r.game)}) has not arrived yet. {why}
              </span>
              <span className="num">{pct}%</span>
            </div>
          );
        }
        return (
          <div key={r.code + r.id} className="coach-in" role="status">
            <Loader2 size={15} className="spin" aria-hidden />
            <span>
              Receiving <b>{r.name || "a student"}</b>'s game: {gameLine(r.game)}
            </span>
            <span className="coach-bar" aria-hidden>
              <i style={{ width: `${pct}%` }} />
            </span>
            <span className="num">{pct}%</span>
          </div>
        );
      })}
    </div>
  );
}
