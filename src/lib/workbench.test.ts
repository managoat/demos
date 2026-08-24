import { describe, expect, test } from "bun:test";
import { agentFits, normalizeLegacy } from "./workbench";

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
