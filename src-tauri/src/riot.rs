//! Post-game data from Riot. After each game: the full match record (damage, gold,
//! vision, runes, bans...), the minute-by-minute timeline (every player's position,
//! gold and XP each minute, and where each kill happened) and the player's rank
//! before and after it, for the LP won or lost.
//!
//! Two sources. The League client's local API needs nothing set up and is only read.
//! Riot's official web API is used instead when the user adds their own API key; its
//! record has a little more (what killed you, damage per minute). The raw answers are
//! kept in the game's folder (`riot_match.json`, `riot_timeline.json`) and boiled
//! down into `postgame.json`, which is what the app reads. A change to that summary
//! only needs the raw files, not Riot.
//!
//! Hard rule 1: the one read at game start (who is playing, and their rank) happens
//! while the game loads, on its own thread. Everything else waits until no game is
//! running.

use crate::settings::{app_dir, log, Settings};
use anyhow::{anyhow, Result};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

/// The summary the app reads.
pub const FILE: &str = "postgame.json";
/// Who played, their rank before and after, and how fetching went.
pub const RIOT_FILE: &str = "riot.json";
const RAW_MATCH: &str = "riot_match.json";
const RAW_TIMELINE: &str = "riot_timeline.json";
/// Bumped whenever `normalize` changes. Saved games are then summarized again from
/// their raw files, without asking Riot. 2: players whose name the live feed hid get
/// their champion.
pub const VERSION: i64 = 2;
/// Attempts at a game's match data before giving up on it.
const MAX_TRIES: i64 = 8;
/// Games looked up per round of the background job. Each is about two requests.
const PER_ROUND: usize = 6;

/// One piece of Riot work at a time: the background job, "fetch now" in the player
/// and the read at game start all write the same small files.
static BUSY: Mutex<()> = Mutex::new(());
/// The web API key Riot last refused. Not tried again until the key changes.
static REJECTED_KEY: Mutex<Option<String>> = Mutex::new(None);
/// When the last web request went out, for pacing.
static LAST_WEB: Mutex<Option<Instant>> = Mutex::new(None);
/// Recordings with nothing left to fetch, and whether a web key was usable when that
/// was decided (adding a key gives games read from the client more to fetch).
static SETTLED: Mutex<Option<(bool, HashSet<PathBuf>)>> = Mutex::new(None);
/// What each recording's match.json says, by when the file last changed.
static GAMES: Mutex<Option<HashMap<PathBuf, (SystemTime, Option<GameRef>)>>> = Mutex::new(None);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ------------------------------------------------------------------ small helpers

fn num(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f.round() as i64))).unwrap_or(0)
}

fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}

fn flag(v: &Value, k: &str) -> bool {
    v.get(k).and_then(|x| x.as_bool()).unwrap_or(false)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn read_json(path: &Path) -> Option<Value> {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok())
}

/// Write through a temporary file, so a crash never leaves half a file behind.
fn write_json(path: &Path, v: &Value) -> Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec(v)?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn same_name(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim(), b.trim());
    !a.is_empty() && a.to_lowercase() == b.to_lowercase()
}

fn dir_id(dir: &Path) -> String {
    dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

// ------------------------------------------------------------------ regions

/// Riot's platform id ("EUW1") for a region name as the client gives it ("EUW").
fn platform_for_region(region: &str) -> Option<&'static str> {
    Some(match region.trim().to_uppercase().as_str() {
        "EUW" | "EUW1" => "EUW1",
        "EUNE" | "EUN1" => "EUN1",
        "NA" | "NA1" => "NA1",
        "BR" | "BR1" => "BR1",
        "LAN" | "LA1" => "LA1",
        "LAS" | "LA2" => "LA2",
        "OCE" | "OC1" => "OC1",
        "TR" | "TR1" => "TR1",
        "RU" | "RU1" => "RU",
        "JP" | "JP1" => "JP1",
        "KR" => "KR",
        "ME" | "ME1" => "ME1",
        "PH" | "PH2" => "PH2",
        "SG" | "SG2" => "SG2",
        "TH" | "TH2" => "TH2",
        "TW" | "TW2" => "TW2",
        "VN" | "VN2" => "VN2",
        _ => return None,
    })
}

/// The regional cluster that holds a platform's match records.
fn regional_host(platform: &str) -> &'static str {
    match platform.to_uppercase().as_str() {
        "NA1" | "BR1" | "LA1" | "LA2" => "americas",
        "KR" | "JP1" => "asia",
        "OC1" | "PH2" | "SG2" | "TH2" | "TW2" | "VN2" => "sea",
        _ => "europe",
    }
}

fn match_id(platform: &str, game_id: i64) -> String {
    format!("{}_{game_id}", platform.to_uppercase())
}

fn match_url(platform: &str, path: &str) -> String {
    format!("https://{}.api.riotgames.com/lol/match/v5/{path}", regional_host(platform))
}

fn platform_url(platform: &str, path: &str) -> String {
    format!("https://{}.api.riotgames.com{path}", platform.to_lowercase())
}

// ------------------------------------------------------------------ accounts

/// A Riot account, as far as it is known.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Account {
    pub puuid: String,
    pub game_name: String,
    pub tag_line: String,
    pub platform: String,
}

impl Account {
    fn to_json(&self) -> Value {
        json!({ "puuid": self.puuid, "gameName": self.game_name, "tagLine": self.tag_line, "platform": self.platform })
    }

    fn from_json(v: &Value) -> Account {
        Account {
            puuid: text(v, "puuid").into(),
            game_name: text(v, "gameName").into(),
            tag_line: text(v, "tagLine").into(),
            platform: text(v, "platform").into(),
        }
    }
}

fn accounts_file() -> PathBuf {
    app_dir().join("riot_accounts.json")
}

/// Accounts seen playing on this PC, newest first. Older recordings only know the
/// player's name; this is how they are matched to an account and region.
fn known_accounts() -> Vec<Account> {
    read_json(&accounts_file())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(Account::from_json)
        .filter(|a| !a.puuid.is_empty())
        .collect()
}

fn remember_account(a: &Account) {
    if a.puuid.is_empty() {
        return;
    }
    let mut all = known_accounts();
    if all.first() == Some(a) {
        return;
    }
    all.retain(|k| k.puuid != a.puuid);
    all.insert(0, a.clone());
    let _ = write_json(&accounts_file(), &Value::Array(all.iter().map(Account::to_json).collect()));
}

/// Who played a recorded game: certain when the game's start was seen, otherwise
/// worked out from the player's name.
fn who_played(riot: &Value, game: &GameRef, client: Option<&Account>) -> Account {
    if !text(riot, "puuid").is_empty() {
        return Account::from_json(riot);
    }
    let known = known_accounts();
    if let Some(a) = known.iter().find(|a| same_name(&a.game_name, &game.me_name)) {
        return a.clone();
    }
    if let Some(a) = client.filter(|a| same_name(&a.game_name, &game.me_name)) {
        return a.clone();
    }
    // Not an account seen before. Most people play on one region, so borrow it.
    Account {
        platform: known
            .first()
            .map(|a| a.platform.clone())
            .or_else(|| client.map(|a| a.platform.clone()))
            .unwrap_or_default(),
        ..Default::default()
    }
}

// ------------------------------------------------------------------ the League client

/// The League client's local API, found through its lockfile. Only ever read.
pub struct Lcu {
    base: String,
    auth: String,
    agent: ureq::Agent,
}

impl Lcu {
    /// Only reads the lockfile; nothing is asked yet. None when the client is closed
    /// or the setting is off.
    pub fn connect(settings: &Settings) -> Option<Lcu> {
        if !settings.use_client_api {
            return None;
        }
        let lock = fs::read_to_string(settings.league_path()?.join("lockfile")).ok()?;
        let parts: Vec<&str> = lock.trim().split(':').collect();
        if parts.len() < 5 {
            return None;
        }
        let agent = ureq::Agent::config_builder()
            .tls_config(ureq::tls::TlsConfig::builder().disable_verification(true).build())
            .timeout_global(Some(Duration::from_secs(20)))
            .http_status_as_error(false)
            .build()
            .into();
        Some(Lcu {
            base: format!("https://127.0.0.1:{}", parts[2]),
            auth: format!("Basic {}", crate::liveclient::base64(format!("riot:{}", parts[3]).as_bytes())),
            agent,
        })
    }

    fn get(&self, path: &str) -> Option<Value> {
        let mut resp = self
            .agent
            .get(&format!("{}{path}", self.base))
            .header("Authorization", &self.auth)
            .call()
            .ok()?;
        if resp.status().as_u16() != 200 {
            return None;
        }
        resp.body_mut().with_config().limit(64 * 1024 * 1024).read_json::<Value>().ok()
    }

    /// The account logged in to the client, and its region.
    pub fn account(&self) -> Option<Account> {
        let me = self.get("/lol-summoner/v1/current-summoner")?;
        let puuid = text(&me, "puuid");
        if puuid.is_empty() {
            return None;
        }
        Some(Account {
            puuid: puuid.into(),
            game_name: text(&me, "gameName").into(),
            tag_line: text(&me, "tagLine").into(),
            platform: self.platform().unwrap_or_default(),
        })
    }

    fn platform(&self) -> Option<String> {
        if let Some(p) = self.get("/lol-platform-config/v1/namespaces/LoginDataPacket/platformId") {
            if let Some(p) = p.as_str().filter(|p| !p.is_empty()) {
                return Some(p.to_uppercase());
            }
        }
        let rl = self.get("/riotclient/region-locale")?;
        platform_for_region(text(&rl, "region")).map(String::from)
    }

    fn ranks(&self) -> Option<Vec<Value>> {
        self.ranks_at("/lol-ranked/v1/current-ranked-stats")
    }

    /// Any player's standing, by their Riot id. The client only knows players on its
    /// own region.
    fn ranks_of(&self, puuid: &str) -> Option<Vec<Value>> {
        self.ranks_at(&format!("/lol-ranked/v1/ranked-stats/{puuid}"))
    }

    fn ranks_at(&self, path: &str) -> Option<Vec<Value>> {
        let v = self.get(path)?;
        Some(v.get("queues")?.as_array()?.iter().filter_map(rank_entry).collect())
    }

    fn game(&self, game_id: i64) -> Option<Value> {
        self.get(&format!("/lol-match-history/v1/games/{game_id}"))
            .filter(|g| g.get("participants").and_then(|p| p.as_array()).is_some_and(|p| !p.is_empty()))
    }

    fn timeline(&self, game_id: i64) -> Option<Value> {
        self.get(&format!("/lol-match-history/v1/game-timelines/{game_id}"))
            .filter(|t| t.get("frames").and_then(|f| f.as_array()).is_some_and(|f| !f.is_empty()))
    }

    /// The logged-in account's recent games, newest first.
    fn recent_games(&self) -> Vec<Value> {
        self.get("/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=50")
            .and_then(|v| v.pointer("/games/games").and_then(|g| g.as_array()).cloned())
            .unwrap_or_default()
    }
}

/// The game in the client's recent list that a recording shows: created within
/// minutes of the recording starting, and played by the same name.
fn find_in_client(games: &[Value], game: &GameRef) -> Option<i64> {
    games
        .iter()
        .filter_map(|g| {
            let gap = (num(g, "gameCreation") - game.started_ms).abs();
            if gap > 15 * 60_000 {
                return None;
            }
            let named = g
                .get("participantIdentities")
                .and_then(|p| p.as_array())
                .filter(|ids| !ids.is_empty())
                .map(|ids| {
                    ids.iter().any(|i| {
                        let p = i.get("player").unwrap_or(&Value::Null);
                        same_name(text(p, "gameName"), &game.me_name) || same_name(text(p, "summonerName"), &game.me_name)
                    })
                })
                .unwrap_or(true);
            named.then_some((gap, num(g, "gameId")))
        })
        .min_by_key(|(gap, _)| *gap)
        .map(|(_, id)| id)
        .filter(|id| *id > 0)
}

// ------------------------------------------------------------------ Riot's web API

enum Got {
    Data(Value),
    Missing,
    KeyRefused,
    Failed(String),
}

/// Riot's official web API, with the user's own key.
pub struct Web {
    key: String,
    agent: ureq::Agent,
}

/// Keep well inside a development key's limit of 100 requests per two minutes.
fn pace() {
    let mut last = lock(&LAST_WEB);
    if let Some(t) = *last {
        let gap = Duration::from_millis(1300);
        let since = t.elapsed();
        if since < gap {
            std::thread::sleep(gap - since);
        }
    }
    *last = Some(Instant::now());
}

