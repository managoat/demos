/**
 * What the egress broker does with this project's secrets — the replacement
 * config, read from the owner's side.
 *
 * On a brokered Fountain account (ADR 0019) a sandbox is handed placeholders,
 * not credentials, and may reach the internet only through the broker, which
 * puts the real value on the wire for the hosts a *binding* names. A secret
 * with an enabled binding is brokered; one with none goes into the sandbox in
 * the clear, as it always did. The bindings are account-wide — one row per
 * secret name and host, applying wherever an environment or vault holds that
 * name — so the question a project owner actually has is the join: of the
 * secrets on *this* project's environment and vault, which are brokered, to
 * where, and which are not.
 *
 * Owner only, and on `/api/…` rather than through the project proxy: a binding
 * names the owner's secrets and the hosts they go to, which is the owner's
 * configuration, not a fact about a conversation a member is reading. The
 * per-conversation record — what the sandbox actually reached — is the
 * member-visible half, and it goes through the proxy (`server/proxy.ts`).
 *
 * Names only, throughout: Fountain's secrets API never returns a value, and
 * this answer carries nothing that came from one.
 */
import { authenticate, ownerClient, projectAccess, requireOwner, type AppContext } from "./context";
import type { FountainClient, SecretBinding } from "./fountain";
import { json } from "./http";

/** Where a project's secret comes from. A name in both is one secret to the sandbox — the vault's. */
export type SecretSource = "environment" | "vault" | "both";

export interface ProjectSecret {
  key: string;
  source: SecretSource;
  /** The enabled bindings for this name: the hosts it goes to. Empty means it reaches the sandbox in the clear. */
  hosts: string[];
}

export interface BrokeringDto {
  /** Whether the broker is on for the owner's account at all. Everything below is empty when it is not. */
  enabled: boolean;
  /** Every binding on the account, enabled or not, so the config is readable whole. */
  bindings: SecretBinding[];
  /** The project's secrets by name, each with the hosts its bindings send it to. */
  secrets: ProjectSecret[];
  /** Whether the project's environment / vault could be read; false is "unset or gone", and its secrets are simply absent. */
  environment: boolean;
  vault: boolean;
}

/**
 * The join. Two catalog names, `GITHUB_TOKEN` and `GH_TOKEN`, are brokered
 * to GitHub even with no binding of their own (Fountain's catalog default);
 * they read here as bound to the two hosts the catalog names, so the page
 * does not call a brokered secret clear.
 */
const CATALOG: Record<string, string[]> = { GITHUB_TOKEN: ["api.github.com", "github.com"], GH_TOKEN: ["api.github.com", "github.com"] };

export function joinSecrets(bindings: SecretBinding[], envKeys: string[], vaultKeys: string[]): ProjectSecret[] {
  const byKey = new Map<string, string[]>();
  for (const b of bindings) {
    if (!b.enabled) continue;
    byKey.set(b.key, [...(byKey.get(b.key) ?? []), b.host]);
  }
  const sources = new Map<string, SecretSource>();
  for (const k of envKeys) sources.set(k, "environment");
  for (const k of vaultKeys) sources.set(k, sources.has(k) ? "both" : "vault");
  return [...sources]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, source]) => ({ key, source, hosts: byKey.get(key) ?? CATALOG[key] ?? [] }));
}

async function keysOf(client: FountainClient, parent: "environments" | "vaults", id: string | null): Promise<string[] | null> {
  if (!id) return null;
  return client.secretKeys(parent, id);
}

export async function show(ctx: AppContext, req: Request, projectId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { project, role } = projectAccess(ctx, user, projectId);
  requireOwner(role);
  const client = await ownerClient(ctx, project);
  const bindings = await client.secretBindings();
  if (bindings === null) {
    const off: BrokeringDto = { enabled: false, bindings: [], secrets: [], environment: false, vault: false };
    return json({ data: off });
  }
  const [envKeys, vaultKeys] = await Promise.all([keysOf(client, "environments", project.environment_id), keysOf(client, "vaults", project.vault_id)]);
  const dto: BrokeringDto = {
    enabled: true,
    bindings: [...bindings].sort((a, b) => a.key.localeCompare(b.key) || a.host.localeCompare(b.host)),
    secrets: joinSecrets(bindings, envKeys ?? [], vaultKeys ?? []),
    environment: envKeys !== null,
    vault: vaultKeys !== null,
  };
  return json({ data: dto });
}
