/**
 * Telling every open browser that something about a project changed.
 *
 * Deliberately not a data channel. Each event says *what kind of thing* moved
 * and the client re-asks — because the alternative, pushing the new state
 * down the wire, means two code paths that build a `Thread` and a day when
 * they disagree. Fountain's own account-wide stream uses the same trick for
 * the same reason: a `conversations` event carries `{reason: "changed"}` and
 * nothing else.
 *
 * The whole thing is in-process, which is why the deployment is one replica.
 * Two would each hold half the subscribers and each tell half the browsers.
 */
import type { ProjectEvent } from "../shared/api";

interface Subscriber {
  projectId: string;
  send: (chunk: string) => void;
  close: () => void;
}

class Hub {
  private readonly subscribers = new Set<Subscriber>();

  /**
   * One browser watching one project.
   *
   * The heartbeat is not decoration: a proxy that sees no bytes for a minute
   * closes the connection, and a silent project is the normal state. Fifteen
   * seconds matches what Fountain's own streams send.
   */
  subscribe(projectId: string, signal: AbortSignal): Response {
    let sub: Subscriber | null = null;
    const encoder = new TextEncoder();

    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            // The browser went away between the check and the write. Ordinary.
          }
        };
        sub = {
          projectId,
          send,
          close: () => {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          },
        };
        this.subscribers.add(sub);
        send(": connected\n\n");

        const beat = setInterval(() => send(": heartbeat\n\n"), 15_000);
        const stop = () => {
          clearInterval(beat);
          if (sub) this.subscribers.delete(sub);
          sub?.close();
        };
        signal.addEventListener("abort", stop, { once: true });
      },
      cancel: () => {
        if (sub) this.subscribers.delete(sub);
      },
    });

    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Traefik does not buffer by default; nginx does, and a buffered
        // event stream is an event stream that arrives all at once at the end.
        "x-accel-buffering": "no",
      },
    });
  }

  publish(projectId: string, event: ProjectEvent): void {
    const frame = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
    for (const sub of this.subscribers) {
      if (sub.projectId === projectId) sub.send(frame);
    }
  }

  /** How many browsers are watching. Exported for the tests, and for a log line. */
  get size(): number {
    return this.subscribers.size;
  }
}

export const hub = new Hub();
