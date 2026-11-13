import { BarChart3, ShieldAlert, Skull, Sparkles, Swords, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Portrait } from "./ChampIcon";
import { laneName, when } from "./format";
import type { TrendMatch } from "./types";

interface Props {
  onOpen: (id: string) => void;
}

const CAUSES: Record<string, string> = {
  no_vision: "Caught without vision",
  overextended: "Overextended",
  engage_no_followup: "Engaged without follow-up",
  outnumbered: "Outnumbered",
  tower_dive: "Tower dive",
  lost_even_fight: "Lost an even fight",
  worth_it: "Fair trade",
};

const QUEUE_FILTERS = [
  { id: "all", label: "All queues" },
  { id: "420", label: "Ranked Solo/Duo" },
  { id: "440", label: "Ranked Flex" },
  { id: "normal", label: "Normal" },
  { id: "450", label: "ARAM" },
];

const ROLE_FILTERS = [
  { id: "all", label: "All roles" },
  { id: "TOP", label: "Top" },
  { id: "JUNGLE", label: "Jungle" },
  { id: "MIDDLE", label: "Mid" },
  { id: "BOTTOM", label: "Bot" },
  { id: "UTILITY", label: "Support" },
];

function queueMatches(m: TrendMatch, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "normal") return m.queueId === 400 || m.queueId === 430 || m.queueId === 490;
  return String(m.queueId ?? "") === filter;
}

