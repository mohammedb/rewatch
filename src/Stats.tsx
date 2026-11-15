import { useEffect, useState } from "react";
import { dataDragonVersion, ItemIcon } from "./ChampIcon";
import type { PgPlayer, PostGame } from "./types";

// The pieces the tables of numbers are made of: KDA and its ratio, rank crests, item,
// spell and rune slots, and a score for each player's game. Pictures and names come
// from Riot's public image host (Data Dragon), like the champions'.

const DD = "https://ddragon.leagueoflegends.com";

// ------------------------------------------------------------------ KDA

/** Kills and assists for each death; Infinity for a game without deaths. */
export function kdaRatio(k: number, d: number, a: number): number {
  if (d === 0) return k + a > 0 ? Infinity : 0;
  return (k + a) / d;
}

/** 1 (under 2) to 5 (5 or more, or no deaths): how the ratio is coloured. */
export function kdaTier(r: number): number {
  return r >= 5 ? 5 : r >= 4 ? 4 : r >= 3 ? 3 : r >= 2 ? 2 : 1;
}

/** "3.45 KDA", coloured by how good it is; "Perfect" without deaths. */
export function KdaRatio({ k, d, a, unit = true }: { k: number; d: number; a: number; unit?: boolean }) {
  const r = kdaRatio(k, d, a);
  const text = r === Infinity ? "Perfect" : r.toFixed(2);
  return (
    <span className={`kr t${kdaTier(r)}`} title={r === Infinity ? "No deaths" : `${text} kills and assists for each death`}>
      {text}
      {unit && <i> KDA</i>}
    </span>
  );
}

/** "7 / 3 / 9", deaths in red. */
export function Kda({ k, d, a }: { k: number; d: number; a: number }) {
  return (
    <span className="kdal num">
      {k}
      <i>/</i>
      <span className="d">{d}</span>
      <i>/</i>
      {a}
    </span>
  );
}

// ------------------------------------------------------------------ ranks

const TIER_COLOR: Record<string, string> = {
  IRON: "#a39a92",
  BRONZE: "#c99068",
  SILVER: "#b2bfcc",
  GOLD: "#e3b34c",
  PLATINUM: "#4fbfb3",
  EMERALD: "#45c78a",
  DIAMOND: "#84a9ff",
  MASTER: "#c98af0",
  GRANDMASTER: "#f06b6b",
  CHALLENGER: "#f4d47a",
};

export const tierColor = (tier?: string | null) => TIER_COLOR[(tier ?? "").toUpperCase()] ?? "#6f7684";

/** A gem in the tier's colour, crowned from Master up; hollow when unranked. */
export function Crest({ tier, size = 20 }: { tier?: string | null; size?: number }) {
  const t = (tier ?? "").toUpperCase();
  const c = tierColor(t);
  const ranked = t in TIER_COLOR;
  const apex = t === "MASTER" || t === "GRANDMASTER" || t === "CHALLENGER";
  return (
    <svg className="crest" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      {apex && <path d="M6.2 4.6 8.4 1.2 12 3.6 15.6 1.2 17.8 4.6Z" fill={c} />}
      <path d="M12 2.6 20.2 7.3v9.4L12 21.4 3.8 16.7V7.3Z" fill={c} fillOpacity={ranked ? 0.18 : 0.05} stroke={c} strokeOpacity={ranked ? 0.95 : 0.55} strokeWidth="1.4" strokeLinejoin="round" />
      {ranked && (
        <>
          <path d="M12 6.4 16.9 9.2v5.6L12 17.6 7.1 14.8V9.2Z" fill={c} />
          <path d="M12 6.4 16.9 9.2 12 12 7.1 9.2Z" fill="#fff" fillOpacity="0.34" />
          <path d="M12 12v5.6L7.1 14.8V9.2Z" fill="#000" fillOpacity="0.2" />
        </>
      )}
    </svg>
  );
}

/** "62%", hotter the higher: orange from 60, blue from 50, dim under 40. */
export function WinRate({ pct }: { pct: number }) {
  return <span className={`wr ${pct >= 60 ? "hot" : pct >= 50 ? "good" : pct < 40 ? "low" : ""}`}>{Math.round(pct)}%</span>;
}

