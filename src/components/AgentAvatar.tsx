import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { Agent } from "../types";

const cache = new Map<string, string>();

export function initials(name: string): string {
  return name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!)
    .join("")
    .toUpperCase();
}

/** The agent's avatar, fetched with the bearer key (an <img src> cannot send one). */
export function AgentAvatar({ agent, size = 40 }: { agent: Agent; size?: number }) {
  const { fountain } = useStore();
  const [url, setUrl] = useState<string | null>(cache.get(agent.id) ?? null);

  useEffect(() => {
    if (!agent.avatar_media_type) {
      cache.delete(agent.id);
      setUrl(null);
      return;
    }
    if (cache.has(agent.id)) {
      setUrl(cache.get(agent.id)!);
      return;
    }
    let cancelled = false;
    fountain.api
      .raw("GET", `/api/agents/${agent.id}/avatar`)
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (!blob || cancelled) return;
        const u = URL.createObjectURL(blob);
        cache.set(agent.id, u);
        setUrl(u);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [agent.id, agent.avatar_media_type, fountain]);

  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.36 }}>
      {url ? <img src={url} alt="" /> : <span>{initials(agent.name) || "?"}</span>}
    </div>
  );
}
