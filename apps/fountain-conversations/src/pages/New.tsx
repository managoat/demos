import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useStore } from "../store";
import { navigate, paths } from "../router";
import { describeError } from "../api/client";
import type { Agent, Environment, ImageInput, Vault } from "../api/types";
import { ImagePicker } from "../components/ImagePicker";

export function NewPage({ parentId }: { parentId?: string }) {
  const { client, toast, refresh } = useStore();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [agentId, setAgentId] = useState("");
  const [envId, setEnvId] = useState("");
  const [vaultId, setVaultId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<ImageInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([client.listAgents(), client.listEnvironments(), client.listVaults()])
      .then(([a, e, v]) => {
        if (cancelled) return;
        setAgents(a);
        setEnvs(e);
        setVaults(v);
        const preselected = sessionStorage.getItem("fountain-conversations.new-agent");
        sessionStorage.removeItem("fountain-conversations.new-agent");
        setAgentId(preselected && a.some((x) => x.id === preselected) ? preselected : a[0]?.id ?? "");
      })
      .catch((err) => !cancelled && setError(describeError(err)));
    return () => {
      cancelled = true;
    };
  }, [client]);

  const agent = agents?.find((a) => a.id === agentId) ?? null;
  const allowedEnvs = useMemo(
    () => (agent ? envs.filter((e) => allowed(e.id, agent.allowed_environment_ids, agent.environment_id)) : []),
    [agent, envs],
  );
  const ownEnv = allowedEnvs.find((e) => e.id === agent?.environment_id) ?? null;
  const otherEnvs = allowedEnvs.filter((e) => e.id !== agent?.environment_id);
  const allowedVaults = useMemo(() => (agent ? vaults.filter((v) => allowed(v.id, agent.allowed_vault_ids, null)) : []), [agent, vaults]);

  useEffect(() => {
    if (envId && !otherEnvs.some((e) => e.id === envId)) setEnvId("");
    if (vaultId && !allowedVaults.some((v) => v.id === vaultId)) setVaultId("");
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!agentId || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const conv = await client.startConversation({
        agent_id: agentId,
        prompt: prompt.trim(),
        ...(images.length ? { images } : {}),
        ...(envId ? { environment_id: envId } : {}),
        ...(vaultId ? { vault_id: vaultId } : {}),
        ...(parentId ? { parent_conversation_id: parentId } : {}),
      });
      toast("Conversation started");
      void refresh();
      navigate(paths.show(conv.id));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page narrow">
      <header className="page-header">
        <h1>New conversation</h1>
        <a href={paths.index} className="button secondary small">
          Cancel
        </a>
      </header>
      {agents && agents.length === 0 && (
        <div className="empty">
          <p>No agents defined yet.</p>
          <a href="#/agents/new">Create one</a>
        </div>
      )}
      {agents && agents.length > 0 && (
        <form className="card stack" onSubmit={submit}>
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
              <span className="hint">Provision from this environment instead of the agent's own; the conversation stays pinned to it.</span>
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
          <label>
            First prompt
            <textarea
              rows={6}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should the agent do?"
              autoFocus
              required
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  (e.currentTarget.form as HTMLFormElement).requestSubmit();
                }
              }}
            />
          </label>
          <ImagePicker images={images} onChange={setImages} />
          {parentId && (
            <div className="muted small">
              Sub-conversation of <span className="mono">{parentId.slice(0, 8)}</span>
            </div>
          )}
          {error && <div className="error">{error}</div>}
          <div className="row end">
            <span className="muted small">⌘/Ctrl+Enter to start</span>
            <button type="submit" disabled={busy || !agentId || !prompt.trim()}>
              {busy ? "Starting…" : "Start"}
            </button>
          </div>
        </form>
      )}
      {!agents && !error && <div className="muted">Loading…</div>}
      {!agents && error && <div className="error">{error}</div>}
    </div>
  );
}

function allowed(id: string, list: string[] | null, own: string | null): boolean {
  if (list === null) return true;
  if (id === own) return true;
  return list.includes(id);
}
