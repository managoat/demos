import { useCallback, useEffect, useMemo, useState } from "react";
import type { FountainClient } from "../api/client";
import { describeError } from "../api/client";
import type { Agent, Environment, McpServer, Teammate } from "../api/types";
import {
  CONNECTOR_CATALOG,
  CONNECTOR_CATEGORIES,
  buildCustomServer,
  connectorFor,
  describeServer,
  missingVars,
  searchConnectors,
  slugify,
  validSecretKey,
  validServerId,
  withServer,
  withoutServer,
  type Connector,
  type ConnectorSecret,
} from "../lib/connectors";
import { Tile } from "./SkillsTab";

/** A token being asked for: which server it is for, which secret, whether to reuse the one already saved, and the value typed so far. */
interface Asking {
  id: string;
  secret: ConnectorSecret;
  reuse: boolean;
  value: string;
  /** the server to connect once the token is saved (a catalog connect); absent when only the token is missing */
  install?: McpServer;
}

/**
 * The Apps tab (after OpenMausBot's connected-apps marketplace): the apps
 * the teammate can use as tools — each an MCP server. A catalog of hosted
 * ones connects in a click, or a click and a token; a custom server takes a
 * URL or a command. Tokens are saved as secrets on the teammate's
 * environment (made on the spot if they have none) and referenced as
 * `${VAR}` from the server definition — the agent never holds the value.
 */
