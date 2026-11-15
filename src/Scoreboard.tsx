import { Bug, Castle, Coins, Flame, Gem, Skull, Swords, Table2, Worm, X } from "lucide-react";
import { useMemo } from "react";
import { Portrait } from "./ChampIcon";
import { clock } from "./format";
import { LpDelta, queueLabel, standing, TierTag } from "./Rank";
import { ItemSlots, Kda, KdaRatio, MultiChip, RuneIcon, SCORE_HINT, ScoreBadge, scoresOf, short, SpellIcon, useLookup, type PlayerScore } from "./Stats";
import type { MatchFull, PgPlayer, PgTeam, PlayerTitle, RankEntry } from "./types";

// The scoreboard: a compact one for the side panel and the whole table over the video,
// from Riot's record of the game when there is one, else from the live feed.

/** A player's rank in the queue the game was played in: Flex for Flex games, else Solo/Duo, else whichever they have. */
export function rankFor(ranks: RankEntry[], queueId?: number | null): RankEntry | null {
  const first = queueId === 440 ? "RANKED_FLEX_SR" : "RANKED_SOLO_5x5";
  return ranks.find((r) => r.queue === first) ?? ranks.find((r) => r.tier) ?? null;
}

interface Row {
  key: string;
  team: string;
  isMe: boolean;
  champion: string;
  championKey: string;
  name: string;
  tag: string;
  level: number;
  k: number;
  d: number;
  a: number;
  cs: number;
  items: number[] | { id: number; name: string }[];
  pg: PgPlayer | null;
  score: PlayerScore | null;
  /** Undefined when nobody's rank was read for this game; null when unranked. */
  rank?: RankEntry | null;
  title?: PlayerTitle;
}

function rowsOf(match: MatchFull, titles: Map<string, PlayerTitle>): Row[] {
  const pg = match.postgame ?? null;
  const live = match.game?.players ?? [];
  const ranks = match.playerRanks ?? null;
  const queueId = pg?.queueId ?? match.game?.queueId ?? null;
  const scores = pg ? scoresOf(pg) : null;
  // Riot's names for the champions and players can differ from the live feed's, so match
  // on the picture's key and team first.
  const rankOf = (team: string, championKey: string, champion: string, name: string) => {
    if (!ranks) return undefined;
    const row =
      ranks.players.find((r) => r.team === team && !!championKey && r.championKey === championKey) ??
      ranks.players.find((r) => r.team === team && r.champion === champion) ??
      ranks.players.find((r) => !!name && r.name === name);
    return row ? rankFor(row.ranks, queueId) : null;
  };
  if (pg && pg.players.length) {
    return pg.players.map((p) => {
      const lv = live.find((l) => l.team === p.team && ((!!p.championKey && l.championKey === p.championKey) || l.champion === p.champion));
      const champion = p.champion || lv?.champion || "Unknown";
      return {
        key: `p${p.id}`,
        team: p.team,
        isMe: p.isMe,
        champion,
        championKey: p.championKey || lv?.championKey || "",
        name: p.name || lv?.name || "",
        tag: p.tag,
        level: p.level,
        k: p.kills,
        d: p.deaths,
        a: p.assists,
        cs: p.cs,
        items: p.items,
        pg: p,
        score: scores?.get(p.id) ?? null,
        rank: rankOf(p.team, p.championKey, champion, p.name),
        title: titles.get(champion) ?? (lv ? titles.get(lv.champion) : undefined),
      };
    });
  }
  return live.map((p, i) => ({
    key: `l${i}`,
    team: p.team,
    isMe: p.isMe,
    champion: p.champion,
    championKey: p.championKey,
    name: p.name,
    tag: "",
    level: p.level,
    k: p.kills,
    d: p.deaths,
    a: p.assists,
    cs: p.cs,
    items: p.items,
    pg: null,
    score: null,
    rank: rankOf(p.team, p.championKey, p.champion, p.name),
    title: titles.get(p.champion),
  }));
}

type Res = "win" | "lose" | "";

function teamResult(match: MatchFull, team: string, myTeam?: string): Res {
  const t = match.postgame?.teams.find((x) => x.team === team);
  if (t) return t.win ? "win" : "lose";
  const r = match.game?.result;
  if (!r || !myTeam) return "";
  return (team === myTeam) === (r === "Win") ? "win" : "lose";
}

