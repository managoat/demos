/** The coordinator's plan as task cards, with the approve/revise bar. */
import { useState } from "react";
import type { Mission } from "../lib/protocol";

export function PlanView(props: {
  mission: Mission;
  busy: boolean;
  onApprove: (mission: Mission) => void;
  onRevise: (text: string) => void;
}) {
  const { mission } = props;
  const [revision, setRevision] = useState("");

  const revise = () => {
    if (!revision.trim()) return;
    props.onRevise(revision.trim());
    setRevision("");
  };

  return (
    <div className="plan-view">
      <div className="mission-head">
        <span className="mission-id">{mission.plan.id}</span>
        <h2>{mission.plan.objective}</h2>
        <p className="fineprint">
          {mission.plan.tasks.length} task{mission.plan.tasks.length === 1 ? "" : "s"}, one computer each — nothing
          launches until you approve.
        </p>
      </div>
      <div className="task-grid">
        {mission.plan.tasks.map((task) => (
          <div key={task.id} className="task-card plan">
            <div className="task-head">
              <span className="task-id">{task.id}</span>
              <b>{task.title}</b>
            </div>
            <p className="task-brief">{task.brief}</p>
            {task.deliverable && (
              <p className="task-deliverable">
                <span>returns</span> {task.deliverable}
              </p>
            )}
          </div>
        ))}
      </div>
      <div className="approve-bar">
        <button className="primary big" disabled={props.busy} onClick={() => props.onApprove(mission)}>
          Approve &amp; launch {mission.plan.tasks.length} agents
        </button>
        <div className="revise">
          <input
            value={revision}
            onChange={(e) => setRevision(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && revise()}
            placeholder="Or ask for changes — “merge t2 into t1”, “add a cost analysis task”"
            disabled={props.busy}
          />
          <button disabled={props.busy || !revision.trim()} onClick={revise}>
            Revise
          </button>
        </div>
      </div>
    </div>
  );
}
