import type { ItemCounts, ItemStatus, Proposal } from "../../shared/status";
import type { Environment, Vault } from "../types";

/**
 * The workbench's own API (server/app.ts), same origin, session cookie.
 * Fountain itself is reached through the SDK at `/f/<project>` — see store.tsx.
 */

export interface ProjectDto {
  id: string;
  name: string;
  notes: string;
  environmentId: string | null;
  vaultId: string | null;
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
  myResources: () => data(call<{ data: { environments: Environment[]; vaults: Vault[] } }>("GET", "/api/me/resources")),
  // Your own bill and your own projects. Not `/f/<project>/…`: the proxy is the
  // member boundary, and a bill does not belong on the far side of it.
  cost: () => data(call<{ data: Cost }>("GET", "/api/me/cost")),

  projects: () => data(call<{ data: ProjectDto[] }>("GET", "/api/projects")),
  activity: () => data(call<{ data: Record<string, Activity> }>("GET", "/api/projects/activity")),
  createProject: (input: { name: string; notes?: string; environmentId?: string | null; vaultId?: string | null }) => data(call<{ data: ProjectDto }>("POST", "/api/projects", input)),
  project: (id: string) => data(call<{ data: { project: ProjectDto; items: ItemDto[] } }>("GET", `/api/projects/${id}`)),
  patchProject: (id: string, patch: Partial<Pick<ProjectDto, "name" | "notes" | "environmentId" | "vaultId">>) => data(call<{ data: ProjectDto }>("PATCH", `/api/projects/${id}`, patch)),
  deleteProject: (id: string) => call<{ ok: true }>("DELETE", `/api/projects/${id}`),
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
