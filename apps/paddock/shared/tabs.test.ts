import { describe, expect, test } from "bun:test";
import type { Conversation } from "../src/api/types";
import { bootstrapPrompt, welcomePrompt } from "./spec";
import {
  canPrompt,
  channelFor,
  findBox,
  holder,
  nextSlug,
  opsTab,
  parseChannel,
  staleTabs,
  tabsOf,
  titleOf,
  visibleTabs,
} from "./tabs";

const WORK = "/home/sprite/work";

function conv(over: Partial<Conversation> & { id: string }): Conversation {
  return {
    title: null,
    sandbox_id: "sb1",
    sandbox: null,
    agent_id: "a1",
    vault_id: null,
    environment_id: null,
    runtime: "claude",
    status: "idle",
    channel_id: channelFor("t1", 3),
    turn_count: 1,
    last_active_at: null,
    inserted_at: "2026-09-04T10:00:00Z",
    ...over,
  };
}

const input = { sandboxId: "sb1", agentId: "a1", rev: 3, workRoot: WORK };

describe("channel ids", () => {
  test("a slug and a revision round-trip", () => {
    expect(parseChannel(channelFor("t2", 7))).toEqual({ slug: "t2", rev: 7 });
    expect(parseChannel(channelFor("ops", 0))).toEqual({ slug: "ops", rev: 0 });
  });

  test("another app's channel is not ours", () => {
    expect(parseChannel("salon:abc")).toBeNull();
    expect(parseChannel("workbench:p/i/t")).toBeNull();
    expect(parseChannel(null)).toBeNull();
    expect(parseChannel("")).toBeNull();
    expect(parseChannel("paddock:")).toBeNull();
  });

  test("a paddock channel from before revisions reads as rev 0, so it is behind everything", () => {
    expect(parseChannel("paddock:t1")).toEqual({ slug: "t1", rev: 0 });
  });

  test("a malformed revision is rejected rather than guessed at", () => {
    expect(parseChannel("paddock:t1@rabc")).toBeNull();
    expect(parseChannel("paddock:t1@r-2")).toBeNull();
  });
});

describe("tabsOf", () => {
  test("every live paddock conversation on the box becomes a tab, oldest first", () => {
    const tabs = tabsOf(
      [
        conv({ id: "c2", channel_id: channelFor("t2", 3), inserted_at: "2026-09-04T11:00:00Z" }),
        conv({ id: "c1", channel_id: channelFor("t1", 3), inserted_at: "2026-09-04T10:00:00Z" }),
      ],
      input,
    );
    expect(tabs.map((t) => t.conversation.id)).toEqual(["c1", "c2"]);
    expect(tabs.map((t) => t.title)).toEqual(["Terminal 1", "Terminal 2"]);
    expect(tabs[0]!.cwd).toBe(`${WORK}/t1`);
  });

  test("another machine, another agent, a dead tab and a foreign channel are all left out", () => {
    const tabs = tabsOf(
      [
        conv({ id: "other-box", sandbox_id: "sb2" }),
        conv({ id: "other-agent", agent_id: "a2" }),
        conv({ id: "dead", status: "terminated" }),
        conv({ id: "failed", status: "failed" }),
        conv({ id: "not-ours", channel_id: "salon:x" }),
        conv({ id: "no-channel", channel_id: null }),
        conv({ id: "keep" }),
      ],
      input,
    );
    expect(tabs.map((t) => t.conversation.id)).toEqual(["keep"]);
  });

  test("pending and running count as live — a tab exists before its first turn lands", () => {
    const tabs = tabsOf([conv({ id: "p", status: "pending" }), conv({ id: "r", status: "running", channel_id: channelFor("t2", 3) })], input);
    expect(tabs).toHaveLength(2);
  });

  test("a tab opened before the current revision is stale", () => {
    const tabs = tabsOf(
      [conv({ id: "old", channel_id: channelFor("t1", 2) }), conv({ id: "new", channel_id: channelFor("t2", 3) })],
      input,
    );
    expect(tabs.find((t) => t.conversation.id === "old")!.stale).toBe(true);
    expect(tabs.find((t) => t.conversation.id === "new")!.stale).toBe(false);
    expect(staleTabs(tabs).map((t) => t.slug)).toEqual(["t1"]);
  });

  test("the ops tab is a tab, but never in the strip and never counted as stale", () => {
    const tabs = tabsOf(
      [conv({ id: "c1" }), conv({ id: "ops", channel_id: channelFor("ops", 1), inserted_at: "2026-09-04T12:00:00Z" })],
      input,
    );
    expect(tabs).toHaveLength(2);
    expect(visibleTabs(tabs).map((t) => t.slug)).toEqual(["t1"]);
    expect(opsTab(tabs)!.title).toBe("Machine");
    expect(staleTabs(tabs)).toEqual([]);
  });
});

