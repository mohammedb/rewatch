//! Champion select as the League client reports it: each seat's role, hover and locked
//! pick, the bans, whose turn it is, and the phase with its timer. Read once a second
//! while champion select lasts (one read-only request) and kept as a timeline, from
//! which the player rebuilds champion select, so the client's window need not be
//! recorded.
//!
//! Nobody's name or account is kept: ranked lobbies hide them on purpose, and the
//! game's own record names the players anyway. Only what is on this list is read out
//! of the client's answer: seats, sides, roles, champions, summoner spells, actions,
//! the phase and its timer.

use crate::audio::Clock;
use crate::liveclient;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// How often the client is asked.
const EVERY: Duration = Duration::from_secs(1);

/// One seat in champion select.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Seat {
    /// The client's number for the seat; actions name seats by it.
    pub cell: i64,
    /// On the player's own team.
    pub ally: bool,
    /// The player's own seat.
    pub me: bool,
    /// "top", "jungle", "middle", "bottom" or "utility"; empty without roles.
    pub position: String,
    /// The champion locked in the seat. 0: none yet.
    pub champion: i64,
    /// The champion the seat is hovering: the one a player said they would like before
    /// their turn, and the one they are looking at during it. Other teams' are hidden
    /// by the client, but not always at the very last moment. 0: none.
    pub intent: i64,
    pub locked: bool,
    /// Summoner spells; 0 where none is chosen.
    pub spells: [i64; 2],
}

/// One ban.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Ban {
    /// The client's id for the action, which stays the same through champion select.
    pub id: i64,
    /// The seat that bans; -1 when the client doesn't say.
    pub cell: i64,
    pub ally: bool,
    /// Hovered while banning, or banned. 0: none.
    pub champion: i64,
    pub done: bool,
}

/// What champion select looked like at one moment.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Seconds since champion select began recording, on the clock its sound uses.
    pub t: f64,
    /// The client's phase: "PLANNING", "BAN_PICK", "FINALIZATION", "GAME_STARTING".
    pub phase: String,
    /// Seconds left on the timer (of the phase, or of the turn), when there is one.
    pub left: Option<f64>,
    /// How long that timer ran from, in seconds.
    pub total: Option<f64>,
    /// The player's side: 1 blue, 2 red, 0 not known.
    pub side: i64,
    pub seats: Vec<Seat>,
    pub bans: Vec<Ban>,
    /// The seats whose turn it is.
    pub turn: Vec<i64>,
}

/// Something that happened in champion select, for the player's timeline.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub t: f64,
    /// "phase", "ban", "hover", "pick" or "swap" (a locked champion changed hands).
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ally: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub champion: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
}

/// A champion's names: the client's internal one (its pictures' name, nearly always)
/// and the one people read.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct Champion {
    pub alias: String,
    pub name: String,
}

/// Champion select as it went.
#[derive(Default, Debug)]
pub struct Timeline {
    pub snapshots: Vec<Snapshot>,
    /// Every champion the client knows, by id, when it could be read.
    pub champions: BTreeMap<i64, Champion>,
}

fn int(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(false)
}

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

