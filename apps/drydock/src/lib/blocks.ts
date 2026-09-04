/**
 * The transcript, folded out of a conversation's log events.
 *
 * The server proxies Fountain's events with `?blocks=true`, so every event
 * arrives with its content already parsed into blocks — the same parse
 * Fountain's own web UI uses. Nothing here knows what a runtime's dialect
 * looks like, and nothing here should ever have to: this file only *arranges*
 * what the server already understood.
 *
 * The arranging is three things a renderer should not be doing inline:
 * ordering (a stream can deliver an event twice, or late), joining (one
 * sentence of assistant text arrives as thirty blocks), and pairing (a tool's
 * result is a separate block from its call, sometimes several events later).
 * All three are pure functions of the event list, which is why they are here
 * and tested rather than in a component.
 */

/** A server-parsed content block. Every field is optional: this comes off the wire. */
export interface Block {
  /** `text` | `thinking` | `tool_use` | `tool_result` | `init` | `result` | `error` | `raw`. */
  kind: string;
  body?: string | null;
  summary?: string | null;
  /** On `tool_use`: the call's id, which its result names. */
  id?: string | null;
  name?: string | null;
  /** On `tool_result`: the `tool_use.id` this answers. */
  tool_id?: string | null;
  error?: boolean | null;
  /** On `result`: the runtime's own final payload, unparsed. */
  raw?: unknown;
}

/** One line of the conversation's log, as `/api/threads/:id/events` returns it. */
export interface TranscriptEvent {
  id: number;
  kind: "output" | "stage" | string;
  stream: "stdout" | "stderr" | "acp" | "stage" | string | null;
  data: string | null;
  stage: string | null;
  state: string | null;
  turn_id: string | null;
  ts: string;
  blocks?: Block[] | null;
}

export type ToolStatus = "running" | "done" | "error";

interface ItemBase {
  /** Stable across folds, so React keeps the DOM (and the open/closed tools). */
  key: string;
  /** The event that opened this item — what echoes and scroll anchors sort on. */
  eventId: number;
  turnId: string | null;
  at: string;
}

export interface UserItem extends ItemBase {
  kind: "user";
  text: string;
}

export interface TextItem extends ItemBase {
  kind: "text" | "thinking";
  body: string;
}

export interface ToolItem extends ItemBase {
  kind: "tool";
  toolId: string | null;
  name: string;
  summary: string;
  /** What the call was given. Empty when the runtime did not say. */
  input: string;
  /** What came back. Empty while it is still running. */
  output: string;
  status: ToolStatus;
}

export interface ErrorItem extends ItemBase {
  kind: "error";
  body: string;
}

/**
 * Something the runtime said that is not part of the conversation — a `raw`
 * block, or a result whose call never arrived. Kept rather than dropped: it is
 * usually the only trace of whatever went sideways.
 */
export interface NoticeItem extends ItemBase {
  kind: "notice";
  label: string;
  body: string;
}

export type TranscriptItem = UserItem | TextItem | ToolItem | ErrorItem | NoticeItem;

/**
 * A prompt this browser has just sent, held until the machine's own events
 * catch up.
 *
 * Fountain records a turn's prompt on the turn, not in the log stream, so a
 * message you send is invisible in the transcript until the reply lands. That
 * gap is a second or two of the app appearing to have swallowed what you
 * typed, which is the worst second or two to have.
 */
export interface Echo {
  key: string;
  text: string;
  /** The newest event id at the moment it was sent — where it sorts. */
  afterEventId: number;
  at: string;
}

/**
 * Events in, rendered items out.
 *
 * Sorted and de-duplicated first, so an out-of-order stream, a replayed
 * `Last-Event-ID` window and a history page that overlaps the tail all fold to
 * the same list.
 */
