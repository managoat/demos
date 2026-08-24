/**
 * The sidebar's model: the project's computers — one per sandbox, the
 * active team members — each with the conversations on it, live ones
 * first. Pure functions; the component is components/Sidebar.tsx.
 *
 * A computer is live while a conversation still holds it (pending, running
 * or idle); the sandbox record, when we have it, has the last word. Fountain
 * attaches a second conversation only to a `ready` or `suspended` sandbox.
 */
import type { Conversation, SandboxRecord } from "../types";
import { parseChannel } from "../../shared/channel";

export const LIVE_STATUSES = new Set<Conversation["status"]>(["pending", "running", "idle"]);
export const ATTACHABLE = new Set<string>(["ready", "suspended"]);

export interface Computer {
  /** The sandbox id, or `conv:<id>` for a conversation that never got one. */
  key: string;
  sandboxId: string | null;
  agentId: string | null;
  sandbox: SandboxRecord | null;
  /** Most recent activity first. */
  conversations: Conversation[];
  live: boolean;
  /** A turn is in flight on it. */
  busy: boolean;
  unread: boolean;
  /** ISO time of the latest activity on it. */
  latest: string;
}

function activityOf(c: Conversation): string {
  return c.last_active_at ?? c.updated_at ?? c.inserted_at ?? "";
}

/** Conversations sorted by activity, most recent first. */
export function byActivity(convs: Conversation[]): Conversation[] {
  return [...convs].sort((a, b) => activityOf(b).localeCompare(activityOf(a)));
}

export function computersOf(convs: Conversation[], sandboxes: ReadonlyMap<string, SandboxRecord>): Computer[] {
  const byKey = new Map<string, Computer>();
  for (const c of byActivity(convs)) {
    const key = c.sandbox_id ?? `conv:${c.id}`;
    let comp = byKey.get(key);
    if (!comp) {
      comp = {
        key,
        sandboxId: c.sandbox_id ?? null,
        agentId: c.agent_id ?? null,
        sandbox: c.sandbox_id ? sandboxes.get(c.sandbox_id) ?? null : null,
        conversations: [],
        live: false,
        busy: false,
        unread: false,
        latest: "",
      };
      byKey.set(key, comp);
    }
    comp.conversations.push(c);
    if (!comp.agentId && c.agent_id) comp.agentId = c.agent_id;
    if (c.status === "running" || c.status === "pending") comp.busy = true;
    if (c.unread) comp.unread = true;
    const at = activityOf(c);
    if (at > comp.latest) comp.latest = at;
  }
  for (const comp of byKey.values()) comp.live = isLive(comp);
  return [...byKey.values()].sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return b.latest.localeCompare(a.latest);
  });
}

export function isLive(c: Pick<Computer, "sandboxId" | "sandbox" | "conversations">): boolean {
  if (!c.sandboxId) return false;
  if (c.sandbox && (c.sandbox.status === "terminated" || c.sandbox.status === "failed")) return false;
  return c.conversations.some((x) => LIVE_STATUSES.has(x.status));
}

/** Whether "+ Here" can work right now: the record says ready or suspended. */
export function attachable(c: Pick<Computer, "sandbox">): boolean {
  return !!c.sandbox && ATTACHABLE.has(c.sandbox.status);
}

/** The work item a conversation belongs to, off its channel. */
export function itemIdOf(c: Pick<Conversation, "channel_id">): string | null {
  return parseChannel(c.channel_id)?.itemId ?? null;
}

/** Ns / Nm / Nh / Nd ago. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const secs = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(secs)) return "—";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/** The sandbox's name for a label: the sprite, or the id's head. */
export function computerLabel(c: Pick<Computer, "sandbox" | "sandboxId">): string {
  if (c.sandbox?.sprite_name) return c.sandbox.sprite_name.replace(/^fountain-[0-9a-f]{8}-/, "");
  return c.sandboxId ? c.sandboxId.slice(0, 8) : "no computer";
}
