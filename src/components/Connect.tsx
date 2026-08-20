/**
 * Assemble the crew: reuse a teammate already running the Mission Control
 * coordinator (and the Mission Worker agent, if present), or create both
 * from the built-in specs. The coordinator joins the team; workers are
 * launched per task, one fresh computer each.
 */
import { useEffect, useMemo, useState } from "react";
import { describeError, type FountainClient } from "../api/client";
import type { Catalog, Teammate } from "../api/types";
import type { Crew } from "../lib/crew";
import {
  COORDINATOR_DESCRIPTION,
  COORDINATOR_NAME,
  COORDINATOR_PROMPT,
  WORKER_DESCRIPTION,
  WORKER_NAME,
  WORKER_PROMPT,
} from "../lib/spec";

const DEFAULT_MODEL = "anthropic/claude-sonnet-5";

/** Claude models run on claude, OpenAI on codex, the rest on opencode. */
function runtimeFor(model: string, runtimes: string[]): string {
  const provider = model.split("/")[0] ?? "";
  const want = provider === "anthropic" ? "claude" : provider === "openai" ? "codex" : "opencode";
  if (runtimes.includes(want)) return want;
  return runtimes.includes("opencode") ? "opencode" : runtimes[0] ?? want;
}

export function Connect(props: {
  client: FountainClient;
  onReady: (crew: Crew) => void;
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
        const all = Object.values(c.models).flat();
        setModel((cur) => cur || (all.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : all.find((m) => m.startsWith("anthropic/")) ?? all[0] ?? ""));
      })
      .catch((err) => !cancelled && setError(describeError(err)));
    return () => {
      cancelled = true;
    };
  }, [client]);

  const existing = useMemo(
    () => (team ?? []).filter((t) => t.agent.name === COORDINATOR_NAME || t.name === COORDINATOR_NAME),
    [team],
  );
  const models = useMemo(() => [...new Set(Object.values(catalog?.models ?? {}).flat())], [catalog]);

  /** The worker agent, created once and reused ever after. */
  const ensureWorker = async (): Promise<string> => {
    const agents = await client.listAgents(WORKER_NAME);
    const found = agents.find((a) => a.name === WORKER_NAME);
    if (found) return found.id;
    if (!catalog) throw new Error("catalog not loaded");
    const agent = await client.createAgent({
      name: WORKER_NAME,
      description: WORKER_DESCRIPTION,
      model,
      runtime: runtimeFor(model, catalog.runtimes),
      system: WORKER_PROMPT,
    });
    return agent.id;
  };

  const reuse = async (coordinatorId: string) => {
    setBusy(true);
    setError(null);
    try {
      props.onReady({ coordinatorId, workerId: await ensureWorker() });
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  const assemble = async () => {
    if (!model || !catalog) return;
    setBusy(true);
    setError(null);
    try {
      const workerId = await ensureWorker();
      const coordinator = await client.createAgent({
        name: COORDINATOR_NAME,
        description: COORDINATOR_DESCRIPTION,
        model,
        runtime: runtimeFor(model, catalog.runtimes),
        system: COORDINATOR_PROMPT,
      });
      await client.addTeammate({ agent_id: coordinator.id, name: COORDINATOR_NAME });
      props.onReady({ coordinatorId: coordinator.id, workerId });
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="wordmark">
          MISSION<span>CONTROL</span>
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
                  <button key={t.agent_id} className="rowbtn" disabled={busy} onClick={() => void reuse(t.agent_id)}>
                    <b>{t.name}</b>
                    <span>{t.presence.label}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="connect-section">
              <h3>{existing.length ? "Or assemble a fresh crew" : "Assemble the crew"}</h3>
              <p className="fineprint">
                Creates a <code>{COORDINATOR_NAME}</code> coordinator on your team (it plans and synthesizes, never
                executes) and a <code>{WORKER_NAME}</code> agent launched once per task, each on its own computer.
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
              <button className="primary" onClick={() => void assemble()} disabled={busy || !model}>
                {busy ? "Assembling…" : "Create agents & assemble"}
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
