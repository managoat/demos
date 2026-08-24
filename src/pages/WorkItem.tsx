/**
 * One work item: its notes and status, the teammates on it, and the
 * conversations it has — each on its computer — linking into the thread.
 */
import { useMemo, useState } from "react";
import { useProject } from "../store";
import type { Agent } from "../types";
import { agentFits, channelIsItem } from "../lib/workbench";
import { computerLabel, computersOf, relativeTime } from "../lib/sidebar";
import { href } from "../router";
import { TwoStep } from "../components/Thread";
import { StartDialog } from "../components/StartDialog";
import { StatusPill } from "../components/StatusPill";
import { AgentAvatar } from "../components/AgentAvatar";
import { shortId } from "../lib/format";

export function WorkItem({ itemId }: { itemId: string }) {
  const { project, items, conversations, agents, sandboxes, environments, vaults, fountain, toast, refresh, updateItem, addTeammate, removeTeammate } = useProject();
  const item = items.find((w) => w.id === itemId);
  const [dialog, setDialog] = useState<{ agentId: string | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState("");

  const convs = useMemo(() => conversations.filter((c) => channelIsItem(c.channel_id, project.id, itemId)), [conversations, project.id, itemId]);
  const computers = useMemo(() => computersOf(convs, sandboxes), [convs, sandboxes]);
  const byKey = useMemo(() => new Map(computers.map((c) => [c.key, c])), [computers]);

  if (!item) {
    return (
      <div className="page narrow">
        <div className="empty card">
          <p className="strong">No such work item.</p>
          <a className="button secondary" href={href.project(project.id)}>
            Back
          </a>
        </div>
      </div>
    );
  }

  const team = [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  const onItem = item.agentIds.map((id) => agents.get(id)).filter((a): a is Agent => !!a);
  const available = team.filter((a) => !item.agentIds.includes(a.id));
  const envName = project.environmentId ? environments.get(project.environmentId)?.name ?? "?" : "each agent's own";
  const vaultName = project.vaultId ? vaults.get(project.vaultId)?.name ?? "?" : "none";

  return (
    <div className="page narrow">
      <div className="page-header">
        {editing ? (
          <form
            className="stack tight grow"
            onSubmit={(e) => {
              e.preventDefault();
              setEditing(false);
            }}
          >
            <input value={item.title} onChange={(e) => void updateItem(item.id, { title: e.target.value })} />
            <textarea rows={4} value={item.notes} onChange={(e) => void updateItem(item.id, { notes: e.target.value })} placeholder="Notes" />
            <div className="row end">
              <button type="submit" className="secondary small">
                Done
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="min0">
              <div className="muted small">
                <a href={href.project(project.id)}>{project.name}</a> · env {envName} · vault {vaultName}
              </div>
              <h1>{item.title}</h1>
              {item.notes && <p className="muted small pre">{item.notes}</p>}
            </div>
            <div className="row">
              <span className={`pill ${item.status === "done" ? "terminated" : "running"}`}>{item.status}</span>
              <button className="secondary small" onClick={() => void updateItem(item.id, { status: item.status === "done" ? "open" : "done" })}>
                {item.status === "done" ? "Reopen" : "Mark done"}
              </button>
              <button className="secondary small" onClick={() => setEditing(true)}>
                Edit
              </button>
            </div>
          </>
        )}
      </div>

      <section className="card stack tight">
        <div className="row">
          <h2 className="h2 grow">Teammates</h2>
          {available.length > 0 && (
            <select
              className="compact"
              value={pick}
              onChange={(e) => {
                const id = e.target.value;
                setPick("");
                if (id) void addTeammate(item.id, id);
              }}
            >
              <option value="">+ Add…</option>
              {available.map((a) => {
                const f = agentFits(a, project);
                return (
                  <option key={a.id} value={a.id} disabled={!f.ok}>
                    {a.name}
                    {f.ok ? "" : ` — ${f.reason}`}
                  </option>
                );
              })}
            </select>
          )}
        </div>
        {team.length === 0 && (
          <p className="muted small">
            No agents on {project.ownerEmail}'s Fountain yet. <a href={href.team(project.id)}>See the team</a>.
          </p>
        )}
        <ul className="member-list">
          {onItem.map((a) => {
            const fit = agentFits(a, project);
            const live = convs.filter((c) => c.agent_id === a.id && (c.status === "running" || c.status === "pending" || c.status === "idle")).length;
            return (
              <li key={a.id} className="member-row">
                <AgentAvatar agent={a} size={28} />
                <div className="min0 grow">
                  <div className="strong ellipsis">{a.name}</div>
                  <div className="muted small ellipsis">
                    {a.runtime}
                    {live ? ` · ${live} live` : ""}
                    {fit.ok ? "" : ` · ${fit.reason}`}
                  </div>
                </div>
                <button className="small" onClick={() => setDialog({ agentId: a.id })} disabled={!fit.ok} title={fit.ok ? "New conversation on a new computer" : fit.reason}>
                  Talk
                </button>
                <button className="icon" title="Remove from this item" onClick={() => void removeTeammate(item.id, a.id)}>
                  ×
                </button>
              </li>
            );
          })}
        </ul>
        <div>
          <button className="secondary small" onClick={() => setDialog({ agentId: null })} disabled={team.length === 0}>
            + Start a conversation
          </button>
        </div>
      </section>

      <h2 className="h2 section">Conversations</h2>
      {convs.length === 0 && <p className="muted">None yet. Talk to a teammate above; a second conversation on a computer that is up starts from the sidebar's +.</p>}
      {computers.map((comp) => {
        const agent = comp.agentId ? agents.get(comp.agentId) ?? null : null;
        return (
          <div className={`computer ${comp.live ? "live" : "gone"}`} key={comp.key}>
            <div className="computer-head static">
              {agent ? <AgentAvatar agent={agent} size={26} /> : <span className="computer-icon">🖥</span>}
              <div className="min0 grow">
                <div className="strong ellipsis">
                  {agent?.name ?? comp.conversations[0]?.runtime}
                  <span className="muted small"> · 🖥 {computerLabel(comp)}</span>
                </div>
                <div className="muted small">
                  {comp.sandbox ? `${comp.sandbox.provider ?? ""} · ${comp.sandbox.status}` : comp.sandboxId ? (comp.live ? "up" : "gone") : "no computer"}
                  {comp.busy ? " · working" : ""}
                </div>
              </div>
            </div>
            <ul className="conv-list flat">
              {comp.conversations.map((c) => (
                <li key={c.id}>
                  <a className="conv-row" href={href.conversation(project.id, c.id)}>
                    {c.unread && <span className="unread-dot" />}
                    <div className="conv-main">
                      <div className="conv-title">{c.title ?? shortId(c.id)}</div>
                      <div className="conv-sub muted">
                        {c.turn_count ?? 0} turn{c.turn_count === 1 ? "" : "s"} · {relativeTime(c.last_active_at ?? c.inserted_at)}
                      </div>
                    </div>
                    <StatusPill status={c.status} sandbox={byKey.get(comp.key)?.sandbox?.status} />
                  </a>
                  {c.status !== "terminated" && (
                    <TwoStep
                      label="Retire"
                      className="danger small self-center"
                      onConfirm={() =>
                        fountain
                          .resume(c.id)
                          .terminate()
                          .then(() => refresh())
                          .catch((err) => toast(String(err), "error"))
                      }
                    />
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      {dialog && <StartDialog itemId={item.id} initialAgentId={dialog.agentId} onClose={() => setDialog(null)} />}
    </div>
  );
}
