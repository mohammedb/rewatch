export interface QueueToggles {
  rankedSolo: boolean;
  rankedFlex: boolean;
  normal: boolean;
  aram: boolean;
  custom: boolean;
  other: boolean;
}

export interface KeySlot {
  vk: string;
  label: string;
  row: number;
}

export interface LeagueBackup {
  id: string;
  createdAt: string;
  label: string;
  files: string[];
  sizeBytes: number;
  auto: boolean;
}

export interface Settings {
  recordingsDir: string;
  autoRecord: boolean;
  startWithWindows: boolean;
  fps: number;
  resolution: "native" | "1440" | "1080" | "720";
  codec: "h264" | "hevc" | "av1";
  encoder: "auto" | "nvenc" | "amf" | "qsv" | "cpu";
  quality: number;
  recordDiscord: boolean;
  recordMic: boolean;
  micDevice: string;
  mouseTracking: boolean;
  keyTracking: boolean;
  keyMap: KeySlot[];
  useClientApi: boolean;
  queues: QueueToggles;
  quotaGb: number;
  bookmarkHotkey: string;
  ffmpegPath: string;
  leagueDir: string;
  autoBackupLeague: boolean;
  shareWithFriends: boolean;
  shareName: string;
  keepTeammateViews: boolean;
  reviewCopies: boolean;
  shareNotes: boolean;
  notify: boolean;
  autoUpdate: boolean;
  autoHighlights: boolean;
  highlightsOnly: boolean;
  aiReview: boolean;
  geminiKey: string;
  /** The user's own Riot API key: post-game data from Riot's web API instead of the League client. */
  riotApiKey: string;
  /** After this many losses in a row in one sitting, a notification asks whether to stop for today. 0 is off. */
  breakAfterLosses: number;
  friends: Friend[];
}

export interface Friend {
  name: string;
  /** Their friend code. */
  code: string;
}

export interface ShareInfo {
  /** This PC's friend code. */
  code: string;
  running: boolean;
  online: boolean;
  error: string | null;
  /** People who tried to connect and are not on the teammates list yet. */
  requests: { code: string; name: string; atMs: number }[];
}

/** A teammate's view of the same game. */
export interface Pov {
  friend: string;
  /** Their friend code. */
  code: string;
  /** Saved on this PC: plays without them being online. */
  cached: boolean;
  /** Bytes saved so far and total, while a copy is being saved. */
  saving: [number, number] | null;
  status: "ready" | "none" | "offline" | "denied" | "off" | "badcode";
  player: string;
  champion: string;
  championKey: string;
  position: string;
  /** Seconds to add to a time in my video to get the same moment in theirs. */
  shift: number;
  duration: number;
  video: string | null;
  /** The same video as a plain path or local address, for making clips. */
  source?: string | null;
  /** Their cursor log, when they recorded one. */
  mouse: string | null;
  mouseOffset: number;
  mouseW: number;
  mouseH: number;
}

export interface Status {
  state: "idle" | "starting" | "recording" | "finalizing";
  mode: string | null;
  startedEpochMs: number | null;
  queueName: string | null;
  gameRunning: boolean;
  discordRunning: boolean;
  bookmarks: number;
  lastError: string | null;
  lastMatchId: string | null;
}

export interface Environment {
  ffmpeg: string;
  ffmpegVersion: string | null;
  ffprobeFound: boolean;
  leagueDir: string | null;
  suggestedRecordingsDir: string;
  /** Free space on the drive that holds the recordings. */
  freeBytes?: number | null;
}

export interface MicInfo {
  id: string;
  name: string;
  isDefault: boolean;
  isDefaultComms: boolean;
  level: number;
}

export type TrackName = "game" | "discord" | "mic";

export interface Track {
  name: TrackName;
  file: string | null;
  silent: boolean;
  note: string | null;
}

