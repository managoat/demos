/**
 * The Setup panel: everything this machine is declared to be made of.
 *
 * The forms live apart from the rows they produce, on purpose. [Details](./Details.tsx)
 * is the machine as it is — a thing to keep open beside a terminal and glance
 * at — and this is the machine as it was asked for. Mixing them made one long
 * page where the state you wanted to watch was pushed under the forms you had
 * finished with, and made "pending" look like a property of a form rather than
 * a fact about a box.
 *
 * The tiers are the same three, in the same order, under the same headings,
 * because the point of splitting is not to have two layouts. `TIER` in
 * [Panel](./Panel.tsx) is what keeps them from drifting.
 *
 * Nothing here is rendered for anybody but the owner — App does not mount this
 * panel or its tab otherwise, so the guest case is an absence rather than a
 * disabled form. And nothing here applies anything: saving declares, and what
 * declaring costs is the sentence under each heading.
 */
import { useState } from "react";
import type { Agent, Catalog, Connection, ConnectionProvider, Environment, Repository, Vault } from "../api/types";
import type { BoxDrift } from "../lib/machine";
import { needsApply, packageEntries, shortRepo } from "../lib/machine";
import { SectionHead, Editor, TIER } from "./Panel";
import { Skills } from "./Skills";

export interface SetupProps {
  agent: Agent;
  environment: Environment;
  vault: Vault | null;
  /** What this Fountain offers: package managers, and the verified MCP servers. */
  catalog: Catalog | null;
  /**
   * The owner's connections and where to make one. `null` — not `[]` — where
   * the egress broker is not on for this person, which a self-hosted Fountain
   * or an unenrolled account still answers. That null is the panel's only
   * evidence about whether anything is brokered at all, and two sections depend
   * on it. See `client.listConnections`.
   */
  connections: Connection[] | null;
  providers: ConnectionProvider[] | null;
  /** Where to send somebody to connect one. Null before `/api/config` answers. */
  fountainUrl: string | null;
  envSecretKeys: string[];
  vaultSecretKeys: string[];
  /**
   * The same drift Details renders, for the line that hands over to it.
   *
   * It is the whole object rather than a count because the handover has to
   * agree with what is actually on the other panel, and "is there an Apply
   * button over there" is `needsApply(drift) && drift.known` — two facts. A
   * count alone got this wrong in exactly the state it mattered most: an
   * unreadable receipt zeroed it, so Setup went quiet at the moment somebody
   * had just declared something that went nowhere.
   */
  drift: BoxDrift;
  busy: string | null;
  onSaveEnvironment: (patch: { repositories?: Repository[]; packages?: Record<string, string[]>; setup_script?: string }) => Promise<void>;
  onAddSecret: (where: "env" | "vault", key: string, value: string) => Promise<void>;
  onRemoveSecret: (where: "env" | "vault", key: string) => Promise<void>;
  onSaveAgent: (patch: Partial<Agent>) => Promise<void>;
  /** A new box, same declared settings. */
  onRebuild: () => Promise<void>;
  /** A new box and no settings at all — every secret goes. */
  onReset: () => Promise<void>;
  /**
   * The above, and the computer stops existing. Null when there is nothing to
   * offer — somebody else's machine, or the only one this account has, which
   * cannot go because an account always has a computer. **Start over** is the
   * operation for emptying that one, and it is already here.
   */
  onRemove: (() => Promise<void>) | null;
  /** What the owner calls this computer, for the sentence that removes it. */
  computerName: string;
  /** Back to the rows these forms produce, and to the button that applies them. */
  onDetails: () => void;
}

