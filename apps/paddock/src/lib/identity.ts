/**
 * One agent, one environment, one vault — found if they exist, made once if
 * they do not, and never replaced.
 *
 * This is the load-bearing decision of the whole app. Sandbox identity is
 * `(user, agent, environment, vault)` *by id*, so as long as those three ids
 * never move, every conversation this account opens can attach to the same
 * machine, and no configuration change can take the machine away. Every
 * setting paddock offers is therefore a mutation of one of these three
 * records, never a new one.
 *
 * The vault is created up front even though nothing needs it yet, precisely
 * because attaching one later would change the identity and cost the user
 * their box. A Fountain that will not make vaults is fine — paddock records
 * that and offers environment secrets only — but it must be settled at boot,
 * once, rather than the first time somebody adds a secret.
 */
import type { FountainClient } from "../api/client";
import { ApiError } from "../api/client";
import type { Agent, Environment, Vault } from "../api/types";
import { METADATA_KEY, withRev } from "./machine";
import { systemPrompt } from "../../shared/spec";

/** The name all three records carry, and the marker on the agent. */
export const IDENTITY_NAME = "Paddock";

/**
 * What a machine is, unless the Fountain it runs on cannot offer it.
 *
 * Not a question the app asks. Runtime is the one thing baked into the disk,
 * so it looked like it deserved a form — but a form on first run is a form
 * between somebody and the thing they came for, answered identically by
 * everyone. Paddock picks, and the Machine panel says what was picked and what
 * changing it would cost.
 */
export const DEFAULT_RUNTIME = "claude";
export const DEFAULT_MODEL = "claude-opus-5";

/** The steps of first run, in order, so a person can watch it happen. */
export type BootStep = "environment" | "vault" | "agent" | "machine" | "waking";

/**
 * The defaults, reconciled with what this Fountain actually has. A deployment
 * without our preferred model should still get a machine rather than an error
 * about a model nobody asked for.
 */
export function defaultChoice(catalog: { runtimes?: string[]; models?: Record<string, string[]> } | null): { runtime: string; model: string } {
  const runtimes = catalog?.runtimes ?? [];
  const runtime = runtimes.includes(DEFAULT_RUNTIME) ? DEFAULT_RUNTIME : (runtimes[0] ?? DEFAULT_RUNTIME);
  const models = catalog?.models?.[runtime] ?? [];
  if (models.includes(DEFAULT_MODEL)) return { runtime, model: DEFAULT_MODEL };
  const opus = models.find((m) => m.includes("opus"));
  return { runtime, model: opus ?? models[0] ?? DEFAULT_MODEL };
}

export interface Identity {
  agent: Agent;
  environment: Environment;
  /** Null where this Fountain does not do vaults; vault secrets are then unavailable. */
  vault: Vault | null;
}

/** Is this the agent paddock made? Marked in metadata, not matched by name. */
export function isPaddockAgent(a: Pick<Agent, "metadata">): boolean {
  const mine = (a.metadata ?? {})[METADATA_KEY];
  return !!mine && typeof mine === "object" && !Array.isArray(mine) && (mine as { identity?: unknown }).identity === true;
}

/**
 * The account's paddock identity, made on first run.
 *
 * Order matters: the environment and vault exist before the agent, because the
 * agent is created already pointing at them. An agent that had to be updated
 * to point at them afterwards would be an agent whose identity changed between
 * its creation and its first machine.
 */
export async function ensureIdentity(
  client: FountainClient,
  choice: { runtime: string; model: string },
  onStep: (step: BootStep) => void = () => {},
): Promise<Identity> {
  // Sorted, not `.find`. If two paddock agents exist — which a double-render
  // once managed to create — every caller has to pick the *same* one, or the
  // app holds one identity while its machine belongs to the other and nothing
  // matches. Id order is arbitrary but stable, which is the whole requirement.
  const existing = (await client.listAgents()).filter(isPaddockAgent).sort((a, b) => a.id.localeCompare(b.id))[0];
  if (existing) {
    // Nothing is being built on a return visit, so the first-run screen — if
    // it shows at all — should not claim to be fencing a paddock that has
    // stood for weeks.
    onStep("machine");
    const [environment, vault] = await Promise.all([
      existing.environment_id ? client.getEnvironment(existing.environment_id) : ensureEnvironment(client),
      findVault(client, existing.vault_id ?? null),
    ]);
    return { agent: existing, environment, vault };
  }

  onStep("environment");
  const environment = await ensureEnvironment(client);
  onStep("vault");
  const vault = await ensureVault(client);
  onStep("agent");
  const agent = await client.createAgent({
    name: IDENTITY_NAME,
    model: choice.model,
    runtime: choice.runtime,
    // The identity's own default, so every conversation on it — the first one
    // and every tab after — gets the same home without having to say so.
    // fountain-conversations only sends `sandbox_mode` on a conversation when
    // it *differs* from the agent's default; declaring it here is what makes
    // that default right.
    sandbox_mode: "persistent",
    description: "The agent that lives on your Paddock machine.",
    system: systemPrompt(),
    environment_id: environment.id,
    ...(vault ? { vault_id: vault.id } : {}),
    metadata: withRev({ [METADATA_KEY]: { identity: true } }, 1),
  });
  return { agent, environment, vault };
}

async function ensureEnvironment(client: FountainClient): Promise<Environment> {
  const found = (await client.listEnvironments()).find((e) => e.name === IDENTITY_NAME);
  if (found) return found;
  // Deliberately empty: a first box is a bare machine, and everything on it
  // afterwards arrives through the Machine panel where it can be seen.
  return client.createEnvironment({ name: IDENTITY_NAME, repositories: [], packages: {}, setup_script: "" });
}

async function ensureVault(client: FountainClient): Promise<Vault | null> {
  try {
    const found = (await client.listVaults()).find((v) => v.name === IDENTITY_NAME);
    return found ?? (await client.createVault({ name: IDENTITY_NAME }));
  } catch (err) {
    // A Fountain without vaults, or a key without the scope. Not fatal: the
    // machine works, and the Machine panel says vault secrets are unavailable.
    if (err instanceof ApiError && (err.status === 403 || err.status === 404 || err.status === 501)) return null;
    throw err;
  }
}

async function findVault(client: FountainClient, id: string | null): Promise<Vault | null> {
  if (!id) return null;
  try {
    return (await client.listVaults()).find((v) => v.id === id) ?? null;
  } catch {
    return null;
  }
}
