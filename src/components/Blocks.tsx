import { useEffect, useState } from "react";
import { renderMarkdown } from "../lib/markdown";
import { timeLeft, type ShownBlock } from "../lib/blocks";
import { describeError, errorCode } from "../lib/errors";

export type AnswerRequest = (requestId: string, optionId: string) => Promise<void>;

/** One block of the agent's reply. */
export function BlockView({ block, onAnswer }: { block: ShownBlock; onAnswer?: AnswerRequest }) {
  switch (block.kind) {
    case "text":
      return <div className="block text md">{renderMarkdown(block.body ?? "")}</div>;
    case "thinking":
      return (
        <details className="block thinking">
          <summary>Thinking</summary>
          <div className="body">{block.body}</div>
        </details>
      );
    case "tool_use": {
      const b = block as Extract<ShownBlock, { kind: "tool_use" }>;
      const status = b.result ? (b.result.error ? "error" : "done") : "running";
      return (
        <details className={`block tool ${status}`}>
          <summary>
            <span className="tool-status">{status === "running" ? "◌" : status === "done" ? "✓" : "✕"}</span>
            <span className="tool-name">{b.name ?? "tool"}</span>
            {b.summary && <span className="tool-summary">{b.summary}</span>}
          </summary>
          {b.body && (
            <div className="tool-section">
              <div className="label">input</div>
              <pre>{b.body}</pre>
            </div>
          )}
          {b.result && (
            <div className="tool-section">
              <div className="label">{b.result.error ? "error" : "result"}</div>
              <pre className={b.result.error ? "err" : ""}>{b.result.body}</pre>
            </div>
          )}
        </details>
      );
    }
    case "tool_result":
      return (
        <details className={`block tool ${block.error ? "error" : "done"}`}>
          <summary>
            <span className="tool-name">result</span>
            <span className="tool-summary mono">{block.tool_id}</span>
          </summary>
          <pre>{block.body}</pre>
        </details>
      );
    case "permission_request":
      return <PermissionCard block={block as PermissionBlock} onAnswer={onAnswer} />;
    case "init":
      return null;
    case "result":
      return null;
    case "error":
      return <div className="block error">✕ {block.body}</div>;
    case "raw":
    default:
      return (
        <details className="block raw">
          <summary>{block.summary ?? "raw"}</summary>
          <pre>{block.body}</pre>
        </details>
      );
  }
}

// ── permission requests ──────────────────────────────────────────────────
// An agent under an `ask` policy stops before the tool runs and the block
// carries the options the runtime offered — those and only those are the
// buttons. First answer wins; the resolution comes back on the stream and
// src/lib/blocks.ts folds it onto the block, so the card closes itself.

type PermissionBlock = Extract<ShownBlock, { kind: "permission_request" }>;

interface Choice {
  optionId: string;
  label: string;
  allow: boolean;
}

const TICK_MS = 15_000;

function choices(block: PermissionBlock): Choice[] {
  const out: Choice[] = [];
  for (const o of block.options ?? []) {
    const optionId = typeof o.optionId === "string" ? o.optionId : "";
    if (!optionId) continue;
    const kind = typeof o.kind === "string" ? o.kind : "";
    const name = typeof o.name === "string" && o.name ? o.name : kind || optionId;
    out.push({ optionId, label: name, allow: !kind.startsWith("reject") });
  }
  return out;
}

function PermissionCard({ block, onAnswer }: { block: PermissionBlock; onAnswer?: AnswerRequest }) {
  const { outcome, optionId, expiresAt } = block.permission;
  const requestId = typeof block.request_id === "string" ? block.request_id : null;
  const options = choices(block);
  const [sending, setSending] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const expired = Date.parse(expiresAt) <= now;
  const open = !outcome && !said && !expired;

  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, [open]);

  const answerable = !!onAnswer && !!requestId && options.length > 0;

  async function answer(choice: Choice) {
    if (!onAnswer || !requestId || sending) return;
    setSending(choice.optionId);
    setProblem(null);
    try {
      await onAnswer(requestId, choice.optionId);
      setSaid(`Answered — ${choice.label}.`);
    } catch (err) {
      if (errorCode(err) === "permission_request_resolved") setSaid("Already answered — somebody else got there first.");
      else setProblem(describeError(err));
    } finally {
      setSending(null);
    }
  }

  return (
    <div className={`block permission ${open ? "held" : "closed"}`}>
      <div className="permission-head">
        <span className="tool-name">{block.name ?? "a tool"}</span>
        {block.summary && <span className="tool-summary">{block.summary}</span>}
        {open && <span className="tiny muted">{timeLeft(expiresAt, now)}</span>}
      </div>
      {open ? (
        <>
          <div className="permission-ask">{answerable ? "Waiting on someone here before it runs." : "Waiting — and this ask carries nothing to answer it with."}</div>
          {answerable && (
            <div className="permission-options">
              {options.map((o) => (
                <button key={o.optionId} type="button" className={o.allow ? "primary small" : "small"} disabled={sending !== null} onClick={() => void answer(o)}>
                  {sending === o.optionId ? "…" : o.label}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="permission-ask muted">{settled(outcome, optionId, options, said)}</div>
      )}
      {problem && <div className="error small">{problem}</div>}
    </div>
  );
}

function settled(outcome: string | null, optionId: string | null, options: Choice[], said: string | null): string {
  const label = optionId ? (options.find((o) => o.optionId === optionId)?.label ?? optionId) : null;
  switch (outcome) {
    case null:
      break;
    case "answered":
      return label ? `Answered — ${label}.` : "Answered.";
    case "timeout":
      return "Nobody answered in five minutes, so Fountain refused it.";
    case "turn_ended":
      return "The turn ended before anyone answered.";
    default:
      return `Closed — ${outcome}.`;
  }
  return said ?? "Expired — Fountain refuses a request nobody answers in five minutes.";
}
