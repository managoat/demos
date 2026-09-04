/**
 * The prompt contract.
 *
 * These assertions are about *what the machine is asked to do* and *what the
 * app believes when it answers*, which is the pair the whole product rests on.
 * The receipt cases matter most: the app prints the receipt as fact above the
 * transcript, so anything it accepts had better have come from the machine
 * rather than from a hopeful default.
 */
import { describe, expect, test } from "bun:test";
import { RECEIPT_PATH, bootstrapPrompt, parseReceipt, starters, systemPrompt, type Origin } from "./spec";

describe("parseReceipt", () => {
  test("reads what the machine wrote", () => {
    const receipt = parseReceipt(
      JSON.stringify({ repo: "a/b", path: "/workspace/b", branch: "me/kyoto", base: "main", sha: "a1b2c3d", files: 1480 }),
    );
    expect(receipt).toEqual({ repo: "a/b", path: "/workspace/b", branch: "me/kyoto", base: "main", sha: "a1b2c3d", files: 1480 });
  });

  test("anything unreadable is 'not yet', never a partial truth", () => {
    // All four of these happen in normal use: the turn has not run, the box is
    // parked, the box is gone, or the agent wrote prose instead of the JSON.
    for (const raw of ["", "  ", "not json", "null", "[]", '{"branch":"x"}']) {
      expect(parseReceipt(raw)).toBeNull();
    }
  });

  test("a detached HEAD is not a branch name", () => {
    // `git rev-parse --abbrev-ref HEAD` prints the literal string HEAD when the
    // checkout failed, and showing "branched HEAD from main" would be a lie.
    const receipt = parseReceipt(JSON.stringify({ path: "/workspace/b", branch: "HEAD", base: "main", files: 3 }));
    expect(receipt?.branch).toBeNull();
  });

  test("a missing file count is null rather than zero", () => {
    // Zero files and an unreported count read very differently on the card.
    const receipt = parseReceipt(JSON.stringify({ path: "/home/sprite", branch: null, base: null, files: null }));
    expect(receipt?.files).toBeNull();
    expect(parseReceipt(JSON.stringify({ path: "/x", files: "many" }))?.files).toBeNull();
  });
});

describe("bootstrapPrompt", () => {
  const repoInput = { repo: "a/b", repoPath: "/workspace/b", branch: "me/kyoto", base: "main" };

  test("writes the receipt where the app reads it", () => {
    const prompt = bootstrapPrompt({ ...repoInput, origin: { kind: "branch", base: "main" } });
    expect(prompt).toContain(RECEIPT_PATH);
  });

  test("asks the shell for the branch rather than trusting the agent", () => {
    const prompt = bootstrapPrompt({ ...repoInput, origin: { kind: "branch", base: "main" } });
    expect(prompt).toContain("git rev-parse --abbrev-ref HEAD");
    expect(prompt).toContain("git ls-files | wc -l");
  });

  test("a PR thread checks the PR out rather than branching beside it", () => {
    const prompt = bootstrapPrompt({ ...repoInput, origin: { kind: "pr", base: "feat/x", number: 1569, title: "t" } });
    expect(prompt).toContain("pull/1569/head");
  });

  test("a machine with no repository is told so and still writes a receipt", () => {
    const prompt = bootstrapPrompt({ repo: null, repoPath: null, branch: "", origin: { kind: "blank" }, base: null });
    expect(prompt).toContain(RECEIPT_PATH);
    expect(prompt).not.toContain("git checkout");
  });
});

describe("systemPrompt", () => {
  test("names the repository and where it is", () => {
    const prompt = systemPrompt({ project: "demos", repo: "a/b", repoPath: "/workspace/b", instructions: "" });
    expect(prompt).toContain("a/b");
    expect(prompt).toContain("/workspace/b");
  });

  test("says the machine is the thread's alone — the isolation is structural", () => {
    const prompt = systemPrompt({ project: "demos", repo: null, repoPath: null, instructions: "" });
    expect(prompt).toContain("yours alone");
  });

  test("does not tell the agent to open a pull request — the app has a button", () => {
    const prompt = systemPrompt({ project: "demos", repo: "a/b", repoPath: "/workspace/b", instructions: "" });
    expect(prompt).toContain("Do not open a pull request yourself");
  });

  test("the owner's instructions are appended, not interleaved", () => {
    const prompt = systemPrompt({ project: "demos", repo: null, repoPath: null, instructions: "Always use tabs." });
    expect(prompt).toContain("From the project's owner");
    expect(prompt.trimEnd().endsWith("Always use tabs.")).toBe(true);
  });

  test("empty instructions add no empty heading", () => {
    const prompt = systemPrompt({ project: "demos", repo: null, repoPath: null, instructions: "   " });
    expect(prompt).not.toContain("From the project's owner");
  });
});

describe("starters", () => {
  test("a thread cut from an issue is not offered 'fix a TODO'", () => {
    const chips = starters({ kind: "issue", base: "main", number: 412, title: "Terminal drops output" }, "a/b");
    expect(chips.some((c) => c.label.includes("412"))).toBe(true);
    expect(chips.some((c) => c.label === "Fix a TODO")).toBe(false);
  });

  test("a PR thread is offered review, not exploration", () => {
    const chips = starters({ kind: "pr", base: "main", number: 1569, title: "t" }, "a/b");
    expect(chips.some((c) => c.label.includes("Review"))).toBe(true);
  });

  test("a machine with no repository is not asked about a repository", () => {
    const chips = starters({ kind: "blank" } satisfies Origin, null);
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((c) => !c.prompt.includes("repository") || c.label === "Show me around")).toBe(true);
  });
});
