import { useEffect, useState } from "react";
import type { Agent } from "../api/types";
import type { FountainClient } from "../api/client";

export function initials(name: string): string {
  return name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!)
    .join("")
    .toUpperCase();
}

const cache = new Map<string, string>();
const STORE_PREFIX = "fountain-team.avatar.";
const STORE_MAX = 96 * 1024; // data URL bytes; bigger avatars stay in-memory only

function stored(agentId: string): string | null {
  try {
    return localStorage.getItem(STORE_PREFIX + agentId);
  } catch {
    return null;
  }
}

function store(agentId: string, dataUrl: string): void {
  if (dataUrl.length > STORE_MAX) return;
  try {
    localStorage.setItem(STORE_PREFIX + agentId, dataUrl);
  } catch {
    /* quota — fine, it was a cache */
  }
}

/**
 * The agent's avatar, fetched with the bearer key (an <img src> cannot send
 * one) and kept as a data URL in localStorage, so a refresh paints the
 * picture on the first frame instead of initials that swap a beat later.
 */
export function Avatar({ agent, name, client, size = 44 }: { agent: Agent; name: string; client: FountainClient; size?: number }) {
  const [url, setUrl] = useState<string | null>(() => cache.get(agent.id) ?? (agent.avatar_media_type ? stored(agent.id) : null));

  useEffect(() => {
    if (!agent.avatar_media_type || cache.has(agent.id)) return;
    let cancelled = false;
    client
      .fetchRaw(`/api/agents/${agent.id}/avatar`)
      .then((r) => (r.ok ? r.blob() : null))
      .then(
        (blob) =>
          new Promise<string | null>((resolve) => {
            if (!blob) return resolve(null);
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          }),
      )
      .then((dataUrl) => {
        if (!dataUrl || cancelled) return;
        cache.set(agent.id, dataUrl);
        store(agent.id, dataUrl);
        setUrl(dataUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [agent.id, agent.avatar_media_type, client]);

  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.36 }}>
      {url ? <img src={url} alt="" /> : <span>{initials(name) || "?"}</span>}
    </div>
  );
}
