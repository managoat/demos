/**
 * Arena's state derivation, pure and tested: which brains fight by default,
 * what a round is, which turns belong to it, the scoreboard, and the numbers
 * each column shows. Rounds and hired contenders live in localStorage keyed
 * by Fountain URL — the conversations themselves stay the system of record;
 * a round only remembers which conversations (and turns) it was.
 */
import type { LogEvent, Turn, Usage } from "../api/types";

/** A brain in the picker. `instance` > 1 is the same model hired twice. */
export interface ContenderKey {
  model: string;
  instance: number;
}

export function keyId(k: ContenderKey): string {
  return k.instance > 1 ? `${k.model} #${k.instance}` : k.model;
}

export interface RoundContender {
  key: string;
  model: string;
  instance: number;
  /** null when hiring failed — the column shows the error. */
  agentId: string | null;
  conversationId: string | null;
  /** Turn ids captured live from `turn started` stage events. */
  turnIds: string[];
}

export interface Round {
  id: string;
  /** Every prompt of the round, first one is the headline. */
  prompts: string[];
  startedAt: string;
  blind: boolean;
  /** Column order (contender keys) — shuffled at creation when blind. */
  order: string[];
  contenders: RoundContender[];
  winnerKey: string | null;
  revealed: boolean;
  /** Set on vote or "new round" — a closed round takes no follow-ups. */
  closedAt: string | null;
}

export const LABELS = ["A", "B", "C", "D"] as const;

// ── localStorage: hired contenders + rounds, per Fountain URL ───────────────

const AGENTS_KEY = "arena.contenders";
const ROUNDS_KEY = "arena.rounds";

function loadMap<T>(storageKey: string, baseUrl: string): T | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, T>;
    return map[baseUrl] ?? null;
  } catch {
    return null;
  }
}

function saveMap<T>(storageKey: string, baseUrl: string, value: T): void {
  let map: Record<string, T> = {};
  try {
    map = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<string, T>;
  } catch {
    // start over
  }
  map[baseUrl] = value;
  localStorage.setItem(storageKey, JSON.stringify(map));
}

/** contender key → agent id, the teammates this browser has hired. */
export function loadAgentIds(baseUrl: string): Record<string, string> {
  return loadMap<Record<string, string>>(AGENTS_KEY, baseUrl) ?? {};
}

export function saveAgentId(baseUrl: string, key: string, agentId: string): void {
  const ids = loadAgentIds(baseUrl);
  ids[key] = agentId;
  saveMap(AGENTS_KEY, baseUrl, ids);
}

export function loadRounds(baseUrl: string): Round[] {
  const rounds = loadMap<Round[]>(ROUNDS_KEY, baseUrl);
  return Array.isArray(rounds) ? rounds : [];
}

export function saveRounds(baseUrl: string, rounds: Round[]): void {
  saveMap(ROUNDS_KEY, baseUrl, rounds);
}

// ── the picker ───────────────────────────────────────────────────────────────

export function distinctModels(catalogModels: Record<string, string[]>): string[] {
  return [...new Set(Object.values(catalogModels).flat())];
}

/** Chips grouped by provider, in order of first appearance. */
export function groupByProvider(models: string[]): Array<{ provider: string; models: string[] }> {
  const groups: Array<{ provider: string; models: string[] }> = [];
  for (const m of models) {
    const provider = m.split("/")[0] ?? "other";
    const g = groups.find((x) => x.provider === provider);
    if (g) g.models.push(m);
    else groups.push({ provider, models: [m] });
  }
  return groups;
}

/**
 * Default fight card: the three Anthropic tiers when available, else the
 * first few distinct models, else one model hired twice — never a dead end.
 */
export function defaultSelection(models: string[]): ContenderKey[] {
  const anthropic = models.filter((m) => m.startsWith("anthropic/"));
  const tiers = ["haiku", "sonnet", "opus"]
    .map((t) => anthropic.find((m) => m.includes(t)))
    .filter((m): m is string => typeof m === "string");
  const unique = [...new Set(tiers)];
  if (unique.length >= 2) return unique.map((model) => ({ model, instance: 1 }));

  const distinct = [...new Set(models)];
  if (distinct.length >= 2) return distinct.slice(0, 3).map((model) => ({ model, instance: 1 }));
  const only = distinct[0];
  if (only) {
    return [
      { model: only, instance: 1 },
      { model: only, instance: 2 },
    ];
  }
  return [];
}

