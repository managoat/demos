/**
 * The team is the project owner's agent list on Fountain. Nothing to define
 * here — a teammate is pulled onto a work item by picking one of these.
 */
import { useProject, useWorkbench } from "../store";
import { channelPrefix } from "../lib/workbench";
import { AgentAvatar } from "../components/AgentAvatar";
import { href } from "../router";

export function Team() {
  const { me } = useWorkbench();
  const { project, items, isOwner, agents, environments, resourcesLoaded, conversations } = useProject();
  const team = [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  const prefix = channelPrefix(project.id);

  return (
    <div className="page narrow">
      <div className="page-header">
        <div>
          <h1>Team</h1>
          <div className="muted small">
            {isOwner ? "Your" : `${project.ownerEmail}'s`} agents on Fountain. Pull one onto a work item to talk to it there; the project supplies the environment and vault.
          </div>
        </div>
        {isOwner && (
          <a className="button secondary small" href={`${me.fountainUrl}/agents`} target="_blank" rel="noreferrer">
            Manage agents ↗
          </a>
        )}
      </div>

      {!resourcesLoaded && <p className="muted">Loading agents…</p>}
      {resourcesLoaded && team.length === 0 && (
        <div className="empty card">
          <p className="strong">No agents yet.</p>
          <p className="muted">{isOwner ? "Create one in the Fountain console; it shows up here." : `${project.ownerEmail} has not created any agents on Fountain yet.`}</p>
        </div>
      )}

      <ul className="conv-list">
        {team.map((a) => {
          const on = items.filter((w) => w.agentIds.includes(a.id) && w.status === "open");
          const live = conversations.filter((c) => c.agent_id === a.id && c.channel_id?.startsWith(prefix) && (c.status === "running" || c.status === "pending")).length;
          return (
            <li key={a.id}>
              <div className="conv-row">
                <AgentAvatar agent={a} size={36} />
                <div className="conv-main">
                  <div className="conv-title">
                    <span className="strong">{a.name}</span>
                    {live > 0 && <span className="pill running">{live} working</span>}
                  </div>
                  <div className="conv-sub muted">
                    {a.runtime} · {a.model}
                    {a.environment_id ? ` · own env ${environments.get(a.environment_id)?.name ?? ""}` : ""}
                    {a.description ? ` · ${a.description}` : ""}
                  </div>
                  {on.length > 0 && (
                    <div className="conv-sub muted small">
                      On:{" "}
                      {on.map((w, i) => (
                        <span key={w.id}>
                          {i > 0 ? ", " : ""}
                          <a href={href.item(w.projectId, w.id)}>{w.title}</a>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
