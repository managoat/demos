import { useCallback, useEffect, useState } from "react";
import type { FountainClient } from "../api/client";
import { describeError } from "../api/client";
import type { Runner } from "../api/types";
import { formatTime } from "./Roster";

/**
 * Self-hosted runners (fountain ADR 0022): the machines of yours that serve
 * sandboxes. Read-mostly — a machine registers itself by running
 * `fountain runner`; here you see which are online and can forget one.
 */
export function Runners({ client, onBack, toast, fountainUrl, refreshKey }: { client: FountainClient; onBack: () => void; toast: (t: string, k?: "info" | "error") => void; fountainUrl: string; refreshKey: number }) {
  const [runners, setRunners] = useState<Runner[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRunners(await client.listRunners());
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const forget = async (r: Runner) => {
    if (!window.confirm(`Forget ${r.name}? A daemon still running there simply reconnects and re-registers.`)) return;
    setBusy(r.id);
    try {
      await client.deleteRunner(r.id);
      toast(`Forgot ${r.name}`);
      await refresh();
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="thread runners">
      <header className="thread-header">
        <button className="back" onClick={onBack} aria-label="Back to the team">
          ‹ Team
        </button>
        <div className="thread-title">
          <div className="name">Runners</div>
          <div className="sub">Your own machines as a teammate's computer — the agent runs there, as you, with your files and network.</div>
        </div>
        <div className="row">
          <a className="button secondary small" href={`${fountainUrl}/account/runners`} target="_blank" rel="noreferrer">
            In Fountain
          </a>
        </div>
      </header>
      <div className="routines-body">
        <div className="runner-howto">
          <div className="small muted">On the machine, once signed in with a full-scope key:</div>
          <pre>
            <code>{"fountain auth login\nfountain runner                 # name = this machine's hostname\nfountain runner --name mini --root ~/work/fountain-sandboxes"}</code>
          </pre>
          <div className="small muted">
            Then put a teammate on it: right-click them → <b>Run on your own machine…</b> (or Customize → Computer → your own machine) and restart their computer. New computers land on your most recently connected online runner.{" "}
            <b>Trusted mode:</b> there is no VM or container between the agent and the machine — run it where you would hand a capable colleague a shell.{" "}
            <a href="https://github.com/BinaryBourbon/fountain/blob/main/docs/integrations/runners.md" target="_blank" rel="noreferrer">
              Guide
            </a>
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        {runners === null && !error && <div className="muted">Loading…</div>}
        {runners && runners.length === 0 && <div className="muted">No machine has connected yet.</div>}
        {runners && runners.length > 0 && (
          <ul className="routine-list">
            {runners.map((r) => (
              <li key={r.id} className={`routine runner ${r.online ? "" : "disabled"}`}>
                <div className="routine-main">
                  <div className="routine-title">
                    <span className={`presence inline ${r.online ? "online" : "machine_offline"}`} />
                    <span className="name">{r.name}</span>
                    <span className="tag">{r.online ? "online" : "offline"}</span>
                  </div>
                  <div className="mono muted small">
                    {r.hostname}
                    {r.os || r.arch ? ` · ${[r.os, r.arch].filter(Boolean).join("/")}` : ""}
                    {r.version ? ` · ${r.version}` : ""}
                  </div>
                  {r.root && <div className="mono muted small">{r.root}</div>}
                  <div className="small muted">
                    {r.online && r.connected_at ? `Connected ${formatTime(r.connected_at)}` : r.last_seen_at ? `Last seen ${formatTime(r.last_seen_at)}` : "Never seen"}
                  </div>
                </div>
                <div className="routine-actions">
                  <button className="danger small" disabled={busy === r.id} onClick={() => void forget(r)}>
                    Forget
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
