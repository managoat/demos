import { useEffect, useState } from "react";
import { renderMarkdown } from "../lib/markdown";
import { timeLeft } from "../lib/digest";
import { describeError, errorCode } from "../lib/errors";
import type { ShownBlock } from "../lib/blocks";

/** Answer a permission request: the id off the block, and one of the options that block carried. */
export type AnswerRequest = (requestId: string, optionId: string) => Promise<void>;

/** One block, in either view. Chat mode passes `bubble` for text. */
export function BlockView({ block, bubble = false, onAnswer }: { block: ShownBlock; bubble?: boolean; onAnswer?: AnswerRequest }) {
  switch (block.kind) {
    case "text":
      return bubble ? (
        <div className="bubble them">
          <div className="body md">{renderMarkdown(block.body ?? "")}</div>
        </div>
      ) : (
        <div className="block text md">{renderMarkdown(block.body ?? "")}</div>
      );
    case "thinking":
      return (
        <details className="block thinking">
          <summary>thinking</summary>
          <div className="body">{block.body}</div>
        </details>
      );
    case "tool_use": {
      const b = block as Extract<ShownBlock, { kind: "tool_use" }>;
      const status = b.result ? (b.result.error ? "error" : "done") : "running";
      return (
        <details className={`block tool ${status}`}>
          <summary>
            <span className="tool-name">{b.name ?? "tool"}</span>
            {b.summary && <span className="tool-summary">{b.summary}</span>}
            <span className="tool-status">{status === "running" ? "…" : status === "done" ? "✓" : "✕"}</span>
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
      return (
        <details className="block init">
          <summary>{block.summary ?? "session started"}</summary>
          {block.body && <pre>{block.body}</pre>}
        </details>
      );
    case "result":
      return (
        <details className="block result">
          <summary>✓ {block.body}</summary>
          {block.raw && <pre>{block.raw}</pre>}
        </details>
      );
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
//
// An agent under an `ask` permission stops before the tool runs, and Fountain
// puts the ask on the conversation as a `permission_request` block. It is the
// one block a person has to answer: until somebody does, the turn is standing
// still, and after five minutes Fountain refuses the tool for you.
//
// Two rules from docs/concepts/permissions.md are the whole design of the card.
// **An option must come from the runtime** — the buttons are exactly the
// options the block carried, in its order, and nothing is invented here (the
// runtimes disagree: gemini's ids are `proceed_once` and `cancel`). **The
// first answer wins** — another client, the timeout, or the turn ending may
// get there first, which is a 409 and nothing to retry. Either way the
// resolution comes back down the stream as `request · done`, and
// `src/lib/blocks.ts` folds it onto this block, so the card closes itself
// whoever answered.

type PermissionBlock = Extract<ShownBlock, { kind: "permission_request" }>;

/** One of the runtime's own options, read off the block. */
interface Choice {
  optionId: string;
  label: string;
  /** Whether it lets the tool run — styling only; the id is what is sent. */
  allow: boolean;
}

/** How often a held card re-reads the clock. Only the countdown moves. */
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
  /** What answering taught us before the stream caught up: our own answer, or a lost race. */
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
      // Too late is not a failure and not something to send again: the request
      // is gone and the stream says how it ended.
      if (errorCode(err) === "permission_request_resolved") setSaid("Already answered — somebody else got there first.");
      else setProblem(describeError(err));
    } finally {
      setSending(null);
    }
  }

  return (
    <div className={`block permission ${open ? "held" : "closed"}`}>
      <div className="permission-head">
        <span className="permission-mark" aria-hidden="true">
          {open ? "⏸" : "·"}
        </span>
        <span className="tool-name">{block.name ?? "a tool"}</span>
        {block.summary && <span className="tool-summary">{block.summary}</span>}
        {open && <span className="pill pending tiny">{timeLeft(expiresAt, now)}</span>}
      </div>
      {open ? (
        <>
          <div className="permission-ask">{answerable ? "Waiting on you before it runs." : "Waiting on you — and this ask carries nothing to answer it with."}</div>
          {answerable && (
            <div className="permission-options">
              {options.map((o) => (
                <button key={o.optionId} className={o.allow ? "small" : "secondary small"} disabled={sending !== null} onClick={() => void answer(o)}>
                  {sending === o.optionId ? "…" : o.label}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="permission-ask muted">{settled(outcome, optionId, options, said)}</div>
      )}
      {problem && <div className="permission-problem">{problem}</div>}
    </div>
  );
}

/** One line for a request nobody can answer any more. */
function settled(outcome: string | null, optionId: string | null, options: Choice[], said: string | null): string {
  const label = optionId ? options.find((o) => o.optionId === optionId)?.label ?? optionId : null;
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
