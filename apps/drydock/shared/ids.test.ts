/**
 * Names, and the round trip that keeps four uses of one string in step.
 *
 * `parseChannel` is the inverse of `threadChannel`, and it is the only way the
 * server learns which project a conversation belongs to without a table saying
 * so. If these two ever disagree, threads silently stop belonging to their
 * projects — so the round trip is asserted rather than assumed.
 */
import { describe, expect, test } from "bun:test";
import { branchFor, isProjectChannel, mountPathFor, parseChannel, slugify, threadChannel } from "./ids";

describe("slugify", () => {
  test("makes something a directory, a branch and a URL all accept", () => {
    expect(slugify("Fix the build")).toBe("fix-the-build");
    expect(slugify("  Kyoto  ")).toBe("kyoto");
    expect(slugify("#1569 Reapply agent/env")).toBe("1569-reapply-agent-env");
  });

  test("collapses and trims the separators rather than leaving them", () => {
    // A trailing dash is legal in a directory name and illegal at the end of a
    // git ref component, so the strictest rule wins for both.
    expect(slugify("a---b")).toBe("a-b");
    expect(slugify("---")).toBe("thread");
    expect(slugify("...")).toBe("thread");
    expect(slugify("hello!!!")).toBe("hello");
  });

  test("falls back rather than returning an empty string", () => {
    expect(slugify("")).toBe("thread");
    expect(slugify("", "sy")).toBe("sy");
    expect(slugify("😀")).toBe("thread");
  });

  test("stays short enough for a branch name", () => {
    expect(slugify("x".repeat(200)).length).toBeLessThanOrEqual(40);
  });
});

describe("the channel round trip", () => {
  test("what threadChannel writes, parseChannel reads back", () => {
    const channel = threadChannel("proj-1", "kyoto", 7);
    expect(channel).toBe("drydock:proj-1:kyoto@r7");
    expect(parseChannel(channel)).toEqual({ projectId: "proj-1", slug: "kyoto", rev: 7 });
  });

  test("survives a uuid project id, which is what it actually carries", () => {
    const id = "569e39a5-9a8f-46db-b258-83fa6ee3d20c";
    expect(parseChannel(threadChannel(id, "osaka", 1))?.projectId).toBe(id);
  });

  test("anything that is not ours parses as nothing", () => {
    for (const raw of [null, undefined, "", "fountain:team", "drydock:only-a-project", "drydock:p:t", "drydock:p:t@rx"]) {
      expect(parseChannel(raw)).toBeNull();
    }
  });

  test("belongs to its project whatever revision it opened at", () => {
    expect(isProjectChannel(threadChannel("p", "t", 1), "p")).toBe(true);
    expect(isProjectChannel(threadChannel("p", "t", 99), "p")).toBe(true);
    expect(isProjectChannel(threadChannel("p", "t", 1), "other")).toBe(false);
    expect(isProjectChannel("fountain:team", "p")).toBe(false);
  });
});

test("a branch is namespaced under whoever asked for it", () => {
  expect(branchFor("jhgaylor", "kyoto")).toBe("jhgaylor/kyoto");
  // A login with characters git will not take still has to produce a ref.
  expect(branchFor("Some.Person", "fix")).toBe("some-person/fix");
});

test("a repository lands where Fountain's own convention puts it", () => {
  expect(mountPathFor("BinaryBourbon/fountain")).toBe("/workspace/fountain");
  expect(mountPathFor("demos")).toBe("/workspace/demos");
});