export interface GameEvent {
  t: number;
  gameTime: number;
  kind: string;
  killer?: string;
  killerChamp?: string;
  victim?: string;
  victimChamp?: string;
  assisters?: string[];
  detail?: string;
  itemId?: number;
  mine: boolean;
  role?: "kill" | "death" | "assist";
  good?: boolean;
}

export interface PlayerRow {
  name: string;
  isMe: boolean;
  champion: string;
  championKey: string;
  team: string;
  /** TOP, JUNGLE, MIDDLE, BOTTOM or UTILITY when the game assigned lanes. */
  position?: string;
  level: number;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  items: { id: number; name: string }[];
}

export interface GameInfo {
  queueId?: number | null;
  queueName?: string | null;
  mode?: string | null;
  map?: string | null;
  length?: number | null;
  result?: "Win" | "Lose" | null;
  me?: PlayerRow | null;
  players?: PlayerRow[];
}

export interface MouseMeta {
  file: string;
  /** Seconds to add to video time to get the time used in the mouse log. */
  offset: number;
  w: number;
  h: number;
}

export interface KeysMeta {
  file: string;
  /** Seconds to add to video time to get the time used in the key log. */
  offset: number;
  /** Key names; key i is bit i of each row's mask. */
  names: string[];
  rows?: string[][];
}

export interface MatchSummary {
  id: string;
  startedAt: string;
  startedEpochMs: number;
  mode: "game" | "manual";
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  video: string;
  tracks: Track[];
  game: GameInfo;
  bookmarks: { t: number }[];
  mouse: MouseMeta | null;
  /** Game keys held during the game; recorded from version 0.2.4 on. */
  keys?: KeysMeta | null;
  dir: string;
  sizeBytes: number;
  /** The part of sizeBytes that is video and sound: what deleting the video frees. */
  videoBytes?: number;
  /** False once the video is deleted or missing. The game's stats, notes and LP stay. */
  hasVideo?: boolean;
  /** When the video was deleted, and by whom: "you", or "limit" for the size limit. */
  videoDeletedAt?: number | null;
  videoDeletedBy?: "you" | "limit" | null;
  keep: boolean;
  tags?: string[];
  /** Marked as reviewed in the app. */
  reviewed?: boolean;
  /** What the player chose to work on after reviewing this game. */
  nextFocus?: NextFocus | null;
  /** How the focus that was set before this game went. */
  focusCheck?: FocusCheck | null;
  notesText?: string;
  noteCount: number;
  thumb: string | null;
  reel?: string | null;
  trimmedToHighlights?: boolean;
  reelDuration?: number;
  summary: { deaths: number; bookmarks: number };
  /** The rank after this game and the LP it won or lost, once Riot has it. */
  rank?: RankChange | null;
  /** What kind of game it was, from Riot's gold numbers. */
  story?: Story | null;
}

/**
 * What kind of game it was, from the team gold lead minute by minute: a comeback (won
 * from 3,000 gold behind), a throw (lost from 3,000 ahead), a stomp (one-sided from
 * early on) or close (no one 3,000 ahead until the last two minutes).
 */
export type Story = "stomp" | "comeback" | "throw" | "close";

/** One ranked queue's standing, as Riot gives it. */
export interface RankEntry {
  queue: string;
  tier: string;
  division: string;
  lp: number;
  wins: number;
  losses: number;
  provisional?: boolean;
  ladder: number | null;
}

/** Everyone's rank, read once soon after the game. */
export interface PlayerRanks {
  /** When they were read, epoch ms. */
  at: number | null;
  players: { name: string; champion: string; championKey: string; team: "ORDER" | "CHAOS"; ranks: RankEntry[] }[];
}

/** The player's note on playing against one champion. */
export interface MatchupNote {
  text: string;
  /** When it was written, epoch ms. */
  at: number;
}

