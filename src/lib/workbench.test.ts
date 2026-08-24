import { describe, expect, test } from "bun:test";
import {
  EMPTY,
  addItem,
  addMember,
  addProject,
  assignMember,
  channelFor,
  memberFor,
  normalize,
  parseChannel,
  reconcile,
  removeMember,
  removeProject,
} from "./workbench";

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
  test("recovers a project and item from a conversation's channel", () => {
    const s = reconcile(EMPTY, [{ channel_id: "workbench:p1/w1", title: "Coder: Fix foo", inserted_at: "2026-08-23T00:00:00Z" }]);
    expect(s.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]!.title).toBe("Fix foo");
    expect(s.items[0]!.projectId).toBe("p1");
  });
  test("returns the same object when nothing is missing", () => {
    const [s1, p] = addProject(EMPTY, "Fountain");
    const [s2, w] = addItem(s1, p.id, "fix foo");
    expect(reconcile(s2, [{ channel_id: channelFor(p.id, w.id) }])).toBe(s2);
    expect(reconcile(s2, [{ channel_id: "fountain:team" }, { channel_id: null }])).toBe(s2);
  });
});

describe("mutations", () => {
  test("removing a project removes its items", () => {
    const [s1, p] = addProject(EMPTY, "Fountain");
    const [s2] = addItem(s1, p.id, "fix foo");
    expect(removeProject(s2, p.id).items).toHaveLength(0);
  });
  test("removing a member unassigns it everywhere", () => {
    const [s1, p] = addProject(EMPTY, "Fountain");
    const [s2, w] = addItem(s1, p.id, "fix foo");
    const [s3, m] = addMember(s2, { name: "Coder", agentId: "a1", environmentId: null, vaultId: null, notes: "" });
    const s4 = assignMember(assignMember(s3, w.id, m.id), w.id, m.id);
    expect(s4.items[0]!.memberIds).toEqual([m.id]);
    expect(removeMember(s4, m.id).items[0]!.memberIds).toEqual([]);
  });
});

describe("normalize", () => {
  test("drops items whose project is gone and fills defaults", () => {
    const s = normalize({ projects: [{ id: "p" }], items: [{ id: "w", projectId: "p" }, { id: "x", projectId: "gone" }], members: [{ id: "m", agentId: "a" }] });
    expect(s.projects[0]!.name).toBe("Untitled project");
    expect(s.items.map((w) => w.id)).toEqual(["w"]);
    expect(s.items[0]!.status).toBe("open");
    expect(s.members[0]!.environmentId).toBeNull();
  });
  test("garbage is an empty state", () => {
    expect(normalize("nope")).toEqual(EMPTY);
    expect(normalize(null)).toEqual(EMPTY);
  });
});

describe("memberFor", () => {
  const members = [
    { id: "m1", name: "Coder", agentId: "a1", environmentId: null, vaultId: null, notes: "" },
    { id: "m2", name: "Coder+gh", agentId: "a1", environmentId: null, vaultId: "v1", notes: "" },
    { id: "m3", name: "Coder@prod", agentId: "a1", environmentId: "e2", vaultId: null, notes: "" },
  ];
  test("matches through the agent's default environment", () => {
    expect(memberFor(members, { agent_id: "a1", environment_id: "e1", vault_id: null }, "e1")?.id).toBe("m1");
    expect(memberFor(members, { agent_id: "a1", environment_id: "e1", vault_id: "v1" }, "e1")?.id).toBe("m2");
    expect(memberFor(members, { agent_id: "a1", environment_id: "e2", vault_id: null }, "e1")?.id).toBe("m3");
    expect(memberFor(members, { agent_id: "a9", environment_id: "e1", vault_id: null }, "e1")).toBeNull();
  });
});
