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
 * The panel never says "applied" on trust. Tier-`box` rows are `applied` only
 * because the machine itself wrote the id into its receipt, read back over the
 * read-only sandbox routes; when the receipt cannot be read the panel says the
 * box has not reported rather than guessing.
 */
import { useState } from "react";
import type { Agent, Environment, Repository, Sandbox, Vault } from "../api/types";
import type { Role } from "../api/paddock";
import type { BoxDrift, DesiredItem, ItemStatus } from "../lib/machine";
import { needsApply } from "../lib/machine";
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
  onSaveEnvironment: (patch: { repositories?: Repository[]; packages?: string[]; setup_script?: string }) => Promise<void>;
  onAddSecret: (where: "env" | "vault", key: string, value: string) => Promise<void>;
  onRemoveSecret: (where: "env" | "vault", key: string) => Promise<void>;
  onSaveAgent: (patch: Partial<Agent>) => Promise<void>;
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
            Also on the box, no longer declared: {drift.extra.join(", ")}. Harmless — nothing removes them.
          </p>
        )}

        {isOwner && (
          <>
            <Repositories environment={props.environment} onSave={props.onSaveEnvironment} />
            <Packages environment={props.environment} onSave={props.onSaveEnvironment} />
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
            <McpServers agent={props.agent} onSave={props.onSaveAgent} />
            <Skills agent={props.agent} onSave={props.onSaveAgent} />
          </>
        )}
      </section>

      {/* ── tier: machine ─────────────────────────────────────────────── */}
      <section>
        <SectionHead title="New machine" when="cannot be changed here" note="The runtime is baked into the disk when the box is built." />
        <ul className="rows">
          <li className="row">
            <span className="state locked">baked in</span>
            <span className="row-label">{props.agent.runtime}</span>
            <span className="dim">changing this means starting a new box, and losing what is on this one</span>
          </li>
        </ul>
      </section>
    </div>
  );
}