/** One ranked queue's standing after a game, and the LP the game won or lost. */
export interface RankChange {
  /** Riot's name for the queue: "RANKED_SOLO_5x5", "RANKED_FLEX_SR"... */
  queue: string;
  /** IRON to CHALLENGER; empty while unranked. */
  tier: string;
  /** I to IV; empty from Master up. */
  division: string;
  lp: number;
  wins: number;
  losses: number;
  provisional?: boolean;
  /** The standing as one number: 400 a tier, 100 a division, plus LP. */
  ladder: number | null;
  /** LP won or lost; null when it could not be told. */
  delta: number | null;
  won: boolean | null;
  before: { tier: string; division: string; lp: number } | null;
}

/** One player in Riot's record of a game. */
export interface PgPlayer {
  /** 1 to 10, Riot's participant id. */
  id: number;
  puuid: string;
  name: string;
  tag: string;
  teamId: number;
  team: "ORDER" | "CHAOS";
  championId: number;
  champion: string;
  championKey: string;
  position: string;
  win: boolean;
  isMe: boolean;
  level: number;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  gold: number;
  goldSpent: number;
  /** Damage to champions, and its kinds. */
  damage: number;
  physical: number;
  magic: number;
  true: number;
  taken: number;
  mitigated: number;
  heal: number;
  allyHeal: number;
  shield: number;
  objectives: number;
  buildings: number;
  vision: number;
  wardsPlaced: number;
  wardsKilled: number;
  controlWards: number;
  /** Seconds of crowd control on enemies. */
  cc: number;
  deadSecs: number | null;
  largestMulti: number;
  firstBlood: boolean;
  items: number[];
  spells: number[];
  runes: { primary: number; secondary: number; keystone: number; perks: number[]; shards: number[] };
  /** Share of the team's kills taken part in, 0 to 1. */
  kp: number | null;
  /** Share of the team's damage to champions, 0 to 1. */
  dmgShare: number | null;
  /** Skill order, one letter a level: "QEWQQRQ...". */
  skills: string;
  /** Extra numbers only Riot's web API has. */
  extra: Record<string, number> | null;
}

/** What one source did to a player in their last seconds. */
export interface PgRecapHit {
  id: number;
  name: string;
  type: string;
  physical: number;
  magic: number;
  true: number;
  total: number;
  /** "Q", "R", "Auto"... biggest first. */
  hits: string[];
}

export interface PgKill {
  /** Game time, seconds. */
  t: number;
  x: number;
  y: number;
  /** Participant ids; 0 is a turret, minion or monster. */
  killer: number;
  victim: number;
  assists: number[];
  bounty: number;
  shutdown: number;
  /** What killed the victim; only from Riot's web API. */
  recap: PgRecapHit[] | null;
  /** Damage the victim dealt in their last seconds. */
  dealt: number | null;
}

export interface PgObjective {
  t: number;
  kind: string;
  sub: string;
  lane: string;
  /** The team that took it. */
  by: number;
  killer: number;
  x: number;
  y: number;
}

export interface PgTeam {
  teamId: number;
  team: "ORDER" | "CHAOS";
  win: boolean;
  bans: number[];
  kills: number;
  towers: number;
  inhibitors: number;
  dragons: number;
  barons: number;
  heralds: number;
  grubs: number;
  atakhan: number;
}

/** Riot's record of a game, fetched after it: see riot.rs. */
export interface PostGame {
  version: number;
  /** "client": read from the League client; "riot": from Riot's web API. */
  source: "client" | "riot";
  matchId: string;
  gameId: number;
  platform: string;
  queueId: number;
  mapId: number;
  mode: string;
  patch: string;
  /** Seconds. */
  duration: number;
  startMs: number;
  /** My participant id. */
  me: number | null;
  teams: PgTeam[];
  players: PgPlayer[];
  /** Per minute: t in seconds, one row of numbers per player. */
  frames: { t: number[]; players: { id: number; gold: number[]; xp: number[]; cs: number[]; level: number[]; x: number[]; y: number[]; damage: number[] | null }[] } | null;
  kills: PgKill[];
  objectives: PgObjective[];
  /** Me minus my lane opponent, per minute. */
  lane: { opponent: number; gold: number[]; xp: number[]; cs: number[] } | null;
  /** My team's gold minus the enemy team's, per minute. */
  teamGold: number[] | null;
}

