/**
 * The Run tab: saved commands, and a box to type one into.
 *
 * These go over Sprites rather than over Fountain, which is what makes them
 * free and out of band — they are not turns, they do not queue behind the
 * agent and they leave no trace in the transcript. What they are not is
 * streamed: `POST /exec` answers once, with the whole result. So this panel
 * shows a spinner and then the output, and never animates a progress bar it
 * has no information for. The terminal next door is the live one.
 *
 * The commands are the project's, not the thread's, because a build command
 * belongs to the repository and every thread in a project has the same one.
 */
import { useCallback, useEffect, useState } from "react";
import type { Capabilities, ExecResult, RunCommand, Thread } from "../../shared/api";
import type { ApiError } from "../api/client";
import * as api from "../api/client";
import { asApiError } from "./Changes";

export interface RunPanelProps {
  projectId: string;
  thread: Thread | null;
  capabilities: Capabilities;
}

interface Outcome {
  command: string;
  result: ExecResult;
}

export function RunPanel({ projectId, thread, capabilities }: RunPanelProps) {
  const [commands, setCommands] = useState<RunCommand[]>([]);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [line, setLine] = useState("");
  const [oneOff, setOneOff] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [runError, setRunError] = useState<ApiError | null>(null);

  const exec = capabilities.exec;

  const reload = useCallback(() => {
    if (!exec) return;
    api
      .runCommands(projectId)
      .then((next) => {
        setCommands(next);
        setListError(null);
      })
      .catch((err: unknown) => setListError(asApiError(err)));
  }, [exec, projectId]);

  useEffect(() => reload(), [reload]);

  if (!exec) {
    return (
      <div className="empty dd-in-empty">
        <span className="dd-in-empty-icon">
          <PlayIcon size={18} />
        </span>
        <h3>No Sprites token on this drydock</h3>
        <p>
          Running a command reaches the machine directly, beside the agent rather than through it — a build, a test suite, a push — with
          the output here and nothing added to the conversation.
        </p>
        <p>That path needs a Sprites token, and this deployment has none configured.</p>
        <p className="dd-in-empty-what">SPRITES_TOKEN</p>
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="empty dd-in-empty">
        <h3>No thread open</h3>
        <p>Commands run on a thread's own machine. Open one and its shell is here.</p>
      </div>
    );
  }

  const run = async (command: string) => {
    setRunning(command);
    setRunError(null);
    try {
      const result = await api.exec(thread.id, { command });
      setOutcome({ command, result });
    } catch (err) {
      setOutcome(null);
      setRunError(asApiError(err));
    } finally {
      setRunning(null);
    }
  };

  const save = async () => {
    const command = line.trim();
    if (!command) return;
    try {
      await api.addRunCommand(projectId, { label: label.trim() || command, command });
      setLabel("");
      setLine("");
      setAdding(false);
      reload();
    } catch (err) {
      setListError(asApiError(err));
    }
  };

  const forget = async (id: string) => {
    try {
      await api.removeRunCommand(projectId, id);
      reload();
    } catch (err) {
      setListError(asApiError(err));
    }
  };

  return (
    <div className="dd-in-run">
      <div className="dd-in-run-list">
        {listError ? <p className="fine error">{listError.message}</p> : null}
        {commands.length === 0 && !adding ? (
          <p className="dd-in-note" style={{ padding: "2px 2px 4px" }}>
            No saved commands. Save the ones you type more than once — they belong to the project, so every thread in it has them.
          </p>
        ) : null}
        {commands.map((cmd) => (
          <div key={cmd.id} className="dd-in-cmd">
            <button className="icon dd-in-cmd-play" title={`Run ${cmd.command}`} disabled={running !== null} onClick={() => void run(cmd.command)}>
              {running === cmd.command ? <span className="dd-in-spin" /> : <PlayIcon size={14} />}
            </button>
            <span className="dd-in-cmd-text">
              <span className="dd-in-cmd-label clip">{cmd.label}</span>
              {cmd.label !== cmd.command ? <span className="dd-in-cmd-line clip">{cmd.command}</span> : null}
            </span>
            <button className="icon" title="Forget this command" onClick={() => void forget(cmd.id)}>
              <XIcon />
            </button>
          </div>
        ))}
        {adding ? (
          <div className="dd-in-form" style={{ marginTop: 4 }}>
            <div>
              <label htmlFor="dd-in-cmd-label">Name</label>
              <input id="dd-in-cmd-label" value={label} placeholder="Tests" onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div>
              <label htmlFor="dd-in-cmd-line">Command</label>
              <input
                id="dd-in-cmd-line"
                value={line}
                spellCheck={false}
                style={{ fontFamily: "var(--mono)", fontSize: 12 }}
                placeholder="npm test"
                onChange={(e) => setLine(e.target.value)}
              />
            </div>
            <div className="dd-in-form-row">
              <span className="spacer" />
              <button onClick={() => setAdding(false)}>Cancel</button>
              <button className="primary" disabled={!line.trim()} onClick={() => void save()}>
                Save
              </button>
            </div>
          </div>
        ) : (
          <button className="ghost" style={{ alignSelf: "flex-start" }} onClick={() => setAdding(true)}>
            + Save a command
          </button>
        )}
      </div>

      <form
        className="dd-in-run-bar"
        onSubmit={(e) => {
          e.preventDefault();
          const command = oneOff.trim();
          if (command) void run(command);
        }}
      >
        <input
          value={oneOff}
          spellCheck={false}
          placeholder={`Run once in ${thread.workdir}`}
          disabled={running !== null}
          onChange={(e) => setOneOff(e.target.value)}
        />
        <button type="submit" disabled={running !== null || !oneOff.trim()}>
          Run
        </button>
      </form>

      <div className="dd-in-out">
        {running !== null ? (
          <span className="row" style={{ color: "var(--dim)", fontFamily: "var(--sans)" }}>
            <span className="dd-in-spin" />
            <span className="mono">{running}</span>
          </span>
        ) : runError ? (
          <span className="dd-in-out-err">{runError.message}</span>
        ) : outcome ? (
          <Output outcome={outcome} />
        ) : (
          <span style={{ color: "var(--faint)", fontFamily: "var(--sans)" }}>
            Output lands here. Nothing run on this machine reaches the conversation.
          </span>
        )}
      </div>
    </div>
  );
}

function Output({ outcome }: { outcome: Outcome }) {
  const { command, result } = outcome;
  const clean = result.code === 0;
  return (
    <>
      <span className="dd-in-out-cmd">$ {command}</span>
      {result.stdout}
      {result.stderr ? <span className="dd-in-out-err">{result.stderr}</span> : null}
      {!result.stdout && !result.stderr ? <span style={{ color: "var(--faint)" }}>(no output)</span> : null}
      <span className="dd-in-out-foot">
        <span className={`chip ${clean ? "ok" : "bad"}`}>exit {result.code}</span>
        <span className="faint" style={{ fontSize: 11 }}>{formatMs(result.durationMs)}</span>
        {result.timedOut ? <span className="chip warn">timed out</span> : null}
        <span className="spacer" />
        <span className="faint mono" style={{ fontSize: 11 }}>{result.cwd}</span>
      </span>
    </>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function PlayIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M5 3.4v9.2a.5.5 0 0 0 .76.43l7.4-4.6a.5.5 0 0 0 0-.86l-7.4-4.6A.5.5 0 0 0 5 3.4Z" strokeLinejoin="round" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" strokeLinecap="round" />
    </svg>
  );
}
