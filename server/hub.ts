/**
 * The chat's own live channel: one server-sent stream per browser per chat
 * (`GET /api/chats/:id/stream`), carrying whatever Salon itself records and
 * everyone in the room should see at once — a game's board, the
 * repository's changes — each as a named event with the whole record.
 * Fountain's conversation stream is the other channel; this one is for what
 * Fountain does not know about.
 *
 * One process, one map. Fine on the one replica the volume allows.
 */
import type { PresenceDto, PresenceHeartbeatInput, PresencePersonDto, TypingDto, ViewingDto } from "../shared/control";
import { authenticate, chatAccess, type AppContext } from "./context";

export type ChatEvent = { event: "game" | "changes" | "comment" | "note" | "control" | "presence" | "typing" | "viewing" | "plan" | "approval" | "execution" | "turn"; data: unknown };

type Listener = (e: ChatEvent) => void;

const PRESENCE_TTL_MS = 45_000;
const TYPING_TTL_MS = 8_000;

interface PresenceEntry {
  email: string;
  clientId: string;
  seenAt: number;
  expiresAt: number;
  typingUntil: number;
  viewing: PresenceHeartbeatInput["viewing"];
}

export class Hub {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly occupants = new Map<string, Map<string, PresenceEntry>>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  subscribe(chatId: string, fn: Listener): () => void {
    const set = this.listeners.get(chatId) ?? new Set();
    set.add(fn);
    this.listeners.set(chatId, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(chatId);
    };
  }

  publish(chatId: string, event: ChatEvent["event"], data: unknown): void {
    for (const fn of this.listeners.get(chatId) ?? []) fn({ event, data });
  }

  /**
   * Refresh one browser's lease. Browsers should heartbeat at least every
   * twenty seconds; a vanished tab is removed without needing a disconnect.
   */
  heartbeat(chatId: string, email: string, input: PresenceHeartbeatInput, nowMs = Date.now()): PresenceDto {
    this.expire(chatId, nowMs, false);
    const room = this.occupants.get(chatId) ?? new Map<string, PresenceEntry>();
    const key = `${email}\u0000${input.clientId}`;
    room.set(key, {
      email,
      clientId: input.clientId,
      seenAt: nowMs,
      expiresAt: nowMs + PRESENCE_TTL_MS,
      typingUntil: input.typing ? nowMs + TYPING_TTL_MS : 0,
      viewing: input.viewing,
    });
    this.occupants.set(chatId, room);
    const snapshot = this.snapshot(chatId, nowMs);
    const person = snapshot.people.find((p) => p.email === email)!;
    this.publish(chatId, "presence", snapshot);
    this.publish(chatId, "typing", { chatId, email, typing: person.typing, expiresAt: person.expiresAt } satisfies TypingDto);
    this.publish(chatId, "viewing", { chatId, email, viewing: person.viewing, expiresAt: person.expiresAt } satisfies ViewingDto);
    this.scheduleExpiry(chatId, nowMs);
    return snapshot;
  }

  /** Current live occupants, aggregated across a person's browser tabs. */
  presence(chatId: string, nowMs = Date.now()): PresenceDto {
    this.expire(chatId, nowMs, false);
    return this.snapshot(chatId, nowMs);
  }

  /** Explicit tab departure; lease expiry remains the fallback. */
  leave(chatId: string, email: string, clientId: string, nowMs = Date.now()): PresenceDto {
    const room = this.occupants.get(chatId);
    room?.delete(`${email}\u0000${clientId}`);
    if (room?.size === 0) this.occupants.delete(chatId);
    const snapshot = this.snapshot(chatId, nowMs);
    this.publish(chatId, "presence", snapshot);
    const person = snapshot.people.find((p) => p.email === email);
    this.publish(chatId, "typing", { chatId, email, typing: person?.typing ?? false, expiresAt: person?.expiresAt ?? new Date(nowMs).toISOString() } satisfies TypingDto);
    this.publish(chatId, "viewing", { chatId, email, viewing: person?.viewing ?? null, expiresAt: person?.expiresAt ?? new Date(nowMs).toISOString() } satisfies ViewingDto);
    this.scheduleExpiry(chatId, nowMs);
    return snapshot;
  }

