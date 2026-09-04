/**
 * The Machine panel: what you have asked for, what the box actually has, and
 * the one button that closes the gap.
 *
 * Every row carries its tier, because the tier is the honest answer to "when
 * does this take effect?" and there are three different answers:
 *
 *   on the box     the environment builds the disk. Changing it does nothing to
 *                  a running machine until an apply turn does the work.
 *   next tab       the agent and the secrets are injected when a session
 *                  starts. Already-open tabs kept what they started with.
 *   new machine    the runtime is baked in. This one really cannot be done to
 *                  a machine you are already using.
 *
 * The explanations live behind the (i) next to each heading. There are a lot
 * of them — three tiers, two kinds of secret, what Fountain's "verified" claim
 * about an MCP server does and does not cover, what skills.sh is and is not,
 * two ways to replace a box — and a panel that said all of it at once buried
 * the rows and the buttons that are the point of it. Nothing was deleted; it
 * is one click away, next to the thing it is about.
 *
 * What stays on screen unasked is state, and the one disclosure that is about
 * an action in progress: tick "private repository" and the panel says, then and
 * there, where that token ends up and who can read it.
 *
 * The panel never says "applied" on trust. Tier-`box` rows are `applied` only
 * because the machine itself wrote the id into its receipt, read back over the
 * read-only sandbox routes; when the receipt cannot be read the panel says the
 * box has not reported rather than guessing.
 */
import { useState } from "react";
import type { Agent, Catalog, Connection, ConnectionProvider, Environment, Repository, Sandbox, Vault } from "../api/types";
import { paddock, type Role } from "../api/paddock";
import type { BoxDrift, DesiredItem, ItemStatus } from "../lib/machine";
import { needsApply, packageEntries, shortRepo } from "../lib/machine";
import type { SkillEntry, SkillHit } from "../lib/skills";
import { githubSkill, hitToSkill, inlineSkill, parseSource, readSkills, skillKey, skillLabel } from "../lib/skills";
import type { Tab } from "../../shared/tabs";

export interface MachineProps {
  /**
   * Everyone in the paddock sees this panel; only the owner can act on it.
   * Editors and Apply are rendered *absent* for anybody else rather than
   * disabled — a greyed-out secrets box invites somebody to wonder what they
   * would have to do to use it, and the answer is "own this machine".
   */
  role: Role;
  sandbox: Sandbox | null;
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
  rev: number;
  desired: DesiredItem[];
  drift: BoxDrift;
  envSecretKeys: string[];
  vaultSecretKeys: string[];
  stale: Tab[];
  applying: boolean;
  busy: string | null;
  onApply: () => void;
  onReconcile: () => void;
  onOpenTab: () => void;
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
}

