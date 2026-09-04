/**
 * Paddock: one persistent machine per person, terminal tabs on it, and a panel
 * that says what the machine actually has.
 *
 * Nothing about the box lives in this browser. The machine is found from the
 * conversation list (`tabs.findBox`), the tabs are derived from it
 * (`tabs.tabsOf`), what is installed is read out of the machine's own receipt
 * (`protocol.parseReceipt`), and which tabs are behind is a revision stamped
 * on each conversation's `channel_id`. Sign in from another laptop and it is
 * all still there; clear this browser and you lose a sign-in, nothing else.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, describeError, FountainClient } from "./api/client";
import type { Agent, Catalog, Conversation, Environment, LogEvent, Repository, Sandbox } from "./api/types";
import { Boot } from "./components/Boot";
import { Connect } from "./components/Connect";
import { Files } from "./components/Files";
import { Machine } from "./components/Machine";
import { Tabs } from "./components/Tabs";
import { Terminal } from "./components/Terminal";
import { ensureIdentity, type Identity } from "./lib/identity";
import { boxDrift, applyKeep, applyTodo, configRev, desiredItems, primaryRepoPath, withRev } from "./lib/machine";
import { parseReceipt, decodeFile, type Receipt } from "./lib/protocol";
import { completeLoginIfCallback, revoke } from "./lib/oauth";
import { clearSettings, loadSettings, saveSettings, type Settings } from "./lib/settings";
import { applyPrompt, bootstrapPrompt, reconcilePrompt, RECEIPT_PATH, WORK_ROOT } from "./lib/spec";
import { canPrompt, channelFor, findBox, holder, nextSlug, opsTab, OPS_SLUG, staleTabs, tabsOf, visibleTabs } from "../shared/tabs";

const STREAMS = ["acp", "stdout", "stderr", "stage"];
/** The tab list carries status; a short poll keeps "who holds the machine" honest. */
const POLL_MS = 4000;

type Side = "machine" | "files";

export function App() {
  const [settings, setSettings] = useState<Settings | null>(() => loadSettings());
  const [authError, setAuthError] = useState<string | null>(null);

  // ── sign-in ──────────────────────────────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        const cb = await completeLoginIfCallback();
        if (!cb) return;
        const s: Settings = { baseUrl: cb.baseUrl, apiKey: cb.apiKey, via: "oauth" };
        saveSettings(s);
        setSettings(s);
        if (cb.hash) window.location.hash = cb.hash;
      } catch (err) {
        setAuthError(describeError(err));
      }
    })();
  }, []);

  const connect = useCallback((s: Settings) => {
    saveSettings(s);
    setSettings(s);
    setAuthError(null);
  }, []);

  if (!settings) return <Connect onConnect={connect} error={authError} />;
  return <Paddock key={settings.baseUrl + settings.apiKey} settings={settings} onSignOut={() => { void revoke(settings.baseUrl, settings.apiKey).catch(() => undefined); clearSettings(); setSettings(null); }} />;
}

