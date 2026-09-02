/**
 * Who is *blocked*, across every project — the half of a notification the feed
 * could not survey.
 *
 * The feed (`activity` in server/projects.ts) reads one conversation listing
 * per project owner and keeps the rows that have stopped with something
 * unread. A held permission request is on none of those rows. Fountain keeps it
 * on the turn (`pending_permission`) and announces it on the `stage` stream as
 * `request · started`, carrying `request_id`, `tool`, `options` and
 * `timeout_ms`; `GET /api/conversations` carries no count of them and no flag.
 * Worse, the conversation holding one is `running` — the very category the feed
 * excludes as "still working, not news". It is the one running conversation
 * that is news, and unlike a finished conversation it is on a clock: Fountain
 * denies an unanswered request after five minutes.
 *
 * So it is read off the stream instead. Of the three ways the work item set
 * out, this is the second, and the decision it asked for:
 *
 *   1. ASK FOUNTAIN for a held-request count on the conversation record. Still
 *      the right shape and much the smallest change here — one more field on a
 *      listing the survey already does, one more branch in the loop it already
 *      runs. It is not available today: nothing on `GET /api/conversations`
 *      carries it, and `pending_permission` is written to the turn but
 *      serialised nowhere. Filed as an ask on Fountain. When it lands, this
 *      file is deleted and `activity` reads a field.
 *
 *   2. A CROSS-PROJECT STREAM. Taken — in the half of it that is free of the
 *      trap. The workbench holds one user-wide `?streams=stage` stream per
 *      project *owner*, here in this process, and folds it into the map the
 *      survey joins against. What it deliberately does not do is re-emit those
 *      streams to the browser as one merged per-user SSE: Fountain's event ids
 *      are per account and monotonic, so a merged `id:` field breaks
 *      `Last-Event-ID` replay for anybody who is in two owners' projects, and
 *      making that correct needs a composite cursor and a design. Here each
 *      owner's stream keeps its own cursor, in this process, where the two id
 *      spaces never meet. The browser keeps the poll it already has.
 *
 *   3. POLL EACH LIVE CONVERSATION'S STAGE STREAM every tick. No — that is a
 *      request per live conversation per minute for a fact that is usually
 *      "no". It is spent exactly once instead; see `backfill` below.
 *
 * The cost of the choice, said plainly: one long-lived HTTP connection per
 * distinct project owner whose projects somebody is looking at, dropped again
 * after `IDLE_MS` with nobody asking. Not one per conversation, and not one per
 * reader.
 *
 * WHAT A STREAM CANNOT TELL YOU is what was already true when it opened. A
 * request raised before this process connected is not on it, and the person who
 * has just opened the workbench is exactly the person the blocked agent is
 * waiting for. So `backfill` reads, directly and once, the stage history of
 * every conversation the listing calls `running` that this process has never
 * folded an event for, and only then connects — from the last id it read, so
 * the two meet with no gap. Once, ever: the read records the conversation, and
 * only one that goes quiet and comes back is read again.
 *
 * WHY A MISSED EVENT IS SURVIVABLE. Two backstops, because a stream that drops
 * is a stream that eventually drops something. A held request dies on its own
 * deadline and is dropped here on the same one (`src/lib/digest.ts` has the
 * same rule for the same reason: a card that waits forever is a card that
 * lies). And a permission request lives on a turn in flight, so a conversation
 * the listing calls finished cannot be holding one — anything held for a
 * conversation that has since stopped is evicted on the next survey. The worst
 * a lost `request · done` costs is one stale row for one tick.
 */
import type { ConversationSummary, FountainClient, LogEventRow } from "./fountain";

/** An agent holding a tool call, waiting to be told whether to run it. */
export interface HeldRequest {
  conversationId: string;
  requestId: string;
  /** The tool it is asking about, in the runtime's words. */
  tool: string | null;
  askedAt: string;
  /** When Fountain denies it on its own. */
  expiresAt: string;
}

/** Fountain's own default, for a `request · started` that carried no `timeout_ms`. */
const ASK_TIMEOUT_MS = 5 * 60 * 1000;

/** No survey has asked about this owner for this long: let the connection go. */
const IDLE_MS = 5 * 60 * 1000;

/** A connection that lasted less than this did not cycle, it failed — back off before retrying. */
const MIN_CONNECTION_MS = 2_000;

const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

/** Stage events are few per conversation; this is a ceiling, not an expectation. */
const BACKFILL_PAGE = 1000;
const BACKFILL_PAGES = 5;

/**
 * How long a survey waits for a history it has not read before. Past this it
 * answers with what it has and the read finishes in the background, for the
 * next one: a Fountain that is being slow should cost the feed a minute of
 * knowing who is blocked, not the whole page.
 */
const BACKFILL_WAIT_MS = 3_000;

