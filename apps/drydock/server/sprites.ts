/**
 * Running a command on the machine.
 *
 * Fountain deliberately has no exec — its API reference says so in one line:
 * *there is no request that runs a command; to run a command, send a prompt.*
 * That is the right boundary for Fountain, and it is why paddock's terminal is
 * a Claude Code prompt rendered as scrollback rather than a shell.
 *
 * Drydock goes one layer down. Fountain's sandboxes run on Sprites, and
 * every sandbox tells you the name of its sprite (`sandbox.sprite_name`), so a
 * server holding a Sprites token can reach the same machine directly. That
 * buys two things a conversation genuinely cannot give you: a **real terminal**
 * — a PTY, with job control and an editor that works — and a **run command**
 * whose output you watch without spending a turn.
 *
 * Four things about this are worth being clear-eyed about, and the UI says all
 * four rather than leaving them to be discovered:
 *
 *   1. **It is optional.** No `SPRITES_TOKEN`, no terminal — and drydock
 *      still works completely, because everything else goes through Fountain.
 *      The panels render a designed empty state naming what is missing.
 *   2. **It is out of band.** These commands are not turns. They are not in the
 *      transcript, they do not wait for the agent's lock, and the machine's own
 *      record of the conversation does not know they happened. That is the
 *      feature — you can look around while the agent works — and it is also the
 *      thing to remember when the agent seems confused about a file you moved.
 *   3. **It is the same disk, not a copy.** A thread owns its machine outright,
 *      so there is nobody else's work to damage here. The blast radius of this
 *      terminal is exactly one thread, which is the whole reason threads get a
 *      machine each.
 *   4. **The token is the platform's.** It is never sent to a browser and never
 *      written onto a sprite. `server/app.ts` proxies the terminal so the
 *      browser's socket carries a drydock session cookie and nothing else.
 *
 * The wire format is Sprites' own and is not guessable, so it is written down
 * here: exec is a **WebSocket**, not a POST; in non-TTY mode every binary
 * message is `[stream-id, ...payload]` with ids 0 stdin, 1 stdout, 2 stderr,
 * 3 exit (payload is **one** byte), 4 stdin-EOF; in TTY mode the prefix is gone
 * and control messages arrive as JSON text frames. A clean close with no exit
 * frame means exit 0. `argv[0]` goes in the query twice — once as `path`, once
 * as the first `cmd`.
 */

/** Non-TTY stream ids. */
const STDIN = 0;
const STDOUT = 1;
const STDERR = 2;
const EXIT = 3;
const STDIN_EOF = 4;

/**
 * How long to allow the WebSocket handshake.
 *
 * Longer than the Elixir SDK's ten seconds on purpose. Sprites scale to zero
 * on their own and wake as a side effect of the next exec, so the *first*
 * command against a parked machine pays for the wake inside the handshake.
 * Ten seconds is enough for a warm sprite and not always enough for a cold one,
 * and the failure mode of being too strict is an error message about the
 * network for what is actually a machine yawning.
 */
const HANDSHAKE_MS = 45_000;

export interface SpritesConfig {
  token: string;
  baseUrl: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  durationMs: number;
}

export class SpritesError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A live PTY on a machine. `server/app.ts` bridges one of these to a browser. */
export interface TtySession {
  /** Terminal bytes from the machine. */
  onData(fn: (bytes: Uint8Array) => void): void;
  /** The command exited; the socket is closing. */
  onExit(fn: (code: number) => void): void;
  /** Keystrokes to the machine. Raw, unprefixed — that is what TTY mode means. */
  write(bytes: Uint8Array | string): void;
  resize(rows: number, cols: number): void;
  close(): void;
  readonly open: boolean;
}

export class Sprites {
  constructor(private readonly cfg: SpritesConfig) {}

  private wsUrl(spriteName: string, qs: URLSearchParams): string {
    const base = this.cfg.baseUrl.replace(/^http/, "ws");
    return `${base}/v1/sprites/${encodeURIComponent(spriteName)}/exec?${qs}`;
  }

  private open(url: string): WebSocket {
    // Bun's WebSocket takes headers, which is the only way to carry a bearer
    // token onto an upgrade — the browser API has no equivalent, which is
    // exactly why this proxy exists rather than the browser talking to Sprites.
    return new WebSocket(url, { headers: { authorization: `Bearer ${this.cfg.token}`, "user-agent": "drydock" } } as never);
  }

