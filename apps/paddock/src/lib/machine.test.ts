import { describe, expect, test } from "bun:test";
import {
  applyKeep,
  applyTodo,
  boxDrift,
  configRev,
  desiredItems,
  fingerprint,
  needsApply,
  packageId,
  primaryRepoPath,
  repoId,
  setupId,
  shortRepo,
  skillNames,
  withRev,
  type Declared,
} from "./machine";
import type { Receipt } from "./protocol";

const declared = (over: Partial<Declared> = {}): Declared => ({
  agent: { runtime: "claude", skills: ["pdf"], mcp_servers: { linear: {} }, metadata: null },
  environment: {
    repositories: [{ url: "https://github.com/you/api.git", mount_path: "/home/sprite/api", ref: "main" }],
    packages: ["ripgrep", "jq"],
    setup_script: "bun install\n",
  },
  envSecretKeys: ["GITHUB_TOKEN"],
  vaultSecretKeys: ["STRIPE_SECRET_KEY"],
  ...over,
});

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  rev: 1,
  runtime: "claude",
  appliedAt: "2026-09-04T10:00:00Z",
  items: [],
  failed: [],
  ...over,
});

describe("desiredItems", () => {
  test("sorts every declared thing into the tier that can actually deliver it", () => {
    const items = desiredItems(declared());
    const tier = (id: string) => items.find((i) => i.id === id)?.tier;

    // The environment builds the disk.
    expect(tier(repoId({ url: "https://github.com/you/api.git", mount_path: "/home/sprite/api", ref: "main" }))).toBe("box");
    expect(tier(packageId("ripgrep"))).toBe("box");
    expect(tier(setupId("bun install"))).toBe("box");
    // The agent is injected per session.
    expect(tier("skill:pdf")).toBe("session");
    expect(tier("mcp:linear")).toBe("session");
    expect(tier("secret:env:GITHUB_TOKEN")).toBe("session");
    expect(tier("secret:vault:STRIPE_SECRET_KEY")).toBe("session");
    // The runtime is baked in.
    expect(tier("runtime:claude")).toBe("machine");
  });

  test("an absent setup script is not an item", () => {
    // Otherwise an empty box is permanently one item short of applied.
    for (const setup_script of [undefined, null, "", "   \n  "]) {
      const items = desiredItems(declared({ environment: { repositories: [], packages: [], setup_script } }));
      expect(items.some((i) => i.kind === "setup")).toBe(false);
    }
  });

  test("changing the setup script's contents changes its id", () => {
    const idA = desiredItems(declared()).find((i) => i.kind === "setup")!.id;
    const idB = desiredItems(declared({ environment: { ...declared().environment, setup_script: "bun install --frozen" } })).find(
      (i) => i.kind === "setup",
    )!.id;
    expect(idA).not.toBe(idB);
  });

  test("a repo's ref is part of its identity, so switching branch is a new item", () => {
    const base = { url: "https://github.com/you/api.git", mount_path: "/home/sprite/api" };
    expect(repoId({ ...base, ref: "main" })).not.toBe(repoId({ ...base, ref: "next" }));
    expect(repoId({ ...base, ref: null })).toBe(repoId({ ...base, ref: "  " }));
  });

  test("empty declarations still yield the runtime, and nothing else", () => {
    const items = desiredItems({
      agent: { runtime: "codex", skills: null, mcp_servers: null, metadata: null },
      environment: { repositories: null, packages: null, setup_script: null },
      envSecretKeys: [],
      vaultSecretKeys: [],
    });
    expect(items.map((i) => i.id)).toEqual(["runtime:codex"]);
  });
});