impl Web {
    fn new(key: &str) -> Web {
        Web {
            key: key.trim().to_string(),
            agent: ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(30)))
                .http_status_as_error(false)
                .build()
                .into(),
        }
    }

    fn get(&self, url: &str) -> Got {
        for _ in 0..3 {
            pace();
            let mut resp = match self.agent.get(url).header("X-Riot-Token", &self.key).call() {
                Ok(r) => r,
                Err(e) => return Got::Failed(format!("Could not reach Riot ({e})")),
            };
            let status = resp.status().as_u16();
            match status {
                200 => {
                    return match resp.body_mut().with_config().limit(64 * 1024 * 1024).read_json::<Value>() {
                        Ok(v) => Got::Data(v),
                        Err(e) => Got::Failed(format!("Riot's answer could not be read ({e})")),
                    }
                }
                404 => return Got::Missing,
                401 | 403 => return Got::KeyRefused,
                429 | 500..=599 => {
                    let wait = resp
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.trim().parse::<u64>().ok())
                        .unwrap_or(if status == 429 { 10 } else { 3 });
                    std::thread::sleep(Duration::from_secs(wait.clamp(1, 120)));
                }
                _ => return Got::Failed(format!("Riot answered {status}")),
            }
        }
        Got::Failed("Riot is busy right now".into())
    }

    fn game(&self, platform: &str, id: &str) -> Got {
        self.get(&match_url(platform, &format!("matches/{id}")))
    }

    fn timeline(&self, platform: &str, id: &str) -> Got {
        self.get(&match_url(platform, &format!("matches/{id}/timeline")))
    }

    fn ranks(&self, platform: &str, puuid: &str) -> Option<Vec<Value>> {
        match self.get(&platform_url(platform, &format!("/lol/league/v4/entries/by-puuid/{puuid}"))) {
            Got::Data(v) => Some(v.as_array()?.iter().filter_map(rank_entry).collect()),
            _ => None,
        }
    }

    /// The account's game that started closest to `at_ms`, if one did within minutes.
    fn find_game(&self, platform: &str, puuid: &str, at_ms: i64) -> Result<Option<(i64, Value)>, Miss> {
        let secs = at_ms / 1000;
        let url = match_url(
            platform,
            &format!("matches/by-puuid/{puuid}/ids?startTime={}&endTime={}&count=5", secs - 1800, secs + 1800),
        );
        let ids = match self.get(&url) {
            Got::Data(v) => v.as_array().cloned().unwrap_or_default(),
            Got::Missing => return Ok(None),
            Got::KeyRefused => return Err(Miss::KeyRefused),
            Got::Failed(e) => return Err(Miss::Retry(e)),
        };
        let mut best: Option<(i64, i64, Value)> = None;
        for id in ids.iter().filter_map(|v| v.as_str()).take(3) {
            let Some(gid) = id.rsplit('_').next().and_then(|g| g.parse::<i64>().ok()) else { continue };
            match self.game(platform, id) {
                Got::Data(m) => {
                    let start = m
                        .pointer("/info/gameStartTimestamp")
                        .or_else(|| m.pointer("/info/gameCreation"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let gap = (start - at_ms).abs();
                    if gap < 15 * 60_000 && best.as_ref().is_none_or(|b| gap < b.0) {
                        best = Some((gap, gid, m));
                    }
                }
                Got::KeyRefused => return Err(Miss::KeyRefused),
                _ => {}
            }
        }
        Ok(best.map(|(_, gid, m)| (gid, m)))
    }
}

/// The web API, unless there is no key or Riot refused this one.
fn usable_web(settings: &Settings) -> Option<Web> {
    let key = settings.riot_api_key.trim();
    if key.is_empty() || lock(&REJECTED_KEY).as_deref() == Some(key) {
        return None;
    }
    Some(Web::new(key))
}

/// Try a key on Riot's status endpoint, which any valid key may read.
pub fn check_key(key: &str) -> Value {
    let key = key.trim();
    if key.is_empty() {
        return json!({ "ok": false, "message": "No key entered." });
    }
    let platform = known_accounts()
        .first()
        .map(|a| a.platform.clone())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "EUW1".into());
    match Web::new(key).get(&platform_url(&platform, "/lol/status/v4/platform-data")) {
        Got::Data(_) | Got::Missing => {
            let mut rejected = lock(&REJECTED_KEY);
            if rejected.as_deref() == Some(key) {
                *rejected = None;
            }
            json!({ "ok": true, "message": "Riot accepted the key." })
        }
        Got::KeyRefused => json!({
            "ok": false,
            "message": "Riot refused this key. A development key stops working 24 hours after it was made; make a new one at developer.riotgames.com.",
        }),
        Got::Failed(e) => json!({ "ok": false, "message": e }),
    }
}

// ------------------------------------------------------------------ ranks

const TIERS: [&str; 10] = [
    "IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER",
];

/// A standing as one number: 100 per division and 400 per tier, so two standings can
/// be subtracted across a promotion. Master and above share one LP scale.
fn ladder(tier: &str, division: &str, lp: i64) -> Option<i64> {
    let t = TIERS.iter().position(|x| *x == tier)? as i64;
    if t >= 7 {
        return Some(7 * 400 + lp);
    }
    let d = ["IV", "III", "II", "I"].iter().position(|x| *x == division)? as i64;
    Some(t * 400 + d * 100 + lp)
}

/// One ranked queue's standing, from either source, in one shape.
fn rank_entry(q: &Value) -> Option<Value> {
    let queue = text(q, "queueType");
    if queue.is_empty() {
        return None;
    }
    let tier = text(q, "tier").to_uppercase();
    let tier = if TIERS.contains(&tier.as_str()) { tier } else { String::new() };
    // The client calls it "division", the web API "rank"; Master and above have none.
    let division = [text(q, "division"), text(q, "rank")]
        .into_iter()
        .find(|d| ["I", "II", "III", "IV"].contains(d))
        .unwrap_or("")
        .to_string();
    let lp = num(q, "leaguePoints");
    Some(json!({
        "queue": queue,
        "tier": tier,
        "division": division,
        "lp": lp,
        "wins": num(q, "wins"),
        "losses": num(q, "losses"),
        "provisional": flag(q, "isProvisional"),
        "ladder": ladder(&tier, &division, lp),
    }))
}

fn entry<'a>(list: &'a [Value], queue: &str) -> Option<&'a Value> {
    list.iter().find(|e| text(e, "queue") == queue)
}

fn games_in(e: Option<&Value>) -> i64 {
    e.map(|e| num(e, "wins") + num(e, "losses")).unwrap_or(0)
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Ranked {
    /// A queue with LP, by the name Riot's ranked data uses for it.
    Queue(&'static str),
    /// Possibly ranked, but which ranked queue is not known here.
    Unknown,
    No,
}

fn ranked_queue(queue_id: Option<i64>, queue_name: &str) -> Ranked {
    match queue_id {
        Some(420) => Ranked::Queue("RANKED_SOLO_5x5"),
        Some(440) => Ranked::Queue("RANKED_FLEX_SR"),
        None => Ranked::Unknown,
        _ if queue_name.to_lowercase().contains("ranked") => Ranked::Unknown,
        _ => Ranked::No,
    }
}

/// How many games the game's queue gained between two snapshots. For a queue not
/// known here, the one queue that changed is taken; several changing reads as "more
/// than one game".
fn games_added(before: &[Value], after: &[Value], queue: Ranked) -> i64 {
    match queue {
        Ranked::Queue(q) => games_in(entry(after, q)) - games_in(entry(before, q)),
        Ranked::No => 0,
        Ranked::Unknown => {
            let grown: Vec<i64> = after
                .iter()
                .map(|a| games_in(Some(a)) - games_in(entry(before, text(a, "queue"))))
                .filter(|g| *g != 0)
                .collect();
            match grown.as_slice() {
                [] => 0,
                [one] => *one,
                _ => 2,
            }
        }
    }
}

/// Riot's name for the queue a game counted in.
fn queue_of(before: Option<&[Value]>, after: &[Value], queue: Ranked) -> Option<String> {
    match queue {
        Ranked::Queue(q) => Some(q.to_string()),
        Ranked::No => None,
        Ranked::Unknown => {
            let before = before?;
            let grown: Vec<&Value> = after
                .iter()
                .filter(|a| games_in(Some(a)) - games_in(entry(before, text(a, "queue"))) == 1)
                .collect();
            (grown.len() == 1).then(|| text(grown[0], "queue").to_string())
        }
    }
}

/// The standing after a game and the LP it won or lost. With a snapshot from before
/// the game, the two must have exactly that one game between them; without one, the
/// standing is all there is.
fn rank_change(before: Option<&[Value]>, after: &[Value], queue: Ranked) -> Option<Value> {
    let q = queue_of(before, after, queue)?;
    let a = entry(after, &q)?;
    let b = before.and_then(|b| entry(b, &q));
    let one_game = before.is_some() && games_in(Some(a)) - games_in(b) == 1;
    if before.is_some() && !one_game {
        // Other games (or none) in between: this is not the standing after the game.
        return None;
    }
    let ladder_of = |e: &Value| e.get("ladder").and_then(|x| x.as_i64());
    let delta = match (one_game, ladder_of(a), b.and_then(ladder_of)) {
        (true, Some(x), Some(y)) => Some(x - y),
        _ => None,
    };
    let won = one_game.then(|| num(a, "wins") > b.map(|b| num(b, "wins")).unwrap_or(0));
    let before_standing = match (one_game, b) {
        (true, Some(b)) if !text(b, "tier").is_empty() => json!({ "tier": b["tier"], "division": b["division"], "lp": b["lp"] }),
        _ => Value::Null,
    };
    Some(json!({
        "queue": q,
        "tier": a["tier"],
        "division": a["division"],
        "lp": a["lp"],
        "wins": a["wins"],
        "losses": a["losses"],
        "provisional": a["provisional"],
        "ladder": a["ladder"],
        "delta": delta,
        "won": won,
        "before": before_standing,
    }))
}

// ------------------------------------------------------------------ recordings

/// What a recording knows about its game.
#[derive(Clone, Debug, Default)]
struct GameRef {
    started_ms: i64,
    ended_ms: i64,
    game_id: Option<i64>,
    queue_id: Option<i64>,
    queue_name: String,
    /// The game's mode as the live feed names it: "CLASSIC", "ARAM", "PRACTICETOOL"...
    game_mode: String,
    me_name: String,
    me_champion: String,
    me_team: String,
    players: Vec<Value>,
}

fn game_ref_from(doc: &Value) -> Option<GameRef> {
    if text(doc, "mode") != "game" {
        return None;
    }
    let game = doc.get("game")?;
    let me = game.get("me").filter(|m| m.is_object())?;
    let started = num(doc, "startedEpochMs");
    let duration = doc.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
    Some(GameRef {
        started_ms: started,
        ended_ms: started + (duration * 1000.0) as i64,
        game_id: game.get("gameId").and_then(|v| v.as_i64()).filter(|g| *g > 0),
        queue_id: game.get("queueId").and_then(|v| v.as_i64()),
        queue_name: text(game, "queueName").into(),
        game_mode: text(game, "mode").into(),
        me_name: text(me, "name").into(),
        me_champion: text(me, "champion").into(),
        me_team: text(me, "team").into(),
        players: game.get("players").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
    })
}

/// A recording's game, read once per change of its match.json. None for manual
/// recordings and games where the player was not found.
fn game_ref(dir: &Path) -> Option<GameRef> {
    let path = dir.join("match.json");
    let stamp = fs::metadata(&path).and_then(|m| m.modified()).ok()?;
    let mut cache = lock(&GAMES);
    let map = cache.get_or_insert_with(HashMap::new);
    if let Some((seen, g)) = map.get(dir) {
        if *seen == stamp {
            return g.clone();
        }
    }
    let g = read_json(&path).and_then(|doc| game_ref_from(&doc));
    map.insert(dir.to_path_buf(), (stamp, g.clone()));
    g
}

/// The game-clock samples of a match.json: (video time, game time) pairs.
pub fn clock_of(doc: &Value) -> Vec<(f64, f64)> {
    doc.get("clock")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|c| Some((c.get(0)?.as_f64()?, c.get(1)?.as_f64()?))).collect())
        .unwrap_or_default()
}

/// Where in the video a moment of game time is.
pub fn video_time(clock: &[(f64, f64)], game_t: f64) -> Option<f64> {
    if clock.is_empty() {
        return None;
    }
    let i = clock.iter().take_while(|c| c.1 <= game_t).count().saturating_sub(1);
    let (v0, g0) = clock[i];
    let v = v0 + game_t - g0;
    // From before the recording started: there is nothing to play.
    (v >= 0.0).then(|| (v * 10.0).round() / 10.0)
}

// ------------------------------------------------------------------ the summary

/// One participant's numbers in one shape: the client's format keeps them under
/// "stats", the web API's on the participant itself.
fn flat(p: &Value) -> Value {
    match p.get("stats") {
        Some(Value::Object(stats)) => {
            let mut o = stats.clone();
            for (k, v) in p.as_object().into_iter().flatten() {
                if k != "stats" && k != "timeline" {
                    o.entry(k.clone()).or_insert_with(|| v.clone());
                }
            }
            Value::Object(o)
        }
        _ => p.clone(),
    }
}

/// A position from the client format's lane and role guesses.
fn position_from_lane(p: &Value) -> String {
    let lane = p.pointer("/timeline/lane").and_then(|v| v.as_str()).unwrap_or("");
    let role = p.pointer("/timeline/role").and_then(|v| v.as_str()).unwrap_or("");
    match lane {
        "TOP" => "TOP",
        "JUNGLE" => "JUNGLE",
        "MIDDLE" | "MID" => "MIDDLE",
        "BOTTOM" | "BOT" if role == "DUO_SUPPORT" => "UTILITY",
        "BOTTOM" | "BOT" => "BOTTOM",
        _ => "",
    }
    .to_string()
}

fn runes(f: &Value) -> Value {
    if let Some(styles) = f.pointer("/perks/styles").and_then(|s| s.as_array()) {
        let style = |i: usize| styles.get(i).map(|s| num(s, "style")).unwrap_or(0);
        let perks: Vec<i64> = styles
            .iter()
            .flat_map(|s| s.get("selections").and_then(|x| x.as_array()).cloned().unwrap_or_default())
            .map(|x| num(&x, "perk"))
            .collect();
        let shards: Vec<i64> = f
            .pointer("/perks/statPerks")
            .map(|sp| ["offense", "flex", "defense"].iter().map(|k| num(sp, k)).collect())
            .unwrap_or_default();
        return json!({ "primary": style(0), "secondary": style(1), "keystone": perks.first().copied().unwrap_or(0), "perks": perks, "shards": shards });
    }
    let perks: Vec<i64> = (0..6).map(|i| num(f, &format!("perk{i}"))).filter(|x| *x > 0).collect();
    let shards: Vec<i64> = (0..3).map(|i| num(f, &format!("statPerk{i}"))).filter(|x| *x > 0).collect();
    json!({
        "primary": num(f, "perkPrimaryStyle"),
        "secondary": num(f, "perkSubStyle"),
        "keystone": perks.first().copied().unwrap_or(0),
        "perks": perks,
        "shards": shards,
    })
}