  /**
   * One command, as an argv, collected to the end.
   *
   * Non-TTY, so stdout and stderr stay apart — the Run panel colours them
   * differently and a merged stream cannot be un-merged. The exit code is
   * recorded when its frame arrives and the promise settles on `close`, which
   * is what makes "closed without an exit frame" mean exit 0 for free.
   */
  async run(spriteName: string, argv: string[], opts: { cwd?: string; timeoutSec?: number; env?: Record<string, string> } = {}): Promise<RunResult> {
    if (argv.length === 0) throw new SpritesError(400, "No command given.");
    const started = Date.now();
    const timeoutMs = Math.max(1, opts.timeoutSec ?? 60) * 1000;

    const qs = new URLSearchParams();
    qs.set("path", argv[0]!);
    for (const a of argv) qs.append("cmd", a);
    qs.set("stdin", "false");
    if (opts.cwd) qs.set("dir", opts.cwd);
    for (const [k, v] of Object.entries(opts.env ?? {})) qs.append("env", `${k}=${v}`);

    const ws = this.open(this.wsUrl(spriteName, qs));
    ws.binaryType = "arraybuffer";

    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    let code: number | null = null;
    let timedOut = false;

    return await new Promise<RunResult>((resolve, reject) => {
      const handshake = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* already gone */
        }
        reject(new SpritesError(504, "The machine did not accept a connection in time. It may still be waking up."));
      }, HANDSHAKE_MS);

      let deadline: ReturnType<typeof setTimeout> | null = null;

      const settle = () => {
        clearTimeout(handshake);
        if (deadline) clearTimeout(deadline);
        resolve({
          stdout: decode(out),
          stderr: decode(err),
          // A clean close with no exit frame is exit 0 — Sprites' own rule,
          // and the one that made every failed command look successful when
          // the exit frame's width was misread. See the note at the top.
          code: code ?? 0,
          timedOut,
          durationMs: Date.now() - started,
        });
      };

      ws.addEventListener("open", () => {
        clearTimeout(handshake);
        deadline = setTimeout(() => {
          timedOut = true;
          try {
            ws.close();
          } catch {
            /* already gone */
          }
        }, timeoutMs);
      });

      ws.addEventListener("message", (ev) => {
        const data = ev.data;
        if (typeof data === "string") {
          // A control frame on a non-TTY exec is unusual but not impossible;
          // an exit here counts the same as frame 3.
          const parsed = parseControl(data);
          if (parsed?.type === "exit") code = parsed.exitCode ?? 0;
          return;
        }
        const bytes = new Uint8Array(data as ArrayBuffer);
        if (bytes.length === 0) return;
        const id = bytes[0]!;
        const payload = bytes.subarray(1);
        if (id === STDOUT) out.push(payload);
        else if (id === STDERR) err.push(payload);
        else if (id === EXIT) code = payload[0] ?? 0;
      });

      ws.addEventListener("close", settle);