function useBoard(match: MatchFull, titles: Map<string, PlayerTitle>) {
  const rows = useMemo(() => rowsOf(match, titles), [match, titles]);
  const myTeam = rows.find((r) => r.isMe)?.team;
  const teams = [...new Set(rows.map((r) => r.team))].sort((a, b) => (a === myTeam ? -1 : b === myTeam ? 1 : a.localeCompare(b)));
  return { rows, myTeam, teams };
}

function rankTip(r: Row, at: number | null | undefined, queueId: number | null | undefined): string {
  const e = r.rank;
  const tip = e ? `${standing(e)} in ${queueLabel(e.queue)}${e.provisional ? ", in placements" : ""}` : `No ranked standing in ${queueId === 440 ? "Flex" : "Solo/Duo"} or the other queue`;
  return at ? `${tip}. Read ${new Date(at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.` : tip;
}

const RES_WORD: Record<Res, string> = { win: "Victory", lose: "Defeat", "": "" };

// ------------------------------------------------------------------ the side panel's

/** Both teams, compact: who, their rank, KDA and CS, and the MVP and ACE. */
export function TeamBoard({ match, titles, onOpenFull }: { match: MatchFull; titles: Map<string, PlayerTitle>; onOpenFull?: () => void }) {
  const { rows, myTeam, teams } = useBoard(match, titles);
  const queueId = match.postgame?.queueId ?? match.game?.queueId;
  if (!rows.length) return <p className="hint-note">No scoreboard for this recording.</p>;
  return (
    <div className="tb">
      {teams.map((team) => {
        const list = rows.filter((r) => r.team === team);
        const res = teamResult(match, team, myTeam);
        const kills = list.reduce((s, r) => s + r.k, 0);
        return (
          <div key={team} className={`tb-team ${res}`}>
            <div className="tb-cap">
              <b>{RES_WORD[res] || (team === myTeam ? "Your team" : "Enemy team")}</b>
              {res && <span>{team === myTeam ? "Your team" : "Enemy team"}</span>}
              <span className="grow" />
              <span className="num" title="Kills">
                <Swords size={12} aria-hidden /> {kills}
              </span>
            </div>
            {list.map((r) => (
              <div key={r.key} className={`tb-row ${r.isMe ? "me" : ""}`}>
                <Portrait championKey={r.championKey} name={r.champion} size={32} square level={r.level} />
                <span className="tb-who">
                  <b>
                    <span className="nm">{r.champion}</span>
                    {r.score && (r.score.mvp || r.score.ace) && <span className={`badge ${r.score.mvp ? "mvp" : "ace"}`}>{r.score.mvp ? "MVP" : "ACE"}</span>}
                  </b>
                  <small>
                    <span className="pn">{r.isMe ? "You" : r.name}</span>
                    {r.rank !== undefined && <TierTag r={r.rank} size={12} title={rankTip(r, match.playerRanks?.at, queueId)} />}
                  </small>
                  {r.title && (
                    <em className="ptitle" title={r.title.why}>
                      {r.title.title}
                    </em>
                  )}
                </span>
                <span className="tb-kda">
                  <Kda k={r.k} d={r.d} a={r.a} />
                  <KdaRatio k={r.k} d={r.d} a={r.a} unit={false} />
                </span>
                <span className="tb-cs">
                  <b className="num">{r.cs}</b>
                  <small>CS</small>
                </span>
              </div>
            ))}
          </div>
        );
      })}
      {onOpenFull && (
        <button className="btn sm tb-full" onClick={onOpenFull} title="Damage, gold, vision, runes and items for all ten (O)">
          <Table2 size={14} aria-hidden />
          Full scoreboard
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the whole table

function Objectives({ t, kills, gold }: { t: PgTeam | null; kills: number; gold: number | null }) {
  const items: [string, number | string, React.ReactNode][] = [["Kills", kills, <Swords key="k" size={14} />]];
  if (gold != null) items.push(["Gold", short(gold), <Coins key="g" size={14} />]);
  if (t) {
    items.push(["Towers", t.towers, <Castle key="t" size={14} />]);
    items.push(["Inhibitors", t.inhibitors, <Gem key="i" size={14} />]);
    items.push(["Dragons", t.dragons, <Flame key="d" size={14} />]);
    items.push(["Barons", t.barons, <Worm key="b" size={14} />]);
    if (t.grubs || t.heralds) items.push([t.grubs ? "Void grubs" : "Rift Heralds", t.grubs || t.heralds, <Bug key="v" size={14} />]);
    if (t.atakhan) items.push(["Atakhan", t.atakhan, <Skull key="a" size={14} />]);
  }
  return (
    <span className="mb-obj">
      {items.map(([label, v, icon]) => (
        <span key={label} title={label} aria-label={`${label}: ${v}`}>
          {icon}
          <b className="num">{v}</b>
        </span>
      ))}
    </span>
  );
}

function TeamTable({
  match,
  team,
  rows,
  res,
  mine,
  maxDmg,
  mins,
}: {
  match: MatchFull;
  team: string;
  rows: Row[];
  res: Res;
  mine: boolean;
  maxDmg: number;
  mins: number;
}) {
  const champs = useLookup("champions");
  const pg = match.postgame ?? null;
  const full = rows.every((r) => r.pg);
  const t = pg?.teams.find((x) => x.team === team) ?? null;
  const kills = rows.reduce((s, r) => s + r.k, 0);
  const gold = full ? rows.reduce((s, r) => s + (r.pg?.gold ?? 0), 0) : null;
  const bans = (t?.bans ?? []).filter((id) => id > 0);
  const queueId = pg?.queueId ?? match.game?.queueId;
  return (
    <section className={`mb-team ${res} ${mine ? "mine" : ""}`}>
      <div className="mb-th">
        {res && <b className="mb-tres">{RES_WORD[res]}</b>}
        <span className="mb-side">
          {mine ? "Your team" : "Enemy team"}
          {t && (t.teamId === 100 ? " · blue side" : t.teamId === 200 ? " · red side" : "")}
        </span>
        <Objectives t={t} kills={kills} gold={gold} />
        <span className="grow" />
        {bans.length > 0 && (
          <span className="mb-bans" aria-label="Bans">
            <small>Bans</small>
            {bans.map((id, i) => {
              const c = champs?.get(id);
              return <Portrait key={`${id}-${i}`} championKey={c?.icon} name={c?.name ?? `Champion ${id}`} size={22} square />;
            })}
          </span>
        )}
      </div>
      <table className="mb-t">
        <thead>
          <tr>
            <th scope="col">Champion</th>
            {full && (
              <th scope="col" className="c" title={SCORE_HINT}>
                Score
              </th>
            )}
            <th scope="col">KDA</th>
            {full && <th scope="col">Damage to champions</th>}
            {full && (
              <th scope="col" className="n">
                Gold
              </th>
            )}
            <th scope="col" className="n">
              CS
            </th>
            {full && (
              <th scope="col" className="n">
                Vision
              </th>
            )}
            <th scope="col">Items</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const p = r.pg;
            return (
              <tr key={r.key} className={r.isMe ? "me" : ""}>
                <td className="mb-c">
                  <div className="mb-who">
                    <Portrait championKey={r.championKey} name={r.champion} size={40} square level={r.level} />
                    {p && (
                      <span className="mb-sr">
                        <span className="mb-sp">
                          <SpellIcon id={p.spells[0] ?? 0} size={19} />
                          <SpellIcon id={p.spells[1] ?? 0} size={19} />
                        </span>
                        <span className="mb-rn">
                          <RuneIcon id={p.runes.keystone} size={19} />
                          <RuneIcon id={p.runes.secondary} size={14} path />
                        </span>
                      </span>
                    )}
                    <span className="mb-nm">
                      <b>
                        {r.champion}
                        {r.isMe && <i className="you">You</i>}
                      </b>
                      {r.name && (
                        <small className="pn">
                          {r.name}
                          {r.tag && <em>#{r.tag}</em>}
                        </small>
                      )}
                      <span className="mb-tags">
                        {r.rank !== undefined && <TierTag r={r.rank} size={13} title={rankTip(r, match.playerRanks?.at, queueId)} />}
                        {p && <MultiChip n={p.largestMulti} />}
                        {p?.firstBlood && <span className="mchip fb">First blood</span>}
                        {r.title && (
                          <em className="ptitle" title={r.title.why}>
                            {r.title.title}
                          </em>
                        )}
                      </span>
                    </span>
                  </div>
                </td>
                {full && <td className="c">{r.score && <ScoreBadge s={r.score} />}</td>}
                <td>
                  <div className="mb-kda">
                    <Kda k={r.k} d={r.d} a={r.a} />
                    <span>
                      <KdaRatio k={r.k} d={r.d} a={r.a} />
                      {p?.kp != null && <small className="kp"> · {Math.round(p.kp * 100)}% KP</small>}
                    </span>
                  </div>
                </td>
                {full && p && (
                  <td>
                    <div className="mb-dmg" title={`${p.damage.toLocaleString()} to champions: ${p.physical.toLocaleString()} physical, ${p.magic.toLocaleString()} magic, ${p.true.toLocaleString()} true. ${p.taken.toLocaleString()} taken, ${p.mitigated.toLocaleString()} more blocked.`}>
                      <span className="mb-dv">
                        <b className="num">{p.damage.toLocaleString()}</b>
                        {p.dmgShare != null && <small className="num">{Math.round(p.dmgShare * 100)}%</small>}
                      </span>
                      <span className="mb-bar" aria-hidden>
                        <i style={{ width: `${(p.damage / maxDmg) * 100}%` }} />
                      </span>
                      <small className="num">{short(p.taken)} taken</small>
                    </div>
                  </td>
                )}
                {full && p && (
                  <td className="n">
                    <b className="num">{short(p.gold)}</b>
                    <small className="num">{Math.round(p.gold / mins)}/min</small>
                  </td>
                )}
                <td className="n">
                  <b className="num">{r.cs}</b>
                  <small className="num">{(r.cs / mins).toFixed(1)}/min</small>
                </td>
                {full && p && (
                  <td className="n">
                    <b className="num">{p.vision}</b>
                    <small className="num" title="Wards placed, wards destroyed and control wards bought">
                      {p.wardsPlaced} · {p.wardsKilled} · {p.controlWards}
                    </small>
                  </td>
                )}
                <td>
                  <ItemSlots items={r.items} size={26} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/** Both teams in full, over the video: the post-game screen, with what Riot's record adds. */
export function MatchBoard({ match, titles, onClose }: { match: MatchFull; titles: Map<string, PlayerTitle>; onClose: () => void }) {
  const { rows, myTeam, teams } = useBoard(match, titles);
  const pg = match.postgame ?? null;
  const len = pg?.duration ?? match.game?.length ?? match.duration;
  const mins = Math.max(1, len / 60);
  const maxDmg = Math.max(1, ...rows.map((r) => r.pg?.damage ?? 0));
  const res: Res = match.game?.result === "Win" ? "win" : match.game?.result === "Lose" ? "lose" : "";
  const me = rows.find((r) => r.isMe);
  const queue = match.game?.queueName || (match.rank ? queueLabel(match.rank.queue) : "") || pg?.mode || "Game";
  const date = new Date(match.startedEpochMs).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="mb" role="region" aria-label="Scoreboard">
      <header className={`mb-h ${res}`}>
        <div className="mb-res">{RES_WORD[res] || "Game over"}</div>
        <div className="mb-meta">
          <b>{queue}</b>
          <span className="num">{clock(len)}</span>
          <span>{date}</span>
          {pg?.patch && <span>Patch {pg.patch}</span>}
        </div>
        {match.rank && (
          <div className="mb-rank">
            <TierTag r={match.rank} lp size={22} title={`${queueLabel(match.rank.queue)}: ${standing(match.rank)}`} />
            <LpDelta rank={match.rank} />
          </div>
        )}
        {me?.score && (
          <div className="mb-me">
            <small>Your score</small>
            <ScoreBadge s={me.score} />
          </div>
        )}
        <span className="grow" />
        <button className="btn sq quiet" onClick={onClose} aria-label="Close the scoreboard" title="Close (Esc or O)">
          <X size={18} />
        </button>
      </header>
      {teams.map((team) => (
        <TeamTable
          key={team}
          match={match}
          team={team}
          rows={rows.filter((r) => r.team === team)}
          res={teamResult(match, team, myTeam)}
          mine={team === myTeam}
          maxDmg={maxDmg}
          mins={mins}
        />
      ))}
      <p className="mb-foot">{pg ? SCORE_HINT : "Damage, gold, vision, runes and the score come with Riot's record of the game, a minute or two after it."}</p>
    </div>
  );
}