/// The web API's extra numbers ("challenges") worth showing. None from the client.
fn extras(f: &Value) -> Value {
    let Some(c) = f.get("challenges").filter(|c| c.is_object()) else { return Value::Null };
    let pings: i64 = f
        .as_object()
        .map(|o| o.iter().filter(|(k, _)| k.ends_with("Pings")).map(|(_, v)| v.as_i64().unwrap_or(0)).sum::<i64>())
        .unwrap_or(0);
    json!({
        "soloKills": num(c, "soloKills"),
        "plates": num(c, "turretPlatesTaken"),
        "skillshotsHit": num(c, "skillshotsHit"),
        "skillshotsDodged": num(c, "skillshotsDodged"),
        "csAt10": num(c, "laneMinionsFirst10Minutes") + num(c, "jungleCsBefore10Minutes"),
        "controlWardsPlaced": num(c, "controlWardsPlaced"),
        "abilityUses": num(c, "abilityUses"),
        "immobilizations": num(c, "enemyChampionImmobilizations"),
        "saves": num(c, "saveAllyFromDeath"),
        "maxCsLead": num(c, "maxCsAdvantageOnLaneOpponent"),
        "maxLevelLead": num(c, "maxLevelLeadLaneOpponent"),
        "pings": pings,
    })
}

fn team_row(t: &Value, kills: i64) -> Value {
    let obj = |v5: &str, client: &str| {
        t.pointer(&format!("/objectives/{v5}/kills")).and_then(|v| v.as_i64()).unwrap_or_else(|| num(t, client))
    };
    let win = match t.get("win") {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s == "Win",
        _ => false,
    };
    let team_id = num(t, "teamId");
    json!({
        "teamId": team_id,
        "team": if team_id == 200 { "CHAOS" } else { "ORDER" },
        "win": win,
        "bans": t.get("bans").and_then(|b| b.as_array()).map(|b| b.iter().map(|x| num(x, "championId")).filter(|c| *c > 0).collect::<Vec<_>>()).unwrap_or_default(),
        "kills": kills,
        "towers": obj("tower", "towerKills"),
        "inhibitors": obj("inhibitor", "inhibitorKills"),
        "dragons": obj("dragon", "dragonKills"),
        "barons": obj("baron", "baronKills"),
        "heralds": obj("riftHerald", "riftHeraldKills"),
        "grubs": obj("horde", "hordeKills"),
        "atakhan": obj("atakhan", "atakhanKills"),
    })
}

