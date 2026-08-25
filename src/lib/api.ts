import type { ItemCounts, ItemStatus, Proposal } from "../../shared/status";
import type { Agent, Environment, Vault } from "../types";

/**
 * The workbench's own API (server/app.ts), same origin, session cookie.
 * Fountain itself is reached through the SDK at `/f/<project>` — see store.tsx.
 */

/**
 * The caller's own Fountain view, for the form that makes a project: there is
 * no `/f/<project>` to ask through until the project exists. Agents are here
 * so the default teammate is a field on the create form rather than a trip
 * back through Settings & sharing afterwards.
 */
export interface MyResources {
  environments: Environment[];
  vaults: Vault[];
  agents: Agent[];
}

export interface ProjectDto {
  id: string;
  name: string;
  notes: string;
  environmentId: string | null;
  vaultId: string | null;
  /** The teammate new work here starts with unless someone picks otherwise. */
  defaultAgentId: string | null;
  createdAt: string;
  ownerEmail: string;
  role: "owner" | "member";
  members: { email: string; addedAt: string }[];
  counts: ItemCounts;
}

export interface ItemDto {
  id: string;
  projectId: string;
  title: string;
  notes: string;
  status: ItemStatus;
  agentIds: string[];
  createdAt: string;
  /** What a teammate says should happen to this item, waiting on a person (server/mcp.ts). */
  proposal: Proposal | null;
}

/**
 * What a person may change about a work item. `proposal` only ever goes null:
 * a proposal is a teammate's recommendation, made over MCP; from here a person
 * confirms it by setting the status, or dismisses it and leaves the item open.
 */
export type ItemPatch = Partial<Pick<ItemDto, "title" | "notes" | "status" | "agentIds">> & { proposal?: null };

/** What closing a work item did to its computers (server/projects.ts). */
export interface RetiredDto {
  conversations: number;
  computers: number;
  failed: number;
  error?: string;
}

export interface Activity {
  live: number;
  latest: string | null;
}

/**
 * One conversation that stopped with something nobody has read — a row of the
 * feed in the top bar. It names its project and item as well as itself,
 * because a browser reading it is by definition somewhere else and has no
 * store for the project the entry points into (server/projects.ts).
 */
export interface FeedEntry {
  conversationId: string;
  projectId: string;
  projectName: string;
  itemId: string;
  itemTitle: string | null;
  title: string | null;
  agentId: string | null;
  status: "idle" | "failed";
  at: string;
}

/** One agent blocked on a permission request, in whichever project it is in. */
export interface WaitingEntry {
  conversationId: string;
  projectId: string;
  projectName: string;
  itemId: string;
  itemTitle: string | null;
  title: string | null;
  agentId: string | null;
  requestId: string;
  tool: string | null;
  askedAt: string;
  /** When Fountain answers for you, with a refusal. */
  expiresAt: string;
}

/** What one survey of every project you are in came back with. */
export interface ActivityDto {
  projects: Record<string, Activity>;
  feed: FeedEntry[];
  /** Entries past the server's cap; shown, never silently dropped. */
  dropped: number;
  /** Oldest first: the one closest to running out is the one to answer. */
  waiting: WaitingEntry[];
}

export interface Me {
  email: string;
  fountainUrl: string;
}

// ── cost (server/cost.ts) ────────────────────────────────────────────────
// Your own account and the projects you own. The bill is account-wide and
// period-scoped; the breakdown is per project and lifetime. They are two
// different measurements of two different things, so the view never adds them.

/** Fountain's `GET /api/account/billing` document, passed through as it comes — hence snake_case. */
export interface Billing {
  status?: string | null;
  trial_ends_at?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  period?: { start?: string; end?: string; source?: string };
  plan?: { name?: string; slug?: string; monthly_cents?: number; included_turn_hours?: number };
  usage?: { conversations?: number; turns?: number; turn_hours?: number; turn_hours_included?: number; turn_hours_remaining?: number; sandbox_minutes?: number };
}

export interface CostBucket {
  conversations: number;
  turns: number;
  input: number;
  output: number;
  lastActiveAt: string | null;
}

export interface ItemCost extends CostBucket {
  id: string;
  /** Null for an item deleted here whose conversations still name it. */
  title: string | null;
  status: ItemStatus | null;
}

export interface ProjectCost extends CostBucket {
  id: string;
  name: string;
  memberCount: number;
  items: ItemCost[];
}

export interface Cost {
  billing: Billing | null;
  billingUnavailable: "disabled" | "error" | null;
  projects: ProjectCost[];
  elsewhere: CostBucket;
  total: CostBucket;
}

// The same projects, in the bill's unit over the bill's window: turn seconds
// summed from each turn's own timestamps. A second request because it costs a
// round trip per conversation, so the view above paints without waiting for it.

export interface PeriodBucket {
  conversations: number;
  turns: number;
  /** Turn time inside the window, clipped to it exactly as Fountain's meter clips it. */
  seconds: number;
  /** Tokens on turns that ended inside the window. */
  input: number;
  output: number;
}

export interface ItemPeriodCost extends PeriodBucket {
  id: string;
  title: string | null;
  status: ItemStatus | null;
}

export interface ProjectPeriodCost extends PeriodBucket {
  id: string;
  name: string;
  items: ItemPeriodCost[];
}

