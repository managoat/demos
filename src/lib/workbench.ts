/**
 * The workbench model: a project is an environment + vault (the computer
 * every conversation in it gets), and holds work items; a work item pulls in
 * teammates, which are simply agents; the team is the agent list Fountain
 * already has.
 *
 * So the sandbox identity `(user, agent, environment, vault)` falls out of
 * the tree: same project + same agent = the same identity, which is what
 * lets two conversations share one computer.
 *
 * Fountain has no project or work-item primitive, so the tree lives in this
 * browser (localStorage) — but a conversation's membership is recorded on the
 * server, in its `channel_id`, as `workbench:<project>/<item>`. That is what
 * makes the tree recoverable: a fresh browser rebuilds every project and item
 * that ever had a conversation from the conversation list alone, and only the
 * names are lost (they are given placeholders until edited).
 */

export interface Project {
  id: string;
  name: string;
  /** Free text: what the project is, where the repo lives. */
  notes: string;
  /** The environment every conversation in this project provisions from; `null` means each agent's own. */
  environmentId: string | null;
  /** The vault whose secrets every conversation in this project gets; `null` means none. */
  vaultId: string | null;
  createdAt: string;
}

export interface WorkItem {
  id: string;
  projectId: string;
  title: string;
  notes: string;
  status: "open" | "done";
  /** Teammates pulled onto this item — Fountain agent ids, in the order they were added. */
  agentIds: string[];
  createdAt: string;
}

export interface WorkbenchState {
  version: 2;
  projects: Project[];
  items: WorkItem[];
}

export const EMPTY: WorkbenchState = { version: 2, projects: [], items: [] };

const KEY = "fountain-workbench.state";
const CHANNEL_PREFIX = "workbench:";

/** A short, URL-safe, channel-safe id. Not a UUID on purpose: it appears in `channel_id` and the hash. */
export function newId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function channelFor(projectId: string, itemId: string): string {
  return `${CHANNEL_PREFIX}${projectId}/${itemId}`;
}

/** The (project, item) a channel id names, or null if it is not one of ours. */
export function parseChannel(channelId: string | null | undefined): { projectId: string; itemId: string } | null {
  if (!channelId || !channelId.startsWith(CHANNEL_PREFIX)) return null;
  const rest = channelId.slice(CHANNEL_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  const projectId = rest.slice(0, slash);
  const itemId = rest.slice(slash + 1);
  if (!/^[\w-]+$/.test(projectId) || !/^[\w-]+$/.test(itemId)) return null;
  return { projectId, itemId };
}

export function loadState(): WorkbenchState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    return normalize(JSON.parse(raw));
  } catch {
    return EMPTY;
  }
}

export function saveState(state: WorkbenchState): void {
  localStorage.setItem(KEY, JSON.stringify(state));
}

/** Accept a parsed JSON blob (from storage or an import) and make it a valid state. */
export function normalize(input: unknown): WorkbenchState {
  const o = (input && typeof input === "object" ? input : {}) as Partial<WorkbenchState>;
  const projects: Project[] = (Array.isArray(o.projects) ? o.projects : [])
    .filter((p): p is Project => !!p && typeof p.id === "string")
    .map((p) => ({
      id: p.id,
      name: str(p.name) || "Untitled project",
      notes: str(p.notes),
      environmentId: typeof p.environmentId === "string" && p.environmentId ? p.environmentId : null,
      vaultId: typeof p.vaultId === "string" && p.vaultId ? p.vaultId : null,
      createdAt: str(p.createdAt) || new Date(0).toISOString(),
    }));
  const projectIds = new Set(projects.map((p) => p.id));
  const items: WorkItem[] = (Array.isArray(o.items) ? o.items : [])
    .filter((w): w is WorkItem => !!w && typeof w.id === "string" && typeof w.projectId === "string" && projectIds.has(w.projectId))
    .map((w) => ({
      id: w.id,
      projectId: w.projectId,
      title: str(w.title) || "Untitled work item",
      notes: str(w.notes),
      status: w.status === "done" ? "done" : "open",
      agentIds: Array.isArray(w.agentIds) ? w.agentIds.filter((m): m is string => typeof m === "string") : [],
      createdAt: str(w.createdAt) || new Date(0).toISOString(),
    }));
  return { version: 2, projects, items };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Fold the server's conversation list into the tree: any `workbench:` channel
 * naming a project or item this browser has not seen becomes a placeholder
 * entry, so nothing that happened on the server is invisible here. Returns
 * the same object when nothing was missing, so callers can compare by identity.
 */
export function reconcile(
  state: WorkbenchState,
  conversations: { channel_id?: string | null; title?: string | null; inserted_at?: string; agent_id?: string | null; environment_id?: string | null; vault_id?: string | null }[],
): WorkbenchState {
  let projects = state.projects;
  let items = state.items;
  const projectIds = new Set(projects.map((p) => p.id));
  const itemIds = new Set(items.map((w) => w.id));
  for (const c of conversations) {
    const ref = parseChannel(c.channel_id);
    if (!ref) continue;
    if (!projectIds.has(ref.projectId)) {
      projects = [
        ...projects,
        {
          id: ref.projectId,
          name: `Recovered project ${ref.projectId.slice(0, 6)}`,
          notes: "",
          environmentId: c.environment_id ?? null,
          vaultId: c.vault_id ?? null,
          createdAt: c.inserted_at ?? new Date(0).toISOString(),
        },
      ];
      projectIds.add(ref.projectId);
    }
    if (!itemIds.has(ref.itemId)) {
      items = [
        ...items,
        {
          id: ref.itemId,
          projectId: ref.projectId,
          title: recoveredTitle(c.title) ?? `Recovered item ${ref.itemId.slice(0, 6)}`,
          notes: "",
          status: "open",
          agentIds: c.agent_id ? [c.agent_id] : [],
          createdAt: c.inserted_at ?? new Date(0).toISOString(),
        },
      ];
      itemIds.add(ref.itemId);
    } else if (c.agent_id) {
      // An item this browser knows, with a teammate it has not seen on it.
      const w = items.find((x) => x.id === ref.itemId)!;
      if (!w.agentIds.includes(c.agent_id)) {
        items = items.map((x) => (x.id === w.id ? { ...x, agentIds: [...x.agentIds, c.agent_id!] } : x));
      }
    }
  }
  if (projects === state.projects && items === state.items) return state;
  return { ...state, projects, items };
}

/** Conversation titles are written as `<agent>: <item title>`; get the item title back. */
export function conversationTitle(agentName: string, itemTitle: string): string {
  const t = `${agentName}: ${itemTitle}`;
  return t.length > 120 ? t.slice(0, 119) + "…" : t;
}

function recoveredTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const colon = title.indexOf(": ");
  return colon > 0 ? title.slice(colon + 2) : title;
}

