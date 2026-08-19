/**
 * The DNS Desk protocol: how the app reads the agent.
 *
 * The agent embeds machine-readable fenced blocks in its replies —
 * ```dns-state, ```dns-plan, ```dns-result — and the app parses them out of
 * the assistant text. Approval is a plain user message, `APPROVE <plan-id>`
 * or `REJECT <plan-id>`. This is a convention, not a platform feature: when
 * Fountain grows real approval gates (#643) and a record store, this module
 * is the seam to swap.
 */

export interface DnsRecord {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
  comment?: string;
}

export interface DnsZone {
  name: string;
  id?: string;
  records: DnsRecord[];
}

export interface DnsState {
  fetched_at?: string;
  zones: DnsZone[];
}

export interface PlanChange {
  op: "create" | "update" | "delete";
  type: string;
  name: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
  /** the record as it is now, on update/delete */
  before?: DnsRecord;
}

export interface DnsPlan {
  id: string;
  zone: string;
  summary?: string;
  changes: PlanChange[];
}

export interface DnsResult {
  plan_id: string;
  status: "applied" | "failed" | "rejected";
  detail?: string;
}

export type ProtocolBlock =
  | { kind: "state"; state: DnsState }
  | { kind: "plan"; plan: DnsPlan }
  | { kind: "result"; result: DnsResult };

const FENCE = /```dns-(state|plan|result)[^\S\n]*\n([\s\S]*?)```/g;

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
    if (m[1] === "state") {
      const state = asState(parsed);
      if (state) out.push({ kind: "state", state });
    } else if (m[1] === "plan") {
      const plan = asPlan(parsed);
      if (plan) out.push({ kind: "plan", plan });
    } else {
      const result = asResult(parsed);
      if (result) out.push({ kind: "result", result });
    }
  }
  return out;
}

