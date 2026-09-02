/**
 * The Changes view, mounted against a stubbed store: the hook's state from
 * `/api/snapshots`, the diff from Fountain's disk read, and what it says when
 * the computer is asleep or the checkout is somewhere Fountain cannot read.
 */
import { describe, expect, mock, test } from "bun:test";
import { FountainError } from "@agentshit/fountain-sdk";
import { mount, wait } from "../../test/render";
import type { Computer } from "../lib/sidebar";
import type { ItemDto, SnapshotDto } from "../lib/api";

mock.module("./AgentAvatar", () => ({ AgentAvatar: ({ agent }: { agent: { name: string } }) => <span className="avatar">{agent.name.slice(0, 2)}</span> }));

const item = { id: "w1", title: "fix foo" } as ItemDto;

const snapshot: SnapshotDto = {
  itemId: "w1",
  computer: "sb1",
  repo: "/home/sprite/work/thing",
  conversationId: "c1",
  agentId: "a1",
  source: "post-commit",
  branch: "wb/fix-foo",
  head: "53b9d1a325b6145d29224ab5ef81c4a112a7203e",
  upstream: "origin/main",
  ahead: 1,
  behind: 0,
  status: "# branch.oid 53b9d1a3\n# branch.head wb/fix-foo\n# branch.upstream origin/main\n# branch.ab +1 -0\n1 .M N... 100644 100644 100644 x y README.md\n? NOTES.md",
  meta: { event: "Stop" },
  takenAt: new Date().toISOString(),
};

const DIFF = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old title\n+new title\n";

function computer(over: Partial<Computer> & { status?: string }): Computer {
  const status = over.status ?? "ready";
  return {
    key: "sb1",
    sandboxId: "sb1",
    agentId: "a1",
    sandbox: { id: "sb1", sprite_name: "quiet-hill", status, conversations: [], url: status === "ready" ? "https://quiet-hill.sprites.app" : null } as unknown as Computer["sandbox"],
    conversations: [],
    live: status === "ready" || status === "suspended",
    busy: false,
    unread: false,
    latest: "",
    startedAt: "2026-09-01T00:00:00Z",
    ...over,
  };
}

/** What the stubbed Fountain was asked, and what it answers. */
const asked: string[] = [];
let diffAnswer: () => Promise<unknown> = () => Promise.resolve({ diff: DIFF, path: "/home/sprite/work/thing", ref: null, repo_root: "/home/sprite/work/thing", staged: false, truncated: false });
let snapshots: SnapshotDto[] = [snapshot];

// One store object for the whole file: a hook returning a fresh object on
// every call would give each effect a new dependency every render.
const current = {
    project: { id: "p1" },
    agents: new Map([["a1", { id: "a1", name: "Coder" }]]),
    lastSnapshot: null,
    toast: () => {},
    fountain: {
      sandboxDiff: (id: string, opts: { path?: string }) => {
        asked.push(`diff ${id} ${opts.path}`);
        return diffAnswer();
      },
      sandboxFiles: (id: string, path: string) => {
        asked.push(`files ${id} ${path}`);
        return Promise.resolve({ path, entries: [{ name: "found", type: "directory", size: 0 }], truncated: false });
      },
      sandboxFile: (id: string, path: string) => {
        asked.push(`file ${id} ${path}`);
        return Promise.resolve({ path, content: "a note\nsecond line\n", encoding: "utf-8", size: 19, truncated: false });
      },
    },
};
const realStore = await import("../store");
mock.module("../store", () => ({ ...realStore, useProject: () => current }));
const realApi = await import("../lib/api");
mock.module("../lib/api", () => ({ ...realApi, api: { ...realApi.api, snapshots: () => Promise.resolve(snapshots) } }));
const { Changes, diskError } = await import("./Changes");