/** What the fan-out did, so the page can say what is missing rather than imply nothing is. */
export interface CostFanout {
  candidates: number;
  fetched: number;
  cached: number;
  skipped: number;
  dropped: number;
  failed: number;
}

export interface PeriodCost {
  period: { start: string; end: string; source: string };
  measuredTo: string;
  /** Fountain's own account-wide turn hours for the same window. Null when there is no bill. */
  accountTurnHours: number | null;
  projects: ProjectPeriodCost[];
  measured: PeriodBucket;
  fanout: CostFanout;
}

// ── egress credential brokerage (server/brokering.ts) ────────────────────
// The owner's replacement config, joined to this project's environment and
// vault. Names only; Fountain's secrets API has no values to give.

export type BindingAuthType = "substitute" | "bearer" | "basic" | "api_key" | "custom";

export interface SecretBinding {
  id: string;
  key: string;
  host: string;
  auth_type: BindingAuthType;
  header?: string | null;
  prefix?: string | null;
  username?: string | null;
  headers?: Record<string, string>;
  enabled: boolean;
}

export interface ProjectSecret {
  key: string;
  /** A name on both is one secret to the sandbox — the vault's wins. */
  source: "environment" | "vault" | "both";
  /** Hosts its enabled bindings send it to. Empty: it reaches the sandbox in the clear. */
  hosts: string[];
}

export interface BrokeringDto {
  enabled: boolean;
  bindings: SecretBinding[];
  secrets: ProjectSecret[];
  environment: boolean;
  vault: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const e = (parsed ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, e.error ?? `http_${res.status}`, e.message ?? `Request failed (HTTP ${res.status}).`);
  }
  return parsed as T;
}

const data = <T,>(p: Promise<{ data: T }>): Promise<T> => p.then((r) => r.data);

export const api = {
  config: () => call<{ fountainUrl: string }>("GET", "/api/config"),
  me: () => call<Me>("GET", "/api/me"),
  signIn: (apiKey: string) => call<Me>("POST", "/api/session", { apiKey }),
  signOut: () => call<{ ok: true }>("DELETE", "/api/session"),
  // Environments, vaults and agents on the caller's own key: what the
  // create-project form is made of, before there is a project to ask through.
  myResources: () => data(call<{ data: MyResources }>("GET", "/api/me/resources")),
  // Your own bill and your own projects. Not `/f/<project>/…`: the proxy is the
  // member boundary, and a bill does not belong on the far side of it.
  cost: () => data(call<{ data: Cost }>("GET", "/api/me/cost")),
  // A request per conversation upstream, so the page asks for it after it paints.
  costPeriod: () => data(call<{ data: PeriodCost }>("GET", "/api/me/cost/period")),

  projects: () => data(call<{ data: ProjectDto[] }>("GET", "/api/projects")),
  activity: () => data(call<{ data: ActivityDto }>("GET", "/api/projects/activity")),
  createProject: (input: { name: string; notes?: string; environmentId?: string | null; vaultId?: string | null; defaultAgentId?: string | null }) =>
    data(call<{ data: ProjectDto }>("POST", "/api/projects", input)),
  project: (id: string) => data(call<{ data: { project: ProjectDto; items: ItemDto[] } }>("GET", `/api/projects/${id}`)),
  patchProject: (id: string, patch: Partial<Pick<ProjectDto, "name" | "notes" | "environmentId" | "vaultId" | "defaultAgentId">>) => data(call<{ data: ProjectDto }>("PATCH", `/api/projects/${id}`, patch)),
  deleteProject: (id: string) => call<{ ok: true }>("DELETE", `/api/projects/${id}`),
  brokering: (id: string) => data(call<{ data: BrokeringDto }>("GET", `/api/projects/${id}/brokering`)),
  addMember: (id: string, email: string) => data(call<{ data: ProjectDto }>("POST", `/api/projects/${id}/members`, { email })),
  removeMember: (id: string, email: string) => data(call<{ data: ProjectDto }>("DELETE", `/api/projects/${id}/members/${encodeURIComponent(email)}`)),

  createItem: (projectId: string, input: { title: string; notes?: string }) => data(call<{ data: ItemDto }>("POST", `/api/projects/${projectId}/items`, input)),
  // The envelope, not just the item: closing one retires its computers, and says what went.
  patchItem: (projectId: string, itemId: string, patch: ItemPatch) =>
    call<{ data: ItemDto; retired?: RetiredDto }>("PATCH", `/api/projects/${projectId}/items/${itemId}`, patch),
  deleteItem: (projectId: string, itemId: string) => call<{ ok: true }>("DELETE", `/api/projects/${projectId}/items/${itemId}`),

  recover: () => data(call<{ data: { projects: number; items: number } }>("POST", "/api/projects/recover")),
  importState: (state: unknown) => data(call<{ data: { projects: number; items: number } }>("POST", "/api/import", state)),
};

/** The SDK's base URL for one project: Fountain as seen from inside it, on the owner's key. */
export function projectFountainBase(projectId: string): string {
  return `${window.location.origin}/f/${projectId}`;
}

/**
 * One image attached to a turn, by its position in the turn's `image_count`.
 * An `<img src>` of it: same origin, so the session cookie goes with it and
 * the proxy fetches the bytes on the owner's key.
 */
export function turnImageUrl(projectId: string, conversationId: string, turnId: string, position: number): string {
  return `${projectFountainBase(projectId)}/api/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/images/${position}`;
}
