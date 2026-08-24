import { useStore } from "../store";

/** The two selects that make a project a computer: environment and vault. */
export function EnvVaultFields({ environmentId, vaultId, onEnvironment, onVault }: { environmentId: string; vaultId: string; onEnvironment: (id: string) => void; onVault: (id: string) => void }) {
  const { environments, vaults, resourcesLoaded } = useStore();
  const envs = [...environments.values()].sort((a, b) => a.name.localeCompare(b.name));
  const vs = [...vaults.values()].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="grid2">
      <label>
        Environment <span className="hint">Packages, repos, baseline env vars. Every conversation in the project provisions from it.</span>
        <select value={environmentId} onChange={(e) => onEnvironment(e.target.value)} disabled={!resourcesLoaded}>
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
        <select value={vaultId} onChange={(e) => onVault(e.target.value)} disabled={!resourcesLoaded}>
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