export function Setup(props: SetupProps) {
  const { drift } = props;
  const pending = drift.statuses.filter((s) => s.state !== "applied").length;
  /** Whether there is an Apply button waiting on the other panel. */
  const appliable = needsApply(drift) && drift.known;

  return (
    <div className="panel machine setup">
      <header className="panel-head">
        <div>
          <h2>Setup</h2>
          <p className="dim">what this machine is declared to be</p>
        </div>
      </header>

      {/*
        Saving here does not touch the running box, and the only honest place
        to see that is the other panel — so when something is waiting, this one
        says so and hands over rather than growing a second Apply button. Two
        buttons that apply would be two places to learn what "applied" means.

        An unreadable receipt gets its own sentence rather than silence. It is
        the state where a save has most obviously gone nowhere, and the thing
        waiting on Details is then "ask the box what it has" — so the line says
        that instead of promising an Apply that is not rendered.
      */}
      {pending > 0 && (
        <p className={`note${drift.known ? "" : " warn"}`}>
          {pending === 1 ? "1 thing is" : `${pending} things are`} declared and not on the box.{" "}
          {drift.known ? "Applying it is one turn on this machine." : "The box has not reported what it already has."}
          <button className="ghost" onClick={props.onDetails}>
            {appliable ? "Review and apply" : "Open Details"}
          </button>
        </p>
      )}

      {/* ── tier: box ─────────────────────────────────────────────────── */}
      <section>
        <SectionHead
          {...TIER.box}
          note="The environment builds the disk, so changing it here does nothing to the machine you are running until it is applied."
        />
        <Repositories
          environment={props.environment}
          envSecretKeys={props.envSecretKeys}
          vaultSecretKeys={props.vaultSecretKeys}
          hasVault={!!props.vault}
          brokered={props.providers !== null}
          onSave={props.onSaveEnvironment}
          onAddSecret={props.onAddSecret}
        />
        <Packages environment={props.environment} catalog={props.catalog} onSave={props.onSaveEnvironment} />
        <SetupScript environment={props.environment} onSave={props.onSaveEnvironment} />
      </section>

      {/* ── tier: session ─────────────────────────────────────────────── */}
      <section>
        <SectionHead
          {...TIER.session}
          note="Fountain writes these into the machine as a tab opens. Tabs already running kept what they started with, so a save reaches the next tab and not this one."
        />
        <Secrets
          envKeys={props.envSecretKeys}
          vaultKeys={props.vaultSecretKeys}
          hasVault={!!props.vault}
          onAdd={props.onAddSecret}
          onRemove={props.onRemoveSecret}
        />
        <McpServers
          agent={props.agent}
          catalog={props.catalog}
          connections={props.connections}
          providers={props.providers}
          fountainUrl={props.fountainUrl}
          onSave={props.onSaveAgent}
        />
        <Skills agent={props.agent} onSave={props.onSaveAgent} />
      </section>

      {/* ── tier: machine ─────────────────────────────────────────────── */}
      <section>
        <SectionHead {...TIER.machine} note="The runtime is baked into the disk when the box is built, so this tier has no settings — only a way to get a different disk." />
        <Replace
          onRebuild={props.onRebuild}
          onReset={props.onReset}
          onRemove={props.onRemove}
          computerName={props.computerName}
          busy={!!props.busy}
        />
      </section>
    </div>
  );
}

// ── the editors ────────────────────────────────────────────────────────────

/**
 * Where repositories are cloned, and how a private one authenticates.
 *
 * `/workspace/<name>`, not `/home/sprite/<name>`. Fountain's bundled `fountain`
 * skill is mounted into *every* sandbox and tells the agent "Cloned repos are
 * under /workspace/… Always look in /workspace/ first when you need to find
 * source code." Paddock spent a year putting them somewhere else, so the agent
 * on the box was being told to look in the wrong place by the one skill it
 * always has.
 *
 * `MOUNT_ROOT` is part of `repoId`, so changing it puts existing rows back to
 * `pending` and they re-clone on the next apply. That is the content-addressed
 * id doing its job rather than a migration to write.
 */
const MOUNT_ROOT = "/workspace";

/**
 * The one secret name that clones.
 *
 * Fountain's broker keeps a two-entry catalog — `GITHUB_TOKEN` and `GH_TOKEN`
 * — and a key under one of those names is brokered with no binding and no
 * configuration at all. What it buys is specific: the sandbox holds
 * `__github_token__`, the clone URL is written with that placeholder, and the
 * broker attaches git's real `x-access-token` basic auth on the way out. So a
 * private repository clones **with the token never on the machine**.
 *
 * A GitHub *connection* does not do this. Its `GITHUB_ACCESS_TOKEN` gets a
 * bearer rule, and git over HTTPS does not use bearer auth. It gives the agent
 * the GitHub API; it does not give it a checkout. The name is load-bearing, so
 * paddock writes it rather than asking somebody to know that.
 */
