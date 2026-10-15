import { useMemo, useState } from "react";
import { useStore } from "../store";
import { navigate, paths } from "../router";
import { loadPrefs, savePrefs, type SortKey } from "../lib/prefs";
import { formatTime } from "../lib/format";
import { cleanTitle, relativeTime } from "../lib/sidebar";
import { describeError } from "../api/client";
import type { Conversation } from "../api/types";
import { StatusPill } from "../components/StatusPill";

/**
 * Every conversation as a table, the way the web UI's index listed them:
 * status, the task, the agent, runtime, where it came from, and when — with
 * the two date columns sortable, and terminate/delete per row.
 */
export function IndexPage() {
  const { client, conversations, agents, error, refresh, toast } = useStore();
  const [prefs, setPrefs] = useState(() => loadPrefs());
  const [busy, setBusy] = useState<string | null>(null);
  const setPref = (p: Partial<typeof prefs>) => setPrefs(savePrefs(p));

  const rows = useMemo(() => {
    let list = conversations;
    if (prefs.rootsOnly) list = list.filter((c) => !c.parent_conversation_id);
    const at = (c: Conversation) => (prefs.sortBy === "inserted_at" ? c.inserted_at : c.last_active_at ?? c.updated_at ?? c.inserted_at) ?? "";
    const dir = prefs.sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => at(a).localeCompare(at(b)) * dir);
  }, [conversations, prefs.rootsOnly, prefs.sortBy, prefs.sortDir]);

  // Clicking the column you are on flips the direction; a new column starts newest-first.
  const sortBy = (key: SortKey) =>
    setPref(prefs.sortBy === key ? { sortDir: prefs.sortDir === "desc" ? "asc" : "desc" } : { sortBy: key, sortDir: "desc" });

  const arrow = (key: SortKey) => (prefs.sortBy !== key ? "↕" : prefs.sortDir === "desc" ? "↓" : "↑");

  const act = async (id: string, label: string, fn: () => Promise<unknown>, confirm: string) => {
    if (!window.confirm(confirm)) return;
    setBusy(id);
    try {
      await fn();
      toast(label);
      await refresh();
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1>Conversations</h1>
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={prefs.rootsOnly} onChange={(e) => setPref({ rootsOnly: e.target.checked })} />
            roots only
          </label>
          <button onClick={() => navigate(paths.new())}>+ New conversation</button>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      {rows.length === 0 && !error ? (
        <div className="empty">
          <p>No conversations yet. Start one to see it here.</p>
          <p className="muted">Pick an agent, give it a first prompt, and watch it work.</p>
          <button onClick={() => navigate(paths.new())}>+ New conversation</button>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Task</th>
                <th>Agent</th>
                <th>Runtime</th>
                <th>Source</th>
                <th className="sortable" onClick={() => sortBy("inserted_at")}>
                  Started <span className={prefs.sortBy === "inserted_at" ? "" : "faded"}>{arrow("inserted_at")}</span>
                </th>
                <th className="sortable" onClick={() => sortBy("last_active_at")}>
                  Last active <span className={prefs.sortBy === "last_active_at" ? "" : "faded"}>{arrow("last_active_at")}</span>
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const agent = c.agent_id ? agents.get(c.agent_id) : undefined;
                const task = c.title || cleanTitle(c.first_prompt, 120);
                const live = c.status !== "terminated" && c.status !== "failed";
                return (
                  <tr key={c.id} className={busy === c.id ? "busy" : ""}>
                    <td>
                      <StatusPill status={c.status} sandbox={c.sandbox?.status} />
                    </td>
                    <td className="task" title={c.first_prompt ?? undefined}>
                      <a href={paths.show(c.id)}>
                        {c.unread && <span className="unread-dot" title="Unread" />}
                        <span className={c.unread ? "strong" : ""}>{task ?? "—"}</span>
                      </a>
                      {c.parent_conversation_id && <span className="tag">sub</span>}
                      {c.channel_id && <span className="tag">{c.channel_id === "fountain:team" ? "team" : "channel"}</span>}
                    </td>
                    <td>
                      <a href={paths.show(c.id)} className="plain">
                        {c.agent_id ? agent?.name ?? "(deleted agent)" : "(no agent)"}
                      </a>
                      <div className="mono muted small">{c.id.slice(0, 8)}</div>
                    </td>
                    <td className="muted">{c.runtime}</td>
                    <td>
                      <SourceBadge source={c.source} />
                    </td>
                    <td className="muted small" title={formatTime(c.inserted_at)}>
                      {relativeTime(c.inserted_at)}
                    </td>
                    <td className="muted small" title={formatTime(c.last_active_at ?? c.updated_at)}>
                      {relativeTime(c.last_active_at ?? c.updated_at)}
                    </td>
                    <td className="row-actions">
                      {live && (
                        <button
                          className="danger small"
                          disabled={busy === c.id}
                          onClick={() => void act(c.id, "Terminated", () => client.terminate(c.id), "Terminate this conversation?")}
                        >
                          Terminate
                        </button>
                      )}
                      <button
                        className="secondary small"
                        disabled={busy === c.id}
                        onClick={() =>
                          void act(c.id, "Deleted", () => client.deleteConversation(c.id), "Delete this conversation and all its turns? This cannot be undone.")
                        }
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Where the conversation came from — a person, an agent that spawned it, or the API. */
function SourceBadge({ source }: { source: string }) {
  const label = source === "ui" ? "UI" : source === "agent" ? "Agent" : "API";
  return <span className={`badge src-${source}`}>{label}</span>;
}
