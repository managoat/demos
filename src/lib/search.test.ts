import { expect, test } from "bun:test";
import type { Fountain } from "@agentshit/fountain-sdk";
import type { Agent, Conversation, SearchHit } from "../types";
import type { ItemDto } from "./api";
import { describeHits, findIsOurs, matchConversations, searchMessages, threadHits, type Context } from "./search";

const conv = (id: string, title: string, itemId: string, status = "idle", lastActive = "2026-08-23T00:00:00Z") =>
  ({ id, title, channel_id: `workbench:p1/${itemId}/aaaaaaaaaaaa`, agent_id: "a1", status, last_active_at: lastActive }) as unknown as Conversation;

const item = (id: string, title: string) => ({ id, projectId: "p1", title, notes: "", status: "open", agentIds: [], createdAt: "", proposal: null }) as ItemDto;

const ctx: Context = {
  projectId: "p1",
  conversations: [
    conv("c1", "Coder: fix the gate", "w1", "idle", "2026-08-23T00:00:00Z"),
    conv("c2", "Scribe: gate notes", "w2", "idle", "2026-08-24T00:00:00Z"),
    conv("c3", "Coder: gate, retired", "w1", "terminated", "2026-08-25T00:00:00Z"),
    conv("c4", "Coder: mitigate the risk", "w1", "idle", "2026-08-25T00:00:00Z"),
  ],
  items: [item("w1", "fix foo"), item("w2", "write it up")],
  agents: new Map([["a1", { id: "a1", name: "Coder" } as Agent]]),
};

test("conversations match by name, best first", () => {
  const rows = matchConversations("gate", ctx);
  // Both start the word, so the more recent leads; "mitigate" only contains it,
  // and a retired conversation sinks below live ones however recent it is.
  expect(rows.map((r) => r.primary)).toEqual(["Scribe: gate notes", "Coder: fix the gate", "Coder: mitigate the risk", "Coder: gate, retired"]);
  expect(rows[0]!.kind).toBe("conversation");
  expect(rows[0]!.href).toBe("#/p/p1/c/c2");
  // The second line says where it lives: the work item, then the teammate.
  expect(rows[1]!.secondary).toBe("fix foo · Coder");
});

test("an empty query matches nothing at all — the palette opens quiet", () => {
  expect(matchConversations("   ", ctx)).toEqual([]);
});

test("a hit points at the turn it matched; a title hit at the conversation", () => {
  const hits: SearchHit[] = [
    { kind: "reply", conversation_id: "c1", agent_id: "a1", turn_id: "t7", turn_number: 7, snippet: "the gate lives in the billing plug", ts: "2026-08-23T02:00:00Z" },
    { kind: "title", conversation_id: "c2", agent_id: "a1", turn_id: null, turn_number: null, snippet: "Scribe: gate notes", ts: "2026-08-23T01:00:00Z" },
  ];
  const rows = describeHits(hits, ctx);
  expect(rows[0]!.href).toBe("#/p/p1/c/c1/t/t7");
  expect(rows[0]!.secondary).toBe("fix foo · Coder · turn 7");
  expect(rows[1]!.href).toBe("#/p/p1/c/c2");
  expect(rows[1]!.secondary).toBe("write it up · Coder");
  // Two hits in one conversation are two rows, not one key.
  expect(new Set(rows.map((r) => r.key)).size).toBe(2);
});

test("a hit in a conversation the list has not caught up with is still shown", () => {
  const rows = describeHits([{ kind: "prompt", conversation_id: "c9", agent_id: null, turn_id: "t1", turn_number: 1, snippet: "brand new", ts: "2026-08-24T00:00:00Z" }], ctx);
  expect(rows[0]!.href).toBe("#/p/p1/c/c9/t/t1");
  expect(rows[0]!.secondary).toBe("this project · turn 1");
});

// ── ⌘F: one conversation ─────────────────────────────────────────────────

const hit = (kind: SearchHit["kind"], turn: string | null, n: number | null, snippet = "x"): SearchHit =>
  ({ kind, conversation_id: "c1", agent_id: "a1", turn_id: turn, turn_number: n, snippet, ts: "2026-08-23T00:00:00Z" }) as SearchHit;

test("a thread's hits are put back into reading order, prompt before the reply it got", () => {
  // As Fountain ranks them: best first, in no particular place in the thread.
  const rows = threadHits([hit("reply", "t9", 9, "ninth"), hit("reply", "t2", 2, "second"), hit("prompt", "t9", 9, "asked"), hit("prompt", "t2", 2, "asking")]);
  expect(rows.map((r) => r.snippet)).toEqual(["asking", "second", "asked", "ninth"]);
  expect(rows.map((r) => r.turnNumber)).toEqual([2, 2, 9, 9]);
});

test("a title hit is not a place in the transcript, so ⌘F does not count it", () => {
  const rows = threadHits([hit("title", null, null, "Coder: fix the gate"), hit("reply", "t1", 1, "in the gate")]);
  expect(rows.map((r) => r.snippet)).toEqual(["in the gate"]);
  // Two hits on one turn are two stops, not one — the prompt and the reply both matched.
  expect(new Set(threadHits([hit("prompt", "t1", 1), hit("reply", "t1", 1)]).map((r) => r.key)).size).toBe(2);
});

test("⌘F is the browser's unless the reader is in the thread", () => {
  // Reading it: focus inside the thread, or nowhere — where clicking the transcript leaves you.
  expect(findIsOurs({ inThread: true, focusedElsewhere: false, modal: false })).toBe(true);
  expect(findIsOurs({ inThread: false, focusedElsewhere: false, modal: false })).toBe(true);
  // Focused on something else on the page: they meant the browser's find.
  expect(findIsOurs({ inThread: false, focusedElsewhere: true, modal: false })).toBe(false);
  // The palette is up: it is a box over the whole app, and ⌘F over it is not ours.
  expect(findIsOurs({ inThread: true, focusedElsewhere: false, modal: true })).toBe(false);
});

test("searching one conversation names it, which is what puts the proxy on its tight path", async () => {
  const asked: Record<string, string | number>[] = [];
  const fake = {
    request: (_m: string, _p: string, opts: { query: Record<string, string | number> }) => {
      asked.push(opts.query);
      return Promise.resolve({ data: [hit("reply", "t1", 1)], meta: { has_more: true } });
    },
  } as unknown as Fountain;

  const found = await searchMessages(fake, "gate", { conversationId: "c1", limit: 100 });
  expect(asked[0]).toEqual({ q: "gate", limit: 100, conversation_id: "c1" });
  expect(found.hits).toHaveLength(1);
  expect(found.hasMore).toBe(true);

  // The palette's call is the same one without an id: the whole project.
  await searchMessages(fake, "gate");
  expect(asked[1]).toEqual({ q: "gate", limit: 20 });
});
