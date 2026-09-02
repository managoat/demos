import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Agent, Environment, Vault } from "../api/types";
import { describeError, type FountainClient } from "../api/client";

interface Props {
  client: FountainClient;
  onTeam: Set<string>;
  onAdded: (agentId: string) => void;
  onClose: () => void;
}

/**
 * The advanced add: an agent you built in Fountain — with its skills, MCP
 * servers, environment and vault — as a teammate. The everyday add is the
 * "+" button, which asks nothing (lib/instant.ts).
 */
export function AddDialog({ client, onTeam, onAdded, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-root">
      <div className="backdrop" onClick={onClose} aria-hidden="true" />
      <div className="modal add" role="dialog" aria-modal="true" aria-labelledby="add-title">
        <header>
          <h2 id="add-title">Add an agent you already have</h2>
          <button className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <ExistingAgent client={client} onTeam={onTeam} onAdded={onAdded} onClose={onClose} />
      </div>
    </div>
  );
}

// ── the tuned path: an agent that already exists ────────────────────────────

function ExistingAgent({ client, onTeam, onAdded, onClose }: Props) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [name, setName] = useState("");
  const [envId, setEnvId] = useState("");
  const [vaultId, setVaultId] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([client.listAgents(), client.listEnvironments(), client.listVaults()])
      .then(([a, e, v]) => {
        if (cancelled) return;
        const addable = a.filter((x) => !onTeam.has(x.id));
        setAgents(addable);
        setEnvs(e);
        setVaults(v);
        setAgentId(addable[0]?.id ?? "");
      })
      .catch((err) => !cancelled && setError(describeError(err)));
    return () => {
      cancelled = true;
    };
  }, [client, onTeam]);

  const agent = agents?.find((a) => a.id === agentId) ?? null;

  const allowedEnvs = useMemo(() => {
    if (!agent) return [];
    return envs.filter((e) => allowed(e.id, agent.allowed_environment_ids, agent.environment_id));
  }, [agent, envs]);
  const ownEnv = allowedEnvs.find((e) => e.id === agent?.environment_id) ?? null;
  const otherEnvs = allowedEnvs.filter((e) => e.id !== agent?.environment_id);
  const allowedVaults = useMemo(() => {
    if (!agent) return [];
    return vaults.filter((v) => allowed(v.id, agent.allowed_vault_ids, null));
  }, [agent, vaults]);

  useEffect(() => {
    if (envId && !otherEnvs.some((e) => e.id === envId)) setEnvId("");
    if (vaultId && !allowedVaults.some((v) => v.id === vaultId)) setVaultId("");
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!agentId) return;
    setBusy(true);
    setError(null);
    try {
      const t = await client.addTeammate({
        agent_id: agentId,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(envId ? { environment_id: envId } : {}),
        ...(vaultId ? { vault_id: vaultId } : {}),
      });
      onAdded(t.agent_id);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="muted small">An agent you built in Fountain — with its skills, MCP servers and environment — as a teammate. For a fresh one, just press + in the roster.</p>
      {agents === null && !error && <div className="muted">Loading…</div>}
      {agents && agents.length === 0 && (
        <div className="muted">
          Every agent you have is already on the team.{" "}
          <a href={`${client.baseUrl}/agents/new`} target="_blank" rel="noreferrer">
            Create another in Fountain
          </a>
        </div>
      )}
      {agents && agents.length > 0 && (
        <form onSubmit={submit} className="stack">
          <label>
            Agent
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.runtime} · {a.model})
                </option>
              ))}
            </select>
          </label>
          <label>
            Name <span className="muted">(optional)</span>
            <input type="text" value={name} maxLength={120} placeholder={agent?.name ?? "Teammate"} onChange={(e) => setName(e.target.value)} autoComplete="off" />
            <span className="hint">How they show up on the team. Blank uses the agent's name.</span>
          </label>
          {otherEnvs.length > 0 && (
            <label>
              Environment
              <select value={envId} onChange={(e) => setEnvId(e.target.value)}>
                <option value="">{ownEnv ? `Agent's default (${ownEnv.name})` : "Agent's default"}</option>
                {otherEnvs.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
              <span className="hint">Their computer is set up from this environment instead of the agent's own.</span>
            </label>
          )}
          {allowedVaults.length > 0 && (
            <label>
              Vault <span className="muted">(optional)</span>
              <select value={vaultId} onChange={(e) => setVaultId(e.target.value)}>
                <option value="">— none —</option>
                {allowedVaults.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
              <span className="hint">Layered on top of the environment's secrets. Vault values win on key collision.</span>
            </label>
          )}
          {error && <div className="error">{error}</div>}
          <div className="row end">
            <button type="button" className="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" disabled={busy || !agentId}>
              {busy ? "Adding…" : "Add to team"}
            </button>
          </div>
        </form>
      )}
      {agents === null && error && <div className="error">{error}</div>}
    </>
  );
}

function allowed(id: string, list: string[] | null, own: string | null): boolean {
  if (list === null) return true;
  if (id === own) return true;
  return list.includes(id);
}
