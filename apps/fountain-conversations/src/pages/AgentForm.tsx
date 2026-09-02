import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useStore } from "../store";
import { navigate, paths } from "../router";
import { describeError } from "../api/client";
import type { Agent, AgentInput, Catalog, Environment, ImageInput, McpServer, Skill, Vault } from "../api/types";
import { Allowlist, Field, KeyValueRows } from "../components/forms";
import { AgentAvatar } from "../components/AgentAvatar";

type SkillRow = { type: "github" | "inline"; source: string; ref: string; name: string; content: string };
type McpRow = { name: string; command: string; args: string; env: Array<{ key: string; value: string }> };

export function AgentFormPage({ id }: { id: string | "new" }) {
  const { client, toast, refresh } = useStore();
  const isNew = id === "new";
  const [agent, setAgent] = useState<Agent | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [runtime, setRuntime] = useState("claude");
  const [model, setModel] = useState("");
  const [system, setSystem] = useState("");
  const [envId, setEnvId] = useState("");
  const [provider, setProvider] = useState("");
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [mcp, setMcp] = useState<McpRow[]>([]);
  const [allowedEnvs, setAllowedEnvs] = useState<string[] | null>(null);
  const [allowedVaults, setAllowedVaults] = useState<string[] | null>(null);
  const [pendingAvatar, setPendingAvatar] = useState<ImageInput | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [avatarBase, setAvatarBase] = useState("robot");
  const [avatarMood, setAvatarMood] = useState("serious");
  const [generating, setGenerating] = useState(false);
  const [avatarKey, setAvatarKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([client.catalog(), client.listEnvironments(), client.listVaults(), isNew ? Promise.resolve(null) : client.getAgent(id)])
      .then(([c, e, v, a]) => {
        if (cancelled) return;
        setCatalog(c);
        setEnvs(e);
        setVaults(v);
        if (a) {
          setAgent(a);
          setName(a.name);
          setDescription(a.description ?? "");
          setRuntime(a.runtime);
          setModel(a.model);
          setSystem(a.system ?? "");
          setEnvId(a.environment_id ?? "");
          setProvider(a.sandbox_provider ?? "");
          setSkills((a.skills ?? []).map(skillToRow));
          setMcp(Object.entries(a.mcp_servers ?? {}).map(([n, s]) => mcpToRow(n, s)));
          setAllowedEnvs(a.allowed_environment_ids);
          setAllowedVaults(a.allowed_vault_ids);
        } else {
          setModel(c.models["claude"]?.[0] ?? "");
        }
      })
      .catch((err) => !cancelled && setError(describeError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [client, id, isNew]);

  const suggestions = useMemo(() => catalog?.models[runtime] ?? [], [catalog, runtime]);
  const unknownModel = model.includes("/") && suggestions.length > 0 && !suggestions.includes(model);

  function onRuntimeChange(r: string) {
    setRuntime(r);
    const list = catalog?.models[r] ?? [];
    if (!list.includes(model)) setModel(list[0] ?? "");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const input: AgentInput = {
      name: name.trim(),
      description,
      system,
      model: model.trim(),
      runtime,
      environment_id: envId || null,
      sandbox_provider: provider || null,
      skills: skills.map(rowToSkill).filter((s): s is Skill => s !== null),
      mcp_servers: Object.fromEntries(mcp.filter((m) => m.name.trim()).map((m) => [m.name.trim(), rowToMcp(m)])),
      allowed_environment_ids: allowedEnvs,
      allowed_vault_ids: allowedVaults,
    };
    try {
      const saved = isNew ? await client.createAgent(input) : await client.updateAgent(id, input);
      if (pendingAvatar) await client.putAvatar(saved.id, pendingAvatar);
      else if (removeAvatar && agent?.avatar_media_type) await client.deleteAvatar(saved.id);
      toast(isNew ? "Agent created" : "Agent saved");
      void refresh();
      navigate(paths.agents);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    setGenerating(true);
    try {
      const img = await client.generateAvatar(avatarBase, avatarMood);
      setPendingAvatar(img);
      setRemoveAvatar(false);
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setGenerating(false);
    }
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast("Avatars are capped at 5 MB.", "error");
    const data = await new Promise<string>((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
      r.readAsDataURL(file);
    });
    setPendingAvatar({ data, media_type: file.type || "image/png" });
    setRemoveAvatar(false);
    setAvatarKey((k) => k + 1);
  }

  if (loading) return <div className="page muted">Loading…</div>;

  return (
    <div className="page narrow">
      <header className="page-header">
        <h1>{isNew ? "New agent" : `Edit ${agent?.name ?? "agent"}`}</h1>
        <a href={paths.agents} className="button secondary small">
          Cancel
        </a>
      </header>
      <form className="card stack" onSubmit={submit}>
        <div className="row top">
          <div className="avatar-editor">
            {pendingAvatar ? (
              <div className="avatar" style={{ width: 72, height: 72 }}>
                <img src={`data:${pendingAvatar.media_type};base64,${pendingAvatar.data}`} alt="" />
              </div>
            ) : agent && !removeAvatar ? (
              <AgentAvatar agent={agent} size={72} refreshKey={avatarKey} />
            ) : (
              <div className="avatar" style={{ width: 72, height: 72, fontSize: 24 }}>
                <span>{name.trim() ? name.trim().slice(0, 2).toUpperCase() : "?"}</span>
              </div>
            )}
            <div className="stack tight">
              <label className="button secondary small file-btn">
                Upload
                <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => void pickFile(e.target.files?.[0])} />
              </label>
              <div className="row">
                <select className="compact" value={avatarBase} onChange={(e) => setAvatarBase(e.target.value)}>
                  {catalog?.avatar.bases.map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </select>
                <select className="compact" value={avatarMood} onChange={(e) => setAvatarMood(e.target.value)}>
                  {catalog?.avatar.moods.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
                <button type="button" className="secondary small" disabled={generating} onClick={() => void generate()}>
                  {generating ? "Generating…" : "Generate"}
                </button>
              </div>
              {(pendingAvatar || (agent?.avatar_media_type && !removeAvatar)) && (
                <button
                  type="button"
                  className="danger small"
                  onClick={() => {
                    setPendingAvatar(null);
                    setRemoveAvatar(true);
                  }}
                >
                  Remove avatar
                </button>
              )}
            </div>
          </div>
          <div className="stack grow">
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} autoFocus={isNew} />
            </Field>
            <Field label="Description" optional>
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>
        </div>

        <div className="grid2">
          <Field label="Runtime">
            <select value={runtime} onChange={(e) => onRuntimeChange(e.target.value)}>
              {catalog?.runtimes.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
          <Field
            label="Model"
            hint={unknownModel ? "Not one of the models Fountain lists — it will be passed to the runtime as-is." : "provider/model, e.g. anthropic/claude-sonnet-4-6"}
          >
            <input list="model-suggestions" value={model} onChange={(e) => setModel(e.target.value)} required pattern="^[a-z0-9_-]+/[a-z0-9._-]+$" className="mono" />
            <datalist id="model-suggestions">
              {suggestions.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
        </div>

        <Field label="System prompt" optional>
          <textarea rows={6} value={system} onChange={(e) => setSystem(e.target.value)} className="mono" />
        </Field>

        <div className="grid2">
          <Field label="Environment" optional hint="Baseline env vars and runtime config the sandbox is provisioned from.">
            <select value={envId} onChange={(e) => setEnvId(e.target.value)}>
              <option value="">— none —</option>
              {envs.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </Field>
          {catalog && catalog.sandbox_providers.enabled.length > 1 && (
            <Field label="Sandbox provider">
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="">Instance default ({catalog.sandbox_providers.default})</option>
                {catalog.sandbox_providers.enabled.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>

        <fieldset className="fs">
          <legend>Skills</legend>
          {skills.map((s, i) => (
            <div key={i} className="subcard">
              <div className="row">
                <select
                  className="compact"
                  value={s.type}
                  onChange={(e) => setSkills(skills.map((x, j) => (j === i ? { ...x, type: e.target.value as SkillRow["type"] } : x)))}
                >
                  <option value="github">GitHub (skills.sh)</option>
                  <option value="inline">Inline SKILL.md</option>
                </select>
                <span className="spacer" />
                <button type="button" className="icon" aria-label="Remove skill" onClick={() => setSkills(skills.filter((_, j) => j !== i))}>
                  ×
                </button>
              </div>
              {s.type === "github" ? (
                <div className="grid2">
                  <Field label="Source" hint="owner/repo">
                    <input value={s.source} className="mono" placeholder="owner/repo" onChange={(e) => setSkills(skills.map((x, j) => (j === i ? { ...x, source: e.target.value } : x)))} />
                  </Field>
                  <Field label="Ref" optional hint="tag, branch or sha">
                    <input value={s.ref} className="mono" onChange={(e) => setSkills(skills.map((x, j) => (j === i ? { ...x, ref: e.target.value } : x)))} />
                  </Field>
                </div>
              ) : (
                <>
                  <Field label="Name">
                    <input value={s.name} onChange={(e) => setSkills(skills.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  </Field>
                  <Field label="SKILL.md">
                    <textarea rows={6} className="mono" value={s.content} onChange={(e) => setSkills(skills.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))} />
                  </Field>
                </>
              )}
            </div>
          ))}
          <button type="button" className="secondary small" onClick={() => setSkills([...skills, { type: "github", source: "", ref: "", name: "", content: "" }])}>
            + Add skill
          </button>
        </fieldset>

        <fieldset className="fs">
          <legend>MCP servers</legend>
          {mcp.map((m, i) => (
            <div key={i} className="subcard">
              <div className="grid2">
                <Field label="Name">
                  <input value={m.name} className="mono" onChange={(e) => setMcp(mcp.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                </Field>
                <Field label="Command">
                  <input value={m.command} className="mono" placeholder="npx" onChange={(e) => setMcp(mcp.map((x, j) => (j === i ? { ...x, command: e.target.value } : x)))} />
                </Field>
              </div>
              <Field label="Args" optional hint="one per line">
                <textarea rows={2} className="mono" value={m.args} onChange={(e) => setMcp(mcp.map((x, j) => (j === i ? { ...x, args: e.target.value } : x)))} />
              </Field>
              <Field label="Env" optional hint="Use ${VAR} to reference environment/vault secrets.">
                <KeyValueRows rows={m.env} onChange={(rows) => setMcp(mcp.map((x, j) => (j === i ? { ...x, env: rows } : x)))} />
              </Field>
              <button type="button" className="danger small" onClick={() => setMcp(mcp.filter((_, j) => j !== i))}>
                Remove server
              </button>
            </div>
          ))}
          <button type="button" className="secondary small" onClick={() => setMcp([...mcp, { name: "", command: "", args: "", env: [] }])}>
            + Add MCP server
          </button>
        </fieldset>

        <fieldset className="fs">
          <legend>Launch-time overrides</legend>
          <Allowlist
            label="Environments a conversation may launch with instead of the agent's own"
            value={allowedEnvs}
            options={envs.filter((e) => e.id !== envId)}
            onChange={setAllowedEnvs}
            hint="The agent's own environment is always allowed."
          />
          <Allowlist label="Vaults a conversation may attach" value={allowedVaults} options={vaults} onChange={setAllowedVaults} hint="Vault values win on key collision with the environment." />
        </fieldset>

        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button type="submit" disabled={busy || !name.trim() || !model.trim()}>
            {busy ? "Saving…" : isNew ? "Create agent" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

function skillToRow(s: Skill): SkillRow {
  return s.source
    ? { type: "github", source: s.source, ref: s.ref ?? "", name: s.name ?? "", content: "" }
    : { type: "inline", source: "", ref: "", name: s.name ?? "", content: s.content ?? "" };
}

function rowToSkill(r: SkillRow): Skill | null {
  if (r.type === "github") {
    if (!r.source.trim()) return null;
    return { source: r.source.trim(), ...(r.ref.trim() ? { ref: r.ref.trim() } : {}), ...(r.name.trim() ? { name: r.name.trim() } : {}) };
  }
  if (!r.name.trim() || !r.content.trim()) return null;
  return { name: r.name.trim(), content: r.content };
}

function mcpToRow(name: string, s: McpServer): McpRow {
  return { name, command: s.command ?? "", args: (s.args ?? []).join("\n"), env: Object.entries(s.env ?? {}).map(([key, value]) => ({ key, value })) };
}

function rowToMcp(r: McpRow): McpServer {
  const args = r.args.split("\n").map((a) => a.trim()).filter(Boolean);
  const env = Object.fromEntries(r.env.filter((e) => e.key.trim()).map((e) => [e.key.trim(), e.value]));
  return { command: r.command.trim(), ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) };
}