      ws.addEventListener("error", () => {
        clearTimeout(handshake);
        if (deadline) clearTimeout(deadline);
        // An upgrade that fails answers with an ordinary HTTP response rather
        // than a 101, and the browser-shaped WebSocket API throws that away —
        // so there is no status to report and guessing one would be worse.
        reject(new SpritesError(502, "Could not reach this machine over Sprites. It may have been reclaimed."));
      });
    });
  }

  /**
   * A shell command, with its exit code and the directory it ended up in.
   *
   * The Run panel's unit of work. `cd` has to be remembered by *something* —
   * each exec is a fresh process — so the wrapper prints `$PWD` behind a
   * sentinel and the client sends it back with the next command. The sentinel
   * is deliberately unguessable rather than a newline convention, because a
   * command's own output will eventually contain whatever separator you picked.
   */
  async shell(spriteName: string, command: string, cwd: string, timeoutSec = 120): Promise<RunResult & { cwd: string }> {
    const marker = "__drydock_pwd_9f1c__";
    const script = `cd ${shq(cwd)} 2>/dev/null || cd ${shq("/home/sprite")}; { ${command}\n }; __rc=$?; printf '\\n${marker}%s\\n' "$PWD"; exit $__rc`;
    const raw = await this.run(spriteName, ["bash", "-lc", script], { timeoutSec });
    const idx = raw.stdout.lastIndexOf(`\n${marker}`);
    if (idx === -1) return { ...raw, cwd };
    const after = raw.stdout.slice(idx + marker.length + 1);
    const nl = after.indexOf("\n");
    return { ...raw, stdout: raw.stdout.slice(0, idx), cwd: (nl === -1 ? after : after.slice(0, nl)).trim() || cwd };
  }

  /**
   * A login shell on a PTY.
   *
   * TTY mode changes the wire in three ways that all have to be handled
   * together: binary frames lose their stream-id prefix and are raw terminal
   * bytes, stdin is written raw for the same reason, and the exit arrives as a
   * JSON *text* frame rather than as frame 3. Getting one of the three wrong
   * produces a terminal that looks nearly right, which is worse than one that
   * does not open.
   *
   * Not detachable. A detached session replays its whole buffer from byte zero
   * on every attach with no cursor to skip past, so reconnecting to a long
   * session would mean re-sending megabytes of scrollback the browser has
   * already drawn. A terminal you re-open is a fresh shell, and the panel says
   * so rather than implying a session that survives the tab.
   */
  openTty(spriteName: string, opts: { cwd?: string; rows?: number; cols?: number } = {}): TtySession {
    const rows = clampDim(opts.rows, 24);
    const cols = clampDim(opts.cols, 80);
    const qs = new URLSearchParams();
    qs.set("path", "bash");
    qs.append("cmd", "bash");
    qs.append("cmd", "-l");
    qs.set("stdin", "true");
    qs.set("tty", "true");
    qs.set("rows", String(rows));
    qs.set("cols", String(cols));
    if (opts.cwd) qs.set("dir", opts.cwd);

    const ws = this.open(this.wsUrl(spriteName, qs));
    ws.binaryType = "arraybuffer";

    let onData: (b: Uint8Array) => void = () => {};
    let onExit: (code: number) => void = () => {};
    let exitCode: number | null = null;
    let opened = false;

    ws.addEventListener("open", () => {
      opened = true;
    });

    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        const parsed = parseControl(ev.data);
        if (parsed?.type === "exit") exitCode = parsed.exitCode ?? 0;
        return;
      }
      // Raw terminal bytes. No prefix to strip — that is what TTY mode is.
      onData(new Uint8Array(ev.data as ArrayBuffer));
    });

    const finish = () => {
      opened = false;
      onExit(exitCode ?? 0);
    };
    ws.addEventListener("close", finish);
    ws.addEventListener("error", finish);

    return {
      onData: (fn) => {
        onData = fn;
      },
      onExit: (fn) => {
        onExit = fn;
      },
      write: (bytes) => {
        // A send on a socket that has started closing is an ordinary race —
        // somebody typing as the shell exits — and must never throw out of here.
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
        } catch {
          /* the shell went away mid-keystroke */
        }
      },
      resize: (r, c) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify({ type: "resize", rows: clampDim(r, 24), cols: clampDim(c, 80) }));
        } catch {
          /* as above */
        }
      },
      close: () => {
        try {
          ws.close();
        } catch {
          /* already gone */
        }
      },
      get open() {
        return opened && ws.readyState === WebSocket.OPEN;
      },
    };
  }

  /** Is this machine answering at all? The difference between two empty states. */
  async reachable(spriteName: string): Promise<boolean> {
    try {
      const r = await this.run(spriteName, ["true"], { timeoutSec: 20 });
      return r.code === 0;
    } catch {
      return false;
    }
  }
}

/**
 * Where a command is allowed to run.
 *
 * A thread owns its whole machine, so this is not a security boundary and does
 * not pretend to be one — it is the reason `cd ..` out of the repository does
 * not strand the panel somewhere it cannot show a diff for. Escaping upward
 * snaps back to the root, and the panel shows where it actually is rather than
 * printing a refusal.
 */
export function resolveCwd(root: string, requested: string | undefined): string {
  if (!requested) return root;
  const normalized = normalizePosix(requested.startsWith("/") ? requested : `${root}/${requested}`);
  const rootNorm = normalizePosix(root);
  return normalized === rootNorm || normalized.startsWith(`${rootNorm}/`) ? normalized : rootNorm;
}

function normalizePosix(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/** Single-quote for `sh`, the only quoting that is safe for arbitrary bytes. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Sprites' JSON control frames, of which only `exit` changes anything here. */
export interface Control {
  type: string;
  /** Present only on `exit`, where it defaults to 0 if the server omitted it. */
  exitCode?: number;
}

export function parseControl(text: string): Control | null {
  try {
    const obj = JSON.parse(text) as { type?: unknown; exit_code?: unknown };
    if (typeof obj.type !== "string") return null;
    if (obj.type === "exit") return { type: "exit", exitCode: typeof obj.exit_code === "number" ? obj.exit_code : 0 };
    return { type: obj.type };
  } catch {
    return null;
  }
}

/**
 * Concatenate then decode, never the other way round.
 *
 * Message boundaries on Sprites' stdout are arbitrary, so a multi-byte UTF-8
 * character or an ANSI escape sequence can straddle two of them. Decoding each
 * message on arrival puts a replacement character in the middle of anything
 * non-ASCII, which shows up as mojibake in a test suite's output and nowhere
 * else anybody looks.
 */
function decode(chunks: Uint8Array[]): string {
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    merged.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(merged);
}

function clampDim(v: number | undefined, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(1, Math.min(1000, Math.round(v)));
}

/** Exported for `sprites.test.ts`, which proves the decoder against real frames. */
export const frames = { STDIN, STDOUT, STDERR, EXIT, STDIN_EOF };
