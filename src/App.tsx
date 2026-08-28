/**
 * Rounds: a rail of enrolled repositories, each one an agent plus a cron.
 *
 * This page is a control panel, not the product. The product is what happens
 * while nobody is here: a Fountain schedule wakes the agent, it audits, it
 * opens a pull request, and you meet the work on GitHub. Everything shown is
 * derived from the schedules and the agents' own threads — nothing is stored
 * outside Fountain and this browser's settings.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ApiError, describeError, FountainClient } from "./api/client";
import type { Catalog, LogEvent, Schedule, TeamEvent, Teammate, Turn } from "./api/types";
import { blocksForTurn } from "./lib/acp";
import { cronError, describeCron, relativeTime } from "./lib/cron";
import { parseRepoInput, refKey, refLabel, repoUrl, type RepoRef } from "./lib/hosts";
import { clearGhAuth, loadGhAuth, saveGhAuth, type GhAuth } from "./lib/ghauth";
import {
  beginGithubLogin,
  completeGithubLoginIfCallback,
  fetchAppInfo,
  fetchInstallations,
  fetchRepos,
  isGithubCallback,
  takeInstallCallback,
  type AppInfo,
} from "./lib/ghoauth";
import { completeLoginIfCallback, revoke } from "./lib/oauth";
import { foldRounds, type RoundEntry } from "./lib/protocol";
import {
  clearSettings,
  loadCadence,
  loadSettings,
  loadSkipped,
  saveCadence,
  saveSettings,
  saveSkipped,
  type Settings,
} from "./lib/settings";
import type { AccessibleRepo } from "./lib/repos";
import {
  agentDescription,
  agentName,
  CRON_PRESETS,
  DEFAULT_CRON,
  DEFAULT_POLICY,
  ENVIRONMENT_NAME,
  environmentSpec,
  refOfAgentName,
  apiBaseOfPrompt,
  policyOfPrompt,
  GRANT_KEY,
  ROUND_PROMPT,
  scheduleName,
  systemPrompt,
  vaultDescription,
  vaultName,
  type RoundsPolicy,
} from "./lib/spec";
import { InstallGate } from "./components/InstallGate";
import { RepoPicker } from "./components/RepoPicker";
import { Landing } from "./components/Landing";
import { isSignInRoute, SignIn } from "./components/SignIn";
import { RoundView } from "./components/RoundView";

const STREAMS = ["acp", "stdout", "stage"];
const DEFAULT_MODEL = "anthropic/claude-sonnet-5";

type Phase = "boot" | "connect" | "app";

interface Enrolled {
  ref: RepoRef;
  key: string;
  teammate: Teammate;
  schedule: Schedule | null;
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [phase, setPhase] = useState<Phase>("boot");
  const [connectError, setConnectError] = useState<string | null>(null);

  const [team, setTeam] = useState<Teammate[] | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [envId, setEnvId] = useState<string | null>(null);
  // Whether the App is installed anywhere. There is no longer a token to fall
  // back to, so this is the gate on enrolling at all.
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [checkingInstall, setCheckingInstall] = useState(false);
  /**
   * The only route this app has: `#/sign-in`, or the landing page.
   *
   * A hash rather than a path, so reloading it cannot 404 against a static
   * host, and `#/`-prefixed so the landing page's own anchors — `#what`,
   * `#tiers` — stay anchors.
   */
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const [ghAuth, setGhAuth] = useState<GhAuth | null>(() => loadGhAuth());
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  // What the App can already reach. Signing in tells us, so enrolling should
  // be picking from a list rather than typing a slug from memory.
  const [repos, setRepos] = useState<AccessibleRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [skipped, setSkipped] = useState<string[]>(() => loadSkipped());
  /** What the rail enrolls with. Picked once, remembered, per-repo after that. */
  const [railCron, setRailCron] = useState<string>(() => loadCadence(DEFAULT_CRON));

  const client = useMemo(() => (settings ? new FountainClient(settings) : null), [settings]);
  const catalogRef = useRef<Catalog | null>(null);

  const say = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 7000);
  }, []);

  // ── boot ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    void fetchAppInfo().then(setAppInfo);
  }, []);

  useEffect(() => {
    void (async () => {
      // Coming back from installing the App. Nothing to exchange — the fact
      // that we are here is the signal, and the install check will confirm it.
      const setup = takeInstallCallback();
      if (setup) say(setup.action === "install" ? "App installed. Enroll a repository." : "App permissions updated.");

      // Both OAuth flows land here as ?code=…; each claims only the callback
      // whose state it stashed, so this cannot swallow Fountain's.
      if (isGithubCallback()) {
        try {
          const gh = await completeGithubLoginIfCallback();
          if (gh) {
            const auth: GhAuth = { token: gh.token, login: gh.login };
            saveGhAuth(auth);
            setGhAuth(auth);
            say(`Signed in to GitHub as ${gh.login}.`);
          }
        } catch (err) {
          say(err instanceof Error ? err.message : String(err));
        }
      }
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
  }, [say]);

  useEffect(() => {
    if (settings) setPhase("app");
  }, [settings]);

  const signOut = useCallback(() => {
    if (settings?.via === "oauth") void revoke(settings.baseUrl, settings.apiKey);
    clearSettings();
    setSettings(null);
    setTeam(null);
    setSelected(null);
    setPhase("connect");
  }, [settings]);

  // ── the roster and its schedules ─────────────────────────────────────────

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      const [roster, scheds] = await Promise.all([client.listTeam(), client.listAllSchedules().catch(() => [])]);
      setTeam(roster);
      setSchedules(scheds);
    } catch (err) {
      say(describeError(err));
    }
  }, [client, say]);

  useEffect(() => {
    if (phase === "app") void refresh();
  }, [phase, refresh]);

  // The toolkit environment. It holds no credentials any more — only chant and
  // its lexicons — so there is nothing here to check beyond whether it exists.
  const checkEnvironment = useCallback(async () => {
    if (!client) return;
    try {
      const env = (await client.listEnvironments()).find((e) => e.name === ENVIRONMENT_NAME);
      setEnvId(env?.id ?? null);
    } catch {
      // Not fatal — enrolling will create what is missing.
    }
  }, [client]);

  useEffect(() => {
    if (phase === "app") void checkEnvironment();
  }, [phase, checkEnvironment]);

  /**
   * Whether the App is installed. Asked once on sign-in and again whenever the
   * person comes back from GitHub, because installing it happens over there
   * and the only way to know it worked is to look.
   */
  const checkInstall = useCallback(async () => {
    if (!ghAuth) {
      setInstalled(null);
      return;
    }
    setCheckingInstall(true);
    try {
      setInstalled((await fetchInstallations(ghAuth.token)).installed);
    } catch (err) {
      // A rejected token means the sign-in has expired; say so rather than
      // reporting the App as missing, which would send them to the wrong fix.
      say(err instanceof Error ? err.message : String(err));
      setInstalled(null);
    } finally {
      setCheckingInstall(false);
    }
  }, [ghAuth, say]);

  useEffect(() => {
    void checkInstall();
  }, [checkInstall]);

  /**
   * The repositories the App can reach, once we know it is installed at all.
   *
   * Re-asked whenever the install answer changes, which is what coming back
   * from "add repositories" looks like from in here.
   */
  useEffect(() => {
    if (!ghAuth || installed !== true) {
      setRepos([]);
      return;
    }
    let live = true;
    setReposLoading(true);
    void fetchRepos(ghAuth.token)
      .then((list) => {
        if (live) setRepos(list);
      })
      .catch(() => {
        // Not worth a toast: the rail falls back to the box you type into,
        // and the install gate already says when the token is the problem.
        if (live) setRepos([]);
      })
      .finally(() => {
        if (live) setReposLoading(false);
      });
    return () => {
      live = false;
    };
  }, [ghAuth, installed]);

  const skipRepo = useCallback((slug: string) => {
    setSkipped((prev) => {
      const next = prev.includes(slug) ? prev : [...prev, slug];
      saveSkipped(next);
      return next;
    });
  }, []);

  const unskipRepo = useCallback((slug: string) => {
    setSkipped((prev) => {
      const next = prev.filter((s) => s !== slug);
      saveSkipped(next);
      return next;
    });
  }, []);

  const enrolled: Enrolled[] = useMemo(() => {
    const byAgent = new Map(schedules.map((s) => [s.agent_id, s]));
    const out: Enrolled[] = [];
    for (const t of team ?? []) {
      const ref = refOfAgentName(t.name);
      if (ref) out.push({ ref, key: refKey(ref), teammate: t, schedule: byAgent.get(t.agent_id) ?? null });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }, [team, schedules]);

  /** What the picker below the rail must not offer again. */
  const enrolledKeys = useMemo(() => new Set(enrolled.map((e) => e.key)), [enrolled]);
  const skippedSet = useMemo(() => new Set(skipped), [skipped]);

  /**
   * Bring an already-enrolled agent's prompt up to date.
   *
   * The prompt is baked in at enrollment and there was no path to change it
   * afterwards — enrolling a repo that is already on the team just selects it.
   * That was survivable while prompt changes were cosmetic. It is not now: an
   * agent still carrying the old prompt would trade its grant for a read-only
   * token and then try to push with it, failing on a schedule where nobody is
   * watching.
   *
   * Its own choices are read back out of the prompt it is carrying, so this
   * changes the rules and nothing else — not the tier policy, and not the
   * deployment it reports to.
   */
  const reconciledRef = useRef(new Set<string>());
  useEffect(() => {
    if (!client || enrolled.length === 0) return;
    void (async () => {
      const stale = enrolled.filter((e) => {
        if (reconciledRef.current.has(e.teammate.agent_id)) return false;
        const system = e.teammate.agent.system;
        if (!system) return false;
        const want = systemPrompt(e.ref, policyOfPrompt(system), apiBaseOfPrompt(system) ?? window.location.origin);
        return system !== want;
      });
      if (stale.length === 0) return;
      let updated = 0;
      for (const e of stale) {
        // Marked before the call, not after: a failure must not turn into a
        // retry loop against the same agent every time the roster refreshes.
        reconciledRef.current.add(e.teammate.agent_id);
        const system = e.teammate.agent.system!;
        try {
          await client.updateAgent(e.teammate.agent_id, {
            system: systemPrompt(e.ref, policyOfPrompt(system), apiBaseOfPrompt(system) ?? window.location.origin),
            description: agentDescription(e.ref),
          });
          updated += 1;
        } catch {
          // Not fatal, and not worth a toast per repo — the round that fails
          // will say so itself.
        }
      }
      if (updated > 0) {
        say(`Brought ${updated} agent${updated === 1 ? "" : "s"} up to date — they propose pull requests now instead of pushing.`);
        await refresh();
      }
    })();
  }, [client, enrolled, refresh, say]);

  const current = selected ? enrolled.find((e) => e.key === selected) ?? null : null;
  const convId = current?.teammate.conversation.id ?? null;
  const convIdRef = useRef<string | null>(null);
  convIdRef.current = convId;

  const pickedRef = useRef(false);
  useEffect(() => {
    if (team === null || pickedRef.current) return;
    pickedRef.current = true;
    if (!selected && enrolled.length > 0) setSelected(enrolled[0]!.key);
  }, [team, enrolled, selected]);

  // ── the selected repo's rounds ───────────────────────────────────────────

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

  useEffect(() => {
    if (!client || phase !== "app") return;
    const ctrl = new AbortController();
    let lastEventId: string | null = null;
    let backoff = 1000;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      void client.streamTeam({
        lastEventId,
        streams: STREAMS,
        signal: ctrl.signal,
        onOpen: () => {
          setConnected(true);
          backoff = 1000;
          void refresh();
          void reloadThread();
        },
        onMessage: (msg) => {
          if (msg.id) lastEventId = msg.id;
          if (msg.event === "team") {
            void refresh();
            return;
          }
          let ev: TeamEvent;
          try {
            ev = JSON.parse(msg.data) as TeamEvent;
          } catch {
            return;
          }
          if (msg.id) ev.id = Number(msg.id);
          if (ev.conversation_id !== convIdRef.current) {
            if (ev.kind === "stage" && ev.stage === "turn" && ev.state !== "started") void refresh();
            return;
          }
          setEvents((es) => (es.some((e) => e.id === ev.id) ? es : [...es, ev]));
          if (ev.kind === "stage" && ev.stage === "turn") {
            void client.listTurns(ev.conversation_id).then(setTurns).catch(() => undefined);
            if (ev.state !== "started") {
              void client.markRead(ev.conversation_id).catch(() => undefined);
              void refresh();
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
  }, [client, phase, refresh, reloadThread]);

  const runtime = current?.teammate.conversation.runtime ?? "claude";
  const rounds: RoundEntry[] = useMemo(() => {
    const sorted = [...turns].sort((a, b) => a.turn_number - b.turn_number);
    const byTurn = new Map<string, LogEvent[]>();
    for (const ev of events) {
      if (!ev.turn_id) continue;
      const list = byTurn.get(ev.turn_id);
      if (list) list.push(ev);
      else byTurn.set(ev.turn_id, [ev]);
    }
    return foldRounds(
      sorted.map((turn) => ({
        reply: blocksForTurn(byTurn.get(turn.id) ?? [], runtime)
          .filter((b): b is Extract<ReturnType<typeof blocksForTurn>[number], { kind: "text" }> => b.kind === "text")
          .map((b) => b.body)
          .join(""),
        ranAt: turn.ended_at ?? turn.started_at ?? turn.inserted_at,
      })),
    );
  }, [turns, events, runtime]);

  const running = turns.some((t) => t.ended_at === null && t.status !== "failed");

  // ── actions ───────────────────────────────────────────────────────────────

  const ensureEnvironment = useCallback(async (): Promise<string | undefined> => {
    if (!client) return undefined;
    if (envId) return envId;
    try {
      const existing = (await client.listEnvironments()).find((e) => e.name === ENVIRONMENT_NAME);
      const env = existing ?? (await client.createEnvironment(environmentSpec()));
      setEnvId(env.id);
      return env.id;
    } catch (err) {
      say(`Could not set up the ${ENVIRONMENT_NAME} environment: ${describeError(err)}`);
      return undefined;
    }
  }, [client, envId, say]);

  /**
   * A repository's own vault, holding its grant and nothing else.
   *
   * A vault binds to one conversation, so this repo's grant is reachable by
   * this repo's agent alone. It used to be able to hold a pasted token under a
   * different key too, which meant a repo could end up carrying both — the
   * grant in use and a stale token nobody cleaned up.
   */
  const ensureVault = useCallback(
    async (ref: RepoRef, grant: string): Promise<string | undefined> => {
      if (!client) return undefined;
      try {
        const name = vaultName(ref);
        const existing = (await client.listVaults()).find((v) => v.name === name);
        const vault = existing ?? (await client.createVault({ name, description: vaultDescription(ref) }));
        await client.putVaultSecret(vault.id, GRANT_KEY, grant);
        return vault.id;
      } catch (err) {
        say(`Could not store the grant: ${describeError(err)}`);
        return undefined;
      }
    },
    [client, say],
  );

  const enroll = useCallback(
    async (input: string, cron: string, policy: RoundsPolicy) => {
      if (!client) return;
      if (!ghAuth) {
        say("Sign in with GitHub first — a repository is enrolled with a grant from the App.");
        return;
      }
      const ref = parseRepoInput(input);
      if (!ref) {
        say("That doesn't look like a repo — use owner/name, or a URL on github.com, gitlab.com or codeberg.org.");
        return;
      }
      if (ref.host !== "github.com") {
        say("Rounds opens pull requests on GitHub only. Audit a GitLab or Codeberg repo with Mend instead.");
        return;
      }
      const key = refKey(ref);
      if (enrolled.some((e) => e.key === key)) {
        setSelected(key);
        return;
      }
      setAdding(key);
      try {
        const environmentId = await ensureEnvironment();
        // The grant is the whole credential story. It proves a person who can
        // push here authorized the work; it is not a GitHub token, and the
        // server checks both facts before issuing it.
        let vaultId: string | undefined;
        try {
          const { grant } = await client.requestGrant(ghAuth.token, `${ref.owner}/${ref.name}`);
          vaultId = await ensureVault(ref, grant);
        } catch (err) {
          say(err instanceof Error ? err.message : String(err));
          return;
        }
        if (!vaultId) return; // storing it failed, and it was said out loud
        const name = agentName(ref);
        const want = systemPrompt(ref, policy, window.location.origin);
        let agent = (await client.listAgents(name)).find((a) => a.name === name);
        if (agent) {
          if (agent.system !== want) agent = await client.updateAgent(agent.id, { system: want, description: agentDescription(ref) });
        } else {
          if (!catalogRef.current) catalogRef.current = await client.getCatalog().catch(() => null);
          const models = Object.values(catalogRef.current?.models ?? {}).flat();
          const model = models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models.find((m) => m.startsWith("anthropic/")) ?? DEFAULT_MODEL;
          agent = await client.createAgent({
            name,
            description: agentDescription(ref),
            model,
            runtime: "claude",
            system: want,
            ...(environmentId ? { environment_id: environmentId } : {}),
          });
        }
        await client.addTeammate({
          agent_id: agent.id,
          name,
          ...(environmentId ? { environment_id: environmentId } : {}),
          ...(vaultId ? { vault_id: vaultId } : {}),
        });
        await client.createSchedule(agent.id, {
          name: scheduleName(ref),
          cron,
          prompt: ROUND_PROMPT,
          enabled: true,
        });
        await refresh();
        setSelected(key);
        say(`Enrolled ${refLabel(ref)} — ${describeCron(cron).toLowerCase()}. Press Run now for the first round.`);
      } catch (err) {
        say(describeError(err));
      } finally {
        setAdding(null);
      }
    },
    [client, enrolled, ensureEnvironment, ensureVault, ghAuth, refresh, say],
  );

  const runNow = useCallback(
    async (e: Enrolled) => {
      if (!client || !e.schedule) return;
      setBusy(true);
      try {
        await client.runSchedule(e.teammate.agent_id, e.schedule.id);
        await Promise.all([refresh(), reloadThread()]);
        say("Round started.");
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) say("A round is already running for this repository.");
        else say(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [client, refresh, reloadThread, say],
  );

  const setEnabled = useCallback(
    async (e: Enrolled, enabled: boolean) => {
      if (!client || !e.schedule) return;
      try {
        await client.updateSchedule(e.teammate.agent_id, e.schedule.id, { enabled });
        await refresh();
      } catch (err) {
        say(describeError(err));
      }
    },
    [client, refresh, say],
  );

  const setCron = useCallback(
    async (e: Enrolled, cron: string) => {
      if (!client || !e.schedule) return;
      const bad = cronError(cron);
      if (bad) {
        say(bad);
        return;
      }
      try {
        await client.updateSchedule(e.teammate.agent_id, e.schedule.id, { cron });
        await refresh();
        say(`Now running ${describeCron(cron).toLowerCase()}.`);
      } catch (err) {
        say(describeError(err));
      }
    },
    [client, refresh, say],
  );

  /**
   * Change what a repository lets Rounds propose, after it is enrolled.
   *
   * The tier lives in the prompt — it is the only record of it — so changing
   * it is a rewrite of the same prompt with a different policy. It has to be
   * changeable from here now that the rail enrolls in one click: a click that
   * cannot be adjusted afterwards is a click nobody should make.
   *
   * The deployment it reports to is read back off the prompt it is carrying,
   * for the same reason the roster reconcile does it — changing the tier must
   * never repoint an agent at another server.
   */
  const setJudgment = useCallback(
    async (e: Enrolled, on: boolean) => {
      if (!client) return;
      const system = e.teammate.agent.system ?? "";
      const want = systemPrompt(e.ref, { includeNeedsReview: on }, apiBaseOfPrompt(system) ?? window.location.origin);
      try {
        await client.updateAgent(e.teammate.agent_id, { system: want, description: agentDescription(e.ref) });
        await refresh();
        say(
          on
            ? "Judgment calls are in scope from the next round — it will fix guidance findings too."
            : "Back to the mechanical fixes only from the next round.",
        );
      } catch (err) {
        say(describeError(err));
      }
    },
    [client, refresh, say],
  );

  const unenroll = useCallback(
    async (e: Enrolled) => {
      if (!client) return;
      if (!window.confirm(`Stop rounds for ${refLabel(e.ref)}? The schedule and the agent's computer go away. Pull requests it already opened stay open.`)) return;
      try {
        if (e.schedule) await client.deleteSchedule(e.teammate.agent_id, e.schedule.id).catch(() => undefined);
        await client.removeTeammate(e.teammate.agent_id);
        if (selected === e.key) setSelected(null);
        await refresh();
      } catch (err) {
        say(describeError(err));
      }
    },
    [client, refresh, selected, say],
  );

  const githubSignOut = useCallback(() => {
    clearGhAuth();
    setGhAuth(null);
    say("Signed out of GitHub. Repositories already enrolled keep the grant they were given.");
  }, [say]);

  // ── render ────────────────────────────────────────────────────────────────

  if (phase === "boot") return <div className="setup" />;
  // Nobody signed in yet: the pitch, or the form, depending on the route.
  //
  // A failed sign-in lands back here with no hash — the OAuth redirect URI is
  // origin + path — so an error is also a reason to show the form. Otherwise
  // the one page that could explain what went wrong is the one page that
  // never appears.
  if (phase === "connect" || !settings || !client)
    return isSignInRoute(hash) || connectError !== null ? (
      <SignIn
        error={connectError}
        onPaste={(s) => {
          saveSettings(s);
          setConnectError(null);
          setSettings(s);
          // The route has done its job; leaving it set would send a reload
          // back to a form nobody needs any more.
          window.history.replaceState({}, "", window.location.pathname + window.location.search);
          setHash("");
        }}
      />
    ) : (
      <Landing />
    );

  const pending = adding && !enrolled.some((e) => e.key === adding) ? adding : null;

  return (
    <div className="app">
      <aside className="rail">
        <div className="wordmark small">
          Rounds<span>.</span>
        </div>
        <nav className="repolist">
          {enrolled.length > 0 && <span className="railhead">Enrolled</span>}
          {enrolled.map((e) => (
            <button key={e.key} className={e.key === selected ? "repobtn active" : "repobtn"} onClick={() => setSelected(e.key)}>
              <code>{refLabel(e.ref)}</code>
              <span className="repostate">
                {e.schedule && !e.schedule.enabled && <i className="paused">paused</i>}
                {e.schedule?.last_error && <i className="unread" title={e.schedule.last_error} />}
              </span>
            </button>
          ))}
          {pending && (
            <div className="repobtn pending">
              <code>{pending}</code>
              <span className="repostate">enrolling…</span>
            </div>
          )}
          {team !== null && enrolled.length === 0 && !pending && <p className="fineprint">Nothing enrolled yet.</p>}

          {/* The other half of the rail: what the App can reach and nobody has
              decided about yet. Enroll it, or wave it away. */}
          <RepoPicker
            repos={repos}
            enrolledKeys={enrolledKeys}
            skipped={skippedSet}
            busy={adding}
            ready={ghAuth !== null && installed === true}
            loading={reposLoading}
            cron={railCron}
            onCron={(c) => {
              setRailCron(c);
              saveCadence(c);
            }}
            onEnroll={(slug, cron) => void enroll(slug, cron, DEFAULT_POLICY)}
            onSkip={skipRepo}
            onUnskip={unskipRepo}
          />
        </nav>
        <div className="rail-foot">
          <span className={connected ? "dot on" : "dot"} title={connected ? "live" : "reconnecting"} />
          <button className="linkish" onClick={signOut}>
            sign out
          </button>
          <p className="fineprint">
            The audit is <a href="https://intentius.io/chant/cli/audit/">chant</a>. The cron and the computer are{" "}
            <a href="https://github.com/BinaryBourbon/fountain">Fountain</a>.{" "}
            <a href="https://github.com/managoat/rounds">Source</a>.
          </p>
        </div>
      </aside>

      <main className="main">
        {toast && <div className="toast">{toast}</div>}
        {current ? (
          <>
            <header className="repo-head">
              <a href={repoUrl(current.ref)} target="_blank" rel="noreferrer">
                <code>{refLabel(current.ref)}</code>
              </a>
              {current.schedule ? (
                <span className="fineprint">
                  <CadenceField cron={current.schedule.cron} onChange={(c) => void setCron(current, c)} />
                  {current.schedule.enabled
                    ? ` · next ${relativeTime(current.schedule.next_run_at)}`
                    : " · paused"}
                  {current.schedule.last_run_at && ` · last ran ${relativeTime(current.schedule.last_run_at)}`}
                </span>
              ) : (
                <span className="fineprint">no schedule — this repo will not run on its own</span>
              )}
              {current.teammate.conversation.vault_id && (
                <span className="private" title={`Its grant lives in ${vaultName(current.ref)} — read-only, this repository only`}>
                  own grant · read-only
                </span>
              )}
              <div className="head-actions">
                <button disabled={busy || running || !current.schedule} onClick={() => void runNow(current)}>
                  {running ? "Running…" : "Run now"}
                </button>
                {current.schedule && (
                  <button onClick={() => void setEnabled(current, !current.schedule!.enabled)}>
                    {current.schedule.enabled ? "Pause" : "Resume"}
                  </button>
                )}
                <button className="linkish" onClick={() => void unenroll(current)}>
                  remove
                </button>
              </div>
            </header>

            <div className="scroll">
              <InstallGate
                appInfo={appInfo}
                auth={ghAuth}
                installed={installed}
                checking={checkingInstall}
                onSignIn={() => beginGithubLogin(appInfo!.clientId!)}
                onSignOut={githubSignOut}
                onRecheck={() => void checkInstall()}
              />
              {current.schedule?.last_error && (
                <div className="status-card failed">
                  <p>Last scheduled run failed: {current.schedule.last_error}</p>
                </div>
              )}
              {/* The cadence is in the header now, where it was already
                  written down. What is left here is the other thing the rail
                  enrolls with a default for. */}
              <div className="settings">
                <TierToggle
                  on={policyOfPrompt(current.teammate.agent.system).includeNeedsReview}
                  onChange={(v) => void setJudgment(current, v)}
                />
              </div>
              <RoundView entries={rounds} repo={current.ref} running={running} />
            </div>
          </>
        ) : (
          <div className="hero">
            <div className="hero-card">
              <h1>
                Your infrastructure config, kept up to standard — on a <b>schedule</b>.
              </h1>
              <p>
                <a href="https://intentius.io/chant/cli/audit/">chant</a> audits the repositories you enroll — CI
                workflows, Kubernetes manifests, Dockerfiles, Helm charts, cloud templates — and a pull request goes up
                for what Rounds can fix and verify. One PR per file, never a second for something you already have
                open, and never again for one you closed.
              </p>
              <p className="fineprint">
                It runs whether or not this page is open. You meet the work on GitHub.
              </p>
              <InstallGate
                appInfo={appInfo}
                auth={ghAuth}
                installed={installed}
                checking={checkingInstall}
                onSignIn={() => beginGithubLogin(appInfo!.clientId!)}
                onSignOut={githubSignOut}
                onRecheck={() => void checkInstall()}
              />
              {repos.length > 0 ? (
                <p className="fineprint">
                  Everything the App can reach is listed on the left — enroll one from there, or install the App on
                  more repositories to widen the list.
                </p>
              ) : (
                <EnrollForm big disabled={adding !== null} ready={installed === true} onEnroll={(v, c, p) => void enroll(v, c, p)} />
              )}
              {pending && (
                <p className="fineprint">
                  Enrolling <code>{pending}</code>…
                </p>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}


function EnrollForm(props: {
  onEnroll: (repo: string, cron: string, policy: RoundsPolicy) => void;
  disabled: boolean;
  /** Signed in, App installed. Without it there is nothing to enroll with. */
  ready: boolean;
  big?: boolean;
}) {
  const [value, setValue] = useState("");
  const [cron, setCron] = useState(DEFAULT_CRON);
  const [judgment, setJudgment] = useState(DEFAULT_POLICY.includeNeedsReview);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    props.onEnroll(value.trim(), cron, { ...DEFAULT_POLICY, includeNeedsReview: judgment });
    setValue("");
  };
  const blocked = props.disabled || !props.ready;
  return (
    <form className={props.big ? "enroll big" : "enroll"} onSubmit={submit}>
      <div className="enroll-row">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="owner/name — a GitHub repo you can push to"
          disabled={blocked}
          aria-label="repository"
        />
        <select value={cron} onChange={(e) => setCron(e.target.value)} aria-label="cadence" disabled={blocked}>
          {CRON_PRESETS.map((p) => (
            <option key={p.cron} value={p.cron}>
              {p.label}
            </option>
          ))}
        </select>
        <button type="submit" className="primary" disabled={blocked || !value.trim()}>
          {props.disabled ? "…" : "Enroll"}
        </button>
      </div>
      <label className="judgment">
        <input type="checkbox" checked={judgment} onChange={(e) => setJudgment(e.target.checked)} disabled={blocked} />
        <span>
          Propose the judgment calls too — the guidance findings, where the fix depends on what you meant. The
          valuable half, and the half worth reading before you merge.
        </span>
      </label>
      <p className="fineprint">
        The repository has to be one the App is installed on, and one you can push to — the server checks both before it
        will enroll it.
      </p>
    </form>
  );
}

/**
 * The cadence, edited where it is already stated.
 *
 * It used to be a labelled picker further down the page, under the install
 * gate, while the header said the same thing in words a foot above it. Two
 * places for one fact, and the one you read was not the one you could change.
 * So the sentence is the control: click it and it becomes a select, with the
 * cron field behind "Custom…" for anybody who wants a schedule the presets do
 * not cover.
 */
function CadenceField(props: { cron: string; onChange: (cron: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.cron);
  const [custom, setCustom] = useState(false);

  if (!editing) {
    return (
      <button
        className="editable"
        title="Change when it runs"
        onClick={() => {
          setDraft(props.cron);
          setCustom(!CRON_PRESETS.some((p) => p.cron === props.cron));
          setEditing(true);
        }}
      >
        {describeCron(props.cron)}
      </button>
    );
  }

  const bad = cronError(draft);
  return (
    <span className="cadence-edit">
      <select
        value={custom ? "custom" : draft}
        aria-label="cadence"
        onChange={(e) => {
          if (e.target.value === "custom") {
            setCustom(true);
          } else {
            setCustom(false);
            setDraft(e.target.value);
          }
        }}
      >
        {CRON_PRESETS.map((preset) => (
          <option key={preset.cron} value={preset.cron}>
            {preset.label}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      {custom && (
        <input value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="cron expression" className="cronin" />
      )}
      <button
        className="primary tiny"
        disabled={!!bad || draft === props.cron}
        onClick={() => {
          props.onChange(draft);
          setEditing(false);
        }}
      >
        Set
      </button>
      <button className="linkish" onClick={() => setEditing(false)}>
        cancel
      </button>
      {custom && <span className={bad ? "error" : "fineprint"}>{bad ?? describeCron(draft)}</span>}
    </span>
  );
}

/**
 * The judgment calls, on or off, after enrollment.
 *
 * They are on by default: the findings where the fix depends on what you meant
 * are the valuable half, and a bot that fixes only the mechanical ones is
 * quiet about everything that mattered. Off is still one click, because a
 * repository where nobody has time to review them is a real repository.
 *
 * The hygiene tier is deliberately not here. It is the one nobody wants
 * unprompted, so it is reachable only from the audited repository's own
 * `.rounds.yml`.
 */
function TierToggle(props: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="tier" title="guidance findings: worth a pull request, but the fix depends on what you meant">
      <input type="checkbox" checked={props.on} onChange={(e) => props.onChange(e.target.checked)} />
      <span>Propose the judgment calls</span>
    </label>
  );
}

