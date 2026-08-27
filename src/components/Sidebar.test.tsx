/**
 * The explorer's shape. The shelving is tested in src/lib/sidebar.test.ts;
 * this is here for what only the markup can say: that the shelves are
 * headed and counted, that every row carries its glyph in the gutter, that
 * an item nobody is on is a checklist line with no twisty, and that a
 * thread titled after its item does not repeat it.
 */
import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { mount, step } from "../../test/render";
import type { Agent, Conversation, SandboxRecord } from "../types";

const agent = { id: "a1", name: "kai", model: "anthropic/claude-sonnet-4-6", runtime: "claude" } as Agent;

function conv(over: Partial<Conversation>): Conversation {
  return { id: "c", runtime: "claude", status: "idle", agent_id: "a1", inserted_at: "2026-08-24T09:00:00Z", turn_count: 3, ...over } as Conversation;
}

const items = [
  { id: "hot", title: "Desktop notifications die with the tab", status: "open", notes: "", createdAt: "2026-08-24T00:00:00Z", proposal: null },
  { id: "ask", title: "A proposal waiting on you", status: "open", notes: "", createdAt: "2026-08-23T00:00:00Z", proposal: { status: "wont", agentId: "a1", email: "kai@x", at: "2026-08-24T00:00:00Z" } },
  { id: "bare", title: "The cost fan-out test is flaky", status: "open", notes: "", createdAt: "2026-08-22T00:00:00Z", proposal: null },
  { id: "old", title: "Reset a computer", status: "done", notes: "", createdAt: "2026-08-21T00:00:00Z", proposal: null },
];
const conversations = [
  conv({ id: "h1", title: "kai: Desktop notifications die with the tab", channel_id: "workbench:p1/hot", sandbox_id: "sb1", status: "running" }),
  conv({ id: "h2", title: "kai: the iOS half", channel_id: "workbench:p1/hot", sandbox_id: "sb1", status: "idle", inserted_at: "2026-08-24T08:00:00Z" }),
  conv({ id: "a1c", title: "kai: A proposal waiting on you", channel_id: "workbench:p1/ask", sandbox_id: "sb2", status: "terminated" }),
];
const sandbox = (id: string, status: string) => ({ id, sprite_name: `fountain-abcd1234-${id}`, status, provider: "sprites", mode: "ephemeral" }) as SandboxRecord;

const current = {
  project: { id: "p1", name: "Workbench", environmentId: "e1", vaultId: "v1", defaultAgentId: null },
  items,
  conversations,
  agents: new Map([["a1", agent]]),
  sandboxes: new Map([
    ["sb1", sandbox("sb1", "ready")],
    ["sb2", sandbox("sb2", "terminated")],
  ]),
  createItem: async () => null,
  startConversation: async () => {
    throw new Error("not here");
  },
  removeComputers: mock(async () => {}),
  toast: () => {},
};

const realStore = await import("../store");
mock.module("../store", () => ({ ...realStore, useProject: () => current }));
const { Sidebar } = await import("./Sidebar");

const render = () => renderToStaticMarkup(<Sidebar open onNavigate={() => {}} />);

describe("the explorer", () => {
  test("shelves the items by state, headed and counted, needs-you first", () => {
    const html = render();
    const at = (s: string) => html.indexOf(s);
    expect(at("waiting on you")).toBeGreaterThan(-1);
    expect(at("waiting on you")).toBeLessThan(at("▾ working"));
    expect(at("▾ working")).toBeLessThan(at("▾ to do"));
    expect(at("▾ to do")).toBeLessThan(at("▸ closed"));
    // no shelf for "up": nothing is idle on a live computer
    expect(html).not.toContain('sidebar-shelf up');
    // closed starts folded: the row is not rendered
    expect(html).not.toContain("Reset a computer");
  });

  test("every row has its glyph, and the one nobody is on is a leaf", () => {
    const html = render();
    expect(html).toContain('item-glyph waiting');
    expect(html).toContain('item-glyph working');
    expect(html).toContain('item-glyph todo');
    const row = html.slice(html.lastIndexOf("<section", html.indexOf("The cost fan-out")), html.indexOf("</section>", html.indexOf("The cost fan-out")));
    expect(row).toContain("leaf");
    expect(row).not.toContain("aria-expanded");
    expect(html).toContain("kai proposes: won&#x27;t do");
  });

  test("a dead computer's row is where it is taken out of the item; a live one's slot is the +", async () => {
    // The clutter is felt here, so the control is here. Only on a dead one:
    // it takes the slot "+" has on a live computer, and there is nothing
    // running for it to interrupt.
    window.location.hash = "#/p/p1/c/a1c";
    const gone = await mount(<Sidebar open onNavigate={() => {}} />);
    expect(gone.container.innerHTML).toContain("Remove sb2 from A proposal waiting on you");
    const button = gone.container.querySelector<HTMLButtonElement>('button[aria-label^="Remove sb2"]')!;
    expect(button).not.toBeNull();
    await step(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(current.removeComputers).toHaveBeenCalledWith("ask", ["sb2"]);
    await gone.unmount();

    window.location.hash = "#/p/p1/c/h1";
    const live = await mount(<Sidebar open onNavigate={() => {}} />);
    // sb1 is up: its slot offers another conversation, not a removal.
    expect(live.container.innerHTML).not.toContain("Remove sb1");
    expect(live.container.innerHTML).toContain("Another conversation with kai");
    await live.unmount();
    window.location.hash = "";
  });

  test("a thread titled after its item shows its number instead; a renamed one shows its name", async () => {
    // The item you are in opens on mount — an effect, so a real mount.
    window.location.hash = "#/p/p1/c/h1";
    const m = await mount(<Sidebar open onNavigate={() => {}} />);
    const html = m.container.innerHTML;
    expect(html).toContain("#2 · 3 turns");
    expect(html).toContain('<span class="conv-link-title ellipsis">the iOS half</span>');
    await m.unmount();
    window.location.hash = "";
  });
});
