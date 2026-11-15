// Sample data so the interface can be worked on in a plain browser. Never used
// inside the desktop app.

import type {
  Coach, Extras, GameEvent, Highlight, TeamReview, Insights, LeagueBackup, MatchFull, MatchSummary, MatchupNote, PgKill, PgPlayer, PlayerRanks, PlayerRow, PostGame, RankChange, Review, Settings, Stats, Status,
  Story, TrendMatch, TrendPg, TrendSpot, UpdateInfo, Voice, WatchPeer,
} from "./types";

const LANE: Record<string, string> = { Rin: "MIDDLE", Vex1: "MIDDLE", Sindre: "JUNGLE", Rook: "JUNGLE", Kaja: "BOTTOM", Lumen: "BOTTOM", Tor: "UTILITY", Peel: "UTILITY", Ida: "TOP", Stone: "TOP" };
/** A plausible build at the end of the game for each sample champion, trinket last. */
const BUILD: Record<string, [number, string][]> = {
  Ahri: [[3157, "Zhonya's Hourglass"], [3020, "Sorcerer's Shoes"], [4645, "Shadowflame"], [3089, "Rabadon's Deathcap"], [3135, "Void Staff"], [3340, "Stealth Ward"]],
  LeeSin: [[6692, "Eclipse"], [3047, "Plated Steelcaps"], [3071, "Black Cleaver"], [6333, "Death's Dance"], [3364, "Oracle Lens"]],
  Jinx: [[6672, "Kraken Slayer"], [3006, "Berserker's Greaves"], [3031, "Infinity Edge"], [3046, "Phantom Dancer"], [3036, "Lord Dominik's Regards"], [3363, "Farsight Alteration"]],
  Thresh: [[3869, "Celestial Opposition"], [3047, "Plated Steelcaps"], [3190, "Locket of the Iron Solari"], [3109, "Knight's Vow"], [3364, "Oracle Lens"]],
  Ornn: [[6665, "Jak'Sho, The Protean"], [3047, "Plated Steelcaps"], [3068, "Sunfire Aegis"], [3075, "Thornmail"], [3065, "Spirit Visage"], [3340, "Stealth Ward"]],
  Zed: [[3142, "Youmuu's Ghostblade"], [3158, "Ionian Boots of Lucidity"], [6694, "Serylda's Grudge"], [3814, "Edge of Night"], [3340, "Stealth Ward"]],
  Vi: [[3071, "Black Cleaver"], [3111, "Mercury's Treads"], [3053, "Sterak's Gage"], [6610, "Sundered Sky"], [3364, "Oracle Lens"]],
  Kaisa: [[6672, "Kraken Slayer"], [3006, "Berserker's Greaves"], [3124, "Guinsoo's Rageblade"], [3115, "Nashor's Tooth"], [3085, "Runaan's Hurricane"], [3363, "Farsight Alteration"]],
  Nautilus: [[3876, "Solstice Sleigh"], [3047, "Plated Steelcaps"], [3190, "Locket of the Iron Solari"], [3050, "Zeke's Convergence"], [3364, "Oracle Lens"]],
  Garen: [[6631, "Stridebreaker"], [3047, "Plated Steelcaps"], [3053, "Sterak's Gage"], [6333, "Death's Dance"], [3742, "Dead Man's Plate"], [3340, "Stealth Ward"]],
};
const row = (name: string, champion: string, key: string, team: string, k: number, d: number, a: number, cs: number, isMe = false): PlayerRow => ({
  name, isMe, champion, championKey: key, team, position: LANE[name] ?? "", level: isMe ? 14 : Math.min(18, 10 + Math.round(cs / 45)), kills: k, deaths: d, assists: a, cs,
  items: (BUILD[key] ?? []).map(([id, n]) => ({ id, name: n })),
});

const players: PlayerRow[] = [
  row("Rin", "Ahri", "Ahri", "ORDER", 7, 3, 9, 212, true),
  row("Sindre", "Lee Sin", "LeeSin", "ORDER", 4, 5, 11, 148),
  row("Kaja", "Jinx", "Jinx", "ORDER", 9, 4, 6, 241),
  row("Tor", "Thresh", "Thresh", "ORDER", 1, 6, 17, 31),
  row("Ida", "Ornn", "Ornn", "ORDER", 2, 4, 10, 190),
  row("Vex1", "Zed", "Zed", "CHAOS", 8, 6, 3, 220),
  row("Rook", "Vi", "Vi", "CHAOS", 3, 5, 8, 140),
  row("Lumen", "Kai'Sa", "Kaisa", "CHAOS", 7, 4, 5, 232),
  row("Peel", "Nautilus", "Nautilus", "CHAOS", 1, 5, 12, 28),
  row("Stone", "Garen", "Garen", "CHAOS", 3, 3, 4, 205),
];

const ev = (t: number, kind: string, extra: Partial<GameEvent> = {}): GameEvent => ({ t, gameTime: t + 600, kind, mine: false, ...extra });

const events: GameEvent[] = [
  ev(4, "ItemPurchased", { mine: true, detail: "Lost Chapter", itemId: 3802, good: true }),
  ev(11, "ChampionKill", { killer: "Rin", killerChamp: "Ahri", victim: "Vex1", victimChamp: "Zed", role: "kill", mine: true, good: true, assisters: ["Sindre"] }),
  ev(19, "DragonKill", { detail: "Fire", killer: "Sindre", killerChamp: "Lee Sin", good: true }),
  ev(27, "ChampionKill", { killer: "Rook", killerChamp: "Vi", victim: "Tor", victimChamp: "Thresh", good: false }),
  ev(34, "TurretKilled", { detail: "Turret_T2_C_05_A", good: true }),
  ev(41, "ChampionKill", { killer: "Vex1", killerChamp: "Zed", victim: "Rin", victimChamp: "Ahri", role: "death", mine: true, good: false }),
  ev(52, "ItemPurchased", { mine: true, detail: "Zhonya's Hourglass", itemId: 3157, good: true }),
  ev(63, "ChampionKill", { killer: "Kaja", killerChamp: "Jinx", victim: "Lumen", victimChamp: "Kai'Sa", role: "assist", mine: true, good: true, assisters: ["Rin"] }),
  ev(64, "ChampionKill", { killer: "Kaja", killerChamp: "Jinx", victim: "Peel", victimChamp: "Nautilus", good: true }),
  ev(67, "ChampionKill", { killer: "Rook", killerChamp: "Vi", victim: "Sindre", victimChamp: "Lee Sin", good: false }),
  ev(66, "Multikill", { killer: "Kaja", killerChamp: "Jinx", detail: "2", good: true }),
  ev(78, "BaronKill", { killer: "Rook", killerChamp: "Vi", good: false }),
  ev(86, "TurretKilled", { detail: "Turret_T1_L_03_A", good: false }),
  ev(95, "ChampionKill", { killer: "Rin", killerChamp: "Ahri", victim: "Stone", victimChamp: "Garen", role: "kill", mine: true, good: true }),
  ev(104, "InhibKilled", { detail: "Barracks_T2_C1", good: true }),
  ev(112, "ItemPurchased", { mine: true, detail: "Shadowflame", itemId: 4645, good: true }),
];

