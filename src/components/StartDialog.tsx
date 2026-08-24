/**
 * Start a conversation on a work item: pick a teammate (an agent), write the
 * first prompt. The project supplies the environment and vault (the server
 * enforces that whatever this sends). Optionally join a computer another
 * conversation of the same agent already has (`sandbox_id`, ADR 0023 — a
 * Fountain that predates it starts a new one and this dialog says so).
 */
import { useMemo, useState, type FormEvent } from "react";
import { useProject } from "../store";
import type { Agent, Conversation } from "../types";
import { agentFits, channelFor, conversationTitle, type WorkItem } from "../lib/workbench";
import { describeError } from "../lib/errors";
import { href, navigate } from "../router";
import { AgentAvatar } from "./AgentAvatar";

export interface JoinTarget {
  sandboxId: string;
  label: string;
  /** The agent the computer belongs to; a home is never shared across identities. */
  agentId: string;
}

export function StartDialog({ item, join, initialAgentId, onClose }: { item: WorkItem; join?: JoinTarget | null; initialAgentId?: string | null; onClose: () => void }) {
  const { project, fountain, agents, environments, vaults, toast, refresh, reload } = useProject();
  const all = [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  const onItem = all.filter((a) => item.agentIds.includes(a.id));
  const others = all.filter((a) => !item.agentIds.includes(a.id));
  const [agentId, setAgentId] = useState<string>(join?.agentId ?? initialAgentId ?? onItem[0]?.id ?? all[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [includeNotes, setIncludeNotes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agent = agents.get(agentId) ?? null;
  const fit = agent ? agentFits(agent, project) : { ok: false as const, reason: "no agent" };
  const preview = useMemo(() => buildPrompt(item, prompt, includeNotes), [item, prompt, includeNotes]);
  const envName = project.environmentId ? environments.get(project.environmentId)?.name ?? "?" : agent?.environment_id ? `${environments.get(agent.environment_id)?.name ?? "?"} (agent's own)` : "none";
  const vaultName = project.vaultId ? vaults.get(project.vaultId)?.name ?? "?" : "none";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!agent || busy || !fit.ok) return;
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {
      agent_id: agent.id,
      channel_id: channelFor(item.projectId, item.id),
      fresh: true,
      title: conversationTitle(agent.name, item.title),
    };
    if (preview) body.prompt = preview;
    if (join) body.sandbox_id = join.sandboxId;
    try {
      const conversation = await fountain.api.data<Conversation>("POST", "/api/conversations", { body });
      if (join && conversation.sandbox_id !== join.sandboxId) {
        toast("This Fountain does not share a computer between conversations yet — started on a new one.", "error");
      }
      void refresh();
      void reload(); // the server put the teammate on the item
      navigate(href.conversation(item.projectId, item.id, conversation.id));
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
            : `On "${item.title}". The conversation is bound to this work item and runs with ${project.name}'s environment and vault, on ${project.ownerEmail}'s account.`}
        </p>

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
            Teammate
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
        {item.notes.trim() && (
          <label className="check">
            <input type="checkbox" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} /> Prepend the work item's notes
          </label>
        )}

        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !agent || !fit.ok}>
            {busy ? "Starting…" : "Start"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function buildPrompt(item: WorkItem, prompt: string, includeNotes: boolean): string {
  const body = prompt.trim();
  const notes = includeNotes ? item.notes.trim() : "";
  if (!body && !notes) return "";
  if (!notes) return body;
  const head = `Work item: ${item.title}\n\n${notes}`;
  return body ? `${head}\n\n---\n\n${body}` : head;
}