/// What killed a player: the damage taken in their last seconds, by source, biggest
/// first. Only the web API's timeline has it.
fn recap(list: Option<&Value>) -> Value {
    let Some(list) = list.and_then(|l| l.as_array()) else { return Value::Null };
    struct Hit {
        id: i64,
        name: String,
        kind: String,
        physical: i64,
        magic: i64,
        truedmg: i64,
        hits: Vec<(String, i64)>,
    }
    let mut out: Vec<Hit> = Vec::new();
    for d in list {
        let kind = text(d, "type").to_string();
        let name = match kind.as_str() {
            "TOWER" => "Turret".to_string(),
            "MINION" => "Minions".to_string(),
            "MONSTER" => "Monster".to_string(),
            _ => text(d, "name").to_string(),
        };
        let id = num(d, "participantId");
        let (p, m, t) = (num(d, "physicalDamage"), num(d, "magicDamage"), num(d, "trueDamage"));
        let hit = if flag(d, "basic") {
            "Auto"
        } else {
            match num(d, "spellSlot") {
                0 => "Q",
                1 => "W",
                2 => "E",
                3 => "R",
                4 | 5 => "Summoner",
                _ => "Other",
            }
        };
        let i = match out.iter().position(|h| h.id == id && h.name == name) {
            Some(i) => i,
            None => {
                out.push(Hit { id, name, kind, physical: 0, magic: 0, truedmg: 0, hits: Vec::new() });
                out.len() - 1
            }
        };
        let h = &mut out[i];
        h.physical += p;
        h.magic += m;
        h.truedmg += t;
        match h.hits.iter_mut().find(|(n, _)| n == hit) {
            Some(x) => x.1 += p + m + t,
            None => h.hits.push((hit.to_string(), p + m + t)),
        }
    }
    out.sort_by_key(|h| -(h.physical + h.magic + h.truedmg));
    Value::Array(
        out.into_iter()
            .map(|mut h| {
                h.hits.sort_by_key(|(_, d)| -*d);
                json!({
                    "id": h.id,
                    "name": h.name,
                    "type": h.kind,
                    "physical": h.physical,
                    "magic": h.magic,
                    "true": h.truedmg,
                    "total": h.physical + h.magic + h.truedmg,
                    "hits": h.hits.into_iter().map(|(n, _)| n).collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

/// Per-minute numbers for one player, from the timeline frames.
#[derive(Default)]
struct Track {
    gold: Vec<i64>,
    xp: Vec<i64>,
    cs: Vec<i64>,
    level: Vec<i64>,
    x: Vec<i64>,
    y: Vec<i64>,
    damage: Vec<i64>,
    has_damage: bool,
}

fn seconds(e: &Value) -> f64 {
    (num(e, "timestamp") as f64 / 100.0).round() / 10.0
}

fn spot(e: &Value) -> (i64, i64) {
    let p = e.get("position").unwrap_or(&Value::Null);
    (num(p, "x"), num(p, "y"))
}

/// A player in Riot's record, as far as finding them in the recording goes.
struct Person {
    name: String,
    side: &'static str,
    /// Kills, deaths, assists and CS at the end.
    numbers: [i64; 4],
}

/// Each player's row in the recording's own list (an index into it). By name first.
/// The live feed shows a player who hides their name under another one, often their
/// champion's. Such a player is the one left on their team when one row is left too;
/// otherwise the rows left are paired by the closest kills, deaths and assists. CS
/// only breaks ties: the feed gives other players' CS in tens and counts it its own way.
fn recorded_rows(people: &[Person], recorded: &[Value]) -> Vec<Option<usize>> {
    let mut out: Vec<Option<usize>> = people
        .iter()
        .map(|p| recorded.iter().position(|r| same_name(text(r, "name"), &p.name) && (text(r, "team").is_empty() || text(r, "team") == p.side)))
        .collect();
    let mut used: HashSet<usize> = out.iter().flatten().copied().collect();
    for side in ["ORDER", "CHAOS"] {
        let left: Vec<usize> = (0..people.len()).filter(|i| out[*i].is_none() && people[*i].side == side).collect();
        let free: Vec<usize> = (0..recorded.len()).filter(|j| !used.contains(j) && text(&recorded[*j], "team") == side).collect();
        if let ([i], [j]) = (left.as_slice(), free.as_slice()) {
            out[*i] = Some(*j);
            used.insert(*j);
        }
    }
    let mut pairs: Vec<(i64, i64, usize, usize)> = Vec::new();
    for (i, p) in people.iter().enumerate().filter(|(i, _)| out[*i].is_none()) {
        for (j, r) in recorded.iter().enumerate().filter(|(j, r)| !used.contains(j) && text(r, "team") == p.side) {
            let [k, d, a, cs] = p.numbers;
            // The feed's last numbers can miss the final seconds.
            let gap = (k - num(r, "kills")).abs() + (d - num(r, "deaths")).abs() + (a - num(r, "assists")).abs();
            if gap <= 4 {
                pairs.push((gap, (cs - num(r, "cs")).abs(), i, j));
            }
        }
    }
    pairs.sort();
    for (_, _, i, j) in pairs {
        if out[i].is_none() && used.insert(j) {
            out[i] = Some(j);
        }
    }
    out
}

/// The match record and timeline boiled down to what the app shows. Works on both
/// shapes: Riot's web API (match-v5) and the League client's own.
fn normalize(raw: &Value, timeline: Option<&Value>, game: &GameRef, puuid: &str, source: &str) -> Option<Value> {
    let info = raw.get("info").unwrap_or(raw);
    let parts = info.get("participants")?.as_array()?;
    if parts.is_empty() {
        return None;
    }
    let idents: Vec<Value> = info.get("participantIdentities").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let pick_in = |ident: Option<&Value>, f: &Value, keys: &[&str]| -> String {
        keys.iter()
            .flat_map(|k| [ident.map(|i| text(i, k)).unwrap_or(""), text(f, k)])
            .find(|s| !s.is_empty())
            .unwrap_or("")
            .to_string()
    };
    let rows: Vec<(&Value, Value, Option<&Value>, String)> = parts
        .iter()
        .map(|p| {
            let f = flat(p);
            let id = num(&f, "participantId");
            let ident = idents.iter().find(|x| num(x, "participantId") == id).and_then(|x| x.get("player"));
            let name = pick_in(ident, &f, &["riotIdGameName", "gameName", "summonerName"]);
            (p, f, ident, name)
        })
        .collect();
    // The recording's own row for each player has the champion's display name.
    let people: Vec<Person> = rows
        .iter()
        .map(|(_, f, _, name)| Person {
            name: name.clone(),
            side: if num(f, "teamId") == 200 { "CHAOS" } else { "ORDER" },
            numbers: [num(f, "kills"), num(f, "deaths"), num(f, "assists"), num(f, "totalMinionsKilled") + num(f, "neutralMinionsKilled")],
        })
        .collect();
    let recorded = recorded_rows(&people, &game.players);

    let mut players: Vec<Value> = Vec::new();
    for (k, (p, f, ident, name)) in rows.iter().enumerate() {
        let (p, f, ident) = (*p, f, *ident);
        let pick = |keys: &[&str]| pick_in(ident, f, keys);
        let id = num(f, "participantId");
        let team_id = num(f, "teamId");
        let side = people[k].side;
        let rec = recorded[k].map(|j| &game.players[j]);
        let champ_name = text(f, "championName");
        let champion = rec.map(|r| text(r, "champion")).filter(|c| !c.is_empty()).unwrap_or(champ_name);
        let champion_key = rec.map(|r| text(r, "championKey")).filter(|c| !c.is_empty()).unwrap_or(champ_name);
        let position = [text(&f, "teamPosition"), rec.map(|r| text(r, "position")).unwrap_or("")]
            .into_iter()
            .find(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| position_from_lane(p));
        let spells = [
            [num(&f, "summoner1Id"), num(&f, "spell1Id")].into_iter().find(|x| *x > 0).unwrap_or(0),
            [num(&f, "summoner2Id"), num(&f, "spell2Id")].into_iter().find(|x| *x > 0).unwrap_or(0),
        ];
        players.push(json!({
            "id": id,
            "puuid": pick(&["puuid"]),
            "name": name,
            "tag": pick(&["riotIdTagline", "tagLine"]),
            "teamId": team_id,
            "team": side,
            "championId": num(&f, "championId"),
            "champion": champion,
            "championKey": champion_key,
            "position": position,
            "win": flag(&f, "win"),
            "level": num(&f, "champLevel"),
            "kills": num(&f, "kills"),
            "deaths": num(&f, "deaths"),
            "assists": num(&f, "assists"),
            "cs": num(&f, "totalMinionsKilled") + num(&f, "neutralMinionsKilled"),
            "gold": num(&f, "goldEarned"),
            "goldSpent": num(&f, "goldSpent"),
            "damage": num(&f, "totalDamageDealtToChampions"),
            "physical": num(&f, "physicalDamageDealtToChampions"),
            "magic": num(&f, "magicDamageDealtToChampions"),
            "true": num(&f, "trueDamageDealtToChampions"),
            "taken": num(&f, "totalDamageTaken"),
            "mitigated": num(&f, "damageSelfMitigated"),
            "heal": num(&f, "totalHeal"),
            "allyHeal": num(&f, "totalHealsOnTeammates"),
            "shield": num(&f, "totalDamageShieldedOnTeammates"),
            "objectives": num(&f, "damageDealtToObjectives"),
            "buildings": num(&f, "damageDealtToBuildings").max(num(&f, "damageDealtToTurrets")),
            "vision": num(&f, "visionScore"),
            "wardsPlaced": num(&f, "wardsPlaced"),
            "wardsKilled": num(&f, "wardsKilled"),
            "controlWards": num(&f, "visionWardsBoughtInGame"),
            "cc": num(&f, "timeCCingOthers"),
            "deadSecs": f.get("totalTimeSpentDead").and_then(|v| v.as_i64()),
            "largestMulti": num(&f, "largestMultiKill"),
            "firstBlood": flag(&f, "firstBloodKill"),
            "items": (0..7).map(|i| num(&f, &format!("item{i}"))).collect::<Vec<_>>(),
            "spells": spells,
            "runes": runes(&f),
            "extra": extras(&f),
        }));
    }

    // Shares of the team's kills and damage.
    let team_sum = |team: i64, k: &str| -> i64 { players.iter().filter(|p| num(p, "teamId") == team).map(|p| num(p, k)).sum() };
    let sums: HashMap<i64, (i64, i64)> = [100, 200].iter().map(|t| (*t, (team_sum(*t, "kills"), team_sum(*t, "damage")))).collect();
    let share = |part: i64, whole: i64| if whole > 0 { json!(((part as f64 / whole as f64) * 1000.0).round() / 1000.0) } else { Value::Null };
    for p in players.iter_mut() {
        let (kills, damage) = sums.get(&num(p, "teamId")).copied().unwrap_or((0, 0));
        let (kp, dmg) = (share(num(p, "kills") + num(p, "assists"), kills), share(num(p, "damage"), damage));
        p["kp"] = kp;
        p["dmgShare"] = dmg;
    }

    let me = players
        .iter()
        .find(|p| !puuid.is_empty() && text(p, "puuid") == puuid)
        .or_else(|| players.iter().find(|p| same_name(text(p, "name"), &game.me_name)))
        .or_else(|| {
            players.iter().find(|p| {
                same_name(text(p, "champion"), &game.me_champion) && (game.me_team.is_empty() || text(p, "team") == game.me_team)
            })
        })
        .map(|p| num(p, "id"));
    for p in players.iter_mut() {
        let mine = Some(num(p, "id")) == me;
        p["isMe"] = json!(mine);
    }
    let team_of: HashMap<i64, i64> = players.iter().map(|p| (num(p, "id"), num(p, "teamId"))).collect();

    // The timeline: per-minute numbers, kills, objectives and skill order.
    let frames = timeline
        .and_then(|t| t.pointer("/info/frames").or_else(|| t.get("frames")))
        .and_then(|f| f.as_array())
        .cloned()
        .unwrap_or_default();
    let ids: Vec<i64> = players.iter().map(|p| num(p, "id")).collect();
    let mut tracks: HashMap<i64, Track> = ids.iter().map(|id| (*id, Track::default())).collect();
    let mut minutes: Vec<i64> = Vec::new();
    let mut kills: Vec<Value> = Vec::new();
    let mut objectives: Vec<Value> = Vec::new();
    let mut skills: HashMap<i64, String> = HashMap::new();
    for fr in &frames {
        minutes.push((num(fr, "timestamp") as f64 / 1000.0).round() as i64);
        for id in &ids {
            let pf = fr.pointer(&format!("/participantFrames/{id}")).unwrap_or(&Value::Null);
            let t = tracks.get_mut(id).unwrap();
            let last = |v: &Vec<i64>| v.last().copied().unwrap_or(0);
            if pf.is_null() {
                let (g, x, c, l, px, py, d) = (last(&t.gold), last(&t.xp), last(&t.cs), last(&t.level), last(&t.x), last(&t.y), last(&t.damage));
                t.gold.push(g);
                t.xp.push(x);
                t.cs.push(c);
                t.level.push(l);
                t.x.push(px);
                t.y.push(py);
                t.damage.push(d);
                continue;
            }
            let (px, py) = spot(pf);
            t.gold.push(num(pf, "totalGold"));
            t.xp.push(num(pf, "xp"));
            t.cs.push(num(pf, "minionsKilled") + num(pf, "jungleMinionsKilled"));
            t.level.push(num(pf, "level"));
            t.x.push(px);
            t.y.push(py);
            match pf.pointer("/damageStats/totalDamageDoneToChampions").and_then(|v| v.as_i64()) {
                Some(d) => {
                    t.damage.push(d);
                    t.has_damage = true;
                }
                None => t.damage.push(last(&t.damage)),
            }
        }
        for e in fr.get("events").and_then(|v| v.as_array()).into_iter().flatten() {
            let (x, y) = spot(e);
            let killer = num(e, "killerId");
            match text(e, "type") {
                "CHAMPION_KILL" => {
                    let dealt = e.get("victimDamageDealt").and_then(|v| v.as_array()).map(|a| {
                        a.iter().map(|d| num(d, "physicalDamage") + num(d, "magicDamage") + num(d, "trueDamage")).sum::<i64>()
                    });
                    kills.push(json!({
                        "t": seconds(e),
                        "x": x,
                        "y": y,
                        "killer": killer,
                        "victim": num(e, "victimId"),
                        "assists": e.get("assistingParticipantIds").cloned().filter(|a| a.is_array()).unwrap_or_else(|| json!([])),
                        "bounty": num(e, "bounty"),
                        "shutdown": num(e, "shutdownBounty"),
                        "recap": recap(e.get("victimDamageReceived")),
                        "dealt": dealt,
                    }));
                }
                kind @ ("BUILDING_KILL" | "TURRET_PLATE_DESTROYED") => {
                    // These name the team that lost the building.
                    let owner = num(e, "teamId");
                    let what = if kind == "TURRET_PLATE_DESTROYED" {
                        "plate"
                    } else if text(e, "buildingType") == "INHIBITOR_BUILDING" {
                        "inhibitor"
                    } else {
                        "tower"
                    };
                    objectives.push(json!({
                        "t": seconds(e), "kind": what, "sub": text(e, "towerType"), "lane": text(e, "laneType"),
                        "by": if owner == 100 { 200 } else if owner == 200 { 100 } else { team_of.get(&killer).copied().unwrap_or(0) },
                        "killer": killer, "x": x, "y": y,
                    }));
                }
                "ELITE_MONSTER_KILL" => {
                    let what = match text(e, "monsterType") {
                        "DRAGON" => "dragon".to_string(),
                        "BARON_NASHOR" => "baron".to_string(),
                        "RIFTHERALD" => "herald".to_string(),
                        "HORDE" => "grubs".to_string(),
                        "ATAKHAN" => "atakhan".to_string(),
                        other => other.to_lowercase(),
                    };
                    let by = Some(num(e, "killerTeamId")).filter(|t| *t > 0).or_else(|| team_of.get(&killer).copied()).unwrap_or(0);
                    objectives.push(json!({
                        "t": seconds(e), "kind": what, "sub": text(e, "monsterSubType"), "lane": "",
                        "by": by, "killer": killer, "x": x, "y": y,
                    }));
                }
                "SKILL_LEVEL_UP" if text(e, "levelUpType") != "EVOLVE" => {
                    let key = match num(e, "skillSlot") {
                        1 => 'Q',
                        2 => 'W',
                        3 => 'E',
                        4 => 'R',
                        _ => continue,
                    };
                    skills.entry(num(e, "participantId")).or_default().push(key);
                }
                _ => {}
            }
        }
    }
    for p in players.iter_mut() {
        let order = skills.get(&num(p, "id")).cloned().unwrap_or_default();
        p["skills"] = json!(order);
    }

    let frames_out = (!minutes.is_empty()).then(|| {
        json!({
            "t": minutes,
            "players": ids.iter().map(|id| {
                let t = &tracks[id];
                json!({
                    "id": id, "gold": t.gold, "xp": t.xp, "cs": t.cs, "level": t.level, "x": t.x, "y": t.y,
                    "damage": if t.has_damage { json!(t.damage) } else { Value::Null },
                })
            }).collect::<Vec<_>>(),
        })
    });

    // Against the lane opponent (same position, other team), minute by minute.
    let me_row = me.and_then(|m| players.iter().find(|p| num(p, "id") == m));
    let lane = me_row.filter(|_| !minutes.is_empty()).and_then(|mine| {
        let pos = text(mine, "position");
        if pos.is_empty() {
            return None;
        }
        let opp = players.iter().find(|p| num(p, "teamId") != num(mine, "teamId") && text(p, "position") == pos)?;
        let (a, b) = (&tracks[&num(mine, "id")], &tracks[&num(opp, "id")]);
        let diff = |x: &Vec<i64>, y: &Vec<i64>| x.iter().zip(y).map(|(p, q)| p - q).collect::<Vec<_>>();
        Some(json!({ "opponent": num(opp, "id"), "gold": diff(&a.gold, &b.gold), "xp": diff(&a.xp, &b.xp), "cs": diff(&a.cs, &b.cs) }))
    });
    let team_gold = me_row.filter(|_| !minutes.is_empty()).map(|mine| {
        let my_team = num(mine, "teamId");
        (0..minutes.len())
            .map(|i| {
                ids.iter()
                    .map(|id| tracks[id].gold[i] * (if team_of.get(id) == Some(&my_team) { 1 } else { -1 }))
                    .sum::<i64>()
            })
            .collect::<Vec<_>>()
    });

    let teams: Vec<Value> = info
        .get("teams")
        .and_then(|t| t.as_array())
        .map(|ts| ts.iter().map(|t| team_row(t, sums.get(&num(t, "teamId")).map(|s| s.0).unwrap_or(0))).collect())
        .unwrap_or_default();
    let duration = {
        let d = num(info, "gameDuration");
        // Records before late 2021 gave milliseconds.
        if d > 20_000 { d / 1000 } else { d }
    };
    let platform = text(info, "platformId").to_uppercase();
    let game_id = num(info, "gameId");
    let id = raw
        .pointer("/metadata/matchId")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| match_id(&platform, game_id));
    let patch: String = text(info, "gameVersion").split('.').take(2).collect::<Vec<_>>().join(".");
    Some(json!({
        "version": VERSION,
        "source": source,
        "matchId": id,
        "gameId": game_id,
        "platform": platform,
        "queueId": num(info, "queueId"),
        "mapId": num(info, "mapId"),
        "mode": text(info, "gameMode"),
        "patch": patch,
        "duration": duration,
        "startMs": if num(info, "gameStartTimestamp") > 0 { num(info, "gameStartTimestamp") } else { num(info, "gameCreation") },
        "me": me,
        "teams": teams,
        "players": players,
        "frames": frames_out,
        "kills": kills,
        "objectives": objectives,
        "lane": lane,
        "teamGold": team_gold,
    }))
}

/// The few numbers per game that Trends charts, from a game's summary. `video_len` is
/// the recording's length in seconds, so kills after it ended get no video time.
pub fn trend_extras(pg: &Value, clock: &[(f64, f64)], video_len: f64) -> Value {
    let me = num(pg, "me");
    let players = pg.get("players").and_then(|p| p.as_array()).cloned().unwrap_or_default();
    let Some(mine) = players.iter().find(|p| num(p, "id") == me && me > 0) else { return Value::Null };
    let minutes = (num(pg, "duration") as f64 / 60.0).max(1.0);
    let champ_of = |id: i64| players.iter().find(|p| num(p, "id") == id);
    let lane_at = |key: &str, minute: usize| pg.pointer(&format!("/lane/{key}/{minute}")).and_then(|v| v.as_i64());
    let spots = |deaths: bool| -> Vec<Value> {
        pg.get("kills")
            .and_then(|k| k.as_array())
            .into_iter()
            .flatten()
            .filter(|k| if deaths { num(k, "victim") == me } else { num(k, "killer") == me })
            .map(|k| {
                let t = k.get("t").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let other = champ_of(if deaths { num(k, "killer") } else { num(k, "victim") });
                json!({
                    "x": num(k, "x"), "y": num(k, "y"), "t": t,
                    "v": video_time(clock, t).filter(|v| video_len <= 0.0 || *v < video_len),
                    "other": other.map(|p| text(p, "champion")),
                    "otherKey": other.map(|p| text(p, "championKey")),
                })
            })
            .collect()
    };
    let per_min = |v: i64| ((v as f64 / minutes) * 10.0).round() / 10.0;
    let opp = pg.pointer("/lane/opponent").and_then(|v| v.as_i64()).and_then(champ_of);
    json!({
        "mapId": num(pg, "mapId"),
        "opp": opp.map(|p| text(p, "champion")),
        "oppKey": opp.map(|p| text(p, "championKey")),
        "story": story(pg),
        "dmgShare": mine.get("dmgShare"),
        "kp": mine.get("kp"),
        "damage": num(mine, "damage"),
        "dpm": per_min(num(mine, "damage")),
        "gold": num(mine, "gold"),
        "gpm": per_min(num(mine, "gold")),
        "vision": num(mine, "vision"),
        "vpm": ((num(mine, "vision") as f64 / minutes) * 100.0).round() / 100.0,
        "taken": num(mine, "taken"),
        "gold10": lane_at("gold", 10),
        "gold15": lane_at("gold", 15),
        "xp10": lane_at("xp", 10),
        "csd10": lane_at("cs", 10),
        "csd15": lane_at("cs", 15),
        "deaths": spots(true),
        "kills": spots(false),
    })
}

/// A team gold lead that decides a game's story.
const BIG_LEAD: i64 = 3000;

/// What kind of game it was, from the team gold lead minute by minute: a "comeback"
/// (won from 3,000 gold behind) or a "throw" (lost from 3,000 ahead); a "stomp" (the
/// winners were never 1,500 behind and led by 3,000 at 15 minutes); or "close" (no
/// one led by 3,000 until the last two minutes). None for short games and the rest.
pub fn story(pg: &Value) -> Option<&'static str> {
    let me = num(pg, "me");
    let won = pg.get("players")?.as_array()?.iter().find(|p| me > 0 && num(p, "id") == me).map(|p| flag(p, "win"))?;
    let lead: Vec<i64> = pg.get("teamGold")?.as_array()?.iter().map(|v| v.as_i64().unwrap_or(0)).collect();
    let t: Vec<i64> = pg.pointer("/frames/t")?.as_array()?.iter().map(|v| v.as_i64().unwrap_or(0)).collect();
    if lead.len() < 11 || t.len() != lead.len() {
        return None;
    }
    // The winners' lead, minute by minute.
    let winners: Vec<i64> = lead.iter().map(|g| if won { *g } else { -g }).collect();
    let behind = -winners.iter().copied().min().unwrap_or(0);
    let at15 = winners.get(15).or(winners.last()).copied().unwrap_or(0);
    let last_two = num(pg, "duration") - 120;
    let close = lead.iter().zip(&t).filter(|(_, t)| **t <= last_two).all(|(g, _)| g.abs() < BIG_LEAD);
    if behind >= BIG_LEAD {
        Some(if won { "comeback" } else { "throw" })
    } else if behind < BIG_LEAD / 2 && at15 >= BIG_LEAD {
        Some("stomp")
    } else if close {
        Some("close")
    } else {
        None
    }
}

/// Stories worked out already, by recording folder, with when its record last changed.
static STORIES: Mutex<Option<HashMap<PathBuf, (SystemTime, Option<&'static str>)>>> = Mutex::new(None);

/// A recording's story (see `story`), worked out once per change of its record.
pub fn story_of(dir: &Path) -> Option<&'static str> {
    let stamp = fs::metadata(dir.join(FILE)).and_then(|m| m.modified()).ok()?;
    let mut cache = lock(&STORIES);
    let map = cache.get_or_insert_with(HashMap::new);
    if let Some((seen, s)) = map.get(dir) {
        if *seen == stamp {
            return *s;
        }
    }
    let s = load(dir).and_then(|pg| story(&pg));
    map.insert(dir.to_path_buf(), (stamp, s));
    s
}

/// Everyone's rank as read after a recent game, with who they were, for the
/// scoreboard. Null when the ranks were not read.
pub fn player_ranks(dir: &Path, pg: Option<&Value>) -> Value {
    let riot = read_json(&dir.join(RIOT_FILE)).unwrap_or(Value::Null);
    let (Some(list), Some(players)) = (riot.get("playerRanks").and_then(|v| v.as_array()), pg.and_then(|p| p.get("players")).and_then(|p| p.as_array())) else {
        return Value::Null;
    };
    let rows: Vec<Value> = list
        .iter()
        .filter_map(|r| {
            let p = players.iter().find(|p| num(p, "id") == num(r, "id"))?;
            Some(json!({
                "name": p["name"], "champion": p["champion"], "championKey": p["championKey"], "team": p["team"],
                "ranks": r.get("ranks").cloned().unwrap_or_else(|| json!([])),
            }))
        })
        .collect();
    json!({ "at": riot.get("playerRanksAt"), "players": rows })
}

// ------------------------------------------------------------------ reading for the app

/// A game's post-game summary, if it has been fetched.
pub fn load(dir: &Path) -> Option<Value> {
    read_json(&dir.join(FILE)).filter(|v| num(v, "version") == VERSION)
}

/// The LP won or lost in a game and the standing after it, plus why its match data
/// is missing if it is.
pub fn status(dir: &Path) -> (Value, Value) {
    let riot = read_json(&dir.join(RIOT_FILE)).unwrap_or(Value::Null);
    let rank = riot.get("rank").filter(|r| r.is_object()).cloned().unwrap_or(Value::Null);
    let note = riot.pointer("/fetch/note").filter(|n| n.is_string()).cloned().unwrap_or(Value::Null);
    (rank, note)
}

// ------------------------------------------------------------------ at game start

/// Note who is playing and their rank while the game loads. Runs once per recording
/// on its own thread, with a handful of reads from the client.
pub fn at_game_start(settings: &Settings, dir: &Path, game_id: Option<i64>) {
    let Some(lcu) = Lcu::connect(settings) else { return };
    let Some(acct) = lcu.account() else { return };
    let ranks = lcu.ranks();
    let _busy = lock(&BUSY);
    let path = dir.join(RIOT_FILE);
    let mut riot = read_json(&path).filter(|r| r.is_object()).unwrap_or_else(|| json!({}));
    riot["version"] = json!(1);
    for (k, v) in acct.to_json().as_object().into_iter().flatten() {
        riot[k] = v.clone();
    }
    if let Some(id) = game_id {
        riot["gameId"] = json!(id);
    }
    riot["rankBefore"] = json!(ranks);
    riot["rankBeforeAt"] = json!(now_ms());
    if let Err(e) = write_json(&path, &riot) {
        log(format!("[riot] could not note the game start: {e}"));
        return;
    }
    remember_account(&acct);
    // The rank now is also the rank after this account's previous game.
    if let (Some(ranks), Some(root)) = (&ranks, dir.parent()) {
        if let Some(prev) = previous_game(root, dir, &acct.puuid) {
            let p = prev.join(RIOT_FILE);
            if let Some(mut pr) = read_json(&p).filter(|r| r.is_object()) {
                if pr.get("rankAfter").is_none_or(|r| r.is_null()) && !flag(&pr, "rankChecked") {
                    pr["rankAfter"] = json!(ranks);
                    pr["rankAfterAt"] = json!(now_ms());
                    let _ = write_json(&p, &pr);
                }
            }
        }
    }
}

/// The latest earlier recording of the same account.
fn previous_game(root: &Path, dir: &Path, puuid: &str) -> Option<PathBuf> {
    let name = dir_id(dir);
    let mut best: Option<(String, PathBuf)> = None;
    for e in fs::read_dir(root).ok()?.flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if n >= name || best.as_ref().is_some_and(|(b, _)| *b >= n) {
            continue;
        }
        let p = e.path();
        if read_json(&p.join(RIOT_FILE)).is_some_and(|r| text(&r, "puuid") == puuid) {
            best = Some((n, p));
        }
    }
    best.map(|(_, p)| p)
}

// ------------------------------------------------------------------ fetching

struct Fetched {
    raw: Value,
    timeline: Option<Value>,
    source: &'static str,
    game_id: i64,
    platform: String,
}

/// Why a game's match data did not come.
enum Miss {
    /// Nothing to ask right now (client closed, no key). Not counted as a try.
    Wait(String),
    /// Asked, not there (yet).
    Retry(String),
    /// There will never be any.
    Never(String),
    KeyRefused,
}

fn fetch_game(game: &GameRef, riot: &Value, who: &Account, client: Option<(&Lcu, &Account)>, web: Option<&Web>, web_only: bool) -> Result<Fetched, Miss> {
    if game.game_mode == "PRACTICETOOL" {
        return Err(Miss::Never("Riot keeps no record of Practice Tool games.".into()));
    }
    let mut game_id = riot.get("gameId").and_then(|v| v.as_i64()).filter(|g| *g > 0).or(game.game_id);
    let platform = [text(riot, "platform"), who.platform.as_str(), client.map(|c| c.1.platform.as_str()).unwrap_or("")]
        .into_iter()
        .find(|p| !p.is_empty())
        .map(|p| p.to_uppercase());
    let mut why = String::new();

    // The web API first when there is a key: its record is the fuller one.
    if let (Some(web), Some(platform)) = (web, platform.as_deref()) {
        if game_id.is_none() && !who.puuid.is_empty() {
            match web.find_game(platform, &who.puuid, game.started_ms)? {
                Some((gid, raw)) => {
                    let timeline = match web.timeline(platform, &match_id(platform, gid)) {
                        Got::Data(t) => Some(t),
                        Got::KeyRefused => return Err(Miss::KeyRefused),
                        _ => None,
                    };
                    return Ok(Fetched { raw, timeline, source: "riot", game_id: gid, platform: platform.into() });
                }
                None => why = "Riot lists no game of yours at that time.".into(),
            }
        }
        if let Some(gid) = game_id {
            let id = match_id(platform, gid);
            match web.game(platform, &id) {
                Got::Data(raw) => {
                    let timeline = match web.timeline(platform, &id) {
                        Got::Data(t) => Some(t),
                        Got::KeyRefused => return Err(Miss::KeyRefused),
                        _ => None,
                    };
                    return Ok(Fetched { raw, timeline, source: "riot", game_id: gid, platform: platform.into() });
                }
                Got::Missing => why = "Riot has not published this game yet.".into(),
                Got::KeyRefused => return Err(Miss::KeyRefused),
                Got::Failed(e) => why = e,
            }
        }
    }
    if web_only {
        return Err(Miss::Retry(if why.is_empty() { "The game's region is not known.".into() } else { why }));
    }

    if let Some((lcu, acct)) = client {
        let elsewhere = matches!(platform.as_deref(), Some(p) if !acct.platform.is_empty() && !p.eq_ignore_ascii_case(&acct.platform));
        if elsewhere {
            if why.is_empty() {
                why = "This game was played on another region than the League client is on now.".into();
            }
        } else {
            if game_id.is_none() {
                game_id = find_in_client(&lcu.recent_games(), game);
            }
            match game_id {
                Some(gid) => {
                    if let Some(raw) = lcu.game(gid) {
                        let timeline = lcu.timeline(gid);
                        let platform = Some(text(&raw, "platformId").to_uppercase())
                            .filter(|p| !p.is_empty())
                            .unwrap_or_else(|| acct.platform.clone());
                        return Ok(Fetched { raw, timeline, source: "client", game_id: gid, platform });
                    }
                    why = "The League client has no record of this game yet.".into();
                }
                None => {
                    let msg = "This game is not in the League client's match history.".to_string();
                    let old = now_ms() - game.started_ms > 3 * 24 * 3600 * 1000;
                    return Err(if old && web.is_none() { Miss::Never(msg) } else { Miss::Retry(msg) });
                }
            }
        }
    }
    if !why.is_empty() {
        return Err(Miss::Retry(why));
    }
    Err(Miss::Wait("Waiting for the League client to be open, or for a Riot API key in Settings.".into()))
}

fn fetch_state(riot: &mut Value) -> &mut Map<String, Value> {
    if !riot.is_object() {
        *riot = json!({});
    }
    let f = riot.as_object_mut().unwrap().entry("fetch").or_insert_with(|| json!({}));
    if !f.is_object() {
        *f = json!({});
    }
    f.as_object_mut().unwrap()
}

/// Write the raw answers and the summary, and note who played and where.
fn save_fetched(dir: &Path, game: &GameRef, riot: &mut Value, who: &Account, f: Fetched) -> Result<Value> {
    let puuid = [text(riot, "puuid"), who.puuid.as_str()].into_iter().find(|p| !p.is_empty()).unwrap_or("").to_string();
    let pg = normalize(&f.raw, f.timeline.as_ref(), game, &puuid, f.source)
        .ok_or_else(|| anyhow!("Riot's record of this game could not be read"))?;
    write_json(&dir.join(RAW_MATCH), &f.raw)?;
    match &f.timeline {
        Some(t) => write_json(&dir.join(RAW_TIMELINE), t)?,
        None => {
            let _ = fs::remove_file(dir.join(RAW_TIMELINE));
        }
    }
    write_json(&dir.join(FILE), &pg)?;
    if text(riot, "puuid").is_empty() {
        if let Some(me) = pg.get("players").and_then(|p| p.as_array()).and_then(|ps| ps.iter().find(|p| flag(p, "isMe"))) {
            if !text(me, "puuid").is_empty() {
                riot["puuid"] = me["puuid"].clone();
                riot["gameName"] = me["name"].clone();
                riot["tagLine"] = me["tag"].clone();
            }
        }
    }
    riot["version"] = json!(1);
    riot["gameId"] = json!(f.game_id);
    if !f.platform.is_empty() {
        riot["platform"] = json!(f.platform);
    }
    let state = fetch_state(riot);
    state.insert("source".into(), json!(f.source));
    state.insert("at".into(), json!(now_ms()));
    state.remove("note");
    write_json(&dir.join(RIOT_FILE), riot)?;
    Ok(pg)
}

/// Note a failed attempt. Returns the reason, for the player.
fn record_miss(riot: &mut Value, miss: Miss, key: &str, upgrade: bool) -> String {
    let state = fetch_state(riot);
    let note = match miss {
        Miss::Wait(m) => m,
        Miss::Retry(m) => {
            let tries = state.get("tries").and_then(|v| v.as_i64()).unwrap_or(0) + 1;
            state.insert("tries".into(), json!(tries));
            state.insert("last".into(), json!(now_ms()));
            if upgrade {
                state.insert("upgradeTried".into(), json!(true));
            } else if tries >= MAX_TRIES {
                state.insert("gaveUp".into(), json!(true));
            }
            m
        }
        Miss::Never(m) => {
            state.insert("gaveUp".into(), json!(true));
            m
        }
        Miss::KeyRefused => {
            *lock(&REJECTED_KEY) = Some(key.trim().to_string());
            "Riot refused the API key in Settings. A development key stops working 24 hours after it was made.".to_string()
        }
    };
    if !upgrade {
        state.insert("note".into(), json!(note));
    }
    note
}

/// When a game's match data is next worth asking for.
fn due(fetch: &Value, game: &GameRef, now: i64) -> bool {
    const MINUTES: [i64; 8] = [0, 2, 5, 15, 60, 240, 720, 1440];
    if flag(fetch, "gaveUp") {
        return false;
    }
    let tries = num(fetch, "tries").clamp(0, 7) as usize;
    // Riot needs a minute or two after the game to publish it.
    now >= game.ended_ms + 90_000 && now >= num(fetch, "last") + MINUTES[tries] * 60_000
}

/// Fetch one game's match data now, whatever the schedule says.
pub fn fetch_now(settings: &Settings, dir: &Path) -> Result<Value> {
    let game = game_ref(dir).ok_or_else(|| anyhow!("This recording has no game to look up."))?;
    if !settings.use_client_api && settings.riot_api_key.trim().is_empty() {
        return Err(anyhow!("Rewatch gets this from the League client or with a Riot API key, and both are off in Settings."));
    }
    let _busy = lock(&BUSY);
    let mut riot = read_json(&dir.join(RIOT_FILE)).filter(|r| r.is_object()).unwrap_or_else(|| json!({}));
    let web = usable_web(settings);
    let lcu = Lcu::connect(settings);
    let acct = lcu.as_ref().and_then(|l| l.account());
    if let Some(a) = &acct {
        remember_account(a);
    }
    let who = who_played(&riot, &game, acct.as_ref());
    match fetch_game(&game, &riot, &who, lcu.as_ref().zip(acct.as_ref()), web.as_ref(), false) {
        Ok(f) => {
            let source = f.source;
            let pg = save_fetched(dir, &game, &mut riot, &who, f)?;
            log(format!("[riot] {}: match data saved from {}", dir_id(dir), if source == "riot" { "Riot" } else { "the League client" }));
            Ok(pg)
        }
        Err(miss) => {
            let note = record_miss(&mut riot, miss, &settings.riot_api_key, false);
            let _ = write_json(&dir.join(RIOT_FILE), &riot);
            Err(anyhow!(note))
        }
    }
}

// ------------------------------------------------------------------ the background job

/// One round of background work. Ranks first (they must be read before the next game
/// starts), then the match data of a few games, newest first. Returns the recordings
/// that got something new.
pub fn work(settings: &Settings, stop: &dyn Fn() -> bool) -> Vec<String> {
    let Some(root) = settings.recordings_path() else { return Vec::new() };
    let _busy = lock(&BUSY);
    let mut web = usable_web(settings);
    let lcu = Lcu::connect(settings);
    let now = now_ms();
    let mut changed = Vec::new();

    let mut dirs: Vec<(String, PathBuf, Value)> = match fs::read_dir(&root) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| {
                let p = e.path();
                let riot = read_json(&p.join(RIOT_FILE)).filter(|r| r.is_object()).unwrap_or_else(|| json!({}));
                (e.file_name().to_string_lossy().to_string(), p, riot)
            })
            .collect(),
        Err(_) => return changed,
    };
    dirs.sort_by(|a, b| a.0.cmp(&b.0));

    // Which recordings still want something, cheapest checks first.
    let mut fetches: Vec<(PathBuf, GameRef, bool)> = Vec::new();
    {
        let mut settled = lock(&SETTLED);
        if settled.as_ref().is_none_or(|(w, _)| *w != web.is_some()) {
            *settled = Some((web.is_some(), HashSet::new()));
        }
        let set = &mut settled.as_mut().unwrap().1;
        for (id, dir, riot) in &dirs {
            if set.contains(dir) {
                continue;
            }
            let Some(game) = game_ref(dir) else {
                // A manual recording or one without the player: nothing to fetch. One
                // still being recorded has no match.json yet.
                if dir.join("match.json").exists() {
                    set.insert(dir.clone());
                }
                continue;
            };
            let fetch = riot.get("fetch").cloned().unwrap_or(Value::Null);
            match read_json(&dir.join(FILE)) {
                Some(pg) if num(&pg, "version") < VERSION => {
                    // Summarize again from the raw files.
                    let raw = read_json(&dir.join(RAW_MATCH));
                    let made = raw.and_then(|raw| {
                        let tl = read_json(&dir.join(RAW_TIMELINE));
                        let source = if text(&pg, "source") == "riot" { "riot" } else { "client" };
                        normalize(&raw, tl.as_ref(), &game, text(riot, "puuid"), source)
                    });
                    match made {
                        Some(new) if write_json(&dir.join(FILE), &new).is_ok() => changed.push(id.clone()),
                        _ => {
                            let _ = fs::remove_file(dir.join(FILE));
                        }
                    }
                }
                Some(pg) => {
                    if text(&pg, "source") == "client" && web.is_some() && !flag(&fetch, "upgradeTried") {
                        if due(&fetch, &game, now) {
                            fetches.push((dir.clone(), game, true));
                        }
                    } else {
                        set.insert(dir.clone());
                    }
                }
                None if flag(&fetch, "gaveUp") => {
                    set.insert(dir.clone());
                }
                None => {
                    if due(&fetch, &game, now) {
                        fetches.push((dir.clone(), game, false));
                    }
                }
            }
        }
    }
    let rank_wanted = dirs.iter().any(|(_, _, r)| !text(r, "puuid").is_empty() && !flag(r, "rankChecked"));
    let players_wanted = dirs
        .iter()
        .any(|(_, dir, r)| players_due(dir, r, now) && (dir.join(FILE).exists() || fetches.iter().any(|f| &f.0 == dir)));
    if (fetches.is_empty() && !rank_wanted && !players_wanted) || (lcu.is_none() && web.is_none()) || stop() {
        return changed;
    }

    let acct = lcu.as_ref().and_then(|l| l.account());
    if let Some(a) = &acct {
        remember_account(a);
    }
    if rank_wanted {
        changed.extend(rank_pass(&mut dirs, lcu.as_ref(), acct.as_ref(), web.as_ref(), stop));
    }

    // New games first, then improving games read from the client.
    fetches.sort_by(|a, b| a.2.cmp(&b.2).then(b.0.cmp(&a.0)));
    let client = lcu.as_ref().zip(acct.as_ref());
    for (dir, game, upgrade) in fetches.into_iter().take(PER_ROUND) {
        if stop() {
            break;
        }
        if client.is_none() && web.is_none() {
            break;
        }
        let riot_path = dir.join(RIOT_FILE);
        let mut riot = read_json(&riot_path).filter(|r| r.is_object()).unwrap_or_else(|| json!({}));
        let who = who_played(&riot, &game, acct.as_ref());
        match fetch_game(&game, &riot, &who, client, web.as_ref(), upgrade) {
            Ok(f) => {
                let source = f.source;
                match save_fetched(&dir, &game, &mut riot, &who, f) {
                    Ok(_) => {
                        log(format!("[riot] {}: match data saved from {}", dir_id(&dir), if source == "riot" { "Riot" } else { "the League client" }));
                        changed.push(dir_id(&dir));
                    }
                    Err(e) => log(format!("[riot] {}: {e}", dir_id(&dir))),
                }
            }
            Err(miss) => {
                let refused = matches!(miss, Miss::KeyRefused);
                let note = record_miss(&mut riot, miss, &settings.riot_api_key, upgrade);
                let _ = write_json(&riot_path, &riot);
                if refused {
                    log("[riot] Riot refused the API key");
                    web = None;
                } else {
                    log(format!("[riot] {}: {note}", dir_id(&dir)));
                }
            }
        }
    }
    // Everyone's rank last: it needs the record, which may have come just now.
    if players_wanted && !stop() {
        changed.extend(players_pass(&dirs, lcu.as_ref(), acct.as_ref(), web.as_ref(), stop));
    }
    changed.sort();
    changed.dedup();
    changed
}

/// Work out the LP each recent game won or lost. `dirs` is every recording, oldest
/// first, with its riot.json.
fn rank_pass(dirs: &mut [(String, PathBuf, Value)], lcu: Option<&Lcu>, acct: Option<&Account>, web: Option<&Web>, stop: &dyn Fn() -> bool) -> Vec<String> {
    let mut changed = Vec::new();
    let now = now_ms();
    for i in 0..dirs.len() {
        if stop() {
            break;
        }
        let riot = &dirs[i].2;
        let puuid = text(riot, "puuid").to_string();
        if puuid.is_empty() || flag(riot, "rankChecked") {
            continue;
        }
        let dir = dirs[i].1.clone();
        // Still being recorded, or not a game.
        let Some(game) = game_ref(&dir) else { continue };
        let mut riot = riot.clone();
        let queue_id = game.queue_id.or_else(|| load(&dir).map(|pg| num(&pg, "queueId")).filter(|q| *q > 0));
        let queue = ranked_queue(queue_id, &game.queue_name);
        let prev = dirs[..i].iter().rev().find(|d| text(&d.2, "puuid") == puuid).map(|d| d.2.clone());
        let latest = !dirs[i + 1..].iter().any(|d| text(&d.2, "puuid") == puuid);
        let as_list = |v: Option<&Value>| v.and_then(|x| x.as_array()).cloned();
        let before = as_list(riot.get("rankBefore")).or_else(|| prev.as_ref().and_then(|p| as_list(p.get("rankAfter"))));
        let mut after = as_list(riot.get("rankAfter"));

        if queue != Ranked::No && after.is_none() {
            if !latest {
                // The next game's start would have noted it; it did not.
                riot["rankChecked"] = json!(true);
                let _ = write_json(&dir.join(RIOT_FILE), &riot);
                dirs[i].2 = riot;
                continue;
            }
            if now < game.ended_ms + 60_000 {
                continue;
            }
            if now - game.ended_ms > 6 * 3600 * 1000 {
                // Too long ago for today's rank to say anything about this game.
                riot["rankChecked"] = json!(true);
                let _ = write_json(&dir.join(RIOT_FILE), &riot);
                dirs[i].2 = riot;
                continue;
            }
            let from_client = acct.filter(|a| a.puuid == puuid).and(lcu).and_then(|l| l.ranks());
            let platform = text(&riot, "platform").to_string();
            let live = from_client.or_else(|| web.filter(|_| !platform.is_empty()).and_then(|w| w.ranks(&platform, &puuid)));
            let Some(live) = live else { continue };
            let waited = now - game.ended_ms;
            let take = match before.as_deref().map(|b| games_added(b, &live, queue)) {
                // Not updated yet; Riot takes a little while after the game.
                Some(0) => waited > 20 * 60_000,
                Some(_) => true,
                None => waited > 3 * 60_000,
            };
            if !take {
                continue;
            }
            riot["rankAfter"] = json!(live);
            riot["rankAfterAt"] = json!(now);
            after = Some(live);
        }
        if queue != Ranked::No {
            if let Some(after) = &after {
                riot["rank"] = rank_change(before.as_deref(), after, queue).unwrap_or(Value::Null);
            }
        }
        riot["rankChecked"] = json!(true);
        if write_json(&dir.join(RIOT_FILE), &riot).is_ok() && riot.get("rank").is_some_and(|r| r.is_object()) {
            changed.push(dirs[i].0.clone());
        }
        dirs[i].2 = riot;
    }
    changed
}

/// How long after a game everyone's rank still says something about it.
const PLAYERS_WINDOW_MS: i64 = 6 * 3600 * 1000;

/// Whether a recording still wants everyone's rank read: once, for a game that ended
/// in the last six hours. An older game would get today's ranks.
fn players_due(dir: &Path, riot: &Value, now: i64) -> bool {
    if flag(riot, "playersChecked") || num(riot, "playersTries") >= 3 {
        return false;
    }
    let Some(game) = game_ref(dir) else { return false };
    now >= game.ended_ms + 60_000 && now - game.ended_ms < PLAYERS_WINDOW_MS
}

/// Whether a Riot id is one the League client gives out (a UUID), rather than one of
/// the web API's, which are encrypted for each key.
fn client_id(puuid: &str) -> bool {
    puuid.len() == 36 && puuid.chars().all(|c| c.is_ascii_hexdigit() || c == '-') && puuid.matches('-').count() == 4
}

/// The two ranked queues of Summoner's Rift, where the player is ranked.
fn rift_ranks(list: Vec<Value>) -> Vec<Value> {
    list.into_iter()
        .filter(|e| !text(e, "tier").is_empty() && matches!(text(e, "queue"), "RANKED_SOLO_5x5" | "RANKED_FLEX_SR"))
        .collect()
}

/// Read the rank of all ten players of recent games, newest first, for the
/// scoreboard. Each player's Riot id comes from the game's record.
fn players_pass(dirs: &[(String, PathBuf, Value)], lcu: Option<&Lcu>, acct: Option<&Account>, web: Option<&Web>, stop: &dyn Fn() -> bool) -> Vec<String> {
    let mut changed = Vec::new();
    let now = now_ms();
    // Requests to the client so far in this pass, across games, for the pacing.
    let mut asked = 0;
    for (id, dir, _) in dirs.iter().rev() {
        if stop() {
            break;
        }
        // Read again: fetching may have written it since.
        let path = dir.join(RIOT_FILE);
        let mut riot = read_json(&path).filter(|r| r.is_object()).unwrap_or_else(|| json!({}));
        if !players_due(dir, &riot, now) {
            continue;
        }
        let Some(pg) = load(dir) else { continue };
        let platform = [text(&riot, "platform"), text(&pg, "platform")]
            .into_iter()
            .find(|p| !p.is_empty())
            .unwrap_or("")
            .to_uppercase();
        let client = lcu.filter(|_| acct.is_some_and(|a| platform.is_empty() || a.platform.is_empty() || a.platform.eq_ignore_ascii_case(&platform)));
        let mut found = Vec::new();
        for p in pg.get("players").and_then(|p| p.as_array()).into_iter().flatten() {
            if stop() {
                return changed;
            }
            let puuid = text(p, "puuid");
            // The client's own ids are UUIDs; the web API's are encrypted for the key
            // and only the web API reads them. The client answers any other id with an
            // empty, unranked-looking standing.
            let ranks = if client_id(puuid) {
                client.and_then(|l| {
                    // The client turns away quick runs of these.
                    if asked > 0 {
                        std::thread::sleep(Duration::from_millis(1200));
                    }
                    asked += 1;
                    l.ranks_of(puuid)
                })
            } else if !puuid.is_empty() && !platform.is_empty() {
                web.and_then(|w| w.ranks(&platform, puuid))
            } else {
                None
            };
            if let Some(r) = ranks {
                found.push(json!({ "id": num(p, "id"), "ranks": rift_ranks(r) }));
            }
        }
        // Nobody ranked at all is more likely a failed read than ten unranked players.
        if found.iter().all(|f| f["ranks"].as_array().is_none_or(|r| r.is_empty())) {
            riot["playersTries"] = json!(num(&riot, "playersTries") + 1);
            let _ = write_json(&path, &riot);
            continue;
        }
        riot["playerRanks"] = json!(found);
        riot["playerRanksAt"] = json!(now);
        riot["playersChecked"] = json!(true);
        if write_json(&path, &riot).is_ok() && !found.is_empty() {
            log(format!("[riot] {id}: read the rank of {} players", found.len()));
            changed.push(id.clone());
        }
    }
    changed
}

/// For `--riot-probe`: what the League client says about the logged-in account.
pub fn probe(settings: &Settings) -> Value {
    let Some(lcu) = Lcu::connect(settings) else { return json!({ "client": false }) };
    let acct = lcu.account();
    json!({
        "client": true,
        "account": acct.as_ref().map(Account::to_json),
        "ranks": lcu.ranks(),
        // The same, the way other players' ranks are read.
        "ranksByPuuid": acct.as_ref().and_then(|a| lcu.ranks_of(&a.puuid)),
        "recent": lcu.recent_games().iter().take(5).map(|g| json!({ "gameId": g["gameId"], "gameCreation": g["gameCreation"], "queueId": g["queueId"] })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn standing(queue: &str, tier: &str, division: &str, lp: i64, wins: i64, losses: i64) -> Value {
        rank_entry(&json!({ "queueType": queue, "tier": tier, "division": division, "leaguePoints": lp, "wins": wins, "losses": losses })).unwrap()
    }

    #[test]
    fn lp_change_counts_across_a_promotion() {
        let before = vec![standing("RANKED_SOLO_5x5", "GOLD", "I", 90, 10, 8)];
        let after = vec![standing("RANKED_SOLO_5x5", "PLATINUM", "IV", 15, 11, 8)];
        let r = rank_change(Some(&before), &after, Ranked::Queue("RANKED_SOLO_5x5")).unwrap();
        assert_eq!(r["delta"], 25);
        assert_eq!(r["won"], true);
        assert_eq!(r["before"]["tier"], "GOLD");
        assert_eq!(r["tier"], "PLATINUM");
    }

    #[test]
    fn a_loss_and_a_gap_of_two_games() {
        let before = vec![standing("RANKED_FLEX_SR", "EMERALD", "III", 40, 3, 2)];
        let lost = vec![standing("RANKED_FLEX_SR", "EMERALD", "III", 22, 3, 3)];
        let r = rank_change(Some(&before), &lost, Ranked::Queue("RANKED_FLEX_SR")).unwrap();
        assert_eq!(r["delta"], -18);
        assert_eq!(r["won"], false);
        // Two games in between: neither the LP nor the standing belongs to this game.
        let later = vec![standing("RANKED_FLEX_SR", "EMERALD", "III", 60, 4, 3)];
        assert!(rank_change(Some(&before), &later, Ranked::Queue("RANKED_FLEX_SR")).is_none());
        // No snapshot before: standing only.
        let r = rank_change(None, &lost, Ranked::Queue("RANKED_FLEX_SR")).unwrap();
        assert!(r["delta"].is_null() && r["before"].is_null());
    }

    #[test]
    fn an_unknown_ranked_queue_is_the_one_that_changed() {
        let before = vec![standing("RANKED_SOLO_5x5", "GOLD", "II", 50, 10, 10), standing("RANKED_TEAM_5x5", "SILVER", "I", 70, 1, 1)];
        let after = vec![standing("RANKED_SOLO_5x5", "GOLD", "II", 50, 10, 10), standing("RANKED_TEAM_5x5", "GOLD", "IV", 0, 2, 1)];
        assert_eq!(games_added(&before, &after, Ranked::Unknown), 1);
        let r = rank_change(Some(&before), &after, Ranked::Unknown).unwrap();
        assert_eq!(r["queue"], "RANKED_TEAM_5x5");
        assert_eq!(r["delta"], 30);
        // Two queues changed: no telling which game it was.
        let both = vec![standing("RANKED_SOLO_5x5", "GOLD", "II", 70, 11, 10), standing("RANKED_TEAM_5x5", "GOLD", "IV", 0, 2, 1)];
        assert_eq!(games_added(&before, &both, Ranked::Unknown), 2);
        assert!(rank_change(Some(&before), &both, Ranked::Unknown).is_none());
    }

    #[test]
    fn web_and_client_standings_read_alike() {
        let web = rank_entry(&json!({ "queueType": "RANKED_FLEX_SR", "tier": "EMERALD", "rank": "III", "leaguePoints": 40, "wins": 3, "losses": 2 })).unwrap();
        assert_eq!(web["division"], "III");
        assert_eq!(web["ladder"], 5 * 400 + 100 + 40);
        let unranked = rank_entry(&json!({ "queueType": "RANKED_SOLO_5x5", "tier": "NONE", "division": "NA", "leaguePoints": 0, "isProvisional": true })).unwrap();
        assert_eq!(unranked["tier"], "");
        assert!(unranked["ladder"].is_null());
        assert_eq!(ladder("GRANDMASTER", "", 350), Some(2800 + 350));
        assert_eq!(ladder("MASTER", "I", 0), Some(2800));
    }

    #[test]
    fn queues_and_regions() {
        assert_eq!(ranked_queue(Some(420), "Ranked Solo/Duo"), Ranked::Queue("RANKED_SOLO_5x5"));
        assert_eq!(ranked_queue(Some(710), "Ranked 5s"), Ranked::Unknown);
        assert_eq!(ranked_queue(Some(450), "ARAM"), Ranked::No);
        assert_eq!(platform_for_region("EUNE"), Some("EUN1"));
        assert_eq!(platform_for_region("las"), Some("LA2"));
        assert_eq!(regional_host("KR"), "asia");
        assert_eq!(regional_host("OC1"), "sea");
        assert_eq!(regional_host("EUW1"), "europe");
        assert_eq!(match_url("NA1", "matches/NA1_5"), "https://americas.api.riotgames.com/lol/match/v5/matches/NA1_5");
    }

    #[test]
    fn video_time_inverts_the_game_clock() {
        let clock = vec![(10.0, 0.0), (70.0, 60.0), (135.0, 120.0)];
        assert_eq!(video_time(&clock, 30.0), Some(40.0));
        assert_eq!(video_time(&clock, 125.0), Some(140.0));
        assert_eq!(video_time(&[], 30.0), None);
    }

    fn recording() -> GameRef {
        GameRef {
            started_ms: 1_000_000,
            ended_ms: 2_000_000,
            game_id: Some(42),
            me_name: "Rin".into(),
            me_champion: "Ahri".into(),
            me_team: "ORDER".into(),
            players: vec![
                json!({ "name": "Rin", "team": "ORDER", "champion": "Ahri", "championKey": "Ahri", "position": "MIDDLE" }),
                json!({ "name": "Zedd", "team": "CHAOS", "champion": "Zed", "championKey": "Zed", "position": "MIDDLE" }),
                json!({ "name": "Jun", "team": "ORDER", "champion": "Lee Sin", "championKey": "LeeSin", "position": "JUNGLE" }),
                json!({ "name": "Kay", "team": "CHAOS", "champion": "K'Sante", "championKey": "KSante", "position": "TOP" }),
            ],
            ..Default::default()
        }
    }

    fn frame(ts: i64, gold: [i64; 4], events: Value) -> Value {
        let pf: Map<String, Value> = (1..=4)
            .map(|i| {
                (i.to_string(), json!({
                    "participantId": i, "totalGold": gold[i - 1], "xp": gold[i - 1] / 2, "minionsKilled": ts / 6000, "jungleMinionsKilled": 0,
                    "level": 1 + ts / 60000, "position": { "x": 100 * i as i64, "y": 200 },
                    "damageStats": { "totalDamageDoneToChampions": ts / 100 },
                }))
            })
            .collect();
        json!({ "timestamp": ts, "participantFrames": pf, "events": events })
    }

    fn web_match() -> (Value, Value) {
        let part = |id: i64, puuid: &str, name: &str, champ: &str, team: i64, pos: &str, k: i64, d: i64, a: i64, dmg: i64| {
            json!({
                "participantId": id, "puuid": puuid, "riotIdGameName": name, "riotIdTagline": "EUW", "championId": id * 10,
                "championName": champ, "teamId": team, "teamPosition": pos, "win": team == 100,
                "kills": k, "deaths": d, "assists": a, "totalMinionsKilled": 150, "neutralMinionsKilled": 4,
                "goldEarned": 9000, "totalDamageDealtToChampions": dmg, "visionScore": 20, "champLevel": 14,
                "summoner1Id": 4, "summoner2Id": 14, "item0": 3089,
                "perks": { "statPerks": { "offense": 5008, "flex": 5008, "defense": 5001 },
                           "styles": [ { "style": 8100, "selections": [ { "perk": 8112 }, { "perk": 8139 } ] }, { "style": 8200, "selections": [ { "perk": 8210 } ] } ] },
                "challenges": { "soloKills": 2, "turretPlatesTaken": 1, "jungleCsBefore10Minutes": 0.0, "laneMinionsFirst10Minutes": 70 },
                "allInPings": 3, "onMyWayPings": 2,
            })
        };
        let raw = json!({
            "metadata": { "matchId": "EUW1_42" },
            "info": {
                "gameId": 42, "platformId": "EUW1", "queueId": 420, "mapId": 11, "gameMode": "CLASSIC", "gameVersion": "15.20.712.3456",
                "gameDuration": 1500, "gameEndTimestamp": 5, "gameStartTimestamp": 1_000_500,
                "participants": [
                    part(1, "p-rin", "Rin", "Ahri", 100, "MIDDLE", 5, 1, 2, 20000),
                    part(2, "p-zed", "Zedd", "Zed", 200, "MIDDLE", 1, 5, 0, 15000),
                    part(3, "p-jun", "Jun", "LeeSin", 100, "JUNGLE", 2, 0, 6, 5000),
                    part(4, "p-kay", "Kay", "KSante", 200, "TOP", 0, 2, 1, 5000),
                ],
                "teams": [
                    { "teamId": 100, "win": true, "bans": [ { "championId": 55, "pickTurn": 1 } ], "objectives": { "tower": { "kills": 7 }, "dragon": { "kills": 3 }, "baron": { "kills": 1 }, "horde": { "kills": 3 } } },
                    { "teamId": 200, "win": false, "bans": [], "objectives": { "tower": { "kills": 1 } } },
                ],
            }
        });
        let kill = json!({
            "type": "CHAMPION_KILL", "timestamp": 61500, "killerId": 2, "victimId": 1, "assistingParticipantIds": [4],
            "position": { "x": 7000, "y": 7100 }, "bounty": 300, "shutdownBounty": 0,
            "victimDamageReceived": [
                { "participantId": 2, "name": "Zed", "type": "CHAMPION", "basic": false, "spellSlot": 3, "physicalDamage": 400, "magicDamage": 0, "trueDamage": 0 },
                { "participantId": 2, "name": "Zed", "type": "CHAMPION", "basic": true, "spellSlot": 0, "physicalDamage": 100, "magicDamage": 0, "trueDamage": 0 },
                { "participantId": 0, "name": "Turret_T2_C_05_A", "type": "TOWER", "basic": true, "spellSlot": 0, "physicalDamage": 0, "magicDamage": 0, "trueDamage": 0 },
                { "participantId": 4, "name": "KSante", "type": "CHAMPION", "basic": false, "spellSlot": 0, "physicalDamage": 150, "magicDamage": 0, "trueDamage": 20 },
            ],
            "victimDamageDealt": [ { "participantId": 2, "physicalDamage": 0, "magicDamage": 250, "trueDamage": 0 } ],
        });
        let events = json!([
            kill,
            { "type": "SKILL_LEVEL_UP", "timestamp": 1000, "participantId": 1, "skillSlot": 1, "levelUpType": "NORMAL" },
            { "type": "SKILL_LEVEL_UP", "timestamp": 2000, "participantId": 1, "skillSlot": 3, "levelUpType": "NORMAL" },
            { "type": "SKILL_LEVEL_UP", "timestamp": 2500, "participantId": 1, "skillSlot": 4, "levelUpType": "EVOLVE" },
            { "type": "BUILDING_KILL", "timestamp": 90000, "killerId": 3, "teamId": 200, "buildingType": "TOWER_BUILDING", "towerType": "OUTER_TURRET", "laneType": "MID_LANE", "position": { "x": 8955, "y": 8510 } },
            { "type": "ELITE_MONSTER_KILL", "timestamp": 95000, "killerId": 3, "killerTeamId": 100, "monsterType": "DRAGON", "monsterSubType": "FIRE_DRAGON", "position": { "x": 9866, "y": 4414 } },
        ]);
        let tl = json!({ "info": { "frames": [
            frame(0, [500, 500, 500, 500], json!([])),
            frame(60000, [1500, 1200, 1300, 1400], events),
            frame(120000, [2600, 2000, 2400, 2500], json!([])),
        ] } });
        (raw, tl)
    }

    #[test]
    fn a_web_record_is_summarized() {
        let (raw, tl) = web_match();
        let pg = normalize(&raw, Some(&tl), &recording(), "p-rin", "riot").unwrap();
        assert_eq!(pg["me"], 1);
        assert_eq!(pg["matchId"], "EUW1_42");
        assert_eq!(pg["patch"], "15.20");
        assert_eq!(pg["duration"], 1500);
        let me = &pg["players"][0];
        assert_eq!(me["isMe"], true);
        assert_eq!(me["cs"], 154);
        assert_eq!(me["dmgShare"], 0.8);
        // (5 kills + 2 assists) of the team's 7.
        assert_eq!(me["kp"], 1.0);
        assert_eq!(me["runes"]["keystone"], 8112);
        assert_eq!(me["runes"]["secondary"], 8200);
        assert_eq!(me["extra"]["soloKills"], 2);
        assert_eq!(me["extra"]["pings"], 5);
        assert_eq!(me["skills"], "QE");
        assert_eq!(pg["players"][1]["champion"], "Zed");
        assert_eq!(pg["players"][3]["champion"], "K'Sante");
        // Lane: Ahri against Zed, minute by minute.
        assert_eq!(pg["lane"]["opponent"], 2);
        assert_eq!(pg["lane"]["gold"], json!([0, 300, 600]));
        assert_eq!(pg["teamGold"], json!([0, 200, 500]));
        assert_eq!(pg["frames"]["t"], json!([0, 60, 120]));
        assert_eq!(pg["frames"]["players"][0]["x"], json!([100, 100, 100]));
        // The death, with what did it.
        let k = &pg["kills"][0];
        assert_eq!(k["t"], 61.5);
        assert_eq!(k["victim"], 1);
        assert_eq!(k["recap"][0]["name"], "Zed");
        assert_eq!(k["recap"][0]["total"], 500);
        assert_eq!(k["recap"][0]["hits"], json!(["R", "Auto"]));
        assert_eq!(k["recap"][1]["name"], "KSante");
        assert_eq!(k["recap"][2]["name"], "Turret");
        assert_eq!(k["dealt"], 250);
        // Objectives say which team took them.
        assert_eq!(pg["objectives"][0]["kind"], "tower");
        assert_eq!(pg["objectives"][0]["by"], 100);
        assert_eq!(pg["objectives"][1]["kind"], "dragon");
        assert_eq!(pg["objectives"][1]["sub"], "FIRE_DRAGON");
        assert_eq!(pg["teams"][0]["dragons"], 3);
        assert_eq!(pg["teams"][0]["grubs"], 3);
        assert_eq!(pg["teams"][0]["bans"], json!([55]));
        assert_eq!(pg["teams"][0]["kills"], 7);

        let tr = trend_extras(&pg, &[(5.0, 0.0)], 2000.0);
        assert_eq!(tr["deaths"][0]["x"], 7000);
        assert_eq!(tr["deaths"][0]["v"], 66.5);
        // A recording that ended before the death has nothing to play for it.
        assert!(trend_extras(&pg, &[(5.0, 0.0)], 60.0)["deaths"][0]["v"].is_null());
        // Nor does one that started after it.
        assert!(trend_extras(&pg, &[(0.0, 100.0)], 2000.0)["deaths"][0]["v"].is_null());
        assert_eq!(tr["deaths"][0]["other"], "Zed");
        assert_eq!(tr["deaths"][0]["otherKey"], "Zed");
        assert_eq!(tr["dpm"], 800.0);
        assert!(tr["gold10"].is_null());
        assert_eq!(tr["opp"], "Zed");
        assert_eq!(tr["oppKey"], "Zed");
        // Three minutes is too short to tell a story.
        assert!(tr["story"].is_null());
    }

    /// A 20-minute game from my side, with my team's gold lead at each minute.
    fn with_lead(won: bool, lead: &[i64]) -> Value {
        let t: Vec<i64> = (0..lead.len() as i64).map(|i| i * 60).collect();
        json!({
            "me": 1,
            "duration": (lead.len() as i64 - 1) * 60 + 30,
            "players": [ { "id": 1, "win": won } ],
            "teamGold": lead,
            "frames": { "t": t, "players": [] },
        })
    }

    #[test]
    fn games_are_told_by_their_gold_lead() {
        let game = |f: &dyn Fn(i64) -> i64| (0..=20).map(f).collect::<Vec<i64>>();
        // Won from 4,000 behind at 12 minutes.
        let comeback = game(&|m| if m <= 12 { -m * 333 } else { -4000 + (m - 12) * 600 });
        assert_eq!(story(&with_lead(true, &comeback)), Some("comeback"));
        // Lost from 3,500 ahead.
        let throw = game(&|m| if m <= 10 { m * 350 } else { 3500 - (m - 10) * 900 });
        assert_eq!(story(&with_lead(false, &throw)), Some("throw"));
        // Ahead all game, 4,500 up at 15: a stomp. The same curve against me is one too.
        let ahead = game(&|m| m * 300);
        assert_eq!(story(&with_lead(true, &ahead)), Some("stomp"));
        let behind: Vec<i64> = ahead.iter().map(|g| -g).collect();
        assert_eq!(story(&with_lead(false, &behind)), Some("stomp"));
        // Within 3,000 until the last two minutes, whatever happened then.
        let mut close = game(&|m| if m % 2 == 0 { 1500 } else { -1800 });
        close[19] = 3500;
        close[20] = 6000;
        assert_eq!(story(&with_lead(true, &close)), Some("close"));
        // 2,000 behind early, then far ahead: nothing to tell.
        let ordinary = game(&|m| if m <= 8 { -m * 250 } else { -2000 + (m - 8) * 700 });
        assert_eq!(story(&with_lead(true, &ordinary)), None);
        // Too short, or no lead to read.
        assert_eq!(story(&with_lead(true, &ahead[..8])), None);
        assert_eq!(story(&json!({ "me": 1, "players": [ { "id": 1, "win": true } ] })), None);
    }

    #[test]
    fn the_scoreboard_keeps_ranked_rift_queues() {
        let kept = rift_ranks(vec![
            standing("RANKED_SOLO_5x5", "DIAMOND", "II", 40, 1, 1),
            standing("RANKED_FLEX_SR", "NONE", "", 0, 0, 0),
            standing("RANKED_TFT", "GOLD", "I", 10, 1, 1),
        ]);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0]["tier"], "DIAMOND");
        assert_eq!(kept[0]["division"], "II");
        assert!(client_id("e7e87d21-f206-5984-ba48-1a38721386a7"));
        assert!(!client_id("raJw2woGUMW_dmvYXqsEXAMPLEw7Ux0lQ6sKkE0Qx2Yx3Dc2y8qG0bFq1hk3U2yTEeM9QvLwJrQfB4w"));
        assert!(!client_id(""));
    }

    #[test]
    fn a_client_record_is_summarized() {
        let stats = |k: i64, d: i64, win: bool, dmg: i64| {
            json!({ "kills": k, "deaths": d, "assists": 1, "win": win, "totalDamageDealtToChampions": dmg, "totalMinionsKilled": 100, "neutralMinionsKilled": 0,
                    "champLevel": 12, "goldEarned": 8000, "item0": 1055, "perk0": 8005, "perk1": 9111, "perkPrimaryStyle": 8000, "perkSubStyle": 8300 })
        };
        let raw = json!({
            "gameId": 42, "platformId": "EUW1", "queueId": 440, "mapId": 11, "gameMode": "CLASSIC", "gameDuration": 1800, "gameCreation": 999_000, "gameVersion": "15.20.1",
            "participantIdentities": [
                { "participantId": 1, "player": { "gameName": "Rin", "tagLine": "EUW", "puuid": "p-rin" } },
                { "participantId": 2, "player": { "gameName": "Zedd", "tagLine": "EUW", "puuid": "p-zed" } },
                { "participantId": 3, "player": { "gameName": "Jun", "tagLine": "EUW", "puuid": "p-jun" } },
                { "participantId": 4, "player": { "gameName": "Kay", "tagLine": "EUW", "puuid": "p-kay" } },
            ],
            "participants": [
                { "participantId": 1, "teamId": 100, "championId": 103, "spell1Id": 4, "spell2Id": 14, "stats": stats(4, 2, false, 12000), "timeline": { "lane": "MIDDLE", "role": "SOLO" } },
                { "participantId": 2, "teamId": 200, "championId": 238, "spell1Id": 4, "spell2Id": 12, "stats": stats(2, 4, true, 18000), "timeline": { "lane": "MIDDLE", "role": "SOLO" } },
                { "participantId": 3, "teamId": 100, "championId": 64, "spell1Id": 11, "spell2Id": 4, "stats": stats(1, 1, false, 4000), "timeline": { "lane": "JUNGLE", "role": "NONE" } },
                { "participantId": 4, "teamId": 200, "championId": 897, "spell1Id": 12, "spell2Id": 4, "stats": stats(3, 0, true, 6000), "timeline": { "lane": "TOP", "role": "SOLO" } },
            ],
            "teams": [ { "teamId": 100, "win": "Fail", "towerKills": 2, "dragonKills": 1, "bans": [] }, { "teamId": 200, "win": "Win", "towerKills": 8, "baronKills": 1, "bans": [ { "championId": 157 } ] } ],
        });
        let tl = json!({ "frames": [
            { "timestamp": 0, "participantFrames": { "1": { "totalGold": 500, "xp": 0, "minionsKilled": 0, "jungleMinionsKilled": 0, "level": 1, "position": { "x": 500, "y": 500 } } }, "events": [] },
            { "timestamp": 60100, "participantFrames": { "1": { "totalGold": 900, "xp": 300, "minionsKilled": 4, "jungleMinionsKilled": 0, "level": 2, "position": { "x": 6000, "y": 6100 } } },
              "events": [ { "type": "CHAMPION_KILL", "timestamp": 59000, "killerId": 1, "victimId": 2, "assistingParticipantIds": [], "position": { "x": 6200, "y": 6300 } } ] },
        ] });
        let pg = normalize(&raw, Some(&tl), &recording(), "", "client").unwrap();
        assert_eq!(pg["me"], 1);
        assert_eq!(pg["matchId"], "EUW1_42");
        assert_eq!(pg["source"], "client");
        let me = &pg["players"][0];
        assert_eq!(me["champion"], "Ahri");
        assert_eq!(me["position"], "MIDDLE");
        assert_eq!(me["win"], false);
        assert_eq!(me["spells"], json!([4, 14]));
        assert_eq!(me["runes"]["keystone"], 8005);
        assert!(me["extra"].is_null());
        assert_eq!(pg["players"][3]["position"], "TOP");
        assert_eq!(pg["teams"][1]["win"], true);
        assert_eq!(pg["teams"][1]["barons"], 1);
        assert_eq!(pg["teams"][1]["bans"], json!([157]));
        assert_eq!(pg["frames"]["players"][0]["gold"], json!([500, 900]));
        // Players missing from a frame keep their last numbers.
        assert_eq!(pg["frames"]["players"][1]["gold"], json!([0, 0]));
        assert!(pg["frames"]["players"][0]["damage"].is_null());
        assert_eq!(pg["kills"][0]["killer"], 1);
        assert!(pg["kills"][0]["recap"].is_null());
        assert_eq!(pg["startMs"], 999_000);

        // The live feed showed both enemies under their champion's name: they are told
        // apart by their numbers at the end (the feed's last ones missed two CS).
        let mut hidden = recording();
        for (i, name, k, d, a, cs) in [(1, "Zed", 2, 4, 1, 98), (3, "K'Sante", 3, 0, 1, 100)] {
            let row = &mut hidden.players[i];
            row["name"] = json!(name);
            row["kills"] = json!(k);
            row["deaths"] = json!(d);
            row["assists"] = json!(a);
            row["cs"] = json!(cs);
        }
        let pg = normalize(&raw, Some(&tl), &hidden, "", "client").unwrap();
        assert_eq!(pg["players"][1]["name"], "Zedd");
        assert_eq!(pg["players"][1]["champion"], "Zed");
        assert_eq!(pg["players"][3]["name"], "Kay");
        assert_eq!(pg["players"][3]["champion"], "K'Sante");
        assert_eq!(pg["players"][3]["championKey"], "KSante");
        // Numbers far from anyone's are no match.
        let people = [Person { name: "Kay".into(), side: "CHAOS", numbers: [30, 0, 1, 100] }];
        assert_eq!(recorded_rows(&people, &hidden.players), vec![None]);
        // A recording cut short: Zedd's numbers are far off, but he is the one left.
        let rows = vec![json!({ "name": "Rin", "team": "ORDER" }), json!({ "name": "Zed", "team": "CHAOS", "kills": 0, "cs": 10 })];
        let people = [
            Person { name: "Rin".into(), side: "ORDER", numbers: [0, 0, 0, 0] },
            Person { name: "Zedd".into(), side: "CHAOS", numbers: [9, 9, 9, 300] },
        ];
        assert_eq!(recorded_rows(&people, &rows), vec![Some(0), Some(1)]);
    }

    #[test]
    fn the_client_list_is_matched_by_time_and_name() {
        let game = recording();
        let games = vec![
            json!({ "gameId": 7, "gameCreation": game.started_ms - 40 * 60_000, "participantIdentities": [ { "player": { "gameName": "Rin" } } ] }),
            json!({ "gameId": 8, "gameCreation": game.started_ms - 60_000, "participantIdentities": [ { "player": { "gameName": "rin" } } ] }),
            json!({ "gameId": 9, "gameCreation": game.started_ms + 30_000, "participantIdentities": [ { "player": { "gameName": "Someone" } } ] }),
        ];
        assert_eq!(find_in_client(&games, &game), Some(8));
        assert_eq!(find_in_client(&games[..1], &game), None);
    }

    #[test]
    fn retries_back_off() {
        let game = GameRef { ended_ms: 1_000_000, ..Default::default() };
        assert!(!due(&json!({}), &game, 1_000_000 + 30_000));
        assert!(due(&json!({}), &game, 1_000_000 + 100_000));
        let tried = json!({ "tries": 3, "last": 2_000_000 });
        assert!(!due(&tried, &game, 2_000_000 + 10 * 60_000));
        assert!(due(&tried, &game, 2_000_000 + 16 * 60_000));
        assert!(!due(&json!({ "gaveUp": true }), &game, i64::MAX / 2));
    }

    #[test]
    fn practice_tool_games_are_not_looked_up() {
        let game = GameRef { game_mode: "PRACTICETOOL".into(), ..recording() };
        assert!(matches!(fetch_game(&game, &json!({}), &Account::default(), None, None, false), Err(Miss::Never(_))));
        // Nothing to ask: wait without counting a try.
        assert!(matches!(fetch_game(&recording(), &json!({}), &Account::default(), None, None, false), Err(Miss::Wait(_))));
    }
}