/** Wins as a ring: blue for the share won, red for the rest, the percentage inside. */
export function WinRing({ wins, losses, size = 44 }: { wins: number; losses: number; size?: number }) {
  const n = wins + losses;
  const p = n ? wins / n : 0;
  const r = 18;
  const c = 2 * Math.PI * r;
  return (
    <svg className="wring" width={size} height={size} viewBox="0 0 44 44" role="img" aria-label={`${Math.round(p * 100)}% won`}>
      <circle cx="22" cy="22" r={r} className={`wr-bg ${n ? "" : "none"}`} />
      {n > 0 && <circle cx="22" cy="22" r={r} className="wr-fg" strokeDasharray={`${(c * p).toFixed(2)} ${c.toFixed(2)}`} transform="rotate(-90 22 22)" />}
      <text x="22" y="26.5" textAnchor="middle" className="wr-t">
        {n ? `${Math.round(p * 100)}%` : "—"}
      </text>
    </svg>
  );
}

// ------------------------------------------------------------------ Data Dragon lookups

interface Named {
  name: string;
  /** Picture address; for champions, the key their pictures are filed under. */
  icon: string;
}
type Kind = "spells" | "runes" | "items" | "champions";

interface DdSpell {
  key: string;
  name: string;
  image: { full: string };
}
interface DdRune {
  id: number;
  name: string;
  icon: string;
}
interface DdStyle extends DdRune {
  slots: { runes: DdRune[] }[];
}
interface DdChampion {
  key: string;
  id: string;
  name: string;
}

const lookups = new Map<Kind, Promise<Map<number, Named>>>();

/** Riot's names and pictures by id, read once a session. Empty when offline. */
function lookup(kind: Kind): Promise<Map<number, Named>> {
  let p = lookups.get(kind);
  if (!p) {
    p = dataDragonVersion()
      .then(async (v) => {
        const m = new Map<number, Named>();
        if (!v) return m;
        const file = { spells: "summoner", runes: "runesReforged", items: "item", champions: "champion" }[kind];
        const json = await (await fetch(`${DD}/cdn/${v}/data/en_US/${file}.json`)).json();
        if (kind === "spells") {
          for (const s of Object.values(json.data as Record<string, DdSpell>)) m.set(Number(s.key), { name: s.name, icon: `${DD}/cdn/${v}/img/spell/${s.image.full}` });
        } else if (kind === "runes") {
          for (const style of json as DdStyle[]) {
            m.set(style.id, { name: style.name, icon: `${DD}/cdn/img/${style.icon}` });
            for (const slot of style.slots) for (const r of slot.runes) m.set(r.id, { name: r.name, icon: `${DD}/cdn/img/${r.icon}` });
          }
        } else if (kind === "items") {
          for (const [id, it] of Object.entries(json.data as Record<string, { name: string }>)) m.set(Number(id), { name: it.name, icon: "" });
        } else {
          for (const c of Object.values(json.data as Record<string, DdChampion>)) m.set(Number(c.key), { name: c.name, icon: c.id });
        }
        return m;
      })
      .catch(() => new Map<number, Named>());
    lookups.set(kind, p);
  }
  return p;
}

export function useLookup(kind: Kind): Map<number, Named> | null {
  const [m, setM] = useState<Map<number, Named> | null>(null);
  useEffect(() => {
    let live = true;
    lookup(kind).then((x) => live && setM(x));
    return () => {
      live = false;
    };
  }, [kind]);
  return m;
}

/** A summoner spell's square picture. */
export function SpellIcon({ id, size = 18 }: { id: number; size?: number }) {
  const s = useLookup("spells")?.get(id);
  if (!s) return <span className="spell blank" style={{ width: size, height: size }} />;
  return <img className="spell" src={s.icon} alt={s.name} title={s.name} width={size} height={size} draggable={false} />;
}

/** A rune or rune path, round; the second path smaller. */
export function RuneIcon({ id, size = 18, path = false }: { id: number; size?: number; path?: boolean }) {
  const r = useLookup("runes")?.get(id);
  if (!r) return <span className={`rune blank ${path ? "path" : ""}`} style={{ width: size, height: size }} />;
  return <img className={`rune ${path ? "path" : ""}`} src={r.icon} alt={r.name} title={r.name} width={size} height={size} draggable={false} />;
}

const TRINKETS = new Set([3340, 3363, 3364, 3330, 2052]);

/**
 * The six item slots and the trinket's, as the game shows them. Riot's record lists
 * seven slots, the last for the trinket; the live feed only what was held.
 */
