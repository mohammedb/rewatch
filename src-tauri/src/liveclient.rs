//! Reads Riot's Live Client Data API (the local feed Riot documents for third-party
//! tools) about once a second and turns it into timeline events.
//!
//! The feed reports kills and objectives as events. It does not report purchases,
//! but it lists every player's items, so a purchase is detected when an item count
//! goes up between two reads.

use crate::audio::Clock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GameEvent {
    /// Seconds on the session clock while recording; converted to video time at the end.
    pub t: f64,
    pub game_time: f64,
    /// Riot's event name (ChampionKill, DragonKill, TurretKilled...) or "ItemPurchased".
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub killer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub killer_champ: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub victim: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub victim_champ: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub assisters: Vec<String>,
    /// Dragon type, structure name, item name, multikill size, game result...
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<i64>,
    /// The recording player was directly involved.
    pub mine: bool,
    /// For champion kills involving the recording player: "kill" | "death" | "assist".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// Whether the event favours the recording player's team, when that can be told.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub good: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LiveData {
    pub events: Vec<GameEvent>,
    /// Pairs of (session seconds, in-game seconds), one every few seconds.
    pub clock: Vec<[f64; 2]>,
    /// Last full read of the feed, without its event list.
    pub snapshot: Option<Value>,
    /// "Win" | "Lose" once the game-end event has been seen.
    pub result: Option<String>,
    pub me: Option<String>,
    pub my_team: Option<String>,
    /// Every player's numbers over time, one sample about every ten seconds.
    pub stats: Stats,
    #[serde(skip)]
    seen: HashSet<i64>,
    #[serde(skip)]
    items: HashMap<String, HashMap<i64, i64>>,
}

/// Numbers over the course of the game, for the graphs under the timeline.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Stats {
    /// Session seconds of each sample while recording; video time once saved.
    pub t: Vec<f64>,
    /// The recording player's unspent gold at each sample.
    pub gold: Vec<f64>,
    pub players: Vec<PlayerStats>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PlayerStats {
    pub name: String,
    pub cs: Vec<i32>,
    pub level: Vec<i32>,
    pub kills: Vec<i32>,
    pub deaths: Vec<i32>,
    pub assists: Vec<i32>,
}

const STATS_EVERY: f64 = 10.0;

const TRINKETS: [i64; 4] = [3340, 3363, 3364, 3330];

struct Player {
    names: Vec<String>,
    team: String,
    champion: String,
}

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .filter(|x| !x.is_empty())
        .map(|x| x.to_string())
}

fn player_names(p: &Value) -> Vec<String> {
    ["riotIdGameName", "summonerName", "riotId"]
        .iter()
        .filter_map(|k| s(p, k))
        .collect()
}

/// Team of a non-player actor, from Riot's object names (minions, turrets, barracks).
fn team_from_object_name(name: &str) -> Option<&'static str> {
    if name.contains("T100") || name.contains("_T1_") || name.contains("_T1") && name.starts_with("Barracks") {
        Some("ORDER")
    } else if name.contains("T200") || name.contains("_T2_") || name.contains("_T2") && name.starts_with("Barracks") {
        Some("CHAOS")
    } else {
        None
    }
}

