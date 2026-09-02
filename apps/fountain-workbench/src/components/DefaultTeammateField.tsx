import type { ReactNode } from "react";
import { agentFits } from "../lib/workbench";
import type { Agent } from "../types";

/**
 * Who new work in a project starts with. The same question on the form that
 * makes a project and in Settings & sharing afterwards, so it is one field:
 * asked at create time it is the one moment the answer saves the most work,
 * and asked later it is the only place to change it.
 *
 * `project` is whatever environment and vault the project has *or is about to
 * have* — on the create form the other two selects are still moving, and the
 * reasons an agent does not fit move with them.
 */
export function DefaultTeammateField({
  agents,
  loaded,
  project,
  value,
  onChange,
  hint,
}: {
  agents: Iterable<Agent>;
  /** Whether the agent list has arrived. An empty list is only news once it has. */
  loaded: boolean;
  project: { environmentId: string | null; vaultId: string | null };
  /** The chosen agent's id, or "" for "ask every time". */
  value: string;
  onChange: (id: string) => void;
  hint?: ReactNode;
}) {
  const team = [...agents].sort((a, b) => a.name.localeCompare(b.name));

  // One agent is not a list to choose from, it is the answer — so say who it
  // is, and leave the other choice as a sentence rather than a select whose
  // every render is the same single row.
  if (loaded && team.length === 1) {
    const solo = team[0]!;
    const fit = agentFits(solo, project);
    return (
      <div className="field">
        <span className="field-label">Default teammate</span>
        {hint && <span className="hint">{hint}</span>}
        {!fit.ok ? (
          <p className="muted small">
            {solo.name} is the only agent on your Fountain, and it {fit.reason} — so new work here asks every time.
          </p>
        ) : value === solo.id ? (
          <p className="muted small">
            New work starts with <strong>{solo.name}</strong> ({solo.runtime}), the only agent on your Fountain.{" "}
            <button type="button" className="linklike" onClick={() => onChange("")}>
              Ask every time instead
            </button>
          </p>
        ) : (
          <p className="muted small">
            New work here asks every time.{" "}
            <button type="button" className="linklike" onClick={() => onChange(solo.id)}>
              Start it with {solo.name}
            </button>
          </p>
        )}
      </div>
    );
  }

  const picked = team.find((a) => a.id === value) ?? null;
  const pickedFit = picked ? agentFits(picked, project) : null;
  return (
    <label>
      Default teammate {hint && <span className="hint">{hint}</span>}
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={!loaded || team.length === 0}>
        <option value="">{loaded && team.length === 0 ? "No agents on your Fountain" : "Ask every time"}</option>
        {team.map((a) => {
          const fit = agentFits(a, project);
          return (
            <option key={a.id} value={a.id} disabled={!fit.ok}>
              {a.name} ({a.runtime})
              {fit.ok ? "" : ` — ${fit.reason}`}
            </option>
          );
        })}
      </select>
      {/* A default this project cannot run is no default: every picker ignores
          it and falls back to asking, so the field says so rather than looking set. */}
      {loaded && value && !picked && <span className="hint">That teammate is no longer on your Fountain, so new work asks every time until you pick another.</span>}
      {picked && pickedFit && !pickedFit.ok && (
        <span className="hint">
          {picked.name} {pickedFit.reason}, so new work asks every time until you pick another.
        </span>
      )}
    </label>
  );
}
