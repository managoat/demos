import { describe, expect, test } from "bun:test";
import type { Conversation, SandboxRecord } from "../types";
import { attachable, clampWidth, coarseTime, computerLabel, computersOf, groupByItem, hueOf, itemIdOf, relativeTime, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from "./sidebar";

function conv(over: Partial<Conversation>): Conversation {
  return { id: "c", status: "idle", runtime: "claude", inserted_at: "2026-08-24T00:00:00Z", ...over } as Conversation;
}

describe("computersOf", () => {
  test("groups by sandbox, live first, newest started first inside", () => {
    const convs = [
      conv({ id: "old", sandbox_id: "sb1", agent_id: "a1", status: "terminated", inserted_at: "2026-08-24T01:00:00Z", last_active_at: "2026-08-24T01:30:00Z" }),
      conv({ id: "gone", sandbox_id: "sb2", agent_id: "a1", status: "terminated", inserted_at: "2026-08-24T04:00:00Z", last_active_at: "2026-08-24T05:00:00Z" }),
      conv({ id: "new", sandbox_id: "sb1", agent_id: "a1", status: "running", inserted_at: "2026-08-24T02:00:00Z", last_active_at: "2026-08-24T03:00:00Z", unread: true }),
      conv({ id: "lone", sandbox_id: null, agent_id: "a2", status: "idle" }),
    ];
    const cs = computersOf(convs, new Map());
    expect(cs.map((c) => c.key)).toEqual(["sb1", "sb2", "conv:lone"]);
    const sb1 = cs[0]!;
    expect(sb1.live).toBe(true);
    expect(sb1.busy).toBe(true);
    expect(sb1.unread).toBe(true);
    expect(sb1.startedAt).toBe("2026-08-24T01:00:00Z"); // its first conversation
    expect(sb1.conversations.map((c) => c.id)).toEqual(["new", "old"]);
    expect(cs[1]!.live).toBe(false);
    expect(cs[2]!.live).toBe(false); // idle with no computer at all
  });

  test("a conversation still being provisioned is a computer coming up, not a dead one", () => {
    const cs = computersOf(
      [
        conv({ id: "dead", sandbox_id: "sb1", status: "terminated", inserted_at: "2026-08-24T01:00:00Z" }),
        conv({ id: "starting", sandbox_id: null, status: "pending", inserted_at: "2026-08-24T02:00:00Z" }),
      ],
      new Map(),
    );
    // Live first: the one you just started is at the top from the outset, so
    // it does not leap up the list when Fountain hands back the sandbox id.
    expect(cs.map((c) => c.key)).toEqual(["conv:starting", "sb1"]);
    expect(cs[0]!.live).toBe(true);
  });

  test("runtime output does not reorder anything", () => {
    const base = [
      conv({ id: "a1", sandbox_id: "sbA", status: "running", inserted_at: "2026-08-24T03:00:00Z" }),
      conv({ id: "a2", sandbox_id: "sbA", status: "idle", inserted_at: "2026-08-24T01:00:00Z" }),
      conv({ id: "b1", sandbox_id: "sbB", status: "running", inserted_at: "2026-08-24T02:00:00Z" }),
    ];
    const order = (cs: ReturnType<typeof computersOf>) => cs.map((c) => `${c.key}:${c.conversations.map((x) => x.id).join("+")}`);
    const before = order(computersOf(base, new Map()));
    // Two agents talking at once: `last_active_at` moves on every line of
    // output, in any order. The tree must not budge.
    for (const [x, y, z] of [
      ["2026-08-24T09:00:00Z", "2026-08-24T08:00:00Z", "2026-08-24T07:00:00Z"],
      ["2026-08-24T10:00:00Z", "2026-08-24T12:00:00Z", "2026-08-24T11:00:00Z"],
      ["2026-08-24T15:00:00Z", "2026-08-24T13:00:00Z", "2026-08-24T14:00:00Z"],
    ] as const) {
      const moved = [
        { ...base[0]!, last_active_at: x },
        { ...base[1]!, last_active_at: y },
        { ...base[2]!, last_active_at: z },
      ];
      expect(order(computersOf(moved, new Map()))).toEqual(before);
    }
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

test("coarseTime does not count seconds, so a busy row stops reflowing", () => {
  const now = Date.parse("2026-08-24T12:00:00Z");
  for (const t of ["2026-08-24T11:59:59Z", "2026-08-24T11:59:30Z", "2026-08-24T11:59:01Z", "2026-08-24T12:00:00Z"]) {
    expect(coarseTime(t, now)).toBe("now");
  }
  expect(coarseTime("2026-08-24T11:30:00Z", now)).toBe("30m ago");
  expect(coarseTime("2026-08-24T09:00:00Z", now)).toBe("3h ago");
  expect(coarseTime(null, now)).toBe("—");
  // A clock skewed ahead of us is "now", not a negative count.
  expect(coarseTime("2026-08-24T12:00:05Z", now)).toBe("now");
});

describe("groupByItem", () => {
  const items = [
    { id: "quiet", title: "Quiet", status: "open", createdAt: "2026-08-24T00:00:00Z" },
    { id: "hot", title: "Hot", status: "open", createdAt: "2026-08-23T00:00:00Z" },
    { id: "done", title: "Done", status: "done", createdAt: "2026-08-25T00:00:00Z" },
    { id: "cold", title: "Cold", status: "open", createdAt: "2026-08-22T00:00:00Z" },
    { id: "wont", title: "Won't", status: "wont", createdAt: "2026-08-26T00:00:00Z" },
  ];
  const convs = [
    conv({ id: "h1", channel_id: "workbench:p/hot/t1", sandbox_id: "sb1", agent_id: "a1", status: "running", inserted_at: "2026-08-24T03:00:00Z", last_active_at: "2026-08-24T03:30:00Z" }),
    conv({ id: "h2", channel_id: "workbench:p/hot/t2", sandbox_id: "sb1", agent_id: "a1", status: "idle", inserted_at: "2026-08-24T02:00:00Z", last_active_at: "2026-08-24T02:30:00Z" }),
    conv({ id: "c1", channel_id: "workbench:p/cold/t1", sandbox_id: "sb2", agent_id: "a1", status: "terminated", inserted_at: "2026-08-24T04:00:00Z" }),
    conv({ id: "d1", channel_id: "workbench:p/done/t1", sandbox_id: "sb3", agent_id: "a1", status: "idle", inserted_at: "2026-08-24T05:00:00Z" }),
    conv({ id: "x", channel_id: "fountain:team", sandbox_id: "sb9", status: "idle" }),
  ];
  test("items with a live computer first, then newest item first, closed last; computers stay on their item", () => {
    const g = groupByItem(items, convs, new Map());
    // "hot" is live so it leads; "quiet" (created 08-24) then "cold" (08-22)
    // by their own creation, not by which of them last saw output. Both ways
    // of being closed sink, however new the item is.
    expect(g.map((x) => x.item.id)).toEqual(["hot", "quiet", "cold", "done", "wont"]);
    expect(g[0]!.computers).toHaveLength(1);
    expect(g[0]!.computers[0]!.conversations.map((c) => c.id)).toEqual(["h1", "h2"]);
    expect(g[0]!.busy).toBe(true);
    expect(g[1]!.computers).toEqual([]);
    expect(g[2]!.live).toBe(false);
    expect(g[3]!.live).toBe(true); // done, but its computer is still up — shown late, not hidden
    expect(g[4]!.item.id).toBe("wont"); // the newest item of all, and still below every open one
  });

  test("the item list holds still while two agents talk at once", () => {
    // Two work items, each with a running conversation — the case in the bug.
    const two = [
      { id: "first", title: "First", status: "open", createdAt: "2026-08-20T00:00:00Z" },
      { id: "second", title: "Second", status: "open", createdAt: "2026-08-21T00:00:00Z" },
    ];
    const live = [
      conv({ id: "f", channel_id: "workbench:p/first/t", sandbox_id: "sbF", status: "running", inserted_at: "2026-08-22T00:00:00Z" }),
      conv({ id: "s", channel_id: "workbench:p/second/t", sandbox_id: "sbS", status: "running", inserted_at: "2026-08-23T00:00:00Z" }),
    ];
    const before = groupByItem(two, live, new Map()).map((x) => x.item.id);
    expect(before).toEqual(["second", "first"]); // newest item first
    // Whichever of them last printed a line, the list is the same list.
    for (const [f, s] of [
      ["2026-08-24T10:00:00Z", "2026-08-24T10:00:01Z"],
      ["2026-08-24T10:00:02Z", "2026-08-24T10:00:01Z"],
      ["2026-08-24T10:00:02Z", "2026-08-24T10:00:09Z"],
    ] as const) {
      const moved = [
        { ...live[0]!, last_active_at: f },
        { ...live[1]!, last_active_at: s },
      ];
      expect(groupByItem(two, moved, new Map()).map((x) => x.item.id)).toEqual(before);
    }
  });

  // What the explorer's "new work item" row rests on: an item added there has
  // no conversation yet, and still has to be where you can see it afterwards.
  test("a just-created item sorts above the older quiet ones, under the live work", () => {
    const fresh = { id: "fresh", title: "Fresh", status: "open", createdAt: "2026-08-24T06:00:00Z" };
    const g = groupByItem([...items, fresh], convs, new Map());
    // "cold" used to sit above "quiet" here, on the strength of a burst of
    // output from a conversation that is now terminated. Creation order, so
    // the item you just typed lands where you can see it and stays there.
    expect(g.map((x) => x.item.id)).toEqual(["hot", "fresh", "quiet", "cold", "done", "wont"]);
    expect(g[1]!.computers).toEqual([]);
  });
});

test("hueOf is stable and in range", () => {
  expect(hueOf("5e17b8d6")).toBe(hueOf("5e17b8d6"));
  expect(hueOf("5e17b8d6")).not.toBe(hueOf("8e025aa4"));
  for (const id of ["a", "5e17b8d6", "8e025aa4", "269172a5-7061-4119-80d7-75485d3f9872"]) {
    expect(hueOf(id)).toBeGreaterThanOrEqual(0);
    expect(hueOf(id)).toBeLessThan(360);
  }
});

test("clampWidth keeps the explorer usable", () => {
  expect(clampWidth(300)).toBe(300);
  expect(clampWidth(10)).toBe(SIDEBAR_MIN);
  expect(clampWidth(9000)).toBe(SIDEBAR_MAX);
  expect(clampWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT);
  expect(clampWidth(300.6)).toBe(301);
});
