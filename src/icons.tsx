// One place that decides which picture stands for what. Interface controls and
// game events use the Lucide set; champions and items use Riot's own images.

import {
  Bookmark, Bug, Castle, Coins, Crown, Eye, Flame, FlaskConical, Gem, Handshake, Mountain, Skull, Sparkles,
  MessageSquare, Swords, Users, Waves, Wind, Zap, type LucideIcon,
} from "lucide-react";
import type { GameEvent } from "./types";

const DRAGON: Record<string, LucideIcon> = {
  Fire: Flame, Earth: Mountain, Water: Waves, Air: Wind, Hextech: Zap, Chemtech: FlaskConical, Elder: Sparkles,
};

/** Glyph for a game event that has no champion or item picture of its own. */
export function eventGlyph(e: GameEvent): LucideIcon {
  switch (e.kind) {
    case "DragonKill": return DRAGON[e.detail ?? ""] ?? Flame;
    case "BaronKill": return Crown;
    case "HeraldKill": return Eye;
    case "HordeKill": return Bug;
    case "AtakhanKill": return Skull;
    case "TurretKilled": return Castle;
    case "InhibKilled": return Gem;
    case "Multikill": return Swords;
    case "Ace": return Users;
    case "ItemPurchased": return Coins;
    default: return Swords;
  }
}

/** The Rewatch mark, as on the website: a ring, a stem and a leg. */
export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg className="logo" width={size * 0.79} height={size} viewBox="257 189 510 646" aria-hidden="true">
      <g fill="currentColor">
        <circle cx="489" cy="421" r="186" fill="none" stroke="currentColor" strokeWidth="92" />
        <rect x="257" y="421" width="92" height="414" />
        <polygon points="472,609 595,609 767,835 644,835" />
      </g>
    </svg>
  );
}

export const FILTER_ICON: Record<string, LucideIcon> = {
  kill: Swords, death: Skull, assist: Handshake, fight: Users, objective: Flame, structure: Castle,
  item: Coins, bookmark: Bookmark, note: MessageSquare,
};