/** The chips to offer: every distinct model, plus a #2 when there is only one. */
export function pickerKeys(models: string[]): ContenderKey[] {
  const distinct = [...new Set(models)];
  const keys = distinct.map((model) => ({ model, instance: 1 }));
  const only = distinct[0];
  if (distinct.length === 1 && only) keys.push({ model: only, instance: 2 });
  return keys;
}

/** Fisher–Yates; rand injected so tests can pin the order. */
export function shuffled<T>(items: T[], rand: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = out[i]!;
    out[i] = out[j]!;
    out[j] = a;
  }
  return out;
}

// ── which turns belong to a round ────────────────────────────────────────────

const SLACK_MS = 2 * 60 * 1000;

/**
 * Turn ids captured live are authoritative. When they are missing (the round
 * ran in another tab, or events were missed) fall back to matching the
 * round's prompts inside the round's time window.
 */
export function turnsForRound(turns: Turn[], round: Round, contender: RoundContender): Turn[] {
  let mine: Turn[];
  if (contender.turnIds.length > 0) {
    const ids = new Set(contender.turnIds);
    mine = turns.filter((t) => ids.has(t.id));
  } else {
    const start = Date.parse(round.startedAt) - SLACK_MS;
    const end = round.closedAt ? Date.parse(round.closedAt) + SLACK_MS : Infinity;
    mine = turns.filter((t) => {
      const at = Date.parse(t.inserted_at);
      return round.prompts.includes(t.prompt) && at >= start && at <= end;
    });
  }
  return [...mine].sort((a, b) => a.turn_number - b.turn_number);
}

// ── scoreboard ───────────────────────────────────────────────────────────────

export interface Score {
  model: string;
  wins: number;
  rounds: number;
}

/** Tally over voted rounds: each contender appearance counts as a round. */
export function scoreboard(rounds: Round[]): Score[] {
  const byModel = new Map<string, Score>();
  for (const round of rounds) {
    if (!round.winnerKey) continue;
    for (const c of round.contenders) {
      const s = byModel.get(c.model) ?? { model: c.model, wins: 0, rounds: 0 };
      s.rounds += 1;
      if (c.key === round.winnerKey) s.wins += 1;
      byModel.set(c.model, s);
    }
  }
  return [...byModel.values()].sort(
    (a, b) => b.wins - a.wins || b.rounds - a.rounds || a.model.localeCompare(b.model),
  );
}

// ── column numbers & status ──────────────────────────────────────────────────

export interface TurnMetrics {
  /** first output event ts − turn started ts, both server-side. */
  ttfbMs: number | null;
  durationMs: number | null;
  usage: Usage | null;
}

export function turnMetrics(turn: Turn, events: LogEvent[], nowMs: number): TurnMetrics {
  const start = turn.started_at ? Date.parse(turn.started_at) : null;
  const firstOut = events.find((e) => e.kind === "output" && e.turn_id === turn.id)?.ts ?? null;
  const end = turn.ended_at ? Date.parse(turn.ended_at) : turn.status === "running" ? nowMs : null;
  return {
    ttfbMs: start !== null && firstOut !== null ? Math.max(0, Date.parse(firstOut) - start) : null,
    durationMs: start !== null && end !== null ? Math.max(0, end - start) : null,
    usage: turn.usage ?? null,
  };
}

export function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

/** What the app is doing to a contender outside of any turn. */
export type RuntimePhase = "hiring" | "sending" | "starting" | "cancelled" | "error";

export type ColumnStatus =
  | "waiting"
  | "hiring"
  | "starting"
  | "thinking"
  | "answering"
  | "done"
  | "error"
  | "interrupted";

export function columnStatus(
  phase: RuntimePhase | null,
  lastTurn: Turn | null,
  hasOutput: boolean,
): ColumnStatus {
  if (phase === "error") return "error";
  if (phase === "cancelled") return "interrupted";
  if (phase === "hiring") return "hiring";
  if (phase === "starting") return "starting";
  if (phase === "sending") return "waiting";
  if (!lastTurn) return "waiting";
  switch (lastTurn.status) {
    case "running":
      return hasOutput ? "answering" : "thinking";
    case "completed":
      return "done";
    case "failed":
      return "error";
    case "interrupted":
      return "interrupted";
    default:
      return "waiting";
  }
}
