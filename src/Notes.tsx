// Notes as one conversation about the game: yours and teammates', in game order,
// with replies under the note they answer and drawings attached to nearby notes.

import { CornerDownRight, MessageSquare, PenLine, Reply, Trash2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Portrait } from "./ChampIcon";
import { clock } from "./format";
import type { Drawing, Note, PlayerRow } from "./types";

export interface TeamThread {
  friend: string;
  code: string;
  champion: string;
  championKey: string;
  notes: Note[];
  drawings: Drawing[];
}

interface Entry {
  key: string;
  id: string;
  t: number;
  text: string;
  /** Shapes drawn around this moment by the same person. */
  shapes: number;
  mine: boolean;
  who: string;
  champion?: string;
  championKey?: string;
  replyTo?: string;
}

/** Seconds between a note and a drawing for them to count as one. */
const NEAR = 1.5;

function entriesOf(notes: Note[], drawings: Drawing[], who: Omit<Entry, "key" | "id" | "t" | "text" | "shapes" | "replyTo">, prefix: string): Entry[] {
  const out: Entry[] = notes.map((n) => ({ ...who, key: prefix + n.id, id: n.id, t: n.t, text: n.text, shapes: 0, replyTo: n.replyTo }));
  for (const d of drawings) {
    const near = out.filter((e) => !e.replyTo).sort((a, b) => Math.abs(a.t - d.t) - Math.abs(b.t - d.t))[0];
    if (near && Math.abs(near.t - d.t) <= NEAR) near.shapes += d.shapes.length;
    else out.push({ ...who, key: prefix + "d" + d.id, id: "d" + d.id, t: d.t, text: "", shapes: d.shapes.length });
  }
  return out;
}

export function NotesPanel({
  notes,
  drawings,
  team,
  me,
  time,
  tags,
  onTags,
  onSeek,
  onAdd,
  onDelete,
  onPause,
  noVideo,
}: {
  notes: Note[];
  drawings: Drawing[];
  team: TeamThread[];
  me?: PlayerRow | null;
  time: number;
  tags: string[];
  onTags: (tags: string[]) => void;
  onSeek: (t: number) => void;
  onAdd: (text: string, replyTo?: string) => void;
  onDelete: (id: string) => void;
  onPause: () => void;
  /** The game's video was deleted: notes can be read and deleted, not added, and their moments can't be played. */
  noVideo?: boolean;
}) {
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<Entry | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);

  const all = useMemo(() => {
    const list = entriesOf(notes, drawings, { mine: true, who: "You", champion: me?.champion, championKey: me?.championKey }, "m");
    for (const tm of team) list.push(...entriesOf(tm.notes, tm.drawings, { mine: false, who: tm.friend, champion: tm.champion, championKey: tm.championKey }, tm.code));
    return list.sort((a, b) => a.t - b.t);
  }, [notes, drawings, team, me]);
  const ids = new Set(all.map((e) => e.id));
  const top = all.filter((e) => !e.replyTo || !ids.has(e.replyTo));
  const replies = (id: string) => all.filter((e) => e.replyTo === id);

  const send = () => {
    const v = text.trim();
    if (!v) return;
    onAdd(v, replyTo?.id);
    setText("");
    setReplyTo(null);
  };
  const addTag = () => {
    const tag = tagDraft.trim().toLowerCase().replace(/^#/, "");
    if (tag && !tags.includes(tag)) onTags([...tags, tag]);
    setTagDraft("");
  };

  const row = (e: Entry, reply = false) => (
    <article key={e.key} className={`nt ${e.mine ? "mine" : "theirs"} ${reply ? "reply" : ""} ${!noVideo && Math.abs(e.t - time) < 2 ? "now" : ""}`}>
      <header>
        {reply && <CornerDownRight size={13} className="muted" aria-hidden />}
        {e.championKey ? <Portrait championKey={e.championKey} name={e.champion ?? e.who} size={20} side={e.mine ? undefined : "ally"} /> : <span className="glyph" style={{ width: 20, height: 20 }} />}
        <b>{e.who}</b>
        {!reply && (
          <button className="tchip num" onClick={() => onSeek(e.t - 3)} title={noVideo ? undefined : "Go to this moment"} disabled={noVideo}>
            {clock(e.t)}
          </button>
        )}
        <span className="grow" />
        {!reply && e.text && !noVideo && (
          <button
            className="btn quiet xs sq"
            aria-label={`Reply to ${e.who}`}
            title="Reply"
            onClick={() => {
              setReplyTo(e);
              onPause();
              requestAnimationFrame(() => box.current?.focus());
            }}
          >
            <Reply size={13} />
          </button>
        )}
        {e.mine && e.text && (
          <button className="btn quiet xs sq danger" aria-label="Delete note" title="Delete note" onClick={() => onDelete(e.id)}>
            <Trash2 size={13} />
          </button>
        )}
      </header>
      {e.text && <p>{e.text}</p>}
      {e.shapes > 0 && (
        <button className="drawn" onClick={() => onSeek(e.t)} title={noVideo ? undefined : "Show the drawing"} disabled={noVideo}>
          <PenLine size={12} aria-hidden />
          {e.text ? `Drawing, ${e.shapes} ${e.shapes === 1 ? "mark" : "marks"}` : `Drew ${e.shapes} ${e.shapes === 1 ? "mark" : "marks"} on the video`}
        </button>
      )}
    </article>
  );

  return (
    <>
      <div className="tagrow">
        <div className="tags">
          {tags.map((t) => (
            <span className="tag" key={t}>
              #{t}
              <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onTags(tags.filter((x) => x !== t))}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
        <form
          className="tagadd"
          onSubmit={(e) => {
            e.preventDefault();
            addTag();
          }}
        >
          <input className="field-input" type="text" value={tagDraft} placeholder="Add a tag, like laning or macro" aria-label="New game tag" onChange={(e) => setTagDraft(e.target.value)} onFocus={onPause} />
          <button className="btn sm" type="submit" disabled={!tagDraft.trim()}>
            Tag
          </button>
        </form>
      </div>
      <div className="sidebody thread">
        {top.length === 0 && (
          <div className="side-empty">
            <MessageSquare size={20} aria-hidden />
            <p>{noVideo ? "No notes on this game." : "Pause on a moment and write what you see. Notes show on the timeline, and teammates who recorded this game see them too."}</p>
          </div>
        )}
        {top.map((e) => (
          <div key={e.key} className="ntgroup">
            {row(e)}
            {replies(e.id).map((r) => row(r, true))}
          </div>
        ))}
      </div>
      {!noVideo && (
        <div className="noteadd">
          {replyTo && (
            <div className="replying">
              <CornerDownRight size={13} aria-hidden />
              <span>
                Replying to <b>{replyTo.who}</b> at {clock(replyTo.t)}
              </span>
              <button className="btn quiet xs sq" aria-label="Stop replying" onClick={() => setReplyTo(null)}>
                <X size={13} />
              </button>
            </div>
          )}
          <textarea
            ref={box}
            value={text}
            placeholder={replyTo ? "Your reply" : "What happened here?"}
            aria-label={replyTo ? "Reply" : "New note"}
            onChange={(e) => setText(e.target.value)}
            onFocus={onPause}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
              if (e.key === "Escape") setReplyTo(null);
            }}
          />
          <div className="noteadd-foot">
            <span className="muted">Ctrl + Enter</span>
            <span className="grow" />
            <button className="btn sm primary" disabled={!text.trim()} onClick={send}>
              {replyTo ? "Reply" : `Add note at ${clock(time)}`}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
