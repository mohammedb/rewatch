//! A title for every player after a game ("The Carry", "Gray Screen Enjoyer"...).
//!
//! These are worked out from the game's own numbers, so everyone gets them with no
//! account or key, and the same game gives the same titles on every PC. When the AI
//! review is switched on, its titles (written for that one game) are shown instead.

use serde_json::{json, Value};

/// One player's numbers for the game, from the scoreboard and the event list.
#[derive(Debug, Clone, Default)]
pub struct Numbers {
    pub name: String,
    pub champion: String,
    pub team: String,
    pub is_me: bool,
    pub position: String,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
    pub cs: i64,
    pub level: i64,
    pub cs_per_min: f64,
    /// Share of the team's kills this player had a hand in, 0 to 1.
    pub kp: f64,
    pub towers: i64,
    pub epic: i64,
    pub first_blood: bool,
    pub best_multikill: i64,
    /// Deaths to towers, minions or monsters.
    pub executed: i64,
    /// Ward score, in recordings made by version 0.2.1 or later.
    pub wards: Option<f64>,
    pub items: Vec<String>,
}

pub fn minutes(doc: &Value) -> f64 {
    let secs = doc.pointer("/game/length").and_then(|x| x.as_f64()).or_else(|| doc.get("duration").and_then(|x| x.as_f64())).unwrap_or(0.0);
    (secs / 60.0).max(1.0)
}

pub fn numbers(doc: &Value) -> Vec<Numbers> {
    let text = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let int = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_i64()).unwrap_or(0);
    let mins = minutes(doc);
    let mut out: Vec<Numbers> = doc
        .pointer("/game/players")
        .and_then(|p| p.as_array())
        .map(|a| {
            a.iter()
                .map(|p| Numbers {
                    name: text(p, "name"),
                    champion: text(p, "champion"),
                    team: text(p, "team"),
                    is_me: p.get("isMe") == Some(&json!(true)),
                    position: text(p, "position"),
                    kills: int(p, "kills"),
                    deaths: int(p, "deaths"),
                    assists: int(p, "assists"),
                    cs: int(p, "cs"),
                    level: int(p, "level"),
                    cs_per_min: int(p, "cs") as f64 / mins,
                    wards: p.get("wards").and_then(|x| x.as_f64()),
                    items: p.get("items").and_then(|i| i.as_array()).map(|i| i.iter().map(|it| text(it, "name")).filter(|n| !n.is_empty()).collect()).unwrap_or_default(),
                    ..Default::default()
                })
                .collect()
        })
        .unwrap_or_default();
    let team_kills = |team: &str| out.iter().filter(|p| p.team == team).map(|p| p.kills).sum::<i64>().max(1);
    let totals: Vec<i64> = out.iter().map(|p| team_kills(&p.team)).collect();
    for (p, total) in out.iter_mut().zip(totals) {
        p.kp = (p.kills + p.assists) as f64 / total as f64;
    }
    for e in doc.get("events").and_then(|e| e.as_array()).cloned().unwrap_or_default() {
        let kind = text(&e, "kind");
        let killer = text(&e, "killer");
        let by = out.iter().position(|p| !killer.is_empty() && p.name == killer);
        match (kind.as_str(), by) {
            ("TurretKilled" | "InhibKilled", Some(i)) => out[i].towers += 1,
            ("DragonKill" | "BaronKill" | "HeraldKill" | "HordeKill" | "AtakhanKill", Some(i)) => out[i].epic += 1,
            ("FirstBlood", Some(i)) => out[i].first_blood = true,
            ("Multikill", Some(i)) => {
                let n = text(&e, "detail").parse::<i64>().unwrap_or(0);
                out[i].best_multikill = out[i].best_multikill.max(n);
            }
            ("ChampionKill", None) => {
                let victim = text(&e, "victim");
                if let Some(v) = out.iter_mut().find(|p| p.name == victim) {
                    v.executed += 1;
                }
            }
            _ => {}
        }
    }
    out
}

/// A stable pick among a title's variants, so one game always reads the same.
fn pick<'a>(seed: &str, salt: usize, names: &[&'a str]) -> &'a str {
    let h = seed.bytes().fold(1469598103934665603u64, |h, b| (h ^ b as u64).wrapping_mul(1099511628211));
    names[(h as usize).wrapping_add(salt) % names.len()]
}

