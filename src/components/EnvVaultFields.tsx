import type { Environment, Vault } from "../types";

/** The two selects that make a project a computer: environment and vault. The lists come from whichever Fountain view the caller has — their own, or a project's. */
export function EnvVaultFields({
  environments,
  vaults,
  loaded,
  environmentId,
  vaultId,
  onEnvironment,
  onVault,
}: {
  environments: Iterable<Environment>;
  vaults: Iterable<Vault>;
  loaded: boolean;
  environmentId: string;
  vaultId: string;
  onEnvironment: (id: string) => void;
  onVault: (id: string) => void;
}) {
  const envs = [...environments].sort((a, b) => a.name.localeCompare(b.name));
  const vs = [...vaults].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="grid2">
      <label>
        Environment <span className="hint">Packages, repos, baseline env vars. Every conversation in the project provisions from it.</span>
        <select value={environmentId} onChange={(e) => onEnvironment(e.target.value)} disabled={!loaded}>
          <option value="">Each agent's own</option>
          {envs.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Vault <span className="hint">Secrets that win over the environment's on a key collision.</span>
        <select value={vaultId} onChange={(e) => onVault(e.target.value)} disabled={!loaded}>
          <option value="">None</option>
          {vs.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
