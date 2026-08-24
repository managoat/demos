import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useStore } from "../store";
import { navigate, paths } from "../router";
import { describeError } from "../api/client";
import type { Agent, Environment, ImageInput, SandboxDetail, SandboxMode, Vault } from "../api/types";
import { ImagePicker } from "../components/ImagePicker";

const ATTACHABLE = new Set(["ready", "suspended"]);

export function NewPage({ parentId, sandboxId }: { parentId?: string; sandboxId?: string }) {
  const { client, toast, refresh } = useStore();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [vaults, setVaults] = useState<Vault[]>([]);
  // The machine to attach to (`?sandbox=`): it fixes the agent, environment
  // and vault, since a launch must match the identity the disk was built for.
  const [sandbox, setSandbox] = useState<SandboxDetail | null>(null);
  const [agentId, setAgentId] = useState("");
  const [envId, setEnvId] = useState("");
  const [vaultId, setVaultId] = useState("");
  const [mode, setMode] = useState<SandboxMode | "">("");
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<ImageInput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([client.listAgents(), client.listEnvironments(), client.listVaults(), sandboxId ? client.getSandbox(sandboxId) : null])
      .then(([a, e, v, s]) => {
        if (cancelled) return;
        setAgents(a);
        setEnvs(e);
        setVaults(v);
        setSandbox(s);
        const preselected = sessionStorage.getItem("fountain-conversations.new-agent");
        sessionStorage.removeItem("fountain-conversations.new-agent");
        if (s) {
          setAgentId(s.agent_id ?? "");
          const own = a.find((x) => x.id === s.agent_id)?.environment_id ?? null;
          setEnvId(s.environment_id && s.environment_id !== own ? s.environment_id : "");
          setVaultId(s.vault_id ?? "");
        } else {
          setAgentId(preselected && a.some((x) => x.id === preselected) ? preselected : a[0]?.id ?? "");
        }
      })
      .catch((err) => !cancelled && setError(describeError(err)));
    return () => {
      cancelled = true;
    };
  }, [client, sandboxId]);

  const agent = agents?.find((a) => a.id === agentId) ?? null;
  const allowedEnvs = useMemo(
    () => (agent ? envs.filter((e) => allowed(e.id, agent.allowed_environment_ids, agent.environment_id)) : []),
    [agent, envs],
  );
  const ownEnv = allowedEnvs.find((e) => e.id === agent?.environment_id) ?? null;
  const otherEnvs = allowedEnvs.filter((e) => e.id !== agent?.environment_id);
  const allowedVaults = useMemo(() => (agent ? vaults.filter((v) => allowed(v.id, agent.allowed_vault_ids, null)) : []), [agent, vaults]);
  const defaultMode = agent?.sandbox_mode ?? null;

  useEffect(() => {
    if (sandbox) return;
    if (envId && !otherEnvs.some((e) => e.id === envId)) setEnvId("");
    if (vaultId && !allowedVaults.some((v) => v.id === vaultId)) setVaultId("");
    setMode(defaultMode ?? "");
  }, [agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const attachable = !sandbox || ATTACHABLE.has(sandbox.status);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!agentId || !prompt.trim() || !attachable) return;
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
        ...(sandbox ? { sandbox_id: sandbox.id } : {}),
        // Only an override travels; the agent's own default stays implicit.
        ...(!sandbox && mode && defaultMode && mode !== defaultMode ? { sandbox_mode: mode } : {}),
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
        <h1>{sandbox ? "New conversation here" : "New conversation"}</h1>
        <a href={sandbox ? paths.sandbox(sandbox.id) : paths.index} className="button secondary small">
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
          {sandbox && (
            <div className="field">
              <span className="field-label">Machine</span>
              <div>
                <a href={paths.sandbox(sandbox.id)} className="mono">
                  {sandbox.sprite_name}
                </a>{" "}
                <span className={`pill ${sandbox.status}`}>{sandbox.status}</span>
                {sandbox.mode === "persistent" && <span className="home-badge static">⌂ home</span>}
              </div>
              <span className="hint">
                The conversation opens on this machine's disk, beside the {sandbox.conversations.length} already there; agent, environment and
                vault are the ones it was built for.
              </span>
              {!attachable && <div className="error">Only a ready or suspended machine takes a new conversation — this one is {sandbox.status}.</div>}
            </div>
          )}
          <label>
            Agent
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={!!sandbox}>
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
              <select value={envId} onChange={(e) => setEnvId(e.target.value)} disabled={!!sandbox}>
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
              <select value={vaultId} onChange={(e) => setVaultId(e.target.value)} disabled={!!sandbox}>
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
          {!sandbox && defaultMode && (
            <div className="field">
              <span className="field-label">Where it runs</span>
              <div className="mode-options" role="radiogroup">
                <ModeOption
                  value="ephemeral"
                  current={mode}
                  isDefault={defaultMode === "ephemeral"}
                  title="Its own sandbox"
                  onPick={setMode}
                  hint="A fresh machine for this conversation alone, reclaimed when the conversation ends."
                />
                <ModeOption
                  value="persistent"
                  current={mode}
                  isDefault={defaultMode === "persistent"}
                  title="The agent's home"
                  onPick={setMode}
                  hint="One shared disk: every conversation of this agent (with the same environment and vault) lands on the same machine, and it stays when a conversation ends. What one conversation leaves behind — including anything a bad turn wrote — is visible to the others."
                />
              </div>
            </div>
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
            <button type="submit" disabled={busy || !agentId || !prompt.trim() || !attachable}>
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

function ModeOption({
  value,
  current,
  isDefault,
  title,
  hint,
  onPick,
}: {
  value: SandboxMode;
  current: SandboxMode | "";
  isDefault: boolean;
  title: string;
  hint: string;
  onPick: (m: SandboxMode) => void;
}) {
  return (
    <label className={`mode-option ${current === value ? "on" : ""}`}>
      <input type="radio" name="sandbox_mode" value={value} checked={current === value} onChange={() => onPick(value)} />
      <span>
        <span className="strong">{title}</span> <span className="muted">({value}{isDefault ? ", the agent's default" : ""})</span>
        <span className="hint">{hint}</span>
      </span>
    </label>
  );
}

function allowed(id: string, list: string[] | null, own: string | null): boolean {
  if (list === null) return true;
  if (id === own) return true;
  return list.includes(id);
}