/// A title and the reason for it, for every player in the recording. Empty for
/// recordings without a scoreboard.
pub fn for_match(doc: &Value) -> Vec<Value> {
    let ps = numbers(doc);
    if ps.is_empty() {
        return Vec::new();
    }
    let seed = doc.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let long_game = minutes(doc) >= 15.0;
    let mut given: Vec<Option<(String, String)>> = vec![None; ps.len()];
    // "the most in the game" is only said when it is true of the whole game, not just
    // of the players who have no title yet.
    let most = |value: &dyn Fn(&Numbers) -> f64, p: &Numbers| -> &'static str {
        let best = ps.iter().map(|q| value(q)).fold(f64::MIN, f64::max);
        if value(p) >= best { ", the most in the game" } else { "" }
    };

    // The one player who stands out most on a number, if anyone clears the bar.
    let top = |given: &[Option<(String, String)>], value: &dyn Fn(&Numbers) -> f64, bar: f64| -> Option<usize> {
        let mut best: Option<(usize, f64)> = None;
        for (i, p) in ps.iter().enumerate() {
            let v = value(p);
            if given[i].is_none() && v >= bar && best.map(|(_, b)| v > b).unwrap_or(true) {
                best = Some((i, v));
            }
        }
        best.map(|(i, _)| i)
    };
    let award = |given: &mut Vec<Option<(String, String)>>, who: Option<usize>, names: &[&str], why: &dyn Fn(&Numbers) -> String| {
        if let Some(i) = who {
            given[i] = Some((pick(&seed, names.len() + i, names).to_string(), why(&ps[i])));
        }
    };

    // In order of how much there is to say about it. Each player gets one title and
    // each title goes to one player.
    let who = top(&given, &|p| if p.deaths == 0 { (p.kills + p.assists) as f64 } else { -1.0 }, 5.0);
    award(&mut given, who, &["Untouchable", "Allergic To Gray Screens", "Never Saw The Death Recap"], &|p| format!("0 deaths with {} takedowns", p.kills + p.assists));
    let who = top(&given, &|p| p.best_multikill as f64, 3.0);
    award(&mut given, who, &["Buy One Get Two Free", "Multikill Merchant", "Clean-Up Crew"], &|p| {
        format!("a {} kill", match p.best_multikill { 3 => "triple", 4 => "quadra", _ => "penta" })
    });
    let who = top(&given, &|p| p.kills as f64, 8.0);
    award(&mut given, who, &["The Carry", "1v9 Department", "Backpack Included"], &|p| format!("{} kills{}", p.kills, most(&|q| q.kills as f64, p)));
    let who = top(&given, &|p| p.deaths as f64, 8.0);
    award(&mut given, who, &["Gray Screen Enjoyer", "Fountain Tourist", "Respawn Timer Tester"], &|p| format!("{} deaths{}", p.deaths, most(&|q| q.deaths as f64, p)));
    let who = top(&given, &|p| p.assists as f64, 12.0);
    award(&mut given, who, &["Wingman Of The Game", "Assist Collector", "Emotional Support"], &|p| format!("{} assists{}", p.assists, most(&|q| q.assists as f64, p)));
    let who = top(&given, &|p| p.towers as f64, 3.0);
    award(&mut given, who, &["Demolition Crew", "Tower Inspector", "Structural Damage"], &|p| format!("took {} towers", p.towers));
    let who = top(&given, &|p| p.epic as f64, 3.0);
    award(&mut given, who, &["Dragon Landlord", "Smite Diff", "Objective Enjoyer"], &|p| format!("took {} dragons, barons or other big monsters", p.epic));
    let who = top(&given, &|p| p.cs_per_min, 7.0);
    award(&mut given, who, &["Minion Accountant", "PvE Champion", "Farming Simulator"], &|p| format!("{:.1} CS a minute{}", p.cs_per_min, most(&|q| q.cs_per_min, p)));
    let who = top(&given, &|p| p.wards.unwrap_or(-1.0), 30.0);
    award(&mut given, who, &["Ward Bot 3000", "Map Lamp", "Vision Dealer"], &|p| format!("a ward score of {:.0}{}", p.wards.unwrap_or(0.0), most(&|q| q.wards.unwrap_or(-1.0), p)));
    if long_game {
        // The darkest map: only counted when ward scores were recorded at all.
        let who = top(&given, &|p| p.wards.map(|w| 1000.0 - w).unwrap_or(-1.0), 990.0);
        award(&mut given, who, &["Vision Is Optional", "Fog Enjoyer", "Wards Are For Others"], &|p| format!("a ward score of {:.0}", p.wards.unwrap_or(0.0)));
    }
    let who = top(&given, &|p| if p.assists * 2 < p.kills { p.kills as f64 } else { -1.0 }, 6.0);
    award(&mut given, who, &["Kill Secured", "Last Hit Enthusiast", "Finishing Touch"], &|p| format!("{} kills on {} assists", p.kills, p.assists));
    let who = top(&given, &|p| if p.first_blood { 1.0 } else { 0.0 }, 1.0);
    award(&mut given, who, &["Early Bird", "First Blood Merchant", "Opening Act"], &|_| "drew first blood".to_string());
    let who = top(&given, &|p| p.executed as f64, 2.0);
    award(&mut given, who, &["Tower Hugger", "Died To The Scenery", "Minion Victim"], &|p| format!("died {} times to towers or monsters", p.executed));
    let who = top(&given, &|p| if long_game && p.kp < 0.35 { 1.0 - p.kp } else { -1.0 }, 0.0);
    award(&mut given, who, &["Playing Singleplayer", "Side Lane Hermit", "Do Not Disturb"], &|p| format!("in on {:.0}% of the team's kills", p.kp * 100.0));

    let mut used: std::collections::HashSet<String> = given.iter().flatten().map(|(t, _)| t.clone()).collect();
    ps.iter()
        .enumerate()
        .map(|(i, p)| {
            let (title, why) = given[i].clone().unwrap_or_else(|| {
                // Nothing stood out: say so kindly, and differently for each of them.
                let good = (p.kills + p.assists) as f64 / p.deaths.max(1) as f64 >= 3.0;
                let names: &[&str] = if good {
                    &["Solid Citizen", "Quietly Useful", "Did The Job", "No Complaints", "Steady Hands"]
                } else {
                    &["Was Also There", "Present And Accounted For", "Background Character", "Moral Support", "Honorable Mention"]
                };
                let title = (0..names.len()).map(|k| pick(&seed, i + k, names)).find(|t| !used.contains(*t)).unwrap_or(names[i % names.len()]);
                (title.to_string(), format!("{} / {} / {}", p.kills, p.deaths, p.assists))
            });
            used.insert(title.clone());
            json!({ "champion": p.champion, "name": p.name, "title": title, "why": why })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn player(name: &str, champ: &str, team: &str, k: i64, d: i64, a: i64, cs: i64) -> Value {
        json!({ "name": name, "champion": champ, "team": team, "isMe": name == "Rin", "kills": k, "deaths": d, "assists": a, "cs": cs, "level": 15, "items": [] })
    }

    fn game() -> Value {
        json!({
            "id": "2026-11-13_00-42-08", "duration": 1740.0,
            "game": { "length": 1730.0, "players": [
                player("Rin", "Rakan", "CHAOS", 2, 4, 36, 30),
                player("K", "Karthus", "CHAOS", 17, 6, 24, 270),
                player("L", "LeBlanc", "CHAOS", 16, 2, 9, 190),
                player("A", "Alistar", "ORDER", 1, 15, 14, 25),
                player("M", "Mel", "ORDER", 5, 9, 4, 240),
                player("Q", "Quiet", "ORDER", 3, 3, 4, 150)
            ] },
            "events": [
                { "kind": "FirstBlood", "killer": "Rin" },
                { "kind": "TurretKilled", "killer": "L" }, { "kind": "TurretKilled", "killer": "L" }, { "kind": "TurretKilled", "killer": "L" },
                { "kind": "ChampionKill", "killer": "Turret_T1_C_05_A", "victim": "A" }
            ]
        })
    }

    fn title_of(list: &[Value], champ: &str) -> (String, String) {
        let t = list.iter().find(|t| t["champion"] == champ).unwrap();
        (t["title"].as_str().unwrap().to_string(), t["why"].as_str().unwrap().to_string())
    }

    #[test]
    fn numbers_come_from_scoreboard_and_events() {
        let ps = numbers(&game());
        let mo = ps.iter().find(|p| p.name == "Rin").unwrap();
        // 38 takedowns out of the team's 35 kills is capped by nothing here: 2 + 36 over 35.
        assert!((mo.kp - 38.0 / 35.0).abs() < 1e-9 && mo.first_blood && mo.is_me);
        assert_eq!(ps.iter().find(|p| p.name == "L").unwrap().towers, 3);
        assert_eq!(ps.iter().find(|p| p.name == "A").unwrap().executed, 1);
    }

    #[test]
    fn each_player_gets_the_title_their_game_earned() {
        let list = for_match(&game());
        assert_eq!(list.len(), 6);
        assert!(["The Carry", "1v9 Department", "Backpack Included"].contains(&title_of(&list, "Karthus").0.as_str()));
        assert_eq!(title_of(&list, "Karthus").1, "17 kills, the most in the game");
        // Mel farms best of those left, but Karthus (who already has a title) farmed more.
        assert_eq!(title_of(&list, "Mel").1, "8.3 CS a minute");
        assert!(["Gray Screen Enjoyer", "Fountain Tourist", "Respawn Timer Tester"].contains(&title_of(&list, "Alistar").0.as_str()));
        assert!(["Wingman Of The Game", "Assist Collector", "Emotional Support"].contains(&title_of(&list, "Rakan").0.as_str()));
        assert!(["Demolition Crew", "Tower Inspector", "Structural Damage"].contains(&title_of(&list, "LeBlanc").0.as_str()));
        assert!(["Minion Accountant", "PvE Champion", "Farming Simulator"].contains(&title_of(&list, "Mel").0.as_str()));
        // Nobody shares a title, and the same game always reads the same.
        let mut names: Vec<String> = list.iter().map(|t| t["title"].as_str().unwrap().to_string()).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 6);
        assert_eq!(list, for_match(&game()));
        assert!(for_match(&json!({ "id": "x" })).is_empty());
    }
}
