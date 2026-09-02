/**
 * Pick the researcher: reuse a teammate that already runs the briefing-room
 * agent, or create the agent from the built-in spec and hire it. No vault —
 * the researcher reads the open web and holds no credentials.
 */
import { useEffect, useMemo, useState } from "react";
import { describeError, type FountainClient } from "../api/client";
import type { Catalog, Teammate } from "../api/types";
import { AGENT_DESCRIPTION, AGENT_NAME, SYSTEM_PROMPT } from "../lib/spec";

/** Claude models run on claude, OpenAI on codex, the rest on opencode. */
function runtimeFor(model: string, runtimes: string[]): string {
  const provider = model.split("/")[0] ?? "";
  const want = provider === "anthropic" ? "claude" : provider === "openai" ? "codex" : "opencode";
  if (runtimes.includes(want)) return want;
  return runtimes.includes("opencode") ? "opencode" : runtimes[0] ?? want;
}

export function Connect(props: {
  client: FountainClient;
  onReady: (agentId: string) => void;
  onSignOut: () => void;
}) {
  const { client } = props;
  const [team, setTeam] = useState<Teammate[] | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([client.listTeam(), client.getCatalog()])
      .then(([t, c]) => {
        if (cancelled) return;
        setTeam(t);
        setCatalog(c);
        setModel((cur) => cur || Object.values(c.models).flat().find((m) => m.startsWith("anthropic/")) || Object.values(c.models).flat()[0] || "");
      })
      .catch((err) => !cancelled && setError(describeError(err)));
    return () => {
      cancelled = true;
    };
  }, [client]);

  const existing = useMemo(() => (team ?? []).filter((t) => t.agent.name === AGENT_NAME || t.name === AGENT_NAME || t.name === "Briefing Room"), [team]);
  const models = useMemo(() => [...new Set(Object.values(catalog?.models ?? {}).flat())], [catalog]);

  const hire = async () => {
    if (!model || !catalog) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await client.createAgent({
        name: AGENT_NAME,
        description: AGENT_DESCRIPTION,
        model,
        runtime: runtimeFor(model, catalog.runtimes),
        system: SYSTEM_PROMPT,
      });
      await client.addTeammate({ agent_id: agent.id, name: "Briefing Room" });
      props.onReady(agent.id);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="wordmark">
          Briefing <span>Room</span>
        </div>
        {error && <p className="error">{error}</p>}
        {team === null ? (
          <p className="fineprint">Loading your team…</p>
        ) : (
          <>
            {existing.length > 0 && (
              <div className="connect-section">
                <h3>Already on your team</h3>
                {existing.map((t) => (
                  <button key={t.agent_id} className="rowbtn" onClick={() => props.onReady(t.agent_id)}>
                    <b>{t.name}</b>
                    <span>{t.presence.label}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="connect-section">
              <h3>{existing.length ? "Or hire a fresh researcher" : "Hire the researcher"}</h3>
              <p className="fineprint">
                Creates a <code>{AGENT_NAME}</code> agent with the room's operating rules and adds it to your team.
                It gets its own computer with internet access; it holds no credentials of yours.
              </p>
              <label>
                Brain
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <button className="primary" onClick={() => void hire()} disabled={busy || !model}>
                {busy ? "Hiring…" : "Create agent & hire"}
              </button>
            </div>
          </>
        )}
        <button className="linkish" onClick={props.onSignOut}>
          sign out
        </button>
      </div>
    </div>
  );
}
