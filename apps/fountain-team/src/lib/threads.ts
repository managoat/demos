/**
 * Threads: more than one conversation with a teammate on the one computer.
 *
 * Fountain lets several conversations run on one sandbox as long as they
 * belong to the same agent (`sandbox_id` on `POST /api/conversations`). The
 * team itself still knows one conversation per teammate — the **main
 * thread**, bound to the `fountain:team` channel — so a **side thread** is
 * any other live conversation of that agent that points at the same
 * sandbox. Nothing is stored for this: the list is derived from
 * `GET /api/conversations`, and a thread is closed by terminating it (the
 * machine stays up while the main thread holds it).
 */
import type { Conversation, PresenceState, Teammate } from "../api/types";

export const TEAM_CHANNEL = "fountain:team";

/** The statuses a thread can be in and still be talked to. */
export const LIVE_STATUSES = ["pending", "idle", "running"] as const;

export function isLive(c: Pick<Conversation, "status">): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(c.status);
}

/**
 * The side threads of a teammate among `all` (the account's live
 * conversations): same agent, same sandbox as the main thread, not the main
 * thread and not on the team channel, oldest first so tab order is stable.
 */
export function sideThreadsOf(all: readonly Conversation[], teammate: Pick<Teammate, "agent_id" | "conversation">): Conversation[] {
  const main = teammate.conversation;
  if (!main.sandbox_id) return [];
  return all
    .filter(
      (c) =>
        c.id !== main.id &&
        c.agent_id === teammate.agent_id &&
        c.sandbox_id === main.sandbox_id &&
        c.channel_id !== TEAM_CHANNEL &&
        isLive(c),
    )
    .sort((a, b) => a.inserted_at.localeCompare(b.inserted_at));
}

/** Every teammate's side threads at once, keyed by agent id. */
export function groupSideThreads(all: readonly Conversation[], team: readonly Teammate[]): Map<string, Conversation[]> {
  const m = new Map<string, Conversation[]>();
  for (const t of team) {
    const side = sideThreadsOf(all, t);
    if (side.length) m.set(t.agent_id, side);
  }
  return m;
}

/** What a side thread is called: its title, else "Thread n" by position. */
export function threadTitle(c: Pick<Conversation, "title">, index: number): string {
  return c.title?.trim() || `Thread ${index + 2}`;
}

/** The next default name for a new side thread, skipping ones already taken. */
export function nextThreadTitle(existing: readonly Pick<Conversation, "title">[]): string {
  const taken = new Set(existing.map((c, i) => threadTitle(c, i)));
  for (let n = existing.length + 2; ; n++) {
    const candidate = `Thread ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * A side thread's presence, in the roster's vocabulary. The machine's state
 * is the teammate's (offline runner, failed computer); within that, the
 * thread is `working` for exactly its own turn, `starting` while the
 * computer is not ready, else `online`.
 */
export function threadPresence(c: Conversation, teammate: Pick<Teammate, "presence">): { state: PresenceState; label: string } {
  if (teammate.presence.state === "machine_offline") return teammate.presence;
  if (c.status === "running") return { state: "working", label: "working" };
  if (c.status === "failed") return { state: "failed", label: "failed" };
  if (c.status === "terminated") return { state: "offline", label: "closed" };
  const sb = c.sandbox;
  const starting = sb ? sb.status !== "ready" && sb.status !== "suspended" : teammate.presence.state === "starting";
  if (starting) return { state: "starting", label: "starting computer" };
  return { state: "online", label: "online" };
}

/**
 * A teammate as seen through one of its side threads: the same person, but
 * `conversation`, `presence`, `unread` and `preview` are the thread's. This
 * is what lets the Thread component show a side thread unchanged.
 */
export function viewThrough(teammate: Teammate, thread: Conversation): Teammate {
  return {
    ...teammate,
    conversation: thread,
    presence: threadPresence(thread, teammate),
    unread: thread.unread,
    last_turn: null,
    preview: null,
  };
}

/** Is a queue/route key a side thread (a conversation id) rather than a teammate (an agent id)? */
export function threadOfKey(threads: ReadonlyMap<string, readonly Conversation[]>, key: string): { agentId: string; thread: Conversation } | null {
  for (const [agentId, list] of threads) {
    const thread = list.find((c) => c.id === key);
    if (thread) return { agentId, thread };
  }
  return null;
}
