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
import { authenticate, chatAccess, type AppContext } from "./context";

export type ChatEvent = { event: "game" | "changes"; data: unknown };

type Listener = (e: ChatEvent) => void;

class Hub {
  private readonly listeners = new Map<string, Set<Listener>>();

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

  /** For tests. */
  listening(chatId: string): number {
    return this.listeners.get(chatId)?.size ?? 0;
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
