import { describe, expect, test } from "bun:test";
import { EMPTY, addItem, addProject, addTeammate, agentFits, channelFor, normalize, parseChannel, reconcile, removeProject, removeTeammate } from "./workbench";

describe("channel ids", () => {
  test("round-trip", () => {
    expect(parseChannel(channelFor("abc123", "def456"))).toEqual({ projectId: "abc123", itemId: "def456" });
  });
  test("rejects other channels and malformed ones", () => {
    expect(parseChannel("fountain:team")).toBeNull();
    expect(parseChannel("workbench:")).toBeNull();
    expect(parseChannel("workbench:abc")).toBeNull();
    expect(parseChannel("workbench:abc/")).toBeNull();
    expect(parseChannel("workbench:/abc")).toBeNull();
    expect(parseChannel("workbench:a b/c")).toBeNull();
    expect(parseChannel(null)).toBeNull();
  });
});

describe("reconcile", () => {
  test("recovers a project (with its env + vault) and item (with its teammate) from a conversation", () => {
    const s = reconcile(EMPTY, [
      { channel_id: "workbench:p1/w1", title: "Coder: Fix foo", inserted_at: "2026-08-23T00:00:00Z", agent_id: "a1", environment_id: "e1", vault_id: "v1" },
    ]);
    expect(s.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(s.projects[0]!.environmentId).toBe("e1");
    expect(s.projects[0]!.vaultId).toBe("v1");
    expect(s.items).toHaveLength(1);
    expect(s.items[0]!.title).toBe("Fix foo");
    expect(s.items[0]!.projectId).toBe("p1");
    expect(s.items[0]!.agentIds).toEqual(["a1"]);
  });
  test("adds a teammate the browser has not seen on a known item", () => {
    const [s1, p] = addProject(EMPTY, { name: "Fountain" });
    const [s2, w] = addItem(s1, p.id, "fix foo");
    const s3 = reconcile(s2, [{ channel_id: channelFor(p.id, w.id), agent_id: "a9" }]);
    expect(s3.items[0]!.agentIds).toEqual(["a9"]);
  });
  test("returns the same object when nothing is missing", () => {
    const [s1, p] = addProject(EMPTY, { name: "Fountain" });
    const [s2, w] = addItem(s1, p.id, "fix foo");
    const s3 = addTeammate(s2, w.id, "a1");
    expect(reconcile(s3, [{ channel_id: channelFor(p.id, w.id), agent_id: "a1" }])).toBe(s3);
    expect(reconcile(s3, [{ channel_id: "fountain:team" }, { channel_id: null }])).toBe(s3);
  });
});

describe("mutations", () => {
  test("removing a project removes its items", () => {
    const [s1, p] = addProject(EMPTY, { name: "Fountain" });
    const [s2] = addItem(s1, p.id, "fix foo");
    expect(removeProject(s2, p.id).items).toHaveLength(0);
  });
  test("teammates are a set", () => {
    const [s1, p] = addProject(EMPTY, { name: "Fountain" });
    const [s2, w] = addItem(s1, p.id, "fix foo");
    const s3 = addTeammate(addTeammate(s2, w.id, "a1"), w.id, "a1");
    expect(s3.items[0]!.agentIds).toEqual(["a1"]);
    expect(removeTeammate(s3, w.id, "a1").items[0]!.agentIds).toEqual([]);
  });
});

describe("normalize", () => {
  test("drops items whose project is gone and fills defaults", () => {
    const s = normalize({ projects: [{ id: "p" }], items: [{ id: "w", projectId: "p" }, { id: "x", projectId: "gone" }] });
    expect(s.projects[0]!.name).toBe("Untitled project");
    expect(s.projects[0]!.environmentId).toBeNull();
    expect(s.items.map((w) => w.id)).toEqual(["w"]);
    expect(s.items[0]!.status).toBe("open");
    expect(s.items[0]!.agentIds).toEqual([]);
  });
  test("garbage is an empty state", () => {
    expect(normalize("nope")).toEqual(EMPTY);
    expect(normalize(null)).toEqual(EMPTY);
  });
});

describe("agentFits", () => {
  test("empty allowlists admit anything; set ones must include the project's choice", () => {
    expect(agentFits({}, { environmentId: "e1", vaultId: "v1" }).ok).toBe(true);
    expect(agentFits({ allowed_environment_ids: ["e2"] }, { environmentId: "e1", vaultId: null }).ok).toBe(false);
    expect(agentFits({ allowed_environment_ids: ["e2"] }, { environmentId: null, vaultId: null }).ok).toBe(true);
    expect(agentFits({ allowed_vault_ids: ["v1"] }, { environmentId: null, vaultId: "v1" }).ok).toBe(true);
    expect(agentFits({ allowed_vault_ids: ["v2"] }, { environmentId: null, vaultId: "v1" }).ok).toBe(false);
  });
});
