import { useEffect, useState, type FormEvent } from "react";
import { useStore } from "../store";
import { navigate, paths } from "../router";
import { describeError } from "../api/client";
import type { Catalog, Environment, EnvironmentInput, Repository, Secret } from "../api/types";
import { Field, KeyValueRows, SecretsPanel } from "../components/forms";

export function EnvironmentsPage() {
  const { client, toast } = useStore();
  const [envs, setEnvs] = useState<Environment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    client
      .listEnvironments()
      .then((e) => {
        setEnvs(e);
        setError(null);
      })
      .catch((err) => setError(describeError(err)));

  useEffect(() => {
    void load();
  }, [client]); // eslint-disable-line react-hooks/exhaustive-deps

  async function remove(e: Environment) {
    if (!window.confirm(`Delete environment "${e.name}"? Agents that use it lose their environment.`)) return;
    try {
      await client.deleteEnvironment(e.id);
      toast("Environment deleted");
      void load();
    } catch (err) {
      toast(describeError(err), "error");
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Environments</h1>
        <a href={paths.environment("new")} className="button">
          New environment
        </a>
      </header>
      {error && <div className="error">{error}</div>}
      {envs && envs.length === 0 && (
        <div className="empty">
          <p>No environments yet.</p>
          <p className="muted">An environment is the baseline a sandbox is provisioned from: secrets, env vars, packages, repositories, a setup script, network policy.</p>
          <a href={paths.environment("new")} className="button">
            New environment
          </a>
        </div>
      )}
      <ul className="conv-list">
        {envs?.map((e) => (
          <li key={e.id}>
            <a className="conv-row" href={paths.environment(e.id)}>
              <div className="conv-main">
                <div className="conv-title">
                  <span className="strong">{e.name}</span>
                  {e.networking_type === "limited" && <span className="tag">limited net</span>}
                </div>
                <div className="conv-sub muted">
                  {e.secret_count ?? 0} secret{e.secret_count === 1 ? "" : "s"} · {Object.keys(e.env_vars ?? {}).length} var
                  {Object.keys(e.env_vars ?? {}).length === 1 ? "" : "s"} · {sumPackages(e)} package{sumPackages(e) === 1 ? "" : "s"} ·{" "}
                  {(e.repositories ?? []).length} repo{(e.repositories ?? []).length === 1 ? "" : "s"}
                  {e.agent_count ? ` · used by ${e.agent_count} agent${e.agent_count === 1 ? "" : "s"}` : ""}
                </div>
              </div>
            </a>
            <button className="icon danger-icon" title="Delete" aria-label="Delete" onClick={() => void remove(e)}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function sumPackages(e: Environment): number {
  return Object.values(e.packages ?? {}).reduce((n, list) => n + (list?.length ?? 0), 0);
}

export function EnvironmentFormPage({ id }: { id: string | "new" }) {
  const { client, toast } = useStore();
  const isNew = id === "new";
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [env, setEnv] = useState<Environment | null>(null);
  const [secrets, setSecrets] = useState<Secret[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [packages, setPackages] = useState<Record<string, string>>({}); // manager → one per line
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([]);
  const [setup, setSetup] = useState("");
  const [netType, setNetType] = useState<"unrestricted" | "limited">("unrestricted");
  const [hosts, setHosts] = useState("");
  const [repos, setRepos] = useState<Repository[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([client.catalog(), isNew ? Promise.resolve(null) : client.getEnvironment(id)])
      .then(([c, e]) => {
        if (cancelled) return;
        setCatalog(c);
        if (e) {
          setEnv(e);
          setName(e.name);
          setPackages(Object.fromEntries(Object.entries(e.packages ?? {}).map(([m, list]) => [m, (list ?? []).join("\n")])));
          setEnvVars(Object.entries(e.env_vars ?? {}).map(([key, value]) => ({ key, value })));
          setSetup(e.setup_script ?? "");
          setNetType(e.networking_type ?? "unrestricted");
          setHosts((e.networking_config?.allowed_hosts ?? []).join("\n"));
          setRepos(e.repositories ?? []);
          client.listEnvSecrets(e.id).then((s) => !cancelled && setSecrets(s)).catch(() => setSecrets([]));
        }
      })
      .catch((err) => !cancelled && setError(describeError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [client, id, isNew]);

  const managers = [...new Set([...(catalog?.package_managers ?? []), ...Object.keys(packages)])];

  function toInput(): EnvironmentInput {
    const pk: Record<string, string[]> = {};
    for (const [m, text] of Object.entries(packages)) {
      const list = text.split("\n").map((s) => s.trim()).filter(Boolean);
      if (list.length) pk[m] = list;
    }
    return {
      name: name.trim(),
      packages: pk,
      env_vars: Object.fromEntries(envVars.filter((v) => v.key.trim()).map((v) => [v.key.trim(), v.value])),
      setup_script: setup,
      networking_type: netType,
      networking_config: { allowed_hosts: netType === "limited" ? hosts.split("\n").map((h) => h.trim()).filter(Boolean) : [] },
      repositories: repos.filter((r) => r.url.trim() && r.mount_path.trim()),
    };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        const created = await client.createEnvironment(toInput());
        toast("Environment created — add its secrets below");
        navigate(paths.environment(created.id));
      } else {
        await client.updateEnvironment(id, toInput());
        toast("Environment saved");
        navigate(paths.environments);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const addSecret = async (key: string, value: string) => {
    try {
      await client.putEnvSecret(id, key, value);
      setSecrets(await client.listEnvSecrets(id));
      toast(`Set ${key}`);
    } catch (err) {
      toast(describeError(err), "error");
    }
  };
  const delSecret = async (key: string) => {
    if (!window.confirm(`Delete secret ${key}?`)) return;
    try {
      await client.deleteEnvSecret(id, key);
      setSecrets(await client.listEnvSecrets(id));
    } catch (err) {
      toast(describeError(err), "error");
    }
  };

  if (loading) return <div className="page muted">Loading…</div>;

  return (
    <div className="page narrow">
      <header className="page-header">
        <h1>{isNew ? "New environment" : `Edit ${env?.name ?? "environment"}`}</h1>
        <a href={paths.environments} className="button secondary small">
          Cancel
        </a>
      </header>
      <form className="card stack" onSubmit={submit}>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} autoFocus={isNew} />
        </Field>

        <fieldset className="fs">
          <legend>Packages</legend>
          <div className="grid2">
            {managers.map((m) => (
              <Field key={m} label={m} hint={catalog && !catalog.package_managers.includes(m) ? "stored, but provisioning does not install this manager" : "one per line"}>
                <textarea rows={3} className="mono" value={packages[m] ?? ""} onChange={(e) => setPackages({ ...packages, [m]: e.target.value })} />
              </Field>
            ))}
          </div>
        </fieldset>

        <Field label="Env vars" optional hint="Plain (non-secret) variables. Secrets are set separately and encrypted at rest.">
          <KeyValueRows rows={envVars} onChange={setEnvVars} />
        </Field>

        <fieldset className="fs">
          <legend>Repositories</legend>
          {repos.map((r, i) => (
            <div key={i} className="kv-row">
              <input className="mono" placeholder="https://github.com/owner/repo" value={r.url} onChange={(e) => setRepos(repos.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
              <input className="mono" placeholder="/workspace/repo" value={r.mount_path} onChange={(e) => setRepos(repos.map((x, j) => (j === i ? { ...x, mount_path: e.target.value } : x)))} />
              <button type="button" className="icon" aria-label="Remove" onClick={() => setRepos(repos.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
          <button type="button" className="secondary small" onClick={() => setRepos([...repos, { url: "", mount_path: "" }])}>
            + Add repository
          </button>
        </fieldset>

        <Field label="Setup script" optional hint="Runs after packages and clones, before the first turn.">
          <textarea rows={6} className="mono" value={setup} onChange={(e) => setSetup(e.target.value)} placeholder="#!/bin/bash" />
        </Field>

        <fieldset className="fs">
          <legend>Networking</legend>
          <div className="row wrap">
            <label className="check">
              <input type="radio" checked={netType === "unrestricted"} onChange={() => setNetType("unrestricted")} /> unrestricted
            </label>
            <label className="check">
              <input type="radio" checked={netType === "limited"} onChange={() => setNetType("limited")} /> limited to allowed hosts
            </label>
          </div>
          {netType === "limited" && (
            <Field label="Allowed hosts" hint="one per line">
              <textarea rows={4} className="mono" value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="api.github.com" />
            </Field>
          )}
        </fieldset>

        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? "Saving…" : isNew ? "Create environment" : "Save"}
          </button>
        </div>
      </form>

      {!isNew && (
        <section className="card stack" style={{ marginTop: 16 }}>
          <h2 className="h2">Secrets</h2>
          <p className="muted small">Encrypted at rest with your tenant key; values are write-only here and only ever decrypted into the sandbox.</p>
          <SecretsPanel secrets={secrets} onAdd={addSecret} onDelete={delSecret} />
        </section>
      )}
    </div>
  );
}