export function AppsTab({
  client,
  agent,
  teammate,
  envs,
  onEnvs,
  onAgent,
}: {
  client: FountainClient;
  agent: Agent | null;
  teammate: Teammate;
  envs: Environment[];
  onEnvs: (envs: Environment[]) => void;
  onAgent: (a: Agent) => void;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [custom, setCustom] = useState(false);
  /** keys of the secrets on the teammate's environment; null while unknown */
  const [secretKeys, setSecretKeys] = useState<string[] | null>(null);

  const servers = useMemo(() => agent?.mcp_servers ?? {}, [agent]);
  const conv = teammate.conversation;
  // Where `${VAR}` is resolved from: the conversation's environment (it is what
  // a fresh thread carries over), else the agent's own.
  const envId = conv.environment_id ?? agent?.environment_id ?? null;
  const envName = envId ? (envs.find((e) => e.id === envId)?.name ?? "their environment") : null;

  useEffect(() => {
    if (!envId) {
      setSecretKeys([]);
      return;
    }
    let cancelled = false;
    client
      .listEnvironmentSecrets(envId)
      .then((rows) => !cancelled && setSecretKeys(rows.map((r) => r.key)))
      .catch(() => !cancelled && setSecretKeys(null));
    return () => {
      cancelled = true;
    };
  }, [client, envId]);

  const saveServers = async (next: Record<string, McpServer>): Promise<void> => {
    if (!agent) throw new Error("Still loading the agent");
    onAgent(await client.updateAgent(agent.id, { mcp_servers: next }));
  };

  /** The environment a token goes to — made on the spot when the teammate has none. */
  const ensureEnv = useCallback(async (): Promise<string> => {
    if (envId) return envId;
    if (!agent) throw new Error("Still loading the agent");
    const env = await client.createEnvironment(`${teammate.name}'s environment`);
    onEnvs([...envs, env]);
    onAgent(await client.updateAgent(agent.id, { environment_id: env.id }));
    return env.id;
  }, [agent, client, envId, envs, onAgent, onEnvs, teammate.name]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const connect = (c: Connector) => {
    if (c.secret) {
      setAsking({ id: c.id, secret: c.secret, reuse: secretKeys?.includes(c.secret.key) ?? false, value: "", install: c.server });
      return;
    }
    void run(c.id, () => saveServers(withServer(servers, c.id, c.server)));
  };

  /** A custom server (or a catalog one whose token went missing) asking for one `${VAR}`. */
  const askFor = (id: string, key: string) => {
    const c = connectorFor(id);
    const secret: ConnectorSecret = c?.secret?.key === key ? c.secret : { key, label: key, help: "Whatever this server expects for it", helpUrl: "" };
    setAsking({ id, secret, reuse: false, value: "" });
  };

  const finishAsking = async () => {
    if (!asking) return;
    const { id, secret, reuse, install } = asking;
    const value = asking.value.trim();
    if (!reuse && !value) return;
    const ok = await run(id, async () => {
      const env = await ensureEnv();
      if (!reuse) {
        await client.putEnvironmentSecret(env, secret.key, value);
        setSecretKeys((k) => (k && k.includes(secret.key) ? k : [...(k ?? []), secret.key]));
      }
      if (install) await saveServers(withServer(servers, id, install));
    });
    if (ok) setAsking(null);
  };

  const disconnect = (id: string) => void run(id, () => saveServers(withoutServer(servers, id)));

  const installed = Object.entries(servers);
  const matching = useMemo(() => searchConnectors(query, CONNECTOR_CATALOG), [query]);
  const byCategory = CONNECTOR_CATEGORIES.map((cat) => ({ cat, items: matching.filter((c) => c.category === cat) })).filter((g) => g.items.length);
  const tokenForm = (id: string) => asking && asking.id === id && <TokenForm asking={asking} setAsking={setAsking} envName={envName} busy={busy === id} onSubmit={() => void finishAsking()} />;

  return (
    <div className="tab-body">
      <p className="muted small tab-lede">
        Apps are tools {teammate.name} can call — GitHub, a database, web search — each an MCP server. Connect one from the catalog, or add any server by URL or command.
      </p>

      {error && <div className="error">{error}</div>}

      <section>
        <div className="section-head">
          <h3>Connected</h3>
          <span className="muted small">{installed.length === 0 ? "nothing yet" : `${installed.length} app${installed.length === 1 ? "" : "s"}`}</span>
        </div>
        {installed.length > 0 && (
          <ul className="pick-list">
            {installed.map(([id, def]) => {
              const c = connectorFor(id);
              const missing = secretKeys ? missingVars(def, secretKeys) : [];
              return (
                <li key={id} className="pick-row">
                  <Tile text={c?.label ?? id} domain={c?.domain} />
                  <div className="pick-text">
                    <div className="pick-title">
                      {c?.label ?? id}
                      {!c && <span className="tag">custom</span>}
                      {missing.map((k) => (
                        <button key={k} type="button" className="tag warn as-button" title={`${k} is not among the environment's secrets — the computer cannot be set up until it is. Click to add it.`} onClick={() => askFor(id, k)}>
                          needs {k}
                        </button>
                      ))}
                    </div>
                    <div className="pick-sub mono">{describeServer(def)}</div>
                    {tokenForm(id)}
                  </div>
                  <button type="button" className="secondary small" disabled={!agent || busy !== null} onClick={() => disconnect(id)} title="Disconnect — the token, if any, stays on the environment">
                    {busy === id ? "…" : "Disconnect"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <div className="section-head">
          <h3>Connect an app</h3>
          <button type="button" className={`secondary small ${custom ? "active" : ""}`} onClick={() => setCustom(!custom)}>
            Custom server…
          </button>
        </div>

        {custom && (
          <CustomServerForm
            existing={Object.keys(servers)}
            busy={busy === "custom"}
            onCancel={() => setCustom(false)}
            onAdd={(id, def) => void run("custom", () => saveServers(withServer(servers, id, def))).then((ok) => ok && setCustom(false))}
          />
        )}

        <label className="search">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search apps — github, postgres, search, docs…" aria-label="Search apps" />
        </label>
        {byCategory.length === 0 && (
          <div className="muted small pick-empty">
            Nothing in the catalog matches. Any MCP server connects with <b>Custom server…</b> above.
          </div>
        )}
        {byCategory.map((g) => (
          <div key={g.cat} className="pick-group">
            <div className="pick-group-head">{g.cat}</div>
            <ul className="pick-list">
              {g.items.map((c) => {
                const has = c.id in servers;
                const open = !has && asking?.id === c.id;
                return (
                  <li key={c.id} className={`pick-row ${has ? "has" : ""}`}>
                    <Tile text={c.label} domain={c.domain} />
                    <div className="pick-text">
                      <div className="pick-title">
                        {c.label}
                        {c.kind === "stdio" && (
                          <span className="tag" title="Runs on their computer (npx)">
                            local
                          </span>
                        )}
                        {!c.secret && <span className="tag ok">no sign-in</span>}
                      </div>
                      <div className="pick-sub">{c.blurb}</div>
                      {open && tokenForm(c.id)}
                    </div>
                    {has ? (
                      <button type="button" className="secondary small added" disabled={!agent || busy !== null} onClick={() => disconnect(c.id)} title="Disconnect">
                        {busy === c.id ? "…" : "✓ Connected"}
                      </button>
                    ) : open ? null : (
                      <button type="button" className="small" disabled={!agent || busy !== null} onClick={() => connect(c)}>
                        {busy === c.id ? "…" : "Connect"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        <div className="muted small pick-foot">
          Tokens are saved as secrets on {envName ? <b>{envName}</b> : <>an environment made for {teammate.name}</>} and resolved when their computer is set up; the agent only references them by name. Apps that can only sign in through a browser are not in the catalog — a teammate's computer has no browser to finish that in.
        </div>
      </section>
    </div>
  );
}

function TokenForm({ asking, setAsking, envName, busy, onSubmit }: { asking: Asking; setAsking: (a: Asking | null) => void; envName: string | null; busy: boolean; onSubmit: () => void }) {
  const s = asking.secret;
  const where = envName ?? "an environment made for this teammate";
  return (
    <form
      className="token-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {asking.reuse ? (
        <div className="small">
          <span className="mono">{s.key}</span> is already on {where} — it will be used.{" "}
          <button type="button" className="linkish" onClick={() => setAsking({ ...asking, reuse: false })}>
            Replace it
          </button>
        </div>
      ) : (
        <label>
          {s.label}
          <input type="password" value={asking.value} onChange={(e) => setAsking({ ...asking, value: e.target.value })} placeholder={s.placeholder ?? "paste it here"} autoFocus autoComplete="off" spellCheck={false} />
          <span className="hint">
            {s.help}
            {s.helpUrl && (
              <>
                {" — "}
                <a href={s.helpUrl} target="_blank" rel="noreferrer">
                  open
                </a>
              </>
            )}
            . Saved as <span className="mono">{s.key}</span> on {where}; never shown again.
          </span>
        </label>
      )}
      <div className="row end">
        <button type="button" className="secondary small" onClick={() => setAsking(null)} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="small" disabled={busy || (!asking.reuse && !asking.value.trim())}>
          {busy ? "Saving…" : asking.install ? "Connect" : "Save"}
        </button>
      </div>
    </form>
  );
}

function CustomServerForm({ existing, busy, onCancel, onAdd }: { existing: string[]; busy: boolean; onCancel: () => void; onAdd: (id: string, def: McpServer) => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState("");
  const [command, setCommand] = useState("");
  const [env, setEnv] = useState("");
  const id = slugify(name);
  const built = buildCustomServer({ kind, url, command, headers, env });
  const replacing = existing.includes(id);
  const varHint = (text: string) => {
    const bad = [...text.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]!).filter((k) => !validSecretKey(k));
    return bad.length ? `${bad.join(", ")}: secret names are UPPER_SNAKE_CASE` : null;
  };
  const hint = varHint(headers) ?? varHint(env) ?? varHint(url);
  const ok = Boolean(name) && validServerId(id) && built.ok && !hint;
  return (
    <form
      className="add-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok && built.ok) onAdd(id, built.server);
      }}
    >
      <div className="row" style={{ alignItems: "flex-start" }}>
        <label style={{ flex: 1 }}>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Linear" autoFocus />
          {name && (
            <span className="hint">
              {validServerId(id) ? (
                <>
                  saved as <span className="mono">{id}</span>
                  {replacing ? " — already connected; this replaces it" : ""}
                </>
              ) : (
                "The name needs a letter or digit in it"
              )}
            </span>
          )}
        </label>
        <label style={{ width: 180 }}>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as "http" | "stdio")}>
            <option value="http">Hosted (URL)</option>
            <option value="stdio">Local (command)</option>
          </select>
        </label>
      </div>
      {kind === "http" ? (
        <>
          <label>
            URL
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} />
          </label>
          <label>
            Headers <span className="muted">(optional, one per line)</span>
            <textarea value={headers} onChange={(e) => setHeaders(e.target.value)} rows={2} placeholder={"Authorization=Bearer ${EXAMPLE_TOKEN}"} className="mono" spellCheck={false} />
            <span className="hint">
              Write a token as <span className="mono">{"${NAME}"}</span>; after adding, the row offers to save NAME as a secret — the value stays out of the agent.
            </span>
          </label>
        </>
      ) : (
        <>
          <label>
            Command
            <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx -y some-mcp-server" className="mono" spellCheck={false} />
            <span className="hint">Runs on their computer; npx packages work, anything else has to be installed there.</span>
          </label>
          <label>
            Environment variables <span className="muted">(optional, one per line)</span>
            <textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={2} placeholder={"API_TOKEN=${EXAMPLE_TOKEN}"} className="mono" spellCheck={false} />
          </label>
        </>
      )}
      {(hint || (!built.ok && (url || command))) && <div className="error-inline small">{hint ?? (!built.ok ? built.error : "")}</div>}
      <div className="row end">
        <button type="button" className="secondary small" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="small" disabled={!ok || busy}>
          {busy ? "Adding…" : replacing ? "Replace" : "Add"}
        </button>
      </div>
    </form>
  );
}
