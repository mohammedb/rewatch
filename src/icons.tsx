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

export const FILTER_ICON: Record<string, LucideIcon> = {
  kill: Swords, death: Skull, assist: Handshake, fight: Users, objective: Flame, structure: Castle,
  item: Coins, bookmark: Bookmark, note: MessageSquare,
};
