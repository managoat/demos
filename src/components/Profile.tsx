import { useEffect, useMemo, useState } from "react";
import type { FountainClient } from "../api/client";
import { describeError } from "../api/client";
import type { Agent, Environment, Runner, Teammate } from "../api/types";
import { formatUsage } from "../lib/format";
import { brainsFrom, CREDENTIAL_PROVIDERS, keySource, labelFor, personaPrompt, type Brain, type Catalog } from "../lib/brain";
import { Avatar } from "./Avatar";
import { Markdown } from "./Markdown";
import { SkillsTab } from "./SkillsTab";
import { AppsTab } from "./AppsTab";
import { ContactLine } from "./ContactLine";
import type { ContactOffer } from "../lib/contact";

type Tab = "profile" | "skills" | "apps";

/**
 * Customize a teammate (after Grok Bot's bot profile and OpenMausBot's
 * profile + connected-apps panels): who they are — brain, what they do —
 * and what they can do: skills and connected apps, each a tab with a
 * catalog to pick from. Everything is edited here, on the agent behind
 * them (PUT /api/agents/:id); nothing sends you to Fountain. Skills and
 * apps land when the teammate's computer is next set up, so a change to
 * those offers to restart it.
 */
export function Profile({
  client,
  teammate,
  onClose,
  onAgentChanged,
  onRetire,
  onRunners,
  contactOffer = { kind: "absent" },
  onGiveContact,
  onReleaseContact,
  onChangeContactNumber,
  initialTab = "profile",
}: {
  client: FountainClient;
  teammate: Teammate;
  onClose: () => void;
  onAgentChanged?: () => void;
  /** End the current computer so the next message starts a fresh one with the new skills/apps. */
  onRetire?: () => void;
  /** Open the Runners page — how to start `fountain runner` on a machine. */
  onRunners?: () => void;
  /** whether "Give email & phone" is offered here (absent when the feature is off or they have one) */
  contactOffer?: ContactOffer;
  onGiveContact?: () => void;
  onReleaseContact?: () => void;
  onChangeContactNumber?: () => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [creds, setCreds] = useState<Record<string, boolean>>({});
  const [persona, setPersona] = useState<string | null>(null);
  const [saving, setSaving] = useState<"brain" | "persona" | "key" | "computer" | null>(null);
  const [runners, setRunners] = useState<Runner[] | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyMessage, setKeyMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** skills/apps changed since opening: they need a fresh computer */
  const [pending, setPending] = useState(false);
  const conv = teammate.conversation;

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      client.getAgent(teammate.agent_id),
      client.listEnvironments().catch(() => []),
      client.getCatalog().catch(() => null),
      client.inferenceCredentials().catch(() => ({}) as Record<string, boolean>),
    ])
      .then(([a, e, cat, cr]) => {
        if (cancelled) return;
        setAgent(a);
        setEnvs(e);
        setCatalog(cat);
        setCreds(cr);
      })
      .catch((err) => !cancelled && setError(describeError(err)));
    return () => {
      cancelled = true;
    };
  }, [client, teammate.agent_id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const a = agent ?? teammate.agent;
  const brains = useMemo(() => (catalog ? brainsFrom(catalog, creds) : []), [catalog, creds]);
  const brainKnown = brains.some((b) => b.model === a.model);
  // the brain in use needs a provider this account holds no key for: collect it here
  const currentBrain = brains.find((b) => b.model === a.model) ?? null;
  const missingKey = currentBrain && !currentBrain.available ? (CREDENTIAL_PROVIDERS[currentBrain.provider]?.[0] ?? null) : null;

  const saveKey = async () => {
    if (!missingKey || !keyDraft.trim()) return;
    setSaving("key");
    setKeyMessage(null);
    try {
      await client.putInferenceCredential(missingKey, keyDraft.trim());
      setCreds(await client.inferenceCredentials().catch(() => ({ ...creds, [missingKey]: true })));
      setKeyDraft("");
      setKeyMessage({ kind: "ok", text: "Saved and validated." });
    } catch (err) {
      setKeyMessage({ kind: "error", text: describeError(err) });
    } finally {
      setSaving(null);
    }
  };
  const skillCount = a.skills?.length ?? 0;
  const appCount = Object.keys(a.mcp_servers ?? {}).length;

  const changeBrain = async (model: string) => {
    const b: Brain | undefined = brains.find((x) => x.model === model);
    if (!b || !agent) return;
    setSaving("brain");
    try {
      setAgent(await client.updateAgent(agent.id, { model: b.model, runtime: b.runtime }));
      onAgentChanged?.();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(null);
    }
  };

  const savePersona = async () => {
    if (!agent || persona === null) return;
    setSaving("persona");
    try {
      setAgent(await client.updateAgent(agent.id, { description: persona.trim(), system: personaPrompt(teammate.name, persona) }));
      setPersona(null);
      onAgentChanged?.();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(null);
    }
  };

  /** The tabs call this with the agent the server returned after a skills/apps write. */
  const onAgentUpdated = (next: Agent) => {
    setAgent(next);
    setPending(true);
    onAgentChanged?.();
  };

  // ── the computer: Fountain's cloud, or a machine of yours running `fountain runner` ──
  const providers = catalog?.sandbox_providers;
  const runnerOffered = providers?.enabled.includes("runner") ?? false;
  const cloudProviders = (providers?.enabled ?? []).filter((p) => p !== "runner");
  const defaultProvider = providers?.default ?? null;
  const onRunner = a.sandbox_provider === "runner";
  useEffect(() => {
    if (!runnerOffered && !onRunner) return;
    let cancelled = false;
    client
      .listRunners()
      .then((r) => !cancelled && setRunners(r))
      .catch(() => !cancelled && setRunners([]));
    return () => {
      cancelled = true;
    };
  }, [client, runnerOffered, onRunner]);
  const online = (runners ?? []).filter((r) => r.online);

  const changeComputer = async (value: string) => {
    if (!agent) return;
    const provider = value === "" ? null : value;
    if ((agent.sandbox_provider ?? null) === provider) return;
    setSaving("computer");
    try {
      onAgentUpdated(await client.updateAgent(agent.id, { sandbox_provider: provider }));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(null);
    }
  };

  // ── what answers before they run a tool (fountain#939, withdrawn in #996) ──
  //
  // The control that set this is gone. "Ask me first" reaches a human and the
  // answer reaches the agent, which is the half that works — but what an
  // "always" answer then means is decided by the runtime, and measurement on
  // 2026-08-22 found it means three different things and, for one shape of
  // command, nothing at all: claude re-prompts for a byte-identical command
  // forever where it writes outside its cwd (anthropics/claude-code#88919),
  // and codex's "Allow for Session" expires at the end of every turn. Offering
  // a switch whose promise the runtimes do not keep is worse than not offering
  // it, so this waits on fountain#996.
  //
  // Reading it stays. A policy set through the API or `fountain acp` still
  // governs the teammate, and an owner who sees cards they did not ask for
  // deserves to find out why here rather than nowhere. Nothing writes it.
  const permission = a.permission_policy?.default ?? null;

  const envName = (id: string | null) => (id ? (envs.find((e) => e.id === id)?.name ?? id.slice(0, 8)) : null);
  const usedEnv = conv.environment_id ?? a.environment_id;
  const retired = conv.status === "terminated";
  const freshCheap = conv.turn_count === 0;

  return (
    <div className="modal-root">
      <div className="backdrop" onClick={onClose} />
      <div className="modal wide profile" role="dialog" aria-label={`Customize ${teammate.name}`}>
        <header>
          <div className="row">
            <Avatar agent={a} name={teammate.name} client={client} size={40} />
            <div>
              <h2>Customize {teammate.name}</h2>
              <div className="muted small">
                {teammate.name !== a.name && <>agent <b>{a.name}</b> · </>}
                {labelFor(a.model)} · {a.runtime}
              </div>
            </div>
          </div>
          <button type="button" className="icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="tabs" role="tablist" aria-label="Customize">
          <button type="button" role="tab" aria-selected={tab === "profile"} className={tab === "profile" ? "active" : ""} onClick={() => setTab("profile")}>
            Profile
          </button>
          <button type="button" role="tab" aria-selected={tab === "skills"} className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}>
            Skills{skillCount > 0 && <span className="count">{skillCount}</span>}
          </button>
          <button type="button" role="tab" aria-selected={tab === "apps"} className={tab === "apps" ? "active" : ""} onClick={() => setTab("apps")}>
            Apps{appCount > 0 && <span className="count">{appCount}</span>}
          </button>
        </div>

        {error && <div className="error">{error}</div>}

        {pending && !retired && (
          <div className="apply-banner" role="status">
            <div>
              <b>Saved.</b> {teammate.name} picks this up on their next computer
              {freshCheap ? " — nothing has happened on this one yet, so restarting it costs nothing." : " — the one they are on now was set up before the change."}
            </div>
            {onRetire && (
              <button type="button" className="small" onClick={onRetire}>
                {freshCheap ? "Restart their computer" : "Restart their computer…"}
              </button>
            )}
          </div>
        )}
        {pending && retired && (
          <div className="apply-banner" role="status">
            <b>Saved.</b> This thread is retired, so {teammate.name}'s next message already starts on a computer with this.
          </div>
        )}

        {tab === "profile" && (
          <>
            <label className="profile-field">
              Brain
              <select value={brainKnown ? a.model : "__current"} disabled={!agent || !brains.length || saving === "brain"} onChange={(e) => void changeBrain(e.target.value)}>
                {!brainKnown && <option value="__current">{labelFor(a.model)} (current)</option>}
                {brains.map((b) => (
                  <option key={b.model} value={b.model}>
                    {b.label}
                    {b.available ? "" : " — no key on the account"}
                  </option>
                ))}
              </select>
              <span className="hint">The runtime follows the brain. A change applies from their next turn; the conversation continues.</span>
            </label>
            {missingKey && (
              <div className="key-card">
                <div className="small">
                  <b>No {providerName(currentBrain!.provider)} key on the account yet</b> — {teammate.name} can't answer on this brain until there is one. Paste it here (from{" "}
                  {keySource(missingKey)}); it's validated and saved to your Fountain account.
                </div>
                <form
                  className="row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveKey();
                  }}
                >
                  <input type="password" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} placeholder={missingKey} autoComplete="off" spellCheck={false} />
                  <button type="submit" className="small" disabled={saving === "key" || !keyDraft.trim()}>
                    {saving === "key" ? "Checking…" : "Save key"}
                  </button>
                </form>
                {keyMessage && <div className={`small ${keyMessage.kind === "ok" ? "ok-text" : "error-inline"}`}>{keyMessage.text}</div>}
              </div>
            )}

            <label className="profile-field">
              What they do
              <textarea
                rows={2}
                value={persona ?? a.description ?? ""}
                placeholder="e.g. reviews pull requests on the api repo and keeps the changelog honest"
                onChange={(e) => setPersona(e.target.value)}
                disabled={!agent || saving === "persona"}
                maxLength={600}
              />
              {persona !== null && persona !== (a.description ?? "") && (
                <div className="row end">
                  <button type="button" className="secondary small" onClick={() => setPersona(null)} disabled={saving === "persona"}>
                    Cancel
                  </button>
                  <button type="button" className="small" onClick={() => void savePersona()} disabled={saving === "persona"}>
                    {saving === "persona" ? "Saving…" : "Save"}
                  </button>
                </div>
              )}
              <span className="hint">One line is plenty — it becomes their description and the start of their instructions.</span>
            </label>

            {permission && permission !== "auto_allow" && (
              <label className="profile-field">
                Before they run a tool
                <div className="readonly-value">{permission === "ask" ? "Ask me first" : "Refuse it"}</div>
                <span className="hint">
                  Set outside this app, and only changeable there — <code>PATCH /api/agents</code> or{" "}
                  <code>fountain acp --permission</code>. It is why this teammate stops for a card.
                </span>
              </label>
            )}

            <label className="profile-field">
              Computer
              {(runnerOffered || onRunner) && (
                <select value={a.sandbox_provider ?? ""} disabled={!agent || saving === "computer"} onChange={(e) => void changeComputer(e.target.value)}>
                  <option value="">Fountain's cloud{defaultProvider && defaultProvider !== "runner" ? ` (${defaultProvider})` : ""}</option>
                  {cloudProviders
                    .filter((p) => p !== defaultProvider)
                    .map((p) => (
                      <option key={p} value={p}>
                        Cloud · {p}
                      </option>
                    ))}
                  <option value="runner">Your own machine (fountain runner)</option>
                </select>
              )}
              <span className="computer-status">
                <span className={`presence inline ${teammate.presence.state}`} />
                {teammate.presence.label}
                {conv.sandbox?.runner ? (
                  <span className="muted">
                    {" "}
                    · on <b>{conv.sandbox.runner.name}</b>
                    {conv.sandbox.runner.path ? <span className="mono"> {conv.sandbox.runner.path}</span> : ""}
                  </span>
                ) : conv.sandbox?.provider && conv.sandbox.provider !== "runner" ? (
                  <span className="muted"> · {conv.sandbox.provider}</span>
                ) : null}
              </span>
              {onRunner && (
                <span className="hint">
                  {runners === null ? (
                    "Checking your machines…"
                  ) : online.length > 0 ? (
                    <>
                      New computers land on your most recently connected machine — online now: <b>{online.map((r) => r.name).join(", ")}</b>.
                    </>
                  ) : (
                    <>
                      <b>No machine of yours is online</b> — a new computer for {teammate.name} cannot start until one is. On the machine: <code>fountain auth login</code>, then <code>fountain runner</code>.
                    </>
                  )}{" "}
                  {onRunners && (
                    <button type="button" className="linkish" onClick={onRunners}>
                      {online.length > 0 ? "Your machines." : "How to set one up."}
                    </button>
                  )}{" "}
                  The agent runs there as you, with your files and network — trusted mode.
                </span>
              )}
              {!onRunner && runnerOffered && (
                <span className="hint">
                  Pick your own machine to run {teammate.name} on a Mac, a GPU box or a home server — anything with <code>fountain runner</code> on it.
                  {online.length > 0 ? ` Online now: ${online.map((r) => r.name).join(", ")}.` : ""}
                </span>
              )}
            </label>

            {(teammate.contact || contactOffer.kind !== "absent") && (
              <div className="profile-field profile-contact">
                Email &amp; phone
                {teammate.contact ? (
                  <>
                    <ContactLine contact={teammate.contact} onChangeNumber={onChangeContactNumber} />
                    <span className="hint">
                      Their own AgentMail inbox and AgentPhone number: from their next turn they can send, reply to and read email and send texts (
                      <code>email_send</code>, <code>sms_send</code>, …). A text from the number above reaches them as a prompt in this thread; they
                      answer by text with <code>sms_send</code>, not in the chat.{" "}
                      {onReleaseContact && (
                        <button type="button" className="linkish" onClick={onReleaseContact}>
                          Release email &amp; phone…
                        </button>
                      )}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="muted small">None yet.</span>
                    <div className="row">
                      <button
                        type="button"
                        className="secondary small"
                        onClick={onGiveContact}
                        disabled={contactOffer.kind === "disabled" || !onGiveContact}
                        title={contactOffer.kind === "disabled" ? contactOffer.reason : "Buy this teammate an AgentMail inbox and an AgentPhone number (billed)"}
                      >
                        Give email &amp; phone…
                      </button>
                      {contactOffer.kind === "disabled" && <span className="muted small">{contactOffer.reason}</span>}
                    </div>
                    <span className="hint">
                      An inbox and a number of their own — billed — with tools to use them; texts from your number become prompts in this thread.
                    </span>
                  </>
                )}
              </div>
            )}

            <dl className="profile-grid">
              <dt>Can do</dt>
              <dd>
                {skillCount === 0 && appCount === 0 ? (
                  <span className="muted">
                    No skills or apps yet —{" "}
                    <button type="button" className="linkish" onClick={() => setTab("skills")}>
                      add a skill
                    </button>{" "}
                    or{" "}
                    <button type="button" className="linkish" onClick={() => setTab("apps")}>
                      connect an app
                    </button>
                    .
                  </span>
                ) : (
                  <>
                    <button type="button" className="linkish" onClick={() => setTab("skills")}>
                      {skillCount} skill{skillCount === 1 ? "" : "s"}
                    </button>
                    {" · "}
                    <button type="button" className="linkish" onClick={() => setTab("apps")}>
                      {appCount} app{appCount === 1 ? "" : "s"}
                    </button>
                  </>
                )}
              </dd>
            </dl>

            <details className="profile-system">
              <summary>Details</summary>
              <dl className="profile-grid profile-details">
                <dt>Environment</dt>
                <dd>
                  {envName(usedEnv) ?? <span className="muted">none</span>}
                  {conv.environment_id && conv.environment_id !== a.environment_id && <span className="muted"> (this conversation; the agent's default is {envName(a.environment_id) ?? "none"})</span>}
                </dd>
                <dt>Conversation</dt>
                <dd>
                  <span className="mono small">{conv.id}</span>
                  <span className="muted">
                    {" "}
                    · {conv.turn_count} turn{conv.turn_count === 1 ? "" : "s"}
                    {formatUsage(teammate.usage_total) ? ` · ${formatUsage(teammate.usage_total)}` : ""}
                  </span>
                </dd>
                {conv.sandbox && (
                  <>
                    <dt>Sandbox</dt>
                    <dd className="mono small">{conv.sandbox.sprite_name}</dd>
                  </>
                )}
              </dl>
              {a.system && (
                <>
                  <div className="muted small" style={{ marginTop: 8 }}>
                    System prompt
                  </div>
                  <div className="profile-system-body">
                    <Markdown text={a.system} />
                  </div>
                </>
              )}
            </details>
          </>
        )}

        {tab === "skills" && <SkillsTab client={client} agent={agent} name={teammate.name} onAgent={onAgentUpdated} />}
        {tab === "apps" && <AppsTab client={client} agent={agent} teammate={teammate} envs={envs} onEnvs={setEnvs} onAgent={onAgentUpdated} />}
      </div>
    </div>
  );
}

function providerName(p: string): string {
  return p === "anthropic" ? "Anthropic" : p === "openai" ? "OpenAI" : p === "google" ? "Google" : p;
}

