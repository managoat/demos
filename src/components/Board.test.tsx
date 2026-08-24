/**
 * A board card. The columns and the drag rules are lib/board.ts and tested
 * there; what matters here is the promise the drawing makes — that dragging
 * is a shortcut and never the only way, because a keyboard cannot drag and a
 * touch screen has no drag at all. So every card carries the same controls the
 * list rows do, and closing one from the board warns about the computers in
 * exactly the words the list uses.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BoardCard } from "./Board";
import type { Card } from "../lib/board";
import type { WorkItem } from "../lib/workbench";

const item: WorkItem = {
  id: "w1",
  projectId: "p1",
  title: "fix foo",
  notes: "Foo 500s on save.",
  status: "open",
  agentIds: [],
  createdAt: "2026-08-01T00:00:00Z",
  proposal: null,
};

function card(over: Partial<Card<WorkItem>> = {}): Card<WorkItem> {
  return { item, column: "todo", live: 0, working: 0, total: 0, unread: false, latest: "", ...over };
}

const markup = (c: Card<WorkItem>) =>
  renderToStaticMarkup(
    <BoardCard card={c} projectId="p1" agents={new Map()} dragging={false} onDragStart={() => {}} onDragEnd={() => {}} onSet={() => {}} onDismiss={() => {}} />,
  );

describe("a card", () => {
  test("opens the item, and can be dragged", () => {
    const html = markup(card());
    expect(html).toContain('href="#/p/p1/w/w1"');
    expect(html).toContain("draggable=");
    expect(html).toContain("fix foo");
    expect(html).toContain("Foo 500s on save.");
  });

  test("carries the same close controls as a list row, so the board works without a pointer", () => {
    const html = markup(card());
    expect(html).toContain("Done");
    expect(html).toContain("Won&#x27;t do");
  });

  test("a close that would take computers down warns about them here too", () => {
    expect(markup(card({ column: "doing", live: 2, working: 1 }))).toContain("Retires 2 conversations");
  });

  test("To do says whether the item was ever started, because the column cannot", () => {
    expect(markup(card())).toContain("Not started");
    expect(markup(card({ total: 2 }))).toContain("2 conversations, none running");
    // A turn in flight has its own pill; the line does not say it twice.
    const busy = markup(card({ column: "doing", live: 1, working: 1, total: 1 }));
    expect(busy).toContain("1 working");
    expect(busy).toContain("1 conversation");
    expect(busy).not.toContain("none running");
  });

  test("a closed card says which way it closed, and offers the way back", () => {
    const html = markup(card({ item: { ...item, status: "wont" }, column: "wont" }));
    expect(html).toContain("won&#x27;t do");
    expect(html).toContain("Reopen");
  });

  test("a teammate's verdict is a question on the card, not a state it is already in", () => {
    const proposed: WorkItem = { ...item, proposal: { status: "done", agentId: null, email: "coder@example.com", at: "2026-08-20T00:00:00Z" } };
    const html = renderToStaticMarkup(
      <BoardCard
        card={{ ...card(), item: proposed, column: "waiting" }}
        projectId="p1"
        agents={new Map()}
        dragging={false}
        onDragStart={() => {}}
        onDragEnd={() => {}}
        onSet={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("coder@example.com says: done");
    expect(html).toContain("Confirm");
    expect(html).toContain("Dismiss");
  });
});
