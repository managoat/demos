/**
 * The patrol schedule — the product's heartbeat. Cadence presets over the
 * schedule's cron, next/last run, pause/resume, Run now. All on the team
 * schedules API; the list refreshes on the team stream's `schedule` event.
 */
import type { Schedule } from "../api/types";
import { CADENCES, cadenceLabel, cadenceOf, cronFor, type Cadence } from "../lib/schedule";
import { timeAgo, timeUntil } from "../lib/schedule";

export function SchedulePanel(props: {
  schedule: Schedule | null;
  busy: boolean;
  working: boolean;
  onRunNow: () => void;
  onCadence: (cron: string) => void;
  onToggle: (enabled: boolean) => void;
}) {
  const s = props.schedule;
  if (!s) return <div className="schedule fineprint">Setting up the patrol schedule…</div>;
  const cadence = cadenceOf(s.cron);
  return (
    <div className="schedule">
      <span className={s.enabled ? "lamp lamp-ok" : "lamp lamp-pending"} />
      <span className="sched-main">
        {s.enabled ? (
          <>
            patrols <b>{cadenceLabel(s.cron)}</b>
            {s.next_run_at && <> · next {timeUntil(s.next_run_at)}</>}
          </>
        ) : (
          <>patrol paused</>
        )}
        {s.last_run_at && <> · last ran {timeAgo(s.last_run_at)}</>}
      </span>
      {s.last_error && <span className="error" title={s.last_error}>last run failed</span>}
      <span className="sched-controls">
        <select
          aria-label="patrol cadence"
          value={cadence ?? "custom"}
          onChange={(e) => {
            const v = e.target.value as Cadence | "custom";
            if (v !== "custom") props.onCadence(cronFor(v));
          }}
          disabled={props.busy}
        >
          {CADENCES.map((c) => (
            <option key={c} value={c}>
              {cadenceLabel(cronFor(c))}
            </option>
          ))}
          {cadence === null && <option value="custom">custom ({s.cron})</option>}
        </select>
        <button onClick={() => props.onToggle(!s.enabled)} disabled={props.busy}>
          {s.enabled ? "Pause" : "Resume"}
        </button>
        <button className="primary" onClick={props.onRunNow} disabled={props.busy || props.working}>
          {props.working ? "Patrolling…" : "Run now"}
        </button>
      </span>
    </div>
  );
}
