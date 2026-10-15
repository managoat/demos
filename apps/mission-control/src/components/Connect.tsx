/**
 * Assemble the crew: reuse an existing Mission Control coordinator agent
 * (and the Mission Worker agent, if present), or create both from the
 * built-in specs. The coordinator runs on one conversation bound to the
 * mission-control channel; workers are launched per task, one fresh
 * computer each.
 */
import { useEffect, useMemo, useState } from "react";
import { describeError, type FountainClient } from "../api/client";
import type { Agent, Catalog } from "../api/types";
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

/**
 * The ACP runtime a model runs on: Claude models on claude, OpenAI models on codex. This app reads the
 * ACP stream, so nothing else is offered: Google models' only runtime, gemini, doesn't speak ACP.
 */
function acpRuntime(model: string, runtimes: string[]): string | null {
  const want = model.startsWith("anthropic/") ? "claude" : model.startsWith("openai/") ? "codex" : null;
  return want && runtimes.includes(want) ? want : null;
}

/** The runtime for a model the picker offered; one with no ACP runtime is refused. */
function runtimeFor(model: string, runtimes: string[]): string {
  const runtime = acpRuntime(model, runtimes);
  if (!runtime) throw new Error(`${model} has no ACP runtime on this Fountain (only Anthropic and OpenAI models do)`);
  return runtime;
}

export function Connect(props: {
  client: FountainClient;
  onReady: (crew: Crew) => void;
  onSignOut: () => void;
}) {
  const { client } = props;
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([client.listAgents(COORDINATOR_NAME), client.getCatalog()])
      .then(([a, c]) => {
        if (cancelled) return;
        setAgents(a);
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
    () => (agents ?? []).filter((a) => a.name === COORDINATOR_NAME),
    [agents],
  );
  const models = useMemo(
    () => [...new Set(Object.values(catalog?.models ?? {}).flat())].filter((m) => acpRuntime(m, catalog?.runtimes ?? [])),
    [catalog],
  );

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
        {agents === null ? (
          <p className="fineprint">Loading your agents…</p>
        ) : (
          <>
            {existing.length > 0 && (
              <div className="connect-section">
                <h3>Use an existing coordinator</h3>
                {existing.map((a) => (
                  <button key={a.id} className="rowbtn" disabled={busy} onClick={() => void reuse(a.id)}>
                    <b>{a.name}</b>
                    <span>{a.model}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="connect-section">
              <h3>{existing.length ? "Or assemble a fresh crew" : "Assemble the crew"}</h3>
              <p className="fineprint">
                Creates a <code>{COORDINATOR_NAME}</code> coordinator agent (it plans and synthesizes, never
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
