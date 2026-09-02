/** Small shared form pieces for the resource pages. */
import type { ReactNode } from "react";

export function Field({ label, hint, optional, children }: { label: ReactNode; hint?: ReactNode; optional?: boolean; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">
        {label} {optional && <span className="muted">(optional)</span>}
      </span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

/** Key/value rows with add/remove — env vars, MCP env, secrets entry. */
export function KeyValueRows({
  rows,
  onChange,
  keyPlaceholder = "KEY",
  valuePlaceholder = "value",
  secret = false,
}: {
  rows: Array<{ key: string; value: string }>;
  onChange: (rows: Array<{ key: string; value: string }>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  secret?: boolean;
}) {
  const set = (i: number, patch: Partial<{ key: string; value: string }>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="kv">
      {rows.map((r, i) => (
        <div key={i} className="kv-row">
          <input value={r.key} placeholder={keyPlaceholder} onChange={(e) => set(i, { key: e.target.value })} className="mono" autoComplete="off" />
          <input
            value={r.value}
            placeholder={valuePlaceholder}
            type={secret ? "password" : "text"}
            onChange={(e) => set(i, { value: e.target.value })}
            className="mono"
            autoComplete="off"
          />
          <button type="button" className="icon" aria-label="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button type="button" className="secondary small" onClick={() => onChange([...rows, { key: "", value: "" }])}>
        + Add
      </button>
    </div>
  );
}

/** A tri-state allowlist: any / none / these. */
export function Allowlist({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: string[] | null;
  options: Array<{ id: string; name: string }>;
  onChange: (v: string[] | null) => void;
  hint?: ReactNode;
}) {
  const mode = value === null ? "any" : value.length === 0 ? "none" : "some";
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="row wrap">
        <label className="check">
          <input type="radio" checked={mode === "any"} onChange={() => onChange(null)} /> any
        </label>
        <label className="check">
          <input type="radio" checked={mode === "none"} onChange={() => onChange([])} /> none
        </label>
        <label className="check">
          <input type="radio" checked={mode === "some"} onChange={() => onChange(value && value.length ? value : options[0] ? [options[0].id] : [])} /> only these
        </label>
      </div>
      {mode === "some" && (
        <div className="checklist">
          {options.map((o) => (
            <label key={o.id} className="check">
              <input
                type="checkbox"
                checked={value?.includes(o.id) ?? false}
                onChange={(e) => onChange(e.target.checked ? [...(value ?? []), o.id] : (value ?? []).filter((x) => x !== o.id))}
              />
              {o.name}
            </label>
          ))}
          {options.length === 0 && <span className="muted small">Nothing to choose from yet.</span>}
        </div>
      )}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/** Secrets on an environment or vault: keys listed, values write-only. */
export function SecretsPanel({
  secrets,
  onAdd,
  onDelete,
}: {
  secrets: Array<{ key: string }> | null;
  onAdd: (key: string, value: string) => Promise<void>;
  onDelete: (key: string) => Promise<void>;
}) {
  return (
    <div className="secrets">
      {secrets === null && <div className="muted small">Loading…</div>}
      {secrets && secrets.length === 0 && <div className="muted small">No secrets yet.</div>}
      <ul className="secret-list">
        {secrets?.map((s) => (
          <li key={s.key}>
            <span className="mono">{s.key}</span>
            <span className="muted mono">••••••••</span>
            <button type="button" className="icon" aria-label={`Delete ${s.key}`} onClick={() => void onDelete(s.key)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <SecretAdd onAdd={onAdd} />
    </div>
  );
}

import { useState } from "react";

function SecretAdd({ onAdd }: { onAdd: (key: string, value: string) => Promise<void> }) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="kv-row">
      <input value={key} placeholder="KEY" className="mono" onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} autoComplete="off" />
      <input value={value} type="password" placeholder="value" className="mono" onChange={(e) => setValue(e.target.value)} autoComplete="off" />
      <button
        type="button"
        className="small"
        disabled={busy || !key || !value}
        onClick={async () => {
          setBusy(true);
          try {
            await onAdd(key, value);
            setKey("");
            setValue("");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "…" : "Set"}
      </button>
    </div>
  );
}
