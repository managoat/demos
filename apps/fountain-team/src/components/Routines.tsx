import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { FountainClient } from "../api/client";
import { describeError } from "../api/client";
import type { Schedule, ScheduleInput, Teammate } from "../api/types";
import { CRON_PRESETS, describeCron, isCronLike } from "../lib/cron";
import { Avatar } from "./Avatar";
import { transcriptUrl } from "../lib/transcript";


interface Props {
  client: FountainClient;
  teammates: Teammate[];
  schedules: Schedule[] | null;
  /** the teammate to preselect in "New routine", from the thread header */
  forAgentId: string | null;
  onRefresh: () => Promise<unknown>;
  onBack: () => void;
  onOpenTeammate: (agentId: string) => void;
  toast: (text: string, kind?: "info" | "error") => void;
  fountainUrl: string;
}

/**
 * Routines: the schedules that run teammates (after OpenMausBot's Routines
 * page), on /api/team/:agent_id/schedules. Grouped by teammate; create,
 * edit, enable/disable, run now, delete. The server evaluates cron in UTC
 * and reports next/last run — the page never computes a run time itself.
 */
export function Routines({ client, teammates, schedules, forAgentId, onRefresh, onBack, onOpenTeammate, toast, fountainUrl }: Props) {
  const [editing, setEditing] = useState<{ schedule: Schedule | null; agentId: string } | null>(
    forAgentId ? { schedule: null, agentId: forAgentId } : null,
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  const byAgent = useMemo(() => {
    const m = new Map<string, Schedule[]>();
    for (const s of schedules ?? []) {
      const arr = m.get(s.agent_id);
      if (arr) arr.push(s);
      else m.set(s.agent_id, [s]);
    }
    return m;
  }, [schedules]);

  const teammateOf = (agentId: string) => teammates.find((t) => t.agent_id === agentId) ?? null;

  const act = async (id: string, f: () => Promise<unknown>, done?: string) => {
    setBusyId(id);
    try {
      await f();
      if (done) toast(done);
      await onRefresh();
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setBusyId(null);
    }
  };

  const groups: Array<{ agentId: string; teammate: Teammate | null; items: Schedule[] }> = [];
  for (const t of teammates) groups.push({ agentId: t.agent_id, teammate: t, items: byAgent.get(t.agent_id) ?? [] });
  for (const [agentId, items] of byAgent) if (!teammates.some((t) => t.agent_id === agentId)) groups.push({ agentId, teammate: null, items });

  return (
    <section className="thread routines">
      <header className="thread-header">
        <button className="back" onClick={onBack} aria-label="Back to the team">
          ‹ Team
        </button>
        <div className="thread-title">
          <div className="name">Routines</div>
          <div className="sub">Schedules that message a teammate for you — in their thread, or on a one-off computer. Times are UTC.</div>
        </div>
        <div className="row">
          <button className="small" onClick={() => setEditing({ schedule: null, agentId: forAgentId ?? teammates[0]?.agent_id ?? "" })} disabled={teammates.length === 0}>
            + New routine
          </button>
        </div>
      </header>

      <div className="routines-body">
        {schedules === null && <div className="centered muted">Loading…</div>}
        {schedules !== null && groups.every((g) => g.items.length === 0) && (
          <div className="centered muted empty-thread">
            <div className="glyph">⏰</div>
            <div>No routines yet. A routine runs a teammate with a prompt on a schedule — a standup every weekday, a report on the first of the month.</div>
          </div>
        )}
        {groups
          .filter((g) => g.items.length > 0)
          .map((g) => (
            <div className="routine-group" key={g.agentId}>
              <div className="routine-group-head">
                {g.teammate ? (
                  <button className="linkish" onClick={() => onOpenTeammate(g.agentId)}>
                    <Avatar agent={g.teammate.agent} name={g.teammate.name} client={client} size={24} />
                    <span className="name">{g.teammate.name}</span>
                  </button>
                ) : (
                  <span className="muted">Agent {g.agentId.slice(0, 8)} (not on the team — in-thread runs will fail until it is)</span>
                )}
              </div>
              <ul className="routine-list">
                {g.items.map((s) => (
                  <li key={s.id} className={`routine ${s.enabled ? "" : "disabled"}`}>
                    <div className="routine-main">
                      <div className="routine-title">
                        <span className="name">{s.name || describeCron(s.cron)}</span>
                        {!s.enabled && <span className="tag">paused</span>}
                        {s.one_off && (
                          <span className="tag" title="Each run opens a fresh conversation on a new computer">
                            one-off computer
                          </span>
                        )}
                      </div>
                      <div className="routine-cron mono muted small">
                        {describeCron(s.cron)}
                        {describeCron(s.cron) !== `${s.cron} (UTC)` ? ` · ${s.cron}` : ""}
                      </div>
                      <div className="routine-prompt">{s.prompt}</div>
                      <div className="routine-meta small muted">
                        {s.enabled && s.next_run_at ? `Next ${formatDateTime(s.next_run_at)}` : "Not scheduled"}
                        {s.last_run_at && (
                          <>
                            {" · "}Last {formatDateTime(s.last_run_at)}
                            {s.last_conversation_id && (
                              <>
                                {" "}
                                (
                                <a href={transcriptUrl(fountainUrl, s.last_conversation_id)} target="_blank" rel="noreferrer">
                                  conversation
                                </a>
                                )
                              </>
                            )}
                          </>
                        )}
                        {s.last_error && <span className="error-inline"> · last run failed: {s.last_error}</span>}
                      </div>
                    </div>
                    <div className="routine-actions">
                      <button
                        className="secondary small"
                        disabled={busyId === s.id}
                        onClick={() => act(s.id, () => client.runSchedule(s.agent_id, s.id), "Queued — the reply lands in their thread")}
                        title="Send the prompt now"
                      >
                        Run now
                      </button>
                      <button
                        className="secondary small"
                        disabled={busyId === s.id}
                        onClick={() => act(s.id, () => client.updateSchedule(s.agent_id, s.id, { enabled: !s.enabled }))}
                      >
                        {s.enabled ? "Pause" : "Resume"}
                      </button>
                      <button className="secondary small" disabled={busyId === s.id} onClick={() => setEditing({ schedule: s, agentId: s.agent_id })}>
                        Edit
                      </button>
                      <button
                        className="danger small"
                        disabled={busyId === s.id}
                        onClick={() => {
                          if (!window.confirm(`Delete "${s.name || describeCron(s.cron)}"?`)) return;
                          void act(s.id, () => client.deleteSchedule(s.agent_id, s.id), "Routine deleted");
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>

      {editing && (
        <RoutineDialog
          client={client}
          teammates={teammates}
          schedule={editing.schedule}
          agentId={editing.agentId}
          teammateName={teammateOf(editing.agentId)?.name ?? null}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await onRefresh();
          }}
          toast={toast}
        />
      )}
    </section>
  );
}

function RoutineDialog({
  client,
  teammates,
  schedule,
  agentId: initialAgentId,
  onClose,
  onSaved,
  toast,
}: {
  client: FountainClient;
  teammates: Teammate[];
  schedule: Schedule | null;
  agentId: string;
  teammateName: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  toast: (text: string, kind?: "info" | "error") => void;
}) {
  const [agentId, setAgentId] = useState(initialAgentId);
  const [name, setName] = useState(schedule?.name ?? "");
  const presetIdx = CRON_PRESETS.findIndex((p) => p.cron === (schedule?.cron ?? CRON_PRESETS[0]!.cron));
  const [preset, setPreset] = useState<string>(schedule ? (presetIdx >= 0 ? String(presetIdx) : "custom") : "0");
  const [cron, setCron] = useState(schedule?.cron ?? CRON_PRESETS[0]!.cron);
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [oneOff, setOneOff] = useState(schedule?.one_off ?? false);
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const choosePreset = (v: string) => {
    setPreset(v);
    if (v !== "custom") setCron(CRON_PRESETS[Number(v)]!.cron);
  };

  const cronOk = isCronLike(cron);
  const canSave = !busy && agentId && cronOk && prompt.trim().length > 0;

  const submit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!canSave) return;
      setBusy(true);
      setError(null);
      const input: ScheduleInput = { cron: cron.trim(), prompt: prompt.trim(), name: name.trim() || null, one_off: oneOff, enabled };
      try {
        if (schedule) await client.updateSchedule(schedule.agent_id, schedule.id, input);
        else await client.createSchedule(agentId, input);
        toast(schedule ? "Routine updated" : "Routine created");
        await onSaved();
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [canSave, cron, prompt, name, oneOff, enabled, schedule, client, agentId, toast, onSaved],
  );

  return (
    <div className="modal-root">
      <div className="backdrop" onClick={onClose} />
      <form className="modal" onSubmit={submit}>
        <header>
          <h2>{schedule ? "Edit routine" : "New routine"}</h2>
          <button type="button" className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        {!schedule && (
          <label>
            Teammate
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {teammates.map((t) => (
                <option key={t.agent_id} value={t.agent_id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Name <span className="muted">(optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Standup" />
        </label>
        <label>
          When
          <select value={preset} onChange={(e) => choosePreset(e.target.value)}>
            {CRON_PRESETS.map((p, i) => (
              <option key={p.cron} value={String(i)}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom cron…</option>
          </select>
        </label>
        {preset === "custom" && (
          <label>
            Cron <span className="muted">(five fields, UTC — e.g. <code>0 9 * * 1-5</code>)</span>
            <input value={cron} onChange={(e) => setCron(e.target.value)} className={cronOk ? "" : "invalid"} spellCheck={false} />
            {!cronOk && <span className="hint error-inline">That does not look like a cron expression.</span>}
          </label>
        )}
        <label>
          Prompt
          <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Tell me what you did yesterday and what you'll do today." />
        </label>
        <label className="check">
          <input type="checkbox" checked={oneOff} onChange={(e) => setOneOff(e.target.checked)} />
          <span>
            Run on a one-off computer <span className="hint">Each run opens a fresh conversation on a new computer instead of messaging their thread.</span>
          </span>
        </label>
        {schedule && (
          <label className="check">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>Enabled</span>
          </label>
        )}
        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" disabled={!canSave}>
            {busy ? "Saving…" : schedule ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? `today ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

