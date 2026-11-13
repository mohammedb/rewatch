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
  keep: boolean;
  tags?: string[];
  notesText?: string;
  noteCount: number;
  thumb: string | null;
  reel?: string | null;
  trimmedToHighlights?: boolean;
  reelDuration?: number;
  summary: { deaths: number; bookmarks: number };
}

export interface Note {
  id: string;
  t: number;
  text: string;
}

export type Tool = "pen" | "arrow" | "circle";

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
  deathCauses: string[];
  avgAvoidable?: number | null;
}

export interface MatchFull extends Omit<MatchSummary, "keep" | "noteCount" | "thumb" | "summary"> {
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
}