function Paddock({ settings, onSignOut }: { settings: Settings; onSignOut: () => void }) {
  const client = useMemo(() => new FountainClient(settings), [settings]);

  const [identity, setIdentity] = useState<Identity | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [booting, setBooting] = useState(true);
  const [starting, setStarting] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sandbox, setSandbox] = useState<Sandbox | null>(null);
  const [events, setEvents] = useState<Record<string, LogEvent[]>>({});
  const [loadedTabs, setLoadedTabs] = useState<Record<string, boolean>>({});
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [queued, setQueued] = useState<Record<string, string>>({});
  const [opening, setOpening] = useState(false);
  const [side, setSide] = useState<Side>("machine");

  const [envSecretKeys, setEnvSecretKeys] = useState<string[]>([]);
  const [vaultSecretKeys, setVaultSecretKeys] = useState<string[]>([]);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [receiptRead, setReceiptRead] = useState(false);
  const [applying, setApplying] = useState(false);

  const boxId = identity ? findBox(conversations, identity.agent.id) : null;
  const rev = identity ? configRev(identity.agent) : 0;

  const tabs = useMemo(
    () => (identity && boxId ? tabsOf(conversations, { sandboxId: boxId, agentId: identity.agent.id, rev, workRoot: WORK_ROOT }) : []),
    [conversations, identity, boxId, rev],
  );
  const strip = useMemo(() => visibleTabs(tabs), [tabs]);
  const active = strip.find((t) => t.slug === activeSlug) ?? strip[0] ?? null;
  const machineHolder = holder(tabs);

  // ── boot: the identity, then the box ─────────────────────────────────────
  useEffect(() => {
    void (async () => {
      try {
        const [cat, agents] = await Promise.all([
          client.getCatalog().catch(() => null),
          client.listAgents().catch(() => [] as Agent[]),
        ]);
        setCatalog(cat);
        const mine = agents.find((a) => {
          const m = (a.metadata ?? {})["paddock"];
          return !!m && typeof m === "object" && !Array.isArray(m) && (m as { identity?: unknown }).identity === true;
        });
        if (!mine) return; // first run — Boot asks for a runtime
        setIdentity(await ensureIdentity(client, { runtime: mine.runtime, model: mine.model }));
      } catch (err) {
        setFatal(describeError(err));
      } finally {
        setBooting(false);
      }
    })();
  }, [client]);

  const refreshConversations = useCallback(async () => {
    if (!identity) return;
    try {
      setConversations(await client.listConversations({ agent_id: identity.agent.id }));
    } catch {
      /* a poll that misses is not worth a message; the next one will do */
    }
  }, [client, identity]);

  useEffect(() => {
    if (!identity) return;
    void refreshConversations();
    const t = window.setInterval(() => void refreshConversations(), POLL_MS);
    return () => window.clearInterval(t);
  }, [identity, refreshConversations]);

  // First run of an identity that exists but has no live box: start one.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!identity || booting || boxId || startedRef.current || conversations.length === 0) return;
    startedRef.current = true;
    void startBox(identity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, booting, boxId, conversations.length]);

  async function startBox(id: Identity) {
    setStarting(true);
    try {
      const conv = await client.startBox({
        agent_id: id.agent.id,
        title: "Terminal 1",
        channel_id: channelFor("t1", configRev(id.agent)),
        ...(id.environment ? { environment_id: id.environment.id } : {}),
        ...(id.vault ? { vault_id: id.vault.id } : {}),
      });
      await client.sendPrompt(conv.id, bootstrapPrompt({ slug: "t1", repoPath: primaryRepoPath(id.environment) })).catch(() => undefined);
      setActiveSlug("t1");
      await refreshConversations();
    } catch (err) {
      setFatal(describeError(err));
    } finally {
      setStarting(false);
    }
  }

  async function boot(choice: { runtime: string; model: string }) {
    setStarting(true);
    setFatal(null);
    try {
      const id = await ensureIdentity(client, choice);
      setIdentity(id);
      startedRef.current = true;
      await startBox(id);
    } catch (err) {
      setFatal(describeError(err));
      setStarting(false);
    }
  }

  // ── the machine's own state ──────────────────────────────────────────────
  const refreshMachine = useCallback(async () => {
    if (!identity) return;
    const [env, envKeys, vaultKeys] = await Promise.all([
      client.getEnvironment(identity.environment.id).catch(() => identity.environment),
      client.listSecretKeys("environments", identity.environment.id).then((r) => r.map((s) => s.key)).catch(() => [] as string[]),
      identity.vault
        ? client.listSecretKeys("vaults", identity.vault.id).then((r) => r.map((s) => s.key)).catch(() => [] as string[])
        : Promise.resolve([] as string[]),
    ]);
    setIdentity((cur) => (cur ? { ...cur, environment: env } : cur));
    setEnvSecretKeys(envKeys);
    setVaultSecretKeys(vaultKeys);
  }, [client, identity]);

  useEffect(() => {
    if (identity) void refreshMachine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity?.agent.id]);

  /** The receipt: free to read, and it does not wake a parked box. */
  const readReceipt = useCallback(async () => {
    if (!boxId) return;
    try {
      const file = await client.readFile(boxId, RECEIPT_PATH);
      setReceipt(parseReceipt(decodeFile(file)));
    } catch {
      setReceipt(null); // missing is the common case, and it is not an error
    } finally {
      setReceiptRead(true);
    }
  }, [client, boxId]);

  useEffect(() => {
    if (!boxId) return;
    void readReceipt();
    void client.getSandbox(boxId).then(setSandbox).catch(() => undefined);
  }, [boxId, client, readReceipt]);

  const desired = useMemo(
    () =>
      identity
        ? desiredItems({ agent: identity.agent, environment: identity.environment, envSecretKeys, vaultSecretKeys })
        : [],
    [identity, envSecretKeys, vaultSecretKeys],
  );
  const drift = useMemo(() => boxDrift(desired, receiptRead ? receipt : null), [desired, receipt, receiptRead]);

  // ── scrollback ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active || loadedTabs[active.conversation.id]) return;
    const id = active.conversation.id;
    setLoadedTabs((m) => ({ ...m, [id]: true }));
    void client
      .listAllEvents(id, STREAMS)
      .then((list) => setEvents((m) => ({ ...m, [id]: list })))
      .catch(() => undefined);
  }, [active, client, loadedTabs]);

  useEffect(() => {
    if (!identity) return;
    const ctrl = new AbortController();
    let stopped = false;
    let lastEventId: string | null = null;
    let backoff = 1000;

    const run = () => {
      void client.streamAllEvents({
        lastEventId,
        streams: STREAMS,
        signal: ctrl.signal,
        onOpen: () => {
          backoff = 1000;
        },
        onMessage: (msg) => {
          if (msg.id) lastEventId = msg.id;
          if (msg.event === "conversations") {
            void refreshConversations();
            return;
          }
          let ev: LogEvent;
          try {
            ev = JSON.parse(msg.data) as LogEvent;
          } catch {
            return;
          }
          if (msg.id) ev.id = Number(msg.id);
          const conv = ev.conversation_id;
          if (!conv) return;
          setEvents((m) => {
            const list = m[conv] ?? [];
            return list.some((e) => e.id === ev.id) ? m : { ...m, [conv]: [...list, ev] };
          });
          if (ev.kind === "stage" && ev.stage === "turn" && ev.state !== "started") {
            void refreshConversations();
            void readReceipt();
          }
        },
        onClose: () => {
          if (stopped) return;
          window.setTimeout(run, backoff);
          backoff = Math.min(backoff * 2, 15000);
        },
      });
    };
    run();
    return () => {
      stopped = true;
      ctrl.abort();
    };
  }, [client, identity, refreshConversations, readReceipt]);

  // A tab that was waiting for the box gets its turn the moment it frees up.
  useEffect(() => {
    if (machineHolder) return;
    const waiting = Object.entries(queued)[0];
    if (!waiting) return;
    const [slug, text] = waiting;
    const tab = tabs.find((t) => t.slug === slug);
    if (!tab) return;
    setQueued((q) => {
      const next = { ...q };
      delete next[slug];
      return next;
    });
    void client.sendPrompt(tab.conversation.id, text).catch((err) => setNotice(describeError(err)));
  }, [machineHolder, queued, tabs, client]);

  // ── actions ──────────────────────────────────────────────────────────────
  async function send(slug: string, text: string) {
    const tab = tabs.find((t) => t.slug === slug);
    if (!tab) return;
    if (!canPrompt(tabs, slug)) {
      setQueued((q) => ({ ...q, [slug]: text }));
      return;
    }
    try {
      await client.sendPrompt(tab.conversation.id, text);
      await refreshConversations();
    } catch (err) {
      if (err instanceof ApiError && (err.code === "sandbox_at_capacity" || err.code === "conversation_busy")) {
        setQueued((q) => ({ ...q, [slug]: text }));
        return;
      }
      setNotice(describeError(err));
    }
  }

  async function openTab() {
    if (!identity || !boxId) return;
    setOpening(true);
    try {
      const slug = nextSlug(tabs);
      const conv = await client.openTab({
        agent_id: identity.agent.id,
        sandbox_id: boxId,
        title: `Terminal ${slug.slice(1)}`,
        channel_id: channelFor(slug, rev),
      });
      setActiveSlug(slug);
      await client.sendPrompt(conv.id, bootstrapPrompt({ slug, repoPath: primaryRepoPath(identity.environment) })).catch(() => undefined);
      await refreshConversations();
    } catch (err) {
      setNotice(describeError(err));
    } finally {
      setOpening(false);
    }
  }

  async function closeTab(slug: string) {
    const tab = tabs.find((t) => t.slug === slug);
    if (!tab) return;
    try {
      // The machine stays up: it is the identity's home, not this conversation's.
      await client.terminate(tab.conversation.id);
      await refreshConversations();
    } catch (err) {
      setNotice(describeError(err));
    }
  }

  /** The hidden tab paddock changes the machine through, made on demand. */
  async function ensureOps(): Promise<string | null> {
    if (!identity || !boxId) return null;
    const existing = opsTab(tabs);
    if (existing) return existing.conversation.id;
    const conv = await client.openTab({
      agent_id: identity.agent.id,
      sandbox_id: boxId,
      title: "Machine",
      channel_id: channelFor(OPS_SLUG, rev),
    });
    await refreshConversations();
    return conv.id;
  }

  async function apply() {
    if (!identity) return;
    setApplying(true);
    setNotice(null);
    try {
      const ops = await ensureOps();
      if (!ops) return;
      await client.sendPrompt(
        ops,
        applyPrompt({ rev, todo: applyTodo(drift), keep: applyKeep(drift), runtime: identity.agent.runtime }),
      );
      setSide("machine");
      setNotice("Applying on the box — watch the Machine tab.");
      await refreshConversations();
    } catch (err) {
      setNotice(describeError(err));
    } finally {
      setApplying(false);
    }
  }

  async function reconcile() {
    if (!identity) return;
    setApplying(true);
    try {
      const ops = await ensureOps();
      if (!ops) return;
      await client.sendPrompt(
        ops,
        reconcilePrompt({
          rev,
          candidates: desired.filter((i) => i.tier === "box").map((i) => ({ id: i.id, instruction: i.instruction })),
          runtime: identity.agent.runtime,
        }),
      );
      setNotice("Asking the box what it already has.");
      await refreshConversations();
    } catch (err) {
      setNotice(describeError(err));
    } finally {
      setApplying(false);
    }
  }

  async function saveEnvironment(patch: { repositories?: Repository[]; packages?: string[]; setup_script?: string }) {
    if (!identity) return;
    try {
      // Same environment id, new contents: the box keeps running, and the
      // Machine panel starts showing the gap.
      const env: Environment = await client.updateEnvironment(identity.environment.id, patch);
      setIdentity((cur) => (cur ? { ...cur, environment: env } : cur));
    } catch (err) {
      setNotice(describeError(err));
    }
  }

  /** A tier-`session` change: bump the revision so open tabs read as behind. */
  async function bumpAndSave(patch: Partial<Agent>) {
    if (!identity) return;
    const next = configRev(identity.agent) + 1;
    const agent = await client.updateAgent(identity.agent.id, { ...patch, metadata: withRev(identity.agent.metadata, next) });
    setIdentity((cur) => (cur ? { ...cur, agent } : cur));
  }

  async function saveAgent(patch: Partial<Agent>) {
    try {
      await bumpAndSave(patch);
    } catch (err) {
      setNotice(describeError(err));
    }
  }

  async function addSecret(where: "env" | "vault", key: string, value: string) {
    if (!identity) return;
    try {
      const parent = where === "env" ? "environments" : "vaults";
      const id = where === "env" ? identity.environment.id : identity.vault?.id;
      if (!id) return;
      await client.putSecret(parent, id, key, value);
      await bumpAndSave({}); // a new secret reaches the next session, not this one
      await refreshMachine();
    } catch (err) {
      setNotice(describeError(err));
    }
  }

  async function removeSecret(where: "env" | "vault", key: string) {
    if (!identity) return;
    try {
      const parent = where === "env" ? "environments" : "vaults";
      const id = where === "env" ? identity.environment.id : identity.vault?.id;
      if (!id) return;
      await client.deleteSecret(parent, id, key);
      await bumpAndSave({});
      await refreshMachine();
    } catch (err) {
      setNotice(describeError(err));
    }
  }

  // ── render ───────────────────────────────────────────────────────────────
  if (booting) return <Splash line="finding your machine…" />;
  if (!identity) return <Boot catalog={catalog} starting={starting} error={fatal} onStart={boot} />;
  if (fatal && !boxId) return <Splash line={fatal} error />;
  if (!boxId || strip.length === 0) return <Splash line={starting ? "starting your machine…" : "waiting for your machine…"} />;

  return (
    <div className="app">
      <header className="bar">
        <span className="brand">
          <span className="glyph">🐐</span> Paddock
        </span>
        <span className="dim">
          <code>{sandbox?.id ?? boxId}</code> · {sandbox?.status ?? "…"} · rev {rev}
        </span>
        <span className="spacer" />
        <button className={`ghost ${side === "machine" ? "on" : ""}`} onClick={() => setSide("machine")}>
          Machine
        </button>
        <button className={`ghost ${side === "files" ? "on" : ""}`} onClick={() => setSide("files")}>
          Files
        </button>
        <button className="ghost" onClick={onSignOut}>
          Sign out
        </button>
      </header>

      {notice && (
        <div className="notice" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}

      <div className="split">
        <main>
          <Tabs
            tabs={strip}
            active={active?.slug ?? null}
            onSelect={setActiveSlug}
            onOpen={() => void openTab()}
            onClose={(slug) => void closeTab(slug)}
            opening={opening}
          />
          {active && (
            <Terminal
              tab={active}
              events={events[active.conversation.id] ?? []}
              blockedBy={machineHolder && machineHolder.slug !== active.slug ? machineHolder.title : null}
              queued={queued[active.slug] ?? null}
              onSend={(text) => void send(active.slug, text)}
              onInterrupt={() => void client.interrupt(active.conversation.id).catch(() => undefined)}
              loading={!loadedTabs[active.conversation.id]}
            />
          )}
        </main>

        <aside>
          {side === "machine" ? (
            <Machine
              sandbox={sandbox}
              agent={identity.agent}
              environment={identity.environment}
              vault={identity.vault}
              rev={rev}
              desired={desired}
              drift={drift}
              envSecretKeys={envSecretKeys}
              vaultSecretKeys={vaultSecretKeys}
              stale={staleTabs(tabs)}
              applying={applying}
              busy={machineHolder?.title ?? null}
              onApply={() => void apply()}
              onReconcile={() => void reconcile()}
              onOpenTab={() => void openTab()}
              onSaveEnvironment={saveEnvironment}
              onAddSecret={addSecret}
              onRemoveSecret={removeSecret}
              onSaveAgent={saveAgent}
            />
          ) : (
            <Files client={client} sandboxId={boxId} root={active?.cwd ?? WORK_ROOT} />
          )}
        </aside>
      </div>
    </div>
  );
}

function Splash({ line, error }: { line: string; error?: boolean }) {
  return (
    <div className="connect">
      <div className="connect-card">
        <h1>
          <span className="glyph">🐐</span> Paddock
        </h1>
        <p className={error ? "error" : "lede"}>{line}</p>
      </div>
    </div>
  );
}
