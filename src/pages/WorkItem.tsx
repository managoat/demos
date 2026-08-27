/**
 * One work item: what happened on it since you last looked, its notes and
 * status, the teammates on it and the rest of the team a click away, and the
 * conversations it has — each on its computer — linking into the thread.
 * Prompting an agent from here is what puts them on the item; "+" on one only
 * earmarks them.
 *
 * The notes are the briefing whoever picks the item up reads — a teammate
 * over MCP (`list_work_items`) as much as a person here — so they are
 * markdown on the read path: a checklist, a repro block, a link to the PR.
 * The editor stays a textarea, and saves on a pause, not on a keystroke.
 *
 * **Retiring a computer is not finishing with it.** Fountain keeps a
 * terminated conversation for good, so an item worked on all week ends up a
 * column of dead machines with the live one somewhere in it. "Remove" is the
 * other half: it retires whatever is still running on that computer and takes
 * it out of the item — here, in the explorer, in the palette, in the feed.
 * Nothing is deleted on Fountain, so it is a fold at the bottom of the page
 * away from being put back, and the bill still counts every token it spent.
 */
import { useMemo, useState } from "react";
import { useProject } from "../store";
import type { Agent } from "../types";
import { agentFits, channelIsItem, proposerName } from "../lib/workbench";
import { computerLabel, computersOf, relativeTime } from "../lib/sidebar";
import { useDraft } from "../lib/draft";
import { renderMarkdown } from "../lib/markdown";
import { href } from "../router";
import { TwoStep } from "../components/Thread";
import { CloseControls, ItemStatusPill } from "../components/ItemStatus";
import { StartDialog } from "../components/StartDialog";
import { StatusPill } from "../components/StatusPill";
import { AgentAvatar } from "../components/AgentAvatar";
import { ItemDigest } from "../components/ItemDigest";
import { shortId } from "../lib/format";