interface Watch {
  /** Conversation id → the request it is holding. At most one: Fountain holds one per turn. */
  held: Map<string, HeldRequest>;
  /** Conversation id → the highest log-event id folded for it, so replay and backfill do not double count. */
  seen: Map<string, number>;
  /** The highest id the *stream* has delivered — what a reconnect resumes from. Never advanced by a backfill. */
  cursor: number;
  /** When a survey last wanted this owner. */
  wantedAt: number;
  streaming: boolean;
  abort: AbortController | null;
  /** Backfills in flight, by conversation, so two surveys at once do not both read the same history. */
  filling: Map<string, Promise<void>>;
}

const watches = new Map<string, Watch>();

/** For tests, and for a shutdown: drop every connection and everything folded out of it. */
export function resetWatch(): void {
  for (const w of watches.values()) {
    w.wantedAt = 0;
    w.abort?.abort();
  }
  watches.clear();
}

/**
 * What the owner's agents are blocked on, by conversation.
 *
 * `conversations` is the listing the survey has just taken on this owner's
 * key — passed in rather than fetched, because the survey has already paid for
 * it and this is a join, not a second question.
 *
 * Awaits the first read of a conversation's history and nothing else: the
 * stream is started (or left running) in the background, so a survey costs a
 * request only for a running conversation this process has never seen.
 */
export async function heldRequests(
  owner: string,
  client: FountainClient,
  conversations: readonly ConversationSummary[],
  now: number = Date.now(),
): Promise<ReadonlyMap<string, HeldRequest>> {
  let w = watches.get(owner);
  if (!w) {
    w = { held: new Map(), seen: new Map(), cursor: 0, wantedAt: now, streaming: false, abort: null, filling: new Map() };
    watches.set(owner, w);
  }
  w.wantedAt = Date.now();

  // History first, then the stream from where history ended: a request raised
  // before this process existed is the case this whole function is for.
  await backfill(w, client, conversations);
  stream(w, owner, client);

  evict(w, conversations, now);
  return w.held;
}

/**
 * Read, once, the stage history of every running conversation this process has
 * folded nothing for. A conversation that is not running cannot be holding a
 * request, so the set is the account's concurrency — usually none, and never
 * the whole account.
 */
async function backfill(w: Watch, client: FountainClient, conversations: readonly ConversationSummary[]): Promise<void> {
  const wanted = conversations.filter((c) => c.status === "running" && !w.seen.has(c.id) && !w.filling.has(c.id));
  const ends: number[] = [];
  for (const c of wanted) {
    const p = readHistory(w, client, c.id)
      .then((last) => {
        if (last > 0) ends.push(last);
      })
      .finally(() => w.filling.delete(c.id));
    w.filling.set(c.id, p);
  }
  // Every backfill in flight, not just the ones started here: a survey that
  // races another one must not answer before the history it is waiting on.
  // Bounded, though — a read that has not come back is not a page that fails
  // to load. It keeps going, in `filling`, for whichever survey is next.
  await Promise.race([Promise.allSettled([...w.filling.values()]), sleep(BACKFILL_WAIT_MS)]);

  // Where the first connection resumes from: the *oldest* of the histories
  // just read. It has to be low enough that nothing said between a history
  // being read and the stream being joined onto it is skipped, and any event
  // this process has not folded for one of these conversations has an id above
  // that conversation's last one, and so above this. It is a recent id all the
  // same — these are conversations that are running, and one that is running
  // has just said something.
  //
  // Only before the first connection. After that the stream's own cursor is
  // the truth, and a reconnect replays from it: a later history read must
  // never drag it backwards into replaying the account all over again.
  if (w.cursor === 0 && ends.length > 0) w.cursor = Math.min(...ends);
}

/** One conversation's stage history, folded. Answers the last event id it saw. */
async function readHistory(w: Watch, client: FountainClient, conversationId: string): Promise<number> {
  let after = 0;
  for (let page = 0; page < BACKFILL_PAGES; page += 1) {
    const rows = await client.events(conversationId, { streams: "stage", after: String(after), limit: String(BACKFILL_PAGE) });
    for (const ev of rows) {
      fold(w, conversationId, ev);
      if (ev.id > after) after = ev.id;
    }
    if (rows.length < BACKFILL_PAGE) break;
  }
  // Even a conversation whose history was empty is recorded, so it is read
  // once and not once a minute.
  if (!w.seen.has(conversationId)) w.seen.set(conversationId, after);
  return after;
}

/**
 * Follow the owner's whole account on one connection, reconnecting for as long
 * as somebody is asking. Fountain closes the stream after 60 s idle, so a
 * reconnect is the normal case, not an error; `Last-Event-ID` makes it lossless.
 */
