/**
 * "+" adds a teammate with no questions asked (Grok Bot / OpenMausBot): a
 * name from the list, the default brain (Claude Sonnet when the account can
 * run it), no persona yet, a generated avatar that arrives after the fact.
 * Everything is changeable afterwards — rename in the header, brain and
 * "what they do" in the profile — so the add itself has nothing to ask.
 */
import type { FountainClient } from "../api/client";
import { brainsFrom, defaultBrain, personaPrompt, type Brain, type Catalog } from "./brain";
import { pickName } from "./names";

export interface InstantPlan {
  name: string;
  brain: Brain;
  system: string;
}

/** Pure: what the instant add will create, given the catalog, credentials and names in use. */
export function planInstantTeammate(catalog: Catalog, credentials: Record<string, boolean>, takenNames: Iterable<string>, random: () => number = Math.random): InstantPlan | null {
  const brain = defaultBrain(brainsFrom(catalog, credentials));
  if (!brain) return null;
  const name = pickName(takenNames, random);
  return { name, brain, system: personaPrompt(name, "") };
}

/**
 * Create the agent and put it on the team; resolve with the agent id as
 * soon as the teammate exists. The avatar is generated and attached in the
 * background — the roster picks it up on the next re-list — so a slow image
 * model never stands between the click and the teammate.
 */
export async function addInstantTeammate(client: FountainClient, opts: { onAvatar?: () => void } = {}): Promise<{ agentId: string; name: string }> {
  const [catalog, credentials, agents] = await Promise.all([
    client.getCatalog(),
    client.inferenceCredentials().catch(() => ({}) as Record<string, boolean>),
    client.listAgents().catch(() => []),
  ]);
  const plan = planInstantTeammate(catalog, credentials, agents.map((a) => a.name));
  if (!plan) throw new Error("The catalog lists no models to run a teammate on.");
  const agent = await client.createAgent({ name: plan.name, model: plan.brain.model, runtime: plan.brain.runtime, description: "", system: plan.system });
  const teammate = await client.addTeammate({ agent_id: agent.id, name: plan.name });
  // background: a face
  const bases = catalog.avatar?.bases ?? [];
  const moods = catalog.avatar?.moods ?? [];
  if (bases.length && moods.length) {
    void client
      .generateAvatar(bases[Math.floor(Math.random() * bases.length)]!, moods[Math.floor(Math.random() * moods.length)]!)
      .then((a) => client.putAvatar(agent.id, a.data, a.media_type))
      .then(() => opts.onAvatar?.())
      .catch(() => undefined); // no OpenAI key, or the generator is down: initials are fine
  }
  return { agentId: teammate.agent_id, name: plan.name };
}
