/**
 * The Setup tab: the project's environment, edited where you can see it.
 *
 * There is no apply step and no rebuild button, and the copy at the top of
 * each section says so, because the reason is structural rather than a
 * convenience: every thread is a fresh machine built from these settings, so a
 * changed setup script is simply what the next thread gets. Nothing is
 * "pending". The one thing a person can be wrong about is the thread they are
 * looking at right now — it was built from whatever these said when it opened
 * — which is what `Thread.stale` is for, and why that notice sits in the panel
 * rather than in a help page.
 */
import { useCallback, useEffect, useState } from "react";
import type { Capabilities, Project, ProjectSettings, Thread } from "../../shared/api";
import type { ApiError } from "../api/client";
import * as api from "../api/client";
import { asApiError } from "./Changes";

export interface SetupProps {
  project: Project;
  /** The thread on screen, so the panel can say whether it predates these settings. */
  thread: Thread | null;
  capabilities: Capabilities;
  refreshKey: number;
  /** The project as the server returned it after a patch, for the shell to keep. */
  onProjectChange?: (project: Project) => void;
}

type Store = "environment" | "vault";

export function Setup({ project, thread, capabilities, refreshKey, onProjectChange }: SetupProps) {
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  const [script, setScript] = useState("");
  const [instructions, setInstructions] = useState("");

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .getSettings(project.id)
      .then((next) => {
        if (!live) return;
        setSettings(next);
        setScript(next.setupScript);
        setInstructions(next.instructions);
        setError(null);
      })
      .catch((err: unknown) => live && setError(asApiError(err)))
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [project.id, refreshKey, tick]);

  const patch = useCallback(
    async (what: string, body: Partial<ProjectSettings>, after?: (s: ProjectSettings) => ProjectSettings) => {
      setBusy(what);
      setError(null);
      try {
        const updated = await api.patchProject(project.id, body);
        onProjectChange?.(updated);
        if (after) setSettings((prev) => (prev ? after(prev) : prev));
      } catch (err) {
        setError(asApiError(err));
      } finally {
        setBusy(null);
      }
    },
    [onProjectChange, project.id],
  );

  if (loading && !settings) {
    return (
      <div className="dd-in-sk">
        {[40, 90, 90, 55, 70].map((w, i) => (
          <div key={i} className="skeleton" style={{ width: `${w}%`, height: i === 1 || i === 2 ? 26 : 11 }} />
        ))}
      </div>
    );
  }
  if (!settings) {
    return (
      <div className="dd-in-msg error">
        {error?.message ?? "These settings could not be read."}
        <div style={{ marginTop: 10 }}>
          <button onClick={reload}>Try again</button>
        </div>
      </div>
    );
  }

  const apt = settings.packages.apt ?? [];
  const npm = settings.packages.npm ?? [];
  const models = capabilities.models.includes(settings.model) ? capabilities.models : [settings.model, ...capabilities.models];

  const setPackages = (manager: "apt" | "npm", list: string[]) =>
    patch(`pkg:${manager}`, { packages: { ...settings.packages, [manager]: list } }, (prev) => ({
      ...prev,
      packages: { ...prev.packages, [manager]: list },
    }));

  return (
    <div className="dd-in-setup">
      {thread?.stale ? (
        <div className="dd-in-notice stale">
          <span className="dd-in-notice-icon">
            <InfoIcon />
          </span>
          <span>
            This thread was built before the settings below and is running the older ones. It stays that way for its whole life — the next
            thread you open gets these.
          </span>
        </div>
      ) : null}

      {error ? <p className="fine error">{error.message}</p> : null}

      <section className="dd-in-sec">
        <div className="dd-in-sec-head">
          <h4>Setup script</h4>
          {busy === "setupScript" ? <span className="dd-in-spin" /> : null}
        </div>
        <p className="dd-in-note">
          Shell that runs once while a machine is built, after the clone. Every thread is a fresh machine, so a change here lands on the
          next thread you open — there is nothing to apply and nothing to rebuild.
        </p>
        <textarea
          rows={7}
          value={script}
          spellCheck={false}
          onChange={(e) => setScript(e.target.value)}
          placeholder={"npm ci\nnpm run build"}
        />
        <div className="dd-in-save">
          <button
            className="primary"
            disabled={script === settings.setupScript || busy !== null}
            onClick={() => void patch("setupScript", { setupScript: script }, (prev) => ({ ...prev, setupScript: script }))}
          >
            Save
          </button>
          {script !== settings.setupScript ? (
            <button className="ghost" onClick={() => setScript(settings.setupScript)}>
              Discard
            </button>
          ) : (
            <span className="faint" style={{ fontSize: 11.5 }}>saved</span>
          )}
        </div>
      </section>

      <section className="dd-in-sec">
        <div className="dd-in-sec-head">
          <h4>Packages</h4>
          {busy?.startsWith("pkg:") ? <span className="dd-in-spin" /> : null}
        </div>
        <p className="dd-in-note">Installed while the machine is built, before the setup script. Also next-thread, immediately.</p>
        <PackageList
          manager="apt"
          list={apt}
          disabled={busy !== null}
          onChange={(list) => void setPackages("apt", list)}
          placeholder="ripgrep"
        />
        <PackageList
          manager="npm"
          list={npm}
          disabled={busy !== null}
          onChange={(list) => void setPackages("npm", list)}
          placeholder="typescript"
        />
      </section>

      <Secrets projectId={project.id} settings={settings} onChanged={reload} />

      <section className="dd-in-sec">
        <div className="dd-in-sec-head">
          <h4>Instructions</h4>
          {busy === "instructions" ? <span className="dd-in-spin" /> : null}
        </div>
        <p className="dd-in-note">
          Appended to the agent's system prompt. Injected when a session starts, so it reaches the next thread rather than one that is
          already open.
        </p>
        <textarea
          rows={6}
          value={instructions}
          spellCheck={false}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Prefer small commits. Run the test suite before you say you are done."
        />
        <div className="dd-in-save">
          <button
            className="primary"
            disabled={instructions === settings.instructions || busy !== null}
            onClick={() => void patch("instructions", { instructions }, (prev) => ({ ...prev, instructions }))}
          >
            Save
          </button>
          {instructions !== settings.instructions ? (
            <button className="ghost" onClick={() => setInstructions(settings.instructions)}>
              Discard
            </button>
          ) : (
            <span className="faint" style={{ fontSize: 11.5 }}>saved</span>
          )}
        </div>
      </section>

      <section className="dd-in-sec">
        <div className="dd-in-sec-head">
          <h4>Model</h4>
          {busy === "model" ? <span className="dd-in-spin" /> : null}
        </div>
        <p className="dd-in-note">What the agent runs on. Chosen when a session starts, so this too is the next thread's.</p>
        <select
          value={settings.model}
          disabled={busy !== null}
          onChange={(e) => {
            const model = e.target.value;
            void patch("model", { model }, (prev) => ({ ...prev, model }));
          }}
        >
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </section>
    </div>
  );
}

