/**
 * A tab, rendered as terminal scrollback.
 *
 * It is not a PTY and does not pretend to be one: what you type is a prompt to
 * the agent living on the box, and what scrolls past is that agent's turn,
 * parsed by the suite's ACP reader (`packages/fountain-app/src/acp.ts`) into
 * text, thinking and tool calls. Tool calls are drawn the way Claude Code
 * draws them, because that is what is actually happening.
 *
 * The one piece of real terminal behaviour that matters here is the prompt
 * line's states, and they are honest about the machine: a box runs one turn at
 * a time, so a tab whose box is busy elsewhere says so and queues rather than
 * failing. See `lib/tabs.ts`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { blocksForTurn, type Block } from "../lib/acp";
import type { Tab } from "../lib/tabs";
import type { LogEvent } from "../api/types";

export interface TerminalProps {
  tab: Tab;
  events: LogEvent[];
  /** The tab holding the machine, when it is not this one. */
  blockedBy: string | null;
  /** Queued locally because the box was busy; sent when it frees up. */
  queued: string | null;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  loading: boolean;
}

export function Terminal({ tab, events, blockedBy, queued, onSend, onInterrupt, loading }: TerminalProps) {
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);

  const blocks = useMemo(() => blocksForTurn(events, tab.conversation.runtime), [events, tab.conversation.runtime]);

  // Follow the tail, but stop following the moment the reader scrolls up —
  // reading output while it is still coming is the normal thing to do.
  useEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [blocks, queued]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  function submit() {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  }

  const running = tab.busy;

  return (
    <div className="terminal">
      <div className="terminal-scroll" ref={scroller} onScroll={onScroll}>
        <div className="terminal-head">
          <span className="dim">{tab.cwd}</span>
          {tab.stale && (
            <span className="badge warn" title="This tab started before the current settings. Open a new tab to pick them up.">
              older settings
            </span>
          )}
        </div>

        {loading && <div className="dim">reading scrollback…</div>}
        {!loading && blocks.length === 0 && (
          <div className="dim">
            Nothing yet. This is a Claude Code session on your machine — ask it for something.
          </div>
        )}

        {blocks.map((b, i) => (
          <BlockView key={i} block={b} />
        ))}

        {queued && (
          <div className="queued">
            <span className="dim">queued</span> {queued}
          </div>
        )}
      </div>

      <div className="prompt">
        <span className={`sigil ${running ? "working" : ""}`}>{running ? "◐" : "›"}</span>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          spellCheck={false}
          placeholder={
            blockedBy ? `${blockedBy} has the machine — this will go next` : running ? "working… (Enter queues)" : "say something"
          }
        />
        {running ? (
          <button className="ghost" onClick={onInterrupt} title="Interrupt this turn">
            stop
          </button>
        ) : (
          <button className="ghost" onClick={submit} disabled={!draft.trim()}>
            send
          </button>
        )}
      </div>

      {blockedBy && (
        <div className="prompt-note">
          One turn at a time on a box. <strong>{blockedBy}</strong> is working; anything you send waits for it.
        </div>
      )}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  if (block.kind === "text") return <div className="say">{block.body}</div>;
  if (block.kind === "thinking") return <div className="think">{block.body}</div>;
  if (block.kind === "raw") return <div className="raw">{block.body}</div>;

  const mark = block.status === "running" ? "⏺" : block.status === "error" ? "⨯" : "⏺";
  return (
    <div className={`tool ${block.status}`}>
      <div className="tool-head">
        <span className="mark">{mark}</span> {block.name}
        {block.summary ? <span className="dim">({block.summary})</span> : null}
      </div>
      {block.output.trim() && <div className="tool-out">⎿ {clip(block.output.trim())}</div>}
    </div>
  );
}

/** Tool output is scrollback, not a document: keep the head and say what was cut. */
function clip(s: string, lines = 16): string {
  const all = s.split("\n");
  if (all.length <= lines) return s;
  return `${all.slice(0, lines).join("\n")}\n… ${all.length - lines} more lines`;
}