impl LiveData {
    /// Fold one read of `/liveclientdata/allgamedata` into the timeline.
    /// `t_session` is the session-clock time at which the read came back.
    pub fn ingest(&mut self, data: &Value, t_session: f64) {
        let game_time = data
            .pointer("/gameData/gameTime")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let offset = t_session - game_time;

        let players: Vec<Player> = data
            .get("allPlayers")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .map(|p| Player {
                        names: player_names(p),
                        team: s(p, "team").unwrap_or_default(),
                        champion: s(p, "championName").unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let find = |name: &str| players.iter().find(|p| p.names.iter().any(|n| n == name));

        let my_names: Vec<String> = data.get("activePlayer").map(player_names).unwrap_or_default();
        let me = my_names.iter().find_map(|n| find(n));
        let my_team = me.map(|p| p.team.clone());
        let is_me = |name: &str| my_names.iter().any(|n| n == name);
        if let Some(n) = my_names.first() {
            self.me = Some(n.clone());
        }
        if my_team.is_some() {
            self.my_team = my_team.clone();
        }
        let team_of = |name: &str| -> Option<String> {
            find(name)
                .map(|p| p.team.clone())
                .or_else(|| team_from_object_name(name).map(|t| t.to_string()))
        };
        let favours_me = |team: Option<String>| -> Option<bool> {
            match (&team, &my_team) {
                (Some(t), Some(m)) => Some(t == m),
                _ => None,
            }
        };

        // --- events reported by the feed
        if let Some(list) = data.pointer("/events/Events").and_then(|v| v.as_array()) {
            for e in list {
                let id = e.get("EventID").and_then(|v| v.as_i64()).unwrap_or(-1);
                if !self.seen.insert(id) {
                    continue;
                }
                let kind = s(e, "EventName").unwrap_or_default();
                let event_time = e.get("EventTime").and_then(|v| v.as_f64()).unwrap_or(game_time);
                let killer = s(e, "KillerName").or_else(|| s(e, "Acer")).or_else(|| s(e, "Recipient"));
                let assisters: Vec<String> = e
                    .get("Assisters")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                let mut ev = GameEvent {
                    t: (event_time + offset).max(0.0),
                    game_time: event_time,
                    kind: kind.clone(),
                    killer_champ: killer.as_deref().and_then(|k| find(k)).map(|p| p.champion.clone()),
                    killer: killer.clone(),
                    assisters: assisters.clone(),
                    ..Default::default()
                };
                let killer_team = killer.as_deref().and_then(|k| team_of(k));
                let i_killed = killer.as_deref().map(|k| is_me(k)).unwrap_or(false);
                let i_assisted = assisters.iter().any(|a| is_me(a));

                match kind.as_str() {
                    "ChampionKill" => {
                        let victim = s(e, "VictimName");
                        let i_died = victim.as_deref().map(|v| is_me(v)).unwrap_or(false);
                        ev.victim_champ = victim.as_deref().and_then(|v| find(v)).map(|p| p.champion.clone());
                        let victim_team = victim.as_deref().and_then(|v| team_of(v));
                        ev.victim = victim;
                        ev.role = if i_died {
                            Some("death".into())
                        } else if i_killed {
                            Some("kill".into())
                        } else if i_assisted {
                            Some("assist".into())
                        } else {
                            None
                        };
                        ev.mine = ev.role.is_some();
                        // Judge by the victim: an executed enemy is still good for us.
                        ev.good = favours_me(victim_team).map(|same| !same);
                    }
                    "TurretKilled" | "InhibKilled" | "FirstBrick" => {
                        let structure = s(e, "TurretKilled").or_else(|| s(e, "InhibKilled"));
                        let owner = structure.as_deref().and_then(team_from_object_name).map(String::from);
                        ev.good = favours_me(owner).map(|same| !same).or(favours_me(killer_team));
                        ev.detail = structure;
                        ev.mine = i_killed || i_assisted;
                    }
                    "DragonKill" => {
                        ev.detail = s(e, "DragonType");
                        ev.good = favours_me(killer_team);
                        ev.mine = i_killed || i_assisted;
                    }
                    "Multikill" => {
                        ev.detail = e.get("KillStreak").and_then(|v| v.as_i64()).map(|n| n.to_string());
                        ev.good = favours_me(killer_team);
                        ev.mine = i_killed;
                    }
                    "Ace" => {
                        ev.good = favours_me(s(e, "AcingTeam"));
                        ev.mine = i_killed;
                    }
                    "GameEnd" => {
                        let result = s(e, "Result");
                        ev.good = result.as_deref().map(|r| r == "Win");
                        ev.detail = result.clone();
                        self.result = result;
                    }
                    _ => {
                        // HeraldKill, BaronKill, HordeKill, FirstBlood, GameStart and anything
                        // Riot adds later: keep it, judged by who did it.
                        ev.good = favours_me(killer_team);
                        ev.mine = i_killed || i_assisted;
                    }
                }
                self.events.push(ev);
            }
        }

        // --- purchases, from item list changes
        if let Some(all) = data.get("allPlayers").and_then(|v| v.as_array()) {
            for p in all {
                let Some(name) = player_names(p).into_iter().next() else { continue };
                let mut now: HashMap<i64, i64> = HashMap::new();
                let mut display: HashMap<i64, String> = HashMap::new();
                if let Some(items) = p.get("items").and_then(|v| v.as_array()) {
                    for it in items {
                        let id = it.get("itemID").and_then(|v| v.as_i64()).unwrap_or(0);
                        let count = it.get("count").and_then(|v| v.as_i64()).unwrap_or(1).max(1);
                        *now.entry(id).or_insert(0) += count;
                        display.insert(id, s(it, "displayName").unwrap_or_else(|| format!("Item {id}")));
                    }
                }
                let before = match self.items.get(&name) {
                    Some(b) => b.clone(),
                    // First sight of this player. Early in the game the items are starting
                    // purchases; later (app started mid-game) they are just the baseline.
                    None if game_time < 90.0 => HashMap::new(),
                    None => now.clone(),
                };
                let mine = is_me(&name);
                let team = s(p, "team");
                for (id, count) in &now {
                    // Trinkets are free and swapped constantly; they are not purchases.
                    if TRINKETS.contains(id) {
                        continue;
                    }
                    if *id != 0 && *count > *before.get(id).unwrap_or(&0) {
                        self.events.push(GameEvent {
                            t: t_session.max(0.0),
                            game_time,
                            kind: "ItemPurchased".into(),
                            killer: Some(name.clone()),
                            killer_champ: s(p, "championName"),
                            detail: display.get(id).cloned(),
                            item_id: Some(*id),
                            mine,
                            good: favours_me(team.clone()),
                            ..Default::default()
                        });
                    }
                }
                self.items.insert(name, now);
            }
        }

        // --- numbers for the graphs
        if self.stats.t.last().map(|last| t_session - last >= STATS_EVERY).unwrap_or(true) {
            if let Some(all) = data.get("allPlayers").and_then(|v| v.as_array()) {
                let n = self.stats.t.len();
                for p in all {
                    let Some(name) = player_names(p).into_iter().next() else { continue };
                    if s(p, "championName").is_none() {
                        continue;
                    }
                    let idx = match self.stats.players.iter().position(|x| x.name == name) {
                        Some(i) => i,
                        None => {
                            // Seen for the first time: pad so every row has one value per sample.
                            self.stats.players.push(PlayerStats { name, cs: vec![0; n], level: vec![0; n], kills: vec![0; n], deaths: vec![0; n], assists: vec![0; n] });
                            self.stats.players.len() - 1
                        }
                    };
                    let score = |k: &str| p.pointer(&format!("/scores/{k}")).and_then(|x| x.as_f64()).unwrap_or(0.0) as i32;
                    let row = &mut self.stats.players[idx];
                    row.cs.push(score("creepScore"));
                    row.level.push(p.get("level").and_then(|x| x.as_i64()).unwrap_or(0) as i32);
                    row.kills.push(score("kills"));
                    row.deaths.push(score("deaths"));
                    row.assists.push(score("assists"));
                }
                self.stats.t.push(t_session);
                self.stats.gold.push(data.pointer("/activePlayer/currentGold").and_then(|x| x.as_f64()).unwrap_or(0.0).round());
                // Anyone missing from this read keeps their last value.
                for row in &mut self.stats.players {
                    for col in [&mut row.cs, &mut row.level, &mut row.kills, &mut row.deaths, &mut row.assists] {
                        while col.len() <= n {
                            let last = col.last().copied().unwrap_or(0);
                            col.push(last);
                        }
                    }
                }
            }
        }

        // --- game clock sample, at most one every five seconds
        if self.clock.last().map(|c| t_session - c[0] >= 5.0).unwrap_or(true) {
            self.clock.push([t_session, game_time]);
        }

        let mut snap = data.clone();
        if let Some(o) = snap.as_object_mut() {
            o.remove("events");
        }
        self.snapshot = Some(snap);
    }
}

pub fn live_url() -> String {
    std::env::var("REWATCH_LIVE_URL").unwrap_or_else(|_| "https://127.0.0.1:2999".into())
}

/// HTTP client for Riot's local endpoints. They use a self-signed certificate, so
/// certificate checking is off; the client is only ever pointed at 127.0.0.1.
pub fn local_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .tls_config(ureq::tls::TlsConfig::builder().disable_verification(true).build())
        .timeout_global(Some(Duration::from_millis(1500)))
        .build()
        .into()
}

/// Poll until `stop` is set. Writes `dump` (if given) every 15 s so an interrupted
/// recording can still be finished with its events.
pub fn poll_loop(data: Arc<Mutex<LiveData>>, clock: Clock, stop: Arc<AtomicBool>, dump: Option<PathBuf>) {
    let agent = local_agent();
    let url = format!("{}/liveclientdata/allgamedata", live_url());
    let mut last_dump = std::time::Instant::now();
    while !stop.load(Ordering::Relaxed) {
        let read: Result<Value, ureq::Error> = agent.get(&url).call().and_then(|mut r| r.body_mut().read_json());
        if let Ok(v) = read {
            if v.get("gameData").is_some() {
                let t = clock.secs();
                if let Ok(mut d) = data.lock() {
                    d.ingest(&v, t);
                }
            }
        }
        if let Some(path) = &dump {
            if last_dump.elapsed() > Duration::from_secs(15) {
                last_dump = std::time::Instant::now();
                if let Ok(d) = data.lock() {
                    if let Ok(js) = serde_json::to_string(&*d) {
                        let _ = std::fs::write(path, js);
                    }
                }
            }
        }
        for _ in 0..10 {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

fn base64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// What the League client says about the game that is starting.
#[derive(Debug, Clone, Default)]
pub struct ClientInfo {
    pub queue: Option<(i64, String)>,
    /// Riot's id for this game. Every player in the game sees the same one, which is
    /// what lets recordings from different players be matched up.
    pub game_id: Option<i64>,
}

/// One read-only request to the League client's local API. Used to name the queue,
/// honour the per-queue switches and identify the game. Returns None if the client
/// is not reachable.
pub fn client_info(league_dir: &std::path::Path) -> Option<ClientInfo> {
    let lock = std::fs::read_to_string(league_dir.join("lockfile")).ok()?;
    let parts: Vec<&str> = lock.trim().split(':').collect();
    if parts.len() < 5 {
        return None;
    }
    let (port, password) = (parts[2], parts[3]);
    let auth = format!("Basic {}", base64(format!("riot:{password}").as_bytes()));
    let v: Value = local_agent()
        .get(&format!("https://127.0.0.1:{port}/lol-gameflow/v1/session"))
        .header("Authorization", &auth)
        .call()
        .ok()?
        .body_mut()
        .read_json()
        .ok()?;
    Some(parse_client_info(&v))
}

fn parse_client_info(v: &Value) -> ClientInfo {
    let game_id = v.pointer("/gameData/gameId").and_then(|x| x.as_i64()).filter(|id| *id > 0);
    let queue = v.pointer("/gameData/queue").and_then(|q| {
        let id = q.get("id").and_then(|x| x.as_i64())?;
        let name = s(q, "description")
            .or_else(|| s(q, "name"))
            .unwrap_or_else(|| queue_name(id).to_string());
        Some((id, name))
    });
    ClientInfo { queue, game_id }
}

pub fn queue_name(id: i64) -> &'static str {
    match id {
        420 => "Ranked Solo/Duo",
        440 => "Ranked Flex",
        400 => "Normal Draft",
        430 => "Normal Blind",
        480 => "Swiftplay",
        490 => "Quickplay",
        450 => "ARAM",
        0 | -1 => "Custom",
        _ => "Other",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn player(name: &str, champ: &str, team: &str, items: Value) -> Value {
        json!({ "riotIdGameName": name, "summonerName": name, "championName": champ, "team": team,
                "items": items, "scores": {"kills": 0, "deaths": 0, "assists": 0, "creepScore": 0} })
    }

    fn feed(game_time: f64, events: Value, my_items: Value) -> Value {
        json!({
            "activePlayer": { "riotIdGameName": "Rin", "summonerName": "Rin", "riotId": "Rin#EUW" },
            "allPlayers": [
                player("Rin", "Ahri", "ORDER", my_items),
                player("Friend", "Lee Sin", "ORDER", json!([])),
                player("Enemy", "Zed", "CHAOS", json!([])),
            ],
            "events": { "Events": events },
            "gameData": { "gameTime": game_time, "gameMode": "CLASSIC" }
        })
    }

    #[test]
    fn kills_are_placed_on_the_session_clock_and_judged() {
        let mut d = LiveData::default();
        // The game clock reads 100 s when the recording has run for 130 s.
        d.ingest(
            &feed(
                100.0,
                json!([
                    {"EventID": 1, "EventName": "ChampionKill", "EventTime": 95.0, "KillerName": "Rin", "VictimName": "Enemy", "Assisters": ["Friend"]},
                    {"EventID": 2, "EventName": "ChampionKill", "EventTime": 98.0, "KillerName": "Enemy", "VictimName": "Rin", "Assisters": []},
                    {"EventID": 3, "EventName": "ChampionKill", "EventTime": 99.0, "KillerName": "Friend", "VictimName": "Enemy", "Assisters": ["Rin"]},
                ]),
                json!([]),
            ),
            130.0,
        );
        let kills: Vec<&GameEvent> = d.events.iter().filter(|e| e.kind == "ChampionKill").collect();
        assert_eq!(kills.len(), 3);
        assert!((kills[0].t - 125.0).abs() < 1e-9);
        assert_eq!(kills[0].role.as_deref(), Some("kill"));
        assert_eq!(kills[0].good, Some(true));
        assert_eq!(kills[0].victim_champ.as_deref(), Some("Zed"));
        assert_eq!(kills[1].role.as_deref(), Some("death"));
        assert_eq!(kills[1].good, Some(false));
        assert_eq!(kills[2].role.as_deref(), Some("assist"));
        assert_eq!(d.my_team.as_deref(), Some("ORDER"));
    }

    #[test]
    fn events_are_not_duplicated_across_reads() {
        let mut d = LiveData::default();
        let ev = json!([{"EventID": 7, "EventName": "DragonKill", "EventTime": 400.0, "KillerName": "Enemy", "DragonType": "Fire", "Assisters": []}]);
        d.ingest(&feed(401.0, ev.clone(), json!([])), 500.0);
        d.ingest(&feed(402.0, ev, json!([])), 501.0);
        let dragons: Vec<&GameEvent> = d.events.iter().filter(|e| e.kind == "DragonKill").collect();
        assert_eq!(dragons.len(), 1);
        assert_eq!(dragons[0].detail.as_deref(), Some("Fire"));
        assert_eq!(dragons[0].good, Some(false));
    }

    #[test]
    fn structures_are_judged_by_owner() {
        let mut d = LiveData::default();
        d.ingest(
            &feed(
                900.0,
                json!([
                    {"EventID": 1, "EventName": "TurretKilled", "EventTime": 890.0, "KillerName": "Minion_T100L1S1N3", "TurretKilled": "Turret_T2_L_03_A", "Assisters": []},
                    {"EventID": 2, "EventName": "InhibKilled", "EventTime": 895.0, "KillerName": "Enemy", "InhibKilled": "Barracks_T1_L1", "Assisters": []},
                ]),
                json!([]),
            ),
            950.0,
        );
        assert_eq!(d.events[0].good, Some(true)); // enemy (CHAOS) turret fell
        assert_eq!(d.events[1].good, Some(false)); // our (ORDER) inhibitor fell
    }

    #[test]
    fn purchases_come_from_item_list_changes() {
        let mut d = LiveData::default();
        let doran = json!({"itemID": 1056, "displayName": "Doran's Ring", "count": 1});
        let potion = |n: i64| json!({"itemID": 2003, "displayName": "Health Potion", "count": n});
        // Starting items count as purchases when seen early.
        d.ingest(&feed(10.0, json!([]), json!([doran, potion(2)])), 60.0);
        let bought = |d: &LiveData| d.events.iter().filter(|e| e.kind == "ItemPurchased").count();
        assert_eq!(bought(&d), 2);
        // Nothing new, nothing reported. Using a potion is not a purchase.
        d.ingest(&feed(11.0, json!([]), json!([doran, potion(1)])), 61.0);
        assert_eq!(bought(&d), 2);
        // A new item appears.
        let boots = json!({"itemID": 1001, "displayName": "Boots", "count": 1});
        d.ingest(&feed(300.0, json!([]), json!([doran, potion(1), boots])), 350.0);
        assert_eq!(bought(&d), 3);
        let last = d.events.last().unwrap();
        assert_eq!(last.detail.as_deref(), Some("Boots"));
        assert_eq!(last.item_id, Some(1001));
        assert!(last.mine);
        assert!((last.t - 350.0).abs() < 1e-9);
    }

    #[test]
    fn joining_late_does_not_report_existing_items() {
        let mut d = LiveData::default();
        let item = json!({"itemID": 3157, "displayName": "Zhonya's Hourglass", "count": 1});
        d.ingest(&feed(1200.0, json!([]), json!([item])), 5.0);
        assert!(d.events.iter().all(|e| e.kind != "ItemPurchased"));
    }

    #[test]
    fn game_end_sets_result() {
        let mut d = LiveData::default();
        d.ingest(&feed(1800.0, json!([{"EventID": 50, "EventName": "GameEnd", "EventTime": 1799.0, "Result": "Win"}]), json!([])), 1850.0);
        assert_eq!(d.result.as_deref(), Some("Win"));
    }

    #[test]
    fn client_info_reads_queue_and_game_id() {
        let v = json!({"phase": "InProgress", "gameData": {"gameId": 7412345678i64, "queue": {"id": 420, "description": "Ranked Solo/Duo", "name": "x"}}});
        let info = parse_client_info(&v);
        assert_eq!(info.game_id, Some(7412345678));
        assert_eq!(info.queue, Some((420, "Ranked Solo/Duo".to_string())));
        // Practice Tool: no useful queue text, id only.
        let v = json!({"gameData": {"gameId": 0, "queue": {"id": -1, "description": "", "name": ""}}});
        let info = parse_client_info(&v);
        assert_eq!(info.game_id, None);
        assert_eq!(info.queue, Some((-1, "Custom".to_string())));
        assert!(parse_client_info(&json!({"message": "No gameflow session exists."})).queue.is_none());
    }

    #[test]
    fn trinkets_are_not_purchases() {
        let mut d = LiveData::default();
        let ward = json!({"itemID": 3340, "displayName": "Stealth Ward", "count": 1});
        d.ingest(&feed(10.0, json!([]), json!([ward])), 60.0);
        assert!(d.events.iter().all(|e| e.kind != "ItemPurchased"));
    }

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64(b"riot:abc"), "cmlvdDphYmM=");
        assert_eq!(base64(b"a"), "YQ==");
        assert_eq!(base64(b"abc"), "YWJj");
    }
}

#[cfg(test)]
mod stats_tests {
    use super::*;
    use serde_json::json;

    fn read(game_time: f64, cs: i64, with_enemy: bool) -> Value {
        let p = |name: &str, champ: &str, cs: i64| json!({ "riotIdGameName": name, "championName": champ, "team": "ORDER", "level": 3, "items": [], "scores": { "kills": 1, "deaths": 0, "assists": 2, "creepScore": cs } });
        let mut all = vec![p("Rin", "Ahri", cs)];
        if with_enemy {
            all.push(p("Enemy", "Zed", 7));
        }
        json!({ "activePlayer": { "riotIdGameName": "Rin", "currentGold": 512.4 }, "allPlayers": all, "events": { "Events": [] }, "gameData": { "gameTime": game_time } })
    }

    #[test]
    fn numbers_are_sampled_every_ten_seconds_with_equal_rows() {
        let mut d = LiveData::default();
        d.ingest(&read(1.0, 0, false), 41.0);
        d.ingest(&read(5.0, 2, false), 45.0); // too soon: no sample
        d.ingest(&read(12.0, 9, true), 52.0); // a player shows up late
        d.ingest(&read(23.0, 15, false), 63.0); // and is missing from a read
        assert_eq!(d.stats.t, vec![41.0, 52.0, 63.0]);
        assert_eq!(d.stats.gold, vec![512.0, 512.0, 512.0]);
        let me = d.stats.players.iter().find(|p| p.name == "Rin").unwrap();
        assert_eq!(me.cs, vec![0, 9, 15]);
        let enemy = d.stats.players.iter().find(|p| p.name == "Enemy").unwrap();
        assert_eq!(enemy.cs, vec![0, 7, 7]);
        assert_eq!(enemy.kills.len(), 3);
    }
}
