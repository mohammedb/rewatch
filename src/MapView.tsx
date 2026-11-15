import { useState } from "react";
import { Portrait, useVersion, type Side } from "./ChampIcon";

// A minimap with things placed on it, in game units (Riot's x and y, y pointing up).

/** Each map's playable area: x and y at the bottom left, then at the top right. */
export const BOUNDS: Record<number, [number, number, number, number]> = {
  11: [-120, -120, 14870, 14980],
  12: [-28, -19, 12849, 12858],
};

/** Whether things can be placed on this map. */
export const hasMap = (mapId?: number | null) => mapId != null && mapId in BOUNDS;

export interface MapDot {
  key: string;
  x: number;
  y: number;
  /** Colour: "death", "kill", "ally", "enemy" or "other". */
  tone: string;
  /** Says what the dot is, for the tooltip and screen readers. */
  label: string;
  /** Second line of the tooltip. */
  detail?: string;
  /** A champion picture instead of a dot. */
  championKey?: string;
  champion?: string;
  side?: Side;
  /** Picked: play this moment. */
  onPick?: () => void;
}

export function MapView({ mapId, dots, label, empty }: { mapId: number; dots: MapDot[]; label: string; empty?: string }) {
  const version = useVersion();
  const [failed, setFailed] = useState(false);
  const [hot, setHot] = useState<string | null>(null);
  const b = BOUNDS[mapId] ?? BOUNDS[11];
  const left = (x: number) => Math.min(98, Math.max(2, ((x - b[0]) / (b[2] - b[0])) * 100));
  const top = (y: number) => Math.min(98, Math.max(2, (1 - (y - b[1]) / (b[3] - b[1])) * 100));
  const tip = dots.find((d) => d.key === hot);

  return (
    <div className={`mapview ${failed || !version ? "plain" : ""}`} role="group" aria-label={label}>
      {version && !failed && (
        <img className="map-img" src={`https://ddragon.leagueoflegends.com/cdn/${version}/img/map/map${mapId}.png`} alt="" draggable={false} onError={() => setFailed(true)} />
      )}
      {dots.map((d) => {
        const style = { left: `${left(d.x)}%`, top: `${top(d.y)}%` };
        const body = d.championKey ? <Portrait championKey={d.championKey} name={d.champion ?? d.label} size={22} side={d.side} /> : <i />;
        const props = {
          className: `mdot ${d.tone} ${d.championKey ? "pic" : ""} ${hot === d.key ? "hot" : ""}`,
          style,
          onPointerEnter: () => setHot(d.key),
          onPointerLeave: () => setHot((h) => (h === d.key ? null : h)),
        };
        return d.onPick ? (
          <button key={d.key} {...props} onClick={d.onPick} onFocus={() => setHot(d.key)} onBlur={() => setHot(null)} aria-label={`${d.label}${d.detail ? `, ${d.detail}` : ""}. Play it.`}>
            {body}
          </button>
        ) : (
          <span key={d.key} {...props} role="img" aria-label={`${d.label}${d.detail ? `, ${d.detail}` : ""}`}>
            {body}
          </span>
        );
      })}
      {tip && (
        <div className={`map-tip ${left(tip.x) > 60 ? "flip" : ""} ${top(tip.y) < 25 ? "below" : ""}`} style={{ left: `${left(tip.x)}%`, top: `${top(tip.y)}%` }} aria-hidden>
          <b>{tip.label}</b>
          {tip.detail && <span>{tip.detail}</span>}
          {tip.onPick && <small>Click to watch</small>}
        </div>
      )}
      {dots.length === 0 && empty && <p className="map-empty">{empty}</p>}
    </div>
  );
}
