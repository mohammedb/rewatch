// Shared interface pieces: popovers, dropdowns, menus, toasts (including jobs that run
// for a while), the confirm dialog, loading placeholders, and error wording a player
// can act on.

import { Check, ChevronDown, CircleAlert, CircleCheck, Copy, FolderOpen, Info, LoaderCircle, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { api, showInFolder } from "./api";
import { clock } from "./format";

// ------------------------------------------------------------------ popover

export type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

/** Where a floating panel goes next to its anchor, flipped when there is no room. */
function usePlacement(anchor: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>, open: boolean, placement: Placement, matchWidth: boolean) {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    if (!open) {
      setStyle({ visibility: "hidden" });
      return;
    }
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const p = panel.current;
      if (!a || !p) return;
      const minWidth = matchWidth ? a.width : undefined;
      const pw = Math.max(p.offsetWidth, minWidth ?? 0);
      const ph = p.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = 6;
      let up = placement.startsWith("top");
      if (!up && a.bottom + gap + ph > vh - 8 && a.top - gap - ph >= 8) up = true;
      else if (up && a.top - gap - ph < 8 && a.bottom + gap + ph <= vh - 8) up = false;
      const left = Math.max(8, Math.min(placement.endsWith("end") ? a.right - pw : a.left, vw - pw - 8));
      const top = Math.max(8, Math.min(up ? a.top - gap - ph : a.bottom + gap, vh - ph - 8));
      setStyle({ left, top, minWidth, maxHeight: vh - 16 });
    };
    place();
    // Content can change size after the first paint (images, async rows).
    const ro = new ResizeObserver(place);
    if (panel.current) ro.observe(panel.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, panel, open, placement, matchWidth]);
  return style;
}

/** Close on a press outside the panel and its anchor, and on Escape. */
function useDismiss(open: boolean, refs: RefObject<HTMLElement | null>[], onClose: () => void, anchor?: RefObject<HTMLElement | null>) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (refs.some((r) => r.current?.contains(t))) return;
      close.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close.current();
      anchor?.current?.focus();
    };
    // Registered a tick later so the press that opened the panel does not close it.
    const id = window.setTimeout(() => window.addEventListener("pointerdown", down, true));
    window.addEventListener("keydown", key, true);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

