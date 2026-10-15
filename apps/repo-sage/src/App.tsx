/**
 * Repo Sage: a rail of repositories, each with one sage (a Fountain agent
 * named `Sage: owner/name` that cloned the repo on its own computer) and one
 * conversation, the agent's live one on the `repo-sage` channel. The dossier
 * and every answer are derived from turns + blocks; localStorage holds only
 * settings and choices. Streaming/reconnect follows jhgaylor/dns-desk.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ApiError, describeError, FountainClient } from "./api/client";
import type { Agent, Catalog, Conversation, LogEvent, StreamEvent, Turn } from "./api/types";
import { blocksForTurn } from "./lib/acp";
import { parseRepoInput } from "./lib/github";
import { completeLoginIfCallback, revoke } from "./lib/oauth";
import { foldThread, stripBlocks } from "./lib/protocol";
import { loadSelected, reconcileRepos, saveRepo, saveSelected } from "./lib/repos";
import { clearSettings, loadSettings, saveSettings, type Settings } from "./lib/settings";
import { AGENT_NAME_PREFIX, agentDescription, agentName, repoOfAgentName, STUDY_PROMPT, systemPrompt } from "./lib/spec";
import { Chat, type ThreadEntry } from "./components/Chat";
import { Connect } from "./components/Connect";
import { Dossier } from "./components/Dossier";

const STREAMS = ["acp", "stdout", "stage"];
const DEFAULT_MODEL = "anthropic/claude-sonnet-5";
/** The channel every sage conversation is bound to; one live conversation per agent. */
const CHANNEL = "repo-sage";

type Phase = "boot" | "connect" | "app";

interface Sage {
  repo: string;
  agent: Agent;
  /** Its live conversation on the channel; null before the first question, or after its machine was retired. */
  conversation: Conversation | null;
}

