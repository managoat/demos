/**
 * Paddock: one persistent machine per person, terminal tabs on it, and a panel
 * that says what the machine actually has.
 *
 * The first thing a visitor sees is their own computer starting, not a
 * registration wall: with no session and no invite link, `POST /api/start`
 * opens one on a claimable Fountain principal and Terminal 1 comes up. Signing
 * in later *claims* that exact machine — same disk, same history — rather than
 * building a second one. See `server/starter.ts`.
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
import type { Agent, Catalog, Connection, ConnectionProvider, Conversation, Environment, LogEvent, Repository, Sandbox } from "./api/types";
import { Starting } from "./components/Starting";
import { Connect } from "./components/Connect";
import { Files } from "./components/Files";
import { Details } from "./components/Details";
import { Setup } from "./components/Setup";
import { People } from "./components/People";
import { Upgrade } from "./components/Upgrade";
import { Claim, remaining } from "./components/Claim";
import { Tabs } from "./components/Tabs";
import { Terminal } from "./components/Terminal";
import { Workspaces } from "./components/Workspaces";
import { defaultChoice, ensureIdentity, isPaddockAgent, type BootStep, type Identity } from "./lib/identity";
import { boxDrift, applyKeep, applyTodo, configRev, desiredItems, primaryRepoPath, withRev } from "./lib/machine";
import { parseReceipt, decodeFile, type Receipt } from "./lib/protocol";
import { completeLoginIfCallback } from "./lib/oauth";
import { describePaddockError, paddock, type Me, type PaddockDto, type Reachable, type Role, type TabPeopleDto } from "./api/paddock";
import { applyPrompt, bootstrapPrompt, reconcilePrompt, welcomePrompt, RECEIPT_PATH, WORK_ROOT } from "../shared/spec";
import { canPrompt, channelFor, findBox, holder, nextSlug, opsTab, OPS_SLUG, staleTabs, tabsOf, visibleTabs } from "../shared/tabs";

const STREAMS = ["acp", "stdout", "stderr", "stage"];
/** The tab list carries status; a short poll keeps "who holds the machine" honest. */
const POLL_MS = 4000;

/**
 * Which panel the inspector is showing. `setup` is the owner's only — it is
 * never in the tab strip for anybody else, and the branch that renders it
 * checks again, because a `side` can outlive the role that chose it.
 */