/// Read one answer from `/lol-champ-select/v1/session`, received when this PC's clock
/// said `now_ms` (milliseconds since 1970). None when it isn't one (the client answers
/// "No active delegate" outside champion select). `t` is left at 0.
pub fn parse(v: &Value, now_ms: f64) -> Option<Snapshot> {
    let me = v.get("localPlayerCellId")?.as_i64()?;
    let timer = v.get("timer")?;
    let phase = text(timer, "phase").to_string();
    // The actions come in turns: a list of lists.
    let actions: Vec<&Value> = v
        .get("actions")
        .and_then(|a| a.as_array())
        .map(|turns| turns.iter().filter_map(|t| t.as_array()).flatten().collect())
        .unwrap_or_default();
    let of_kind = |kind: &'static str| actions.iter().copied().filter(move |a| text(a, "type") == kind);
    let team = |key: &str| v.get(key).and_then(|t| t.as_array()).cloned().unwrap_or_default();
    let (mine, theirs) = (team("myTeam"), team("theirTeam"));
    let allies: BTreeSet<i64> = mine.iter().map(|s| int(s, "cellId")).collect();

    let seat = |s: &Value, ally: bool| {
        let cell = int(s, "cellId");
        let picks: Vec<&Value> = of_kind("pick").filter(|a| int(a, "actorCellId") == cell).collect();
        let done = picks.iter().find(|a| flag(a, "completed"));
        let mut champion = int(s, "championId");
        // Without a pick of its own (champions handed out, as in ARAM), a champion in
        // the seat is the seat's.
        let locked = if picks.is_empty() { champion != 0 } else { done.is_some() };
        if champion == 0 {
            champion = done.map_or(0, |a| int(a, "championId"));
        }
        // The seat says what it hovers; its pick under way says it too.
        let hovered = picks
            .iter()
            .filter(|a| flag(a, "isInProgress") && !flag(a, "completed"))
            .map(|a| int(a, "championId"))
            .find(|&c| c != 0);
        let intent = match int(s, "championPickIntent") {
            0 => hovered.unwrap_or(0),
            c => c,
        };
        Seat {
            cell,
            ally,
            me: ally && cell == me,
            position: text(s, "assignedPosition").to_ascii_lowercase(),
            champion,
            intent,
            locked,
            spells: [int(s, "spell1Id"), int(s, "spell2Id")],
        }
    };
    let mut seats: Vec<Seat> = mine.iter().map(|s| seat(s, true)).collect();
    seats.extend(theirs.iter().map(|s| seat(s, false)));

    let mut bans: Vec<Ban> = of_kind("ban")
        .map(|a| {
            let cell = a.get("actorCellId").and_then(|c| c.as_i64()).unwrap_or(-1);
            Ban { id: int(a, "id"), cell, ally: flag(a, "isAllyAction") || allies.contains(&cell), champion: int(a, "championId"), done: flag(a, "completed") }
        })
        .collect();
    if bans.is_empty() {
        // Some modes only list the banned champions.
        let list = |key: &str| v.pointer(&format!("/bans/{key}")).and_then(|b| b.as_array()).cloned().unwrap_or_default();
        for (i, c) in list("myTeamBans").iter().enumerate() {
            bans.push(Ban { id: -1 - i as i64, cell: -1, ally: true, champion: c.as_i64().unwrap_or(0), done: true });
        }
        for (i, c) in list("theirTeamBans").iter().enumerate() {
            bans.push(Ban { id: -101 - i as i64, cell: -1, ally: false, champion: c.as_i64().unwrap_or(0), done: true });
        }
    }

    // While players plan, the bans already count as under way, though nobody's turn
    // has come.
    let mut turn: Vec<i64> = actions
        .iter()
        .filter(|a| phase == "BAN_PICK" && flag(a, "isInProgress") && !flag(a, "completed"))
        .filter(|a| matches!(text(a, "type"), "pick" | "ban"))
        .map(|a| int(a, "actorCellId"))
        .collect();
    turn.sort_unstable();
    turn.dedup();

    // The client works out the time left whenever champion select changes, at
    // `internalNowInEpochMs` on this PC's clock, and repeats it until the next change.
    let ms = |key: &str| timer.get(key).and_then(|x| x.as_f64()).filter(|x| x.is_finite());
    let timed = !flag(timer, "isInfinite");
    let age = ms("internalNowInEpochMs").filter(|&at| at > 0.0).map_or(0.0, |at| (now_ms - at).max(0.0));
    let left = timed.then(|| ms("adjustedTimeLeftInPhase")).flatten().map(|l| round((l - age).max(0.0) / 1000.0));
    let total = timed.then(|| ms("totalTimeInPhase")).flatten().filter(|&x| x > 0.0).map(|x| round(x / 1000.0));
    Some(Snapshot {
        t: 0.0,
        phase,
        left,
        total,
        side: mine.first().map(|s| int(s, "team")).unwrap_or(0),
        seats,
        bans,
        turn,
    })
}

