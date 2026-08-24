/**
 * The team: named presets of agent + environment + vault. Pull one into a
 * work item and every conversation it starts carries that identity.
 */
import { useState, type FormEvent } from "react";
import { useStore } from "../store";
import { addMember, removeMember, updateMember, type Member } from "../lib/workbench";
import { AgentAvatar } from "../components/AgentAvatar";
import { TwoStep } from "../components/Thread";

export function Team() {
  const { state, update, agents, environments, vaults, resourcesLoaded, settings } = useStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const agentList = [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  const unused = agentList.filter((a) => !state.members.some((m) => m.agentId === a.id));

  return (
    <div className="page narrow">
      <div className="page-header">
        <div>
          <h1>Team</h1>
          <div className="muted small">A member is an agent plus the environment and vault it runs with. Agents themselves are defined in Fountain.</div>
        </div>
      </div>

      {!resourcesLoaded && <p className="muted">Loading agents…</p>}

      <ul className="conv-list">
        {state.members.map((m) => {
          const agent = agents.get(m.agentId);
          if (editingId === m.id) {
            return (
              <li key={m.id} className="editing">
                <MemberForm
                  initial={m}
                  onCancel={() => setEditingId(null)}
                  onSave={(patch) => {
                    update((s) => updateMember(s, m.id, patch));
                    setEditingId(null);
                  }}
                />
              </li>
            );
          }
          return (
            <li key={m.id}>
              <div className="conv-row">
                {agent ? <AgentAvatar agent={agent} size={36} /> : <div className="avatar" style={{ width: 36, height: 36 }}>?</div>}
                <div className="conv-main">
                  <div className="conv-title strong">{m.name}</div>
                  <div className="conv-sub muted">
                    {agent ? `${agent.name} · ${agent.runtime} · ${agent.model}` : "agent no longer exists"}
                    {" · env "}
                    {m.environmentId ? environments.get(m.environmentId)?.name ?? "?" : agent?.environment_id ? `${environments.get(agent.environment_id)?.name ?? "?"} (agent's)` : "none"}
                    {" · vault "}
                    {m.vaultId ? vaults.get(m.vaultId)?.name ?? "?" : "none"}
                    {m.notes ? ` · ${m.notes}` : ""}
                  </div>
                </div>
              </div>
              <button className="secondary small self-center" onClick={() => setEditingId(m.id)}>
                Edit
              </button>
              <TwoStep label="Remove" onConfirm={() => update((s) => removeMember(s, m.id))} className="danger small self-center" />
            </li>
          );
        })}
      </ul>

      {resourcesLoaded && (
        <div className="card stack new-form">
          <h2 className="h2">New member</h2>
          <MemberForm
            key={state.members.length}
            onSave={(input) => {
              update((s) => addMember(s, input)[0]);
            }}
          />
        </div>
      )}

      {unused.length > 0 && (
        <div className="stack">
          <h2 className="h2 section">Agents not on the team</h2>
          <ul className="conv-list">
            {unused.map((a) => (
              <li key={a.id}>
                <div className="conv-row">
                  <AgentAvatar agent={a} size={28} />
                  <div className="conv-main">
                    <div className="conv-title">{a.name}</div>
                    <div className="conv-sub muted">
                      {a.runtime} · {a.model}
                      {a.environment_id ? ` · ${environments.get(a.environment_id)?.name ?? ""}` : ""}
                    </div>
                  </div>
                </div>
                <button className="secondary small self-center" onClick={() => update((s) => addMember(s, { name: a.name, agentId: a.id, environmentId: null, vaultId: null, notes: "" })[0])}>
                  Add as member
                </button>
              </li>
            ))}
          </ul>
          <p className="muted small">
            Agents are created in the <a href={`${settings.baseUrl}/agents`}>Fountain console</a>.
          </p>
        </div>
      )}
    </div>
  );
}

function MemberForm({ initial, onSave, onCancel }: { initial?: Member; onSave: (m: Omit<Member, "id">) => void; onCancel?: () => void }) {
  const { agents, environments, vaults } = useStore();
  const agentList = [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  const [name, setName] = useState(initial?.name ?? "");
  const [agentId, setAgentId] = useState(initial?.agentId ?? agentList[0]?.id ?? "");
  const [environmentId, setEnvironmentId] = useState(initial?.environmentId ?? "");
  const [vaultId, setVaultId] = useState(initial?.vaultId ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const agent = agents.get(agentId);
  const envs = [...environments.values()].filter((e) => !agent?.allowed_environment_ids?.length || agent.allowed_environment_ids.includes(e.id));
  const vs = [...vaults.values()].filter((v) => !agent?.allowed_vault_ids?.length || agent.allowed_vault_ids.includes(v.id));

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!agentId) return;
    onSave({ name: name.trim() || agent?.name || "Member", agentId, environmentId: environmentId || null, vaultId: vaultId || null, notes });
    if (!initial) {
      setName("");
      setNotes("");
    }
  }

  return (
    <form className="stack tight grow member-form" onSubmit={submit}>
      <div className="grid2">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={agent?.name ?? "Coder"} />
        </label>
        <label>
          Agent
          <select
            value={agentId}
            onChange={(e) => {
              setAgentId(e.target.value);
              setEnvironmentId("");
              setVaultId("");
            }}
            required
          >
            {agentList.length === 0 && <option value="">No agents on this Fountain</option>}
            {agentList.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.runtime})
              </option>
            ))}
          </select>
        </label>
        <label>
          Environment
          <select value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
            <option value="">{agent?.environment_id ? `Agent's own (${environments.get(agent.environment_id)?.name ?? "?"})` : "None"}</option>
            {envs.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Vault
          <select value={vaultId} onChange={(e) => setVaultId(e.target.value)}>
            <option value="">None</option>
            {vs.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Notes
        <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What this member is for" />
      </label>
      <div className="row end">
        {onCancel && (
          <button type="button" className="secondary small" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="small" disabled={!agentId}>
          {initial ? "Save" : "Add member"}
        </button>
      </div>
    </form>
  );
}