export function Machine(props: MachineProps) {
  const { drift, desired, sandbox, stale } = props;
  const isOwner = props.role === "owner";
  const pending = drift.statuses.filter((s) => s.state !== "applied");
  const session = desired.filter((i) => i.tier === "session");

  return (
    <div className="panel machine">
      <header className="panel-head">
        <div>
          <h2>The machine</h2>
          <p className="dim">
            {sandbox ? (
              <>
                <code>{sandbox.id}</code> · {sandbox.status}
                {sandbox.mode ? ` · ${sandbox.mode}` : ""}
                {sandbox.provider ? ` · ${sandbox.provider}` : ""}
              </>
            ) : (
              "no machine yet"
            )}
          </p>
        </div>
        {isOwner && needsApply(drift) && drift.known && (
          <button className="primary" onClick={props.onApply} disabled={props.applying || !!props.busy}>
            {props.applying ? "applying…" : `Apply ${pending.length} to the box`}
          </button>
        )}
      </header>

      {props.busy && !props.applying && <p className="note">{props.busy} is mid-turn — an apply has to wait for the box.</p>}

      {/* ── tier: box ─────────────────────────────────────────────────── */}
      <section>
        <SectionHead
          title="On the box"
          when="applied by a turn on this machine"
          note="The environment builds the disk, so changing it here does nothing to the machine you are running until it is applied."
        />

        {!drift.known && isOwner && (
          <p className="note warn">
            The box has not reported what is on it — there is no readable receipt at <code>~/.paddock/applied.json</code>.
            <button className="ghost" onClick={props.onReconcile} disabled={props.applying || !!props.busy}>
              Ask the box what it has
            </button>
          </p>
        )}

        <Rows statuses={drift.statuses} known={drift.known} />

        {drift.extra.length > 0 && (
          <p className="fine">
            Also on the box, no longer declared: {drift.extra.join(", ")}. Nothing removes them.
          </p>
        )}

        {isOwner && (
          <>
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
          </>
        )}
      </section>

      {/* ── tier: session ─────────────────────────────────────────────── */}
      <section>
        <SectionHead
          title="Next tab"
          when="injected when a session starts"
          note="Fountain writes these into the machine as a tab opens. Tabs already running kept what they started with."
        />

        {isOwner && stale.length > 0 && (
          <p className="note warn">
            {stale.length === 1 ? `${stale[0]!.title} started` : `${stale.map((t) => t.title).join(", ")} started`} before the
            current settings (revision {props.rev}).
            <button className="ghost" onClick={props.onOpenTab}>
              Open a fresh tab
            </button>
          </p>
        )}

        {session.length === 0 ? (
          <p className="fine">Nothing yet — no skills, MCP servers or secrets.</p>
        ) : (
          <ul className="rows">
            {session.map((item) => (
              <li key={item.id} className="row">
                <span className="state next" title="Active in tabs opened from now on">
                  next tab
                </span>
                <span className="row-label">{item.label}</span>
                <span className="dim">{item.detail}</span>
              </li>
            ))}
          </ul>
        )}

        {isOwner && (
          <>
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
          </>
        )}
      </section>

      {/* ── tier: machine ─────────────────────────────────────────────── */}
      <section>
        <SectionHead title="New machine" when="only by replacing this one" note="The runtime is baked into the disk when the box is built." />
        <ul className="rows">
          <li className="row">
            <span className="state locked">baked in</span>
            <span className="row-label">{props.agent.runtime}</span>
          </li>
        </ul>
        {isOwner && (
          <Replace
            onRebuild={props.onRebuild}
            onReset={props.onReset}
            onRemove={props.onRemove}
            computerName={props.computerName}
            busy={!!props.busy}
          />
        )}
      </section>
    </div>
  );
}

function SectionHead({ title, when, note }: { title: string; when: string; note: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="section-head">
        <h3>
          {title} <span className="dim">— {when}</span>
        </h3>
        <InfoButton open={open} about={title} onToggle={() => setOpen(!open)} />
      </div>
      {open && <p className="fine info-note">{note}</p>}
    </>
  );
}

/**
 * The (i). It is a toggle rather than a tooltip because the thing it opens is
 * a sentence or three that somebody may want to read twice, and a hover
 * bubble is not readable on a touchscreen or by a keyboard at all.
 */