// Numbers over the two sample minutes, shaped like a real game's.
const stats: Stats = (() => {
  const t = Array.from({ length: 13 }, (_, i) => i * 10);
  const curve = (end: number, bend: number) => t.map((x) => Math.round(end * Math.pow(x / 120, bend)));
  return {
    t,
    gold: t.map((x) => Math.round(500 + 900 * Math.abs(Math.sin(x / 26)))),
    players: players.map((p, i) => ({
      name: p.name,
      cs: curve(p.cs, 1 + (i % 3) * 0.15),
      level: t.map((x) => Math.min(14, 9 + Math.floor((x / 120) * 5 + (i % 2) * 0.4))),
      kills: curve(p.kills, 1.4),
      deaths: curve(p.deaths, 1.2),
      assists: curve(p.assists, 1.1),
      itemGold: t.map((x) => Math.round((3200 + (i % 4) * 450) + (x / 120) * (7600 + (i % 3) * 900))),
      wardScore: t.map((x) => Math.round((12 + i * 2) * (x / 120) + 6)),
      dead: t.map((x) => (i === 0 ? x >= 40 && x <= 50 : false)),
    })),
  };
})();

const voice: Voice = {
  mic: [[8, 12.5], [38, 43], [61, 64], [76, 81.5], [93, 96]],
  discord: [[3, 7], [10, 15], [25, 29], [39.5, 46], [60, 67.5], [74, 84], [92, 99], [108, 112]],
};

const extras: Extras[] = [
  {
    friend: "Kaja", code: "kaja", player: "Kaja", champion: "Jinx", championKey: "Jinx",
    notes: [{ id: "k1", t: 62, text: "I had flash here. Should have gone in with you." }],
    drawings: [{ id: "kd1", t: 64, view: "Rin", shapes: [{ tool: "arrow", color: "#4c9dff", pts: [[0.3, 0.7], [0.48, 0.52]] }] }],
    voice: [[10.5, 14], [40, 45.5], [62, 67], [95, 98.5]],
  },
  {
    friend: "Sindre", code: "sindre", player: "Sindre", champion: "Lee Sin", championKey: "LeeSin",
    notes: [{ id: "s1", t: 76, text: "Baron was my call, too late. Next time I ping it 20 s earlier." }],
    drawings: [],
    voice: [[3.5, 6.5], [25.5, 28.5], [74, 79], [108.5, 111.5]],
  },
];

const insights: Insights = {
  model: "gemini-decision-1",
  deaths: [{ t: 41, avoidable: 0.81, sawItComing: 0.22, allyClose: 0.31, cause: "no_vision", causeP: 0.58, fight: "caught_alone", fightP: 0.77, positioning: 0.4 }],
};

const builtInTitles = [
  ["Ahri", "Solid Citizen", "7 / 3 / 9"], ["Lee Sin", "Dragon Landlord", "took 3 dragons, barons or other big monsters"], ["Jinx", "The Carry", "9 kills, the most in the game"],
  ["Thresh", "Wingman Of The Game", "17 assists, the most in the game"], ["Ornn", "Quietly Useful", "2 / 4 / 10"], ["Zed", "Kill Secured", "8 kills on 3 assists"],
  ["Vi", "Smite Diff", "took 3 dragons, barons or other big monsters"], ["Kai'Sa", "Minion Accountant", "7.8 CS a minute"], ["Nautilus", "Assist Collector", "12 assists"], ["Garen", "Playing Singleplayer", "in on 30% of the team's kills"],
].map(([champion, title, why]) => ({ champion, title, why }));

const coach: Coach = {
  model: "gemini-3.8-flash",
  headline: "You won lane and two fights, but your one death handed Zed the mid tower.",
  wentWell: ["Your solo kill on Zed at 10:11 came from holding Charm until he used his shadow.", "You were in the Jinx double kill at 11:03 and followed her up instead of chasing Nautilus."],
  workOn: ["At 10:41 you walked to the raptor camp with no ward and Zed's ultimate up.", "Baron went to the enemy at 11:18 while you were shopping; reset earlier when it is about to spawn."],
  nextGame: "Before stepping past the river, check where Zed was last seen and whether his ultimate is up.",
  deaths: [{ t: 41, whatHappened: "Zed came out of the raptor brush while you were auto-attacking a ward, and you had no dash left.", better: "Keep Spirit Rush for when you cannot see him, or ward from over the wall." }],
  titles: [
    ["Ahri", "Charm School Graduate", "Landed the charm that started a solo kill and a 3-for-1."], ["Zed", "Shadow Tax Collector", "8 kills, most of them on people walking alone."], ["Jinx", "Get Excited Indeed", "9 kills and a double at 11:03."],
    ["Lee Sin", "Blind But Busy", "11 assists and the fire dragon."], ["Thresh", "Lantern Uber", "17 assists carrying people out of trouble."], ["Ornn", "Forge And Forget", "190 CS and nobody noticed."],
    ["Vi", "Baron's Best Friend", "Took the Baron at 11:18."], ["Kai'Sa", "Lane Kingdom Resident", "232 CS, 7 kills, rarely seen elsewhere."], ["Nautilus", "Anchor Management", "12 assists, 5 deaths."], ["Garen", "Spin To Lose", "3 / 3 / 4 from the top lane."],
  ].map(([champion, title, why]) => ({ champion, title, why })),
};

let highlights: Highlight[] = [
  { t: 66, start: 55, end: 71, kind: "fight", label: "Team fight, 2 for 1", file: null },
  { t: 78, start: 70, end: 82, kind: "objective", label: "Baron fight, lost", file: null },
];
const teamReview: TeamReview = {
  t: 63, end: 67, views: ["Ahri", "Jinx", "Lee Sin"], model: "gemini-3.8-flash",
  summary: "You won it 2 for 1, but only because Jinx had flash. Thresh hooked with nobody close.",
  turningPoint: "Lee Sin arrived four seconds late from raptors, so the first three seconds were a 3 against 4.",
  shouldHave: ["Wait for Lee Sin to be on the screen before the hook goes out.", "Kill Kai'Sa first: on Jinx's screen she was alone at the back with no flash."],
  players: [
    { champion: "Ahri", did: "Charmed Nautilus, the tank in front.", better: "Hold the charm for Kai'Sa stepping up." },
    { champion: "Lee Sin", did: "Finished the camp before walking over.", better: "Leave the camp when Thresh pings the hook." },
  ],
  call: "Wait for Lee, then hook, and everything on Kai'Sa.",
};

const update: UpdateInfo = { current: "0.2.4", available: { version: "0.2.5", notes: "Highlight reels, trends, and per-match audio.", url: "" }, checked: true, installing: false, error: null };

