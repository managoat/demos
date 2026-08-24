/**
 * One work item: who is on it, the conversations it has (grouped by the
 * computer they run on), and the open thread.
 */
import { useMemo, useState } from "react";
import { useStore } from "../store";
import type { Conversation } from "../types";
import { assignMember, channelFor, memberFor, unassignMember, updateItem, type Member } from "../lib/workbench";
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
  member: Member | null;
}

export function WorkItem({ projectId, itemId, conversationId }: { projectId: string; itemId: string; conversationId: string | null }) {
  const { state, update, conversations, agents, fountain, toast, refresh } = useStore();
  const project = state.projects.find((p) => p.id === projectId);
  const item = state.items.find((w) => w.id === itemId && w.projectId === projectId);
  const [dialog, setDialog] = useState<{ join: JoinTarget | null; memberId: string | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState("");

  const convs = useMemo(
    () =>
      conversations
        .filter((c) => c.channel_id === channelFor(projectId, itemId))
        .sort((a, b) => (a.inserted_at ?? "").localeCompare(b.inserted_at ?? "")),
    [conversations, projectId, itemId],
  );

  const computers = useMemo<Computer[]>(() => {
    const byKey = new Map<string, Computer>();
    for (const c of convs) {
      const key = c.sandbox_id ?? `conv:${c.id}`;
      let comp = byKey.get(key);
      if (!comp) {
        const agent = c.agent_id ? agents.get(c.agent_id) : undefined;
        comp = { key, sandbox: c.sandbox ?? null, conversations: [], member: memberFor(state.members, c, agent?.environment_id) };
        byKey.set(key, comp);
      }
      comp.conversations.push(c);
      if (!comp.sandbox && c.sandbox) comp.sandbox = c.sandbox;
    }
    // Live computers first, then by most recent activity.
    return [...byKey.values()].sort((a, b) => {
      const la = a.sandbox && a.sandbox.status !== "terminated" && a.sandbox.status !== "failed" ? 0 : 1;
      const lb = b.sandbox && b.sandbox.status !== "terminated" && b.sandbox.status !== "failed" ? 0 : 1;
      if (la !== lb) return la - lb;
      return latest(b).localeCompare(latest(a));
    });
  }, [convs, agents, state.members]);

  if (!project || !item) {
    return (
      <div className="page narrow">
        <div className="empty card">
          <p className="strong">No such work item.</p>
          <a className="button secondary" href={project ? href.project(project.id) : href.projects()}>
            Back
          </a>
        </div>
      </div>
    );
  }

  const onItem = item.memberIds.map((id) => state.members.find((m) => m.id === id)).filter((m): m is Member => !!m);
  const available = state.members.filter((m) => !item.memberIds.includes(m.id));

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
              <input value={item.title} onChange={(e) => update((s) => updateItem(s, item.id, { title: e.target.value }))} />
              <textarea rows={4} value={item.notes} onChange={(e) => update((s) => updateItem(s, item.id, { notes: e.target.value }))} placeholder="Notes" />
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
                <button className="secondary small" onClick={() => update((s) => updateItem(s, item.id, { status: item.status === "done" ? "open" : "done" }))}>
                  {item.status === "done" ? "Reopen" : "Mark done"}
                </button>
              </div>
            </>
          )}
        </div>

        <section className="item-section">
          <div className="row">
            <h2 className="h2 grow">Members</h2>
            {available.length > 0 && (
              <select
                className="compact"
                value={pick}
                onChange={(e) => {
                  const id = e.target.value;
                  setPick("");
                  if (id) update((s) => assignMember(s, item.id, id));
                }}
              >
                <option value="">+ Add member…</option>
                {available.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {state.members.length === 0 && (
            <p className="muted small">
              No members yet. <a href={href.team()}>Define your team</a> — each member is an agent plus an environment and a vault.
            </p>
          )}
          <ul className="member-list">
            {onItem.map((m) => {
              const agent = agents.get(m.agentId);
              const active = convs.filter((c) => memberFor([m], c, agent?.environment_id) && c.status !== "terminated").length;
              return (
                <li key={m.id} className="member-row">
                  {agent && <AgentAvatar agent={agent} size={28} />}
                  <div className="min0 grow">
                    <div className="strong ellipsis">{m.name}</div>
                    <div className="muted small ellipsis">
                      {agent?.name ?? "missing agent"}
                      {active ? ` · ${active} live` : ""}
                    </div>
                  </div>
                  <button className="small" onClick={() => setDialog({ join: null, memberId: m.id })} disabled={!agent}>
                    Talk
                  </button>
                  <button className="icon" title="Remove from this item" onClick={() => update((s) => unassignMember(s, item.id, m.id))}>
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
          <button className="secondary small" onClick={() => setDialog({ join: null, memberId: null })} disabled={state.members.length === 0}>
            + Start a conversation
          </button>
        </section>

        <section className="item-section">
          <h2 className="h2">Conversations</h2>
          {computers.length === 0 && <p className="muted small">None yet.</p>}
          {computers.map((comp) => {
            const live = comp.sandbox && comp.sandbox.status !== "terminated" && comp.sandbox.status !== "failed";
            const runtime = comp.conversations[0]?.runtime;
            const busy = comp.conversations.some((c) => c.status === "running" || c.status === "pending");
            return (
              <div className={`computer ${live ? "live" : "gone"}`} key={comp.key}>
                <div className="computer-head">
                  <span className="computer-icon">🖥</span>
                  <div className="min0 grow">
                    <div className="strong ellipsis">
                      {comp.member?.name ?? agents.get(comp.conversations[0]?.agent_id ?? "")?.name ?? runtime}
                      {comp.sandbox ? <span className="muted small"> · {comp.sandbox.sprite_name}</span> : null}
                    </div>
                    <div className="muted small">
                      {comp.sandbox ? `${comp.sandbox.provider ?? ""} · ${comp.sandbox.status}` : "no computer"}
                      {runtime ? ` · ${runtime}` : ""}
                      {busy ? " · busy" : ""}
                    </div>
                  </div>
                  {live && comp.sandbox && (
                    <button
                      className="secondary small"
                      title="Another conversation with the same member on this computer"
                      onClick={() => setDialog({ join: { sandboxId: comp.sandbox!.id, label: comp.sandbox!.sprite_name, member: comp.member }, memberId: comp.member?.id ?? null })}
                      disabled={!comp.member}
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
              <p className="small">A member gets its own computer; “+ Here” opens a second conversation on a computer that is already up.</p>
            </div>
          </div>
        )}
      </div>

      {dialog && <StartDialog item={item} join={dialog.join} initialMemberId={dialog.memberId} onClose={() => setDialog(null)} />}
    </div>
  );
}

function latest(c: Computer): string {
  return c.conversations.reduce((m, x) => ((x.last_active_at ?? x.inserted_at ?? "") > m ? x.last_active_at ?? x.inserted_at ?? "" : m), "");
}
