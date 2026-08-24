/**
 * Start a conversation: pick the work item (fixed when opened from one),
 * pick a teammate (an agent), write the first prompt. Starting is also what
 * puts the teammate on the item, so this dialog is the whole of assigning
 * one. The project supplies the environment and vault (the server enforces
 * that whatever this sends). Optionally join a computer another conversation
 * of the same agent already has (`sandbox_id`, ADR 0023).
 */
import { useState, type FormEvent } from "react";
import { useProject } from "../store";
import type { Agent } from "../types";
import { agentFits, type WorkItem } from "../lib/workbench";
import type { JoinTarget } from "../lib/start";
import { describeError } from "../lib/errors";
import { href, navigate } from "../router";
import { AgentAvatar } from "./AgentAvatar";

export function StartDialog({ itemId, join, initialAgentId, onClose }: { itemId?: string | null; join?: JoinTarget | null; initialAgentId?: string | null; onClose: () => void }) {
  const { project, items, agents, environments, vaults, startConversation } = useProject();
  const open = items.filter((w) => w.status === "open");
  const fixed = itemId ? items.find((w) => w.id === itemId) ?? null : null;
  const [pickedItem, setPickedItem] = useState<string>(fixed?.id ?? open[0]?.id ?? items[0]?.id ?? "");
  const item: WorkItem | null = fixed ?? items.find((w) => w.id === pickedItem) ?? null;
  const all = [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  const onItem = item ? all.filter((a) => item.agentIds.includes(a.id)) : [];
  const others = item ? all.filter((a) => !item.agentIds.includes(a.id)) : all;
  const [agentId, setAgentId] = useState<string>(join?.agentId ?? initialAgentId ?? onItem[0]?.id ?? all[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [includeNotes, setIncludeNotes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agent = agents.get(agentId) ?? null;
  const fit = agent ? agentFits(agent, project) : { ok: false as const, reason: "no agent" };
  const envName = project.environmentId ? environments.get(project.environmentId)?.name ?? "?" : agent?.environment_id ? `${environments.get(agent.environment_id)?.name ?? "?"} (agent's own)` : "none";
  const vaultName = project.vaultId ? vaults.get(project.vaultId)?.name ?? "?" : "none";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!agent || !item || busy || !fit.ok) return;
    setBusy(true);
    setError(null);
    try {
      const conversation = await startConversation({ item, agent, prompt, includeNotes, join });
      navigate(href.conversation(project.id, conversation.id));
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const option = (a: Agent) => {
    const f = agentFits(a, project);
    return (
      <option key={a.id} value={a.id} disabled={!f.ok}>
        {a.name} ({a.runtime}){f.ok ? "" : ` — ${f.reason}`}
      </option>
    );
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 className="h2">{join ? `New conversation on ${join.label}` : "Start a conversation"}</h2>
        <p className="muted small">
          {join
            ? "Same teammate, same computer: the checkout and everything on disk are shared, the transcript is its own."
            : `The conversation is bound to a work item and runs with ${project.name}'s environment and vault, on ${project.ownerEmail}'s account.`}
        </p>

        {fixed ? (
          <div className="field">
            <span className="field-label">Work item</span>
            <span className="strong">{fixed.title}</span>
          </div>
        ) : (
          <label>
            Work item
            <select value={pickedItem} onChange={(e) => setPickedItem(e.target.value)} required>
              {items.length === 0 && <option value="">No work items yet</option>}
              {open.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.title}
                </option>
              ))}
              {items.filter((w) => w.status !== "open").length > 0 && (
                <optgroup label="Done">
                  {items
                    .filter((w) => w.status !== "open")
                    .map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.title}
                      </option>
                    ))}
                </optgroup>
              )}
            </select>
          </label>
        )}

        {join ? (
          <div className="field">
            <span className="field-label">Teammate</span>
            <div className="row">
              {agent && <AgentAvatar agent={agent} size={24} />}
              <span className="strong">{agent?.name ?? "?"}</span>
            </div>
          </div>
        ) : (
          <label>
            Teammate <span className="hint">Whoever you pick joins the work item when the conversation starts.</span>
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)} required>
              {all.length === 0 && <option value="">No agents on this Fountain</option>}
              {onItem.length > 0 && <optgroup label="On this work item">{onItem.map(option)}</optgroup>}
              {others.length > 0 && <optgroup label={onItem.length ? "Rest of the team" : "Team"}>{others.map(option)}</optgroup>}
            </select>
          </label>
        )}
        {agent && (
          <div className="muted small">
            {agent.runtime} · {agent.model} · env {envName} · vault {vaultName}
          </div>
        )}
        {agent && !fit.ok && <div className="error">{agent.name} {fit.reason}.</div>}

        <label>
          First prompt
          <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should they do? Leave empty to just bring the computer up." autoFocus />
        </label>
        {item?.notes.trim() && (
          <label className="check">
            <input type="checkbox" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} /> Prepend the work item's notes
          </label>
        )}

        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !agent || !item || !fit.ok}>
            {busy ? "Starting…" : "Start"}
          </button>
        </div>
      </form>
    </div>
  );
}