describe("boxDrift", () => {
  const items = desiredItems(declared());
  const boxIds = items.filter((i) => i.tier === "box").map((i) => i.id);

  test("no receipt is 'not known', never 'nothing applied'", () => {
    const d = boxDrift(items, null);
    expect(d.known).toBe(false);
    expect(d.statuses.every((s) => s.state === "pending")).toBe(true);
  });

  test("everything on the box reads applied, and needs no apply turn", () => {
    const d = boxDrift(items, receipt({ items: boxIds }));
    expect(d.known).toBe(true);
    expect(d.statuses.every((s) => s.state === "applied")).toBe(true);
    expect(needsApply(d)).toBe(false);
    expect(applyTodo(d)).toEqual([]);
    expect(applyKeep(d).sort()).toEqual([...boxIds].sort());
  });

  test("a declared item the box has not got is pending", () => {
    const d = boxDrift(items, receipt({ items: boxIds.filter((id) => id !== packageId("jq")) }));
    expect(d.statuses.find((s) => s.item.id === packageId("jq"))!.state).toBe("pending");
    expect(needsApply(d)).toBe(true);
    expect(applyTodo(d).map((t) => t.id)).toEqual([packageId("jq")]);
    // A partial apply must not undo the rest.
    expect(applyKeep(d)).toContain(packageId("ripgrep"));
  });

  test("a reported failure is its own state, and carries the reason", () => {
    const d = boxDrift(items, receipt({ items: boxIds.filter((id) => id !== packageId("jq")), failed: [{ id: packageId("jq"), why: "no such package" }] }));
    const jq = d.statuses.find((s) => s.item.id === packageId("jq"))!;
    expect(jq.state).toBe("failed");
    expect(jq.why).toBe("no such package");
    // A failure is still something to retry.
    expect(applyTodo(d).map((t) => t.id)).toEqual([packageId("jq")]);
  });

  test("an item on the box that nothing declares any more is 'extra', not an error", () => {
    const d = boxDrift(items, receipt({ items: [...boxIds, "pkg:cowsay"] }));
    expect(d.extra).toEqual(["pkg:cowsay"]);
    expect(needsApply(d)).toBe(false);
  });

  test("only tier box is the receipt's business", () => {
    const d = boxDrift(items, receipt({ items: boxIds }));
    expect(d.statuses.every((s) => s.item.tier === "box")).toBe(true);
    expect(d.statuses.some((s) => s.item.kind === "mcp")).toBe(false);
  });

  test("a failure the box also reports as installed counts as installed", () => {
    // Contradictory receipts happen; 'present' is the safer reading, because
    // the alternative is reinstalling something that is already there.
    const d = boxDrift(items, receipt({ items: boxIds, failed: [{ id: packageId("jq"), why: "stale line" }] }));
    expect(d.statuses.find((s) => s.item.id === packageId("jq"))!.state).toBe("applied");
  });
});

describe("configRev / withRev", () => {
  test("an agent with no metadata is revision 0", () => {
    expect(configRev({ metadata: null })).toBe(0);
    expect(configRev({ metadata: {} })).toBe(0);
    expect(configRev({ metadata: { paddock: {} } })).toBe(0);
    expect(configRev({ metadata: { paddock: "nope" } })).toBe(0);
    expect(configRev({ metadata: { paddock: { rev: -3 } } })).toBe(0);
    expect(configRev({ metadata: { paddock: { rev: "7" } } })).toBe(0);
  });

  test("a revision round-trips, and nobody else's metadata is disturbed", () => {
    const before = { salon: { key: "keep me" }, paddock: { rev: 2, other: true } };
    const after = withRev(before, 3);
    expect(configRev({ metadata: after })).toBe(3);
    expect(after.salon).toEqual({ key: "keep me" });
    expect((after.paddock as { other: boolean }).other).toBe(true);
  });

  test("withRev copes with no metadata at all", () => {
    expect(configRev({ metadata: withRev(null, 1) })).toBe(1);
  });
});

describe("odds and ends", () => {
  test("fingerprint is stable and content-sensitive", () => {
    expect(fingerprint("bun install")).toBe(fingerprint("bun install"));
    expect(fingerprint("bun install")).not.toBe(fingerprint("bun install "));
    expect(fingerprint("")).toMatch(/^[0-9a-f]{8}$/);
  });

  test("shortRepo trims a URL to owner/name", () => {
    expect(shortRepo("https://github.com/you/api.git")).toBe("you/api");
    expect(shortRepo("https://github.com/you/api/")).toBe("you/api");
    expect(shortRepo("api")).toBe("api");
  });

  test("skillNames accepts both shapes Fountain serves, sorted and de-duplicated", () => {
    expect(skillNames(["pdf", { name: "xlsx" }, { slug: "docx" }, "pdf", 42, null])).toEqual(["docx", "pdf", "xlsx"]);
    expect(skillNames(null)).toEqual([]);
  });

  test("primaryRepoPath is where a tab's worktree comes from", () => {
    expect(primaryRepoPath({ repositories: [{ url: "u", mount_path: "/home/sprite/api" }] })).toBe("/home/sprite/api");
    expect(primaryRepoPath({ repositories: [] })).toBeNull();
    expect(primaryRepoPath({ repositories: null })).toBeNull();
  });
});
