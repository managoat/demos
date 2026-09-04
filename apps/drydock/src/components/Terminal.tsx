/**
 * A real PTY on the thread's machine, in the browser.
 *
 * The socket is drydock's, not Sprites' — the server bridges the two so the
 * platform's token never reaches a tab — and the protocol across it is
 * deliberately two rules wide: binary frames are terminal bytes in both
 * directions, and the only text frames are JSON control (`resize` out,
 * `exit` in). Anything this file did to the bytes beyond passing them along
 * would be damage.
 *
 * Everything is torn down on unmount, including on a tab switch. A PTY that
 * outlives the component holding it is a shell running on a machine somebody
 * is paying for with nothing attached to it, and there is no second place in
 * this UI that would ever find it again.
 */
import { FitAddon } from "@xterm/addon-fit";
import type { ITheme } from "@xterm/xterm";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import type { Capabilities, Thread } from "../../shared/api";
import * as api from "../api/client";

export interface TerminalProps {
  thread: Thread | null;
  capabilities: Capabilities;
}

type Phase = "connecting" | "live" | "exited" | "lost";

export function Terminal({ thread, capabilities }: TerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);

  const threadId = capabilities.exec ? (thread?.id ?? null) : null;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !threadId) return;

    setPhase("connecting");
    setExitCode(null);

    const term = new XTerm({
      fontFamily: cssVar("--mono", "ui-monospace, monospace"),
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      theme: themeFromCss(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* the pane has no size yet; the observer below will do it */
    }

    const socket = api.terminalSocket(threadId, term.rows, term.cols);
    socket.binaryType = "arraybuffer";
    const encoder = new TextEncoder();

    socket.onopen = () => setPhase("live");
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data === "string") {
        try {
          const control = JSON.parse(event.data) as { type?: string; code?: number };
          if (control.type === "exit") {
            const code = Number(control.code ?? 0);
            setExitCode(code);
            setPhase("exited");
            term.write(`\r\n\x1b[2mshell exited (${code})\x1b[0m\r\n`);
          }
        } catch {
          /* not ours */
        }
        return;
      }
      if (event.data instanceof ArrayBuffer) term.write(new Uint8Array(event.data));
    };
    socket.onclose = () => setPhase((prev) => (prev === "exited" ? prev : "lost"));
    socket.onerror = () => setPhase((prev) => (prev === "exited" ? prev : "lost"));

    const typed = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    });
    const resized = term.onResize(({ rows, cols }) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", rows, cols }));
    });

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* mid-teardown, or a pane with no height */
      }
    });
    observer.observe(host);

    // The shell's colours are the app's colours, and the app's theme is an
    // attribute on <html> — so the terminal follows a theme switch rather
    // than being the one panel that stays dark.
    const themeWatch = new MutationObserver(() => {
      term.options.theme = themeFromCss();
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      themeWatch.disconnect();
      observer.disconnect();
      typed.dispose();
      resized.dispose();
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        /* already gone */
      }
      term.dispose();
    };
  }, [threadId, generation]);

  if (!capabilities.exec) {
    return (
      <div className="empty dd-in-empty">
        <span className="dd-in-empty-icon">
          <TerminalIcon />
        </span>
        <h3>No Sprites token on this drydock</h3>
        <p>
          The terminal is a real shell on this thread's machine — the same disk the agent is working on, with your own prompt on it, for
          the times reading the diff is not enough.
        </p>
        <p>It needs a Sprites token to open a PTY, and this deployment has none configured.</p>
        <p className="dd-in-empty-what">SPRITES_TOKEN</p>
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="empty dd-in-empty">
        <h3>No thread open</h3>
        <p>Every thread has a machine of its own. Open one and its shell is here.</p>
      </div>
    );
  }

  return (
    <div className="dd-in-term">
      <div className="dd-in-term-host" ref={hostRef} />
      {phase !== "live" ? (
        <div className="dd-in-term-bar">
          {phase === "connecting" ? (
            <>
              <span className="dd-in-spin" />
              <span>opening a shell on this machine…</span>
            </>
          ) : (
            <>
              <span className={`dot ${phase === "exited" ? "" : "bad"}`} />
              <span>{phase === "exited" ? `shell exited${exitCode === null ? "" : ` (${exitCode})`}` : "the connection closed"}</span>
              <span className="spacer" />
              <button onClick={() => setGeneration((n) => n + 1)}>Restart</button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * xterm's palette, from the app's tokens.
 *
 * Only the colours drydock actually names are set. There is no token for
 * magenta or cyan, and inventing two here would be exactly the hardcoded
 * colour the design system exists to prevent — so those stay xterm's.
 */
function themeFromCss(): ITheme {
  return {
    background: cssVar("--code-bg", "#0a0b0e"),
    foreground: cssVar("--ink", "#e6e8ec"),
    cursor: cssVar("--accent", "#8ab4f8"),
    cursorAccent: cssVar("--code-bg", "#0a0b0e"),
    selectionBackground: cssVar("--accent-soft", "#1c3153"),
    selectionForeground: cssVar("--accent-ink", "#d7e6ff"),
    black: cssVar("--bg", "#0d0e11"),
    red: cssVar("--bad", "#e78c86"),
    green: cssVar("--ok", "#7bcf9b"),
    yellow: cssVar("--warn", "#e3bd77"),
    blue: cssVar("--accent", "#8ab4f8"),
    white: cssVar("--ink", "#e6e8ec"),
    brightBlack: cssVar("--faint", "#626a78"),
    brightRed: cssVar("--del", "#d9797a"),
    brightGreen: cssVar("--add", "#6fbf7f"),
    brightYellow: cssVar("--warn", "#e3bd77"),
    brightBlue: cssVar("--accent-ink", "#d7e6ff"),
    brightWhite: cssVar("--ink", "#e6e8ec"),
  };
}

function TerminalIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="m4.5 6.5 2 1.8-2 1.8M8.5 10.3h3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
