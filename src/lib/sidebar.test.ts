import { describe, expect, test } from "bun:test";
import type { Conversation, SandboxRecord } from "../types";
import { attachable, computerLabel, computersOf, groupByItem, itemIdOf, relativeTime } from "./sidebar";

function conv(over: Partial<Conversation>): Conversation {
  return { id: "c", status: "idle", runtime: "claude", inserted_at: "2026-08-24T00:00:00Z", ...over } as Conversation;
}

describe("computersOf", () => {
  test("groups by sandbox, live first, newest activity first inside", () => {
    const convs = [
      conv({ id: "old", sandbox_id: "sb1", agent_id: "a1", status: "terminated", last_active_at: "2026-08-24T01:00:00Z" }),
      conv({ id: "gone", sandbox_id: "sb2", agent_id: "a1", status: "terminated", last_active_at: "2026-08-24T05:00:00Z" }),
      conv({ id: "new", sandbox_id: "sb1", agent_id: "a1", status: "running", last_active_at: "2026-08-24T03:00:00Z", unread: true }),
      conv({ id: "lone", sandbox_id: null, agent_id: "a2", status: "idle" }),
    ];
    const cs = computersOf(convs, new Map());
    expect(cs.map((c) => c.key)).toEqual(["sb1", "sb2", "conv:lone"]);
    const sb1 = cs[0]!;
    expect(sb1.live).toBe(true);
    expect(sb1.busy).toBe(true);
    expect(sb1.unread).toBe(true);
    expect(sb1.conversations.map((c) => c.id)).toEqual(["new", "old"]);
    expect(cs[1]!.live).toBe(false);
    expect(cs[2]!.live).toBe(false); // no computer at all
  });

  test("the sandbox record overrides: a terminated sandbox is not live, a ready one is attachable", () => {
    const sandboxes = new Map<string, SandboxRecord>([
      ["sb1", { id: "sb1", status: "terminated", sprite_name: "fountain-50e06232-abc", conversations: [] } as unknown as SandboxRecord],
      ["sb2", { id: "sb2", status: "ready", sprite_name: "fountain-50e06232-def", conversations: [] } as unknown as SandboxRecord],
      ["sb3", { id: "sb3", status: "starting", sprite_name: "x", conversations: [] } as unknown as SandboxRecord],
    ]);
    const cs = computersOf(
      [conv({ id: "1", sandbox_id: "sb1", status: "idle" }), conv({ id: "2", sandbox_id: "sb2", status: "idle" }), conv({ id: "3", sandbox_id: "sb3", status: "pending" })],
      sandboxes,
    );
    const by = new Map(cs.map((c) => [c.key, c]));
    expect(by.get("sb1")!.live).toBe(false);
    expect(by.get("sb2")!.live).toBe(true);
    expect(attachable(by.get("sb2")!)).toBe(true);
    expect(attachable(by.get("sb3")!)).toBe(false);
    expect(computerLabel(by.get("sb2")!)).toBe("def");
    expect(computerLabel({ sandbox: null, sandboxId: "0123456789ab" })).toBe("01234567");
  });
});

test("itemIdOf reads the channel", () => {
  expect(itemIdOf({ channel_id: "workbench:p/w/tag" })).toBe("w");
  expect(itemIdOf({ channel_id: "fountain:team" })).toBeNull();
});

test("relativeTime", () => {
  const now = Date.parse("2026-08-24T12:00:00Z");
  expect(relativeTime("2026-08-24T11:59:30Z", now)).toBe("30s ago");
  expect(relativeTime("2026-08-24T11:30:00Z", now)).toBe("30m ago");
  expect(relativeTime("2026-08-24T09:00:00Z", now)).toBe("3h ago");
  expect(relativeTime("2026-08-20T12:00:00Z", now)).toBe("4d ago");
  expect(relativeTime(null, now)).toBe("—");
});

describe("groupByItem", () => {
  const items = [
    { id: "quiet", title: "Quiet", status: "open", createdAt: "2026-08-24T00:00:00Z" },
    { id: "hot", title: "Hot", status: "open", createdAt: "2026-08-23T00:00:00Z" },
    { id: "done", title: "Done", status: "done", createdAt: "2026-08-25T00:00:00Z" },
    { id: "cold", title: "Cold", status: "open", createdAt: "2026-08-22T00:00:00Z" },
  ];
  const convs = [
    conv({ id: "h1", channel_id: "workbench:p/hot/t1", sandbox_id: "sb1", agent_id: "a1", status: "running", last_active_at: "2026-08-24T03:00:00Z" }),
    conv({ id: "h2", channel_id: "workbench:p/hot/t2", sandbox_id: "sb1", agent_id: "a1", status: "idle", last_active_at: "2026-08-24T02:00:00Z" }),
    conv({ id: "c1", channel_id: "workbench:p/cold/t1", sandbox_id: "sb2", agent_id: "a1", status: "terminated", last_active_at: "2026-08-24T04:00:00Z" }),
    conv({ id: "d1", channel_id: "workbench:p/done/t1", sandbox_id: "sb3", agent_id: "a1", status: "idle", last_active_at: "2026-08-24T05:00:00Z" }),
    conv({ id: "x", channel_id: "fountain:team", sandbox_id: "sb9", status: "idle" }),
  ];
  test("items with a live computer first, then by activity, done last; computers stay on their item", () => {
    const g = groupByItem(items, convs, new Map());
    expect(g.map((x) => x.item.id)).toEqual(["hot", "cold", "quiet", "done"]);
    expect(g[0]!.computers).toHaveLength(1);
    expect(g[0]!.computers[0]!.conversations.map((c) => c.id)).toEqual(["h1", "h2"]);
    expect(g[0]!.busy).toBe(true);
    expect(g[1]!.live).toBe(false);
    expect(g[2]!.computers).toEqual([]);
    expect(g[3]!.live).toBe(true); // done, but its computer is still up — shown last, not hidden
  });
});
