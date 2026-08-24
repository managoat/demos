import { expect, test } from "bun:test";
import { boardOf, cardLine, cardsOf, columnOf, dropOn, isProjectView, type BoardItem, type Card } from "./board";
import type { Conversation } from "../types";

const PROJECT = "p1";

function item(over: Partial<BoardItem> & { id: string }): BoardItem {
  return { title: over.id, notes: "", status: "open", agentIds: [], createdAt: "2026-01-01T00:00:00Z", proposal: null, ...over };
}

function conv(itemId: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id: `c-${itemId}-${over.id ?? "1"}`,
    channel_id: `workbench:${PROJECT}/${itemId}/x`,
    status: "idle",
    ...over,
  } as Conversation;
}

function card(over: Partial<Card> & { column: Card["column"] }): Card {
  return { item: item({ id: "w" }), live: 0, working: 0, total: 0, unread: false, latest: "", ...over };
}

test("the open half is split by what is running, not by a field", () => {
  expect(columnOf(item({ id: "w" }), 0)).toBe("todo");
  expect(columnOf(item({ id: "w" }), 2)).toBe("doing");
  expect(columnOf(item({ id: "w", status: "done" }), 0)).toBe("done");
  expect(columnOf(item({ id: "w", status: "wont" }), 0)).toBe("wont");
});

test("a proposal outranks the work still running under it", () => {
  const proposed = item({ id: "w", proposal: { status: "wont", agentId: "a1", email: "x@y.z", at: "2026-01-02T00:00:00Z" } });
  expect(columnOf(proposed, 3)).toBe("waiting");
  // Closing settles the question, so a closed item is never in Needs you.
  expect(columnOf({ ...proposed, status: "done" }, 0)).toBe("done");
});

test("cards carry what the conversation list says about the item", () => {
  const items = [item({ id: "w1" }), item({ id: "w2" })];
  const convs = [
    conv("w1", { id: "1", status: "running", last_active_at: "2026-02-01T10:00:00Z", unread: true }),
    conv("w1", { id: "2", status: "terminated", last_active_at: "2026-02-01T09:00:00Z" }),
    conv("w2", { id: "3", status: "terminated" }),
    // Another project's conversation, on the same-looking item id.
    { ...conv("w1", { id: "4", status: "running" }), channel_id: "workbench:other/w1/x" } as Conversation,
  ];
  const [a, b] = cardsOf(items, convs, PROJECT);
  expect(a).toMatchObject({ column: "doing", live: 1, working: 1, total: 2, unread: true, latest: "2026-02-01T10:00:00Z" });
  // Every conversation ended and nobody closed it: nothing is happening, so it is To do.
  expect(b).toMatchObject({ column: "todo", live: 0, working: 0, total: 1, unread: false });
});

test("the board keeps empty columns and ranks cards on when they were made", () => {
  const items = [item({ id: "w1", createdAt: "2026-01-01T00:00:00Z" }), item({ id: "w2", createdAt: "2026-03-01T00:00:00Z" })];
  const board = boardOf(items, [], PROJECT);
  expect(board.map((c) => c.column.id)).toEqual(["todo", "doing", "waiting", "done", "wont"]);
  expect(board[0]!.cards.map((c) => c.item.id)).toEqual(["w2", "w1"]);
  expect(board[1]!.cards).toEqual([]);
});

test("closing works from any column, and is the same field the button writes", () => {
  expect(dropOn(card({ column: "todo" }), "done")).toEqual({ kind: "set", status: "done" });
  expect(dropOn(card({ column: "doing", live: 2 }), "wont")).toEqual({ kind: "set", status: "wont" });
  expect(dropOn(card({ column: "waiting" }), "done")).toEqual({ kind: "set", status: "done" });
  expect(dropOn(card({ column: "done" }), "wont")).toEqual({ kind: "set", status: "wont" });
});

test("dragging a closed card back into the open half reopens it, and says where it landed", () => {
  expect(dropOn(card({ column: "done" }), "todo")).toEqual({ kind: "set", status: "open" });
  // Reopening brings nothing back, so In progress is not where it can land.
  const d = dropOn(card({ column: "wont" }), "doing");
  expect(d.kind).toBe("set");
  expect(d).toMatchObject({ status: "open" });
  expect((d as { note: string }).note).toContain("To do");
});

test("dragging a verdict back into the open half is Dismiss", () => {
  // Nothing running: it falls to To do, which is where it was dropped.
  expect(dropOn(card({ column: "waiting" }), "todo")).toEqual({ kind: "dismiss", note: undefined });
  // Something running: dropped on To do, it lands in In progress, and says so.
  const d = dropOn(card({ column: "waiting", live: 1 }), "todo");
  expect(d.kind).toBe("dismiss");
  expect((d as { note: string }).note).toContain("In progress");
});

test("a column with no field behind it refuses, and names what would move the card", () => {
  const refused = (from: Card["column"], to: Card["column"]) => dropOn(card({ column: from }), to);
  expect(refused("todo", "doing")).toMatchObject({ kind: "refused" });
  expect((refused("todo", "doing") as { reason: string }).reason).toContain("Start a teammate");
  expect(refused("doing", "todo")).toMatchObject({ kind: "refused" });
  expect(refused("todo", "waiting")).toMatchObject({ kind: "refused" });
  expect(refused("doing", "waiting")).toMatchObject({ kind: "refused" });
  expect(refused("done", "waiting")).toMatchObject({ kind: "refused" });
});

test("a card dropped where it already is does nothing", () => {
  for (const c of ["todo", "doing", "waiting", "done", "wont"] as const) {
    expect(dropOn(card({ column: c }), c)).toEqual({ kind: "same" });
  }
});

test("only a write is a drop the browser is allowed to make", () => {
  // The board withholds the drop for anything else, so this is the whole
  // predicate behind the highlight and the cursor.
  const takes = (from: Card["column"], to: Card["column"]) => ["set", "dismiss"].includes(dropOn(card({ column: from }), to).kind);
  expect(takes("todo", "done")).toBe(true);
  expect(takes("waiting", "doing")).toBe(true);
  expect(takes("done", "todo")).toBe(true);
  expect(takes("todo", "doing")).toBe(false);
  expect(takes("todo", "todo")).toBe(false);
});

test("the card's line tells never-started apart from stalled", () => {
  expect(cardLine({ total: 0, working: 0 })).toBe("Not started");
  expect(cardLine({ total: 1, working: 0 })).toBe("1 conversation, none running");
  expect(cardLine({ total: 3, working: 1 })).toBe("3 conversations");
});

test("a stored view that is not one is the list", () => {
  expect(isProjectView("board")).toBe(true);
  expect(isProjectView("list")).toBe(true);
  expect(isProjectView("kanban")).toBe(false);
  expect(isProjectView(null)).toBe(false);
});
