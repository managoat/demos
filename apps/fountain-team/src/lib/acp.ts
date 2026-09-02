/**
 * Turn stored log events into what a chat bubble shows.
 *
 * The `acp` stream holds the raw Agent Client Protocol ndjson the adapter
 * emitted — one `session/update` notification per line. This is a port of
 * `Fountain.Runtimes.ACP.Blocks` (server side, tested there): text chunks
 * concatenate into the assistant's reply, tool calls become chips paired to
 * their result on `toolCallId`, everything else is dropped on purpose.
 *
 * One *request* renders too: `session/request_permission` (fountain#940). The
 * agent is blocked on it and a human has to answer, so it belongs inline in
 * the transcript beside the tool it is about. Its resolution cannot mutate
 * this block — log events are immutable — so it arrives separately as a
 * `request` stage event and is paired on `request_id` (see `permissions.ts`).
 *
 * Non-ACP runtimes (legacy stdout) are shown as plain text lines — good
 * enough for a preview; the full conversation view in Fountain does better.
 */
import type { LogEvent } from "../api/types";

export type Block =
  | { kind: "text"; body: string; startedAt: string | null; endedAt: string | null }
  | { kind: "thinking"; body: string; startedAt: string | null; endedAt: string | null }
  | {
      kind: "tool";
      id: string | null;
      name: string;
      summary: string;
      status: "running" | "done" | "error";
      output: string;
      /** event timestamps: when the call was announced and when it settled */
      startedAt: string | null;
      endedAt: string | null;
    }
  | {
      kind: "permission";
      /** answer with POST /api/conversations/:id/requests/:requestId */
      requestId: string;
      /** the tool being asked about */
      name: string;
      summary: string;
      /** exactly what the agent offered, in its order — never add to this */
      options: PermissionOption[];
      /** event timestamp: when the agent asked */
      startedAt: string | null;
    }
  | { kind: "raw"; body: string };

/**
 * One choice the agent offered. `kind` is ACP's own vocabulary —
 * `allow_once`, `allow_always`, `reject_once`, `reject_always` — and it is
 * advisory: it colours the button, it does not decide what is sent. Only
 * `optionId` is ever sent back.
 */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
  /** what picking it changes beyond this one call; empty for most options */
  effects: PermissionEffect[];
}

/**
 * What an option changes beyond the call being asked about.
 *
 * The agent sends this on the option itself, as `_meta.permission.changes`,
 * and it is the only place the **scope** of "always" is ever stated. That
 * matters more than it sounds: measured against claude-agent-acp 0.66 on
 * 2026-08-22, "Always Allow" writes a rule matching the *exact command line*
 * into `.claude/settings.local.json` in the teammate's sandbox — so the same
 * tool with a different argument asks again, and the rule dies with the
 * sandbox. A button labelled "Always Allow" over a rule that narrow promises
 * something the agent will not deliver, which is why this is carried through
 * rather than dropped.
 *
 * Advisory, like `kind`: it is never sent back and never decides anything.
 */
export interface PermissionEffect {
  /** the agent's own wording, e.g. ``Allow Bash calls matching `curl …` `` */
  description: string;
  /** ACP's lifetime scope — `persistent`, `session` — or null if unstated */
  scope: string | null;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/** Blocks for one turn's events, adjacent text merged, tools paired. */
export function blocksForTurn(events: LogEvent[], runtime: string): Block[] {
  const out: Block[] = [];
  const tools = new Map<string, Extract<Block, { kind: "tool" }>>();

  // startedAt/endedAt are the log timestamps of the first and last chunk
  // that landed in the block — "when the reply arrived", not when the model
  // produced it (one flush apart at most).
  const pushText = (kind: "text" | "thinking", body: string, ts: string | null) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) {
      last.body += body;
      if (ts) last.endedAt = ts;
    } else out.push({ kind, body, startedAt: ts, endedAt: ts });
  };

  for (const ev of events) {
    if (ev.kind !== "output" || typeof ev.data !== "string") continue;
    if (ev.stream === "acp") {
      for (const line of ev.data.split("\n")) {
        if (!line.trim()) continue;
        const update = updateOf(line);
        if (!update) {
          const ask = permissionOf(line);
          if (ask) out.push({ ...ask, startedAt: ev.ts ?? null });
          else if (!looksLikeJsonRpc(line)) out.push({ kind: "raw", body: line });
          continue;
        }
        switch (update.sessionUpdate) {
          case "agent_message_chunk": {
            const t = contentText(update.content);
            if (t) pushText("text", t, ev.ts ?? null);
            break;
          }
          case "agent_thought_chunk": {
            const t = contentText(update.content);
            if (t) pushText("thinking", t, ev.ts ?? null);
            break;
          }
          case "tool_call": {
            const id = str(update.toolCallId);
            const block: Extract<Block, { kind: "tool" }> = {
              kind: "tool",
              id,
              name: toolName(update),
              summary: toolSummary(update),
              status: "running",
              output: "",
              startedAt: ev.ts ?? null,
              endedAt: null,
            };
            out.push(block);
            if (id) tools.set(id, block);
            break;
          }
          case "tool_call_update": {
            const status = str(update.status);
            if (!status || !TERMINAL.has(status)) break;
            const id = str(update.toolCallId);
            const block = id ? tools.get(id) : undefined;
            if (block) {
              block.status = status === "completed" ? "done" : "error";
              block.output = toolOutput(update);
              block.endedAt = ev.ts ?? null;
            }
            break;
          }
          default:
            break;
        }
      }
    } else if (ev.stream === "stdout" && runtime !== "claude" && runtime !== "codex" && runtime !== "opencode") {
      // Legacy dialects: show the text as-is rather than parse four vendor
      // formats here. Claude/codex/opencode only ever spoke ACP on this page.
      pushText("text", ev.data, ev.ts ?? null);
    }
  }
  return out;
}

