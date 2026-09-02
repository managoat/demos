/**
 * One contender's corner: label (blind) or model name (revealed), a status
 * line, the round's replies rendered like dns-desk's preview (text, thinking,
 * tool chips), the turn's numbers, and the vote button.
 */
import type { Block } from "../lib/acp";
import { formatMs, LABELS, type ColumnStatus, type TurnMetrics } from "../lib/arena";
import type { Turn } from "../api/types";

export interface ColumnSegment {
  turn: Turn;
  blocks: Block[];
  metrics: TurnMetrics;
}

export interface ColumnData {
  key: string;
  /** what the header shows once revealed */
  name: string;
  index: number;
  segments: ColumnSegment[];
  status: ColumnStatus;
  statusDetail: string | null;
}

const STATUS_LABEL: Record<ColumnStatus, string> = {
  waiting: "waiting…",
  hiring: "hiring…",
  starting: "computer starting…",
  thinking: "thinking…",
  answering: "answering…",
  done: "done",
  error: "error",
  interrupted: "interrupted",
};

const LIVE: ReadonlySet<ColumnStatus> = new Set(["waiting", "hiring", "starting", "thinking", "answering"]);

export function Column(props: {
  col: ColumnData;
  revealed: boolean;
  winner: boolean;
  canVote: boolean;
  onVote?: (key: string) => void;
}) {
  const { col } = props;
  const label = LABELS[col.index] ?? "?";
  return (
    <section className={`col status-${col.status}${props.winner ? " winner" : ""}`} aria-label={`contender ${label}`}>
      <header className="col-head">
        <span className="col-label">{label}</span>
        <span className="col-name">{props.revealed ? col.name : "· · ·"}</span>
        {props.winner && <span className="crown" title="round winner">♛</span>}
        <span className={`col-status s-${col.status}`}>{STATUS_LABEL[col.status]}</span>
      </header>
      {col.statusDetail && col.status === "error" && <p className="col-error">{col.statusDetail}</p>}
      <div className="col-body">
        {col.segments.length === 0 && LIVE.has(col.status) && <div className="pulse" aria-hidden="true" />}
        {col.segments.map(({ turn, blocks, metrics }, i) => (
          <div key={turn.id} className="segment">
            {i > 0 && <div className="segment-mark">turn {i + 1}</div>}
            {blocks.map((b, j) => <BlockView key={j} block={b} />)}
            {turn.status === "failed" && <p className="col-error">This turn failed{turn.exit_code !== null ? ` (exit ${turn.exit_code})` : ""}.</p>}
            <div className="metrics">
              <span title="time to first output">first {formatMs(metrics.ttfbMs)}</span>
              <span title="turn duration">total {formatMs(metrics.durationMs)}</span>
              <span title="token usage (in/out)">
                {metrics.usage ? `${metrics.usage.input}▸${metrics.usage.output} tok` : "— tok"}
              </span>
            </div>
          </div>
        ))}
      </div>
      {props.canVote && props.onVote && (
        <button className="vote" onClick={() => props.onVote?.(col.key)}>
          Winner
        </button>
      )}
    </section>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "text":
      return <div className="blk-text">{block.body}</div>;
    case "thinking":
      return (
        <details className="blk-thinking">
          <summary>thinking</summary>
          <div>{block.body}</div>
        </details>
      );
    case "tool":
      return (
        <div className={`blk-tool tool-${block.status}`}>
          <span className="tool-name">{block.name}</span>
          {block.summary && <span className="tool-summary">{block.summary}</span>}
        </div>
      );
    case "raw":
      return <div className="blk-raw">{block.body}</div>;
    default:
      return null;
  }
}
