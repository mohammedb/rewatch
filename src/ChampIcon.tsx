import { useEffect, useState } from "react";

// Champion and item pictures come from Riot's public image host (Data Dragon).
// If it cannot be reached the interface falls back to initials.
let versionPromise: Promise<string | null> | null = null;
function dataDragonVersion(): Promise<string | null> {
  versionPromise ??= fetch("https://ddragon.leagueoflegends.com/api/versions.json")
    .then((r) => r.json())
    .then((v: string[]) => v[0] ?? null)
    .catch(() => null);
  return versionPromise;
}

function useVersion(): string | null {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    dataDragonVersion().then((x) => live && setV(x));
    return () => {
      live = false;
    };
  }, []);
  return v;
}

export type Side = "ally" | "enemy" | "neutral";

interface PortraitProps {
  championKey?: string;
  name: string;
  size?: number;
  /** Coloured ring: which team this champion is on, where that matters. */
  side?: Side;
}

/** Round champion portrait. People are round, things (items) are square. */
export function Portrait({ championKey, name, size = 44, side }: PortraitProps) {
  const version = useVersion();
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size, fontSize: Math.max(10, size * 0.36) };
  const cls = `portrait${side ? ` ring-${side}` : ""}`;
  if (!championKey || !version || failed) {
    return <span className={cls} style={style} aria-hidden>{name.slice(0, 2)}</span>;
  }
  return (
    <span className={cls} style={style} title={name}>
      <img alt={name} src={`https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${championKey}.png`} onError={() => setFailed(true)} draggable={false} />
    </span>
  );
}

export function ItemIcon({ id, name, size = 28 }: { id: number; name: string; size?: number }) {
  const version = useVersion();
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  if (!version || failed || !id) return <span className="item blank" style={style} title={name} />;
  return (
    <img className="item" style={style} alt={name} title={name} draggable={false}
      src={`https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${id}.png`} onError={() => setFailed(true)} />
  );
}