/** A kill or death of mine on the map, for Trends. */
export interface TrendSpot {
  x: number;
  y: number;
  /** Game time and video time, seconds. */
  t: number;
  v: number | null;
  /** The other champion: who killed me, or whom I killed. Null for a turret, minions or a monster. */
  other: string | null;
  otherKey: string | null;
}

/** The numbers Trends takes from Riot's record of a game. */
export interface TrendPg {
  mapId: number;
  dmgShare: number | null;
  kp: number | null;
  damage: number;
  dpm: number;
  gold: number;
  gpm: number;
  vision: number;
  vpm: number;
  taken: number;
  /** The lane opponent's champion, when the game had lanes. */
  opp: string | null;
  oppKey: string | null;
  story: Story | null;
  /** Gold, XP and CS against the lane opponent at 10 and 15 minutes. */
  gold10: number | null;
  gold15: number | null;
  xp10: number | null;
  csd10: number | null;
  csd15: number | null;
  deaths: TrendSpot[];
  kills: TrendSpot[];
}

export interface Note {
  id: string;
  t: number;
  text: string;
  /** The note this one answers, for a thread. */
  replyTo?: string;
}

/** One thing to work on in the next games, chosen while reviewing. */
export interface NextFocus {
  text: string;
  /** When it was chosen, in epoch ms. */
  setAt: number;
}

/** The player's own verdict on the focus they had going into a game. */
export interface FocusCheck {
  text: string;
  answer: "yes" | "partly" | "no";
}

export type Tool = "pen" | "arrow" | "circle" | "laser";

export interface Shape {
  tool: Tool;
  color: string;
  /** Points in 0..1 of the video frame. */
  pts: [number, number][];
}

export interface Drawing {
  id: string;
  t: number;
  /** In-game name of the player whose recording it was drawn over. Absent: the author's own. */
  view?: string;
  shapes: Shape[];
}

/** What Google's Decisions API said about one death. Every number is a probability from 0 to 1. */
export interface DeathInsight {
  t: number;
  avoidable?: number | null;
  sawItComing?: number | null;
  allyClose?: number | null;
  cause?: string | null;
  causeP?: number | null;
  fight?: string | null;
  fightP?: number | null;
  /** 0 poor, 1 risky, 2 sound. */
  positioning?: number | null;
  error?: string;
}

/** A moment worth keeping: a multikill, an ace, a fight over a big objective, a fight won clearly. */
export interface Highlight {
  t: number;
  start: number;
  end: number;
  kind: "multikill" | "ace" | "objective" | "fight";
  label: string;
  /** Its saved clip, once there is one. */
  file: string | null;
}

/** A review of one team fight from several teammates' screens. */
export interface TeamReview {
  t: number;
  end: number;
  /** Champions whose screens were used. */
  views: string[];
  model: string;
  summary: string;
  turningPoint: string;
  shouldHave: string[];
  players: { champion: string; did: string; better: string }[];
  call: string;
}

/** A title a player earned in one game, and the number behind it. */
export interface PlayerTitle {
  champion: string;
  name?: string;
  title: string;
  why: string;
}

/** The written review of a game by Gemini. */
export interface Coach {
  model: string;
  headline: string;
  wentWell: string[];
  workOn: string[];
  nextGame: string;
  deaths: { t: number; whatHappened: string; better: string }[];
  titles: PlayerTitle[];
}

export interface Insights {
  model: string;
  deaths: DeathInsight[];
}

/** A stretch of time, from and to, in seconds. */
export type Span = [number, number];