const base = (id: string, ms: number, result: "Win" | "Lose", champ: PlayerRow, tags: string[] = []): MatchSummary => ({
  id, startedAt: new Date(ms).toISOString(), startedEpochMs: ms, mode: "game", duration: 120, width: 1280, height: 720,
  fps: 60, codec: "h264", video: "game.mp4",
  tracks: [
    { name: "game", file: null, silent: false, note: null },
    { name: "discord", file: "discord.m4a", silent: false, note: null },
    { name: "mic", file: "mic.m4a", silent: true, note: null },
  ],
  game: { queueId: 420, queueName: "Ranked Solo/Duo", mode: "CLASSIC", map: "Map11", length: 1974, result, me: champ, players: players.map((p) => (p.isMe ? champ : p)) },
  bookmarks: [{ t: 45 }, { t: 90 }],
  mouse: { file: "mouse.csv", offset: 0, w: 1280, h: 720 },
  keys: { file: "keys.csv", offset: 0, names: ["Q", "W", "E", "R", "D", "F", "1", "2", "3", "4", "5", "6", "7", "B", "A", "S", "Tab", "Space", "Ctrl", "Shift"] },
  dir: "/mock", sizeBytes: 6.4 * 1024 ** 3, videoBytes: 6.39 * 1024 ** 3, hasVideo: true, keep: false, tags, notesText: "", noteCount: 0, thumb: null, reel: null,
  summary: { deaths: champ.deaths, bookmarks: 2 },
});

/** A recording folder's name: its local start time, like 2026-11-12_20-14-03. */
const idOf = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

const CHAMPS: [string, string][] = [["Ahri", "Ahri"], ["Orianna", "Orianna"], ["Syndra", "Syndra"], ["Viktor", "Viktor"], ["Taliyah", "Taliyah"], ["Akali", "Akali"]];
const QUEUES: [number, string][] = [[420, "Ranked Solo/Duo"], [440, "Ranked Flex"], [400, "Normal Draft"]];
// Hours ago, champion, result, kills, deaths, assists, CS, minutes, queue, tags. Newest first.
const SPEC: [number, number, "Win" | "Lose", number, number, number, number, number, number, string[]][] = [
  [2, 0, "Win", 7, 3, 9, 212, 33, 0, ["roaming", "vision"]],
  [26, 1, "Lose", 2, 7, 5, 187, 31, 0, ["laning"]],
  [27.5, 0, "Win", 9, 4, 8, 231, 29, 0, []],
  [50, 2, "Win", 11, 2, 4, 260, 34, 1, ["carry"]],
  [75, 3, "Lose", 3, 6, 6, 198, 36, 0, ["vision"]],
  [77, 0, "Lose", 4, 8, 7, 176, 28, 0, ["laning", "tilt"]],
  [100, 4, "Win", 6, 2, 12, 205, 30, 2, []],
  [124, 0, "Win", 8, 5, 10, 224, 35, 0, ["teamfight"]],
  [170, 2, "Lose", 5, 6, 3, 201, 32, 0, []],
  [196, 1, "Win", 4, 1, 14, 244, 37, 1, ["carry"]],
  [250, 5, "Lose", 6, 9, 2, 158, 27, 0, ["laning"]],
  [340, 0, "Win", 10, 3, 6, 239, 31, 0, []],
  [420, 3, "Win", 5, 4, 9, 217, 33, 0, ["vision"]],
  [500, 0, "Lose", 3, 5, 8, 190, 30, 0, []],
  [600, 2, "Win", 12, 4, 7, 270, 38, 1, ["teamfight"]],
  [700, 4, "Lose", 2, 6, 11, 172, 29, 2, []],
];
const FOCUS = ["Ward the river before crossing it when Zed's ultimate is up", "Shop before Baron spawns, not during it", "Hold charm for their carry, not the tank in front"];
// Which games set a focus, and how the games after them went.
const SET_FOCUS: Record<number, number> = { 2: 0, 6: 1, 11: 2 };
const CHECK: Record<number, [number, "yes" | "partly" | "no"]> = { 1: [0, "partly"], 3: [1, "yes"], 4: [1, "no"], 7: [2, "yes"], 8: [2, "partly"], 9: [2, "yes"], 10: [2, "no"] };
const UNREVIEWED = new Set([0, 1, 5]);
const KEPT = new Set([1, 3, 9]);
const ROTATE = ["no_vision", "overextended", "no_vision", "outnumbered", "tower_dive", "overextended", "engage_no_followup", "no_vision", "lost_even_fight"];

let watchPeers: WatchPeer[] = [{ code: "kaja", name: "Kaja", playing: false, rate: 1, matchId: null, t: 61 }];

/** What kind of game each was, as the gold numbers would tell it. */
const storyOf = (i: number, won: boolean): Story | null => (["stomp", "close", null, won ? "comeback" : "throw", null, "close"] as (Story | null)[])[i % 6];

const now = Date.now();
const reviews: Record<string, Review> = {};
/** Games whose record was asked for by hand. */
const fetched = new Set<string>();
const matches: MatchSummary[] = SPEC.map(([h, c, result, k, d, a, cs, min, q, tags], i) => {
  const ms = now - h * 3600e3 - (i % 3) * 37 * 60e3;
  const me = { ...players[0], champion: CHAMPS[c][0], championKey: CHAMPS[c][1], kills: k, deaths: d, assists: a, cs };
  const m = base(idOf(ms), ms, result, me, tags);
  m.game = { ...m.game, queueId: QUEUES[q][0], queueName: QUEUES[q][1], length: min * 60 + 17 * (i % 4) };
  m.sizeBytes = (4.2 + ((i * 37) % 36) / 10) * 1024 ** 3;
  m.videoBytes = m.sizeBytes - 2.4 * 1024 ** 2;
  const done = !UNREVIEWED.has(i);
  const setAt = ms + (min + 25) * 60e3;
  const review: Review = {
    keep: KEPT.has(i),
    tags,
    notes: i % 3 === 0 && i > 0 ? [{ id: `n${i}`, t: 39, text: "Walked up without vision. Ward first next time." }] : [],
    drawings: [],
    reviewedAt: done ? setAt : null,
    nextFocus: i in SET_FOCUS ? { text: FOCUS[SET_FOCUS[i]], setAt } : null,
    focusCheck: i in CHECK ? { text: FOCUS[CHECK[i][0]], answer: CHECK[i][1] } : null,
  };
  reviews[m.id] = review;
  return {
    ...m, keep: review.keep, reviewed: done, nextFocus: review.nextFocus, focusCheck: review.focusCheck, noteCount: review.notes.length, notesText: review.notes.map((n) => n.text).join("\n"),
    story: storyOf(i, result === "Win"),
    // The two oldest games have only their stats left: one video deleted by hand, one by the size limit.
    ...(i >= SPEC.length - 2
      ? { hasVideo: false, sizeBytes: 2.4 * 1024 ** 2, videoBytes: 0, videoDeletedAt: now - 20 * 3600e3, videoDeletedBy: i === SPEC.length - 1 ? ("limit" as const) : ("you" as const) }
      : {}),
  };
});
// The newest game has the full sample review: notes, a drawing and tags.
reviews[matches[0].id] = {
  keep: false,
  tags: ["roaming", "vision"],
  notes: [
    { id: "n1", t: 39, text: "Walked up without vision of Zed. Ward the raptor side before trading." },
    { id: "n2", t: 76, text: "Baron call was late; we had no pink in pit." },
  ],
  drawings: [
    { id: "d1", t: 40, shapes: [{ tool: "circle", color: "#ffb347", pts: [[0.42, 0.38], [0.56, 0.6]] }, { tool: "arrow", color: "#ff5d5d", pts: [[0.7, 0.3], [0.52, 0.47]] }] },
  ],
};
matches[0] = { ...matches[0], noteCount: 2, notesText: "Walked up without vision of Zed.\nBaron call was late." };
watchPeers[0].matchId = matches[0].id;
// One screen recording, between games.
{
  const ms = now - 52 * 3600e3;
  matches.splice(4, 0, { ...base(idOf(ms), ms, "Win", players[0]), mode: "manual", game: { result: null } as unknown as MatchSummary["game"], noteCount: 0, summary: { deaths: 0, bookmarks: 0 }, sizeBytes: 0.4 * 1024 ** 3, videoBytes: 0.4 * 1024 ** 3 });
}