fn round(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// Whether a new read is worth keeping: something changed, or the timer did something
/// other than run down (a new turn, more time).
fn worth_keeping(last: Option<&Snapshot>, new: &Snapshot) -> bool {
    let Some(last) = last else { return true };
    let same = last.phase == new.phase
        && last.total == new.total
        && last.side == new.side
        && last.seats == new.seats
        && last.bans == new.bans
        && last.turn == new.turn;
    if !same {
        return true;
    }
    match (last.left, new.left) {
        (Some(a), Some(b)) => ((a - (new.t - last.t)).max(0.0) - b).abs() > 1.5,
        (None, None) => false,
        _ => true,
    }
}

/// Every champion the client knows, by id, from its own game data (read-only).
fn champion_names(league_dir: &std::path::Path) -> Option<BTreeMap<i64, Champion>> {
    let list = liveclient::client_get(league_dir, "/lol-game-data/assets/v1/champion-summary.json")?;
    let map: BTreeMap<i64, Champion> = list
        .as_array()?
        .iter()
        .filter(|c| int(c, "id") > 0)
        .map(|c| (int(c, "id"), Champion { alias: text(c, "alias").to_string(), name: text(c, "name").to_string() }))
        .collect();
    (!map.is_empty()).then_some(map)
}

/// Follow champion select until `stop` is set: ask the client once a second and keep
/// each read that changed something.
pub fn follow(league_dir: Option<PathBuf>, clock: Clock, stop: Arc<AtomicBool>) -> Timeline {
    let mut timeline = Timeline::default();
    let mut named = false;
    while !stop.load(Ordering::Relaxed) {
        if let Some(dir) = &league_dir {
            let read = liveclient::client_get(dir, "/lol-champ-select/v1/session");
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
            // A read that failed, or one that isn't champion select (the game is being
            // launched), changes nothing: the board stays as it last was.
            if let Some(mut s) = read.as_ref().and_then(|v| parse(v, now_ms)) {
                s.t = round(clock.secs());
                if worth_keeping(timeline.snapshots.last(), &s) {
                    timeline.snapshots.push(s);
                }
            }
            if !named {
                if let Some(names) = champion_names(dir) {
                    timeline.champions = names;
                    named = true;
                }
            }
        }
        for _ in 0..(EVERY.as_millis() / 100) {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    timeline
}

/// What happened, from one look to the next: the phases, bans, hovers on the player's
/// side, locked picks and champions changing hands afterwards.
pub fn events(snapshots: &[Snapshot]) -> Vec<Event> {
    let mut out = Vec::new();
    let event = |t: f64, kind: &str| Event { t, kind: kind.into(), cell: None, ally: None, champion: None, phase: None };
    let mut prev: Option<&Snapshot> = None;
    for s in snapshots {
        if prev.is_none_or(|p| p.phase != s.phase) && !s.phase.is_empty() {
            out.push(Event { phase: Some(s.phase.clone()), ..event(s.t, "phase") });
        }
        for b in &s.bans {
            let before = prev.and_then(|p| p.bans.iter().find(|x| x.id == b.id));
            let was_done = before.is_some_and(|x| x.done && x.champion == b.champion);
            if b.done && b.champion != 0 && !was_done {
                out.push(Event { cell: (b.cell >= 0).then_some(b.cell), ally: Some(b.ally), champion: Some(b.champion), ..event(s.t, "ban") });
            }
        }
        for seat in &s.seats {
            let before = prev.and_then(|p| p.seats.iter().find(|x| x.cell == seat.cell));
            let at = |kind: &str, champion: i64| Event { cell: Some(seat.cell), ally: Some(seat.ally), champion: Some(champion), ..event(s.t, kind) };
            // A player who swapped pick order brings their hover to the new seat: not news.
            let moved = || prev.is_some_and(|p| moved_here(p, s, seat));
            match before {
                _ if seat.locked && seat.champion == 0 => {}
                Some(b) if seat.locked && b.locked && b.champion != seat.champion => out.push(at("swap", seat.champion)),
                Some(b) if seat.locked && b.locked => {}
                _ if seat.locked => out.push(at("pick", seat.champion)),
                Some(b) if seat.ally && shown(seat) != 0 && shown(seat) != shown(b) && !moved() => out.push(at("hover", shown(seat))),
                None if seat.ally && shown(seat) != 0 => out.push(at("hover", shown(seat))),
                _ => {}
            }
        }
        prev = Some(s);
    }
    out
}

/// What a seat shows: its champion, or else the one it is hovering.
fn shown(s: &Seat) -> i64 {
    if s.champion != 0 { s.champion } else { s.intent }
}

/// Whether the player in `seat` sat elsewhere in the look before, having swapped pick
/// order: another seat on that side showed this champion then and doesn't now, and this
/// seat now has the role that one had. Where roles aren't given, the champion alone tells.
fn moved_here(prev: &Snapshot, now: &Snapshot, seat: &Seat) -> bool {
    let champion = shown(seat);
    prev.seats.iter().any(|other| {
        other.ally == seat.ally
            && other.cell != seat.cell
            && shown(other) == champion
            && !now.seats.iter().any(|x| x.cell == other.cell && shown(x) == champion)
            && (seat.position.is_empty() || other.position.is_empty() || seat.position == other.position)
    })
}

/// The file kept with the game: the timeline, what happened in it, and the names of the
/// champions in it.
pub fn to_json(timeline: &Timeline) -> Value {
    let mut used = BTreeSet::new();
    for s in &timeline.snapshots {
        used.extend(s.seats.iter().flat_map(|x| [x.champion, x.intent]));
        used.extend(s.bans.iter().map(|b| b.champion));
    }
    let champions: BTreeMap<String, &Champion> =
        used.iter().filter_map(|id| timeline.champions.get(id).map(|c| (id.to_string(), c))).collect();
    json!({
        "version": 1,
        "champions": champions,
        "snapshots": timeline.snapshots,
        "events": events(&timeline.snapshots),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seat(cell: i64, ally: bool, champion: i64, intent: i64, locked: bool) -> Seat {
        Seat { cell, ally, me: cell == 2, position: String::new(), champion, intent, locked, spells: [4, 12] }
    }

    fn snap(t: f64, phase: &str, seats: Vec<Seat>, bans: Vec<Ban>) -> Snapshot {
        Snapshot { t, phase: phase.into(), left: Some(30.0), total: Some(30.0), side: 1, seats, bans, turn: Vec::new() }
    }

    #[test]
    fn only_changes_are_kept() {
        let a = snap(1.0, "BAN_PICK", vec![seat(2, true, 0, 0, false)], Vec::new());
        // The timer running down is not a change.
        let b = Snapshot { t: 2.0, left: Some(29.0), ..a.clone() };
        assert!(!worth_keeping(Some(&a), &b));
        // The timer starting again (a new turn with nothing else to see yet) is.
        let ending = Snapshot { left: Some(3.0), ..a.clone() };
        let c = Snapshot { t: 2.0, left: Some(30.0), ..a.clone() };
        assert!(worth_keeping(Some(&ending), &c));
        // So is anything on the board.
        let d = Snapshot { t: 2.0, left: Some(29.0), seats: vec![seat(2, true, 103, 0, false)], ..a.clone() };
        assert!(worth_keeping(Some(&a), &d));
        assert!(worth_keeping(None, &a));
    }

    #[test]
    fn what_happened_is_told_from_one_look_to_the_next() {
        let ban = |id, cell, ally, champion, done| Ban { id, cell, ally, champion, done };
        let snaps = vec![
            snap(0.5, "PLANNING", vec![seat(2, true, 0, 103, false), seat(7, false, 0, 0, false)], vec![ban(1, 2, true, 0, false)]),
            snap(30.0, "BAN_PICK", vec![seat(2, true, 0, 103, false), seat(7, false, 0, 0, false)], vec![ban(1, 2, true, 157, false)]),
            snap(40.0, "BAN_PICK", vec![seat(2, true, 0, 103, false), seat(7, false, 0, 0, false)], vec![ban(1, 2, true, 157, true)]),
            snap(50.0, "BAN_PICK", vec![seat(2, true, 81, 103, false), seat(7, false, 0, 0, false)], vec![ban(1, 2, true, 157, true)]),
            snap(55.0, "BAN_PICK", vec![seat(2, true, 81, 103, true), seat(7, false, 0, 0, false)], vec![ban(1, 2, true, 157, true)]),
            snap(70.0, "FINALIZATION", vec![seat(2, true, 81, 103, true), seat(7, false, 30, 0, true)], vec![ban(1, 2, true, 157, true)]),
            snap(80.0, "FINALIZATION", vec![seat(2, true, 222, 103, true), seat(7, false, 30, 0, true)], vec![ban(1, 2, true, 157, true)]),
        ];
        let all = events(&snaps);
        let told: Vec<(f64, &str, Option<i64>)> = all.iter().map(|e| (e.t, e.kind.as_str(), e.champion)).collect();
        assert_eq!(
            told,
            [
                (0.5, "phase", None),
                // The player's wish before their turn shows on their side.
                (0.5, "hover", Some(103)),
                (30.0, "phase", None),
                // A ban counts once it is locked, not while it is hovered.
                (40.0, "ban", Some(157)),
                (50.0, "hover", Some(81)),
                (55.0, "pick", Some(81)),
                (70.0, "phase", None),
                // The other side's pick shows once it is locked; their hovers never do.
                (70.0, "pick", Some(30)),
                (80.0, "swap", Some(222)),
            ]
        );
    }

    #[test]
    fn a_hover_that_moves_with_its_player_is_not_told_again() {
        let role = |mut s: Seat, position: &str| {
            s.position = position.into();
            s
        };
        let mid = role(seat(5, true, 0, 39, false), "middle");
        let support = role(seat(7, true, 0, 0, false), "utility");
        let before = snap(1.0, "BAN_PICK", vec![mid.clone(), support.clone()], Vec::new());
        let hovers = |after: Snapshot| -> Vec<(f64, Option<i64>, Option<i64>)> {
            events(&[before.clone(), after]).iter().filter(|e| e.kind == "hover").map(|e| (e.t, e.cell, e.champion)).collect()
        };
        // They swap pick order: each takes the other's seat, with role, spells and hover.
        let swapped = snap(2.0, "BAN_PICK", vec![Seat { cell: 5, ..support.clone() }, Seat { cell: 7, ..mid.clone() }], Vec::new());
        assert_eq!(hovers(swapped), [(1.0, Some(5), Some(39))]);
        // Support taking up the champion Mid has just let go of is news, though.
        let taken = snap(2.0, "BAN_PICK", vec![Seat { intent: 40, ..mid.clone() }, Seat { intent: 39, ..support.clone() }], Vec::new());
        assert_eq!(hovers(taken), [(1.0, Some(5), Some(39)), (2.0, Some(5), Some(40)), (2.0, Some(7), Some(39))]);
    }

    /// Real answers from the League client, one for each change: a ranked flex draft and
    /// a Practice Tool game. Names, accounts, skins and ids were taken out and the clock
    /// moved to another day; `at` is when each answer came, on that clock.
    const DRAFT: &str = include_str!("../testdata/champselect-draft.jsonl");
    const PRACTICE: &str = include_str!("../testdata/champselect-practice.jsonl");

    fn answers(text: &str) -> Vec<Snapshot> {
        let mut first = None;
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|line| {
                let v: Value = serde_json::from_str(line).unwrap();
                let at = v["at"].as_f64().unwrap();
                let first = *first.get_or_insert(at);
                let mut s = parse(&v["session"], at).expect("an answer from champion select");
                s.t = round((at - first) / 1000.0);
                s
            })
            .collect()
    }

    #[test]
    fn a_ranked_draft_reads_as_the_client_showed_it() {
        let snaps = answers(DRAFT);
        // Red side, the fourth of its five seats.
        assert!(snaps.iter().all(|s| s.side == 2 && s.seats.len() == 10));
        assert!(snaps.iter().all(|s| s.seats.iter().filter(|x| x.me).map(|x| x.cell).eq([8])));
        // While everyone plans, their bans already count as under way: it's nobody's turn.
        let planning: Vec<&Snapshot> = snaps.iter().filter(|s| s.phase == "PLANNING").collect();
        assert_eq!(planning.len(), 4);
        assert!(planning.iter().all(|s| s.turn.is_empty() && s.total == Some(12.0)));
        // Then all ten ban at once.
        let banning = snaps.iter().find(|s| s.phase == "BAN_PICK").unwrap();
        assert_eq!(banning.turn, (0..10).collect::<Vec<i64>>());
        // The client works the timer out when something changes and repeats it: this
        // answer came 7.4 s after it was worked out, when 31.4 s were left.
        let first_pick = snaps.iter().find(|s| s.turn == [0]).unwrap();
        assert_eq!((first_pick.left, first_pick.total), (Some(24.04), Some(31.4)));
        // The other side's bans show once all are revealed.
        let enemy_bans = |s: &Snapshot| s.bans.iter().filter(|b| !b.ally && b.done).count();
        assert_eq!(enemy_bans(banning), 0);
        assert_eq!(enemy_bans(first_pick), 5);
        // A last-second hover of theirs came through (cell 2, just before it locked).
        assert!(snaps.iter().any(|s| s.seats.iter().any(|x| !x.ally && !x.locked && x.intent != 0)));
        // How it ended: every seat locked, every ban made.
        let last = snaps.iter().rev().find(|s| s.phase == "FINALIZATION").unwrap();
        let champions: Vec<(i64, i64)> = last.seats.iter().map(|x| (x.cell, x.champion)).collect();
        assert_eq!(champions, [(5, 89), (6, 45), (7, 42), (8, 517), (9, 154), (0, 145), (1, 54), (2, 62), (3, 157), (4, 43)]);
        assert!(last.seats.iter().all(|x| x.locked));
        assert_eq!(last.bans.iter().filter(|b| b.done && b.champion != 0).count(), 10);
        assert_eq!(last.seats.iter().find(|x| x.cell == 7).unwrap().position, "middle");

        let told = events(&snaps);
        let count = |kind: &str| told.iter().filter(|e| e.kind == kind).count();
        assert_eq!((count("pick"), count("ban"), count("swap")), (10, 10, 0));
        // Hovers are told for the player's side only.
        assert!(count("hover") > 3);
        assert!(told.iter().filter(|e| e.kind == "hover").all(|e| e.ally == Some(true)));
        // Mid swapped pick order with Support (cells 5 and 7) while hovering Irelia: told
        // once, not again from the new seat.
        assert_eq!(told.iter().filter(|e| e.kind == "hover" && e.champion == Some(39)).count(), 1);
        let phases: Vec<&str> = told.iter().filter_map(|e| e.phase.as_deref()).collect();
        assert_eq!(phases, ["PLANNING", "BAN_PICK", "FINALIZATION", "GAME_STARTING"]);
    }

    #[test]
    fn a_practice_tool_game_reads_too() {
        let snaps = answers(PRACTICE);
        assert!(snaps.iter().all(|s| s.side == 1));
        assert_eq!(snaps.last().unwrap().phase, "GAME_STARTING");
        let mine = snaps.last().unwrap().seats.iter().find(|x| x.me).unwrap();
        assert_eq!((mine.cell, mine.champion, mine.locked), (0, 157, true));
        // The empty seat across "locks in" nothing, and isn't told as a pick.
        let told = events(&snaps);
        let picks: Vec<(Option<i64>, Option<i64>)> = told.iter().filter(|e| e.kind == "pick").map(|e| (e.cell, e.champion)).collect();
        assert_eq!(picks, [(Some(0), Some(157))]);
        assert!(told.iter().any(|e| e.kind == "hover" && e.champion == Some(157)));
    }

    #[test]
    fn an_answer_repeated_a_second_later_is_not_kept_again() {
        let v: Value = serde_json::from_str(DRAFT.lines().next().unwrap()).unwrap();
        let at = v["at"].as_f64().unwrap();
        let a = parse(&v["session"], at).unwrap();
        let mut b = parse(&v["session"], at + 1000.0).unwrap();
        b.t = a.t + 1.0;
        assert!((a.left.unwrap() - b.left.unwrap() - 1.0).abs() < 0.02);
        assert!(!worth_keeping(Some(&a), &b));
    }

    /// Writes the interface's sample champion select (public/mock/draft-picks.json) from
    /// the ranked draft above, with the client's names for its champions when they are
    /// at hand: `cargo test --lib -- --ignored sample_for_the_interface`.
    #[test]
    #[ignore]
    fn sample_for_the_interface() {
        let names = std::env::var("REWATCH_CHAMPION_NAMES").ok().and_then(|p| std::fs::read_to_string(p).ok());
        let champions = names
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .map(|c| (int(c, "id"), Champion { alias: text(c, "alias").to_string(), name: text(c, "name").to_string() }))
            .collect();
        let timeline = Timeline { snapshots: answers(DRAFT), champions };
        let out = concat!(env!("CARGO_MANIFEST_DIR"), "/../public/mock/draft-picks.json");
        std::fs::write(out, serde_json::to_string(&to_json(&timeline)).unwrap()).unwrap();
    }
}
