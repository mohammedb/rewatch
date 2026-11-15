// A picture of one game to paste in Discord: the result, LP, KDA, damage share and
// where you died. It is drawn on a canvas from what the app already has. Data Dragon
// serves its pictures to any page, so a canvas with them on it can still be saved; the
// rank emblem comes with the app.

import { dataDragonVersion } from "./ChampIcon";
import { clock, laneName } from "./format";
import { BOUNDS } from "./MapView";
import { queueLabel, standing } from "./Rank";
import { emblemUrl } from "./Stats";
import type { MatchFull } from "./types";

const W = 1200;
const H = 630;
const BG = "#0c0e13";
const TILE = "rgba(255, 255, 255, 0.045)";
const LINE = "rgba(255, 255, 255, 0.09)";
const INK = "#eceef2";
const MUTED = "#8a91a0";
const WIN = "#4cc38a";
const LOSS = "#e84057";
const DEATH = "#ff4d5e";
const KILL = "#5b8def";
const BRAND = "#f2c94c";
const DISPLAY = `"Archivo", "Segoe UI", system-ui, sans-serif`;
const SANS = `"Geist", "Segoe UI", system-ui, sans-serif`;

function picture(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Whether there is enough to make a card: a result or Riot's record. */
export function canShare(match: MatchFull): boolean {
  return match.mode === "game" && (!!match.postgame?.players.some((p) => p.id === match.postgame!.me) || !!match.game?.me);
}

/** The card as a PNG data URL. */
export async function shareCardPng(match: MatchFull): Promise<string> {
  const pg = match.postgame ?? null;
  const mine = pg?.players.find((p) => p.id === pg.me) ?? null;
  const live = match.game?.me ?? null;
  const champion = mine?.champion || live?.champion || "Game";
  const championKey = mine?.championKey || live?.championKey || "";
  const [k, d, a] = mine ? [mine.kills, mine.deaths, mine.assists] : [live?.kills ?? 0, live?.deaths ?? 0, live?.assists ?? 0];
  const cs = mine?.cs ?? live?.cs ?? null;
  const won = mine ? mine.win : match.game?.result === "Win" ? true : match.game?.result === "Lose" ? false : null;
  const secs = pg?.duration ?? match.game?.length ?? null;
  const lane = laneName(mine?.position || live?.position);
  const queue = match.game?.queueName || (match.rank ? queueLabel(match.rank.queue) : "");
  const date = new Date(match.startedEpochMs).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const tone = won === true ? WIN : won === false ? LOSS : MUTED;

  const map = pg && pg.me && pg.mapId in BOUNDS ? pg.mapId : null;
  const deaths = map && pg ? pg.kills.filter((x) => x.victim === pg.me) : [];
  const kills = map && pg ? pg.kills.filter((x) => x.killer === pg.me) : [];

  const version = await dataDragonVersion();
  const emblemSrc = emblemUrl(match.rank?.tier);
  const [portrait, minimap, emblem] = await Promise.all([
    version && championKey ? picture(`https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${championKey}.png`) : Promise.resolve(null),
    version && map ? picture(`https://ddragon.leagueoflegends.com/cdn/${version}/img/map/map${map}.png`) : Promise.resolve(null),
    emblemSrc ? picture(emblemSrc) : Promise.resolve(null),
  ]);
  try {
    await Promise.all([document.fonts.load(`700 64px ${DISPLAY}`), document.fonts.load(`600 28px ${SANS}`), document.fonts.load(`400 22px ${SANS}`)]);
  } catch {
    /* the fallback fonts will do */
  }

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const c = canvas.getContext("2d");
  if (!c) throw new Error("This PC could not draw the picture");

  // Background, tinted by the result from the top left.
  c.fillStyle = BG;
  c.fillRect(0, 0, W, H);
  const glow = c.createRadialGradient(140, 90, 0, 140, 90, 760);
  glow.addColorStop(0, won === true ? "rgba(76, 195, 138, 0.20)" : won === false ? "rgba(232, 64, 87, 0.20)" : "rgba(138, 145, 160, 0.12)");
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  c.fillStyle = glow;
  c.fillRect(0, 0, W, H);
  c.fillStyle = tone;
  c.fillRect(0, 0, W, 6);

  // Who and how it went.
  const left = 64;
  c.save();
  c.beginPath();
  c.roundRect(left, 64, 132, 132, 20);
  c.clip();
  if (portrait) c.drawImage(portrait, left, 64, 132, 132);
  else {
    c.fillStyle = "#1b1f29";
    c.fillRect(left, 64, 132, 132);
    c.fillStyle = INK;
    c.font = `700 56px ${DISPLAY}`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(champion.slice(0, 1).toUpperCase(), left + 66, 132);
  }
  c.restore();
  c.strokeStyle = tone;
  c.lineWidth = 3;
  c.beginPath();
  c.roundRect(left, 64, 132, 132, 20);
  c.stroke();

  c.textAlign = "left";
  c.textBaseline = "alphabetic";
  const tx = left + 132 + 28;
  c.fillStyle = tone;
  c.font = `800 64px ${DISPLAY}`;
  c.fillText(won === true ? "Victory" : won === false ? "Defeat" : "Game over", tx, 122);
  c.fillStyle = INK;
  c.font = `600 28px ${SANS}`;
  c.fillText([champion, lane].filter(Boolean).join(" · "), tx, 162);
  c.fillStyle = MUTED;
  c.font = `400 22px ${SANS}`;
  c.fillText([queue, secs ? clock(secs) : "", date].filter(Boolean).join(" · "), tx, 194);

  // LP.
  let y = 262;
  if (match.rank) {
    let x = left;
    if (match.rank.delta != null) {
      const delta = match.rank.delta;
      const text = `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta)} LP`;
      c.font = `800 38px ${DISPLAY}`;
      c.fillStyle = delta > 0 ? WIN : delta < 0 ? LOSS : MUTED;
      c.fillText(text, x, y);
      x += c.measureText(text).width + 18;
    }
    if (emblem) {
      c.drawImage(emblem, x, y - 31, 48, 36);
      x += 48 + 8;
    }
    c.font = `500 24px ${SANS}`;
    c.fillStyle = MUTED;
    c.fillText(standing(match.rank), x, y);
  }

  // The numbers, as tiles: two by two beside the map, in a row without one.
  const team = pg && mine ? pg.players.filter((p) => p.teamId === mine.teamId) : [];
  const teamKills = team.reduce((s, p) => s + p.kills, 0);
  const minutes = secs ? secs / 60 : 0;
  const tiles: { label: string; big: string; small: string }[] = [
    { label: "KDA", big: `${k} / ${d} / ${a}`, small: d === 0 ? "Perfect, no deaths" : `${((k + a) / d).toFixed(1)} ratio` },
  ];
  if (mine?.dmgShare != null) tiles.push({ label: "Damage share", big: `${Math.round(mine.dmgShare * 100)}%`, small: `${mine.damage.toLocaleString()} to champions` });
  if (mine?.kp != null) tiles.push({ label: "Kill participation", big: `${Math.round(mine.kp * 100)}%`, small: `${k + a} of ${teamKills} kills` });
  if (cs != null) tiles.push({ label: "CS", big: String(cs), small: minutes >= 1 ? `${(cs / minutes).toFixed(1)} a minute` : "" });
  const cols = map ? 2 : 4;
  const gap = 14;
  const area = map ? 640 - left : W - left * 2;
  const tw = (area - gap * (cols - 1)) / cols;
  const th = 116;
  const top = match.rank ? 300 : 260;
  tiles.forEach((t, i) => {
    const x = left + (i % cols) * (tw + gap);
    const ty = top + Math.floor(i / cols) * (th + gap);
    c.fillStyle = TILE;
    c.beginPath();
    c.roundRect(x, ty, tw, th, 14);
    c.fill();
    c.strokeStyle = LINE;
    c.lineWidth = 1;
    c.stroke();
    c.fillStyle = MUTED;
    c.font = `500 19px ${SANS}`;
    c.fillText(t.label, x + 20, ty + 34);
    c.fillStyle = INK;
    // Shrink a long KDA until it fits its tile.
    let fs = 40;
    c.font = `800 ${fs}px ${DISPLAY}`;
    while (fs > 24 && c.measureText(t.big).width > tw - 40) c.font = `800 ${--fs}px ${DISPLAY}`;
    c.fillText(t.big, x + 20, ty + 76);
    c.fillStyle = MUTED;
    c.font = `400 17px ${SANS}`;
    c.fillText(t.small, x + 20, ty + 100);
  });

  // Where you died, and where you got your kills.
  if (map && pg) {
    const size = 452;
    const mx = W - 64 - size;
    const my = 64;
    c.save();
    c.beginPath();
    c.roundRect(mx, my, size, size, 16);
    c.clip();
    if (minimap) {
      c.drawImage(minimap, mx, my, size, size);
      c.fillStyle = "rgba(8, 10, 14, 0.38)";
      c.fillRect(mx, my, size, size);
    } else {
      c.fillStyle = "#151922";
      c.fillRect(mx, my, size, size);
    }
    const b = BOUNDS[map];
    const px = (x: number) => mx + Math.min(0.98, Math.max(0.02, (x - b[0]) / (b[2] - b[0]))) * size;
    const py = (v: number) => my + Math.min(0.98, Math.max(0.02, 1 - (v - b[1]) / (b[3] - b[1]))) * size;
    const dot = (x: number, v: number, r: number, fill: string) => {
      c.beginPath();
      c.arc(px(x), py(v), r, 0, Math.PI * 2);
      c.fillStyle = fill;
      c.fill();
      c.lineWidth = 3;
      c.strokeStyle = "rgba(8, 10, 14, 0.85)";
      c.stroke();
    };
    for (const x of kills) dot(x.x, x.y, 8, KILL);
    for (const x of deaths) dot(x.x, x.y, 11, DEATH);
    c.restore();
    c.strokeStyle = LINE;
    c.lineWidth = 1;
    c.beginPath();
    c.roundRect(mx, my, size, size, 16);
    c.stroke();

    // Legend under the map.
    let lx = mx;
    const ly = my + size + 36;
    const key = (fill: string, r: number, text: string) => {
      c.beginPath();
      c.arc(lx + r, ly - 7, r, 0, Math.PI * 2);
      c.fillStyle = fill;
      c.fill();
      lx += r * 2 + 10;
      c.fillStyle = INK;
      c.font = `500 20px ${SANS}`;
      c.fillText(text, lx, ly);
      lx += c.measureText(text).width + 28;
    };
    key(DEATH, 9, deaths.length === 1 ? "1 death" : `${deaths.length} deaths`);
    key(KILL, 7, kills.length === 1 ? "1 kill" : `${kills.length} kills`);
  }

  // Signature.
  c.fillStyle = BRAND;
  c.font = `800 24px ${DISPLAY}`;
  c.fillText("Rewatch", left, H - 36);

  return canvas.toDataURL("image/png");
}
