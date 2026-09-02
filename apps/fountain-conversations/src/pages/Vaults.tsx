import { useEffect, useState, type FormEvent } from "react";
import { useStore } from "../store";
import { navigate, paths } from "../router";
import { describeError } from "../api/client";
import type { Secret, Vault } from "../api/types";
import { Field, SecretsPanel } from "../components/forms";

export function VaultsPage() {
  const { client, toast } = useStore();
  const [vaults, setVaults] = useState<Vault[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    client
      .listVaults()
      .then((v) => {
        setVaults(v);
        setError(null);
      })
      .catch((err) => setError(describeError(err)));

  useEffect(() => {
    void load();
  }, [client]); // eslint-disable-line react-hooks/exhaustive-deps

  async function remove(v: Vault) {
    if (!window.confirm(`Delete vault "${v.name}" and its secrets?`)) return;
    try {
      await client.deleteVault(v.id);
      toast("Vault deleted");
      void load();
    } catch (err) {
      toast(describeError(err), "error");
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Vaults</h1>
        <a href={paths.vault("new")} className="button">
          New vault
        </a>
      </header>
      {error && <div className="error">{error}</div>}
      {vaults && vaults.length === 0 && (
        <div className="empty">
          <p>No vaults yet.</p>
          <p className="muted">A vault is a bag of secret overrides attached to a conversation at launch; its values win over the environment's on key collision.</p>
          <a href={paths.vault("new")} className="button">
            New vault
          </a>
        </div>
      )}
      <ul className="conv-list">
        {vaults?.map((v) => (
          <li key={v.id}>
            <a className="conv-row" href={paths.vault(v.id)}>
              <div className="conv-main">
                <div className="conv-title">
                  <span className="strong">{v.name}</span>
                </div>
                <div className="conv-sub muted">
                  {v.secret_count ?? 0} secret{v.secret_count === 1 ? "" : "s"}
                  {v.description ? ` · ${v.description}` : ""}
                </div>
              </div>
            </a>
            <button className="icon danger-icon" title="Delete" aria-label="Delete" onClick={() => void remove(v)}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function VaultFormPage({ id }: { id: string | "new" }) {
  const { client, toast } = useStore();
  const isNew = id === "new";
  const [vault, setVault] = useState<Vault | null>(null);
  const [secrets, setSecrets] = useState<Secret[] | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!isNew);

  useEffect(() => {
    if (isNew) return;
    let cancelled = false;
    client
      .getVault(id)
      .then((v) => {
        if (cancelled) return;
        setVault(v);
        setName(v.name);
        setDescription(v.description ?? "");
        return client.listVaultSecrets(id).then((s) => !cancelled && setSecrets(s));
      })
      .catch((err) => !cancelled && setError(describeError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [client, id, isNew]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        const created = await client.createVault({ name: name.trim(), description });
        toast("Vault created — add its secrets below");
        navigate(paths.vault(created.id));
      } else {
        await client.updateVault(id, { name: name.trim(), description });
        toast("Vault saved");
        navigate(paths.vaults);
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const addSecret = async (key: string, value: string) => {
    try {
      await client.putVaultSecret(id, key, value);
      setSecrets(await client.listVaultSecrets(id));
      toast(`Set ${key}`);
    } catch (err) {
      toast(describeError(err), "error");
    }
  };
  const delSecret = async (key: string) => {
    if (!window.confirm(`Delete secret ${key}?`)) return;
    try {
      await client.deleteVaultSecret(id, key);
      setSecrets(await client.listVaultSecrets(id));
    } catch (err) {
      toast(describeError(err), "error");
    }
  };

  if (loading) return <div className="page muted">Loading…</div>;

  return (
    <div className="page narrow">
      <header className="page-header">
        <h1>{isNew ? "New vault" : `Edit ${vault?.name ?? "vault"}`}</h1>
        <a href={paths.vaults} className="button secondary small">
          Cancel
        </a>
      </header>
      <form className="card stack" onSubmit={submit}>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} autoFocus={isNew} />
        </Field>
        <Field label="Description" optional>
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? "Saving…" : isNew ? "Create vault" : "Save"}
          </button>
        </div>
      </form>
      {!isNew && (
        <section className="card stack" style={{ marginTop: 16 }}>
          <h2 className="h2">Secrets</h2>
          <p className="muted small">Encrypted at rest; write-only here. Attached to a conversation at launch, these win over the environment's values on key collision.</p>
          <SecretsPanel secrets={secrets} onAdd={addSecret} onDelete={delSecret} />
        </section>
      )}
    </div>
  );
}