  /** For tests. */
  listening(chatId: string): number {
    return this.listeners.get(chatId)?.size ?? 0;
  }

  private snapshot(chatId: string, nowMs: number): PresenceDto {
    const byEmail = new Map<string, PresenceEntry[]>();
    for (const entry of this.occupants.get(chatId)?.values() ?? []) {
      if (entry.expiresAt <= nowMs) continue;
      const list = byEmail.get(entry.email) ?? [];
      list.push(entry);
      byEmail.set(entry.email, list);
    }
    const people: PresencePersonDto[] = [];
    for (const [email, entries] of byEmail) {
      entries.sort((a, b) => b.seenAt - a.seenAt || a.clientId.localeCompare(b.clientId));
      const latest = entries[0]!;
      const viewed = entries.find((e) => e.viewing !== null)?.viewing ?? null;
      people.push({
        email,
        lastSeenAt: new Date(latest.seenAt).toISOString(),
        expiresAt: new Date(Math.max(...entries.map((e) => e.expiresAt))).toISOString(),
        typing: entries.some((e) => e.typingUntil > nowMs),
        viewing: viewed,
      });
    }
    people.sort((a, b) => a.email.localeCompare(b.email));
    return { chatId, at: new Date(nowMs).toISOString(), people };
  }

  private expire(chatId: string, nowMs: number, announce: boolean): void {
    const room = this.occupants.get(chatId);
    if (!room) return;
    const emails = announce ? new Set([...room.values()].map((entry) => entry.email)) : null;
    for (const [key, entry] of room) if (entry.expiresAt <= nowMs) room.delete(key);
    if (room.size === 0) this.occupants.delete(chatId);
    if (!announce) return;
    const snapshot = this.snapshot(chatId, nowMs);
    this.publish(chatId, "presence", snapshot);
    for (const email of emails ?? []) {
      const after = snapshot.people.find((person) => person.email === email);
      this.publish(chatId, "typing", { chatId, email, typing: after?.typing ?? false, expiresAt: after?.expiresAt ?? snapshot.at } satisfies TypingDto);
      this.publish(chatId, "viewing", { chatId, email, viewing: after?.viewing ?? null, expiresAt: after?.expiresAt ?? snapshot.at } satisfies ViewingDto);
    }
  }

  private scheduleExpiry(chatId: string, nowMs: number): void {
    const prior = this.expiryTimers.get(chatId);
    if (prior) clearTimeout(prior);
    const entries = [...(this.occupants.get(chatId)?.values() ?? [])];
    if (entries.length === 0) {
      this.expiryTimers.delete(chatId);
      return;
    }
    const next = Math.min(...entries.flatMap((e) => [e.expiresAt, ...(e.typingUntil > nowMs ? [e.typingUntil] : [])]));
    const timer = setTimeout(() => {
      this.expiryTimers.delete(chatId);
      const at = Date.now();
      this.expire(chatId, at, true);
      this.scheduleExpiry(chatId, at);
    }, Math.max(1, next - nowMs));
    this.expiryTimers.set(chatId, timer);
  }
}

export const hub = new Hub();

/**
 * The stream. Each change is one event carrying its whole record — small
 * enough that a diff would cost more than it saves, a changes record aside,
 * which is sent without its diff so a browser fetches that on demand — and a
 * comment every 25 s so an idle proxy keeps the connection.
 */
export async function stream(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // closed under us; the cancel below tidies up
        }
      };
      send(": hello\n\n");
      unsubscribe = hub.subscribe(chat.id, (e) => send(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
      send(`event: presence\ndata: ${JSON.stringify(hub.presence(chat.id))}\n\n`);
      keepalive = setInterval(() => send(": keepalive\n\n"), 25_000);
      req.signal.addEventListener("abort", () => {
        unsubscribe?.();
        if (keepalive) clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      unsubscribe?.();
      if (keepalive) clearInterval(keepalive);
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
}
