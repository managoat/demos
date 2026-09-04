/**
 * The scrollback.
 *
 * Fountain stores a conversation as log events; `blocksForTurn` — shared with
 * the rest of this suite and ported from the server's own ACP parser — turns
 * one turn's events into text, thinking and tool chips. What this file adds is
 * everything about *reading* them, and one editorial decision that is
 * switchyard's own.
 *
 * The decision: turns switchyard sent itself are rendered differently from
 * turns a person sent. Opening a track, closing one, surveying the machine —
 * these are real turns on a real machine and hiding them would make the
 * transcript a lie about what the box has been doing. But they are also not
 * things anybody said, and dressed as a user message they read as if the app
 * had been typing in your name. So they are a dashed one-line note, and the
 * agent's reply to them is shown normally, because that part *is* the machine
 * doing your work and it is the most reassuring thing on the screen while a
 * worktree is being cut.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { blocksForTurn, type Block } from "@managoat/fountain-app/acp";
import type { LogEvent } from "../../shared/fountain-types";
import { Chevron } from "../lib/icons";

export interface TranscriptProps {
  events: LogEvent[];
  runtime: string;
  /** True while a turn is in flight, so the trailing indicator is honest. */
  running: boolean;
  /** Rendered above the first turn — the ribbon, the starters, an empty state. */
  head?: React.ReactNode;
}

export function Transcript({ events, runtime, running, head }: TranscriptProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);

  const turns = useMemo(() => groupTurns(events), [events]);

  // Follow the bottom, but only while the reader is already there. Yanking
  // somebody back down mid-scroll is the single most irritating thing a live
  // transcript can do, and it happens on every chunk.
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [turns, running]);

  return (
    <div
      className="scroll"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {head}
      <div className="transcript">
        {turns.map((turn) => (
          <Turn key={turn.id} turn={turn} runtime={runtime} />
        ))}
        {running ? (
          <div className="thinking-now">
            <span className="dots">
              <i />
              <i />
              <i />
            </span>
            Working
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface GroupedTurn {
  id: string;
  prompt: string | null;
  events: LogEvent[];
}

/**
 * Events into turns.
 *
 * `turn_id` is the grouping, and the prompt arrives as a `stage` event rather
 * than as output — which is why the user's own words are pulled out here
 * instead of falling through `blocksForTurn` and appearing as part of the
 * agent's reply.
 */
function groupTurns(events: LogEvent[]): GroupedTurn[] {
  const order: string[] = [];
  const byTurn = new Map<string, GroupedTurn>();
  for (const ev of events) {
    const id = ev.turn_id ?? "loose";
    let turn = byTurn.get(id);
    if (!turn) {
      turn = { id, prompt: null, events: [] };
      byTurn.set(id, turn);
      order.push(id);
    }
    if (ev.kind === "stage" && ev.stage === "prompt" && typeof ev.data === "string") turn.prompt = ev.data;
    else turn.events.push(ev);
  }
  return order.map((id) => byTurn.get(id)!);
}

function Turn({ turn, runtime }: { turn: GroupedTurn; runtime: string }) {
  const blocks = useMemo(() => blocksForTurn(turn.events, runtime), [turn.events, runtime]);
  const app = turn.prompt ? appTurnLabel(turn.prompt) : null;
  return (
    <div className="turn">
      {app ? <div className="turn-app">{app}</div> : turn.prompt ? <div className="turn-you">{turn.prompt}</div> : null}
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </div>
  );
}

/**
 * A turn switchyard sent itself, as one line.
 *
 * Matched on the marker the prompt contract puts at the front of every one of
 * them (`shared/spec.ts`), so there is exactly one place that decides what an
 * app turn looks like and it is the same place that writes them.
 */
function appTurnLabel(prompt: string): string | null {
  if (!prompt.startsWith("[switchyard]")) return null;
  const first = prompt.slice("[switchyard]".length).split("\n")[0]!.trim();
  return first || "Switchyard sent this machine an instruction.";
}

function BlockView({ block }: { block: Block }) {
  const [open, setOpen] = useState(false);
  switch (block.kind) {
    case "text":
      return <div className="block-text">{block.body}</div>;
    case "thinking":
      return <div className="block-thinking">{block.body}</div>;
    case "tool":
      return (
        <div className="tool">
          <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            <Chevron size={13} open={open} />
            <strong>{block.name}</strong>
            <span className="truncate">{block.summary}</span>
            <span className="spacer" />
            <ToolStatus status={block.status} />
          </button>
          {open && block.output ? <pre className="tool-out">{block.output}</pre> : null}
        </div>
      );
    case "raw":
      return <div className="block-text dim">{block.body}</div>;
  }
}

function ToolStatus({ status }: { status: "running" | "done" | "error" }) {
  if (status === "error") return <span className="chip bad">failed</span>;
  if (status === "running") return <span className="dot running" />;
  return <span className="dot ready" />;
}