function InfoButton({ open, about, onToggle }: { open: boolean; about: string; onToggle: () => void }) {
  return (
    <button
      className={`info${open ? " on" : ""}`}
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${open ? "Hide" : "What"} ${about.toLowerCase()} means`}
      title={open ? "hide" : `about ${about.toLowerCase()}`}
    >
      i
    </button>
  );
}

function Rows({ statuses, known }: { statuses: ItemStatus[]; known: boolean }) {
  if (statuses.length === 0) return <p className="fine">Nothing declared — this is a bare machine.</p>;
  return (
    <ul className="rows">
      {statuses.map((s) => (
        <li key={s.item.id} className="row">
          <span className={`state ${known ? s.state : "unknown"}`}>{known ? s.state : "unknown"}</span>
          <span className="row-label">{s.item.label}</span>
          <span className="dim">{s.item.detail}</span>
          {s.why && <span className="why">{s.why}</span>}
        </li>
      ))}
    </ul>
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
  onSave: MachineProps["onSaveEnvironment"];
  onAddSecret: MachineProps["onAddSecret"];
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
  onSave: MachineProps["onSaveEnvironment"];
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

function SetupScript({ environment, onSave }: { environment: Environment; onSave: MachineProps["onSaveEnvironment"] }) {
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
  onAdd: MachineProps["onAddSecret"];
  onRemove: MachineProps["onRemoveSecret"];
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
  onSave: MachineProps["onSaveAgent"];
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
 * Skills: the skills.sh index, then the two shapes by hand.
 *
 * This editor used to append a bare string, which Fountain refuses outright —
 * `skills` is an array of objects and always has been. See `lib/skills.ts` for
 * the shapes and for why the bug survived as long as it did.
 *
 * The index is skills.sh and the panel says so, because the MCP section two
 * blocks up looks similar and is not the same kind of list: those entries are
 * dated claims Fountain checked, and these are whatever the ecosystem uploaded.
 * A github skill is `npx skills add owner/repo` run on the machine, from a
 * repository nobody here vouches for, and the person clicking `+` is the only
 * one in a position to judge that.
 */
function Skills({ agent, onSave }: { agent: Agent; onSave: MachineProps["onSaveAgent"] }) {
  const entries = readSkills(agent.skills);
  const [error, setError] = useState<string | null>(null);

  function save(next: SkillEntry[]) {
    setError(null);
    return onSave({ skills: next });
  }

  const have = new Set(entries.map(skillKey));

  async function add(entry: SkillEntry) {
    if (have.has(skillKey(entry))) return;
    await save([...entries, entry]);
  }

  return (
    <Editor
      title="Skills"
      info={
        <>
          Search is skills.sh, not Fountain — Fountain curates no list of skills, so nothing here is verified by anyone, and
          adding one runs its installer on your machine. A repository can hold many skills; naming one installs only that one.
          Without a ref, Fountain resolves the default branch <em>when a tab opens</em>, so two tabs a week apart can get
          different code — pin anything you depend on. <em>Write it here</em> runs no installer: Fountain writes what you type
          to the machine as <code>SKILL.md</code>.
        </>
      }
    >
      <div className="chips">
        {entries.map((entry, i) => (
          <span className="chip" key={`${skillKey(entry)}-${i}`}>
            {skillLabel(entry)}
            <button className="x" onClick={() => void save(entries.filter((_, j) => j !== i))} title="remove">
              ×
            </button>
          </span>
        ))}
        {entries.length === 0 && <span className="fine">none</span>}
      </div>

      <SkillSearch have={have} onAdd={add} />
      <SkillByHand onAdd={add} onError={setError} />

      {error && <p className="fine error">{error}</p>}
    </Editor>
  );
}

/**
 * The index, through paddock's own server.
 *
 * It has to be: skills.sh sends no CORS header, so this browser cannot read it
 * directly. `server/skills.ts` carries the rest of that note.
 *
 * Search being unavailable is a normal state, not an error — the form below
 * still works and somebody who knows the `owner/repo` should not be stopped by
 * a search box.
 */
function SkillSearch({ have, onAdd }: { have: Set<string>; onAdd: (entry: SkillEntry) => Promise<void> }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SkillHit[] | null>(null);
  const [state, setState] = useState<"idle" | "searching" | "unavailable">("idle");

  async function run() {
    const query = q.trim();
    if (query.length < 2) return;
    setState("searching");
    try {
      const res = await paddock.searchSkills(query);
      setHits(res.data);
      setState(res.unavailable ? "unavailable" : "idle");
    } catch {
      setHits([]);
      setState("unavailable");
    }
  }

  return (
    <>
      <div className="editor-row">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search skills.sh — pdf, postgres, code review"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
        />
        <button onClick={() => void run()} disabled={q.trim().length < 2 || state === "searching"}>
          {state === "searching" ? "…" : "search"}
        </button>
      </div>

      {/* skills.sh answers in two to eight seconds when it answers at all, so
          the wait is said out loud rather than left as a spinner somebody
          assumes is broken. `server/skills.ts` has the measurements. */}
      {state === "searching" && <p className="fine">Asking skills.sh — it can take a few seconds.</p>}
      {state === "unavailable" && <p className="fine">skills.sh did not answer. Add an owner/repo below instead.</p>}
      {state === "idle" && hits?.length === 0 && <p className="fine">Nothing found.</p>}

      {hits && hits.length > 0 && (
        <ul className="rows hits">
          {hits.map((hit) => {
            const entry = hitToSkill(hit);
            const already = have.has(skillKey(entry));
            return (
              <li className="row" key={`${hit.source}#${hit.skill}`}>
                <span className="row-label">{hit.label}</span>
                <code className="dim">{hit.source}</code>
                <span className="fine">{installs(hit.installs)}</span>
                <button className="ghost" onClick={() => void onAdd(entry)} disabled={already} title={already ? "already added" : `add ${hit.skill}`}>
                  {already ? "added" : "add"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** Both shapes, typed out. Everything the index can offer, and everything it cannot. */
function SkillByHand({ onAdd, onError }: { onAdd: (entry: SkillEntry) => Promise<void>; onError: (why: string | null) => void }) {
  const [kind, setKind] = useState<"github" | "inline">("github");
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const [pick, setPick] = useState("");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");

  async function submit() {
    onError(null);
    if (kind === "inline") {
      const made = inlineSkill({ name, content });
      if ("error" in made) return onError(made.error);
      await onAdd(made.entry);
      setName("");
      setContent("");
      return;
    }
    // A pasted GitHub URL or an `owner/repo@ref` is obviously the same intent
    // as the two fields, so it is read rather than refused.
    const parsed = parseSource(source);
    const made = githubSkill({ source: parsed.source, ref: ref.trim() || parsed.ref, name: pick });
    if ("error" in made) return onError(made.error);
    await onAdd(made.entry);
    setSource("");
    setRef("");
    setPick("");
  }

  return (
    <>
      <div className="editor-row">
        <select className="narrow" value={kind} onChange={(e) => setKind(e.target.value as "github" | "inline")}>
          <option value="github">from GitHub</option>
          <option value="inline">write it here</option>
        </select>
        {kind === "github" ? (
          <>
            <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="anthropics/skills" spellCheck={false} />
            <input className="narrow" value={pick} onChange={(e) => setPick(e.target.value)} placeholder="skill (optional)" spellCheck={false} />
            <input className="narrow" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="ref (optional)" spellCheck={false} />
          </>
        ) : (
          <input className="narrow" value={name} onChange={(e) => setName(e.target.value)} placeholder="house-style" spellCheck={false} />
        )}
        <button onClick={() => void submit()} disabled={kind === "github" ? !source.trim() : !name.trim() || !content.trim()}>
          add
        </button>
      </div>

      {kind === "inline" && (
        <textarea
          className="script"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={6}
          spellCheck={false}
          placeholder={"---\nname: house-style\ndescription: Our commit and PR conventions.\n---\n\n# House style"}
        />
      )}
    </>
  );
}

/** `190279` → `190k`. A rough sense of scale is the whole value of the number. */
function installs(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M ↓`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k ↓`;
  return `${n} ↓`;
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

function Editor({
  title,
  info,
  right,
  children,
}: {
  title: string;
  /** The explanation, if this editor needs one. Folded behind the (i). */
  info?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="editor">
      <div className="editor-head">
        <h4>{title}</h4>
        {info && <InfoButton open={open} about={title} onToggle={() => setOpen(!open)} />}
        <span className="spacer" />
        {right}
      </div>
      {info && open && <p className="fine info-note">{info}</p>}
      {children}
    </div>
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