/** A one-word status for a sage, from its conversation. */
function presenceLabel(conv: Conversation | null): string {
  if (!conv) return "ready";
  switch (conv.status) {
    case "pending":
      return "starting";
    case "running":
      return "working";
    case "idle":
      return "online";
    default:
      return conv.status;
  }
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [phase, setPhase] = useState<Phase>("boot");
  const [connectError, setConnectError] = useState<string | null>(null);

  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const client = useMemo(() => (settings ? new FountainClient(settings) : null), [settings]);
  const catalogRef = useRef<Catalog | null>(null);

  const say = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 6000);
  }, []);

  // ── boot: OAuth callback, stored settings ─────────────────────────────────

  useEffect(() => {
    void (async () => {
      try {
        const cb = await completeLoginIfCallback();
        if (cb) {
          const s: Settings = { baseUrl: cb.baseUrl, apiKey: cb.apiKey, via: "oauth" };
          saveSettings(s);
          setSettings(s);
          return;
        }
      } catch (err) {
        setConnectError(err instanceof Error ? err.message : String(err));
      }
      const stored = loadSettings();
      if (stored) setSettings(stored);
      else setPhase("connect");
    })();
  }, []);

  useEffect(() => {
    if (!settings) return;
    setSelected(loadSelected(settings.baseUrl));
    setPhase("app");
  }, [settings]);

  const signOut = useCallback(() => {
    if (settings?.via === "oauth") void revoke(settings.baseUrl, settings.apiKey);
    clearSettings();
    setSettings(null);
    setAgents(null);
    setConversations([]);
    setSelected(null);
    setPhase("connect");
  }, [settings]);

  // ── the roster: every agent named "Sage: owner/name" ─────────────────────

  const sages: Sage[] = useMemo(() => {
    // The list is most recently updated first, so the first one per agent wins.
    const byAgent = new Map<string, Conversation>();
    for (const c of conversations) if (c.agent_id && !byAgent.has(c.agent_id)) byAgent.set(c.agent_id, c);
    const out: Sage[] = [];
    for (const a of agents ?? []) {
      const repo = repoOfAgentName(a.name);
      if (repo) out.push({ repo, agent: a, conversation: byAgent.get(a.id) ?? null });
    }
    return out.sort((a, b) => a.repo.localeCompare(b.repo));
  }, [agents, conversations]);

  const current = selected ? sages.find((s) => s.repo === selected) ?? null : null;
  const convId = current?.conversation?.id ?? null;
  const convIdRef = useRef<string | null>(null);
  convIdRef.current = convId;

  const refreshSages = useCallback(async () => {
    if (!client || !settings) return;
    try {
      const [list, convs] = await Promise.all([client.listAgents(AGENT_NAME_PREFIX), client.listChannelConversations(CHANNEL)]);
      setAgents(list);
      setConversations(convs);
      const live: Record<string, string> = {};
      for (const a of list) {
        const repo = repoOfAgentName(a.name);
        if (repo) live[repo] = a.id;
      }
      reconcileRepos(settings.baseUrl, live);
    } catch (err) {
      say(describeError(err));
    }
  }, [client, settings, say]);

  useEffect(() => {
    if (phase === "app") void refreshSages();
  }, [phase, refreshSages]);

  // First roster in: land on the remembered repo, or the first sage.
  const pickedRef = useRef(false);
  useEffect(() => {
    if (agents === null || pickedRef.current) return;
    pickedRef.current = true;
    if (!selected && sages.length > 0) setSelected(sages[0]!.repo);
  }, [agents, sages, selected]);

  const select = useCallback(
    (repo: string) => {
      setSelected(repo);
      setTurns([]);
      setEvents([]);
      if (settings) saveSelected(settings.baseUrl, repo);
    },
    [settings],
  );

  // ── the selected sage's thread ────────────────────────────────────────────

  const reloadThread = useCallback(async () => {
    if (!client || !convId) return;
    try {
      const [t, e] = await Promise.all([client.listTurns(convId), client.listAllEvents(convId, STREAMS)]);
      setTurns(t);
      setEvents(e);
    } catch (err) {
      say(describeError(err));
    }
  }, [client, convId, say]);

  useEffect(() => {
    if (convId) void reloadThread();
  }, [convId, reloadThread]);

  // ── stream: append live events, resync on turn boundaries ────────────────

  useEffect(() => {
    if (!client || phase !== "app") return;
    const ctrl = new AbortController();
    let lastEventId: string | null = null;
    let backoff = 1000;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      void client.streamEvents({
        lastEventId,
        streams: STREAMS,
        signal: ctrl.signal,
        onOpen: () => {
          setConnected(true);
          backoff = 1000;
          void refreshSages();
          void reloadThread();
        },
        onMessage: (msg) => {
          if (msg.id) lastEventId = msg.id;
          if (msg.event === "conversations") {
            // The list changed — a sage's conversation opened, ended, was read.
            void refreshSages();
            return;
          }
          let ev: StreamEvent;
          try {
            ev = JSON.parse(msg.data) as StreamEvent;
          } catch {
            return;
          }
          if (msg.id) ev.id = Number(msg.id);
          if (ev.conversation_id !== convIdRef.current) {
            // Another sage's turn ended → its unread flag moved; a new
            // conversation for the open sage (fresh computer) → re-point.
            if (ev.kind === "stage" && ev.stage === "turn" && ev.state !== "started") void refreshSages();
            return;
          }
          setEvents((es) => (es.some((e) => e.id === ev.id) ? es : [...es, ev]));
          if (ev.kind === "stage" && ev.stage === "turn") {
            void client.listTurns(ev.conversation_id).then(setTurns).catch(() => undefined);
            if (ev.state !== "started") {
              void client.markRead(ev.conversation_id).catch(() => undefined);
              void refreshSages();
            }
          }
        },
        onClose: () => {
          setConnected(false);
          if (stopped) return;
          window.setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 15000);
        },
      });
    };
    connect();
    return () => {
      stopped = true;
      ctrl.abort();
    };
  }, [client, phase, refreshSages, reloadThread]);

  // ── derived: blocks per turn, the dossier ─────────────────────────────────

  const runtime = current?.conversation?.runtime ?? current?.agent.runtime ?? "claude";
  const thread: ThreadEntry[] = useMemo(() => {
    const sorted = [...turns].sort((a, b) => a.turn_number - b.turn_number);
    const byTurn = new Map<string, LogEvent[]>();
    for (const ev of events) {
      if (!ev.turn_id) continue;
      const list = byTurn.get(ev.turn_id);
      if (list) list.push(ev);
      else byTurn.set(ev.turn_id, [ev]);
    }
    return sorted.map((turn) => {
      const blocks = blocksForTurn(byTurn.get(turn.id) ?? [], runtime);
      const reply = blocks
        .filter((b): b is Extract<(typeof blocks)[number], { kind: "text" }> => b.kind === "text")
        .map((b) => b.body)
        .join("");
      return { turn, blocks, reply };
    });
  }, [turns, events, runtime]);

  const view = useMemo(() => foldThread(thread), [thread]);
  const working = thread.some((t) => t.turn.ended_at === null && t.turn.status !== "failed");
  const settled = thread.length > 0 && !working;
  const studyFailed = view.map === null && settled;

  // ── actions ───────────────────────────────────────────────────────────────

  const send = useCallback(
    async (agentId: string, text: string) => {
      if (!client) return;
      setBusy(true);
      try {
        await client.sendOnChannel({ agent_id: agentId, channel_id: CHANNEL, prompt: text });
        await Promise.all([refreshSages(), reloadThread()]);
      } catch (err) {
        say(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [client, refreshSages, reloadThread, say],
  );

  /** The study kick-off: the computer may still be provisioning, so retry through 503s. */
  const study = useCallback(
    async (agentId: string) => {
      if (!client) return;
      setBusy(true);
      try {
        for (let i = 0; i < 24; i++) {
          try {
            await client.sendOnChannel({ agent_id: agentId, channel_id: CHANNEL, prompt: STUDY_PROMPT });
            await Promise.all([refreshSages(), reloadThread()]);
            return;
          } catch (err) {
            if (err instanceof ApiError && err.status === 503) {
              await sleep(Math.min(err.retryAfter ?? 10, 15) * 1000);
              continue;
            }
            throw err;
          }
        }
        say("The sage's computer took too long to start — use Retry in a moment.");
      } catch (err) {
        say(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [client, refreshSages, reloadThread, say],
  );

  const addRepo = useCallback(
    async (input: string) => {
      if (!client || !settings) return;
      const repo = parseRepoInput(input);
      if (!repo) {
        say("That doesn't look like a GitHub repo — use owner/name or a github.com URL. Public repos only.");
        return;
      }
      const existing = sages.find((s) => s.repo === repo);
      if (existing) {
        select(repo);
        return;
      }
      setAdding(repo);
      try {
        const name = agentName(repo);
        // Reuse an agent of that name if there is one; otherwise create one.
        let agent = (await client.listAgents(name)).find((a) => a.name === name);
        if (!agent) {
          if (!catalogRef.current) catalogRef.current = await client.getCatalog().catch(() => null);
          const models = Object.values(catalogRef.current?.models ?? {}).flat();
          const model = models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models.find((m) => m.startsWith("anthropic/")) ?? DEFAULT_MODEL;
          agent = await client.createAgent({
            name,
            description: agentDescription(repo),
            model,
            runtime: "claude",
            system: systemPrompt(repo),
          });
        }
        saveRepo(settings.baseUrl, repo, agent.id);
        await refreshSages();
        select(repo);
        void study(agent.id);
      } catch (err) {
        say(describeError(err));
      } finally {
        setAdding(null);
      }
    },
    [client, settings, sages, select, refreshSages, study, say],
  );

  const retire = useCallback(
    async (sage: Sage) => {
      if (!client || !settings) return;
      if (!window.confirm(`Retire the sage for ${sage.repo}? Its agent, computer and clone go away; the conversation stays in Fountain.`)) return;
      try {
        if (sage.conversation) await client.terminate(sage.conversation.id);
        await client.deleteAgent(sage.agent.id);
        if (selected === sage.repo) {
          setSelected(null);
          saveSelected(settings.baseUrl, null);
        }
        await refreshSages();
      } catch (err) {
        say(describeError(err));
      }
    },
    [client, settings, selected, refreshSages, say],
  );

  // ── render ────────────────────────────────────────────────────────────────

  if (phase === "boot") return <div className="setup" />;
  if (phase === "connect" || !settings || !client)
    return (
      <Connect
        error={connectError}
        onPaste={(s) => {
          saveSettings(s);
          setConnectError(null);
          setSettings(s);
        }}
      />
    );

  const pendingRepo = adding && !sages.some((s) => s.repo === adding) ? adding : null;

  return (
    <div className="app">
      <aside className="rail">
        <div className="wordmark small">
          Repo<span>Sage</span>
        </div>
        <nav className="repolist">
          {sages.map((s) => (
            <button key={s.repo} className={s.repo === selected ? "repobtn active" : "repobtn"} onClick={() => select(s.repo)}>
              <code>{s.repo}</code>
              <span className="repostate">
                {s.conversation?.unread && s.repo !== selected && <i className="unread" />}
                {s.conversation?.status === "running" ? "working" : ""}
              </span>
            </button>
          ))}
          {pendingRepo && (
            <div className="repobtn pending">
              <code>{pendingRepo}</code>
              <span className="repostate">hiring…</span>
            </div>
          )}
          {agents !== null && sages.length === 0 && !pendingRepo && <p className="fineprint">No repos yet.</p>}
        </nav>
        <AddRepoForm disabled={adding !== null} onAdd={(v) => void addRepo(v)} />
        <div className="rail-foot">
          <span className={connected ? "dot on" : "dot"} title={connected ? "live" : "reconnecting"} />
          <button className="linkish" onClick={signOut}>
            sign out
          </button>
          <p className="fineprint">
            Runs on <a href="https://github.com/managoat/fountain">Fountain</a> ·{" "}
            <a href="https://github.com/managoat/repo-sage">source</a>
          </p>
        </div>
      </aside>

      <main className="main">
        {toast && <div className="toast">{toast}</div>}
        {current ? (
          <>
            <header className="repo-head">
              <a href={`https://github.com/${current.repo}`} target="_blank" rel="noreferrer">
                <code>{current.repo}</code>
              </a>
              <span className="fineprint">{working ? "working…" : presenceLabel(current.conversation)}</span>
              <button className="linkish" onClick={() => void retire(current)}>
                retire sage
              </button>
            </header>
            {view.map && <Dossier map={view.map} />}
            {view.map === null && !settled && (
              <div className="study-card">
                <p>
                  The sage is getting a computer, cloning <code>{current.repo}</code> (shallow — very large repos may be
                  declined), and reading it. The map lands here when it is done.
                </p>
              </div>
            )}
            {studyFailed && (
              <div className="study-card failed">
                <p>{lastProse(thread) || "The sage could not study this repository."}</p>
                <div className="study-actions">
                  <button className="primary" disabled={busy} onClick={() => void study(current.agent.id)}>
                    Retry
                  </button>
                  <button className="danger" disabled={busy} onClick={() => void retire(current)}>
                    Remove
                  </button>
                </div>
              </div>
            )}
            <Chat
              thread={thread}
              map={view.map}
              repo={current.repo}
              busy={busy}
              working={working}
              onSend={(text) => {
                if (current) void send(current.agent.id, text);
              }}
            />
          </>
        ) : (
          <div className="hero">
            <div className="hero-card">
              <h1>Chat with any codebase.</h1>
              <p>
                Name a public GitHub repo. A sage — an agent on its own computer — clones it, maps it, and answers your
                questions with citations that link straight to the lines on GitHub.
              </p>
              <AddRepoForm big disabled={adding !== null} onAdd={(v) => void addRepo(v)} />
              {pendingRepo && (
                <p className="fineprint">
                  Hiring a sage for <code>{pendingRepo}</code>…
                </p>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function AddRepoForm(props: { onAdd: (value: string) => void; disabled: boolean; big?: boolean }) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    props.onAdd(value);
    setValue("");
  };
  return (
    <form className={props.big ? "addrepo big" : "addrepo"} onSubmit={submit}>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="owner/name or GitHub URL"
        disabled={props.disabled}
        aria-label="repository"
      />
      <button type="submit" className="primary" disabled={props.disabled || !value.trim()}>
        {props.disabled ? "…" : "Study"}
      </button>
    </form>
  );
}

/** The agent's last words, for the study-failed card. */
function lastProse(thread: ThreadEntry[]): string {
  for (let i = thread.length - 1; i >= 0; i--) {
    const prose = stripBlocks(thread[i]!.reply);
    if (prose) return prose;
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
