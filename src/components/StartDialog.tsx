/**
 * Start a conversation on a work item: pick a member, write the first prompt,
 * optionally on a computer another conversation of the same member already
 * has (`sandbox_id`, ADR 0023 — a Fountain that predates it starts a new one
 * and this dialog says so).
 */
import { useMemo, useState, type FormEvent } from "react";
import { useStore } from "../store";
import type { Conversation } from "../types";
import { assignMember, channelFor, conversationTitle, type Member, type WorkItem } from "../lib/workbench";
import { describeError } from "../lib/errors";
import { href, navigate } from "../router";

export interface JoinTarget {
  sandboxId: string;
  label: string;
  /** The member the sandbox belongs to; a home is never shared across identities. */
  member: Member | null;
}

export function StartDialog({ item, join, initialMemberId, onClose }: { item: WorkItem; join?: JoinTarget | null; initialMemberId?: string | null; onClose: () => void }) {
  const { fountain, state, update, agents, environments, vaults, toast, refresh } = useStore();
  const members = state.members;
  const onItem = members.filter((m) => item.memberIds.includes(m.id));
  const others = members.filter((m) => !item.memberIds.includes(m.id));
  const fixed = join?.member ?? null;
  const [memberId, setMemberId] = useState<string>(fixed?.id ?? initialMemberId ?? onItem[0]?.id ?? members[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [includeNotes, setIncludeNotes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const member = members.find((m) => m.id === memberId) ?? null;
  const agent = member ? agents.get(member.agentId) ?? null : null;
  const preview = useMemo(() => buildPrompt(item, prompt, includeNotes), [item, prompt, includeNotes]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!member || busy) return;
    setBusy(true);
    setError(null);
    const body: Record<string, unknown> = {
      agent_id: member.agentId,
      channel_id: channelFor(item.projectId, item.id),
      fresh: true,
      title: conversationTitle(member.name, item.title),
    };
    if (member.environmentId) body.environment_id = member.environmentId;
    if (member.vaultId) body.vault_id = member.vaultId;
    if (preview) body.prompt = preview;
    if (join) body.sandbox_id = join.sandboxId;
    try {
      const conversation = await fountain.api.data<Conversation>("POST", "/api/conversations", { body });
      update((s) => assignMember(s, item.id, member.id));
      if (join && conversation.sandbox_id !== join.sandboxId) {
        toast("This Fountain does not share a computer between conversations yet — started on a new one.", "error");
      }
      void refresh();
      navigate(href.conversation(item.projectId, item.id, conversation.id));
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 className="h2">{join ? `New conversation on ${join.label}` : "Start a conversation"}</h2>
        <p className="muted small">
          {join
            ? "Same member, same computer: the checkout and everything on disk are shared, the transcript is its own."
            : `On "${item.title}". The conversation is bound to this work item.`}
        </p>

        {fixed ? (
          <div className="field">
            <span className="field-label">Member</span>
            <MemberLine member={fixed} />
          </div>
        ) : (
          <label>
            Member
            <select value={memberId} onChange={(e) => setMemberId(e.target.value)} required>
              {members.length === 0 && <option value="">No members yet — add one under Team</option>}
              {onItem.length > 0 && (
                <optgroup label="On this work item">
                  {onItem.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {others.length > 0 && (
                <optgroup label={onItem.length ? "Other members" : "Members"}>
                  {others.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
        )}
        {member && (
          <div className="muted small">
            {agent ? `${agent.name} · ${agent.runtime} · ${agent.model}` : "agent not found"}
            {" · env "}
            {member.environmentId ? environments.get(member.environmentId)?.name ?? "?" : agent?.environment_id ? `${environments.get(agent.environment_id)?.name ?? "agent's own"}` : "none"}
            {" · vault "}
            {member.vaultId ? vaults.get(member.vaultId)?.name ?? "?" : "none"}
          </div>
        )}

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
          <button type="submit" disabled={busy || !member}>
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

export function MemberLine({ member }: { member: Member }) {
  const { agents, environments, vaults } = useStore();
  const agent = agents.get(member.agentId);
  return (
    <span>
      <span className="strong">{member.name}</span>
      <span className="muted small">
        {" "}
        · {agent?.name ?? "missing agent"}
        {member.environmentId ? ` · ${environments.get(member.environmentId)?.name ?? "?"}` : ""}
        {member.vaultId ? ` · 🔐 ${vaults.get(member.vaultId)?.name ?? "?"}` : ""}
      </span>
    </span>
  );
}
