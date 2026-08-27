/**
 * The workbench model: a project is an environment + vault (the computer
 * every conversation in it gets), and holds work items; a work item pulls in
 * teammates, which are simply agents; the team is the agent list the
 * project's owner has on Fountain.
 *
 * So the sandbox identity `(user, agent, environment, vault)` falls out of
 * the tree: same project + same agent = the same identity, which is what
 * lets two conversations share one computer. The user in that identity is
 * always the project's owner — every conversation in a project runs on the
 * owner's Fountain key, whichever member started it.
 *
 * The tree lives on the workbench server (server/), shared between the
 * project's members; a conversation's membership is also recorded on
 * Fountain, in its `channel_id`, as `workbench:<project>/<item>/<tag>`
 * (shared/channel.ts — one channel per conversation, since a Fountain
 * channel binds only one), which is what makes the tree recoverable from
 * the conversation list alone.
 */
import { markedAs, parseItemStatus, type ItemStatus, type Proposal } from "../../shared/status";
import type { RetiredDto } from "./api";

export { channelFor, channelIsItem, channelPrefix, conversationTitle, newId, parseChannel } from "../../shared/channel";
export { isClosed, ITEM_STATUSES, statusLabel } from "../../shared/status";
export type { ItemStatus, Proposal } from "../../shared/status";
export type { ItemDto as WorkItem, ProjectDto as Project } from "./api";

/**
 * Who a proposal is from, as a row says it: the teammate that made it, since
 * "Coder says: won't do" is what a person needs to read. An agent that has
 * since gone from the team — or a proposal made on a bare key, from outside
 * any conversation — falls back to the account it was made on.
 */
export function proposerName(proposal: Proposal, agents: Map<string, { name: string }>): string {
  return (proposal.agentId ? agents.get(proposal.agentId)?.name : null) ?? proposal.email;
}

/**
 * What to say after an item was closed — done or won't do — and the server
 * retired its computers. Nothing to report when there was nothing running on it.
 */
export function retiredMessage(r: RetiredDto, status: ItemStatus = "done"): { text: string; kind: "info" | "error" } | null {
  if (r.failed > 0 || r.error) {
    const what = r.failed > 0 ? `${count(r.failed, "conversation")} would not retire` : "its computers could not be retired";
    return { text: `${markedAs(status)}, but ${what}${r.error ? `: ${r.error}` : "."}`, kind: "error" };
  }
  if (r.conversations === 0) return null;
  const on = r.computers > 0 ? ` on ${count(r.computers, "computer")}` : "";
  return { text: `Retired ${count(r.conversations, "conversation")}${on}.`, kind: "info" };
}

/**
 * What to say after a computer was taken out of a work item. Removing retires
 * whatever was still live on it first (server/projects.ts), and that is the
 * only part worth a word: a computer that was already down went quietly, and
 * "removed" is visible on screen without being told. One that would *not* go
 * is news either way round — the row has left the item and the machine has
 * not, which is the one outcome a person needs to hear about.
 */
export function removedMessage(r: RetiredDto): { text: string; kind: "info" | "error" } | null {
  if (r.failed > 0 || r.error) {
    const what = r.failed > 0 ? `${count(r.failed, "conversation")} would not retire, so it may still be running` : "it may still be running";
    return { text: `Removed, but ${what}${r.error ? `: ${r.error}` : "."}`, kind: "error" };
  }
  if (r.conversations === 0) return null;
  return { text: `Removed, and retired ${count(r.conversations, "conversation")} on it.`, kind: "info" };
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Whether an agent can run in a project: its allowlists, when set, must admit
 * the project's environment and vault. The server refuses otherwise (422), so
 * the picker says so first.
 */
export function agentFits<A extends { allowed_environment_ids?: string[] | null; allowed_vault_ids?: string[] | null }>(
  agent: A,
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

/**
 * The project's default teammate — who new work starts with when nobody says
 * otherwise. Null when none is set, when the agent has left the owner's
 * Fountain, or when it no longer fits the project: a default that cannot run
 * is not one, and every picker falls back to asking.
 */
export function defaultTeammate<A extends { allowed_environment_ids?: string[] | null; allowed_vault_ids?: string[] | null }>(
  project: { environmentId: string | null; vaultId: string | null; defaultAgentId: string | null },
  agents: Map<string, A>,
): A | null {
  if (!project.defaultAgentId) return null;
  const agent = agents.get(project.defaultAgentId);
  if (!agent) return null;
  return agentFits(agent, project).ok ? agent : null;
}

// ── the tree an earlier build kept in this browser ─────────────────────────

/** What `fountain-workbench.state` held before the server existed. Imported once, then cleared. */
export interface LegacyState {
  projects: { id: string; name: string; notes: string; environmentId: string | null; vaultId: string | null; createdAt: string }[];
  items: { id: string; projectId: string; title: string; notes: string; status: ItemStatus; agentIds: string[]; createdAt: string }[];
}

const LEGACY_KEY = "fountain-workbench.state";

export function loadLegacyState(): LegacyState | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const s = normalizeLegacy(JSON.parse(raw));
    return s.projects.length > 0 ? s : null;
  } catch {
    return null;
  }
}

export function clearLegacyState(): void {
  localStorage.removeItem(LEGACY_KEY);
}

/** Accept a parsed JSON blob and make it a valid legacy state. */
export function normalizeLegacy(input: unknown): LegacyState {
  const o = (input && typeof input === "object" ? input : {}) as Partial<LegacyState>;
  const projects: LegacyState["projects"] = (Array.isArray(o.projects) ? o.projects : [])
    .filter((p): p is LegacyState["projects"][number] => !!p && typeof p.id === "string")
    .map((p) => ({
      id: p.id,
      name: str(p.name) || "Untitled project",
      notes: str(p.notes),
      environmentId: typeof p.environmentId === "string" && p.environmentId ? p.environmentId : null,
      vaultId: typeof p.vaultId === "string" && p.vaultId ? p.vaultId : null,
      createdAt: str(p.createdAt) || new Date(0).toISOString(),
    }));
  const projectIds = new Set(projects.map((p) => p.id));
  const items: LegacyState["items"] = (Array.isArray(o.items) ? o.items : [])
    .filter((w): w is LegacyState["items"][number] => !!w && typeof w.id === "string" && typeof w.projectId === "string" && projectIds.has(w.projectId))
    .map((w) => ({
      id: w.id,
      projectId: w.projectId,
      title: str(w.title) || "Untitled work item",
      notes: str(w.notes),
      status: parseItemStatus(w.status),
      agentIds: Array.isArray(w.agentIds) ? w.agentIds.filter((m): m is string => typeof m === "string") : [],
      createdAt: str(w.createdAt) || new Date(0).toISOString(),
    }));
  return { projects, items };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