export function Trends({ onOpen }: Props) {
  const [rows, setRows] = useState<TrendMatch[] | null>(null);
  const [queueFilter, setQueueFilter] = useState("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [champFilter, setChampFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");

  useEffect(() => {
    api.libraryTrends().then(setRows).catch(() => setRows([]));
  }, []);

  const champions = useMemo(() => {
    if (!rows) return [];
    const counts = new Map<string, number>();
    for (const r of rows) if (r.champion) counts.set(r.champion, (counts.get(r.champion) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
  }, [rows]);

  const tags = useMemo(() => {
    if (!rows) return [];
    const set = new Set<string>();
    for (const r of rows) for (const t of r.tags) set.add(t);
    return [...set].sort();
  }, [rows]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((r) => {
      if (!queueMatches(r, queueFilter)) return false;
      if (roleFilter !== "all" && r.position.toUpperCase() !== roleFilter) return false;
      if (champFilter !== "all" && r.champion !== champFilter) return false;
      if (tagFilter !== "all" && !r.tags.includes(tagFilter)) return false;
      return true;
    });
  }, [rows, queueFilter, roleFilter, champFilter, tagFilter]);

  const kpis = useMemo(() => {
    const n = filtered.length;
    if (!n) return null;
    const wins = filtered.filter((r) => r.result === "Win").length;
    const losses = filtered.filter((r) => r.result === "Lose").length;
    const decided = wins + losses;
    const wr = decided > 0 ? Math.round((wins / decided) * 100) : null;

    const k = filtered.reduce((s, r) => s + r.kills, 0);
    const d = filtered.reduce((s, r) => s + r.deaths, 0);
    const a = filtered.reduce((s, r) => s + r.assists, 0);
    const kdaRatio = (k + a) / Math.max(1, d);

    const minsTotal = filtered.reduce((s, r) => s + Math.max(1, r.length / 60), 0);
    const csTotal = filtered.reduce((s, r) => s + r.cs, 0);
    const cspm = csTotal / Math.max(1, minsTotal);

    const cs10Vals = filtered.map((r) => r.cs10).filter((v): v is number => typeof v === "number");
    const cs15Vals = filtered.map((r) => r.cs15).filter((v): v is number => typeof v === "number");
    const avgCs10 = cs10Vals.length ? Math.round(cs10Vals.reduce((s, v) => s + v, 0) / cs10Vals.length) : null;
    const avgCs15 = cs15Vals.length ? Math.round(cs15Vals.reduce((s, v) => s + v, 0) / cs15Vals.length) : null;

    const deadVals = filtered.map((r) => r.deadPct).filter((v): v is number => typeof v === "number");
    const avgDeadPct = deadVals.length ? Math.round(deadVals.reduce((s, v) => s + v, 0) / deadVals.length) : null;

    const wardVals = filtered.map((r) => r.wards).filter((v): v is number => typeof v === "number");
    const avgWards = wardVals.length ? Math.round(wardVals.reduce((s, v) => s + v, 0) / wardVals.length) : null;

    const avoidVals = filtered.map((r) => r.avgAvoidable).filter((v): v is number => typeof v === "number");
    const avgAvoidable = avoidVals.length ? Math.round((avoidVals.reduce((s, v) => s + v, 0) / avoidVals.length) * 100) : null;

    return {
      n, wins, losses, wr,
      avgK: k / n, avgD: d / n, avgA: a / n, kdaRatio,
      cspm, avgCs10, avgCs15,
      avgDeadPct, avgWards, avgAvoidable,
    };
  }, [filtered]);

  const byChamp = useMemo(() => {
    const map = new Map<string, {
      champion: string;
      championKey?: string | null;
      games: number;
      wins: number;
      losses: number;
      k: number; d: number; a: number;
      cs: number; mins: number;
      cs10: number[];
      dead: number[];
    }>();
    for (const r of filtered) {
      const key = r.champion || "Unknown";
      const cur = map.get(key) ?? {
        champion: key,
        championKey: r.championKey,
        games: 0, wins: 0, losses: 0,
        k: 0, d: 0, a: 0,
        cs: 0, mins: 0,
        cs10: [], dead: [],
      };
      cur.games++;
      if (r.result === "Win") cur.wins++;
      else if (r.result === "Lose") cur.losses++;
      cur.k += r.kills;
      cur.d += r.deaths;
      cur.a += r.assists;
      cur.cs += r.cs;
      cur.mins += Math.max(1, r.length / 60);
      if (typeof r.cs10 === "number") cur.cs10.push(r.cs10);
      if (typeof r.deadPct === "number") cur.dead.push(r.deadPct);
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => b.games - a.games || b.wins - a.wins);
  }, [filtered]);

  const causes = useMemo(() => {
    const counts = new Map<string, number>();
    let total = 0;
    for (const r of filtered) {
      for (const c of r.deathCauses) {
        counts.set(c, (counts.get(c) ?? 0) + 1);
        total++;
      }
    }
    return {
      total,
      items: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
    };
  }, [filtered]);

  const allies = useMemo(() => {
    const map = new Map<string, { name: string; games: number; wins: number; losses: number; champs: string[] }>();
    for (const r of filtered) {
      for (const al of r.allies) {
        if (!al.name) continue;
        const cur = map.get(al.name) ?? { name: al.name, games: 0, wins: 0, losses: 0, champs: [] };
        cur.games++;
        if (r.result === "Win") cur.wins++;
        else if (r.result === "Lose") cur.losses++;
        if (al.champion && !cur.champs.includes(al.champion)) cur.champs.push(al.champion);
        map.set(al.name, cur);
      }
    }
    const all = [...map.values()].sort((a, b) => b.games - a.games || b.wins - a.wins);
    const repeat = all.filter((x) => x.games >= 2);
    return (repeat.length > 0 ? repeat : all).slice(0, 10);
  }, [filtered]);

  if (rows === null) return <div className="page" />;

  return (
    <div className="page">
      <div className="page-inner trends">
        <div className="lib-head">
          <h1>Trends</h1>
          <p>{rows.length} recorded League {rows.length === 1 ? "game" : "games"} analysed</p>
          <span className="grow" />
          <div className="trends-filters">
            <select className="field-input" value={queueFilter} onChange={(e) => setQueueFilter(e.target.value)} aria-label="Filter by queue">
              {QUEUE_FILTERS.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
            </select>
            <select className="field-input" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="Filter by role">
              {ROLE_FILTERS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
            <select className="field-input" value={champFilter} onChange={(e) => setChampFilter(e.target.value)} aria-label="Filter by champion">
              <option value="all">All champions</option>
              {champions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {tags.length > 0 && (
              <select className="field-input" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} aria-label="Filter by tag">
                <option value="all">All tags</option>
                {tags.map((t) => <option key={t} value={t}>#{t}</option>)}
              </select>
            )}
          </div>
        </div>

        {!kpis ? (
          <div className="empty">
            <BarChart3 size={40} strokeWidth={1.4} aria-hidden />
            <h2>No matching games yet</h2>
            <p>Play some League games or clear the filters above to see your trends.</p>
          </div>
        ) : (
          <>
            <div className="kpi-grid">
              <div className="kpi">
                <span className="caps">Win rate</span>
                <b className={kpis.wr !== null && kpis.wr >= 50 ? "ally" : kpis.wr !== null ? "enemy" : ""}>
                  {kpis.wr !== null ? `${kpis.wr}%` : "—"}
                </b>
                <small>{kpis.wins}W – {kpis.losses}L ({kpis.n} games)</small>
              </div>
              <div className="kpi">
                <span className="caps">Average KDA</span>
                <b>{kpis.kdaRatio.toFixed(2)}:1</b>
                <small>{kpis.avgK.toFixed(1)} / {kpis.avgD.toFixed(1)} / {kpis.avgA.toFixed(1)}</small>
              </div>
              <div className="kpi">
                <span className="caps">Farming</span>
                <b>{kpis.cspm.toFixed(1)} CS/m</b>
                <small>
                  {kpis.avgCs10 !== null ? `CS@10 ${kpis.avgCs10}` : "No early stats"}
                  {kpis.avgCs15 !== null ? ` · CS@15 ${kpis.avgCs15}` : ""}
                </small>
              </div>
              <div className="kpi">
                <span className="caps">Time dead &amp; vision</span>
                <b>{kpis.avgDeadPct !== null ? `${kpis.avgDeadPct}% dead` : (kpis.avgWards !== null ? `${kpis.avgWards} vis` : "—")}</b>
                <small>
                  {kpis.avgWards !== null ? `Avg vision ${kpis.avgWards}` : ""}
                  {kpis.avgAvoidable !== null ? `${kpis.avgWards !== null ? " · " : ""}${kpis.avgAvoidable}% avoidable deaths` : ""}
                </small>
              </div>
            </div>

            <div className="trends-grid">
              <section className="trend-card">
                <h2><Swords size={16} aria-hidden />Champion breakdown</h2>
                <table className="trend-table">
                  <thead>
                    <tr>
                      <th>Champion</th>
                      <th className="n">Games</th>
                      <th className="n">Win%</th>
                      <th className="n">KDA</th>
                      <th className="n">CS/m</th>
                      <th className="n">CS@10</th>
                      <th className="n">Dead%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byChamp.map((c) => {
                      const dec = c.wins + c.losses;
                      const wr = dec ? Math.round((c.wins / dec) * 100) : null;
                      const kda = ((c.k + c.a) / Math.max(1, c.d)).toFixed(2);
                      const cs10 = c.cs10.length ? Math.round(c.cs10.reduce((s, v) => s + v, 0) / c.cs10.length) : null;
                      const dead = c.dead.length ? Math.round(c.dead.reduce((s, v) => s + v, 0) / c.dead.length) : null;
                      return (
                        <tr key={c.champion}>
                          <td>
                            <div className="champ-cell">
                              <Portrait championKey={c.championKey ?? undefined} name={c.champion} size={24} />
                              <span>{c.champion}</span>
                            </div>
                          </td>
                          <td className="n">{c.wins}W–{c.losses}L</td>
                          <td className={`n ${wr !== null && wr >= 50 ? "ally" : wr !== null ? "enemy" : ""}`}>{wr !== null ? `${wr}%` : "—"}</td>
                          <td className="n">{kda}</td>
                          <td className="n">{(c.cs / c.mins).toFixed(1)}</td>
                          <td className="n">{cs10 ?? "—"}</td>
                          <td className="n">{dead !== null ? `${dead}%` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>

              <div className="trends-col">
                <section className="trend-card">
                  <h2><Skull size={16} aria-hidden />Top death causes</h2>
                  {causes.items.length === 0 ? (
                    <p className="muted" style={{ padding: "8px 0" }}>
                      <Sparkles size={13} style={{ verticalAlign: -2, marginRight: 5 }} aria-hidden />
                      Run AI death hints on a few games to see your recurring death patterns here.
                    </p>
                  ) : (
                    <div className="causes">
                      {kpis.avgAvoidable !== null && (
                        <div className="avoid-pill">
                          <ShieldAlert size={14} aria-hidden />
                          Average avoidable rating: <b>{kpis.avgAvoidable}%</b>
                        </div>
                      )}
                      {causes.items.map(([cause, count]) => {
                        const pct = Math.round((count / Math.max(1, causes.total)) * 100);
                        return (
                          <div className="cause-row" key={cause}>
                            <div className="cause-head">
                              <span>{CAUSES[cause] ?? cause}</span>
                              <span className="num">{count} ({pct}%)</span>
                            </div>
                            <div className="cause-bar"><i style={{ width: `${pct}%` }} /></div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section className="trend-card">
                  <h2><Users size={16} aria-hidden />Duo &amp; teammate synergy</h2>
                  {allies.length === 0 ? (
                    <p className="muted" style={{ padding: "8px 0" }}>No teammate data found in these games.</p>
                  ) : (
                    <table className="trend-table">
                      <thead>
                        <tr>
                          <th>Player</th>
                          <th className="n">Games</th>
                          <th className="n">W–L</th>
                          <th className="n">Win%</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allies.map((al) => {
                          const dec = al.wins + al.losses;
                          const wr = dec ? Math.round((al.wins / dec) * 100) : null;
                          return (
                            <tr key={al.name}>
                              <td>
                                <div>{al.name}</div>
                                <small className="muted">{al.champs.slice(0, 3).join(", ")}</small>
                              </td>
                              <td className="n">{al.games}</td>
                              <td className="n">{al.wins}–{al.losses}</td>
                              <td className={`n ${wr !== null && wr >= 50 ? "ally" : wr !== null ? "enemy" : ""}`}>{wr !== null ? `${wr}%` : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </section>
              </div>
            </div>

            <section className="trend-card">
              <h2>Recent games ({filtered.length})</h2>
              <div className="recent-list">
                {filtered.slice(0, 12).map((r) => {
                  const mins = Math.max(1, r.length / 60);
                  const role = laneName(r.position);
                  return (
                    <button key={r.id} className="recent-row" onClick={() => onOpen(r.id)}>
                      <Portrait championKey={r.championKey ?? undefined} name={r.champion} size={28} side={r.result === "Win" ? "ally" : r.result === "Lose" ? "enemy" : undefined} />
                      <span className="rc-champ">
                        <b>{r.champion}</b>
                        <small>{role ? `${role} · ` : ""}{r.queueName ?? "League"} · {when(r.startedEpochMs)}</small>
                      </span>
                      <span className={`rc-res ${r.result === "Win" ? "ally" : r.result === "Lose" ? "enemy" : ""}`}>{r.result === "Win" ? "Win" : r.result === "Lose" ? "Loss" : "—"}</span>
                      <span className="num">{r.kills} / {r.deaths} / {r.assists}</span>
                      <span className="num soft">{(r.cs / mins).toFixed(1)} CS/m</span>
                      {r.cs10 != null && <span className="num muted">@{r.cs10}</span>}
                    </button>
                  );
                })}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