describe("two tabs claiming one slug", () => {
  test("both stay in the strip, and the newer one is told apart", () => {
    // Happens when a tab is opened out of band, or two browsers race
    // nextSlug. Hiding one would make somebody's open tab vanish.
    const tabs = tabsOf(
      [
        conv({ id: "first", channel_id: channelFor("t1", 3), inserted_at: "2026-09-04T10:00:00Z" }),
        conv({ id: "second", channel_id: channelFor("t1", 3), inserted_at: "2026-09-04T11:00:00Z" }),
      ],
      input,
    );
    expect(tabs).toHaveLength(2);
    expect(tabs.map((t) => t.title)).toEqual(["Terminal 1", "Terminal 1 (2)"]);
    // The conversation id is what identifies a tab; the slug is only a name.
    expect(new Set(tabs.map((t) => t.conversation.id)).size).toBe(2);
  });
});

describe("one turn at a time", () => {
  test("a running tab holds the machine and the others queue behind it", () => {
    const tabs = tabsOf(
      [conv({ id: "c1", status: "running" }), conv({ id: "c2", status: "idle", channel_id: channelFor("t2", 3) })],
      input,
    );
    expect(holder(tabs)!.slug).toBe("t1");
    expect(canPrompt(tabs, "t1")).toBe(true);
    expect(canPrompt(tabs, "t2")).toBe(false);
  });

  test("an idle box lets anybody prompt", () => {
    const tabs = tabsOf([conv({ id: "c1" }), conv({ id: "c2", channel_id: channelFor("t2", 3) })], input);
    expect(holder(tabs)).toBeNull();
    expect(canPrompt(tabs, "t2")).toBe(true);
  });
});

describe("nextSlug", () => {
  test("fills the first free number, reusing one a closed tab gave up", () => {
    const tabs = tabsOf(
      [conv({ id: "c1", channel_id: channelFor("t1", 3) }), conv({ id: "c3", channel_id: channelFor("t3", 3) })],
      input,
    );
    expect(nextSlug(tabs)).toBe("t2");
    expect(nextSlug([])).toBe("t1");
  });
});

describe("titleOf", () => {
  test("a tab's own title wins over the derived one", () => {
    expect(titleOf({ title: "deploys" }, "t2")).toBe("deploys");
    expect(titleOf({ title: "   " }, "t2")).toBe("Terminal 2");
    expect(titleOf({ title: null }, "weird")).toBe("weird");
  });
});

describe("findBox", () => {
  test("the newest live paddock conversation names the machine", () => {
    const box = findBox(
      [
        conv({ id: "old", sandbox_id: "sbOld", inserted_at: "2026-09-01T10:00:00Z" }),
        conv({ id: "new", sandbox_id: "sbNew", inserted_at: "2026-09-04T10:00:00Z" }),
      ],
      "a1",
    );
    expect(box).toBe("sbNew");
  });

  test("dead conversations, other agents and other apps do not name a machine", () => {
    expect(findBox([conv({ id: "d", status: "terminated" })], "a1")).toBeNull();
    expect(findBox([conv({ id: "o", agent_id: "a2" })], "a1")).toBeNull();
    expect(findBox([conv({ id: "s", channel_id: "salon:x" })], "a1")).toBeNull();
    expect(findBox([], "a1")).toBeNull();
  });

  test("a live conversation with no machine yet does not name one", () => {
    expect(findBox([conv({ id: "p", status: "pending", sandbox_id: null })], "a1")).toBeNull();
  });
});

describe("the welcome turn", () => {
  test("does the setup as well as the introduction — a tab is useless without a directory", () => {
    const welcome = welcomePrompt({ slug: "t1", repoPath: null });
    const bootstrap = bootstrapPrompt({ slug: "t1", repoPath: null });
    // Everything the terse version does, verbatim, and then some.
    expect(welcome.startsWith(bootstrap)).toBe(true);
    expect(welcome).toContain("introduce it");
    expect(welcome.length).toBeGreaterThan(bootstrap.length);
  });

  test("carries a worktree when the box has a repository, exactly as the terse one does", () => {
    const welcome = welcomePrompt({ slug: "t2", repoPath: "/home/sprite/api" });
    expect(welcome).toContain("git worktree add /home/sprite/work/t2");
  });

  test("names what a person can actually do here, so the first turn orients them", () => {
    const welcome = welcomePrompt({ slug: "t1", repoPath: null });
    for (const subject of ["persists", "tab", "one tab runs a turn at a time", "Machine panel", "applied", "People"]) {
      expect(welcome).toContain(subject);
    }
  });
});