export function Popover({
  anchor,
  open,
  onClose,
  placement = "bottom-start",
  matchWidth = false,
  className = "",
  label,
  role = "dialog",
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  placement?: Placement;
  matchWidth?: boolean;
  className?: string;
  label?: string;
  role?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const style = usePlacement(anchor, panel, open, placement, matchWidth);
  useDismiss(open, [anchor, panel], onClose, anchor);
  // A panel is drawn at the end of the page, so Tab would never reach it from its button: focus goes in on
  // opening (to its first control when opened from the keyboard) and back to the button on closing.
  // Dropdowns and menus (role "none") move focus themselves.
  const dialog = role !== "none";
  useEffect(() => {
    if (!open || !dialog) return;
    const a = anchor.current;
    const fromKeys = !!a?.matches(":focus-visible");
    // A frame later, once the panel has been placed and is visible.
    const raf = requestAnimationFrame(() => {
      const p = panel.current;
      if (!p) return;
      const first = fromKeys ? p.querySelector<HTMLElement>(FOCUSABLE) : null;
      (first ?? p).focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      const f = document.activeElement;
      if (a?.isConnected && (!f || f === document.body || panel.current?.contains(f))) a.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dialog]);
  if (!open) return null;
  return createPortal(
    <div ref={panel} className={`pop ${className}`} style={style} role={dialog ? role : undefined} aria-label={label} tabIndex={dialog ? -1 : undefined} data-own-keys="">
      {children}
    </div>,
    document.body,
  );
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// ------------------------------------------------------------------ select

export interface Option<T extends string | number> {
  value: T;
  label: ReactNode;
  /** Plain words for type-to-find, when the label is not a string. */
  text?: string;
  hint?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

/** A dropdown that looks like the rest of the app, with the keyboard behaviour of a native one. */
export function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
  className = "",
  small = false,
  disabled = false,
  title,
  placement = "bottom-start",
  prefix,
}: {
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  /** Read out to screen readers; also the tooltip when there is no title. */
  label: string;
  className?: string;
  small?: boolean;
  disabled?: boolean;
  title?: string;
  placement?: Placement;
  /** Words before the value inside the button, like "Sort:". */
  prefix?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = options.find((o) => o.value === value);

  const show = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  };
  useEffect(() => {
    if (open) list.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (open) list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const choose = (o: Option<T> | undefined) => {
    if (!o || o.disabled) return;
    setOpen(false);
    btn.current?.focus();
    if (o.value !== value) onChange(o.value);
  };
  const step = (from: number, dir: number) => {
    for (let i = 1; i <= options.length; i++) {
      const j = (from + dir * i + options.length * 2) % options.length;
      if (!options[j].disabled) return j;
    }
    return from;
  };
  const onKey = (e: ReactKeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") setActive((a) => step(a, 1));
    else if (e.key === "ArrowUp") setActive((a) => step(a, -1));
    else if (e.key === "Home") setActive(step(-1, 1));
    else if (e.key === "End") setActive(step(options.length, -1));
    else if (e.key === "Enter" || e.key === " ") choose(options[active]);
    else if (e.key === "Escape") {
      setOpen(false);
      btn.current?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
      return;
    } else if (e.key.length === 1) {
      const k = e.key.toLowerCase();
      const text = (o: Option<T>) => (o.text ?? (typeof o.label === "string" ? o.label : String(o.value))).toLowerCase();
      for (let i = 1; i <= options.length; i++) {
        const j = (active + i) % options.length;
        if (!options[j].disabled && text(options[j]).startsWith(k)) {
          setActive(j);
          break;
        }
      }
    } else return;
    e.preventDefault();
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`select ${small ? "sm" : ""} ${className}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={title ?? label}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            show();
          }
        }}
      >
        {prefix && <span className="pre">{prefix}</span>}
        {current?.icon}
        <span className="v">{current?.label ?? "Choose"}</span>
        <ChevronDown size={14} aria-hidden className="chev" />
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} placement={placement} matchWidth role="none">
        <div ref={list} className="listbox" role="listbox" tabIndex={-1} aria-label={label} aria-activedescendant={`${id}-${active}`} onKeyDown={onKey}>
          {options.map((o, i) => (
            <div
              key={String(o.value)}
              id={`${id}-${i}`}
              data-i={i}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              className={`item-row ${i === active ? "active" : ""}`}
              onPointerMove={() => !o.disabled && setActive(i)}
              onClick={() => choose(o)}
            >
              {o.icon}
              <span className="l">
                {o.label}
                {o.hint && <small>{o.hint}</small>}
              </span>
              {o.value === value && <Check size={14} aria-hidden className="tick" />}
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}

// ------------------------------------------------------------------ menu

export type MenuItem =
  | { label: ReactNode; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: ReactNode }
  | "-";

/** A button that opens a short list of actions. */
export function Menu({
  items,
  label,
  children,
  className = "btn quiet sq",
  placement = "bottom-end",
  title,
}: {
  items: MenuItem[];
  label: string;
  children: ReactNode;
  className?: string;
  placement?: Placement;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const focusAt = (i: number) => {
    const all = Array.from(box.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? []);
    if (!all.length) return;
    all[(i + all.length) % all.length].focus();
  };
  useEffect(() => {
    if (open) requestAnimationFrame(() => focusAt(0));
  }, [open]);
  const onKey = (e: ReactKeyboardEvent) => {
    e.stopPropagation();
    const all = Array.from(box.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? []);
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") focusAt(at + 1);
    else if (e.key === "ArrowUp") focusAt(at - 1);
    else if (e.key === "Home") focusAt(0);
    else if (e.key === "End") focusAt(-1);
    else if (e.key === "Tab") {
      setOpen(false);
      return;
    } else return;
    e.preventDefault();
  };
  return (
    <>
      <button ref={btn} type="button" className={className} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={title ?? label} onClick={() => setOpen((o) => !o)}>
        {children}
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} placement={placement} role="none">
        <div ref={box} className="menu" role="menu" aria-label={label} onKeyDown={onKey}>
          {items.map((it, i) =>
            it === "-" ? (
              <hr key={i} />
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                className={`item-row ${it.danger ? "danger" : ""}`}
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  btn.current?.focus();
                  it.onSelect();
                }}
              >
                {it.icon}
                <span className="l">
                  {it.label}
                  {it.hint && <small>{it.hint}</small>}
                </span>
              </button>
            ),
          )}
        </div>
      </Popover>
    </>
  );
}

// ------------------------------------------------------------------ errors

/** Turn an error from the app's core, FFmpeg or Google into one sentence a player can act on. */
export function humanError(e: unknown): string {
  let raw = e instanceof Error ? e.message : typeof e === "string" ? e : (() => {
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  })();
  raw = raw.replace(/^(Error|error):\s*/, "").trim();
  const low = raw.toLowerCase();
  const has = (...words: string[]) => words.some((w) => low.includes(w));
  if (has("os error 112", "not enough space", "no space left", "disk full")) return "The drive is full. Free up some space and try again.";
  if (has("os error 32", "being used by another process", "sharing violation")) return "Another program is using the file. Close it and try again.";
  if (has("os error 5)", "os error 5 ", "access is denied", "permission denied")) return "Windows blocked access to the file. Check that the folder is not read-only.";
  if (has("os error 2)", "os error 3)", "cannot find the file", "cannot find the path", "no such file", "not found on disk", "no longer exists"))
    return "The file is missing. It may have been moved or deleted.";
  if (has("api key", "api_key", "permission_denied", "unauthenticated", "401", "403")) return "Google turned down the API key. Check it in Settings, under AI review.";
  if (has("resource_exhausted", "429", "quota", "rate limit")) return "Google's free limit is used up for now. Try again in a while.";
  if (has("timed out", "timeout", "deadline")) return "That took too long and was stopped. Try again.";
  if (has("dns", "connection refused", "network", "offline", "could not resolve", "failed to connect", "unreachable"))
    return "Rewatch could not reach the internet. Check the connection and try again.";
  if (has("invalid data found", "moov atom", "corrupt", "end of file")) return "The video file looks damaged, so this could not be done.";
  if (has("clip is too long", "too long to fit")) return raw.endsWith(".") ? raw : raw + ".";
  if (has("busy")) return raw.charAt(0).toUpperCase() + raw.slice(1).replace(/[.]?$/, ".");
  // Keep the first line only, and keep it short.
  let line = raw.split(/\r?\n/)[0].replace(/\s+/g, " ").trim();
  if (!line) return "Something went wrong. Try again.";
  if (line.length > 180) line = line.slice(0, 177).trimEnd() + "…";
  line = line.charAt(0).toUpperCase() + line.slice(1);
  return /[.!?…]$/.test(line) ? line : line + ".";
}

// ------------------------------------------------------------------ toasts

export interface ToastAction {
  label: string;
  run: () => void;
  /** Leave the toast up after the action. */
  keep?: boolean;
}

export interface ToastInput {
  text: ReactNode;
  kind?: "info" | "success" | "error" | "busy";
  detail?: ReactNode;
  actions?: ToastAction[];
  /** A file the toast is about: adds "Show in folder" and "Copy file". */
  path?: string | null;
  /** Milliseconds before it goes by itself; 0 keeps it until closed. */
  ms?: number;
  /** Reuse an id to replace a toast instead of stacking another. */
  id?: string;
  /** Called once when the toast goes, however it goes. */
  onClose?: () => void;
}

interface ToastItem extends ToastInput {
  id: string;
  since: number;
}

interface ToastApi {
  show: (t: ToastInput) => string;
  update: (id: string, t: Partial<ToastInput>) => void;
  dismiss: (id: string) => void;
  /** Show a job while it runs (with the time it has taken), then what came of it. */
  job: <R>(label: string, work: () => Promise<R>, done?: (result: R) => ToastInput) => Promise<R | undefined>;
}

const ToastContext = createContext<ToastApi | null>(null);
const ConfirmContext = createContext<((c: ConfirmInput) => Promise<boolean>) | null>(null);

export function useToast(): ToastApi {
  const t = useContext(ToastContext);
  if (!t) throw new Error("useToast outside UiProvider");
  return t;
}

export function useConfirm() {
  const c = useContext(ConfirmContext);
  if (!c) throw new Error("useConfirm outside UiProvider");
  return c;
}

function defaultMs(t: ToastInput): number {
  if (t.ms !== undefined) return t.ms;
  if (t.kind === "error" || t.kind === "busy") return 0;
  return t.path || t.actions?.length ? 10000 : 5000;
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const iv = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(iv);
  }, []);
  return <span className="num muted">{clock((Date.now() - since) / 1000)}</span>;
}

function ToastView({ t, onClose }: { t: ToastItem; onClose: () => void }) {
  const [hover, setHover] = useState(false);
  const [copied, setCopied] = useState(false);
  const ms = defaultMs(t);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!ms || hover) return;
    const id = window.setTimeout(() => close.current(), ms);
    return () => window.clearTimeout(id);
  }, [ms, hover, t.since, t.kind]);
  const Icon = t.kind === "error" ? CircleAlert : t.kind === "success" ? CircleCheck : t.kind === "busy" ? LoaderCircle : Info;
  return (
    <div
      className={`toast ${t.kind ?? "info"}`}
      role={t.kind === "error" ? "alert" : "status"}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      <Icon size={17} aria-hidden className={`ti ${t.kind === "busy" ? "spin" : ""}`} />
      <div className="tbody">
        <div className="tline">
          <span className="ttext">{t.text}</span>
          {t.kind === "busy" && <Elapsed since={t.since} />}
        </div>
        {t.detail && <div className="tdetail">{t.detail}</div>}
        {(t.path || t.actions?.length) && (
          <div className="tacts">
            {t.actions?.map((a) => (
              <button
                key={a.label}
                type="button"
                className="btn sm"
                onClick={() => {
                  a.run();
                  if (!a.keep) onClose();
                }}
              >
                {a.label}
              </button>
            ))}
            {t.path && (
              <>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() =>
                    api
                      .copyFile(t.path!)
                      .then(() => setCopied(true))
                      .catch(() => setCopied(false))
                  }
                  title="Puts the file on the clipboard. Paste it straight into Discord."
                >
                  {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                  {copied ? "Copied, paste it anywhere" : "Copy file"}
                </button>
                <button type="button" className="btn sm quiet" onClick={() => showInFolder(t.path!)}>
                  <FolderOpen size={14} aria-hidden />
                  Show in folder
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {t.kind !== "busy" && (
        <button type="button" className="btn quiet sq xs" aria-label="Close" onClick={onClose}>
          <X size={15} />
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ confirm

export interface ConfirmInput {
  title: string;
  body?: ReactNode;
  confirm: string;
  cancel?: string;
  danger?: boolean;
}

function ConfirmDialog({ c, onDone }: { c: ConfirmInput; onDone: (ok: boolean) => void }) {
  const ok = useRef<HTMLButtonElement>(null);
  const no = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useEffect(() => {
    // The safe answer gets the focus when the action cannot be taken back.
    (c.danger ? no : ok).current?.focus();
  }, [c.danger]);
  return createPortal(
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onDone(false)}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={c.body ? bodyId : undefined}
        data-own-keys=""
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onDone(false);
          if (e.key === "Tab") {
            // Keep the focus inside the dialog.
            e.preventDefault();
            (document.activeElement === ok.current ? no : ok).current?.focus();
          }
        }}
      >
        <h2 id={titleId}>{c.title}</h2>
        {c.body && (
          <div id={bodyId} className="modal-body">
            {c.body}
          </div>
        )}
        <div className="modal-acts">
          <button ref={no} type="button" className="btn" onClick={() => onDone(false)}>
            {c.cancel ?? "Cancel"}
          </button>
          <button ref={ok} type="button" className={`btn ${c.danger ? "danger-fill" : "primary"}`} onClick={() => onDone(true)}>
            {c.confirm}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ provider

export function UiProvider({ children }: { children: ReactNode }) {
  // The toasts live in a ref so several calls in a row see each other; a counter redraws.
  const list = useRef<ToastItem[]>([]);
  const [, redraw] = useState(0);
  const commit = useCallback((next: ToastItem[]) => {
    list.current = next;
    redraw((n) => n + 1);
  }, []);
  const toasts = list.current;
  const [ask, setAsk] = useState<{ c: ConfirmInput; resolve: (ok: boolean) => void } | null>(null);
  const seq = useRef(0);

  const dismiss = useCallback(
    (id: string) => {
      const gone = list.current.find((t) => t.id === id);
      if (!gone) return;
      commit(list.current.filter((t) => t.id !== id));
      gone.onClose?.();
    },
    [commit],
  );
  const show = useCallback(
    (t: ToastInput) => {
      const id = t.id ?? `t${++seq.current}`;
      const item: ToastItem = { ...t, id, since: Date.now() };
      const all = list.current;
      const at = all.findIndex((x) => x.id === id);
      if (at >= 0) {
        const old = all[at];
        commit(all.map((x, i) => (i === at ? item : x)));
        if (old.onClose && old.onClose !== t.onClose) old.onClose();
        return id;
      }
      // At most five at once. The oldest plain notice goes first; one offering an Undo goes last, since
      // pushing it out ends the chance to undo (and its onClose carries out the change).
      const next = [...all, item];
      const evicted: ToastItem[] = [];
      while (next.length > 5) {
        const older = next.slice(0, -1);
        let old = older.findIndex((x) => x.kind !== "busy" && !x.actions?.length && !x.onClose);
        if (old < 0) old = older.findIndex((x) => x.kind !== "busy");
        evicted.push(...next.splice(old >= 0 ? old : 0, 1));
      }
      commit(next);
      evicted.forEach((x) => x.onClose?.());
      return id;
    },
    [commit],
  );
  const update = useCallback(
    (id: string, t: Partial<ToastInput>) =>
      commit(list.current.map((x) => (x.id === id ? { ...x, ...t, since: t.kind && t.kind !== x.kind ? Date.now() : x.since } : x))),
    [commit],
  );
  const job = useCallback(
    async <R,>(label: string, work: () => Promise<R>, done?: (result: R) => ToastInput) => {
      const id = show({ text: label, kind: "busy" });
      try {
        const result = await work();
        const out = done ? done(result) : { text: "Done", kind: "success" as const, path: typeof result === "string" ? result : null };
        update(id, { kind: "success", ms: undefined, ...out, id });
        return result;
      } catch (e) {
        update(id, { kind: "error", text: humanError(e), detail: undefined, actions: undefined, path: null, ms: 0 });
        return undefined;
      }
    },
    [show, update],
  );
  const toastApi = useMemo(() => ({ show, update, dismiss, job }), [show, update, dismiss, job]);
  const confirm = useCallback((c: ConfirmInput) => new Promise<boolean>((resolve) => setAsk({ c, resolve })), []);

  return (
    <ToastContext.Provider value={toastApi}>
      <ConfirmContext.Provider value={confirm}>
        {children}
        {createPortal(
          <div className="toasts" aria-live="polite">
            {toasts.map((t) => (
              <ToastView key={t.id} t={t} onClose={() => dismiss(t.id)} />
            ))}
          </div>,
          document.body,
        )}
        {ask && (
          <ConfirmDialog
            c={ask.c}
            onDone={(ok) => {
              ask.resolve(ok);
              setAsk(null);
            }}
          />
        )}
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}

// ------------------------------------------------------------------ loading

export function Skeleton({ w, h, r, className = "", style }: { w?: number | string; h?: number | string; r?: number; className?: string; style?: CSSProperties }) {
  return <span className={`skel ${className}`} style={{ width: w, height: h, borderRadius: r, ...style }} aria-hidden />;
}

/** Keyboard key, for help text. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

/** True when a key press should be left to the element it happened in. */
export function ownsKeys(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.closest) return false;
  if (el.closest("[data-own-keys]")) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