const CLONE_SECRET = "GITHUB_TOKEN";

function Repositories({
  environment,
  envSecretKeys,
  vaultSecretKeys,
  hasVault,
  brokered,
  onSave,
  onAddSecret,
}: {
  environment: Environment;
  envSecretKeys: string[];
  vaultSecretKeys: string[];
  hasVault: boolean;
  /** Whether this account has the egress broker — which is what protects the token. */
  brokered: boolean;
  onSave: SetupProps["onSaveEnvironment"];
  onAddSecret: SetupProps["onAddSecret"];
}) {
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [priv, setPriv] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const repos = environment.repositories ?? [];

  const stored = vaultSecretKeys.includes(CLONE_SECRET) ? "vault" : envSecretKeys.includes(CLONE_SECRET) ? "env" : null;
  const needsToken = priv && !stored && !token;

  async function add() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);

    // Fountain accepts https and nothing else. The SSH path existed here fully
    // implemented and was deleted rather than enabled, so this is not a
    // temporary gap — and catching it in the editor turns a failed provision on
    // somebody's machine into a sentence.
    if (!/^https:\/\//i.test(trimmed)) {
      setError("Fountain clones over https:// only — an ssh or git URL is refused when the machine is built.");
      return;
    }

    const name = trimmed.replace(/\.git$/, "").replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? "repo";

    if (priv && !stored) {
      if (!token) return;
      // The vault where there is one: a vault secret is the only kind the
      // broker can keep off the box entirely, and this is the value people are
      // most likely to regret handing to everyone they invite.
      await onAddSecret(hasVault ? "vault" : "env", CLONE_SECRET, token);
    }

    await onSave({
      repositories: [
        ...repos,
        {
          url: trimmed,
          mount_path: `${MOUNT_ROOT}/${name}`,
          ref: ref.trim() || null,
          ...(priv ? { secret_key: CLONE_SECRET } : {}),
        },
      ],
    });
    setUrl("");
    setRef("");
    setPriv(false);
    setToken("");
  }

  return (
    <Editor
      title="Repositories"
      info={
        <>
          Fountain clones over <code>https://</code> only. A private one needs a token: tick <em>private repository</em> and
          paste one, and it is kept as a secret named <code>{CLONE_SECRET}</code>. Where more than one is listed, a new tab
          branches from the first and the rest are cloned and left alone.
        </>
      }
    >
      {repos.map((r, i) => (
        <div className="editor-row" key={`${r.url}-${i}`}>
          <code>{shortRepo(r.url)}</code>
          <span className="dim">{r.mount_path}</span>
          {r.secret_key && <span className="fine">{r.secret_key}</span>}
          <button className="ghost" onClick={() => onSave({ repositories: repos.filter((_, j) => j !== i) })}>
            remove
          </button>
        </div>
      ))}

      {/* Two rows rather than one. Four controls do not fit the panel at this
          width, and the private toggle belongs beside the token field it
          reveals rather than beside the URL. */}
      <div className="editor-row">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/you/thing" spellCheck={false} />
        <input className="narrow" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="ref (optional)" spellCheck={false} />
      </div>
      <div className="editor-row">
        <label className="check" title={`Clone with ${CLONE_SECRET}`}>
          <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> private repository
        </label>
        {priv && !stored && (
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            placeholder={`${CLONE_SECRET} — a token that can read it`}
            spellCheck={false}
            autoComplete="off"
          />
        )}
        <button onClick={() => void add()} disabled={!url.trim() || needsToken}>
          add
        </button>
      </div>

      {priv && (
        <>
          <p className="fine">
            {stored ? (
              <>
                Cloning with the <code>{CLONE_SECRET}</code> already in your {stored === "vault" ? "vault" : "environment"}.
              </>
            ) : hasVault ? (
              <>
                It goes in your <strong>vault</strong>.
              </>
            ) : (
              <>
                It goes in your <strong>environment</strong>, because this Fountain has no vault for you.
              </>
            )}{" "}
            {/* The protection here comes from the broker, not from the vault.
                `GITHUB_TOKEN` is one of two names in Fountain's broker catalog,
                and `Broker.split` works on the environment and vault secrets
                merged together — so where the broker is on, either store gets
                the placeholder, and where it is off, neither does. An earlier
                draft of this line credited the vault for it, which read well
                and was not true. */}
            {brokered ? (
              <>
                Fountain&apos;s broker knows this key by name, so the machine only ever holds <code>__github_token__</code> — the
                real token is attached to the request on its way out, and nobody with a terminal here can print it.
              </>
            ) : (
              <>
                This Fountain brokers nothing for you, so it is an ordinary variable inside the machine and anyone you invite can
                read it.
              </>
            )}
          </p>
        </>
      )}

      {error && <p className="fine error">{error}</p>}

    </Editor>
  );
}

