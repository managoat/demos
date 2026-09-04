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
import { Starting } from "./components/Starting";
import { Connect } from "./components/Connect";
import { Files } from "./components/Files";
import { Machine } from "./components/Machine";
import { People } from "./components/People";
import { Tabs } from "./components/Tabs";
import { Terminal } from "./components/Terminal";
import { defaultChoice, ensureIdentity, type BootStep, type Identity } from "./lib/identity";
import { boxDrift, applyKeep, applyTodo, configRev, desiredItems, primaryRepoPath, withRev } from "./lib/machine";
import { parseReceipt, decodeFile, type Receipt } from "./lib/protocol";
import { completeLoginIfCallback } from "./lib/oauth";
import { describePaddockError, paddock, type Me, type PaddockDto, type TabPeopleDto } from "./api/paddock";
import { applyPrompt, bootstrapPrompt, reconcilePrompt, welcomePrompt, RECEIPT_PATH, WORK_ROOT } from "../shared/spec";
import { canPrompt, channelFor, findBox, holder, nextSlug, opsTab, OPS_SLUG, staleTabs, tabsOf, visibleTabs } from "../shared/tabs";

const STREAMS = ["acp", "stdout", "stderr", "stage"];
/** The tab list carries status; a short poll keeps "who holds the machine" honest. */
const POLL_MS = 4000;

