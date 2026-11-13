import type { GameEvent, MatchSummary } from "./types";

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? h + ":" : ""}${mm}:${String(r).padStart(2, "0")}`;
}

export function bytes(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + " GB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(0) + " MB";
  return Math.max(1, Math.round(n / 1024)) + " KB";
}

export function when(epochMs: number): string {
  const d = new Date(epochMs);
  const today = new Date();
  const days = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86400000,
  );
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

export type Category = "kill" | "death" | "assist" | "fight" | "objective" | "structure" | "item";

export const CATEGORY_LABEL: Record<Category | "bookmark" | "note", string> = {
  kill: "My kills",
  death: "My deaths",
  assist: "My assists",
  fight: "Other kills",
  objective: "Objectives",
  structure: "Towers",
  item: "Item buys",
  bookmark: "Bookmarks",
  note: "Notes",
};

/** Which timeline group an event belongs to, or null if it is not shown. */
export function categorize(e: GameEvent): Category | null {
  switch (e.kind) {
    case "ChampionKill":
      return e.role ?? "fight";
    case "Multikill":
      return e.mine ? "kill" : "fight";
    case "Ace":
      return "fight";
    case "DragonKill":
    case "BaronKill":
    case "HeraldKill":
    case "HordeKill":
    case "AtakhanKill":
      return "objective";
    case "TurretKilled":
    case "InhibKilled":
      return "structure";
    case "ItemPurchased":
      return e.mine ? "item" : null;
    default:
      return null;
  }
}

const MULTI: Record<string, string> = { "2": "Double kill", "3": "Triple kill", "4": "Quadra kill", "5": "Penta kill" };

export function describe(e: GameEvent): string {
  const killer = e.killerChamp || e.killer || "Someone";
  const victim = e.victimChamp || e.victim || "someone";
  const side = e.good === undefined ? "" : e.good ? " for your team" : " for the enemy";
  switch (e.kind) {
    case "ChampionKill":
      if (e.role === "kill") return `You killed ${victim}`;
      if (e.role === "death") return `${isUnit(e.killer) ? "You were executed" : killer + " killed you"}`;
      if (e.role === "assist") return `${killer} killed ${victim} (assist)`;
      return `${isUnit(e.killer) ? victim + " was executed" : killer + " killed " + victim}`;
    case "Multikill":
      return `${MULTI[e.detail ?? ""] ?? "Multikill"}: ${killer}`;
    case "Ace":
      return `Ace${side}`;
    case "DragonKill":
      return `${e.detail ?? ""} dragon${side}`.trim();
    case "BaronKill":
      return `Baron${side}`;
    case "HeraldKill":
      return `Rift Herald${side}`;
    case "HordeKill":
      return `Voidgrub${side}`;
    case "AtakhanKill":
      return `Atakhan${side}`;
    case "TurretKilled":
      return e.good === false ? "Your tower fell" : e.good ? "Enemy tower destroyed" : "Tower destroyed";
    case "InhibKilled":
      return e.good === false ? "Your inhibitor fell" : e.good ? "Enemy inhibitor destroyed" : "Inhibitor destroyed";
    case "ItemPurchased":
      return `Bought ${e.detail ?? "an item"}`;
    default:
      return e.kind;
  }
}

function isUnit(name?: string): boolean {
  return !name || /^(Minion_|Turret_|SRU_|Barracks_)/.test(name);
}

/** In-game clock at a given video time, from the recorded clock samples. */
export function gameClockAt(samples: [number, number][], t: number): number | null {
  if (!samples.length) return null;
  let best = samples[0];
  for (const s of samples) {
    if (s[0] <= t) best = s;
    else break;
  }
  const g = best[1] + (t - best[0]);
  return g < 0 ? null : g;
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

const LANES: Record<string, string> = { TOP: "Top", JUNGLE: "Jungle", MIDDLE: "Mid", BOTTOM: "Bot", UTILITY: "Support" };

/** "MIDDLE" -> "Mid". Empty when the game assigned no lane. */
export function laneName(position?: string | null): string {
  return LANES[(position ?? "").toUpperCase()] ?? "";
}

/** Games recorded in the last week that nobody has marked as reviewed yet. */
export function toReview(matches: MatchSummary[] | null): MatchSummary[] {
  const since = Date.now() - 7 * 86400e3;
  return (matches ?? []).filter((m) => m.mode === "game" && !m.reviewed && m.startedEpochMs >= since && !!m.game?.me);
}

/** "12 minutes ago", "3 hours ago", "2 days ago". */
export function ago(epochMs: number): string {
  const min = Math.max(0, Math.round((Date.now() - epochMs) / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"} ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

/** A day heading: "Today", "Yesterday", "Tuesday", or "Tuesday 3 November" further back. */
export function dayLabel(epochMs: number): string {
  const d = new Date(epochMs);
  const t = new Date();
  const days = Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400e3);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() !== t.getFullYear() ? { year: "numeric" } : {}) });
}

/** Time of day only, for lists already grouped by day. */
export function timeOfDay(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