export function WorkItem({ itemId }: { itemId: string }) {
  const { project, items, conversations, agents, sandboxes, environments, vaults, fountain, toast, refresh, updateItem, addTeammate, removeTeammate, removeComputer, restoreComputer } =
    useProject();
  const item = items.find((w) => w.id === itemId);
  const [dialog, setDialog] = useState<{ agentId: string | null } | null>(null);
  const [editing, setEditing] = useState(false);

  // What is saved, against what the fields show: one PATCH per pause in the
  // typing, and another member's edit still lands on a field nobody is in.
  const record = useMemo(() => ({ title: item?.title ?? "", notes: item?.notes ?? "" }), [item?.title, item?.notes]);
  const { draft, edit, flush } = useDraft(record, (v) => {
    if (item) void updateItem(item.id, v);
  });

  const convs = useMemo(() => conversations.filter((c) => channelIsItem(c.channel_id, project.id, itemId)), [conversations, project.id, itemId]);
  const computers = useMemo(() => computersOf(convs, sandboxes), [convs, sandboxes]);
  const byKey = useMemo(() => new Map(computers.map((c) => [c.key, c])), [computers]);
  const live = convs.filter((c) => c.status !== "terminated").length;

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
  // The project's default first: on an item it is not on yet, it is still the
  // name you most likely want, so it should not be somewhere in the alphabet.
  const available = team.filter((a) => !item.agentIds.includes(a.id)).sort((a, b) => Number(b.id === project.defaultAgentId) - Number(a.id === project.defaultAgentId));
  const envName = project.environmentId ? environments.get(project.environmentId)?.name ?? "?" : "each agent's own";
  const vaultName = project.vaultId ? vaults.get(project.vaultId)?.name ?? "?" : "none";

  return (
    <div className="page narrow">
      <div className="page-header top">
        {editing ? (
          <form
            className="stack tight grow"
            onSubmit={(e) => {
              e.preventDefault();
              flush();
              setEditing(false);
            }}
          >
            <input value={draft.title} onChange={(e) => edit({ ...draft, title: e.target.value })} />
            <textarea
              rows={10}
              value={draft.notes}
              onChange={(e) => edit({ ...draft, notes: e.target.value })}
              placeholder={"The briefing whoever picks this up reads.\n\n## Repro\n```\nbun test foo\n```\n- [ ] a checklist\n- a link: https://…"}
            />
            <div className="row end">
              <span className="muted small grow">Markdown. Saved as you stop typing.</span>
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
              {item.notes.trim() && <div className="md notes">{renderMarkdown(item.notes)}</div>}
            </div>
            <div className="row">
              <ItemStatusPill status={item.status} />
              <CloseControls
                status={item.status}
                live={live}
                proposal={item.proposal}
                proposedBy={item.proposal ? proposerName(item.proposal, agents) : ""}
                onSet={(status) => void updateItem(item.id, { status })}
                onDismiss={() => void updateItem(item.id, { proposal: null })}
              />
              <button className="secondary small" onClick={() => setEditing(true)}>
                Edit
              </button>
            </div>
          </>
        )}
      </div>

      {/* Keyed on the item: the mark it reads is captured once, per item. */}
      <ItemDigest key={item.id} itemId={item.id} conversations={convs} />

      <section className="card stack tight">
        <h2 className="h2">Teammates</h2>
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
        {available.length > 0 && (
          <>
            <div className="muted small">{onItem.length > 0 ? "Rest of the team" : "The team"} — pick one to put them on this item and prompt them.</div>
            <div className="row wrap">
              {available.map((a) => {
                const fit = agentFits(a, project);
                return (
                  <span className="agent-chip" key={a.id}>
                    <button
                      className="chip-talk"
                      disabled={!fit.ok}
                      title={fit.ok ? `Put ${a.name} on this work item and prompt them` : fit.reason}
                      onClick={() => setDialog({ agentId: a.id })}
                    >
                      <AgentAvatar agent={a} size={20} />
                      <span className="ellipsis">{a.name}</span>
                    </button>
                    <button className="chip-add" title={`Put ${a.name} on this work item without starting anything`} onClick={() => void addTeammate(item.id, a.id)}>
                      +
                    </button>
                  </span>
                );
              })}
            </div>
          </>
        )}
      </section>

      <h2 className="h2 section">Conversations</h2>
      {convs.length === 0 && <p className="muted">None yet. Pick a teammate above and prompt them; a second conversation on a computer that is up starts from the sidebar's +.</p>}
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
              <TwoStep
                label="Remove"
                className="danger small"
                title={
                  comp.live
                    ? `Retire this computer and take it out of "${item.title}". Its conversations stay on Fountain; put it back below.`
                    : `Take this computer out of "${item.title}". Its conversations stay on Fountain; put it back below.`
                }
                onConfirm={() => void removeComputer(item.id, comp.key)}
              />
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

      {item.removedComputers.length > 0 && (
        <details className="removed-computers">
          <summary>
            {item.removedComputers.length} computer{item.removedComputers.length === 1 ? "" : "s"} removed from this item
          </summary>
          <p className="muted small">
            Out of this item, not gone: their conversations are still on {project.ownerEmail}'s Fountain, and what they spent is still on the bill.
          </p>
          <ul className="member-list">
            {item.removedComputers.map((r) => (
              <li key={r.key} className="member-row">
                <span className="computer-icon">🖥</span>
                <div className="min0 grow">
                  <div className="strong ellipsis">{r.key.startsWith("conv:") ? "a computer that never started" : computerLabel({ sandbox: sandboxes.get(r.key) ?? null, sandboxId: r.key })}</div>
                  <div className="muted small ellipsis">
                    removed by {r.by} · {relativeTime(r.at)}
                  </div>
                </div>
                <button className="small" title="Show this computer on the item again" onClick={() => void restoreComputer(item.id, r.key)}>
                  Put back
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {dialog && <StartDialog itemId={item.id} initialAgentId={dialog.agentId} onClose={() => setDialog(null)} />}
    </div>
  );
}
