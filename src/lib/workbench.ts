/**
 * The workbench model: projects hold work items; work items pull in members;
 * a member is a named preset of agent + environment + vault.
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
  createdAt: string;
}

export interface WorkItem {
  id: string;
  projectId: string;
  title: string;
  notes: string;
  status: "open" | "done";
  /** Members pulled onto this item, by member id, in the order they were added. */
  memberIds: string[];
  createdAt: string;
}

/** A named agent + environment + vault combination — the thing you pull into work. */
export interface Member {
  id: string;
  name: string;
  agentId: string;
  /** `null` means the agent's own environment. */
  environmentId: string | null;
  vaultId: string | null;
  notes: string;
}

export interface WorkbenchState {
  version: 1;
  projects: Project[];
  items: WorkItem[];
  members: Member[];
}

export const EMPTY: WorkbenchState = { version: 1, projects: [], items: [], members: [] };

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
    .map((p) => ({ id: p.id, name: str(p.name) || "Untitled project", notes: str(p.notes), createdAt: str(p.createdAt) || new Date(0).toISOString() }));
  const projectIds = new Set(projects.map((p) => p.id));
  const items: WorkItem[] = (Array.isArray(o.items) ? o.items : [])
    .filter((w): w is WorkItem => !!w && typeof w.id === "string" && typeof w.projectId === "string" && projectIds.has(w.projectId))
    .map((w) => ({
      id: w.id,
      projectId: w.projectId,
      title: str(w.title) || "Untitled work item",
      notes: str(w.notes),
      status: w.status === "done" ? "done" : "open",
      memberIds: Array.isArray(w.memberIds) ? w.memberIds.filter((m): m is string => typeof m === "string") : [],
      createdAt: str(w.createdAt) || new Date(0).toISOString(),
    }));
  const members: Member[] = (Array.isArray(o.members) ? o.members : [])
    .filter((m): m is Member => !!m && typeof m.id === "string" && typeof m.agentId === "string")
    .map((m) => ({
      id: m.id,
      name: str(m.name) || "Unnamed member",
      agentId: m.agentId,
      environmentId: typeof m.environmentId === "string" && m.environmentId ? m.environmentId : null,
      vaultId: typeof m.vaultId === "string" && m.vaultId ? m.vaultId : null,
      notes: str(m.notes),
    }));
  return { version: 1, projects, items, members };
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
export function reconcile(state: WorkbenchState, conversations: { channel_id?: string | null; title?: string | null; inserted_at?: string }[]): WorkbenchState {
  let projects = state.projects;
  let items = state.items;
  const projectIds = new Set(projects.map((p) => p.id));
  const itemIds = new Set(items.map((w) => w.id));
  for (const c of conversations) {
    const ref = parseChannel(c.channel_id);
    if (!ref) continue;
    if (!projectIds.has(ref.projectId)) {
      projects = [...projects, { id: ref.projectId, name: `Recovered project ${ref.projectId.slice(0, 6)}`, notes: "", createdAt: c.inserted_at ?? new Date(0).toISOString() }];
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
          memberIds: [],
          createdAt: c.inserted_at ?? new Date(0).toISOString(),
        },
      ];
      itemIds.add(ref.itemId);
    }
  }
  if (projects === state.projects && items === state.items) return state;
  return { ...state, projects, items };
}

/** Conversation titles are written as `<member>: <item title>`; get the item title back. */
export function conversationTitle(memberName: string, itemTitle: string): string {
  const t = `${memberName}: ${itemTitle}`;
  return t.length > 120 ? t.slice(0, 119) + "…" : t;
}

function recoveredTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const colon = title.indexOf(": ");
  return colon > 0 ? title.slice(colon + 2) : title;
}

// ── mutations: all pure, all return a new state ───────────────────────────

export function addProject(s: WorkbenchState, name: string, notes = ""): [WorkbenchState, Project] {
  const p: Project = { id: newId(), name: name.trim() || "Untitled project", notes, createdAt: new Date().toISOString() };
  return [{ ...s, projects: [...s.projects, p] }, p];
}

export function updateProject(s: WorkbenchState, id: string, patch: Partial<Pick<Project, "name" | "notes">>): WorkbenchState {
  return { ...s, projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)) };
}

export function removeProject(s: WorkbenchState, id: string): WorkbenchState {
  return { ...s, projects: s.projects.filter((p) => p.id !== id), items: s.items.filter((w) => w.projectId !== id) };
}

export function addItem(s: WorkbenchState, projectId: string, title: string, notes = ""): [WorkbenchState, WorkItem] {
  const w: WorkItem = { id: newId(), projectId, title: title.trim() || "Untitled work item", notes, status: "open", memberIds: [], createdAt: new Date().toISOString() };
  return [{ ...s, items: [...s.items, w] }, w];
}

export function updateItem(s: WorkbenchState, id: string, patch: Partial<Pick<WorkItem, "title" | "notes" | "status" | "memberIds">>): WorkbenchState {
  return { ...s, items: s.items.map((w) => (w.id === id ? { ...w, ...patch } : w)) };
}

export function removeItem(s: WorkbenchState, id: string): WorkbenchState {
  return { ...s, items: s.items.filter((w) => w.id !== id) };
}

export function addMember(s: WorkbenchState, input: Omit<Member, "id">): [WorkbenchState, Member] {
  const m: Member = { ...input, id: newId(), name: input.name.trim() || "Unnamed member" };
  return [{ ...s, members: [...s.members, m] }, m];
}

export function updateMember(s: WorkbenchState, id: string, patch: Partial<Omit<Member, "id">>): WorkbenchState {
  return { ...s, members: s.members.map((m) => (m.id === id ? { ...m, ...patch } : m)) };
}

export function removeMember(s: WorkbenchState, id: string): WorkbenchState {
  return {
    ...s,
    members: s.members.filter((m) => m.id !== id),
    items: s.items.map((w) => (w.memberIds.includes(id) ? { ...w, memberIds: w.memberIds.filter((x) => x !== id) } : w)),
  };
}

/** Put a member on an item (idempotent). */
export function assignMember(s: WorkbenchState, itemId: string, memberId: string): WorkbenchState {
  return { ...s, items: s.items.map((w) => (w.id === itemId && !w.memberIds.includes(memberId) ? { ...w, memberIds: [...w.memberIds, memberId] } : w)) };
}

export function unassignMember(s: WorkbenchState, itemId: string, memberId: string): WorkbenchState {
  return { ...s, items: s.items.map((w) => (w.id === itemId ? { ...w, memberIds: w.memberIds.filter((x) => x !== memberId) } : w)) };
}

/**
 * Which member a conversation was started as, when it can be told: the same
 * (agent, environment, vault) triple. `null` environment on a member means the
 * agent's own, which the conversation records as its id — so compare through
 * the agent's default when the member has none.
 */
export function memberFor(
  members: Member[],
  conversation: { agent_id?: string | null; environment_id?: string | null; vault_id?: string | null },
  agentDefaultEnvironment: string | null | undefined,
): Member | null {
  const env = conversation.environment_id ?? null;
  const vault = conversation.vault_id ?? null;
  return (
    members.find((m) => {
      if (m.agentId !== conversation.agent_id) return false;
      const memberEnv = m.environmentId ?? agentDefaultEnvironment ?? null;
      return memberEnv === env && (m.vaultId ?? null) === vault;
    }) ?? null
  );
}
