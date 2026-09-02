import { describe, expect, test } from "bun:test";
import { addInstantTeammate, planInstantTeammate } from "./instant";
import type { FountainClient } from "../api/client";

const catalog = { runtimes: ["claude", "codex", "opencode"], models: { claude: ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"], codex: ["openai/gpt-5"] } };

describe("instant add", () => {
  test("a name not in use, the default brain, a system prompt that names them", () => {
    const plan = planInstantTeammate(catalog, { anthropic_api_key: true }, ["Scout"], () => 0)!;
    expect(plan.name).not.toBe("Scout");
    expect(plan.brain.model).toBe("anthropic/claude-sonnet-5");
    expect(plan.brain.runtime).toBe("claude");
    expect(plan.system).toContain(`You are ${plan.name}`);
  });
  test("falls to a provider with a key", () => {
    expect(planInstantTeammate(catalog, { openai_api_key: true }, [])!.brain.model).toBe("openai/gpt-5");
  });
  test("no models → null", () => {
    expect(planInstantTeammate({ runtimes: [], models: {} }, {}, [])).toBeNull();
  });

  // A new teammate must arrive with an empty policy, which Fountain reads as
  // "let them run it". Sending `ask` here would put every new teammate behind
  // a prompt whose "always" the runtimes do not honour (fountain#996), and the
  // app no longer offers a way to turn it back off. Asserting on the payload
  // rather than the type so that widening `createAgent` cannot quietly do it.
  test("a new teammate is created with no permission policy at all", async () => {
    const sent: Record<string, unknown>[] = [];
    const client = {
      getCatalog: async () => catalog,
      inferenceCredentials: async () => ({ anthropic_api_key: true }),
      listAgents: async () => [],
      createAgent: async (input: Record<string, unknown>) => {
        sent.push(input);
        return { id: "a1", name: String(input.name) };
      },
      addTeammate: async () => ({}),
    } as unknown as FountainClient;

    await addInstantTeammate(client);

    expect(sent).toHaveLength(1);
    expect(Object.keys(sent[0]!)).not.toContain("permission_policy");
  });
});
