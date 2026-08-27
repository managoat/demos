import { describe, expect, test } from "bun:test";
import { agentFits, defaultTeammate, normalizeLegacy, removedMessage, retiredMessage } from "./workbench";

describe("agentFits", () => {
  const project = { environmentId: "e1", vaultId: "v1" };
  test("no allowlists: fits", () => {
    expect(agentFits({}, project)).toEqual({ ok: true });
    expect(agentFits({ allowed_environment_ids: [], allowed_vault_ids: null }, project)).toEqual({ ok: true });
  });
  test("allowlist admitting the project's env and vault: fits", () => {
    expect(agentFits({ allowed_environment_ids: ["e1", "e2"], allowed_vault_ids: ["v1"] }, project)).toEqual({ ok: true });
  });
  test("allowlist excluding the env or vault: does not", () => {
    expect(agentFits({ allowed_environment_ids: ["e2"] }, project).ok).toBe(false);
    expect(agentFits({ allowed_vault_ids: ["v2"] }, project).ok).toBe(false);
  });
  test("a project with no env/vault set never trips an allowlist", () => {
    expect(agentFits({ allowed_environment_ids: ["e2"], allowed_vault_ids: ["v2"] }, { environmentId: null, vaultId: null })).toEqual({ ok: true });
  });
});

describe("retiredMessage", () => {
  test("nothing was running: nothing to say", () => {
    expect(retiredMessage({ conversations: 0, computers: 0, failed: 0 })).toBeNull();
  });
  test("what went, counted", () => {
    expect(retiredMessage({ conversations: 2, computers: 1, failed: 0 })).toEqual({ text: "Retired 2 conversations on 1 computer.", kind: "info" });
    expect(retiredMessage({ conversations: 1, computers: 0, failed: 0 })).toEqual({ text: "Retired 1 conversation.", kind: "info" });
  });
  test("what did not is an error, with Fountain's reason", () => {
    expect(retiredMessage({ conversations: 1, computers: 1, failed: 1, error: "Fountain answered 500." })).toEqual({
      text: "Marked done, but 1 conversation would not retire: Fountain answered 500.",
      kind: "error",
    });
    expect(retiredMessage({ conversations: 0, computers: 0, failed: 0, error: "Fountain answered 401." })).toEqual({
      text: "Marked done, but its computers could not be retired: Fountain answered 401.",
      kind: "error",
    });
  });
  test("the notice says which way the item was closed", () => {
    expect(retiredMessage({ conversations: 1, computers: 1, failed: 1, error: "Fountain answered 500." }, "wont")!.text).toBe(
      "Marked won't do, but 1 conversation would not retire: Fountain answered 500.",
    );
    // What actually went is the same either way.
    expect(retiredMessage({ conversations: 2, computers: 1, failed: 0 }, "wont")).toEqual({ text: "Retired 2 conversations on 1 computer.", kind: "info" });
  });
});

describe("removedMessage", () => {
  test("a computer that was already down goes quietly — the row leaving says it", () => {
    expect(removedMessage({ conversations: 0, computers: 0, failed: 0 })).toBeNull();
  });
  test("one that was still running says what it cost to take out", () => {
    expect(removedMessage({ conversations: 2, computers: 1, failed: 0 })).toEqual({ text: "Removed, and retired 2 conversations on it.", kind: "info" });
  });
  test("the row left the item and the machine did not: the one outcome worth hearing about", () => {
    expect(removedMessage({ conversations: 0, computers: 0, failed: 1, error: "Fountain answered 500." })).toEqual({
      text: "Removed, but 1 conversation would not retire, so it may still be running: Fountain answered 500.",
      kind: "error",
    });
    expect(removedMessage({ conversations: 0, computers: 0, failed: 0, error: "Fountain answered 401." })).toEqual({
      text: "Removed, but it may still be running: Fountain answered 401.",
      kind: "error",
    });
  });
});

describe("normalizeLegacy", () => {
  test("drops garbage, keeps ids, fills defaults", () => {
    const s = normalizeLegacy({
      projects: [{ id: "p1", name: "" }, { nope: true }, null],
      items: [
        { id: "w1", projectId: "p1", status: "done", agentIds: ["a", 3] },
        { id: "w2", projectId: "missing" },
      ],
    });
    expect(s.projects).toHaveLength(1);
    expect(s.projects[0]!.name).toBe("Untitled project");
    expect(s.items).toHaveLength(1);
    expect(s.items[0]!.agentIds).toEqual(["a"]);
    expect(s.items[0]!.status).toBe("done");
  });
  test("anything else is empty", () => {
    expect(normalizeLegacy(null)).toEqual({ projects: [], items: [] });
    expect(normalizeLegacy("x")).toEqual({ projects: [], items: [] });
  });
});

describe("defaultTeammate", () => {
  const project = { environmentId: "e1", vaultId: "v1", defaultAgentId: "a1" };
  const coder = { id: "a1", allowed_environment_ids: ["e1"], allowed_vault_ids: null };
  const team = new Map([["a1", coder]]);
  test("the agent the project names", () => {
    expect(defaultTeammate(project, team)).toBe(coder);
  });
  test("none set: nobody, so every picker asks", () => {
    expect(defaultTeammate({ ...project, defaultAgentId: null }, team)).toBeNull();
  });
  test("gone from the owner's Fountain: nobody", () => {
    expect(defaultTeammate(project, new Map())).toBeNull();
  });
  test("still there but no longer allowed in this project: nobody", () => {
    expect(defaultTeammate({ ...project, environmentId: "e9" }, team)).toBeNull();
  });
});
