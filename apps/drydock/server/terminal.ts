/**
 * The terminal, as two sockets with this server in the middle.
 *
 * The browser cannot talk to Sprites directly and should not want to: a
 * WebSocket from a browser cannot carry an `Authorization` header, and the
 * Sprites token is the platform's — one token pays for every tenant's
 * machines, so it never leaves this process. So the browser opens a socket to
 * drydock carrying nothing but its own session cookie, this file opens the
 * other half to Sprites, and bytes move across.
 *
 * The bridge is deliberately thin. In TTY mode Sprites' binary frames are raw
 * terminal bytes with no framing of their own, and xterm.js on the other side
 * wants exactly those bytes — so anything this file did to them beyond passing
 * them along would be damage. The one piece of protocol it adds is for the
 * browser's *control* messages, which have nowhere else to go: a text frame
 * of `{"type":"resize"}` on the way in, and `{"type":"exit"}` on the way out.
 * Everything binary is data, in both directions, which keeps the rule short
 * enough to not get wrong.
 */
import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { Sprites, TtySession } from "./sprites";

export interface TerminalData {
  kind: "terminal";
  spriteName: string;
  cwd: string;
  rows: number;
  cols: number;
}

/**
 * The live session behind each browser socket.
 *
 * Held outside the socket's own `data` because Bun's upgrade payload is
 * assembled before the socket opens, and the Sprites connection cannot be
 * made until it does.
 */
const sessions = new WeakMap<ServerWebSocket<TerminalData>, TtySession>();

export function attachTerminal(sprites: () => Sprites | null): WebSocketHandler<TerminalData> {
  return {
    open(ws) {
      const client = sprites();
      if (!client) {
        ws.close(1011, "no sprites token");
        return;
      }

      const tty = client.openTty(ws.data.spriteName, { cwd: ws.data.cwd, rows: ws.data.rows, cols: ws.data.cols });
      sessions.set(ws, tty);

      tty.onData((bytes) => {
        // `send` on a closing socket is an ordinary race — the tab went away
        // mid-command — and must not throw out of a callback nobody awaits.
        try {
          ws.send(bytes);
        } catch {
          /* the browser has gone */
        }
      });

      tty.onExit((code) => {
        try {
          ws.send(JSON.stringify({ type: "exit", code }));
          ws.close(1000, "shell exited");
        } catch {
          /* as above */
        }
      });
    },

    message(ws, message) {
      const tty = sessions.get(ws);
      if (!tty) return;
      if (typeof message === "string") {
        // The only control the browser sends. Anything else is ignored rather
        // than refused — a future client saying more must not break this one.
        try {
          const parsed = JSON.parse(message) as { type?: string; rows?: number; cols?: number };
          if (parsed.type === "resize") tty.resize(Number(parsed.rows), Number(parsed.cols));
        } catch {
          /* not JSON; not ours */
        }
        return;
      }
      tty.write(new Uint8Array(message as unknown as ArrayBufferLike));
    },

    close(ws) {
      sessions.get(ws)?.close();
      sessions.delete(ws);
    },

    // A PTY is silent while somebody reads. Without this Bun closes the socket
    // out from under a terminal that was simply not being typed into.
    idleTimeout: 960,
  };
}
