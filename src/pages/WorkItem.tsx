/**
 * One work item: the teammates on it, the conversations it has (grouped by
 * the computer they run on), and the open thread.
 */
import { useMemo, useState } from "react";
import { useProject } from "../store";
import type { Agent, Conversation } from "../types";
import { agentFits, channelFor } from "../lib/workbench";
import { href, navigate } from "../router";
import { Thread, TwoStep } from "../components/Thread";
import { StartDialog, type JoinTarget } from "../components/StartDialog";
import { StatusPill } from "../components/StatusPill";
import { AgentAvatar } from "../components/AgentAvatar";
import { formatTime, shortId } from "../lib/format";

interface Computer {
  key: string;
  sandbox: Conversation["sandbox"] | null;
  conversations: Conversation[];
  agent: Agent | null;
}

export function WorkItem({ itemId, conversationId }: { itemId: string; conversationId: string | null }) {
  const { project, items, conversations, agents, environments, vaults, fountain, toast, refresh, updateItem, addTeammate, removeTeammate } = useProject();
  const item = items.find((w) => w.id === itemId);
  const [dialog, setDialog] = useState<{ join: JoinTarget | null; agentId: string | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState("");

  const convs = useMemo(
    () =>
      conversations
        .filter((c) => c.channel_id === channelFor(project.id, itemId))
        .sort((a, b) => (a.inserted_at ?? "").localeCompare(b.inserted_at ?? "")),
    [conversations, project.id, itemId],
  );

  const computers = useMemo<Computer[]>(() => {
    const byKey = new Map<string, Computer>();
    for (const c of convs) {
      const key = c.sandbox_id ?? `conv:${c.id}`;
      let comp = byKey.get(key);
      if (!comp) {
        comp = { key, sandbox: c.sandbox ?? null, conversations: [], agent: c.agent_id ? agents.get(c.agent_id) ?? null : null };
        byKey.set(key, comp);
      }
      comp.conversations.push(c);
      if (!comp.sandbox && c.sandbox) comp.sandbox = c.sandbox;
    }
    // Live computers first, then by most recent activity.
    return [...byKey.values()].sort((a, b) => {
      const la = isLive(a) ? 0 : 1;
      const lb = isLive(b) ? 0 : 1;
      if (la !== lb) return la - lb;
      return latest(b).localeCompare(latest(a));
    });
  }, [convs, agents]);

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
    <div className={`item-layout ${conversationId ? "with-thread" : ""}`}>
      <aside className="item-side">
        <div className="item-head">
          {editing ? (
            <form
              className="stack tight"
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
              <div className="row top">
                <h1 className="item-title grow">{item.title}</h1>
                <button className="secondary small" onClick={() => setEditing(true)}>
                  Edit
                </button>
              </div>
              {item.notes && <p className="muted small pre">{item.notes}</p>}
              <div className="row wrap">
                <span className={`pill ${item.status === "done" ? "terminated" : "running"}`}>{item.status}</span>
                <button className="secondary small" onClick={() => void updateItem(item.id, { status: item.status === "done" ? "open" : "done" })}>
                  {item.status === "done" ? "Reopen" : "Mark done"}
                </button>
              </div>
              <div className="muted small">
                env {envName} · vault {vaultName}
              </div>
            </>
          )}
        </div>

        <section className="item-section">
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
                  <button className="small" onClick={() => setDialog({ join: null, agentId: a.id })} disabled={!fit.ok} title={fit.ok ? "New conversation on a new computer" : fit.reason}>
                    Talk
                  </button>
                  <button className="icon" title="Remove from this item" onClick={() => void removeTeammate(item.id, a.id)}>
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
          <button className="secondary small" onClick={() => setDialog({ join: null, agentId: null })} disabled={team.length === 0}>
            + Start a conversation
          </button>
        </section>

        <section className="item-section">
          <h2 className="h2">Conversations</h2>
          {computers.length === 0 && <p className="muted small">None yet.</p>}
          {computers.map((comp) => {
            const live = isLive(comp);
            const runtime = comp.conversations[0]?.runtime;
            const busy = comp.conversations.some((c) => c.status === "running" || c.status === "pending");
            return (
              <div className={`computer ${live ? "live" : "gone"}`} key={comp.key}>
                <div className="computer-head">
                  {comp.agent ? <AgentAvatar agent={comp.agent} size={26} /> : <span className="computer-icon">🖥</span>}
                  <div className="min0 grow">
                    <div className="strong ellipsis">
                      {comp.agent?.name ?? runtime}
                      {comp.sandbox ? <span className="muted small"> · 🖥 {comp.sandbox.sprite_name}</span> : null}
                    </div>
                    <div className="muted small">
                      {comp.sandbox ? `${comp.sandbox.provider ?? ""} · ${comp.sandbox.status}` : "no computer"}
                      {runtime ? ` · ${runtime}` : ""}
                      {busy ? " · busy" : ""}
                    </div>
                  </div>
                  {live && comp.sandbox && comp.agent && (
                    <button
                      className="secondary small"
                      title="Another conversation with the same teammate on this computer"
                      onClick={() => setDialog({ join: { sandboxId: comp.sandbox!.id, label: comp.sandbox!.sprite_name, agentId: comp.agent!.id }, agentId: comp.agent!.id })}
                    >
                      + Here
                    </button>
                  )}
                </div>
                <ul className="conv-list flat">
                  {comp.conversations.map((c) => (
                    <li key={c.id} className={c.id === conversationId ? "current" : ""}>
                      <a className="conv-row" href={href.conversation(project.id, item.id, c.id)}>
                        {c.unread && <span className="unread-dot" />}
                        <div className="conv-main">
                          <div className="conv-title">{c.title ?? shortId(c.id)}</div>
                          <div className="conv-sub muted">
                            {c.turn_count ?? 0} turn{c.turn_count === 1 ? "" : "s"} · {formatTime(c.last_active_at ?? c.inserted_at)}
                          </div>
                        </div>
                        <StatusPill status={c.status} sandbox={c.sandbox?.status} />
                      </a>
                      {c.status !== "terminated" && (
                        <TwoStep
                          label="Retire"
                          className="danger small self-center"
                          onConfirm={() =>
                            fountain
                              .resume(c.id)
                              .terminate()
                              .then(() => {
                                if (c.id === conversationId) navigate(href.item(project.id, item.id));
                                return refresh();
                              })
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
        </section>
      </aside>

      <div className="item-main">
        {conversationId ? (
          <Thread key={conversationId} conversationId={conversationId} onClose={() => navigate(href.item(project.id, item.id))} />
        ) : (
          <div className="centered muted">
            <div>
              <p className="strong">Pick a conversation, or start one.</p>
              <p className="small">A teammate gets its own computer; “+ Here” opens a second conversation on a computer that is already up.</p>
            </div>
          </div>
        )}
      </div>

      {dialog && <StartDialog item={item} join={dialog.join} initialAgentId={dialog.agentId} onClose={() => setDialog(null)} />}
    </div>
  );
}

function isLive(c: Computer): boolean {
  return !!c.sandbox && c.sandbox.status !== "terminated" && c.sandbox.status !== "failed";
}

function latest(c: Computer): string {
  return c.conversations.reduce((m, x) => ((x.last_active_at ?? x.inserted_at ?? "") > m ? x.last_active_at ?? x.inserted_at ?? "" : m), "");
}