type Side = "machine" | "files" | "people";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await paddock.me());
    } catch {
      setMe(null);
    } finally {
      setChecked(true);
    }
  }, []);

  // Sign-in, an invite link, or neither — settled once, in that order.
  //
  // The OAuth round trip still happens in the browser (the key is minted for
  // this app), but the key is handed straight to the server and never kept
  // here. What the browser holds afterwards is a session cookie.
  useEffect(() => {
    void (async () => {
      const joinToken = joinTokenFromHash();
      try {
        const cb = await completeLoginIfCallback();
        if (cb) {
          setMe(await paddock.signIn(cb.apiKey));
          setChecked(true);
          window.location.hash = cb.hash || "";
          return;
        }
        if (joinToken) {
          setMe(await paddock.join(joinToken));
          setChecked(true);
          window.location.hash = "";
          return;
        }
      } catch (err) {
        setAuthError(describePaddockError(err));
        setChecked(true);
        return;
      }
      await refreshMe();
    })();
  }, [refreshMe]);

  /**
   * An invite link pasted into a tab that already has the app open.
   *
   * Changing only the hash is a same-document navigation, so nothing remounts
   * and the effect above never runs again. Without this, following a link from
   * inside the app silently did nothing — which looked exactly like a dead
   * link, and is the way most people will actually use one.
   */
  useEffect(() => {
    const onHash = () => {
      const token = joinTokenFromHash();
      if (!token) return;
      void paddock
        .join(token)
        .then((next) => {
          setMe(next);
          setAuthError(null);
          window.location.hash = "";
        })
        .catch((err) => setAuthError(describePaddockError(err)));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const connect = useCallback(async (apiKey: string) => {
    setAuthError(null);
    try {
      setMe(await paddock.signIn(apiKey));
    } catch (err) {
      setAuthError(describePaddockError(err));
    }
  }, []);

  const signOut = useCallback(async () => {
    await paddock.signOut().catch(() => undefined);
    setMe(null);
  }, []);

  if (!checked) return <Splash line="…" />;
  if (!me) return <Connect onConnect={connect} error={authError} />;
  return <Paddock key={me.label} me={me} onMe={setMe} onSignOut={() => void signOut()} />;
}

/** `#/join/<token>` — the anonymous way in. */
function joinTokenFromHash(): string | null {
  const m = /^#\/join\/([^/?#]+)/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]!) : null;
}

function Paddock({ me, onMe, onSignOut }: { me: Me; onMe: (m: Me) => void; onSignOut: () => void }) {
  // Every Fountain call goes through this machine's own proxy, on the owner's
  // key. A guest's browser makes exactly the same calls and holds nothing.
  const [paddockId, setPaddockId] = useState<string | null>(me.paddockId);
  /** Which paddock the boot effect has already run for. See the effect. */
  const bootedRef = useRef<string | null | undefined>(undefined);
  const client = useMemo(() => new FountainClient(`/f/${paddockId ?? "none"}`), [paddockId]);
  const role = me.role;
  const isOwner = role === "owner";
  const [people, setPeople] = useState<PaddockDto | null>(null);
  /** Who is in the tab being looked at. Invitations are per tab, so this is too. */
  const [tabPeople, setTabPeople] = useState<TabPeopleDto | null>(null);

  const [identity, setIdentity] = useState<Identity | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [booting, setBooting] = useState(true);
  const [step, setStep] = useState<BootStep>("environment");
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

  /**
   * The agent behind the machine.
   *
   * The owner learns it from their identity; somebody else learns it from the
   * tabs they can see, because the proxy hands back only this machine's
   * conversations. Taking it from `identity` alone deadlocked a guest: their
   * identity is read *from* the conversations, and the conversations were
   * gated on having an identity.
   */
  const identityAgent = identity?.agent.id ?? null;
  // Prefer the identity's own agent — but only if the machine is actually on
  // it. The conversations are the truth about where the machine lives, and an
  // account that ended up with two paddock identities would otherwise hold one
  // agent while its box belonged to the other, and match nothing forever.
  const agentId =
    identityAgent && findBox(conversations, identityAgent)
      ? identityAgent
      : (conversations.find((c) => c.agent_id)?.agent_id ?? identityAgent);
  const boxId = agentId ? findBox(conversations, agentId) : null;
  const rev = identity ? configRev(identity.agent) : 0;

  const tabs = useMemo(
    () => (agentId && boxId ? tabsOf(conversations, { sandboxId: boxId, agentId, rev, workRoot: WORK_ROOT }) : []),
    [conversations, agentId, boxId, rev],
  );
  const strip = useMemo(() => visibleTabs(tabs), [tabs]);
  const active = strip.find((t) => t.slug === activeSlug) ?? strip[0] ?? null;
  const machineHolder = holder(tabs);

  // ── boot ─────────────────────────────────────────────────────────────────
  // The owner claims a paddock (idempotent) and then finds or makes the
  // identity behind the machine. A guest does neither: they were handed a
  // paddock id by the invite and everything else is derived.
  useEffect(() => {
    // Once per client, ever. React double-invokes effects in development and
    // will re-run this on any dep change; `ensureIdentity` creates records, so
    // two overlapping runs created two agents and left the app holding the one
    // without the machine. The work is idempotent against Fountain but not
    // against itself running twice at the same time.
    if (bootedRef.current === paddockId) return;
    bootedRef.current = paddockId;
    void (async () => {
      try {
        let id = paddockId;
        if (!id && isOwner === false && me.kind === "user") {
          // A signed-in user with no machine yet: claiming one is free and
          // creates nothing on Fountain.
          const claimed = await paddock.claim();
          id = claimed.id;
          setPaddockId(id);
          onMe({ ...me, role: "owner", paddockId: id });
          return; // the effect reruns with a real paddock id
        }
        if (!id) return;

        setPeople(await paddock.show().catch(() => null));
        if (!isOwner) return;

        const [cat, agents] = await Promise.all([
          client.getCatalog().catch(() => null),
          client.listAgents().catch(() => [] as Agent[]),
        ]);
        setCatalog(cat);
        const mine = agents.find((a) => {
          const meta = (a.metadata ?? {})["paddock"];
          return !!meta && typeof meta === "object" && !Array.isArray(meta) && (meta as { identity?: unknown }).identity === true;
        });
        // First run provisions rather than asking. The one choice that was
        // ever on that form — the runtime — is the same answer for everybody,
        // and the Machine panel says what was picked and what changing it costs.
        const choice = mine ? { runtime: mine.runtime, model: mine.model } : defaultChoice(cat);
        setIdentity(await ensureIdentity(client, choice, setStep));
      } catch (err) {
        setFatal(describeError(err));
      } finally {
        setBooting(false);
      }
    })();
  }, [client, paddockId, isOwner, me, onMe]);

  // No agent filter and no identity gate: the proxy already returns exactly
  // this machine's tabs, to everybody in the paddock.
  const refreshConversations = useCallback(async () => {
    if (!paddockId) return;
    try {
      setConversations(await client.listConversations());
    } catch (err) {
      // A poll that misses is not worth interrupting anybody over — the next
      // one will do — but it is worth *saying*. An empty catch here hid two
      // bugs in a row, both of which looked like the app being stuck rather
      // than the app failing.
      console.error("paddock: could not list tabs —", describeError(err));
    }
  }, [client, paddockId]);

  useEffect(() => {
    if (!paddockId) return;
    void refreshConversations();
    const t = window.setInterval(() => void refreshConversations(), POLL_MS);
    return () => window.clearInterval(t);
  }, [paddockId, refreshConversations]);

  /**
   * An identity with no live machine: start one.
   *
   * `conversations.length === 0` is the "this account has never had a box"
   * case and gets the welcome turn. An identity with conversations but no live
   * box has simply had its machine end, and only needs its directory back.
   */
  const startedRef = useRef(false);
  useEffect(() => {
    if (!identity || booting || startedRef.current || !isOwner) return;
    // A box with a usable tab needs nothing. A box whose tabs have all ended
    // is as unusable as no box, and gets one the same way.
    if (boxId && strip.length > 0) return;
    startedRef.current = true;
    void startBox(identity, conversations.length === 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, booting, boxId, isOwner, strip.length, conversations.length]);

  async function startBox(id: Identity, welcome = false) {
    setStep("machine");
    try {
      // The first turn goes in the same call that starts the machine, which is
      // how the rest of the suite does it, and a machine that failed to start
      // is worth an error rather than a silent catch.
      //
      // On a brand-new machine that turn also introduces the place: the first
      // thing somebody sees is the agent working on their own box, saying what
      // is true of it. A machine being restarted just gets its directory back.
      await client.startBox({
        agent_id: id.agent.id,
        prompt: (welcome ? welcomePrompt : bootstrapPrompt)({ slug: "t1", repoPath: primaryRepoPath(id.environment) }),
        agentDefaultMode: id.agent.sandbox_mode ?? null,
        title: "Terminal 1",
        channel_id: channelFor("t1", configRev(id.agent)),
        ...(id.environment ? { environment_id: id.environment.id } : {}),
        ...(id.vault ? { vault_id: id.vault.id } : {}),
      });
      setActiveSlug("t1");
      setStep("waking");
      await refreshConversations();
    } catch (err) {
      setFatal(describeError(err));
    }
  }

  /**
   * Replacing the machine, then starting over from nothing.
   *
   * The reload is deliberate. Everything about the box — the identity, the
   * tabs, the receipt, which tab is active, the refs that say boot already
   * ran — is now describing something that does not exist, and unpicking that
   * by hand is how you get an app that is subtly wrong. A reload lands on the
   * one path that is already known to work: a person with no machine.
   */
  async function replaceMachine(which: "rebuild" | "reset") {
    if (!paddockId) return;
    try {
      const report = which === "rebuild" ? await paddock.rebuild(paddockId) : await paddock.reset(paddockId);
      if (report.failed.length) {
        // The machine is gone either way; say what would not go rather than
        // reloading over the top of it.
        setNotice(`Machine retired, but ${report.failed.map((f) => `${f.what} (${f.why})`).join("; ")}.`);
        window.setTimeout(() => window.location.reload(), 4000);
        return;
      }
      window.location.reload();
    } catch (err) {
      setNotice(describePaddockError(err));
    }
  }

  /** The retry behind the Try again button. Everything here is idempotent. */
  async function retryBoot() {
    setFatal(null);
    try {
      const id = await ensureIdentity(client, defaultChoice(catalog), setStep);
      setIdentity(id);
      startedRef.current = true;
      await startBox(id, conversations.length === 0);
    } catch (err) {
      setFatal(describeError(err));
    }
  }

  /**
   * A read-only identity for somebody who is not the owner.
   *
   * The owner's copy comes from `ensureIdentity`, which may create things; a
   * guest may not list agents at all. But the conversations they *can* see
   * name the agent, environment and vault the box was built from, and reading
   * those three by id is allowed. Same panel, same numbers, no writes.
   */
  useEffect(() => {
    if (isOwner || identity || conversations.length === 0) return;
    const source = conversations.find((c) => c.agent_id);
    if (!source?.agent_id) return;
    void (async () => {
      try {
        const agent = await client.getAgent(source.agent_id!);
        const environment = source.environment_id
          ? await client.getEnvironment(source.environment_id)
          : { id: "", name: "", repositories: [], packages: {}, setup_script: "" };
        setIdentity({ agent, environment, vault: source.vault_id ? { id: source.vault_id, name: "" } : null });
      } catch {
        // A machine we can use but not describe: the terminal still works,
        // and the Machine panel says it has nothing to show.
      }
    })();
  }, [isOwner, identity, conversations, client]);

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

  // Who is in the active tab. Reloaded on every tab change, because the
  // answer is different for each one.
  useEffect(() => {
    if (!paddockId || !active) {
      setTabPeople(null);
      return;
    }
    const conv = active.conversation.id;
    let stale = false;
    void paddock
      .tabPeople(paddockId, conv)
      .then((t) => {
        if (!stale) setTabPeople(t);
      })
      .catch(() => {
        if (!stale) setTabPeople(null);
      });
    return () => {
      stale = true;
    };
  }, [paddockId, active]);

  // ── scrollback ───────────────────────────────────────────────────────────

  /**
   * One tab's history, merged in rather than assigned over.
   *
   * Merging matters because this races the live stream: a turn that started
   * before the stream attached emits events nobody is listening for, and a
   * fetch that lands after them would otherwise drop whatever arrived in
   * between. Union by event id, oldest first, so calling this twice is free.
   */
  const loadEvents = useCallback(
    async (conversationId: string) => {
      try {
        const history = await client.listAllEvents(conversationId, STREAMS);
        setEvents((m) => {
          const seen = new Set(history.map((e) => e.id));
          const live = (m[conversationId] ?? []).filter((e) => !seen.has(e.id));
          return { ...m, [conversationId]: [...history, ...live].sort((a, b) => a.id - b.id) };
        });
      } catch {
        /* the stream is the other half of this; a missed fetch is not fatal */
      }
    },
    [client],
  );

  useEffect(() => {
    if (!active || loadedTabs[active.conversation.id]) return;
    const id = active.conversation.id;
    setLoadedTabs((m) => ({ ...m, [id]: true }));
    void loadEvents(id);
  }, [active, loadedTabs, loadEvents]);

  // The active tab's live tail. Phase 1 used Fountain's account-wide stream,
  // which cannot be shared: it carries every conversation on the owner's key.
  useEffect(() => {
    if (!active) return;
    const conversationId = active.conversation.id;
    const ctrl = new AbortController();
    let stopped = false;
    let lastEventId: string | null = null;
    let backoff = 1000;

    const run = () => {
      void client.streamConversation({
        conversationId,
        lastEventId,
        streams: STREAMS,
        signal: ctrl.signal,
        onOpen: () => {
          backoff = 1000;
          // Whatever happened before this connection existed. The first turn
          // of a brand-new machine starts the instant the conversation does,
          // which is before any of this is listening — that turn was invisible
          // until a reload, and so would anything missed by a dropped stream.
          void loadEvents(conversationId);
        },
        onMessage: (msg) => {
          if (msg.id) lastEventId = msg.id;
          let ev: LogEvent;
          try {
            ev = JSON.parse(msg.data) as LogEvent;
          } catch {
            return;
          }
          if (msg.id) ev.id = Number(msg.id);
          setEvents((m) => {
            const list = m[conversationId] ?? [];
            return list.some((e) => e.id === ev.id) ? m : { ...m, [conversationId]: [...list, ev] };
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
  }, [client, active, refreshConversations, readReceipt, loadEvents]);

  // The paddock's own channel: who is here, and when somebody else acts.
  useEffect(() => {
    if (!paddockId) return;
    const ctrl = new AbortController();
    const clientId = Math.random().toString(36).slice(2);
    const beat = () => void paddock.presence(paddockId, clientId).then((here) => setPeople((p) => (p ? { ...p, here } : p))).catch(() => undefined);
    beat();
    const timer = window.setInterval(beat, 20000);
    void paddock.stream(paddockId, {
      signal: ctrl.signal,
      onMessage: (msg) => {
        if (msg.event === "presence") {
          try {
            setPeople((p) => (p ? { ...p, here: JSON.parse(msg.data) } : p));
          } catch {
            /* a malformed frame is not worth a re-render */
          }
          return;
        }
        // Somebody opened a tab, took a turn, or was invited: re-read rather
        // than trying to patch state from another browser's event.
        void refreshConversations();
        if (msg.event === "people") void paddock.show().then(setPeople).catch(() => undefined);
      },
      onClose: () => undefined,
    });
    return () => {
      window.clearInterval(timer);
      ctrl.abort();
    };
  }, [paddockId, refreshConversations]);

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

  /**
   * Close a terminal. The machine stays up — it is the identity's home, not
   * this conversation's — and anyone invited to that tab loses their way in
   * with it, which is the point of being able to close one.
   *
   * Closing the last one is allowed, and immediately replaced: a machine you
   * cannot reach is not a state worth being able to get into, and "close this
   * one and start a clean one" is the reason to do it.
   */
  async function closeTab(slug: string) {
    const tab = tabs.find((t) => t.slug === slug);
    if (!tab) return;
    const last = strip.length === 1;
    try {
      await client.terminate(tab.conversation.id);
      if (activeSlug === slug) setActiveSlug(null);
      await refreshConversations();
      if (last && identity) {
        const fresh = nextSlug(tabs.filter((t) => t.slug !== slug));
        await client.openTab({
          agent_id: identity.agent.id,
          sandbox_id: boxId!,
          title: `Terminal ${fresh.slice(1)}`,
          channel_id: channelFor(fresh, rev),
        });
        setActiveSlug(fresh);
        await refreshConversations();
      }
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

  async function saveEnvironment(patch: { repositories?: Repository[]; packages?: Record<string, string[]>; setup_script?: string }) {
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
  // The owner watches their machine get built; anybody else is only waiting
  // for somebody else's, and has nothing to retry.
  if (isOwner && (!identity || !boxId || strip.length === 0)) {
    return <Starting step={step} error={fatal} onRetry={() => void retryBoot()} />;
  }
  if (fatal && !boxId) return <Splash line={fatal} error />;
  if (!boxId || strip.length === 0) return <Splash line="This machine is not running yet." />;

  return (
    <div className="app">
      <header className="bar">
        <span className="brand">
          <span className="glyph">🐐</span> Paddock
        </span>
        <span className="dim">
          <code>{sandbox?.id ?? boxId}</code> · {sandbox?.status ?? "…"} · rev {rev}
        </span>
        {!isOwner && <span className="badge">{people ? `${people.ownerEmail}'s machine` : "shared with you"}</span>}
        <span className="spacer" />
        <button className="ghost" onClick={onSignOut}>
          {me.kind === "guest" ? "Leave" : "Sign out"}
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
            canClose={isOwner}
            canOpen={isOwner}
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
          {/*
            These three switch the panel, so they belong to the panel. In the
            top bar they read as application-wide navigation, which is what
            they looked like and never were.
          */}
          <nav className="panel-tabs">
            {(["machine", "files", "people"] as const).map((which) => (
              <button key={which} className={side === which ? "on" : ""} onClick={() => setSide(which)}>
                {which === "machine" ? "Machine" : which === "files" ? "Files" : `People${people && people.here.length > 1 ? ` (${people.here.length})` : ""}`}
              </button>
            ))}
          </nav>
          {side === "people" ? (
            people && active ? (
              <People
                tab={tabPeople}
                tabTitle={active.title}
                role={role ?? "guest"}
                meLabel={me.label}
                ownerEmail={people.ownerEmail}
                here={people.here}
                onInvite={async (email) => setTabPeople(await paddock.addMember(people.id, active.conversation.id, email))}
                onRemove={async (email) => setTabPeople(await paddock.removeMember(people.id, active.conversation.id, email))}
                onMintLink={async () => {
                  const r = await paddock.mintInvite(people.id, active.conversation.id);
                  setTabPeople(r.data);
                  if (r.evicted) setNotice(`New link for ${active.title}. ${r.evicted} guest${r.evicted === 1 ? "" : "s"} removed.`);
                }}
                onCloseLink={async () => {
                  const r = await paddock.closeInvite(people.id, active.conversation.id);
                  setTabPeople(r.data);
                  setNotice(r.evicted ? `Link closed. ${r.evicted} guest${r.evicted === 1 ? "" : "s"} removed.` : "Link closed.");
                }}
              />
            ) : (
              <div className="panel">
                <p className="fine">Nobody is sharing this machine.</p>
              </div>
            )
          ) : side === "machine" ? (
            !identity ? (
              <div className="panel">
                <p className="fine">Nothing to show about this machine.</p>
              </div>
            ) : (
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
              onRebuild={() => replaceMachine("rebuild")}
              onReset={() => replaceMachine("reset")}
              role={role ?? "guest"}
            />
            )
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