/** The reply with protocol blocks removed — what the chat bubble shows as prose. */
export function stripBlocks(text: string): string {
  return text.replace(FENCE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** `APPROVE plan-x` / `REJECT plan-x` in a user message; null otherwise. */
export function parseDecision(prompt: string): { verb: "approve" | "reject"; planId: string } | null {
  const m = prompt.trim().match(/^(APPROVE|REJECT)\s+(\S+)$/i);
  if (!m) return null;
  return { verb: m[1]!.toLowerCase() as "approve" | "reject", planId: m[2]! };
}

export type PlanStatus = "awaiting" | "approved" | "applied" | "failed" | "rejected" | "superseded";

export interface PlanCard {
  plan: DnsPlan;
  status: PlanStatus;
  /** the agent's word on how it ended, when there is one */
  detail: string | null;
  /** index of the turn the plan appeared in, for ordering */
  turnIndex: number;
}

export interface DeskView {
  /** the newest dns-state the agent has reported, if any */
  state: DnsState | null;
  stateTurnIndex: number | null;
  /** every plan ever proposed, oldest first, with derived status */
  plans: PlanCard[];
}

/**
 * Fold a conversation into what the desk shows. `turns` is oldest-first:
 * each entry is the user's prompt plus the agent's full reply text.
 *
 * Status is derived, never stored: a dns-result names the outcome; an
 * APPROVE/REJECT message after the plan marks it approved/rejected while the
 * apply is still running; a newer plan with no outcome supersedes an older
 * undecided one (the agent re-plans rather than applying stale diffs).
 */
export function foldConversation(turns: Array<{ prompt: string; reply: string }>): DeskView {
  let state: DnsState | null = null;
  let stateTurnIndex: number | null = null;
  const plans = new Map<string, PlanCard>();
  const decisions = new Map<string, "approve" | "reject">();
  const results = new Map<string, DnsResult>();

  turns.forEach((turn, i) => {
    const decision = parseDecision(turn.prompt);
    if (decision) decisions.set(decision.planId, decision.verb);
    for (const block of parseBlocks(turn.reply)) {
      if (block.kind === "state") {
        state = block.state;
        stateTurnIndex = i;
      } else if (block.kind === "plan") {
        plans.set(block.plan.id, { plan: block.plan, status: "awaiting", detail: null, turnIndex: i });
      } else {
        results.set(block.result.plan_id, block.result);
      }
    }
  });

  const cards = [...plans.values()].sort((a, b) => a.turnIndex - b.turnIndex);
  for (const card of cards) {
    const result = results.get(card.plan.id);
    const decision = decisions.get(card.plan.id);
    if (result) {
      card.status = result.status;
      card.detail = result.detail ?? null;
    } else if (decision === "reject") {
      card.status = "rejected";
    } else if (decision === "approve") {
      card.status = "approved";
    }
  }
  // A newer plan supersedes older ones still awaiting a decision.
  const lastAwaiting = cards.map((c) => c.status).lastIndexOf("awaiting");
  cards.forEach((c, i) => {
    if (c.status === "awaiting" && i < lastAwaiting) c.status = "superseded";
  });
  return { state, stateTurnIndex, plans: cards };
}

/** The one plan an Approve button should point at, if any. */
export function pendingPlan(view: DeskView): PlanCard | null {
  for (let i = view.plans.length - 1; i >= 0; i--) {
    const c = view.plans[i]!;
    if (c.status === "awaiting") return c;
  }
  return null;
}

// ── shape guards: tolerate a sloppy agent, never a crashing UI ─────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asRecord(v: unknown): DnsRecord | null {
  if (!isObj(v)) return null;
  const type = str(v.type);
  const name = str(v.name);
  if (!type || !name) return null;
  const r: DnsRecord = { type, name, content: str(v.content) ?? "" };
  if (typeof v.ttl === "number") r.ttl = v.ttl;
  if (typeof v.proxied === "boolean") r.proxied = v.proxied;
  if (typeof v.priority === "number") r.priority = v.priority;
  if (typeof v.comment === "string") r.comment = v.comment;
  return r;
}

function asState(v: Record<string, unknown>): DnsState | null {
  if (!Array.isArray(v.zones)) return null;
  const zones: DnsZone[] = [];
  for (const z of v.zones) {
    if (!isObj(z)) continue;
    const name = str(z.name);
    if (!name) continue;
    const records = Array.isArray(z.records) ? z.records.map(asRecord).filter((r): r is DnsRecord => r !== null) : [];
    const zone: DnsZone = { name, records };
    const id = str(z.id);
    if (id) zone.id = id;
    zones.push(zone);
  }
  const state: DnsState = { zones };
  const fetched = str(v.fetched_at);
  if (fetched) state.fetched_at = fetched;
  return state;
}

function asPlan(v: Record<string, unknown>): DnsPlan | null {
  const id = str(v.id);
  const zone = str(v.zone);
  if (!id || !zone || !Array.isArray(v.changes)) return null;
  const changes: PlanChange[] = [];
  for (const c of v.changes) {
    if (!isObj(c)) continue;
    const op = str(c.op);
    const type = str(c.type);
    const name = str(c.name);
    if (!type || !name || (op !== "create" && op !== "update" && op !== "delete")) continue;
    const change: PlanChange = { op, type, name };
    if (typeof c.content === "string") change.content = c.content;
    if (typeof c.ttl === "number") change.ttl = c.ttl;
    if (typeof c.proxied === "boolean") change.proxied = c.proxied;
    if (typeof c.priority === "number") change.priority = c.priority;
    const before = asRecord(c.before);
    if (before) change.before = before;
    changes.push(change);
  }
  if (changes.length === 0) return null;
  const plan: DnsPlan = { id, zone, changes };
  const summary = str(v.summary);
  if (summary) plan.summary = summary;
  return plan;
}

function asResult(v: Record<string, unknown>): DnsResult | null {
  const planId = str(v.plan_id);
  const status = str(v.status);
  if (!planId || (status !== "applied" && status !== "failed" && status !== "rejected")) return null;
  const result: DnsResult = { plan_id: planId, status };
  const detail = str(v.detail);
  if (detail) result.detail = detail;
  return result;
}