function SectionHead({ title, when, note }: { title: string; when: string; note: string }) {
  return (
    <div className="section-head">
      <h3>
        {title} <span className="dim">— {when}</span>
      </h3>
      <p className="fine">{note}</p>
    </div>
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

function Repositories({ environment, onSave }: { environment: Environment; onSave: MachineProps["onSaveEnvironment"] }) {
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const repos = environment.repositories ?? [];

  async function add() {
    const trimmed = url.trim();
    if (!trimmed) return;
    const name = trimmed.replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? "repo";
    await onSave({
      repositories: [...repos, { url: trimmed, mount_path: `/home/sprite/${name}`, ref: ref.trim() || null }],
    });
    setUrl("");
    setRef("");
  }

  return (
    <Editor title="Repositories">
      {repos.map((r, i) => (
        <div className="editor-row" key={`${r.url}-${i}`}>
          <code>{r.url}</code>
          <span className="dim">{r.mount_path}</span>
          <button className="ghost" onClick={() => onSave({ repositories: repos.filter((_, j) => j !== i) })}>
            remove
          </button>
        </div>
      ))}
      <div className="editor-row">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/you/thing" spellCheck={false} />
        <input className="narrow" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="ref (optional)" spellCheck={false} />
        <button onClick={add} disabled={!url.trim()}>
          add
        </button>
      </div>
      <p className="fine">A private repository clones with an environment secret named in its entry — add the secret below first.</p>
    </Editor>
  );
}

function Packages({ environment, onSave }: { environment: Environment; onSave: MachineProps["onSaveEnvironment"] }) {
  const [name, setName] = useState("");
  const packages = environment.packages ?? [];

  return (
    <Editor title="Packages">
      <div className="chips">
        {packages.map((p) => (
          <span className="chip" key={p}>
            {p}
            <button className="x" onClick={() => onSave({ packages: packages.filter((q) => q !== p) })} title={`remove ${p}`}>
              ×
            </button>
          </span>
        ))}
        {packages.length === 0 && <span className="fine">none</span>}
      </div>
      <div className="editor-row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="ripgrep"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !name.trim() || packages.includes(name.trim())) return;
            void onSave({ packages: [...packages, name.trim()] }).then(() => setName(""));
          }}
        />
        <button
          onClick={() => void onSave({ packages: [...packages, name.trim()] }).then(() => setName(""))}
          disabled={!name.trim() || packages.includes(name.trim())}
        >
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
    <Editor title="Setup script" right={<button className="ghost" onClick={() => setOpen(!open)}>{open ? "hide" : "edit"}</button>}>
      {!open ? (
        <p className="fine">{saved.trim() ? `${saved.trim().split("\n").length} lines` : "none"}</p>
      ) : (
        <>
          <textarea className="script" value={text} onChange={(e) => setText(e.target.value)} rows={8} spellCheck={false} />
          <div className="editor-row">
            <button onClick={() => void onSave({ setup_script: text })} disabled={!dirty}>
              Save
            </button>
            {dirty && <span className="fine">Saving changes what a new box is built from; applying runs it on this one.</span>}
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
    <Editor title="Secrets">
      <p className="fine">
        Two different things. An <strong>environment</strong> secret is put into the machine as an environment variable — the
        agent can read it. A <strong>vault</strong> secret never touches the machine: the egress broker substitutes it into
        outbound requests, so the agent uses it without ever holding it.
      </p>

      <KeyList label="environment · in the box" keys={envKeys} onRemove={(k) => onRemove("env", k)} />
      {hasVault ? (
        <KeyList label="vault · never on the box" keys={vaultKeys} onRemove={(k) => onRemove("vault", k)} />
      ) : (
        <p className="fine">This Fountain has no vault for you, so broker-held secrets are not available.</p>
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
      <p className="fine">The value goes straight to Fountain. Paddock does not keep it, and cannot read it back.</p>
    </Editor>
  );
}

function KeyList({ label, keys, onRemove }: { label: string; keys: string[]; onRemove: (k: string) => void }) {
  return (
    <div className="editor-row">
      <span className="dim narrow">{label}</span>
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

function McpServers({ agent, onSave }: { agent: Agent; onSave: MachineProps["onSaveAgent"] }) {
  const servers = agent.mcp_servers ?? {};
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");

  async function add() {
    if (!name.trim() || !url.trim()) return;
    await onSave({ mcp_servers: { ...servers, [name.trim()]: { url: url.trim() } } });
    setName("");
    setUrl("");
  }

  function remove(key: string) {
    const next = { ...servers };
    delete next[key];
    void onSave({ mcp_servers: next });
  }

  return (
    <Editor title="MCP servers">
      {Object.keys(servers).length === 0 && <p className="fine">none</p>}
      {Object.entries(servers).map(([key, cfg]) => (
        <div className="editor-row" key={key}>
          <span className="row-label">{key}</span>
          <code className="dim">{urlOf(cfg)}</code>
          <button className="ghost" onClick={() => remove(key)}>
            remove
          </button>
        </div>
      ))}
      <div className="editor-row">
        <input className="narrow" value={name} onChange={(e) => setName(e.target.value)} placeholder="linear" spellCheck={false} />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/sse" spellCheck={false} />
        <button onClick={add} disabled={!name.trim() || !url.trim()}>
          add
        </button>
      </div>
    </Editor>
  );
}

function Skills({ agent, onSave }: { agent: Agent; onSave: MachineProps["onSaveAgent"] }) {
  const skills = Array.isArray(agent.skills) ? agent.skills : [];
  const [name, setName] = useState("");

  return (
    <Editor title="Skills">
      <div className="chips">
        {skills.map((s, i) => (
          <span className="chip" key={`${label(s)}-${i}`}>
            {label(s)}
            <button className="x" onClick={() => void onSave({ skills: skills.filter((_, j) => j !== i) })} title="remove">
              ×
            </button>
          </span>
        ))}
        {skills.length === 0 && <span className="fine">none</span>}
      </div>
      <div className="editor-row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="pdf" spellCheck={false} />
        <button onClick={() => void onSave({ skills: [...skills, name.trim()] }).then(() => setName(""))} disabled={!name.trim()}>
          add
        </button>
      </div>
    </Editor>
  );
}

function Editor({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="editor">
      <div className="editor-head">
        <h4>{title}</h4>
        {right}
      </div>
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

function label(skill: unknown): string {
  if (typeof skill === "string") return skill;
  if (skill && typeof skill === "object") {
    const name = (skill as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "skill";
}
