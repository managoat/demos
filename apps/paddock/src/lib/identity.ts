/**
 * One agent, one environment, one vault **per computer** — found if they
 * exist, made once if they do not, and never replaced.
 *
 * This is the load-bearing decision of the whole app. Sandbox identity is
 * `(user, agent, environment, vault)` *by id*, so as long as those three ids
 * never move, every conversation opened on that computer can attach to the
 * same machine, and no configuration change can take the machine away. Every
 * setting paddock offers is therefore a mutation of one of these three
 * records, never a new one.
 *
 * The same fact is what makes a second computer a second computer rather than
 * a second tab: a different agent is a different identity is a different box.
 * So each paddock gets its own trio, and the agent's metadata says which
 * paddock it belongs to (`workspace`). Nothing else could say it — the three
 * records are indistinguishable otherwise, and picking the wrong one would
 * point a person's browser at somebody's other machine.
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
 * everyone. Paddock picks, and the Details panel says what was picked and what
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

/**
 * Which computer this machine belongs to.
 *
 *   - a string  — the paddock named in `metadata.paddock.workspace`;
 *   - `null`    — paddock's agent, from before an account could have two;
 *   - `undefined` — not paddock's agent at all.
 *
 * Marked in metadata rather than matched by name, because a name is something
 * a person can change in Fountain and this is not a question they should be
 * able to answer wrongly by accident.
 */
export function agentWorkspace(a: Pick<Agent, "metadata">): string | null | undefined {
  const mine = (a.metadata ?? {})[METADATA_KEY];
  if (!mine || typeof mine !== "object" || Array.isArray(mine)) return undefined;
  const meta = mine as { identity?: unknown; workspace?: unknown };
  if (meta.identity !== true) return undefined;
  return typeof meta.workspace === "string" && meta.workspace ? meta.workspace : null;
}

/** Is this an agent paddock made, for any computer? */
export function isPaddockAgent(a: Pick<Agent, "metadata">): boolean {
  return agentWorkspace(a) !== undefined;
}

/** Which computer is being opened, and whether it is the account's first. */
export interface Place {
  paddockId: string;
  /**
   * The oldest computer this account owns. It is the only one allowed to claim
   * an agent that names no computer, because such an agent predates there
   * being a choice — and it was this machine. The server decides it, once, in
   * `db.paddocksFor`; nothing here re-derives it.
   */
  original: boolean;
}

/**
 * This computer's paddock identity, made the first time it is opened.
 *
 * Order matters: the environment and vault exist before the agent, because the
 * agent is created already pointing at them. An agent that had to be updated
 * to point at them afterwards would be an agent whose identity changed between
 * its creation and its first machine.
 */
export async function ensureIdentity(
  client: FountainClient,
  choice: { runtime: string; model: string },
  place: Place,
  onStep: (step: BootStep) => void = () => {},
): Promise<Identity> {
  const agents = await client.listAgents();
  // Sorted, not `.find`. If two paddock agents exist for one computer — which
  // a double-render once managed to create — every caller has to pick the
  // *same* one, or the app holds one identity while its machine belongs to the
  // other and nothing matches. Id order is arbitrary but stable, which is the
  // whole requirement.
  const byId = (a: Agent, b: Agent) => a.id.localeCompare(b.id);
  const mine = agents.filter((a) => agentWorkspace(a) === place.paddockId).sort(byId)[0];
  // An agent from before computers had names belongs to the machine this
  // account already had. Adopting it is what stops the second computer feature
  // costing every existing user their box.
  const inherited = !mine && place.original ? agents.filter((a) => agentWorkspace(a) === null).sort(byId)[0] : undefined;
  const existing = mine ?? inherited;

  if (existing) {
    // Nothing is being built on a return visit, so the first-run screen — if
    // it shows at all — should not claim to be fencing a paddock that has
    // stood for weeks.
    onStep("machine");
    const [agent, environment, vault] = await Promise.all([
      inherited ? stamp(client, inherited, place.paddockId) : Promise.resolve(existing),
      existing.environment_id ? client.getEnvironment(existing.environment_id) : ensureEnvironment(client, place),
      findVault(client, existing.vault_id ?? null),
    ]);
    return { agent, environment, vault };
  }

  onStep("environment");
  const environment = await ensureEnvironment(client, place);
  onStep("vault");
  const vault = await ensureVault(client, place);
  onStep("agent");
  const agent = await client.createAgent({
    name: identityName(place),
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
    metadata: withRev({ [METADATA_KEY]: { identity: true, workspace: place.paddockId } }, 1),
  });
  return { agent, environment, vault };
}

/**
 * Write the computer's id onto an agent that predates them, so the question is
 * only ever asked once. A Fountain that refuses the write is not fatal: the
 * adoption rule above still finds the same agent next time, for as long as
 * this stays the account's original computer.
 */
async function stamp(client: FountainClient, agent: Agent, paddockId: string): Promise<Agent> {
  const meta = (agent.metadata ?? {})[METADATA_KEY];
  const kept = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
  return client
    .updateAgent(agent.id, { metadata: { ...(agent.metadata ?? {}), [METADATA_KEY]: { ...kept, workspace: paddockId } } })
    .catch(() => agent);
}

/**
 * What the three records are called in Fountain's own lists.
 *
 * The original computer keeps the bare name it has always had — renaming
 * somebody's records is not this feature's business — and every computer after
 * it carries its paddock id, because two records called `Paddock` in one
 * account is a list nobody can read.
 */
function identityName(place: Place): string {
  return place.original ? IDENTITY_NAME : `${IDENTITY_NAME} ${place.paddockId}`;
}

async function ensureEnvironment(client: FountainClient, place: Place): Promise<Environment> {
  const name = identityName(place);
  const found = (await client.listEnvironments()).find((e) => e.name === name);
  if (found) return found;
  // Deliberately empty: a first box is a bare machine, and everything on it
  // afterwards arrives through the Setup panel where it can be seen.
  return client.createEnvironment({ name, repositories: [], packages: {}, setup_script: "" });
}

async function ensureVault(client: FountainClient, place: Place): Promise<Vault | null> {
  const name = identityName(place);
  try {
    const found = (await client.listVaults()).find((v) => v.name === name);
    return found ?? (await client.createVault({ name }));
  } catch (err) {
    // A Fountain without vaults, or a key without the scope. Not fatal: the
    // machine works, and the Setup panel says vault secrets are unavailable.
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