/** What Fountain installs from, when the catalog has not been read. */
const PACKAGE_MANAGERS = ["apt", "npm"];

/**
 * Packages, keyed by the manager that installs them.
 *
 * `apt` is the default because that is what the box is, but the manager is a
 * field rather than an assumption: Fountain stores `{"apt": [...], "npm": [...]}`
 * and a UI that hid the key would quietly put npm packages under apt.
 *
 * It is a list rather than a text box because Fountain "stores another key and
 * ignores it". Typing `brew` here produced a row that read as configured, sat
 * at `pending` forever, and installed nothing — the catalog knows the two
 * managers that actually exist, so it says so.
 */
function Packages({
  environment,
  catalog,
  onSave,
}: {
  environment: Environment;
  catalog: Catalog | null;
  onSave: SetupProps["onSaveEnvironment"];
}) {
  const managers = catalog?.package_managers?.length ? catalog.package_managers : PACKAGE_MANAGERS;
  const [name, setName] = useState("");
  const [manager, setManager] = useState(managers[0] ?? "apt");
  const entries = packageEntries(environment.packages);
  const current = environment.packages ?? {};
  const already = (current[manager] ?? []).includes(name.trim());

  function add() {
    const trimmed = name.trim();
    if (!trimmed || already) return;
    const next = { ...current, [manager]: [...(current[manager] ?? []), trimmed] };
    void onSave({ packages: next }).then(() => setName(""));
  }

  function remove(mgr: string, pkg: string) {
    const kept = (current[mgr] ?? []).filter((q) => q !== pkg);
    const next = { ...current };
    // An empty manager is dropped rather than left as an empty list: "apt: []"
    // reads as a thing that is configured, and it is not.
    if (kept.length) next[mgr] = kept;
    else delete next[mgr];
    void onSave({ packages: next });
  }

  return (
    <Editor title="Packages">
      {entries.length === 0 && <p className="fine">none</p>}
      {entries.map(([mgr, names]) => (
        <div className="editor-row" key={mgr}>
          <span className="dim narrow">{mgr}</span>
          <div className="chips">
            {names.map((pkg) => (
              <span className="chip" key={pkg}>
                {pkg}
                <button className="x" onClick={() => remove(mgr, pkg)} title={`remove ${pkg}`}>
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      ))}
      <div className="editor-row">
        <select className="narrow" value={manager} onChange={(e) => setManager(e.target.value)}>
          {managers.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="ripgrep"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button onClick={add} disabled={!name.trim() || !manager || already}>
          add
        </button>
      </div>
    </Editor>
  );
}

function SetupScript({ environment, onSave }: { environment: Environment; onSave: SetupProps["onSaveEnvironment"] }) {
  const saved = environment.setup_script ?? "";
  const [text, setText] = useState(saved);
  const [open, setOpen] = useState(false);
  const dirty = text !== saved;

  return (
    <Editor
      title="Setup script"
      info="Saving changes what a new box is built from. Applying runs it on this one."
      right={
        <button className="ghost" onClick={() => setOpen(!open)}>
          {open ? "hide" : "edit"}
        </button>
      }
    >
      {!open ? (
        <p className="fine">{saved.trim() ? `${saved.trim().split("\n").length} lines` : "none"}</p>
      ) : (
        <>
          <textarea className="script" value={text} onChange={(e) => setText(e.target.value)} rows={8} spellCheck={false} />
          <div className="editor-row">
            <button onClick={() => void onSave({ setup_script: text })} disabled={!dirty}>
              Save
            </button>
          </div>
        </>
      )}
    </Editor>
  );
}

function Secrets({
  envKeys,
  vaultKeys,
  hasVault,
  onAdd,
  onRemove,
}: {
  envKeys: string[];
  vaultKeys: string[];
  hasVault: boolean;
  onAdd: SetupProps["onAddSecret"];
  onRemove: SetupProps["onRemoveSecret"];
}) {
  const [where, setWhere] = useState<"env" | "vault">("env");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  async function add() {
    if (!key.trim() || !value) return;
    await onAdd(where, key.trim(), value);
    setKey("");
    setValue("");
  }

  return (
    <Editor
      title="Secrets"
      info={
        <>
          Two different things. An <strong>environment</strong> secret is put into the machine as an environment variable — the
          agent can read it. A <strong>vault</strong> secret never touches the machine: the egress broker substitutes it into
          outbound requests, so the agent uses it without ever holding it. Either way the value goes straight to Fountain —
          Paddock does not keep it, and cannot read it back.
        </>
      }
    >
      <KeyList label="environment" hint="in the box" keys={envKeys} onRemove={(k) => onRemove("env", k)} />
      {hasVault ? (
        <KeyList label="vault" hint="never on the box" keys={vaultKeys} onRemove={(k) => onRemove("vault", k)} />
      ) : (
        <p className="fine">No vault on this Fountain, so vault secrets are not available.</p>
      )}

      <div className="editor-row">
        <select value={where} onChange={(e) => setWhere(e.target.value as "env" | "vault")} disabled={!hasVault}>
          <option value="env">environment</option>
          <option value="vault">vault</option>
        </select>
        <input className="narrow" value={key} onChange={(e) => setKey(e.target.value)} placeholder="GITHUB_TOKEN" spellCheck={false} />
        <input value={value} onChange={(e) => setValue(e.target.value)} type="password" placeholder="value" spellCheck={false} autoComplete="off" />
        <button onClick={add} disabled={!key.trim() || !value}>
          add
        </button>
      </div>
    </Editor>
  );
}

function KeyList({ label, hint, keys, onRemove }: { label: string; hint: string; keys: string[]; onRemove: (k: string) => void }) {
  return (
    <div className="editor-row">
      <span className="dim narrow" title={hint}>
        {label}
      </span>
      <div className="chips">
        {keys.map((k) => (
          <span className="chip" key={k}>
            {k}
            <button className="x" onClick={() => onRemove(k)} title={`remove ${k}`}>
              ×
            </button>
          </span>
        ))}
        {keys.length === 0 && <span className="fine">none</span>}
      </div>
    </div>
  );
}

/**
 * MCP servers, from Fountain's own catalog.
 *
 * `GET /api/catalog` carries `mcp_servers`: the remote servers whose
 * authorization chain Fountain watched complete, dated. Paddock read two keys
 * of that catalog for a year and asked people to type these URLs from memory.
 *
 * The chips are three states, and the difference between them is the whole
 * point — a remote MCP server without a connection is a URL the agent cannot
 * authenticate to, and rendering it identically to one that works would be the
 * panel lying in the way this app tries hardest not to:
 *
 *   connected     there is an active connection; adding it names that connection
 *                 and the broker attaches the token in flight
 *   connect ↗     go to Fountain and authorize it. Not something paddock can do
 *                 here: connecting needs a browser session at Fountain, and this
 *                 app is not it
 *
 * The typed name + URL row stays underneath. The catalog is "a menu, not a
 * gate" and any URL Fountain can discover still works.
 */
function McpServers({
  agent,
  catalog,
  connections,
  providers,
  fountainUrl,
  onSave,
}: {
  agent: Agent;
  catalog: Catalog | null;
  connections: Connection[] | null;
  providers: ConnectionProvider[] | null;
  fountainUrl: string | null;
  onSave: SetupProps["onSaveAgent"];
}) {
  const servers = agent.mcp_servers ?? {};
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  const entries = catalog?.mcp_servers ?? [];
  // `null` is the 404 — connections do not exist on this account — as opposed
  // to an empty list, which is "they exist and you have made none". Only the
  // first of those means a remote server here can carry no credential.
  const brokered = providers !== null;
  const live = connections ?? [];
  const provs = providers ?? [];

  async function add(key: string, cfg: Record<string, unknown>) {
    await onSave({ mcp_servers: { ...servers, [key]: cfg } });
  }

  async function addTyped() {
    if (!name.trim() || !url.trim()) return;
    await add(name.trim(), { url: url.trim() });
    setName("");
    setUrl("");
  }

  function remove(key: string) {
    const next = { ...servers };
    delete next[key];
    void onSave({ mcp_servers: next });
  }

  return (
    <Editor
      title="MCP servers"
      info={
        <>
          The list is Fountain&apos;s catalog. <em>Verified{entries[0]?.verified_on ? ` ${entries[0].verified_on}` : ""}</em>{" "}
          means the authorization chain completed against each URL on that date, by a script — not an endorsement, and nothing
          was checked about the tools they offer.{" "}
          {brokered
            ? "A connection is made at Fountain, in a browser signed in as you. Paddock cannot do it here: connecting is not an API operation."
            : "This Fountain has no credential broker for you, so a remote server added here carries no credential of its own."}
        </>
      }
    >
      {Object.keys(servers).length === 0 && <p className="fine">none</p>}
      {Object.entries(servers).map(([key, cfg]) => {
        const connection = connectionOf(cfg);
        const held = live.find((c) => c.id === connection);
        return (
          <div className="editor-row" key={key}>
            <span className="row-label">{key}</span>
            <code className="dim">{urlOf(cfg)}</code>
            {connection &&
              (held?.status === "active" ? (
                <span className="fine ok">connected</span>
              ) : (
                // A connection that was revoked or lapsed leaves the entry
                // pointing at nothing. The next tool call fails with
                // "connection revoked", and that is a bad place to find out.
                <span className="fine warn-text">{held ? held.status : "connection is gone"} — reconnect at Fountain</span>
              ))}
            <button className="ghost" onClick={() => remove(key)}>
              remove
            </button>
          </div>
        );
      })}

      {entries.length > 0 && (
        <>
          <div className="chips catalog">
            {entries.map((entry) => {
              const provider = provs.find((p) => p.mcp_url === entry.url);
              const connection = provider
                ? live.find((c) => c.provider_id === provider.id && c.status === "active")
                : undefined;
              const added = Object.entries(servers).some(([, cfg]) => urlOf(cfg) === entry.url);

              if (added) {
                return (
                  <span className="chip added" key={entry.slug} title={`${entry.url} — already added`}>
                    {entry.name} ✓
                  </span>
                );
              }
              if (connection) {
                return (
                  <button
                    className="chip act"
                    key={entry.slug}
                    title={`${entry.url} — connected as ${connection.account_email ?? "you"}`}
                    onClick={() => void add(entry.slug, { type: "http", url: entry.url, connection: connection.id })}
                  >
                    {entry.name} <span className="ok">connected</span>
                  </button>
                );
              }
              // Nowhere in paddock to send them but Fountain: `connect_url` when
              // the provider already exists, the Connections page when it does
              // not, because creating one is account-level and not this app's.
              const href = provider?.connect_url ?? (fountainUrl ? `${fountainUrl}/connections` : null);
              return (
                <a
                  className={`chip act ${brokered ? "" : "inert"}`}
                  key={entry.slug}
                  href={href ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  title={`${entry.url} — verified ${entry.verified_on}${entry.dcr ? "" : "; needs a client id from an app registration of your own"}`}
                >
                  {entry.name} <span className="dim">connect ↗</span>
                </a>
              );
            })}
          </div>
        </>
      )}

      <div className="editor-row">
        <input className="narrow" value={name} onChange={(e) => setName(e.target.value)} placeholder="linear" spellCheck={false} />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/sse" spellCheck={false} />
        <button onClick={() => void addTyped()} disabled={!name.trim() || !url.trim()}>
          add
        </button>
      </div>
    </Editor>
  );
}
/**
 * Replacing the machine.
 *
 * Two operations that look similar and are not, so they are spelled out
 * rather than named: one keeps everything you configured, the other deletes
 * your secrets. Neither uses a browser confirm() — a modal that blocks the
 * page is a poor way to ask, and the thing worth showing is *what goes*,
 * which a one-line dialog cannot say.
 */
function Replace({
  onRebuild,
  onReset,
  onRemove,
  computerName,
  busy,
}: {
  onRebuild: () => Promise<void>;
  onReset: () => Promise<void>;
  onRemove: (() => Promise<void>) | null;
  computerName: string;
  busy: boolean;
}) {
  const [asking, setAsking] = useState<"rebuild" | "reset" | "remove" | null>(null);
  const [working, setWorking] = useState(false);

  async function go(which: "rebuild" | "reset" | "remove") {
    setWorking(true);
    try {
      if (which === "rebuild") await onRebuild();
      else if (which === "reset") await onReset();
      else await onRemove?.();
    } finally {
      setWorking(false);
      setAsking(null);
    }
  }

  if (working) return <p className="fine">Retiring this machine…</p>;

  if (asking === "rebuild") {
    return (
      <div className="note warn">
        <p>
          <strong>Build a new machine?</strong> This one ends, and everything that only ever lived on its disk goes with it.
        </p>
        <p className="fine">
          Kept: repositories, packages, the setup script, secrets, MCP servers and skills. The new box starts bare and you apply
          them to it, the same as any other change.
        </p>
        <div className="editor-row">
          <button onClick={() => void go("rebuild")} disabled={busy}>
            Build a new one
          </button>
          <button className="ghost" onClick={() => setAsking(null)}>
            Cancel
          </button>
          {busy && <span className="fine">A tab is mid-turn — that turn ends too.</span>}
        </div>
      </div>
    );
  }

  if (asking === "reset") {
    return (
      <div className="note danger">
        <p>
          <strong>Delete everything?</strong> The machine, and every setting on it.
        </p>
        <p className="fine">
          Repositories, packages, the setup script, MCP servers, skills and <strong>every secret you have added</strong> are
          deleted from Fountain. Anyone you invited loses their way in, and the link stops working. This cannot be undone, and
          the next sign-in starts from nothing.
        </p>
        <div className="editor-row">
          <button className="danger" onClick={() => void go("reset")} disabled={busy}>
            Delete everything
          </button>
          <button className="ghost" onClick={() => setAsking(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (asking === "remove") {
    return (
      <div className="note danger">
        <p>
          <strong>Remove {computerName || "this computer"}?</strong> It stops existing, and you go back to your other one.
        </p>
        <p className="fine">
          Everything <strong>Start over</strong> deletes goes — the machine, the repositories, packages, setup script, MCP
          servers, skills and every secret — and the computer itself goes with it, so there is nothing left to come back to.
          Anyone you invited to a terminal on it loses their way in. Your other computers are untouched.
        </p>
        <div className="editor-row">
          <button className="danger" onClick={() => void go("remove")} disabled={busy}>
            Remove this computer
          </button>
          <button className="ghost" onClick={() => setAsking(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <Editor
      title="Replace"
      info={
        <>
          <strong>Build a new machine</strong> keeps everything declared above and starts you on a fresh disk — useful when
          this one is in a state you would rather not unpick. <strong>Start over</strong> deletes the machine and the
          settings with it, secrets included, and leaves you an empty computer of the same name.
          {onRemove ? (
            <>
              {" "}
              <strong>Remove</strong> is that, and the computer too — available because you have another one to go back to.
            </>
          ) : (
            <>
              {" "}
              There is no <strong>Remove</strong> here because this is your only computer, and an account always has one.
            </>
          )}
        </>
      }
    >
      <div className="editor-row">
        <button onClick={() => setAsking("rebuild")}>Build a new machine</button>
        <button className="ghost danger-text" onClick={() => setAsking("reset")}>
          Start over
        </button>
        {onRemove && (
          <button className="ghost danger-text" onClick={() => setAsking("remove")}>
            Remove
          </button>
        )}
      </div>
    </Editor>
  );
}
function urlOf(cfg: unknown): string {
  if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
    const url = (cfg as { url?: unknown }).url;
    if (typeof url === "string") return url;
  }
  return "";
}

/** The connection id an `mcp_servers` entry names, when it names one. */
function connectionOf(cfg: unknown): string | null {
  if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
    const id = (cfg as { connection?: unknown }).connection;
    if (typeof id === "string" && id) return id;
  }
  return null;
}