function stream(w: Watch, owner: string, client: FountainClient): void {
  if (w.streaming) return;
  w.streaming = true;
  void (async () => {
    let fails = 0;
    try {
      while (watches.get(owner) === w && Date.now() - w.wantedAt < IDLE_MS) {
        const started = Date.now();
        try {
          await follow(w, client);
        } catch {
          // A stream that fell over is a stream to open again; nothing folded
          // is lost, and the cursor resumes it.
        }
        if (Date.now() - started >= MIN_CONNECTION_MS) fails = 0;
        else await sleep(BACKOFF_MS[Math.min(fails++, BACKOFF_MS.length - 1)]!);
      }
    } finally {
      w.streaming = false;
      w.abort = null;
      // Nobody has asked in five minutes, so this owner is forgotten entirely
      // rather than kept as a cursor into the past: whoever comes back reads
      // the running conversations' histories again and starts from now. An
      // hour of stage events replayed to catch up on a request that expired
      // fifty-five minutes ago is not a thing worth doing.
      if (watches.get(owner) === w) watches.delete(owner);
    }
  })();
}

async function follow(w: Watch, client: FountainClient): Promise<void> {
  const ctrl = new AbortController();
  w.abort = ctrl;
  const headers: Record<string, string> = { accept: "text/event-stream" };
  // Resume where this owner's stream left off. The id is this account's own:
  // it is never mixed with another owner's, which is the whole reason these
  // are folded here rather than merged into one stream for the browser.
  if (w.cursor > 0) headers["last-event-id"] = String(w.cursor);
  const res = await client.fetch("/api/events/stream?streams=stage", { headers, signal: ctrl.signal });
  if (!res.ok || !res.body) {
    await res.text().catch(() => "");
    throw new Error(`stream ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        record(w, buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** One SSE record: the `id:` line is the cursor, the `data:` line is the event. */
function record(w: Watch, raw: string): void {
  let id = 0;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") id = Number(value) || 0;
    else if (field === "data") data.push(value);
  }
  if (!id || data.length === 0) return; // a heartbeat, or the `conversations` notice
  let payload: (LogEventRow & { conversation_id?: string }) | null = null;
  try {
    payload = JSON.parse(data.join("\n")) as LogEventRow & { conversation_id?: string };
  } catch {
    return;
  }
  const conversationId = payload?.conversation_id;
  if (!conversationId) return;
  // From here on only the stream advances the cursor — it is the one thing
  // that sees every conversation, so its highest id is the only id that means
  // "everything up to here is folded". `backfill` seeds the first one.
  if (id > w.cursor) w.cursor = id;
  fold(w, conversationId, { ...payload, id });
}

/**
 * One log event into what is held. Ordering is by the event's own id rather
 * than arrival, so a replay after a reconnect, and a backfill that overlaps
 * the stream, fold to the same answer as seeing each event once.
 */
function fold(w: Watch, conversationId: string, ev: LogEventRow): void {
  if (typeof ev.id !== "number") return;
  if (ev.id <= (w.seen.get(conversationId) ?? 0)) return;
  w.seen.set(conversationId, ev.id);
  if (ev.kind !== "stage" || ev.stage !== "request") return;
  const d = dataOf(ev.data);
  const requestId = str(d.request_id);
  if (!requestId) return;
  if (ev.state !== "started") {
    // Answered, denied, timed out, or the turn ended under it.
    if (w.held.get(conversationId)?.requestId === requestId) w.held.delete(conversationId);
    return;
  }
  const askedAt = typeof ev.ts === "string" ? ev.ts : new Date().toISOString();
  const ms = typeof d.timeout_ms === "number" && d.timeout_ms > 0 ? d.timeout_ms : ASK_TIMEOUT_MS;
  const asked = Date.parse(askedAt);
  w.held.set(conversationId, {
    conversationId,
    requestId,
    tool: str(d.tool),
    askedAt,
    expiresAt: new Date((Number.isNaN(asked) ? Date.now() : asked) + ms).toISOString(),
  });
}

/**
 * Drop what cannot still be true: a request past its deadline (Fountain has
 * already denied it), and one held by a conversation this listing says has
 * stopped. The second is the backstop for a `request · done` that never
 * arrived — but only for a request raised before the listing was taken, so a
 * conversation that started blocking in the moment between is not thrown away.
 */
function evict(w: Watch, conversations: readonly ConversationSummary[], now: number): void {
  const settled = new Set(conversations.filter((c) => c.status !== "running" && c.status !== "pending").map((c) => c.id));
  for (const [id, held] of w.held) {
    // Compared as instants, not as text: Fountain writes more decimal places
    // than `toISOString` does, and `"…:00.123456Z" < "…:00.123Z"` as a string.
    const asked = Date.parse(held.askedAt);
    if (Date.parse(held.expiresAt) <= now) w.held.delete(id);
    else if (settled.has(id) && (Number.isNaN(asked) || asked < now)) w.held.delete(id);
  }
  // A conversation nobody is looking at any more is not worth remembering we
  // have read; it will be read again if it comes back live.
  if (w.seen.size > 2000) w.seen.clear();
}

/** A stage event's metadata, which rides along as JSON in `data`. */
function dataOf(data: unknown): Record<string, unknown> {
  if (typeof data !== "string" || !data) return {};
  try {
    const v = JSON.parse(data) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // A backoff must never be the reason a process stays alive.
    (t as unknown as { unref?: () => void }).unref?.();
  });
}
