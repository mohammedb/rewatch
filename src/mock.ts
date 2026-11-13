// Sample data so the interface can be worked on in a plain browser. Never used
// inside the desktop app.

import type { Coach, Extras, GameEvent, Highlight, TeamReview, Insights, LeagueBackup, MatchFull, MatchSummary, PlayerRow, Review, Settings, Stats, Status, TrendMatch, UpdateInfo, Voice, WatchPeer } from "./types";

const LANE: Record<string, string> = { Rin: "MIDDLE", Vex1: "MIDDLE", Sindre: "JUNGLE", Rook: "JUNGLE", Kaja: "BOTTOM", Lumen: "BOTTOM", Tor: "UTILITY", Peel: "UTILITY", Ida: "TOP", Stone: "TOP" };
const row = (name: string, champion: string, key: string, team: string, k: number, d: number, a: number, cs: number, isMe = false): PlayerRow => ({
  name, isMe, champion, championKey: key, team, position: LANE[name] ?? "", level: 14, kills: k, deaths: d, assists: a, cs,
  items: isMe ? [{ id: 3157, name: "Zhonya's Hourglass" }, { id: 3020, name: "Sorcerer's Shoes" }, { id: 4645, name: "Shadowflame" }, { id: 3089, name: "Rabadon's Deathcap" }, { id: 3135, name: "Void Staff" }, { id: 3340, name: "Stealth Ward" }] : [],
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

let watchPeers: WatchPeer[] = [{ code: "kaja", name: "Kaja", playing: false, rate: 1, matchId: "2026-11-12_20-14-03", t: 61 }];

const update: UpdateInfo = { current: "0.2.4", available: { version: "0.2.5", notes: "Highlight reels, trends, and per-match audio.", url: "" }, checked: true, installing: false, error: null };

const base = (id: string, ms: number, result: "Win" | "Lose", champ: PlayerRow, tags: string[] = []): MatchSummary => ({
  id, startedAt: new Date(ms).toISOString(), startedEpochMs: ms, mode: "game", duration: 120, width: 1280, height: 720,
  fps: 60, codec: "h264", video: "game.mp4",
  tracks: [
    { name: "game", file: null, silent: false, note: null },
    { name: "discord", file: "discord.m4a", silent: false, note: null },
    { name: "mic", file: "mic.m4a", silent: true, note: null },
  ],
  game: { queueId: 420, queueName: "Ranked Solo/Duo", mode: "CLASSIC", map: "Map11", length: 1974, result, me: champ, players },
  bookmarks: [{ t: 45 }, { t: 90 }],
  mouse: { file: "mouse.csv", offset: 0, w: 1280, h: 720 },
  keys: { file: "keys.csv", offset: 0, names: ["Q", "W", "E", "R", "D", "F", "1", "2", "3", "4", "5", "6", "7", "B", "A", "S", "Tab", "Space", "Ctrl", "Shift"] },
  dir: "/mock", sizeBytes: 6.4 * 1024 ** 3, keep: false, tags, notesText: "Walked up without vision of Zed.\nBaron call was late.", noteCount: 2, thumb: null, reel: null,
  summary: { deaths: 3, bookmarks: 2 },
});

const now = Date.now();
const matches: MatchSummary[] = [
  base("2026-11-12_20-14-03", now - 2 * 3600e3, "Win", players[0], ["roaming", "vision"]),
  { ...base("2026-11-11_22-40-51", now - 26 * 3600e3, "Lose", { ...players[0], champion: "Orianna", championKey: "Orianna", kills: 2, deaths: 7, assists: 5, cs: 187 }, ["laning"]), keep: true, sizeBytes: 5.1 * 1024 ** 3 },
  { ...base("2026-11-10_19-02-17", now - 50 * 3600e3, "Win", { ...players[0], champion: "Syndra", championKey: "Syndra", kills: 11, deaths: 2, assists: 4, cs: 260 }, ["carry"]), game: { ...base("x", 0, "Win", players[0]).game, queueName: "Ranked Flex", queueId: 440 }, noteCount: 0, notesText: "" },
  { ...base("2026-11-10_17-30-00", now - 52 * 3600e3, "Win", players[0]), mode: "manual", game: { result: null }, noteCount: 0, notesText: "", summary: { deaths: 0, bookmarks: 0 } },
];

let review: Review = {
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

let backups: LeagueBackup[] = [
  { id: "2026-11-12_19-50-00", createdAt: new Date(now - 3 * 3600e3).toISOString(), label: "Auto before game", files: ["PersistedSettings.json", "input.ini", "game.cfg"], sizeBytes: 18420, auto: true },
  { id: "2026-11-10_14-12-00", createdAt: new Date(now - 56 * 3600e3).toISOString(), label: "Main account bindings", files: ["PersistedSettings.json", "input.ini", "game.cfg"], sizeBytes: 18390, auto: false },
];

let settings: Settings = {
  recordingsDir: "E:\\Rewatch", autoRecord: true, startWithWindows: true, fps: 60, resolution: "native", codec: "h264", encoder: "auto", quality: 23, recordDiscord: true, recordMic: true,
  micDevice: "", mouseTracking: true, keyTracking: true, keyMap: [], useClientApi: true,
  queues: { rankedSolo: true, rankedFlex: true, normal: true, aram: false, custom: true, other: true },
  quotaGb: 300, bookmarkHotkey: "F8", ffmpegPath: "", leagueDir: "", autoBackupLeague: true,
  shareWithFriends: true, shareName: "Rin", keepTeammateViews: true, reviewCopies: true, shareNotes: true, notify: true, autoUpdate: true, autoHighlights: true, highlightsOnly: false, aiReview: true, geminiKey: "sample",
  friends: [
    { name: "Kaja", code: "3f9a1c0b7d2e4a6f8b1c3d5e7f9a0b2c4d6e8f0a1b3c5d7e9f1a2b4c6d8e0f13" },
    { name: "Tor", code: "a81d4e6f0b2c3d5e7f9a1b3c5d7e9f0a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e" },
  ],
};

const status: Status = {
  state: "idle", mode: null, startedEpochMs: null, queueName: null, gameRunning: false, discordRunning: true,
  bookmarks: 0, lastError: null, lastMatchId: null,
};

export async function mock<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const out = ((): unknown => {
    switch (cmd) {
      case "get_settings": return settings;
      case "save_settings": settings = args!.settings as Settings; return settings;
      case "get_status": return status;
      case "environment": return { ffmpeg: "C:\\ffmpeg\\bin\\ffmpeg.exe", ffmpegVersion: "ffmpeg version 7.1.1", ffprobeFound: true, leagueDir: "D:\\Riot Games\\League of Legends", suggestedRecordingsDir: "C:\\Users\\you\\Videos\\Rewatch" };
      case "list_microphones": return [{ id: "a", name: "Headset Microphone", isDefault: true, isDefaultComms: true, level: 0.2 }, { id: "b", name: "Webcam Microphone", isDefault: false, isDefaultComms: false, level: 0 }];
      case "list_matches": return matches;
      case "get_match": {
        const m = matches.find((x) => x.id === args!.id) ?? matches[0];
        const game = m.mode !== "manual";
        const full: MatchFull = { ...m, events: game ? events : [], clock: game ? [[0, 600]] : [], review, stats: game ? stats : null, voice: game ? voice : null, titles: game ? builtInTitles : [], highlights: game ? highlights : [], team: [] };
        return full;
      }
      case "save_review": review = args!.review as Review; return null;
      case "start_manual_recording": status.state = "recording"; status.mode = "manual"; status.startedEpochMs = Date.now(); return null;
      case "stop_recording": status.state = "idle"; status.mode = null; return matches[0].id;
      case "export_clip": return args?.maxMb ? `E:\\Rewatch\\Clips\\clip_${args.maxMb}mb.mp4` : "E:\\Rewatch\\Clips\\clip.mp4";
      case "export_full": return "E:\\Rewatch\\all-tracks.mp4";
      case "build_highlight_reel": return "E:\\Rewatch\\2026-11-12_20-14-03\\highlights_reel.mp4";
      case "library_trends": {
        const list: TrendMatch[] = matches
          .filter((m) => m.mode !== "manual" && m.game.me)
          .map((m, idx) => ({
            id: m.id,
            startedEpochMs: m.startedEpochMs,
            queueId: m.game.queueId,
            queueName: m.game.queueName,
            result: m.game.result ?? null,
            champion: m.game.me!.champion,
            championKey: m.game.me!.championKey,
            position: m.game.me!.position ?? "MIDDLE",
            kills: m.game.me!.kills,
            deaths: m.game.me!.deaths,
            assists: m.game.me!.assists,
            cs: m.game.me!.cs,
            wards: 24 + idx * 3,
            length: m.game.length ?? m.duration,
            cs10: 78 - idx * 4,
            cs15: 128 - idx * 6,
            deadPct: 8 + idx * 4,
            allies: (m.game.players ?? []).filter((p) => !p.isMe && p.team === m.game.me!.team).map((p) => ({ name: p.name, champion: p.champion })),
            tags: m.tags ?? [],
            keep: m.keep,
            deathCauses: idx === 0 ? ["no_vision"] : idx === 1 ? ["overextended", "outnumbered"] : [],
            avgAvoidable: idx === 0 ? 0.81 : idx === 1 ? 0.65 : 0.25,
          }));
        return list;
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
      case "insights": return args!.run ? insights : null;
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