// ---- Riot's record of each game: ranks, damage, gold, and kills on the map.

/** The same numbers every time for the same seed. */
function seeded(seed: number): () => number {
  let s = (seed * 2654435761) % 4294967296;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND"];
const DIVS = ["IV", "III", "II", "I"];
const standingAt = (ladder: number) => ({ tier: TIERS[Math.floor(ladder / 400)], division: DIVS[Math.floor((ladder % 400) / 100)], lp: ladder % 100 });

// Ranks, oldest game first: Solo/Duo from Gold IV, Flex from Silver I.
{
  const ladders: Record<number, { queue: string; ladder: number; wins: number; losses: number }> = {
    420: { queue: "RANKED_SOLO_5x5", ladder: 1240, wins: 41, losses: 38 },
    440: { queue: "RANKED_FLEX_SR", ladder: 1130, wins: 12, losses: 10 },
  };
  matches
    .map((x, i) => ({ x, i }))
    .reverse()
    .forEach(({ x, i }) => {
      const q = ladders[x.game?.queueId ?? 0];
      if (x.mode !== "game" || !q) return;
      const won = x.game.result === "Win";
      const before = q.ladder;
      const delta = won ? 19 + ((i * 7) % 7) : -(16 + ((i * 5) % 5));
      q.ladder = Math.max(0, q.ladder + delta);
      if (won) q.wins++;
      else q.losses++;
      // One game whose LP could not be told: two games between the reads.
      const known = i !== 9;
      const rank: RankChange = {
        queue: q.queue,
        ...standingAt(q.ladder),
        wins: q.wins,
        losses: q.losses,
        ladder: q.ladder,
        delta: known ? delta : null,
        won,
        before: known ? standingAt(before) : null,
      };
      matches[i] = { ...x, rank };
    });
}

const ENEMIES: [string, string][] = [["Zed", "Zed"], ["Vi", "Vi"], ["Kai'Sa", "Kaisa"], ["Nautilus", "Nautilus"], ["Garen", "Garen"]];
/** Where a mid laner tends to fight on Summoner's Rift: x, y and spread. */
const HOT: [number, number, number][] = [
  [7400, 7300, 1200],
  [5700, 5900, 800],
  [9200, 9000, 900],
  [9900, 4500, 900],
  [4800, 10300, 900],
  [10600, 7300, 1000],
  [3900, 7600, 900],
];
const spotNear = (rnd: () => number): [number, number] => {
  const [x, y, r] = HOT[Math.floor(rnd() * HOT.length)];
  return [Math.round(x + (rnd() * 2 - 1) * r), Math.round(y + (rnd() * 2 - 1) * r)];
};
/** Video time for a game time, with the sample clock (video 0 is 10:00 in the game). */
const videoAt = (t: number) => Math.min(110, Math.max(0, t - 600));

/** Lane opponents across the sample games, so the matchups have something to show. */
const OPPONENTS: [string, string][] = [["Zed", "Zed"], ["Syndra", "Syndra"], ["Zed", "Zed"], ["Kha'Zix", "Khazix"], ["Yasuo", "Yasuo"], ["Zed", "Zed"], ["Syndra", "Syndra"]];

function trendPgFor(i: number, me: PlayerRow, length: number, story: Story | null): TrendPg {
  const rnd = seeded(i + 11);
  const mins = Math.max(1, length / 60);
  const spot = (deaths: boolean): TrendSpot => {
    const t = Math.round(120 + rnd() * (length - 180));
    const [x, y] = spotNear(rnd);
    const executed = deaths && rnd() < 0.08;
    const e = ENEMIES[Math.floor(rnd() * ENEMIES.length)];
    return { x, y, t, v: videoAt(t), other: executed ? null : e[0], otherKey: executed ? null : e[1] };
  };
  const damage = Math.round(14000 + me.kills * 1900 + rnd() * 8000);
  const gold = Math.round(8000 + me.cs * 22 + me.kills * 300);
  return {
    mapId: 11,
    dmgShare: Math.round((0.21 + rnd() * 0.14) * 1000) / 1000,
    kp: Math.round((0.45 + rnd() * 0.3) * 1000) / 1000,
    damage,
    dpm: Math.round((damage / mins) * 10) / 10,
    gold,
    gpm: Math.round((gold / mins) * 10) / 10,
    vision: Math.round(mins * 0.9),
    vpm: 0.9,
    taken: Math.round(16000 + me.deaths * 2200),
    opp: OPPONENTS[i % OPPONENTS.length][0],
    oppKey: OPPONENTS[i % OPPONENTS.length][1],
    story,
    gold10: Math.round((rnd() - 0.45) * 900),
    gold15: Math.round((rnd() - 0.42) * 1700),
    xp10: Math.round((rnd() - 0.45) * 600),
    csd10: Math.round((rnd() - 0.4) * 18),
    csd15: Math.round((rnd() - 0.4) * 26),
    deaths: Array.from({ length: me.deaths }, () => spot(true)).sort((a, b) => a.t - b.t),
    kills: Array.from({ length: me.kills }, () => spot(false)).sort((a, b) => a.t - b.t),
  };
}

const SPELLS: Record<string, number[]> = { TOP: [4, 12], JUNGLE: [4, 11], MIDDLE: [4, 14], BOTTOM: [4, 7], UTILITY: [4, 3] };
/** Keystone, its path, and the second path. */
const RUNES: Record<string, [number, number, number]> = {
  Ahri: [8112, 8100, 8300], LeeSin: [8010, 8000, 8100], Jinx: [8005, 8000, 8300], Thresh: [8439, 8400, 8300], Ornn: [8437, 8400, 8300],
  Zed: [8112, 8100, 8000], Vi: [8010, 8000, 8100], Kaisa: [9923, 8100, 8000], Nautilus: [8439, 8400, 8200], Garen: [8010, 8000, 8400],
};
const TRINKET_IDS = new Set([3340, 3363, 3364]);
/** Riot's seven item slots: six, then the trinket. */
const sevenSlots = (items: { id: number }[]): number[] => {
  const six = items.filter((it) => !TRINKET_IDS.has(it.id)).map((it) => it.id).slice(0, 6);
  return [...six, ...Array<number>(6 - six.length).fill(0), items.find((it) => TRINKET_IDS.has(it.id))?.id ?? 0];
};

/** A whole record of one game, built from its scoreboard. */
function postgameFor(m: MatchSummary, i: number): PostGame {
  const rnd = seeded(i + 101);
  const rows = m.game.players ?? [];
  const length = m.game.length ?? m.duration;
  const mins = Math.max(1, length / 60);
  const myTeamWon = m.game.result === "Win";
  const players: PgPlayer[] = rows.map((p, j) => {
    const sup = p.position === "UTILITY";
    const damage = Math.round((sup ? 7000 : 13000) + p.kills * 1800 + rnd() * 7000);
    const magic = Math.round(damage * (p.champion === "Ahri" || p.champion === "Nautilus" ? 0.8 : 0.25));
    const trueDmg = Math.round(damage * 0.06);
    return {
      id: j + 1, puuid: `mock-${j}`, name: p.name, tag: "EUW", teamId: p.team === "ORDER" ? 100 : 200, team: p.team === "ORDER" ? "ORDER" : "CHAOS",
      championId: 0, champion: p.champion, championKey: p.championKey, position: p.position ?? "", win: (p.team === "ORDER") === myTeamWon, isMe: p.isMe,
      level: 13 + (j % 5), kills: p.kills, deaths: p.deaths, assists: p.assists, cs: p.cs,
      gold: Math.round(7000 + p.cs * 22 + p.kills * 300 + p.assists * 120), goldSpent: Math.round(6800 + p.cs * 21),
      damage, physical: damage - magic - trueDmg, magic, true: trueDmg,
      taken: Math.round(14000 + p.deaths * 2400 + (p.position === "TOP" || p.position === "JUNGLE" ? 9000 : 0) + rnd() * 5000),
      mitigated: Math.round(9000 + rnd() * 12000), heal: Math.round(2000 + rnd() * 5000), allyHeal: sup ? Math.round(3000 + rnd() * 4000) : Math.round(rnd() * 600),
      shield: sup ? Math.round(2000 + rnd() * 5000) : 0, objectives: Math.round(4000 + rnd() * 14000), buildings: Math.round(1000 + rnd() * 6000),
      vision: Math.round(mins * (sup ? 2.2 : 0.8)), wardsPlaced: Math.round(mins * (sup ? 1.1 : 0.35)), wardsKilled: Math.round(mins * 0.15), controlWards: sup ? 6 : 2,
      cc: Math.round(10 + rnd() * 40), deadSecs: p.deaths * 28, largestMulti: p.kills >= 9 ? 3 : p.kills >= 6 ? 2 : 1, firstBlood: j === 0,
      items: sevenSlots(p.items ?? []), spells: SPELLS[p.position ?? ""] ?? [4, 14],
      runes: (() => {
        const [keystone, primary, secondary] = RUNES[p.championKey] ?? [8112, 8100, 8300];
        return { primary, secondary, keystone, perks: [keystone], shards: [5008, 5008, 5001] };
      })(),
      kp: null, dmgShare: null, skills: p.isMe ? "QWEQQRQEQERWEEWRWW" : "", extra: null,
    };
  });
  for (const p of players) {
    const mates = players.filter((x) => x.teamId === p.teamId);
    const kills = mates.reduce((s, x) => s + x.kills, 0);
    const dmg = mates.reduce((s, x) => s + x.damage, 0);
    p.kp = kills ? Math.round(((p.kills + p.assists) / kills) * 1000) / 1000 : null;
    p.dmgShare = dmg ? Math.round((p.damage / dmg) * 1000) / 1000 : null;
  }
  const me = players.find((p) => p.isMe)!;
  me.extra = { soloKills: 2, plates: 3, skillshotsHit: 41, skillshotsDodged: 17, csAt10: 74, controlWardsPlaced: 3, abilityUses: 612, immobilizations: 14, saves: 1, maxCsLead: 18, maxLevelLead: 2, pings: 23 };

  // Every kill: each player's kills, against someone on the other team.
  const kills: PgKill[] = [];
  for (const k of players) {
    const foes = players.filter((x) => x.teamId !== k.teamId);
    for (let n = 0; n < k.kills; n++) {
      const t = Math.round((120 + rnd() * (length - 160)) * 10) / 10;
      const [x, y] = spotNear(rnd);
      const mates = players.filter((x2) => x2.teamId === k.teamId && x2.id !== k.id);
      const victim = k.id === me.id || rnd() > 0.2 ? foes[Math.floor(rnd() * foes.length)] : foes[0];
      kills.push({ t, x, y, killer: k.id, victim: victim.id, assists: mates.filter(() => rnd() < 0.35).map((a) => a.id), bounty: 300, shutdown: rnd() < 0.15 ? 150 : 0, recap: null, dealt: null });
    }
  }
  // My deaths exactly as many as the scoreboard says, with what hit me.
  const others = kills.filter((k) => k.victim !== me.id);
  const mine = kills.filter((k) => k.victim === me.id);
  while (mine.length > me.deaths) others.push({ ...mine.pop()!, victim: players.find((p) => p.teamId === me.teamId && !p.isMe)!.id });
  const enemies = players.filter((p) => p.teamId !== me.teamId);
  while (mine.length < me.deaths) {
    const [x, y] = spotNear(rnd);
    const killer = enemies[Math.floor(rnd() * enemies.length)];
    mine.push({ t: Math.round((150 + rnd() * (length - 200)) * 10) / 10, x, y, killer: rnd() < 0.08 ? 0 : killer.id, victim: me.id, assists: rnd() < 0.5 ? [enemies[(enemies.indexOf(killer) + 1) % enemies.length].id] : [], bounty: 300, shutdown: 0, recap: null, dealt: null });
  }
  for (const d of mine) {
    const killer = players.find((p) => p.id === d.killer);
    const helper = players.find((p) => p.id === d.assists[0]);
    d.recap = [
      killer
        ? { id: killer.id, name: killer.championKey, type: "OTHER", physical: Math.round(400 + rnd() * 900), magic: killer.magic > killer.physical ? Math.round(600 + rnd() * 700) : 0, true: Math.round(rnd() * 200), total: 0, hits: ["Q", "R", "Auto"] }
        : { id: 0, name: "Turret", type: "TOWER", physical: 1200, magic: 0, true: 0, total: 0, hits: ["Auto"] },
      ...(helper ? [{ id: helper.id, name: helper.championKey, type: "OTHER", physical: Math.round(rnd() * 400), magic: Math.round(200 + rnd() * 500), true: 0, total: 0, hits: ["E", "Auto"] }] : []),
    ].map((h) => ({ ...h, total: h.physical + h.magic + h.true }));
    d.dealt = Math.round(300 + rnd() * 1200);
  }
  const all = [...others, ...mine].sort((a, b) => a.t - b.t);

  // Minute by minute.
  const t = Array.from({ length: Math.floor(length / 60) + 1 }, (_, n) => n * 60);
  const lanePos: Record<string, [number, number]> = { TOP: [2200, 12600], JUNGLE: [4200, 7800], MIDDLE: [7400, 7300], BOTTOM: [12600, 2300], UTILITY: [12000, 2600] };
  const frames = {
    t,
    players: players.map((p) => {
      const [lx, ly] = lanePos[p.position] ?? [7400, 7300];
      const flip = p.teamId === 200;
      const pos = t.map((_, n) => (n === 0 ? (flip ? [14300, 14400] : [400, 400]) : [lx + (rnd() * 2 - 1) * 1800 + (flip ? 600 : -600), ly + (rnd() * 2 - 1) * 1800 + (flip ? 600 : -600)]));
      return {
        id: p.id,
        gold: t.map((_, n) => Math.round(500 + (p.gold - 500) * (n / (t.length - 1)) ** 1.1)),
        xp: t.map((_, n) => Math.round(18000 * (n / (t.length - 1)))),
        cs: t.map((_, n) => Math.round(p.cs * (n / (t.length - 1)))),
        level: t.map((_, n) => Math.min(18, 1 + Math.floor(n / 2))),
        x: pos.map((q) => Math.round(Math.min(14500, Math.max(300, q[0])))),
        y: pos.map((q) => Math.round(Math.min(14500, Math.max(300, q[1])))),
        damage: null,
      };
    }),
  };
  const opp = players.find((p) => p.teamId !== me.teamId && p.position === me.position) ?? enemies[0];
  let g = 0;
  const laneGold = t.map((_, n) => (n === 0 ? 0 : (g += Math.round((rnd() - 0.47) * 260))));
  // The lead follows the game's story. The sample video is game minutes 10 to 12, so
  // the lead swings hard in minutes 11 and 12 to have turns to show there.
  const sign = myTeamWon ? 1 : -1;
  const teamGold = t.map((_, n) => {
    if (n === 0) return 0;
    const f = n / (t.length - 1);
    const shape =
      m.story === "stomp" ? sign * 8000 * f
      : m.story === "comeback" ? (f < 0.5 ? -9000 * f : -4500 + 15000 * (f - 0.5))
      : m.story === "throw" ? (f < 0.5 ? 9000 * f : 4500 - 15000 * (f - 0.5))
      : m.story === "close" ? 1200 * Math.sin(f * 9)
      : sign * 3500 * f;
    const swing = (n >= 11 ? 2400 : 0) - (n >= 12 ? 1900 : 0);
    return Math.round(shape + swing + (rnd() - 0.5) * 300);
  });
  const teams = [100, 200].map((id) => ({
    teamId: id, team: (id === 100 ? "ORDER" : "CHAOS") as "ORDER" | "CHAOS", win: (id === 100) === myTeamWon, bans: id === 100 ? [157, 555, 517, 777, 141] : [84, 105, 266, 875, 200],
    kills: players.filter((p) => p.teamId === id).reduce((s, p) => s + p.kills, 0),
    towers: (id === 100) === myTeamWon ? 8 : 3, inhibitors: (id === 100) === myTeamWon ? 1 : 0, dragons: (id === 100) === myTeamWon ? 3 : 1, barons: (id === 100) === myTeamWon ? 1 : 0, heralds: 1, grubs: 3, atakhan: 0,
  }));
  return {
    version: 1, source: "riot", matchId: `EUW1_70${String(1234567 + i)}`, gameId: 701234567 + i, platform: "EUW1", queueId: m.game.queueId ?? 420, mapId: 11, mode: "CLASSIC",
    patch: "25.22", duration: length, startMs: m.startedEpochMs, me: me.id, teams, players, frames, kills: all,
    objectives: [
      { t: 380, kind: "dragon", sub: "FIRE_DRAGON", lane: "", by: 100, killer: 2, x: 9866, y: 4414 },
      { t: 619, kind: "dragon", sub: "FIRE_DRAGON", lane: "", by: 100, killer: 2, x: 9866, y: 4414 },
      { t: 634, kind: "tower", sub: "OUTER_TURRET", lane: "MID_LANE", by: 100, killer: 1, x: 8955, y: 8510 },
      { t: 678, kind: "baron", sub: "", lane: "", by: 200, killer: 7, x: 5007, y: 10471 },
      { t: 686, kind: "tower", sub: "OUTER_TURRET", lane: "TOP_LANE", by: 200, killer: 10, x: 981, y: 10441 },
      { t: 704, kind: "inhibitor", sub: "", lane: "MID_LANE", by: 100, killer: 3, x: 11598, y: 11667 },
    ],
    lane: { opponent: opp.id, gold: laneGold, xp: laneGold.map((v) => Math.round(v * 0.6)), cs: laneGold.map((v) => Math.round(v / 40)) },
    teamGold,
  };
}

/** Everyone's rank a few minutes after the game: Solo/Duo around Gold, a few unranked. */
function playerRanksFor(m: MatchSummary, pg: PostGame, i: number): PlayerRanks {
  const rnd = seeded(i + 303);
  return {
    at: pg.startMs + (pg.duration + 240) * 1000,
    players: pg.players.map((p) => {
      const ladder = p.isMe && m.rank?.ladder != null ? m.rank.ladder : Math.round(700 + rnd() * 1700);
      const ranks = !p.isMe && rnd() < 0.12 ? [] : [{ queue: "RANKED_SOLO_5x5", ...standingAt(ladder), wins: 30 + Math.round(rnd() * 90), losses: 0, ladder }];
      return { name: p.name, champion: p.champion, championKey: p.championKey, team: p.team, ranks };
    }),
  };
}

let matchupNotes: Record<string, MatchupNote> = {
  Zed: { text: "Stay behind the minions until his W is down. Ward the side brush at 3:00 and keep Spirit Rush for his ultimate.", at: now - 3 * 86400e3 },
};

/** Causes for the deaths in a game, as the hints would give them. */
const causesOf = (i: number, deaths: number) => Array.from({ length: Math.min(deaths, 3) }, (_, j) => ROTATE[(i * 2 + j) % ROTATE.length]);
function insightsFor(id: string): Insights | null {
  const games = matches.filter((m) => m.mode === "game");
  const i = games.findIndex((m) => m.id === id);
  if (i < 0) return null;
  return {
    model: "gemini-decision-1",
    deaths: causesOf(i, games[i].game.me!.deaths).map((cause, j) => ({ t: 22 + j * 31, avoidable: 0.55 + (j % 3) * 0.12, sawItComing: 0.3, allyClose: 0.3, cause, causeP: 0.6, fight: "caught_alone", fightP: 0.5, positioning: 0.4 })),
  };
}

let backups: LeagueBackup[] = [
  { id: "2026-11-12_19-50-00", createdAt: new Date(now - 3 * 3600e3).toISOString(), label: "Auto before game", files: ["PersistedSettings.json", "input.ini", "game.cfg"], sizeBytes: 18420, auto: true },
  { id: "2026-11-10_14-12-00", createdAt: new Date(now - 56 * 3600e3).toISOString(), label: "Main account bindings", files: ["PersistedSettings.json", "input.ini", "game.cfg"], sizeBytes: 18390, auto: false },
];

let settings: Settings = {
  recordingsDir: "E:\\Rewatch", autoRecord: true, startWithWindows: true, fps: 60, resolution: "native", codec: "h264", encoder: "auto", quality: 23, recordDiscord: true, recordMic: true,
  micDevice: "", mouseTracking: true, keyTracking: true, keyMap: [], useClientApi: true,
  queues: { rankedSolo: true, rankedFlex: true, normal: true, aram: false, custom: true, other: true },
  quotaGb: 300, bookmarkHotkey: "F8", ffmpegPath: "", leagueDir: "", autoBackupLeague: true,
  shareWithFriends: true, shareName: "Rin", keepTeammateViews: true, reviewCopies: true, shareNotes: true, notify: true, autoUpdate: true, autoHighlights: true, highlightsOnly: false, aiReview: true, geminiKey: "sample", riotApiKey: "", breakAfterLosses: 3,
  friends: [
    { name: "Kaja", code: "3f9a1c0b7d2e4a6f8b1c3d5e7f9a0b2c4d6e8f0a1b3c5d7e9f1a2b4c6d8e0f13" },
    { name: "Tor", code: "a81d4e6f0b2c3d5e7f9a1b3c5d7e9f0a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e" },
  ],
};

const status: Status = {
  state: "idle", mode: null, startedEpochMs: null, queueName: null, gameRunning: false, discordRunning: true,
  bookmarks: 0, lastError: null, lastMatchId: null,
};

// The first-run setup in the browser: "?setup" in the address starts as a new PC does, and "?setup=missing"
// as one where League and FFmpeg weren't found.
const setupPreview = new URLSearchParams(location.search).get("setup");
if (setupPreview !== null) settings = { ...settings, recordingsDir: "", shareName: "", friends: [] };
const loadedAt = Date.now();
const MY_CODE = "c4e19d2a7b3f5061a8d4e2c9b7f1a3d5e6c8b0a2f4d6e8c1a3b5d7f9e0c2a4b6";
const IDA = "9d41c7e2a0b3f5648c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b";
const pings = new Map<string, number>();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Codes starting 0 to 3 add you back after two checks, 4 and 5 are offline, the rest have you already. */
async function mockPing(code: string): Promise<string> {
  await wait(700 + Math.random() * 700);
  const c = code.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(c)) throw "That does not look like a friend code. Ask them to copy it again.";
  if (c === MY_CODE) throw "That is your own code.";
  const n = (pings.get(c) ?? 0) + 1;
  pings.set(c, n);
  if (/^[0-3]/.test(c) && n < 3) throw "Reached them, but you are not on their teammates list yet. You now show up in their Settings under Teammates, where they can add you with one click.";
  if (/^[45]/.test(c)) throw "Could not reach them. Their PC must be on with Rewatch running.";
  return c === IDA ? "Ida" : ["Kaja", "Tor", "Sindre", "Lumen"][parseInt(c[1], 16) % 4];
}