export function ItemSlots({ items, size = 22 }: { items: number[] | { id: number; name: string }[]; size?: number }) {
  const names = useLookup("items");
  const list = (items as (number | { id: number; name: string })[]).map((x) => (typeof x === "number" ? { id: x, name: "" } : x));
  let six = list;
  let trinket: { id: number; name: string } | null = null;
  if (typeof items[0] === "number" && list.length === 7) {
    six = list.slice(0, 6);
    trinket = list[6];
  } else {
    trinket = list.find((x) => TRINKETS.has(x.id)) ?? null;
    six = list.filter((x) => x !== trinket).slice(0, 6);
  }
  const slots = [...six, ...Array.from({ length: Math.max(0, 6 - six.length) }, () => ({ id: 0, name: "" }))];
  const named = (it: { id: number; name: string }) => it.name || names?.get(it.id)?.name || (it.id ? `Item ${it.id}` : "Empty slot");
  return (
    <span className="islots" style={{ ["--isz" as string]: `${size}px` }}>
      {slots.map((it, i) => (
        <ItemIcon key={i} id={it.id} name={named(it)} size={size} />
      ))}
      <span className="trk">
        <ItemIcon id={trinket?.id ?? 0} name={trinket ? named(trinket) : "No trinket"} size={size} />
      </span>
    </span>
  );
}

// ------------------------------------------------------------------ score

export interface PlayerScore {
  /** 0 to 10. */
  score: number;
  /** 1 for the best in the game. */
  place: number;
  of: number;
  /** Best on the winning team. */
  mvp: boolean;
  /** Best on the losing team. */
  ace: boolean;
}

/** What the score weighs, each against the other players in the game. */
const WEIGHTS: [number, (p: PgPlayer, mins: number) => number][] = [
  [0.3, (p) => (p.kills + p.assists) / Math.max(1, p.deaths)],
  [0.2, (p) => p.kp ?? 0],
  [0.18, (p, m) => p.damage / m],
  [0.12, (p, m) => p.gold / m],
  [0.08, (p, m) => p.vision / m],
  [0.07, (p, m) => (p.taken + p.mitigated) / m],
  [0.05, (p, m) => p.objectives / m],
];

export const SCORE_HINT =
  "Rewatch's own score, 0 to 10: KDA, kill participation, damage, gold, vision, damage soaked and objectives, each against the other players in the game. MVP is the best on the winning team, ACE the best on the losing team.";

/** Everyone's score in the game, by participant id. */
export function scoresOf(pg: PostGame): Map<number, PlayerScore> {
  const ps = pg.players;
  const n = ps.length;
  const out = new Map<number, PlayerScore>();
  if (n < 2) return out;
  const mins = Math.max(1, pg.duration / 60);
  const raw = ps.map(() => 0);
  for (const [w, f] of WEIGHTS) {
    const vals = ps.map((p) => f(p, mins));
    vals.forEach((v, i) => {
      const below = vals.filter((x) => x < v).length;
      const same = vals.filter((x) => x === v).length - 1;
      raw[i] += w * ((below + same / 2) / (n - 1));
    });
  }
  const best = (team: boolean) => {
    let at = -1;
    ps.forEach((p, i) => {
      if (p.win === team && (at < 0 || raw[i] > raw[at])) at = i;
    });
    return at;
  };
  const anyWin = ps.some((p) => p.win);
  const mvp = anyWin ? best(true) : raw.indexOf(Math.max(...raw));
  const ace = anyWin ? best(false) : -1;
  ps.forEach((p, i) => {
    out.set(p.id, {
      score: Math.round(raw[i] * 100) / 10,
      place: 1 + raw.filter((r) => r > raw[i]).length,
      of: n,
      mvp: i === mvp,
      ace: i === ace,
    });
  });
  return out;
}

export const ordinal = (n: number) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

/** "8.4" over "MVP", "ACE" or the place in the game. */
export function ScoreBadge({ s, size = "md" }: { s: PlayerScore; size?: "sm" | "md" }) {
  const tag = s.mvp ? "MVP" : s.ace ? "ACE" : ordinal(s.place);
  return (
    <span className={`score ${size} ${s.mvp ? "mvp" : s.ace ? "ace" : s.place <= 3 ? "top" : ""}`} title={`Score ${s.score.toFixed(1)}, ${ordinal(s.place)} of ${s.of}. ${SCORE_HINT}`}>
      <b className="num">{s.score.toFixed(1)}</b>
      <small>{tag}</small>
    </span>
  );
}

const MULTI = ["", "", "Double kill", "Triple kill", "Quadra kill", "Penta kill"];

/** The best multi-kill of the game, from a double up. */
export function MultiChip({ n }: { n: number }) {
  if (n < 2) return null;
  const k = Math.min(n, 5);
  return <span className={`mchip m${k}`}>{MULTI[k]}</span>;
}

/** "24.1k" from ten thousand up, else the number with separators. */
export const short = (n: number) => (Math.abs(n) >= 10_000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n).toLocaleString());