/** The concatenated assistant text of a turn — the roster preview and the bubble. */
export function assistantText(events: LogEvent[], runtime: string): string {
  return blocksForTurn(events, runtime)
    .filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text")
    .map((b) => b.body)
    .join("")
    .trim();
}

type Json = Record<string, unknown>;

function updateOf(line: string): Json | null {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(msg) || msg.method !== "session/update") return null;
  const params = msg.params;
  if (!isObj(params)) return null;
  const update = params.update;
  return isObj(update) ? update : params;
}

/**
 * A `session/request_permission` request line, as a block. Port of
 * `Fountain.Runtimes.ACP.Blocks.permission_blocks/2`.
 *
 * This is a JSON-RPC *request*, not a notification: it carries an `id` the
 * agent is blocked on, and that id — stringified, as the server stringifies
 * it — is the `request_id` the answer route takes.
 */
function permissionOf(line: string): Omit<Extract<Block, { kind: "permission" }>, "startedAt"> | null {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(msg) || msg.method !== "session/request_permission") return null;
  if (typeof msg.id !== "string" && typeof msg.id !== "number") return null;
  const params = isObj(msg.params) ? msg.params : {};
  const call = isObj(params.toolCall) ? params.toolCall : {};
  return {
    kind: "permission",
    requestId: String(msg.id),
    name: toolName(call),
    summary: toolSummary(call),
    options: permissionOptions(params.options),
  };
}

/**
 * The agent's own option list, in its order.
 *
 * An option with no `optionId` is dropped rather than rendered: the id is the
 * only thing an answer sends, and a button that cannot be answered with is
 * worse than one that is not offered. Nothing is ever added to this list —
 * synthesising an "allow" the agent did not offer is the failure the
 * server-side fail-closed rule exists to prevent.
 */
function permissionOptions(raw: unknown): PermissionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: PermissionOption[] = [];
  for (const o of raw) {
    if (!isObj(o)) continue;
    const optionId = str(o.optionId);
    if (!optionId) continue;
    out.push({
      optionId,
      name: str(o.name) || optionId,
      kind: str(o.kind) || "",
      effects: permissionEffects(o._meta),
    });
  }
  return out;
}

/**
 * The scope of an option, from its `_meta.permission.changes`.
 *
 * A change with no `description` is skipped rather than described from its
 * parts: the agent writes that sentence itself, and inventing one risks
 * saying "allows Bash" where the rule is far narrower — exactly the
 * over-promise this exists to prevent. Agents that send no metadata (codex's
 * "Allow for Session", opencode) yield an empty list and no note is shown.
 */
function permissionEffects(meta: unknown): PermissionEffect[] {
  if (!isObj(meta) || !isObj(meta.permission)) return [];
  const changes = meta.permission.changes;
  if (!Array.isArray(changes)) return [];
  const out: PermissionEffect[] = [];
  for (const c of changes) {
    if (!isObj(c)) continue;
    const description = str(c.description);
    if (!description) continue;
    out.push({ description, scope: isObj(c.lifetime) ? str(c.lifetime.scope) : null });
  }
  return out;
}

function looksLikeJsonRpc(line: string): boolean {
  try {
    const v = JSON.parse(line);
    return isObj(v) && v.jsonrpc === "2.0";
  } catch {
    return false;
  }
}

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function contentText(content: unknown): string {
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join("");
  if (typeof content === "string") return content;
  if (!isObj(content)) return "";
  switch (content.type) {
    case "text":
      return typeof content.text === "string" ? content.text : "";
    case "image":
      return "[image]";
    case "audio":
      return "[audio]";
    case "resource_link":
      return typeof content.uri === "string" ? content.uri : "";
    default:
      return "";
  }
}

function toolName(u: Json): string {
  const title = str(u.title);
  if (title) return title;
  const kind = str(u.kind);
  return kind || "tool";
}

function toolSummary(u: Json): string {
  const locs = u.locations;
  if (Array.isArray(locs) && locs.length > 0) {
    const first = locs[0];
    if (isObj(first) && typeof first.path === "string") return first.path;
  }
  const input = u.rawInput;
  if (isObj(input) && Object.keys(input).length > 0) {
    return truncate(
      Object.entries(input)
        .map(([k, v]) => `${k}=${truncate(typeof v === "string" ? v : JSON.stringify(v), 40)}`)
        .join(" "),
      120,
    );
  }
  return "";
}

function toolOutput(u: Json): string {
  const content = u.content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (isObj(c) && c.type === "content") return contentText(c.content);
        if (isObj(c) && c.type === "diff") return `diff: ${str(c.path) ?? ""}`;
        return contentText(c);
      })
      .join("\n");
  }
  const raw = u.rawOutput;
  if (raw == null) return "";
  return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