// ── packages ───────────────────────────────────────────────────────────

function PackageList({
  manager,
  list,
  disabled,
  placeholder,
  onChange,
}: {
  manager: string;
  list: string[];
  disabled: boolean;
  placeholder: string;
  onChange: (list: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const name = draft.trim();
    if (!name || list.includes(name)) {
      setDraft("");
      return;
    }
    onChange([...list, name]);
    setDraft("");
  };
  return (
    <div className="col" style={{ gap: 6 }}>
      <label style={{ marginBottom: 0 }}>{manager}</label>
      {list.length > 0 ? (
        <div className="dd-in-chips">
          {list.map((name) => (
            <span key={name} className="chip mono">
              {name}
              <button className="dd-in-chip-x" disabled={disabled} title={`Remove ${name}`} onClick={() => onChange(list.filter((n) => n !== name))}>
                <XIcon />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <span className="faint" style={{ fontSize: 11.5 }}>none</span>
      )}
      <div className="dd-in-add">
        <input
          value={draft}
          placeholder={placeholder}
          spellCheck={false}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button disabled={disabled || !draft.trim()} onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

// ── secrets ────────────────────────────────────────────────────────────

/**
 * Names, never values.
 *
 * The server only ever hands back keys — the values live at Fountain and are
 * write-only from here — so there is no "reveal" and nothing to accidentally
 * put on a screen behind somebody.
 */
function Secrets({ projectId, settings, onChanged }: { projectId: string; settings: ProjectSettings; onChanged: () => void }) {
  const [store, setStore] = useState<Store>("environment");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const rows: { key: string; store: Store }[] = [
    ...settings.envKeys.map((k) => ({ key: k, store: "environment" as const })),
    ...settings.vaultKeys.map((k) => ({ key: k, store: "vault" as const })),
  ];

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.putSecret(projectId, { store, key: key.trim(), value });
      setKey("");
      setValue("");
      onChanged();
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: { key: string; store: Store }) => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteSecret(projectId, row.store, row.key);
      onChanged();
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="dd-in-sec">
      <div className="dd-in-sec-head">
        <h4>Secrets</h4>
        {busy ? <span className="dd-in-spin" /> : null}
      </div>
      <p className="dd-in-note">
        Names only — the values are held at Fountain and never come back here. They are injected when a session starts, so a new one
        reaches the next thread and not one that is already open.
      </p>
      {rows.length > 0 ? (
        <div className="dd-in-keys">
          {rows.map((row) => (
            <div key={`${row.store}:${row.key}`} className="dd-in-key">
              <code className="clip">{row.key}</code>
              <span className="where">{row.store === "vault" ? "vault" : "env"}</span>
              <button className="icon" disabled={busy} title={`Delete ${row.key}`} onClick={() => void remove(row)}>
                <TrashIcon />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <span className="faint" style={{ fontSize: 11.5 }}>none set</span>
      )}
      <div className="dd-in-add">
        <select value={store} disabled={busy} style={{ width: 132, flex: "none" }} onChange={(e) => setStore(e.target.value === "vault" ? "vault" : "environment")}>
          <option value="environment">environment</option>
          <option value="vault">vault</option>
        </select>
        <input value={key} placeholder="API_KEY" spellCheck={false} disabled={busy} onChange={(e) => setKey(e.target.value)} />
        <input type="password" value={value} placeholder="value" disabled={busy} onChange={(e) => setValue(e.target.value)} />
        <button disabled={busy || !key.trim() || !value} onClick={() => void save()}>
          Add
        </button>
      </div>
      <p className="dd-in-note">
        An environment secret is part of the machine's shell. A vault secret is handed to the agent when it asks for one.
      </p>
      {error ? <p className="fine error">{error.message}</p> : null}
    </section>
  );
}

function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.2v4M8 5.1h.01" strokeLinecap="round" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" strokeLinecap="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