/** When someone was talking on the recording's own sound tracks. */
export interface Voice {
  mic: Span[] | null;
  discord: Span[] | null;
}

/** Every player's numbers over the game, sampled about every ten seconds. */
export interface Stats {
  t: number[];
  /** Your unspent gold. */
  gold: number[];
  players: {
    name: string;
    cs: number[];
    level: number[];
    kills: number[];
    deaths: number[];
    assists: number[];
    itemGold?: number[];
    wardScore?: number[];
    dead?: boolean[];
  }[];
}

/** What a teammate wrote and drew on the same game, and when they spoke, in my video's time. */
export interface Extras {
  friend: string;
  code: string;
  player: string;
  champion: string;
  championKey: string;
  notes: Note[];
  drawings: Drawing[];
  voice: Span[];
  /** Titles from their AI review of the game, if they have one. */
  titles?: PlayerTitle[];
  /** Team reviews of fights made on their PC. */
  team?: TeamReview[];
}

/** A teammate whose player is open right now. */
export interface WatchPeer {
  code: string;
  name: string;
  playing: boolean;
  rate: number;
  /** My recording of the game they are watching, if I have one. */
  matchId: string | null;
  /** Where they are, in my video's time. */
  t: number | null;
}

/** A position report from a teammate, as it arrives. */
export interface WatchEvent {
  kind: "control" | "sync" | "presence" | "left";
  code: string;
  name: string;
  playing?: boolean;
  rate?: number;
  matchId?: string;
  t?: number;
}

export interface UpdateInfo {
  current: string;
  available: { version: string; notes: string; url: string } | null;
  checked: boolean;
  installing: boolean;
  error: string | null;
}

export interface AudioPrefs {
  volume: Record<TrackName, number>;
  muted: Record<TrackName, boolean>;
  duck?: boolean;
}

export interface Review {
  keep: boolean;
  notes: Note[];
  drawings: Drawing[];
  tags?: string[];
  audio?: AudioPrefs;
  /** When the player marked the game as reviewed, in epoch ms. */
  reviewedAt?: number | null;
  nextFocus?: NextFocus | null;
  focusCheck?: FocusCheck | null;
}

export interface TrendMatch {
  id: string;
  startedEpochMs: number;
  queueId?: number | null;
  queueName?: string | null;
  result?: "Win" | "Lose" | null;
  champion: string;
  championKey?: string | null;
  position: string;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  wards?: number | null;
  length: number;
  cs10?: number | null;
  cs15?: number | null;
  deadPct?: number | null;
  allies: { name: string; champion: string }[];
  tags: string[];
  keep: boolean;
  reviewed?: boolean;
  /** The player's verdict on their focus for this game. */
  focus?: FocusCheck | null;
  deathCauses: string[];
  avgAvoidable?: number | null;
  rank?: RankChange | null;
  /** From Riot's record of the game, once fetched. */
  pg?: TrendPg | null;
  /** False once the game's video is deleted: its numbers stay, its moments can't be played. */
  hasVideo?: boolean;
}

export interface MatchFull extends Omit<MatchSummary, "keep" | "noteCount" | "thumb" | "summary" | "reviewed" | "nextFocus" | "focusCheck"> {
  events: GameEvent[];
  clock: [number, number][];
  review: Review;
  stats?: Stats | null;
  voice?: Voice | null;
  insights?: Insights | null;
  coach?: Coach | null;
  highlights?: Highlight[];
  team?: TeamReview[];
  /** Titles worked out from the game's own numbers. */
  titles?: PlayerTitle[];
  /** Riot's record of the game, once fetched. */
  postgame?: PostGame | null;
  /** Why Riot's record is not here yet. */
  postgameNote?: string | null;
  /**
   * Everyone's rank, read within a few hours of the game. Games recorded before this
   * was added don't have it: today's ranks would not be the ranks they played at.
   */
  playerRanks?: PlayerRanks | null;
}