type Side = "details" | "setup" | "files" | "people" | "account";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(rememberedWorkspace);
  const [checked, setChecked] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  /**
   * Who this browser is, settled once — and if that is nobody, a computer.
   *
   * The old branch here was "no session, show the sign-in wall". A visitor who
   * has never been here does not want a form, they want the thing the form is
   * in front of, so this asks the server for a machine instead. It is not
   * unconditional: `anonymousStart` says whether this deployment offers one at
   * all, and a deployment that does not falls back to exactly the old
   * behaviour, which is why the sign-in screen is still here.
   */
  const refreshMe = useCallback(async () => {
    const existing = await paddock.me().catch(() => null);
    if (existing) {
      setMe(existing);
      setChecked(true);
      return;
    }
    const offered = await paddock.config().then((c) => c.anonymousStart).catch(() => false);
    if (!offered) {
      setMe(null);
      setChecked(true);
      return;
    }
    try {
      setMe(await paddock.start(startKey()));
    } catch (err) {
      // Out of introductory credit, at capacity, or Fountain is unreachable.
      // The sign-in screen is the honest fallback: it is a real way in, and
      // the message says why the easy one did not happen.
      setMe(null);
      setAuthError(describePaddockError(err));
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
          const next = await paddock.signIn(cb.apiKey);
          window.location.hash = cb.hash || "";
          // A claim turned an anonymous owner into a registered one on the same
          // machine. Everything in this tree — the identity, the role, the
          // reachable computers, the refs keyed to the old session — moved at
          // once, so reload rather than reconcile, remembering the computer so
          // the reload lands back on it. Same call the guest upgrade makes.
          if (next.claimedFrom) {
            rememberWorkspace(next.paddockId);
            window.location.reload();
            return;
          }
          setMe(next);
          setChecked(true);
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

  const selectWorkspace = useCallback((id: string | null) => {
    rememberWorkspace(id);
    setWorkspaceId(id);
  }, []);

  const connect = useCallback(async (apiKey: string) => {
    setAuthError(null);
    try {
      const next = await paddock.signIn(apiKey);
      setMe(next);
      // A guest who just upgraded is now a different person in the same seat.
      // Reload rather than reconcile: the identity, the role, the reachable
      // paddocks and every ref keyed to the old session all moved at once.
      // The seat is written down first — they now own a machine too, and
      // landing on that empty one instead is exactly the seat being lost.
      if (next.upgradedFrom || next.claimedFrom) {
        rememberWorkspace(next.paddockId);
        window.location.reload();
      }
    } catch (err) {
      setAuthError(describePaddockError(err));
    }
  }, []);

  const signOut = useCallback(async () => {
    await paddock.signOut().catch(() => undefined);
    rememberWorkspace(null);
    setWorkspaceId(null);
    setMe(null);
  }, []);

  if (!checked) return <Splash line="…" />;
  if (!me) return <Connect onConnect={connect} error={authError} />;

  const selectedId = workspaceId && me.paddocks.some((workspace) => workspace.id === workspaceId) ? workspaceId : me.paddockId;
  const selected = me.paddocks.find((workspace) => workspace.id === selectedId);
  const selectedMe: Me = selectedId === me.paddockId
    ? me
    : { ...me, paddockId: selectedId, role: selected?.role ?? null };

  return (
    <Paddock
      key={`${me.label}:${selectedId ?? "new"}`}
      me={selectedMe}
      /**
       * The computer being opened. A brand-new one has no machine yet, and
       * `Paddock` builds it exactly as it built the first — which is why this
       * component is keyed on the id: switching computers is a remount, not a
       * reconciliation, and every ref that says "boot has run" goes with it.
       */
      place={selected ?? null}
      onMe={(next) => {
        setMe(next);
        selectWorkspace(next.paddockId);
      }}
      onSelectWorkspace={selectWorkspace}
      /**
       * A new computer lands you on it. There is nothing to see anywhere else
       * — the machine is built on arrival — and being left behind on the old
       * one is the button appearing not to have worked.
       */
      onAddComputer={async () => {
        const made = await paddock.addComputer();
        setMe(await paddock.me());
        selectWorkspace(made.id);
      }}
      onRenameComputer={async (id, name) => {
        await paddock.renameComputer(id, name);
        setMe(await paddock.me());
      }}
      /**
       * Removing the computer somebody is standing on. The reload is the same
       * decision `replaceMachine` makes and for the same reason: everything in
       * this tree describes a machine that no longer exists, and the one path
       * already known to work is arriving somewhere fresh.
       */
      onRemoveComputer={async (id) => {
        await paddock.removeComputer(id);
        const next = await paddock.me();
        rememberWorkspace(next.paddocks.find((p) => p.role === "owner" && p.id !== id)?.id ?? next.paddockId);
        window.location.reload();
      }}
      onSignOut={() => void signOut()}
    />
  );
}

/**
 * Which computer the sidebar was left on, kept in this browser.
 *
 * The server's answer to "where do I land" is a default — your own machine —
 * and a person with more than one wants the one they were last in, across a
 * reload and across the reload the guest upgrade does on purpose.
 */
const WORKSPACE_KEY = "paddock.workspace";

function rememberedWorkspace(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

function rememberWorkspace(id: string | null): void {
  try {
    if (id) localStorage.setItem(WORKSPACE_KEY, id);
    else localStorage.removeItem(WORKSPACE_KEY);
  } catch {
    // A storage-restricted browser just lands on the default every time.
  }
}

/**
 * This browser's start key, made once and kept.
 *
 * The server derives the computer's id from it, which is what makes starting
 * idempotent: a dropped response, a refresh mid-flight, or React
 * double-invoking the boot effect all name the same machine rather than
 * opening a second one on this demo's money.
 *
 * A browser that will not store gets a fresh computer per visit. That is the
 * honest degradation — the alternative is pretending a machine persisted for
 * somebody who gave us nothing to recognise them by — and it is exactly what
 * happens today to anyone who clears their cookies.
 */
const START_KEY = "paddock.start";

function startKey(): string {
  try {
    const kept = localStorage.getItem(START_KEY);
    if (kept) return kept;
  } catch {
    return crypto.randomUUID();
  }
  const made = crypto.randomUUID();
  try {
    localStorage.setItem(START_KEY, made);
  } catch {
    // Storage went away between the read and the write. One visit, one
    // computer; nothing else here depends on it.
  }
  return made;
}

/** `#/join/<token>` — the anonymous way in. */
function joinTokenFromHash(): string | null {
  const m = /^#\/join\/([^/?#]+)/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]!) : null;
}

function Paddock({
  me,
  place,
  onMe,
  onSelectWorkspace,
  onAddComputer,
  onRenameComputer,
  onRemoveComputer,
  onSignOut,
}: {
  me: Me;
  place: Reachable | null;
  onMe: (m: Me) => void;
  onSelectWorkspace: (id: string) => void;
  onAddComputer: () => Promise<void>;
  onRenameComputer: (id: string, name: string) => Promise<void>;
  onRemoveComputer: (id: string) => Promise<void>;
  onSignOut: () => void;
}) {
  // Every Fountain call goes through this machine's own proxy, on the owner's
  // key. A guest's browser makes exactly the same calls and holds nothing.
  // Which machine is not this component's to change: switching computers
  // remounts it (see the key), so it reads the one it was mounted for.
  const paddockId = me.paddockId;
  /** Which paddock the boot effect has already run for. See the effect. */
  const bootedRef = useRef<string | null | undefined>(undefined);
  const client = useMemo(() => new FountainClient(`/f/${paddockId ?? "none"}`), [paddockId]);
  const role = me.role;
  const isOwner = role === "owner";
  /**
   * The owner of a computer nobody has claimed yet.
   *
   * They are a full owner of Terminal 1 and of the files, and not an owner of
   * anything that costs more or lets somebody else in — a second terminal, the
   * config surface, invitations, rebuild. Every one of those is refused by the
   * server (`context.requireClaimed`); what this flag does is stop offering
   * buttons that would only come back with a refusal.
   */
  const unclaimed = me.kind === "starter";
  /**
   * What the read-only panels are told this person is.
   *
   * A starter really is the owner — `role` says so, and the server agrees —
   * but every control those panels gate on `owner` is one the server refuses
   * until the computer is claimed: apply, reconcile, open a fresh tab, invite,
   * mint a link. Handing them the guest view is how they get a panel that
   * describes the machine without offering a single button that comes back
   * with `claim_required`.
   */
  const panelRole: Role = unclaimed ? "guest" : (role ?? "guest");
  const [people, setPeople] = useState<PaddockDto | null>(null);
  /** Who is in the tab being looked at. Invitations are per tab, so this is too. */
  const [tabPeople, setTabPeople] = useState<TabPeopleDto | null>(null);

  const [identity, setIdentity] = useState<Identity | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  /**
   * The owner's remote-MCP connections, and where a new one is made.
   *
   * Both are `null` — not empty — where the egress credential broker is not on
   * for this person, which is not an error. That null is the only evidence the
   * panel has that nothing is brokered, and it decides what is true about the
   * machine's secrets as well as its MCP
   * servers. `fountainUrl` is where somebody is sent to connect one, because
   * connecting needs a browser session at Fountain and this app is not it.
   */
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [providers, setProviders] = useState<ConnectionProvider[] | null>(null);
  const [fountainUrl, setFountainUrl] = useState<string | null>(null);
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
  const [side, setSide] = useState<Side>("details");

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
    () =>
      agentId && boxId && paddockId && place
        ? tabsOf(conversations, {
            paddock: { id: paddockId, original: place.original },
            sandboxId: boxId,
            agentId,
            rev,
            workRoot: WORK_ROOT,
          })
        : [],
    [conversations, agentId, boxId, rev, paddockId, place],
  );
  const strip = useMemo(() => visibleTabs(tabs), [tabs]);
  const active = strip.find((t) => t.slug === activeSlug) ?? strip[0] ?? null;
  const machineHolder = holder(tabs);

  // ── boot ─────────────────────────────────────────────────────────────────
  // The owner finds or makes the identity behind the machine. A guest does
  // not: they were handed a paddock id by the invite and everything else is
  // derived. Nobody asks for a paddock here — the server hands every account
  // its own, so there is no state where the app is signed in with nowhere
  // to be.
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
        if (!paddockId || !place) return;
        setPeople(await paddock.showOne(paddockId).catch(() => null));
        if (!isOwner) return;

        const [cat, agents, conns, provs, cfg] = await Promise.all([
          client.getCatalog().catch(() => null),
          client.listAgents().catch(() => [] as Agent[]),
          client.listConnections().catch(() => null),
          client.listConnectionProviders().catch(() => null),
          paddock.config().catch(() => null),
        ]);
        setCatalog(cat);
        setConnections(conns);
        setProviders(provs);
        setFountainUrl(cfg?.fountainUrl ?? null);
        // What a *second* computer runs is what the first one runs. Reading
        // the choice off any paddock agent, rather than this computer's, is
        // deliberate: a new machine should match the ones this person already
        // has instead of quietly reverting to the app's default the day the
        // default moves.
        const mine = agents.find(isPaddockAgent);
        // First run provisions rather than asking. The one choice that was
        // ever on that form — the runtime — is the same answer for everybody,
        // and Details says what was picked, Setup what changing it costs.
        const choice = mine ? { runtime: mine.runtime, model: mine.model } : defaultChoice(cat);
        setIdentity(await ensureIdentity(client, choice, { paddockId, original: place.original }, setStep));
      } catch (err) {
        setFatal(describeError(err));
      } finally {
        setBooting(false);
      }
    })();
  }, [client, paddockId, isOwner, place]);

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
        channel_id: channelFor(paddockId!, "t1", configRev(id.agent)),
        ...(id.environment ? { environment_id: id.environment.id } : {}),
        ...(id.vault ? { vault_id: id.vault.id } : {}),
      });
      setActiveSlug("t1");
      setStep("waking");
      await refreshConversations();
    } catch (err) {
      // A box that cannot be started because the grant is spent is not a
      // failure to retry — "Try again" would fail identically forever — so it
      // is worth naming the one thing that would actually change the answer.
      if (unclaimed && err instanceof ApiError && (err.status === 402 || err.code === "insufficient_credits")) {
        setFatal("This computer has used up its free time. Claim it with a Fountain account to keep going.");
        return;
      }
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

  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  /**
   * The introductory grant is spent, or the computer's time is up.
   *
   * Kept as state rather than read off an error each time, because it is a
   * property of the machine from here on: every turn will fail the same way
   * until somebody claims it, and the prompt should say so instead of failing
   * again once per attempt.
   */
  const [halted, setHalted] = useState<string | null>(null);

  /**
   * Signing in from inside the app: a guest keeping their seat, or the
   * anonymous owner of an unclaimed computer claiming it.
   *
   * One function for both, because it is one call. The server sees whichever
   * session is on the way through and does the corresponding thing — promote
   * the guest, or attach this account to the machine's principal — before it
   * issues the new session, so neither can half-happen the way two requests
   * could. Which of them it did comes back in the answer.
   */
  async function onUpgrade(apiKey: string) {
    setUpgradeError(null);
    try {
      const next = await paddock.signIn(apiKey);
      if (next.upgradedFrom || next.claimedFrom) {
        rememberWorkspace(next.paddockId);
        window.location.reload();
      } else onMe(next);
    } catch (err) {
      setUpgradeError(describePaddockError(err));
    }
  }

  /** The retry behind the Try again button. Everything here is idempotent. */
  async function retryBoot() {
    if (!paddockId || !place) return;
    setFatal(null);
    try {
      const id = await ensureIdentity(client, defaultChoice(catalog), { paddockId, original: place.original }, setStep);
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
        // and the Details panel says it has nothing to show.
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
        // Somebody opened a tab, took a turn, was invited, or renamed the
        // machine: re-read rather than trying to patch state from another
        // browser's event.
        void refreshConversations();
        if (msg.event === "people" || msg.event === "computer") {
          void paddock.showOne(paddockId).then(setPeople).catch(() => undefined);
        }
      },
      onClose: () => undefined,
    });
    return () => {
      window.clearInterval(timer);
      ctrl.abort();
    };
  }, [paddockId, refreshConversations]);

  /**
   * A sign-in that worked while its claim did not.
   *
   * They are signed in and standing on a machine of their own, which is the
   * right outcome — but it is not the machine they were just using, and that
   * has to be said. The alternative is a computer full of somebody's work
   * silently becoming a different, empty one.
   */
  useEffect(() => {
    if (me.claimFailed) setNotice(me.claimFailed);
  }, [me.claimFailed]);

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
      // Money, not machinery. Fountain answers `insufficient_credits` at every
      // door that spends, so this is the same answer whether the grant ran out
      // mid-turn or the computer's time expired between turns.
      if (unclaimed && err instanceof ApiError && (err.status === 402 || err.code === "insufficient_credits")) {
        setHalted("This computer has used up its free time.");
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
        channel_id: channelFor(paddockId!, slug, rev),
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
          channel_id: channelFor(paddockId!, fresh, rev),
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
      channel_id: channelFor(paddockId!, OPS_SLUG, rev),
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
      setSide("details");
      setNotice("Applying on the box — watch the Details tab.");
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
      // Details panel starts showing the gap.
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
    return (
      <Starting
        step={step}
        name={place?.name ?? ""}
        another={!!place && !place.original}
        unclaimed={unclaimed}
        error={fatal}
        onRetry={() => void retryBoot()}
      />
    );
  }
  if (fatal && !boxId) return <Splash line={fatal} error />;
  if (!boxId || strip.length === 0) return <Splash line="This machine is not running yet." />;

  return (
    <div className="app">
      <Workspaces
        workspaces={me.paddocks}
        activeId={paddockId}
        activeStatus={sandbox?.status ?? null}
        me={me.label}
        session={me.kind}
        onSelect={onSelectWorkspace}
        onAdd={onAddComputer}
        onRename={onRenameComputer}
        onSignOut={onSignOut}
      />

      <div className="workspace-stage">
        {notice && (
          <div className="notice" onClick={() => setNotice(null)}>
            <span>{notice}</span>
            <span className="notice-dismiss">×</span>
          </div>
        )}

        {/*
          The offer, in front of somebody rather than behind a menu — and
          persistent rather than a modal. Nothing about it interrupts a person
          who only wants to keep typing in Terminal 1, which is the whole
          reason they were given a machine before an account.
        */}
        {unclaimed && side !== "account" && (
          <div className="notice claim-offer" onClick={() => setSide("account")}>
            <span>
              This computer is not claimed{claimLeft(me) ? ` — it stops in ${claimLeft(me)}` : ""}. Claim it and it stays yours,
              with everything on it.
            </span>
            <span className="notice-dismiss">Claim →</span>
          </div>
        )}

        <div className="split">
          <main className="conversation-panel">
            <Tabs
              tabs={strip}
              active={active?.slug ?? null}
              onSelect={setActiveSlug}
              onOpen={() => void openTab()}
              onClose={(slug) => void closeTab(slug)}
              opening={opening}
              canClose={isOwner && !unclaimed}
              canOpen={isOwner && !unclaimed}
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
                halted={halted ? { line: halted, action: "Claim this computer", onAction: () => setSide("account") } : null}
              />
            )}
          </main>

          <aside className="inspector-panel">
            {/*
              These switch the panel, so they belong to the panel. In the top
              bar they read as application-wide navigation, which is what they
              looked like and never were.

              **Setup** is here only for the owner. It used to be the bottom
              half of the Machine panel, gated the same way — so a guest loses
              nothing by its absence, and gains a strip that offers only what
              they can actually do.
            */}
            <nav className="panel-tabs">
              {(["details", "setup", "files", "people"] as const)
                // Setup is the owner's, and an unclaimed computer is not one
                // anybody may change yet — the server refuses every write on it
                // until it is claimed, so offering the editors would only be
                // offering refusals.
                .filter((which) => which !== "setup" || (role === "owner" && !unclaimed))
                .map((which) => (
                  <button key={which} className={side === which ? "on" : ""} onClick={() => setSide(which)}>
                    {which === "details"
                      ? "Details"
                      : which === "setup"
                        ? "Setup"
                        : which === "files"
                          ? "Files"
                          : `People${people && people.here.length > 1 ? ` (${people.here.length})` : ""}`}
                  </button>
                ))}
              {(me.kind === "guest" || unclaimed) && (
                <button className={`upgrade-tab ${side === "account" ? "on" : ""}`} onClick={() => setSide("account")}>
                  {unclaimed ? "Claim" : "Sign in"}
                </button>
              )}
            </nav>
            {side === "account" ? (
              // Two panels behind one strip button, because they are the same
              // offer to two different people: a guest is being offered a seat
              // of their own, somebody on an unclaimed computer is being
              // offered the machine they are already standing on.
              unclaimed ? (
                <Claim claim={me.claim} onKey={(key) => void onUpgrade(key)} error={upgradeError} />
              ) : (
                <Upgrade handle={me.label} onKey={(key) => void onUpgrade(key)} error={upgradeError} />
              )
            ) : side === "people" ? (
              people && active ? (
                <People
                  tab={tabPeople}
                  // An unclaimed computer cannot let anybody in — the server
                  // refuses both the invitation and the link — so the panel is
                  // shown the way a visitor sees it: who is here, no doors.
                  role={panelRole}
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
            ) : side === "setup" ? (
              // The tab is not offered to a guest, and the panel is not built
              // for one either — `side` is state, and a role can change under
              // it (a guest signing in, an owner removing somebody) without
              // the strip having been clicked since.
              !identity || role !== "owner" ? (
                <div className="panel">
                  <p className="fine">Only the owner changes what this machine is made of.</p>
                </div>
              ) : (
                <Setup
                  agent={identity.agent}
                  environment={identity.environment}
                  vault={identity.vault}
                  catalog={catalog}
                  connections={connections}
                  providers={providers}
                  fountainUrl={fountainUrl}
                  envSecretKeys={envSecretKeys}
                  vaultSecretKeys={vaultSecretKeys}
                  drift={drift}
                  busy={machineHolder?.title ?? null}
                  onSaveEnvironment={saveEnvironment}
                  onAddSecret={addSecret}
                  onRemoveSecret={removeSecret}
                  onSaveAgent={saveAgent}
                  onRebuild={() => replaceMachine("rebuild")}
                  onReset={() => replaceMachine("reset")}
                  onRemove={paddockId && me.paddocks.filter((p) => p.role === "owner").length > 1 ? () => onRemoveComputer(paddockId) : null}
                  computerName={place?.name ?? ""}
                  onDetails={() => setSide("details")}
                  onOpenTab={() => void openTab()}
                />
              )
            ) : side === "details" ? (
              !identity ? (
                <div className="panel">
                  <p className="fine">Nothing to show about this machine.</p>
                </div>
              ) : (
                <Details
                  sandbox={sandbox}
                  agent={identity.agent}
                  rev={rev}
                  desired={desired}
                  drift={drift}
                  stale={staleTabs(tabs)}
                  applying={applying}
                  busy={machineHolder?.title ?? null}
                  onApply={() => void apply()}
                  onReconcile={() => void reconcile()}
                  onOpenTab={() => void openTab()}
                  onSetup={role === "owner" && !unclaimed ? () => setSide("setup") : null}
                  // Apply, "ask the box what it has" and "open a fresh tab" are
                  // all owner-gated in this panel and all claim-gated on the
                  // server, so an unclaimed computer is shown the reading and
                  // none of the three.
                  role={panelRole}
                />
              )
            ) : (
              <Files client={client} sandboxId={boxId} root={active?.cwd ?? WORK_ROOT} />
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

/** How long an unclaimed computer has left, or nothing when it has no clock. */
function claimLeft(me: Me): string | null {
  return me.claim ? remaining(me.claim.expiresAt) : null;
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
