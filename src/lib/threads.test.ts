import { describe, expect, test } from "bun:test";
import type { Conversation, Teammate } from "../api/types";
import { groupSideThreads, nextThreadTitle, sideThreadsOf, threadOfKey, threadPresence, threadTitle, viewThrough } from "./threads";

function conv(over: Partial<Conversation>): Conversation {
  return {
    id: "c",
    title: null,
    sandbox_id: "sb",
    sandbox: { id: "sb", sprite_name: "s", status: "ready", url: null },
    agent_id: "a",
    vault_id: null,
    environment_id: null,
    runtime: "claude",
    acp: true,
    status: "idle",
    channel_id: null,
    turn_count: 0,
    last_active_at: null,
    last_read_at: null,
    unread: false,
    inserted_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const main = conv({ id: "main", channel_id: "fountain:team" });
const teammate = {
  agent_id: "a",
  name: "Ada",
  agent: { id: "a", name: "Ada", model: "m", runtime: "claude", environment_id: null, allowed_vault_ids: null, allowed_environment_ids: null },
  conversation: main,
  presence: { state: "online", label: "online" },
  unread: false,
  last_turn: null,
  preview: null,
} as Teammate;

describe("sideThreadsOf", () => {
  test("same agent + same sandbox, off the team channel, live, oldest first", () => {
    const all = [
      main,
      conv({ id: "t2", inserted_at: "2026-01-02T00:00:00Z" }),
      conv({ id: "t1", inserted_at: "2026-01-01T12:00:00Z" }),
      conv({ id: "other-agent", agent_id: "b" }),
      conv({ id: "other-sandbox", sandbox_id: "sb2" }),
      conv({ id: "dead", status: "terminated" }),
      conv({ id: "retired-main", channel_id: "fountain:team" }),
    ];
    expect(sideThreadsOf(all, teammate).map((c) => c.id)).toEqual(["t1", "t2"]);
  });

  test("no sandbox yet → no side threads", () => {
    const t = { ...teammate, conversation: conv({ id: "main", sandbox_id: null, sandbox: null }) };
    expect(sideThreadsOf([conv({ id: "t1", sandbox_id: null })], t)).toEqual([]);
  });

  test("groupSideThreads keys by agent and skips teammates with none", () => {
    const m = groupSideThreads([main, conv({ id: "t1" })], [teammate, { ...teammate, agent_id: "b", conversation: conv({ id: "mb", agent_id: "b" }) }]);
    expect([...m.keys()]).toEqual(["a"]);
    expect(m.get("a")!.map((c) => c.id)).toEqual(["t1"]);
  });
});

describe("names", () => {
  test("title, else Thread n counting the main as 1", () => {
    expect(threadTitle(conv({ title: "Bugfix" }), 0)).toBe("Bugfix");
    expect(threadTitle(conv({ title: "  " }), 0)).toBe("Thread 2");
    expect(threadTitle(conv({}), 3)).toBe("Thread 5");
  });
  test("nextThreadTitle skips a taken default", () => {
    expect(nextThreadTitle([])).toBe("Thread 2");
    expect(nextThreadTitle([conv({ title: "Thread 3" })])).toBe("Thread 4");
    expect(nextThreadTitle([conv({ title: "Bugfix" })])).toBe("Thread 3");
  });
});

describe("threadPresence", () => {
  test("its own turn is working; idle on a ready computer is online", () => {
    expect(threadPresence(conv({ status: "running" }), teammate).state).toBe("working");
    expect(threadPresence(conv({}), teammate).state).toBe("online");
  });
  test("the machine's state wins when the runner is off", () => {
    const off = { presence: { state: "machine_offline" as const, label: "machine offline" } };
    expect(threadPresence(conv({ status: "running" }), off)).toEqual(off.presence);
  });
  test("a computer still starting reads as starting", () => {
    expect(threadPresence(conv({ status: "pending", sandbox: { id: "sb", sprite_name: "s", status: "provisioning", url: null } }), teammate).state).toBe("starting");
  });
});

test("viewThrough swaps the conversation and derives the rest", () => {
  const v = viewThrough({ ...teammate, unread: true }, conv({ id: "t1", status: "running", unread: false }));
  expect(v.conversation.id).toBe("t1");
  expect(v.presence.state).toBe("working");
  expect(v.unread).toBe(false);
  expect(v.name).toBe("Ada");
});

test("threadOfKey finds a thread by conversation id", () => {
  const threads = new Map([["a", [conv({ id: "t1" })]]]);
  expect(threadOfKey(threads, "t1")?.agentId).toBe("a");
  expect(threadOfKey(threads, "a")).toBeNull();
});
