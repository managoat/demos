/**
 * Which agent a computer is on.
 *
 * This is the one question in the app whose wrong answer is expensive: an
 * agent is a sandbox identity, so picking the wrong one hands somebody a
 * different machine, and picking none where one exists builds a *new* machine
 * and abandons theirs. Both look like "my box is gone".
 */
import { describe, expect, test } from "bun:test";
import type { FountainClient } from "../api/client";
import type { Agent, Environment, Vault } from "../api/types";
import { agentWorkspace, ensureIdentity } from "./identity";

function agent(over: Partial<Agent> & { id: string }): Agent {
  return {
    name: "Paddock",
    model: "claude-opus-5",
    runtime: "claude",
    description: null,
    system: null,
    environment_id: "e1",
    vault_id: "v1",
    sandbox_mode: "persistent",
    metadata: {},
    ...over,
  } as Agent;
}

/** An agent paddock made, on the computer given (or none, for an old one). */
function paddockAgent(id: string, workspace?: string): Agent {
  return agent({ id, metadata: { paddock: { identity: true, rev: 1, ...(workspace ? { workspace } : {}) } } });
}

/**
 * Just enough Fountain to answer `ensureIdentity`, recording what it was asked
 * to create — which is the assertion that matters, because creating is what
 * costs somebody a machine.
 */
function fakeClient(agents: Agent[]) {
  const made: string[] = [];
  let next = agents.length;
  const client = {
    listAgents: async () => agents,
    listEnvironments: async () => [] as Environment[],
    listVaults: async () => [] as Vault[],
    getEnvironment: async (id: string) => ({ id, name: "Paddock", repositories: [], packages: {}, setup_script: "" }) as Environment,
    createEnvironment: async (input: { name: string }) => {
      made.push(`environment:${input.name}`);
      return { id: `e${++next}`, name: input.name, repositories: [], packages: {}, setup_script: "" } as Environment;
    },
    createVault: async (input: { name: string }) => {
      made.push(`vault:${input.name}`);
      return { id: `v${next}`, name: input.name } as Vault;
    },
    createAgent: async (input: Record<string, unknown>) => {
      made.push(`agent:${String(input.name)}`);
      const created = agent({ id: `a${next}`, name: String(input.name), metadata: input.metadata as Record<string, unknown> });
      agents.push(created);
      return created;
    },
    updateAgent: async (id: string, patch: Partial<Agent>) => {
      const found = agents.find((a) => a.id === id)!;
      Object.assign(found, patch);
      made.push(`stamp:${id}`);
      return found;
    },
  };
  return { client: client as unknown as FountainClient, made };
}

describe("agentWorkspace", () => {
  test("tells apart ours-on-this-computer, ours-from-before, and not ours", () => {
    expect(agentWorkspace(paddockAgent("a1", "pdk-1"))).toBe("pdk-1");
    expect(agentWorkspace(paddockAgent("a1"))).toBeNull();
    expect(agentWorkspace(agent({ id: "a2" }))).toBeUndefined();
    // Somebody else's agent that happens to carry a `paddock` key.
    expect(agentWorkspace(agent({ id: "a3", metadata: { paddock: { identity: false } } }))).toBeUndefined();
    expect(agentWorkspace(agent({ id: "a4", metadata: { paddock: "yes" } }))).toBeUndefined();
  });
});

describe("finding this computer's machine", () => {
  test("an agent marked with this computer is used as it stands", async () => {
    const { client, made } = fakeClient([paddockAgent("a1", "pdk-1")]);
    const identity = await ensureIdentity(client, { runtime: "claude", model: "m" }, { paddockId: "pdk-1", original: true });
    expect(identity.agent.id).toBe("a1");
    expect(made).toEqual([]);
  });

  test("the original computer adopts an agent from before computers, and stamps it", async () => {
    // The migration, from the browser's side. Getting this wrong builds a
    // second machine and silently abandons the one somebody has been using.
    const { client, made } = fakeClient([paddockAgent("a1")]);
    const identity = await ensureIdentity(client, { runtime: "claude", model: "m" }, { paddockId: "pdk-1", original: true });
    expect(identity.agent.id).toBe("a1");
    expect(made).toEqual(["stamp:a1"]);
    expect(agentWorkspace(identity.agent)).toBe("pdk-1");
  });

  test("a computer that is not the original never adopts one, and builds its own", async () => {
    const { client, made } = fakeClient([paddockAgent("a1")]);
    const identity = await ensureIdentity(client, { runtime: "claude", model: "m" }, { paddockId: "pdk-2", original: false });
    expect(identity.agent.id).not.toBe("a1");
    // Its own environment and vault too: two computers sharing an environment
    // would mean adding a package to one added it to the other.
    expect(made).toEqual(["environment:Paddock pdk-2", "vault:Paddock pdk-2", "agent:Paddock pdk-2"]);
    expect(agentWorkspace(identity.agent)).toBe("pdk-2");
  });

  test("another computer's agent is not this one's, however old the account is", async () => {
    const { client, made } = fakeClient([paddockAgent("a1", "pdk-1")]);
    const identity = await ensureIdentity(client, { runtime: "claude", model: "m" }, { paddockId: "pdk-2", original: false });
    expect(identity.agent.id).not.toBe("a1");
    expect(made).toContain("agent:Paddock pdk-2");
  });

  test("two agents on one computer resolve to the same one every time", async () => {
    // A double-render once made two. Whichever is picked, every caller has to
    // pick the same, or the app holds one identity and the box belongs to the
    // other. Id order is arbitrary but stable, which is the whole requirement.
    const first = await ensureIdentity(
      fakeClient([paddockAgent("a2", "pdk-1"), paddockAgent("a1", "pdk-1")]).client,
      { runtime: "claude", model: "m" },
      { paddockId: "pdk-1", original: true },
    );
    const second = await ensureIdentity(
      fakeClient([paddockAgent("a1", "pdk-1"), paddockAgent("a2", "pdk-1")]).client,
      { runtime: "claude", model: "m" },
      { paddockId: "pdk-1", original: true },
    );
    expect(first.agent.id).toBe(second.agent.id);
  });

  test("a marked agent wins over an unmarked one, so adopting never overrides", async () => {
    const { client, made } = fakeClient([paddockAgent("a1"), paddockAgent("a2", "pdk-1")]);
    const identity = await ensureIdentity(client, { runtime: "claude", model: "m" }, { paddockId: "pdk-1", original: true });
    expect(identity.agent.id).toBe("a2");
    expect(made).toEqual([]);
  });
});