// ── mutations: all pure, all return a new state ───────────────────────────

export function addProject(s: WorkbenchState, input: { name: string; notes?: string; environmentId?: string | null; vaultId?: string | null }): [WorkbenchState, Project] {
  const p: Project = {
    id: newId(),
    name: input.name.trim() || "Untitled project",
    notes: input.notes ?? "",
    environmentId: input.environmentId ?? null,
    vaultId: input.vaultId ?? null,
    createdAt: new Date().toISOString(),
  };
  return [{ ...s, projects: [...s.projects, p] }, p];
}

export function updateProject(s: WorkbenchState, id: string, patch: Partial<Pick<Project, "name" | "notes" | "environmentId" | "vaultId">>): WorkbenchState {
  return { ...s, projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) };
}

export function removeProject(s: WorkbenchState, id: string): WorkbenchState {
  return { ...s, projects: s.projects.filter((p) => p.id !== id), items: s.items.filter((w) => w.projectId !== id) };
}

export function addItem(s: WorkbenchState, projectId: string, title: string, notes = ""): [WorkbenchState, WorkItem] {
  const w: WorkItem = { id: newId(), projectId, title: title.trim() || "Untitled work item", notes, status: "open", agentIds: [], createdAt: new Date().toISOString() };
  return [{ ...s, items: [...s.items, w] }, w];
}

export function updateItem(s: WorkbenchState, id: string, patch: Partial<Pick<WorkItem, "title" | "notes" | "status" | "agentIds">>): WorkbenchState {
  return { ...s, items: s.items.map((w) => (w.id === id ? { ...w, ...patch } : w)) };
}

export function removeItem(s: WorkbenchState, id: string): WorkbenchState {
  return { ...s, items: s.items.filter((w) => w.id !== id) };
}

/** Put an agent on an item (idempotent). */
export function addTeammate(s: WorkbenchState, itemId: string, agentId: string): WorkbenchState {
  return { ...s, items: s.items.map((w) => (w.id === itemId && !w.agentIds.includes(agentId) ? { ...w, agentIds: [...w.agentIds, agentId] } : w)) };
}

export function removeTeammate(s: WorkbenchState, itemId: string, agentId: string): WorkbenchState {
  return { ...s, items: s.items.map((w) => (w.id === itemId ? { ...w, agentIds: w.agentIds.filter((x) => x !== agentId) } : w)) };
}

/**
 * Whether an agent can run in a project: its allowlists, when set, must admit
 * the project's environment and vault. The server refuses otherwise (422), so
 * the picker says so first.
 */
export function agentFits(
  agent: { allowed_environment_ids?: string[] | null; allowed_vault_ids?: string[] | null },
  project: { environmentId: string | null; vaultId: string | null },
): { ok: true } | { ok: false; reason: string } {
  const envs = agent.allowed_environment_ids ?? [];
  if (project.environmentId && envs.length > 0 && !envs.includes(project.environmentId)) {
    return { ok: false, reason: "does not allow this project's environment" };
  }
  const vaults = agent.allowed_vault_ids ?? [];
  if (project.vaultId && vaults.length > 0 && !vaults.includes(project.vaultId)) {
    return { ok: false, reason: "does not allow this project's vault" };
  }
  return { ok: true };
}
