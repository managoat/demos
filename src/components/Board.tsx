/**
 * The flight board: one card per task — boot sequence while the sandbox comes
 * to life, then a live tail of the worker's blocks, then the result.
 */
import type { Usage } from "../api/types";
import type { ViewBlock } from "../lib/blocks";
import { stripBlocks, type MissionTask, type TaskResult, type TaskStatus } from "../lib/protocol";

export interface TaskView {
  task: MissionTask;
  convId: string | null;
  status: TaskStatus;
  boot: Array<{ stage: string; state: string }>;
  blocks: ViewBlock[];
  result: TaskResult | null;
  usage: Usage | null;
  startedAt: string | null;
  /** the stage that failed, when one did */
  failureStage: string | null;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "queued",
  provisioning: "booting",
  working: "working",
  done: "done",
  blocked: "blocked",
  failed: "failed",
  terminated: "terminated",
  noresult: "no result",
};

const LIVE: ReadonlySet<TaskStatus> = new Set(["provisioning", "working"]);
const TAIL = 6;

export function elapsed(fromIso: string | null, nowMs: number): string {
  if (!fromIso) return "—";
  const s = Math.max(0, Math.floor((nowMs - Date.parse(fromIso)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function tokens(usage: Usage | null): string | null {
  if (!usage) return null;
  const fmt = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)}k` : String(n));
  return `${fmt(usage.input)} in · ${fmt(usage.output)} out`;
}

export function TaskCard(props: { view: TaskView; now: number; onInterrupt: (convId: string) => void }) {
  const { view, now } = props;
  const live = LIVE.has(view.status);
  const tail = view.blocks.slice(-TAIL);
  const toks = tokens(view.usage);
  return (
    <div className={`task-card status-${view.status}`}>
      <div className="task-head">
        <span className="task-id">{view.task.id}</span>
        <b>{view.task.title}</b>
        <span className={`chip chip-${view.status}`}>{STATUS_LABEL[view.status]}</span>
      </div>
      {view.status === "provisioning" && (
        <ol className="boot">
          {(view.boot.length ? view.boot : [{ stage: "provision", state: "started" }]).map((b) => (
            <li key={b.stage} className={`boot-${b.state}`}>
              <span className="boot-mark">{b.state === "done" ? "▮" : b.state === "failed" ? "✕" : "▯"}</span> {b.stage}
            </li>
          ))}
        </ol>
      )}
      {view.status === "failed" && (
        <p className="task-failure">{view.failureStage ? `failed at ${view.failureStage}` : "the computer failed"}</p>
      )}
      {view.status !== "provisioning" && tail.length > 0 && (
        <div className="tail">
          {tail.map((b, i) =>
            b.kind === "tool" ? (
              <span key={i} className={`toolchip tool-${b.status}`} title={b.summary}>
                {b.name}
              </span>
            ) : b.kind === "thinking" ? (
              <span key={i} className="tail-thinking">
                {snip(b.body)}
              </span>
            ) : (
              <span key={i} className="tail-text">
                {snip(b.body)}
              </span>
            ),
          )}
        </div>
      )}
      {view.result?.summary && <p className="task-summary">{view.result.summary}</p>}
      <div className="task-foot">
        <span className="mono">{view.status === "queued" ? "awaiting a computer" : elapsed(view.startedAt, now)}</span>
        {toks && <span className="mono">{toks}</span>}
        {live && view.convId && (
          <button className="linkish danger-link" onClick={() => props.onInterrupt(view.convId!)}>
            interrupt
          </button>
        )}
      </div>
    </div>
  );
}

/** Tail text, sans protocol fences (a trailing partial fence is cut too). */
function snip(s: string): string {
  const t = stripBlocks(s).replace(/```task-result[\s\S]*$/, "").trim().replace(/\s+/g, " ");
  return t.length > 160 ? "…" + t.slice(-159) : t;
}