export function foldEvents(events: readonly TranscriptEvent[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  const calls = new Map<string, ToolItem>();

  for (const ev of ordered(events)) {
    if (ev.kind === "stage") {
      const item = stageItem(ev);
      if (item) out.push(item);
      continue;
    }
    // Anything without blocks is provisioning noise the header card already
    // reports on — apt's stdout, the clone's progress. The transcript is the
    // conversation.
    if (ev.kind !== "output" || !ev.blocks) continue;

    ev.blocks.forEach((b, i) => {
      const key = `${ev.id}:${i}`;
      switch (b.kind) {
        case "text":
        case "thinking": {
          const kind: TextItem["kind"] = b.kind === "thinking" ? "thinking" : "text";
          const body = b.body ?? "";
          if (!body) return;
          const last = out[out.length - 1];
          // One reply arrives as many blocks; joining them is what makes it a
          // paragraph rather than a column of fragments. Turns never join.
          if (last && last.kind === kind && last.turnId === (ev.turn_id ?? null)) {
            last.body += body;
            return;
          }
          out.push({ kind, key, eventId: ev.id, turnId: ev.turn_id ?? null, at: ev.ts, body });
          return;
        }
        case "tool_use": {
          const item: ToolItem = {
            kind: "tool",
            key,
            eventId: ev.id,
            turnId: ev.turn_id ?? null,
            at: ev.ts,
            toolId: b.id ?? null,
            name: b.name ?? "tool",
            summary: b.summary ?? "",
            input: b.body ?? "",
            output: "",
            status: "running",
          };
          out.push(item);
          if (b.id) calls.set(b.id, item);
          return;
        }
        case "tool_result": {
          const call = b.tool_id ? calls.get(b.tool_id) : undefined;
          if (call) {
            call.status = b.error ? "error" : "done";
            call.output = b.body ?? "";
            return;
          }
          // A result whose call we never saw. Rendered on its own rather than
          // dropped, because it is generally the interesting half.
          if (b.body) {
            out.push({
              kind: "notice",
              key,
              eventId: ev.id,
              turnId: ev.turn_id ?? null,
              at: ev.ts,
              label: b.error ? "tool result (failed)" : "tool result",
              body: b.body,
            });
          }
          return;
        }
        case "error": {
          if (b.body) {
            out.push({ kind: "error", key, eventId: ev.id, turnId: ev.turn_id ?? null, at: ev.ts, body: b.body });
          }
          return;
        }
        case "raw": {
          if (b.body) {
            out.push({
              kind: "notice",
              key,
              eventId: ev.id,
              turnId: ev.turn_id ?? null,
              at: ev.ts,
              label: b.summary ?? "unparsed output",
              body: b.body,
            });
          }
          return;
        }
        default:
          // `init` and `result` are session chrome: which model, how many
          // tokens. The transcript is not where a person reads those.
          return;
      }
    });
  }
  return out;
}

/**
 * Fold in the prompts this browser sent, each where it was sent.
 *
 * An echo is dropped as soon as the same text turns up as a real user item
 * after it, so a deployment whose turn events do carry the prompt does not
 * show the message twice.
 */
export function mergeEchoes(items: readonly TranscriptItem[], echoes: readonly Echo[]): TranscriptItem[] {
  if (echoes.length === 0) return items.slice();
  const pending = echoes.filter(
    (e) => !items.some((it) => it.kind === "user" && it.eventId >= e.afterEventId && it.text.trim() === e.text.trim()),
  );
  if (pending.length === 0) return items.slice();

  const out: TranscriptItem[] = [];
  const rest = [...pending].sort((a, b) => a.afterEventId - b.afterEventId);
  for (const item of items) {
    while (rest.length > 0 && rest[0]!.afterEventId < item.eventId) out.push(asItem(rest.shift()!));
    out.push(item);
  }
  for (const echo of rest) out.push(asItem(echo));
  return out;
}

/** The newest event id in a list. 0 for none, which is what `after` omits. */
export function newestEventId(events: readonly TranscriptEvent[]): number {
  let max = 0;
  for (const ev of events) if (ev.id > max) max = ev.id;
  return max;
}

/** Does this item start a new turn from the one before it? The transcript's separators. */
export function startsTurn(item: TranscriptItem, previous: TranscriptItem | undefined): boolean {
  if (!previous) return false;
  if (item.turnId === null || previous.turnId === null) return item.kind === "user";
  return item.turnId !== previous.turnId;
}

function asItem(echo: Echo): UserItem {
  return {
    kind: "user",
    key: echo.key,
    eventId: echo.afterEventId,
    turnId: null,
    at: echo.at,
    text: echo.text,
  };
}

/**
 * A turn starting, and a turn failing.
 *
 * Fountain keeps a turn's prompt on the turn record rather than in the log, so
 * the prompt is read out of the stage event only where a deployment puts it
 * there. Where it does not, `mergeEchoes` covers the sender's own browser and
 * every other browser sees the reply alone — which is honest, and better than
 * inventing the question from the answer.
 */
function stageItem(ev: TranscriptEvent): TranscriptItem | null {
  if (ev.stage !== "turn") return null;
  const fields = dataOf(ev);
  if (ev.state === "started") {
    const prompt = typeof fields.prompt === "string" ? fields.prompt.trim() : "";
    if (!prompt) return null;
    return { kind: "user", key: `${ev.id}:user`, eventId: ev.id, turnId: ev.turn_id ?? null, at: ev.ts, text: prompt };
  }
  if (ev.state === "failed") {
    const said = typeof fields.error === "string" ? fields.error : typeof fields.message === "string" ? fields.message : "";
    return {
      kind: "error",
      key: `${ev.id}:failed`,
      eventId: ev.id,
      turnId: ev.turn_id ?? null,
      at: ev.ts,
      body: said || "This turn failed before it finished.",
    };
  }
  return null;
}

function dataOf(ev: TranscriptEvent): Record<string, unknown> {
  if (!ev.data) return {};
  try {
    const parsed: unknown = JSON.parse(ev.data);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Oldest first, one of each id — the later copy wins, being the more complete one. */
function ordered(events: readonly TranscriptEvent[]): TranscriptEvent[] {
  const byId = new Map<number, TranscriptEvent>();
  for (const ev of events) byId.set(ev.id, ev);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