describe("the Changes view", () => {
  test("shows the hook's state and Fountain's diff for a running computer, and reads an untracked file when opened", async () => {
    asked.length = 0;
    snapshots = [snapshot];
    const m = await mount(<Changes item={item} computers={[computer({})]} />);
    await wait(20);
    const html = m.container.innerHTML;
    expect(html).toContain("Changes");
    expect(html).toContain("Coder");
    expect(html).toContain("wb/fix-foo");
    expect(html).toContain("53b9d1a3");
    expect(html).toContain("1 ahead · 0 behind origin/main");
    expect(html).toContain("via post-commit");
    // The diff, parsed and numbered.
    expect(html).toContain("README.md");
    expect(html).toContain("+new title");
    expect(html).toContain("−old title");
    // The untracked file the diff cannot show, from the status.
    expect(html).toContain("NOTES.md");
    expect(html).toContain("untracked");
    // The preview link, off the sandbox record.
    expect(html).toContain("https://quiet-hill.sprites.app");
    expect(asked).toEqual(["diff sb1 /home/sprite/work/thing"]);

    // Opening the untracked file reads it from the machine, as additions.
    const fold = [...m.container.querySelectorAll("details")].find((d) => d.textContent?.includes("NOTES.md"))!;
    await new Promise<void>((r) => {
      fold.open = true;
      fold.dispatchEvent(new Event("toggle"));
      r();
    });
    await wait(20);
    expect(asked).toContain("file sb1 /home/sprite/work/thing/NOTES.md");
    expect(m.container.innerHTML).toContain("+a note");
    await m.unmount();
  });

  test("a parked computer shows the last reported state and says Fountain will not read it", async () => {
    asked.length = 0;
    snapshots = [snapshot];
    const m = await mount(<Changes item={item} computers={[computer({ status: "suspended" })]} />);
    await wait(20);
    const html = m.container.innerHTML;
    expect(html).toContain("Fountain reads a running computer only");
    expect(html).toContain("suspended");
    expect(html).toContain("wb/fix-foo");
    // The status still lists what moved, since there is no diff to show it.
    expect(html).toContain("README.md");
    expect(html).toContain("modified");
    expect(asked).toEqual([]);
    await m.unmount();
  });

  test("a checkout Fountain cannot reach is named as the reason, not shown blank", async () => {
    asked.length = 0;
    snapshots = [{ ...snapshot, repo: "/workspace/thing" }];
    diffAnswer = () => Promise.reject(new FountainError("path_outside_sandbox", { status: 422, code: "path_outside_sandbox" }));
    const m = await mount(<Changes item={item} computers={[computer({})]} />);
    await wait(20);
    expect(m.container.innerHTML).toContain("Fountain reads under /home/sprite only, and this checkout is at /workspace/thing");
    diffAnswer = () => Promise.resolve({ diff: DIFF, path: "/home/sprite/work/thing", ref: null, repo_root: "/home/sprite/work/thing", staged: false, truncated: false });
    await m.unmount();
  });

  test("with no snapshot yet, a running computer's work directory is listed for checkouts", async () => {
    asked.length = 0;
    snapshots = [];
    const m = await mount(<Changes item={item} computers={[computer({})]} />);
    await wait(20);
    expect(asked[0]).toBe("files sb1 /home/sprite/work");
    expect(asked).toContain("diff sb1 /home/sprite/work/found");
    expect(m.container.innerHTML).toContain("found");
    await m.unmount();
  });

  test("a computer with no sandbox and nothing reported is not a row; no computers is no section", async () => {
    snapshots = [];
    const none = await mount(<Changes item={item} computers={[]} />);
    await wait(10);
    expect(none.container.innerHTML).toBe("");
    await none.unmount();
    const bare = await mount(<Changes item={item} computers={[computer({ sandboxId: null, sandbox: null, key: "conv:c9" })]} />);
    await wait(10);
    expect(bare.container.innerHTML).toBe("");
    await bare.unmount();
  });
});

test("diskError puts Fountain's refusals into words", () => {
  expect(diskError(new FountainError("x", { status: 409, code: "sandbox_not_ready" }), "/r")).toContain("parked");
  expect(diskError(new FountainError("x", { status: 422, code: "not_a_repository" }), "/r")).toBe("/r is not a git repository.");
  expect(diskError(new FountainError("x", { status: 404, code: "path_not_found" }), "/r")).toContain("no longer on the machine");
});
