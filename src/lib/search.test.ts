import { expect, test } from "bun:test";
import type { Agent, Conversation, SearchHit } from "../types";
import type { ItemDto } from "./api";
import { describeHits, matchConversations, type Context } from "./search";

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
