/**
 * The Watchtower protocol: how the app reads the agent.
 *
 * The agent embeds machine-readable fenced blocks in its replies —
 * ```watch-config, ```watch-state, ```watch-incident — and the app parses
 * them out of the assistant text. The watchlist is set with a plain user
 * message, `SET WATCHLIST\n<json array>`. The conversation is the system of
 * record: the history of watch-state blocks IS the metric history, and
 * everything on the dashboard is derived from it on every fold.
 */

export interface SiteSample {
  url: string;
  checked_at: string;
  up: boolean;
  status: number | null;
  latency_ms: number | null;
  cert_days_left: number | null;
  cert_expires_at: string | null;
  dns: string[];
  note: string | null;
}

export interface WatchState {
  checked_at: string;
  sites: Omit<SiteSample, "checked_at">[];
}

export interface WatchConfig {
  sites: string[];
}

export interface Incident {
  url: string;
  summary: string;
  suspected_cause: string | null;
  evidence: string[];
  checked_at: string | null;
}

export type ProtocolBlock =
  | { kind: "config"; config: WatchConfig }
  | { kind: "state"; state: WatchState }
  | { kind: "incident"; incident: Incident };

const FENCE = /```watch-(config|state|incident)[^\S\n]*\n([\s\S]*?)```/g;

/** Every well-formed protocol block in one reply, in order. Malformed JSON is skipped. */
export function parseBlocks(text: string): ProtocolBlock[] {
  const out: ProtocolBlock[] = [];
  for (const m of text.matchAll(FENCE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[2]!);
    } catch {
      continue;
    }
    if (!isObj(parsed)) continue;
    if (m[1] === "config") {
      const config = asConfig(parsed);
      if (config) out.push({ kind: "config", config });
    } else if (m[1] === "state") {
      const state = asState(parsed);
      if (state) out.push({ kind: "state", state });
    } else {
      const incident = asIncident(parsed);
      if (incident) out.push({ kind: "incident", incident });
    }
  }
  return out;
}

/** The reply with protocol blocks removed — what a feed entry shows as prose. */
export function stripBlocks(text: string): string {
  return text.replace(FENCE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** The sites of a `SET WATCHLIST\n[...]` user message; null when it is not one. */
export function parseWatchlistPrompt(prompt: string): string[] | null {
  const m = prompt.trim().match(/^SET WATCHLIST\s*\n([\s\S]+)$/i);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]!.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const sites = parsed.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  return sites;
}

/** The message that sets the watchlist — the other side of parseWatchlistPrompt. */
export function watchlistMessage(sites: string[]): string {
  return `SET WATCHLIST\n${JSON.stringify(sites)}`;
}

/** `Investigate <url>` in a user message; null otherwise. */
export function parseInvestigatePrompt(prompt: string): string | null {
  const m = prompt.trim().match(/^Investigate\s+(\S+)$/i);
  return m ? m[1]! : null;
}

export type TileStatus = "ok" | "warn" | "down" | "pending";

/** Cert < 14 days turns a tile amber; down turns it red. */
export const CERT_WARN_DAYS = 14;

export function statusOf(latest: SiteSample | null): TileStatus {
  if (!latest) return "pending";
  if (!latest.up) return "down";
  if (latest.cert_days_left !== null && latest.cert_days_left < CERT_WARN_DAYS) return "warn";
  return "ok";
}

export interface IncidentCard {
  incident: Incident;
  /** index of the turn it appeared in, for ordering */
  turnIndex: number;
}

export interface TowerView {
  /** the newest agent-confirmed watchlist; null = never configured */
  watchlist: string[] | null;
  /** a SET WATCHLIST sent after the last confirmation — shown optimistically */
  pending: string[] | null;
  /** every sample ever reported, per site url, oldest first */
  samples: Map<string, SiteSample[]>;
  /** when the newest watch-state landed */
  lastCheckedAt: string | null;
  /** every incident ever reported, newest first */
  incidents: IncidentCard[];
}

/** The list the dashboard shows: the optimistic pending list, else the confirmed one. */
export function effectiveWatchlist(view: TowerView): string[] | null {
  return view.pending ?? view.watchlist;
}

/**
 * Fold a conversation into what the tower shows. `turns` is oldest-first:
 * each entry is the user's prompt plus the agent's full reply text.
 *
 * The watchlist is the newest watch-config block (the agent's confirmation);
 * a SET WATCHLIST prompt after it is surfaced as `pending` so tiles appear
 * the moment the owner adds a site. Samples accumulate per url across every
 * watch-state block — nothing is ever dropped, that history is the sparkline
 * and the up/down strip. Incidents accumulate newest first.
 */
export function foldConversation(turns: Array<{ prompt: string; reply: string }>): TowerView {
  let watchlist: string[] | null = null;
  let configTurn = -1;
  let pending: string[] | null = null;
  let pendingTurn = -1;
  const samples = new Map<string, SiteSample[]>();
  let lastCheckedAt: string | null = null;
  const incidents: IncidentCard[] = [];

  turns.forEach((turn, i) => {
    const wanted = parseWatchlistPrompt(turn.prompt);
    if (wanted) {
      pending = wanted;
      pendingTurn = i;
    }
    for (const block of parseBlocks(turn.reply)) {
      if (block.kind === "config") {
        watchlist = block.config.sites;
        configTurn = i;
      } else if (block.kind === "state") {
        lastCheckedAt = block.state.checked_at;
        for (const site of block.state.sites) {
          const sample: SiteSample = { ...site, checked_at: block.state.checked_at };
          const list = samples.get(site.url);
          if (list) list.push(sample);
          else samples.set(site.url, [sample]);
        }
      } else {
        incidents.unshift({ incident: block.incident, turnIndex: i });
      }
    }
  });

  return {
    watchlist,
    pending: pendingTurn > configTurn ? pending : null,
    samples,
    lastCheckedAt,
    incidents,
  };
}

// ── shape guards: tolerate a sloppy agent, never a crashing UI ─────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asConfig(v: Record<string, unknown>): WatchConfig | null {
  if (!Array.isArray(v.sites)) return null;
  return { sites: v.sites.filter((s): s is string => typeof s === "string" && s.length > 0) };
}

function asSite(v: unknown): Omit<SiteSample, "checked_at"> | null {
  if (!isObj(v)) return null;
  const url = str(v.url);
  if (!url || typeof v.up !== "boolean") return null;
  return {
    url,
    up: v.up,
    status: num(v.status),
    latency_ms: num(v.latency_ms),
    cert_days_left: num(v.cert_days_left),
    cert_expires_at: str(v.cert_expires_at),
    dns: Array.isArray(v.dns) ? v.dns.filter((d): d is string => typeof d === "string") : [],
    note: str(v.note),
  };
}

function asState(v: Record<string, unknown>): WatchState | null {
  const checkedAt = str(v.checked_at);
  if (!checkedAt || !Array.isArray(v.sites)) return null;
  const sites = v.sites.map(asSite).filter((s): s is Omit<SiteSample, "checked_at"> => s !== null);
  return { checked_at: checkedAt, sites };
}

function asIncident(v: Record<string, unknown>): Incident | null {
  const url = str(v.url);
  const summary = str(v.summary);
  if (!url || !summary) return null;
  return {
    url,
    summary,
    suspected_cause: str(v.suspected_cause),
    evidence: Array.isArray(v.evidence) ? v.evidence.filter((e): e is string => typeof e === "string" && e.length > 0) : [],
    checked_at: str(v.checked_at),
  };
}