/** Something like a voice: a few words, then a pause. */
function mockMicLevel(): number {
  const t = Date.now() / 1000;
  const words = Math.max(0, Math.sin(t * 1.3)) * Math.abs(Math.sin(t * 9.1)) * (0.6 + 0.4 * Math.random());
  return Math.min(1, 0.002 + words * 0.35);
}

export async function mock<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  switch (cmd) {
    case "league_name": await wait(900); return "Rin" as T;
    case "disk_free": {
      const drive = String(args!.path).slice(0, 1).toUpperCase();
      return ((drive === "C" ? 96 : drive === "D" ? 1210 : 412) * 1024 ** 3) as T;
    }
    case "mic_level": return mockMicLevel() as T;
    case "mic_check_stop": return null as T;
  }
  if (setupPreview !== null) {
    if (cmd === "friend_ping") return (await mockPing(args!.code as string)) as T;
    if (cmd === "environment") {
      await wait(400);
      const missing = setupPreview === "missing" && !settings.leagueDir;
      return {
        ffmpeg: "C:\\Program Files\\Rewatch\\bin\\ffmpeg.exe", ffmpegVersion: setupPreview === "missing" && !settings.ffmpegPath ? null : "ffmpeg version 7.1.1", ffprobeFound: true,
        leagueDir: missing ? null : settings.leagueDir || "D:\\Riot Games\\League of Legends", suggestedRecordingsDir: "C:\\Users\\you\\Videos\\Rewatch", freeBytes: 96 * 1024 ** 3,
      } as T;
    }
    if (cmd === "share_info") {
      // Someone asks to connect a little while after the page opens.
      const asked = Date.now() - loadedAt > 9000 && !settings.friends.some((f) => f.code === IDA);
      return { code: MY_CODE, running: true, online: Date.now() - loadedAt > 1500, error: null, requests: asked ? [{ code: IDA, name: "Ida", atMs: Date.now() - 4000 }] : [] } as T;
    }
    if (cmd === "list_matches") return [] as T;
  }
  const out = ((): unknown => {
    switch (cmd) {
      case "get_settings": return settings;
      case "save_settings": settings = args!.settings as Settings; return settings;
      case "get_status": return status;
      case "environment": return { ffmpeg: "C:\\ffmpeg\\bin\\ffmpeg.exe", ffmpegVersion: "ffmpeg version 7.1.1", ffprobeFound: true, leagueDir: "D:\\Riot Games\\League of Legends", suggestedRecordingsDir: "C:\\Users\\you\\Videos\\Rewatch", freeBytes: 412 * 1024 ** 3 };
      case "copy_file": return null;
      case "delete_match": {
        const i = matches.findIndex((m) => m.id === args!.id);
        if (i >= 0) matches.splice(i, 1);
        return null;
      }
      case "delete_video": {
        const i = matches.findIndex((m) => m.id === args!.id);
        if (i < 0) return 0;
        const m = matches[i];
        const freed = m.videoBytes ?? 0;
        matches[i] = { ...m, hasVideo: false, sizeBytes: m.sizeBytes - freed, videoBytes: 0, videoDeletedAt: m.videoDeletedAt ?? Date.now(), videoDeletedBy: m.videoDeletedBy ?? "you" };
        return freed;
      }
      case "list_microphones": return [{ id: "a", name: "Headset Microphone", isDefault: true, isDefaultComms: true, level: 0.2 }, { id: "b", name: "Webcam Microphone", isDefault: false, isDefaultComms: false, level: 0 }];
      case "list_matches": return matches;
      case "get_match": {
        const m = matches.find((x) => x.id === args!.id) ?? matches[0];
        const game = m.mode !== "manual";
        const review = reviews[m.id] ?? { keep: m.keep, notes: [], drawings: [], tags: m.tags ?? [] };
        const gi = matches.filter((x) => x.mode === "game").indexOf(m);
        const waiting = gi === 1 && !fetched.has(m.id);
        const pg = game && !waiting ? postgameFor(m, gi) : null;
        const full: MatchFull = {
          ...m, events: game ? events : [], clock: game ? [[0, 600]] : [], review, stats: game ? stats : null, voice: game ? voice : null, titles: game ? builtInTitles : [], highlights: game ? highlights : [], team: [],
          postgame: pg,
          postgameNote: waiting ? "Riot has not published this game yet." : null,
          // One older game from before ranks were read.
          playerRanks: pg && gi !== 2 ? playerRanksFor(m, pg, gi) : null,
        };
        return full;
      }
      case "save_review": {
        const r = args!.review as Review;
        reviews[args!.id as string] = r;
        const i = matches.findIndex((m) => m.id === args!.id);
        if (i >= 0) matches[i] = { ...matches[i], keep: r.keep, tags: r.tags ?? [], reviewed: !!r.reviewedAt, nextFocus: r.nextFocus ?? null, focusCheck: r.focusCheck ?? null, noteCount: r.notes.length, notesText: r.notes.map((n) => n.text).join("\n") };
        return null;
      }
      case "start_manual_recording": status.state = "recording"; status.mode = "manual"; status.startedEpochMs = Date.now(); return null;
      case "stop_recording": status.state = "idle"; status.mode = null; return matches[0].id;
      case "export_clip": return args?.maxMb ? `E:\\Rewatch\\Clips\\clip_${args.maxMb}mb.mp4` : "E:\\Rewatch\\Clips\\clip.mp4";
      case "export_full": return "E:\\Rewatch\\all-tracks.mp4";
      case "share_card": return `E:\\Rewatch\\${args!.id}\\share.png`;
      case "matchup_notes": return matchupNotes;
      case "set_matchup_note": {
        const champion = String(args!.champion);
        const text = String(args!.text ?? "").trim();
        const next = { ...matchupNotes };
        if (text) next[champion] = { text, at: Date.now() };
        else delete next[champion];
        matchupNotes = next;
        return matchupNotes;
      }
      case "build_highlight_reel": return "E:\\Rewatch\\2026-11-12_20-14-03\\highlights_reel.mp4";
      case "library_trends": {
        const games = matches.filter((m) => m.mode !== "manual" && m.game.me);
        const list: TrendMatch[] = games.map((m, idx) => {
          const me = m.game.me!;
          const len = m.game.length ?? m.duration;
          // Older games a little worse, so the trend lines have somewhere to go.
          const age = idx / games.length;
          const wob = ((idx * 7919) % 11) / 10;
          const causes = causesOf(idx, me.deaths);
          const r = reviews[m.id];
          return {
            id: m.id,
            startedEpochMs: m.startedEpochMs,
            queueId: m.game.queueId,
            queueName: m.game.queueName,
            result: m.game.result ?? null,
            champion: me.champion,
            championKey: me.championKey,
            position: me.position ?? "MIDDLE",
            kills: me.kills,
            deaths: me.deaths,
            assists: me.assists,
            cs: me.cs,
            wards: Math.round((len / 60) * (0.62 + 0.25 * (1 - age) + wob * 0.12)),
            length: len,
            cs10: Math.round(62 + 14 * (1 - age) + wob * 6),
            cs15: Math.round(101 + 22 * (1 - age) + wob * 9),
            deadPct: Math.round(Math.max(3, me.deaths * 1.7 + 6 * age + wob * 2)),
            allies: (m.game.players ?? []).filter((p) => !p.isMe && p.team === me.team).map((p) => ({ name: p.name, champion: p.champion })),
            tags: m.tags ?? [],
            keep: m.keep,
            hasVideo: m.hasVideo !== false,
            reviewed: !!r?.reviewedAt,
            focus: r?.focusCheck ?? null,
            deathCauses: causes,
            avgAvoidable: causes.length ? 0.45 + wob * 0.4 : null,
            rank: m.rank ?? null,
            pg: idx === 1 && !fetched.has(m.id) ? null : trendPgFor(idx, me, len, m.story ?? null),
          };
        });
        return list;
      }
      case "postgame_fetch": {
        const m = matches.find((x) => x.id === args!.id) ?? matches[0];
        fetched.add(m.id);
        return postgameFor(m, matches.filter((x) => x.mode === "game").indexOf(m));
      }
      case "riot_check": {
        const key = String(args?.key ?? "");
        return key.startsWith("RGAPI-")
          ? { ok: true, message: "Riot accepted the key." }
          : { ok: false, message: "Riot refused this key. A development key stops working 24 hours after it was made; make a new one at developer.riotgames.com." };
      }
      case "list_league_backups": return backups;
      case "create_league_backup": {
        const b: LeagueBackup = { id: new Date().toISOString().replace(/[:.]/g, "-"), createdAt: new Date().toISOString(), label: String(args?.label || "Manual snapshot"), files: ["PersistedSettings.json", "input.ini", "game.cfg"], sizeBytes: 18500, auto: false };
        backups = [b, ...backups];
        return b;
      }
      case "restore_league_backup": return backups.find((b) => b.id === args?.id) ?? backups[0];
      case "delete_league_backup": backups = backups.filter((b) => b.id !== args?.id); return null;
      case "share_info": return { code: "c4e19d2a7b3f5061a8d4e2c9b7f1a3d5e6c8b0a2f4d6e8c1a3b5d7f9e0c2a4b6", running: true, online: true, error: null, requests: [{ code: "9d41c7e2a0b3f5648c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b", name: "Ida", atMs: Date.now() - 20000 }] };
      case "friend_ping": return "Kaja";
      case "pov_list": return [
        { friend: "Kaja", code: "kaja", cached: true, saving: null, status: "ready", player: "Kaja", champion: "Jinx", championKey: "Jinx", position: "BOTTOM", shift: 4, duration: 116, video: "/mock/game.mp4", mouse: "/mock/mouse.csv", mouseOffset: 0, mouseW: 1280, mouseH: 720 },
        { friend: "Sindre", code: "sindre", cached: false, saving: [310000000, 1000000000], status: "ready", player: "Sindre", champion: "Lee Sin", championKey: "LeeSin", position: "JUNGLE", shift: -3, duration: 123, video: "/mock/game.mp4", mouse: "/mock/mouse.csv", mouseOffset: 0, mouseW: 1280, mouseH: 720 },
        { friend: "Ida", code: "ida", cached: false, saving: null, status: "ready", player: "Ida", champion: "Ornn", championKey: "Ornn", position: "TOP", shift: 1.5, duration: 118, video: "/mock/game.mp4", mouse: "/mock/mouse.csv", mouseOffset: 0, mouseW: 1280, mouseH: 720 },
        { friend: "Tor", code: "tor", cached: false, saving: null, status: "offline", player: "", champion: "", championKey: "", position: "", shift: 0, duration: 0, video: null, mouse: null, mouseOffset: 0, mouseW: 0, mouseH: 0 },
      ];
      case "pov_saving": return { sindre: [310000000, 1000000000] };
      case "pov_extras": return extras;
      case "voice": return voice;
      case "insights": return args!.run ? insights : insightsFor(args!.id as string);
      case "coach": return args!.run ? coach : null;
      case "highlights": if (args!.save) highlights = highlights.map((h) => ({ ...h, file: `E:\\Rewatch\\game\\highlight_${Math.round(h.t)}.mp4` })); return highlights;
      case "team_review": return { ...teamReview, t: args!.start as number, end: args!.end as number };
      case "watch_set": if (args!.id === null) watchPeers = []; return null;
      case "watch_peers": return watchPeers;
      case "update_info": case "update_check": return update;
      case "update_install": update.installing = true; return null;
      case "export_split": return args?.maxMb ? `E:\\Rewatch\\Clips\\split_${args.maxMb}mb.mp4` : "E:\\Rewatch\\Clips\\split.mp4";
      default: return null;
    }
  })();
  return structuredClone(out) as T;
}
