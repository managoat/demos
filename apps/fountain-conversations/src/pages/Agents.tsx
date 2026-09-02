import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { paths } from "../router";
import { describeError } from "../api/client";
import type { Agent, Environment } from "../api/types";
import { AgentAvatar } from "../components/AgentAvatar";

export function AgentsPage() {
  const { client, toast } = useStore();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [envs, setEnvs] = useState<Map<string, Environment>>(new Map());
  const [search, setSearch] = useState("");
  const [runtime, setRuntime] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    Promise.all([client.listAgents(), client.listEnvironments()])
      .then(([a, e]) => {
        setAgents(a);
        setEnvs(new Map(e.map((x) => [x.id, x])));
        setError(null);
      })
      .catch((err) => setError(describeError(err)));

  useEffect(() => {
    void load();
  }, [client]); // eslint-disable-line react-hooks/exhaustive-deps

  const runtimes = useMemo(() => [...new Set((agents ?? []).map((a) => a.runtime))].sort(), [agents]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (agents ?? [])
      .filter((a) => !runtime || a.runtime === runtime)
      .filter((a) => !q || `${a.name} ${a.description ?? ""} ${a.model}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [agents, search, runtime]);

  async function remove(a: Agent) {
    if (!window.confirm(`Delete agent "${a.name}"? Its conversations stay; nothing else runs as it.`)) return;
    try {
      await client.deleteAgent(a.id);
      toast("Agent deleted");
      void load();
    } catch (err) {
      toast(describeError(err), "error");
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Agents</h1>
        <div className="row">
          <input className="compact" type="search" placeholder="search…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="compact" value={runtime} onChange={(e) => setRuntime(e.target.value)}>
            <option value="">all runtimes</option>
            {runtimes.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <a href={paths.agent("new")} className="button">
            New agent
          </a>
        </div>
      </header>
      {error && <div className="error">{error}</div>}
      {agents && agents.length === 0 && (
        <div className="empty">
          <p>No agents yet.</p>
          <p className="muted">An agent is a named, re-runnable config: model, runtime, system prompt, skills, MCP servers, environment.</p>
          <a href={paths.agent("new")} className="button">
            New agent
          </a>
        </div>
      )}
      <ul className="card-grid">
        {rows.map((a) => (
          <li key={a.id} className="card agent-card">
            <a href={paths.agent(a.id)} className="agent-card-main">
              <AgentAvatar agent={a} size={44} />
              <div className="min0">
                <div className="strong ellipsis">{a.name}</div>
                <div className="muted small ellipsis">
                  {a.runtime} · {a.model}
                </div>
                <div className="muted small ellipsis">
                  {a.environment_id ? envs.get(a.environment_id)?.name ?? "environment" : "no environment"}
                  {a.conversation_count ? ` · ${a.conversation_count} conversation${a.conversation_count === 1 ? "" : "s"}` : ""}
                  {a.skills?.length ? ` · ${a.skills.length} skill${a.skills.length === 1 ? "" : "s"}` : ""}
                  {a.mcp_servers && Object.keys(a.mcp_servers).length ? ` · ${Object.keys(a.mcp_servers).length} MCP` : ""}
                </div>
                {a.description && <div className="small ellipsis">{a.description}</div>}
              </div>
            </a>
            <div className="row">
              <a className="button small" href={`#/new`} onClick={() => sessionStorage.setItem("fountain-conversations.new-agent", a.id)}>
                Start
              </a>
              <button className="icon danger-icon" title="Delete" aria-label="Delete" onClick={() => void remove(a)}>
                ×
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
