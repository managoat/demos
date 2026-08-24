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
  counts: { open: number; done: number };
}

export interface ItemDto {
  id: string;
  projectId: string;
  title: string;
  notes: string;
  status: "open" | "done";
  agentIds: string[];
  createdAt: string;
}

export interface Activity {
  live: number;
  latest: string | null;
}

export interface Me {
  email: string;
  fountainUrl: string;
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

  projects: () => data(call<{ data: ProjectDto[] }>("GET", "/api/projects")),
  activity: () => data(call<{ data: Record<string, Activity> }>("GET", "/api/projects/activity")),
  createProject: (input: { name: string; notes?: string; environmentId?: string | null; vaultId?: string | null }) => data(call<{ data: ProjectDto }>("POST", "/api/projects", input)),
  project: (id: string) => data(call<{ data: { project: ProjectDto; items: ItemDto[] } }>("GET", `/api/projects/${id}`)),
  patchProject: (id: string, patch: Partial<Pick<ProjectDto, "name" | "notes" | "environmentId" | "vaultId">>) => data(call<{ data: ProjectDto }>("PATCH", `/api/projects/${id}`, patch)),
  deleteProject: (id: string) => call<{ ok: true }>("DELETE", `/api/projects/${id}`),
  addMember: (id: string, email: string) => data(call<{ data: ProjectDto }>("POST", `/api/projects/${id}/members`, { email })),
  removeMember: (id: string, email: string) => data(call<{ data: ProjectDto }>("DELETE", `/api/projects/${id}/members/${encodeURIComponent(email)}`)),

  createItem: (projectId: string, input: { title: string; notes?: string }) => data(call<{ data: ItemDto }>("POST", `/api/projects/${projectId}/items`, input)),
  patchItem: (projectId: string, itemId: string, patch: Partial<Pick<ItemDto, "title" | "notes" | "status" | "agentIds">>) =>
    data(call<{ data: ItemDto }>("PATCH", `/api/projects/${projectId}/items/${itemId}`, patch)),
  deleteItem: (projectId: string, itemId: string) => call<{ ok: true }>("DELETE", `/api/projects/${projectId}/items/${itemId}`),

  recover: () => data(call<{ data: { projects: number; items: number } }>("POST", "/api/projects/recover")),
  importState: (state: unknown) => data(call<{ data: { projects: number; items: number } }>("POST", "/api/import", state)),
};

/** The SDK's base URL for one project: Fountain as seen from inside it, on the owner's key. */
export function projectFountainBase(projectId: string): string {
  return `${window.location.origin}/f/${projectId}`;
}
