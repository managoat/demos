import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, FountainClient, describeError } from "./api/client";
import type { CommsStatus, Conversation, LogEvent, Schedule, SearchHit, TeamEvent, Teammate, Turn } from "./api/types";
import { clearSettings, loadSettings, saveSettings, type Settings } from "./lib/settings";
import { SettingsScreen } from "./components/Settings";
import { completeLoginIfCallback, revoke } from "./lib/oauth";
import { Roster, type RowAction } from "./components/Roster";
import { Thread } from "./components/Thread";
import { AddDialog } from "./components/AddDialog";
import { addInstantTeammate } from "./lib/instant";
import { Routines } from "./components/Routines";
import { Palette, type PaletteChoice } from "./components/Palette";
import { teamManifest } from "./lib/manifest";
import { forgetPerson, identifyPerson } from "./lib/analytics";
import { Onboarding } from "./components/Onboarding";
import { Shortcuts } from "./components/Shortcuts";
import { History } from "./components/History";
import { Runners } from "./components/Runners";
import { ReportDialog } from "./components/ReportDialog";
import { ContactDialog } from "./components/ContactDialog";
import { contactOffer } from "./lib/contact";
import { buildReportContext } from "./lib/report";
import { releaseImages, type OutgoingImage } from "./lib/images";
import { notifyPermission, requestNotifyPermission, shouldNotify, showReplyNotification, showRequestNotification, type NotifyPermission } from "./lib/notify";
import { askFrom, openAsk, resolutionFrom, type PermissionAsk } from "./lib/permissions";
import { loadPrefs, savePrefs, sortPinnedFirst, toggleIn, without, type Prefs } from "./lib/prefs";
import { drain, enqueue, newQueuedId, removeQueued, withoutConversation, type QueuedMessage } from "./lib/queue";
import { loadTranscriptBase, transcriptUrl } from "./lib/transcript";
import { LIVE_STATUSES, groupSideThreads, nextThreadTitle, threadOfKey } from "./lib/threads";

const THREAD_STREAMS = ["acp", "stdout", "stage"];

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(() => loadSettings());
  const [editingSettings, setEditingSettings] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState(() => /[?&](code|error)=/.test(window.location.search));
  const [oauthError, setOauthError] = useState<string | null>(null);

  // Finish an in-progress "Sign in with Fountain" before rendering anything.
  useEffect(() => {
    completeLoginIfCallback()
      .then(async (result) => {
        if (!result) return;
        const s: Settings = { baseUrl: result.baseUrl, apiKey: result.apiKey, via: "oauth" };
        try {
          const me = await new FountainClient(s).me();
          saveSettings(s);
          setSettings(s);
          setEmail(me.email);
          // The Fountain user id, which is the distinct id the server captures
          // under — this is what files a recording under the right account.
          identifyPerson(me.id);
        } catch {
          setOauthError("Signed in, but that Fountain could not be reached.");
        }
      })
      .catch((err) => setOauthError(err instanceof Error ? err.message : String(err)))
      .finally(() => setOauthBusy(false));
  }, []);

  if (oauthBusy) {
    return (
      <div className="settings">
        <div className="settings-card">
          <h1>Signing in…</h1>
        </div>
      </div>
    );
  }

  if (!settings || editingSettings) {
    return (
      <SettingsScreen
        initial={settings}
        error={oauthError}
        onCancel={settings ? () => setEditingSettings(false) : undefined}
        onConnected={(s, who) => {
          saveSettings(s);
          setSettings(s);
          setEmail(who);
          setEditingSettings(false);
          setOauthError(null);
        }}
      />
    );
  }
  return (
    <Team
      key={settings.baseUrl + settings.apiKey}
      settings={settings}
      email={email}
      onSettings={() => setEditingSettings(true)}
      onSignOut={() => {
        if (settings.via === "oauth") void revoke(settings.baseUrl, settings.apiKey);
        clearSettings();
        // Or the next person to use this browser is recorded as the last one.
        forgetPerson();
        setSettings(null);
      }}
    />
  );
}

function Team({ settings, onSettings, onSignOut }: { settings: Settings; email: string | null; onSettings: () => void; onSignOut: () => void }) {
  const client = useMemo(() => new FountainClient(settings), [settings]);
  const [team, setTeam] = useState<Teammate[]>([]);
  // false until the first roster fetch settles: nothing that means "empty"
  // may render before we know, or every refresh flashes the onboarding card
  const [teamLoaded, setTeamLoaded] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => idFromHash());
  /** a side thread of the selected teammate (a conversation id), or null for the main thread */
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(() => threadFromHash());
  /** every teammate's side threads — more conversations on the same computer — by agent id */
  const [threads, setThreads] = useState<ReadonlyMap<string, readonly Conversation[]>>(() => new Map());
  const [page, setPage] = useState<"team" | "routines" | "runners">(() => pageFromHash());
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  /** a row-menu "Customize…" for the selected teammate, consumed by Thread */
  const [customizeRequested, setCustomizeRequested] = useState(false);
  const onCustomizeOpened = useCallback(() => setCustomizeRequested(false), []);
  const [renaming, setRenaming] = useState(false);
  const [teamVersion, setTeamVersion] = useState(0);
  const [routinesFor, setRoutinesFor] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** the report dialog: about a teammate (agent id) or the page (null); undefined = closed */
  const [reporting, setReporting] = useState<string | null | undefined>(undefined);
  /** may this account give teammates an email + phone, and can this instance; null until asked (or on a server without it) */
  const [comms, setComms] = useState<CommsStatus | null>(null);
  /** the "Give email & phone" / "Change number" dialog, for this agent id */
  const [contactFor, setContactFor] = useState<{ agentId: string; mode: "give" | "change" } | null>(null);
  const [focusTurnId, setFocusTurnId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const eventsRef = useRef<LogEvent[]>([]);
  eventsRef.current = events;
  // Conversations with a permission request open, by conversation id. Learned
  // from the `request` stage events on the team stream, so it covers rows the
  // thread is not showing — the whole point of a "waiting on you" roster
  // treatment. It only knows about asks that arrived while this page was up;
  // the open thread is covered separately, from its own loaded events.
  const [openAsks, setOpenAsks] = useState<ReadonlyMap<string, PermissionAsk>>(() => new Map());
  const [threadLoading, setThreadLoading] = useState(false);
  const [loadedConvId, setLoadedConvId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [instantBusy, setInstantBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs());
  const [notifyPerm, setNotifyPerm] = useState<NotifyPermission>(() => notifyPermission());
  // Messages waiting for a busy teammate, keyed by agent id (a teammate's
  // conversation can be replaced under them; the queue follows the person).
  const [queues, setQueues] = useState<ReadonlyMap<string, readonly QueuedMessage[]>>(() => new Map());

  const selected = team.find((t) => t.agent_id === selectedId) ?? null;
  const selectedThread = (selected && selectedThreadId && threads.get(selected.agent_id)?.find((c) => c.id === selectedThreadId)) || null;
  const selectedConvId = selectedThread?.id ?? selected?.conversation.id ?? null;
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const selectedConvRef = useRef<string | null>(null);
  selectedConvRef.current = selectedConvId;
  const teamRef = useRef<Teammate[]>([]);
  teamRef.current = team;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const queuesRef = useRef(queues);
  queuesRef.current = queues;

  const updatePrefs = useCallback((f: (p: Prefs) => Prefs) => {
    setPrefs((p) => {
      const next = f(p);
      savePrefs(next);
      return next;
    });
  }, []);

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 5000);
  }, []);

  // ── roster ────────────────────────────────────────────────────────────────

  const refreshTeam = useCallback(async () => {
    try {
      // The roster, and — from the account's live conversations — each
      // teammate's side threads. An older server without the filter just
      // means no threads, not no roster.
      const [list, live] = await Promise.all([
        client.listTeam(),
        client.listConversations({ status: [...LIVE_STATUSES] }).catch(() => null),
      ]);
      setTeam(list);
      if (live) setThreads(groupSideThreads(live, list));
      setTeamError(null);
      return list;
    } catch (err) {
      setTeamError(describeError(err));
      return null;
    } finally {
      setTeamLoaded(true);
    }
  }, [client]);

  useEffect(() => {
    void refreshTeam();
  }, [refreshTeam]);

  // Once per sign-in: where this Fountain keeps its conversations app, so a
  // "full transcript" link goes straight there rather than through a redirect
  // that wants a browser session this reader may not have.
  useEffect(() => {
    void loadTranscriptBase(client);
  }, [client]);

  // Once per sign-in: whether teammates can be given an email + phone here. An
  // older server 404s the route; that just means "no".
  useEffect(() => {
    let cancelled = false;
    client
      .commsStatus()
      .then((c) => !cancelled && setComms(c))
      .catch(() => !cancelled && setComms(null));
    return () => {
      cancelled = true;
    };
  }, [client]);

  // A debounced refresh for stage events, which arrive in bursts.
  const refreshTimer = useRef<number | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refreshTeam();
    }, 250);
  }, [refreshTeam]);

  // ── selection & thread ────────────────────────────────────────────────────

  useEffect(() => {
    const onHash = () => {
      setSelectedId(idFromHash());
      setSelectedThreadId(threadFromHash());
      setPage(pageFromHash());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const select = useCallback(
    (agentId: string | null, threadId: string | null = null) => {
      window.location.hash = agentId ? (threadId ? `#/team/${agentId}/${threadId}` : `#/team/${agentId}`) : "";
      setPage("team");
      setSelectedId(agentId);
      setSelectedThreadId(agentId ? threadId : null);
      setRenaming(false);
      if (agentId && prefsRef.current.unread.includes(agentId)) {
        updatePrefs((p) => ({ ...p, unread: without(p.unread, agentId) }));
      }
    },
    [updatePrefs],
  );

  useEffect(() => {
    if (!selectedConvId) {
      setTurns([]);
      setEvents([]);
      return;
    }
    let cancelled = false;
    setThreadLoading(true);
    Promise.all([client.listTurns(selectedConvId), client.listAllEvents(selectedConvId, THREAD_STREAMS)])
      .then(([t, e]) => {
        if (cancelled) return;
        setTurns(t);
        setEvents(e);
        setLoadedConvId(selectedConvId);
      })
      .catch((err) => !cancelled && toast(describeError(err), "error"))
      .finally(() => !cancelled && setThreadLoading(false));
    client
      .markRead(selectedConvId)
      .then(() => {
        setTeam((ts) => ts.map((t) => (t.conversation.id === selectedConvId ? { ...t, unread: false } : t)));
        setThreads((m) => markThreadRead(m, selectedConvId));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, selectedConvId, toast]);

  // A hash naming a thread that is gone (closed in another tab): fall back to the main one.
  useEffect(() => {
    if (!selected || !selectedThreadId || selectedThread || !threads.size) return;
    if (!threads.get(selected.agent_id)) return; // not listed yet, or none: wait for a refresh
    select(selected.agent_id);
  }, [selected, selectedThreadId, selectedThread, threads, select]);

  // Which conversations are waiting on an answer. The live map covers rows the
  // thread is not showing; the open thread is re-derived from its own events,
  // which are loaded in full — so a reload with the card on screen still shows
  // the row as waiting, where the live map alone would have forgotten.
  const selectedAsk = useMemo(() => (loadedConvId === selectedConvId ? openAsk(events) : null), [events, loadedConvId, selectedConvId]);
  const waitingConvIds = useMemo(() => {
    const ids = new Set(openAsks.keys());
    if (selectedConvId && loadedConvId === selectedConvId) {
      if (selectedAsk) ids.add(selectedConvId);
      else ids.delete(selectedConvId);
    }
    return ids;
  }, [openAsks, selectedAsk, selectedConvId, loadedConvId]);

  // On a phone, the thread has no room for the roster: only one shows.
  const unreadCount = team.filter(
    (t) => (t.agent_id !== selectedId && (t.unread || prefs.unread.includes(t.agent_id))) || threads.get(t.agent_id)?.some((c) => c.unread && c.id !== selectedConvId),
  ).length;
  useEffect(() => {
    const base = selected ? `${selected.name} · Team` : "Team";
    document.title = unreadCount > 0 ? `(${unreadCount}) ${base}` : base;
  }, [selected, unreadCount]);

  // ── queue-and-steer ───────────────────────────────────────────────────────

  const flushing = useRef(new Set<string>());

  /**
   * Send everything queued under `key` as one turn, now that it is free. The
   * key is a teammate's agent id (the main thread) or a side thread's
   * conversation id.
   */
  const flush = useCallback(
    async (key: string) => {
      const d = drain(queuesRef.current, key);
      if (!d || flushing.current.has(key)) return;
      flushing.current.add(key);
      try {
        const side = threadOfKey(threadsRef.current, key);
        if (side) {
          await client.prompt(key, d.prompt, d.images);
          setQueues((q) => withoutConversation(q, key));
          releaseImages(d.images);
          void refreshTeam();
        } else {
          const before = teamRef.current.find((t) => t.agent_id === key)?.conversation.id;
          const r = await client.sendMessage(key, d.prompt, d.images);
          setQueues((q) => withoutConversation(q, key));
          releaseImages(d.images);
          if (r.conversation_id !== before) await refreshTeam();
        }
      } catch (err) {
        // still busy (a new turn started first, or the computer runs one turn
        // at a time and another thread has it) — keep it; the next turn end retries.
        if (err instanceof ApiError && (err.code === "conversation_busy" || err.status === 409 || err.status === 503)) return;
        toast(describeError(err), "error");
      } finally {
        flushing.current.delete(key);
      }
    },
    [client, refreshTeam, toast],
  );

  /** Every queue of a teammate — its main thread and each side thread — since a turn ending on any of them may free the computer. */
  const flushAll = useCallback(
    (agentId: string) => {
      void flush(agentId);
      for (const c of threadsRef.current.get(agentId) ?? []) void flush(c.id);
    },
    [flush],
  );

  // Provisioning makes no event this stream delivers for a conversation it
  // only just started following, so a teammate whose computer is starting
  // (or whose machine is off, or whose queue waits on either) is polled
  // until the roster says otherwise.
  useEffect(() => {
    const waiting = team.some(
      (t) =>
        (t.presence.state === "starting" && t.conversation.sandbox?.status !== "ready") ||
        (queues.get(t.agent_id)?.length && t.presence.state !== "working" && t.conversation.status !== "running"),
    );
    // A side thread mid-turn that is not the open one has no stream here; its
    // tab and queue follow the list instead.
    const sideBusy = [...threads.values()].some((list) => list.some((c) => c.id !== selectedConvId && (c.status === "running" || queues.get(c.id)?.length)));
    if (!waiting && !sideBusy) return;
    const id = window.setInterval(() => void refreshTeam(), 4000);
    return () => window.clearInterval(id);
  }, [team, threads, queues, selectedConvId, refreshTeam]);

  // A safety net for the event path: after any roster refresh, a free
  // teammate with a queue gets it (a reconnect can miss the turn-end event).
  useEffect(() => {
    for (const t of team) {
      if (!queues.get(t.agent_id)?.length) continue;
      // "starting" and "machine_offline" are not reasons to hold back: the
      // server answers 503 if it really cannot take the turn yet, and the
      // queue keeps it; a stale "starting" must not be the thing blocking.
      const busy = t.presence.state === "working" || t.conversation.status === "running";
      if (!busy) void flush(t.agent_id);
    }
    for (const list of threads.values()) {
      for (const c of list) if (queues.get(c.id)?.length && c.status !== "running") void flush(c.id);
    }
  }, [team, threads, queues, flush]);

  const notifyReply = useCallback(
    (agentId: string, conversationId: string) => {
      const p = prefsRef.current;
      if (
        !shouldNotify({
          enabled: p.notify,
          permission: notifyPermission(),
          muted: p.muted.includes(agentId),
          isOpen: conversationId === selectedConvRef.current,
          hidden: document.hidden,
        })
      )
        return;
      const t = teamRef.current.find((x) => x.agent_id === agentId);
      const side = threadOfKey(threadsRef.current, conversationId);
      showReplyNotification({
        name: t?.name ?? "Teammate",
        body: !side && t?.preview?.kind === "them" && t.preview.text ? t.preview.text : "replied",
        conversationId,
        onClick: () => select(agentId, side ? conversationId : null),
      });
    },
    [select],
  );

  /**
   * A teammate is blocked on a permission request. Notified like a reply, and
   * for the same reason: it is news you cannot see if you are not looking at
   * that thread — except that here nothing moves until you answer, and the
   * server denies it if nobody does.
   */
  const notifyAsk = useCallback(
    (conversationId: string, ask: PermissionAsk) => {
      const side = threadOfKey(threadsRef.current, conversationId);
      const t = teamRef.current.find((x) => x.conversation.id === conversationId || x.agent_id === side?.agentId);
      const p = prefsRef.current;
      if (
        !shouldNotify({
          enabled: p.notify,
          permission: notifyPermission(),
          muted: t ? p.muted.includes(t.agent_id) : false,
          isOpen: conversationId === selectedConvRef.current,
          hidden: document.hidden,
        })
      )
        return;
      showRequestNotification({
        name: t?.name ?? "Teammate",
        tool: ask.tool,
        conversationId,
        onClick: () => t && select(t.agent_id, side ? conversationId : null),
      });
    },
    [select],
  );

  const refreshSchedules = useCallback(async () => {
    try {
      setSchedules(await client.listSchedules());
    } catch (err) {
      toast(describeError(err), "error");
    }
  }, [client, toast]);

  // ── the streams ───────────────────────────────────────────────────────────

  /** One event about one conversation, from the team stream or a side thread's own. */
  const handleEvent = useCallback(
    (ev: TeamEvent) => {
      const isSelected = ev.conversation_id === selectedConvRef.current;
      if (isSelected) {
        setEvents((es) => (es.some((e) => e.id === ev.id) ? es : [...es, ev]));
        if (ev.kind === "stage" && ev.stage === "turn") {
          if (ev.state === "started") {
            client.listTurns(ev.conversation_id).then(setTurns).catch(() => undefined);
          } else {
            client.listTurns(ev.conversation_id).then(setTurns).catch(() => undefined);
            client.markRead(ev.conversation_id).catch(() => undefined);
          }
        }
      }
      // A permission request, on any row — including one the thread is not
      // showing. Tracked here rather than in Thread because the roster has to
      // say "waiting on you" for a teammate you are not looking at.
      if (ev.kind === "stage" && ev.stage === "request") {
        const ask = askFrom(ev);
        if (ask) {
          setOpenAsks((m) => new Map(m).set(ev.conversation_id, ask));
          notifyAsk(ev.conversation_id, ask);
        } else if (resolutionFrom(ev)) {
          setOpenAsks((m) => {
            if (!m.has(ev.conversation_id)) return m;
            const next = new Map(m);
            next.delete(ev.conversation_id);
            return next;
          });
        }
      }
      // A request cannot outlive its turn — the server resolves whatever is
      // held before the peer goes away. Clearing on the turn's end too means a
      // `done` this client was offline for cannot strand a row on "waiting on
      // you" until the next reload.
      if (ev.kind === "stage" && ev.stage === "turn" && ev.state !== "started") {
        setOpenAsks((m) => {
          if (!m.has(ev.conversation_id)) return m;
          const next = new Map(m);
          next.delete(ev.conversation_id);
          return next;
        });
      }
      if (ev.kind === "stage") {
        if (ev.stage === "turn" && ev.state !== "started" && ev.agent_id) {
          const agentId = ev.agent_id;
          // Re-list first so the preview carries the reply, then notify and drain.
          void refreshTeam().then(() => {
            notifyReply(agentId, ev.conversation_id);
            flushAll(agentId);
          });
        } else {
          scheduleRefresh();
        }
      } else if (ev.kind === "output") {
        // Someone else's row: bump it and show "typing…" without a query.
        setTeam((ts) =>
          ts
            .map((t): Teammate =>
              t.conversation.id === ev.conversation_id
                ? {
                    ...t,
                    conversation: { ...t.conversation, last_active_at: ev.ts },
                    preview: { kind: "typing", text: null },
                    unread: t.conversation.id !== selectedConvRef.current,
                  }
                : t,
            )
            .sort(byActivity),
        );
      }
    },
    [client, refreshTeam, scheduleRefresh, flushAll, notifyReply, notifyAsk],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    let lastEventId: string | null = null;
    let backoff = 1000;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      void client.streamTeam({
        lastEventId,
        streams: THREAD_STREAMS,
        signal: ctrl.signal,
        onOpen: () => {
          setConnected(true);
          backoff = 1000;
          // Anything the roster missed while we were away.
          void refreshTeam();
        },
        onMessage: (msg) => {
          if (msg.id) lastEventId = msg.id;
          if (msg.event === "team") {
            void refreshTeam();
            setTeamVersion((v) => v + 1);
            return;
          }
          if (msg.event === "schedule") {
            setSchedules((cur) => {
              if (cur !== null) void refreshSchedules();
              return cur;
            });
            return;
          }
          let ev: TeamEvent;
          try {
            ev = JSON.parse(msg.data) as TeamEvent;
          } catch {
            return;
          }
          if (msg.id) ev.id = Number(msg.id);
          handleEvent(ev);
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
  }, [client, refreshTeam, refreshSchedules, handleEvent]);

  // The open side thread's own stream: the team stream follows one
  // conversation per teammate, and this is not it. Opened once the thread's
  // history is loaded, from its last event, so nothing replays twice.
  const sideStreamFrom = selectedThread && loadedConvId === selectedThread.id ? selectedThread.id : null;
  const agentOfSide = selectedThread ? selectedId : null;
  useEffect(() => {
    if (!sideStreamFrom || !agentOfSide) return;
    const convId = sideStreamFrom;
    const agentId = agentOfSide;
    const ctrl = new AbortController();
    let lastEventId: string | null = String(eventsRef.current.reduce((m, e) => Math.max(m, e.id), 0));
    let backoff = 1000;
    let stopped = false;
    const connect = () => {
      if (stopped) return;
      void client.streamConversation(convId, {
        lastEventId,
        streams: THREAD_STREAMS,
        signal: ctrl.signal,
        onOpen: () => {
          backoff = 1000;
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
          handleEvent({ ...ev, conversation_id: convId, agent_id: agentId });
        },
        onClose: () => {
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
  }, [client, sideStreamFrom, agentOfSide, handleEvent]);

  // ── routines ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (page === "routines" && schedules === null) void refreshSchedules();
  }, [page, schedules, refreshSchedules]);

  const openRoutines = useCallback((forAgentId: string | null = null) => {
    setRoutinesFor(forAgentId);
    window.location.hash = "#/routines";
    setPage("routines");
  }, []);

  const openRunners = useCallback(() => {
    window.location.hash = "#/runners";
    setPage("runners");
  }, []);

  // ── palette (⌘K) ──────────────────────────────────────────────────────────

  const orderedTeamRef = useRef<Teammate[]>([]);
  useEffect(() => {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        const rows = orderedTeamRef.current;
        if (!rows.length) return;
        e.preventDefault();
        const cur = rows.findIndex((t) => t.agent_id === selectedRef.current);
        const next = e.key === "ArrowDown" ? Math.min(cur + 1, rows.length - 1) : Math.max(cur - 1, 0);
        if (next !== cur || cur === -1) select(rows[next === -1 ? 0 : next]!.agent_id);
        return;
      }
      if (e.key === "?" && !typing(e) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select]);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const exportTeam = useCallback(async () => {
    if (!team.length) {
      toast("Nothing to export — the team is empty");
      return;
    }
    try {
      const [agents, envs] = await Promise.all([Promise.all(team.map((t) => client.getAgent(t.agent_id))), client.listEnvironments()]);
      const yaml = teamManifest(
        team.map((t, i) => ({ name: t.name, agent: agents[i]! })),
        envs,
        new Date().toISOString(),
      );
      const blob = new Blob([yaml], { type: "application/yaml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "team.yml";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast(`Exported ${team.length} teammate${team.length === 1 ? "" : "s"} — apply with fountain apply -f team.yml`);
    } catch (err) {
      toast(describeError(err), "error");
    }
  }, [client, team, toast]);

  const openHit = useCallback(
    (hit: SearchHit) => {
      const t = teamRef.current.find((x) => x.conversation.id === hit.conversation_id);
      if (t) {
        select(t.agent_id);
        setFocusTurnId(hit.turn_id);
        return;
      }
      const side = threadOfKey(threadsRef.current, hit.conversation_id);
      if (side) {
        select(side.agentId, hit.conversation_id);
        setFocusTurnId(hit.turn_id);
        return;
      }
      // An older conversation of a teammate, or one outside the team: Fountain shows it.
      window.open(transcriptUrl(client.baseUrl, hit.conversation_id), "_blank", "noopener");
    },
    [client.baseUrl, select],
  );

  const onPaletteChoice = useCallback(
    (choice: PaletteChoice) => {
      setPaletteOpen(false);
      switch (choice.kind) {
        case "teammate":
          select(choice.agentId);
          break;
        case "hit":
          openHit(choice.hit);
          break;
        case "routines":
          openRoutines();
          break;
        case "runners":
          openRunners();
          break;
        case "export":
          void exportTeam();
          break;
      }
    },
    [select, openHit, openRoutines, openRunners, exportTeam],
  );

  const renameTeammate = useCallback(
    async (agentId: string, name: string | null) => {
      const before = teamRef.current.find((t) => t.agent_id === agentId);
      if (!before) return;
      const optimistic = name ?? before.agent.name;
      setTeam((ts) => ts.map((t) => (t.agent_id === agentId ? { ...t, name: optimistic } : t)));
      try {
        const updated = await client.renameTeammate(agentId, name);
        setTeam((ts) => ts.map((t) => (t.agent_id === agentId ? { ...t, name: updated.name } : t)));
      } catch (err) {
        setTeam((ts) => ts.map((t) => (t.agent_id === agentId ? { ...t, name: before.name } : t)));
        toast(describeError(err), "error");
      }
    },
    [client, toast],
  );

  /** "+": a teammate right now — random name, default brain, avatar to follow. */
  const addInstant = useCallback(async () => {
    if (instantBusy) return;
    setInstantBusy(true);
    try {
      const { agentId, name } = await addInstantTeammate(client, { onAvatar: () => void refreshTeam() });
      await refreshTeam();
      select(agentId);
      toast(`${name} joined — rename them from the header; brain and "what they do" are in their profile`);
    } catch (err) {
      toast(describeError(err), "error");
    } finally {
      setInstantBusy(false);
    }
  }, [client, instantBusy, refreshTeam, select, toast]);

  // ── actions ───────────────────────────────────────────────────────────────

  const onSend = useCallback(
    async (text: string, images: OutgoingImage[]): Promise<"sent" | "queued"> => {
      if (!selected) throw new Error("no teammate selected");
      const agentId = selected.agent_id;
      const key = selectedThread?.id ?? agentId;
      const queue = () => {
        setQueues((q) => enqueue(q, key, { id: newQueuedId(), text, images, at: new Date().toISOString() }));
        return "queued" as const;
      };
      if (selectedThread) {
        if (selectedThread.status === "running" || queues.get(key)?.length) return queue();
        try {
          await client.prompt(selectedThread.id, text, images);
          releaseImages(images);
          void refreshTeam();
          return "sent";
        } catch (err) {
          // Busy after all — or the computer runs one turn at a time and another thread has it (409).
          if (err instanceof ApiError && (err.code === "conversation_busy" || err.status === 409 || err.status === 503)) {
            void refreshTeam();
            return queue();
          }
          toast(describeError(err), "error");
          throw err;
        }
      }
      // Only a turn in flight is a reason not to try: "starting" and
      // "machine offline" are the server's call (503 → queued, below), and
      // the roster's idea of them can be stale.
      const busy = selected.presence.state === "working" || selected.conversation.status === "running";
      // Anything already queued goes first, so a new note joins the line.
      if (busy || queues.get(agentId)?.length) return queue();
      try {
        const r = await client.sendMessage(agentId, text, images);
        releaseImages(images);
        if (r.conversation_id !== selected.conversation.id) {
          // The old computer was gone; a fresh conversation is the thread now.
          await refreshTeam();
        }
        return "sent";
      } catch (err) {
        // The roster was stale: they are busy after all. Queue instead of bouncing.
        if (err instanceof ApiError && (err.code === "conversation_busy" || err.status === 503)) {
          void refreshTeam();
          return queue();
        }
        toast(describeError(err), "error");
        throw err;
      }
    },
    [client, selected, selectedThread, queues, refreshTeam, toast],
  );

  const onCancelQueued = useCallback(
    (id: string) => {
      if (!selected) return;
      const key = selectedThread?.id ?? selected.agent_id;
      const item = queues.get(key)?.find((m) => m.id === id);
      if (item) releaseImages(item.images);
      setQueues((q) => removeQueued(q, key, id));
    },
    [selected, selectedThread, queues],
  );

  // ── threads ───────────────────────────────────────────────────────────────

  /** Close every side thread of a teammate (before its computer goes, or the teammate does). */
  const closeSideThreads = useCallback(
    async (agentId: string) => {
      const side = threadsRef.current.get(agentId) ?? [];
      await Promise.all(side.map((c) => client.terminate(c.id).catch(() => undefined)));
      setQueues((q) => side.reduce<ReadonlyMap<string, readonly QueuedMessage[]>>((acc, c) => withoutConversation(acc, c.id), q));
    },
    [client],
  );

  /** A new thread with the selected teammate, on the computer they already have. */
  const openThread = useCallback(
    async (agentId: string) => {
      const t = teamRef.current.find((x) => x.agent_id === agentId);
      if (!t) return;
      const sb = t.conversation.sandbox;
      if (!sb || (sb.status !== "ready" && sb.status !== "suspended")) {
        toast(`${t.name}'s computer is not up yet — a thread can be opened once it is ready.`, "error");
        return;
      }
      const existing = threadsRef.current.get(agentId) ?? [];
      const title = window.prompt(`Name the new thread with ${t.name}`, nextThreadTitle(existing));
      if (title === null) return;
      try {
        const conv = await client.openThread({
          agent_id: agentId,
          sandbox_id: sb.id,
          environment_id: t.conversation.environment_id,
          vault_id: t.conversation.vault_id,
          title: title.trim() || nextThreadTitle(existing),
        });
        await refreshTeam();
        select(agentId, conv.id);
      } catch (err) {
        if (err instanceof ApiError && err.code === "sandbox_not_attachable") {
          toast(`${t.name}'s computer cannot take another thread right now — try again in a moment.`, "error");
          return;
        }
        toast(describeError(err), "error");
      }
    },
    [client, refreshTeam, select, toast],
  );

  /** Close a side thread: it ends and leaves the strip; the computer stays up for the main thread. */
  const closeThread = useCallback(
    (agentId: string, conversationId: string) => {
      const t = teamRef.current.find((x) => x.agent_id === agentId);
      const c = threadsRef.current.get(agentId)?.find((x) => x.id === conversationId);
      if (!t || !c) return;
      const name = c.title?.trim() || "this thread";
      if (c.turn_count > 0 && !window.confirm(`Close ${name} with ${t.name}? The conversation ends (it stays readable in Fountain); ${t.name} keeps the computer and the main thread.`)) return;
      client
        .terminate(conversationId)
        .then(() => {
          setQueues((q) => withoutConversation(q, conversationId));
          if (selectedConvRef.current === conversationId) select(agentId);
          return refreshTeam();
        })
        .catch((err) => toast(describeError(err), "error"));
    },
    [client, refreshTeam, select, toast],
  );

  const onToggleNotify = useCallback(async () => {
    if (prefs.notify) {
      updatePrefs((p) => ({ ...p, notify: false }));
      return;
    }
    const perm = await requestNotifyPermission();
    setNotifyPerm(perm);
    if (perm === "granted") {
      updatePrefs((p) => ({ ...p, notify: true }));
      toast("You'll be notified when a teammate replies");
    } else if (perm === "denied") {
      toast("Notifications are blocked for this site in your browser", "error");
    }
  }, [prefs.notify, updatePrefs, toast]);

  const onInterrupt = useCallback(() => {
    if (!selectedConvId) return;
    client
      .interrupt(selectedConvId)
      .then(() => toast("Interrupted"))
      .catch((err) => toast(describeError(err), "error"));
  }, [client, selectedConvId, toast]);

  const removeTeammate = useCallback(
    (agentId: string) => {
      const t = team.find((x) => x.agent_id === agentId);
      if (!t) return;
      if (!window.confirm(`Remove ${t.name} from the team? Their computer is shut down; the conversation stays in your Fountain history.`)) return;
      closeSideThreads(agentId)
        .then(() => client.removeTeammate(agentId))
        .then(() => {
          toast("Removed from the team");
          if (selectedId === agentId) select(null);
          setQueues((q) => withoutConversation(q, agentId));
          return refreshTeam();
        })
        .catch((err) => toast(describeError(err), "error"));
    },
    [client, team, selectedId, refreshTeam, select, toast, closeSideThreads],
  );

  /**
   * Start a fresh thread with a teammate. By default they keep their computer: the current
   * conversation is retired (it stays in History) and a new one opens on the same sandbox, so
   * the next message starts with a clean context but the files and tools still there. With
   * `newComputer`, the current conversation and its computer are terminated instead and the
   * next message provisions a new one.
   */
  const retireThread = useCallback(
    (agentId: string, opts: { newComputer?: boolean } = {}) => {
      const t = team.find((x) => x.agent_id === agentId);
      if (!t) return;
      if (opts.newComputer) {
        const live = t.conversation.status !== "terminated" && t.conversation.status !== "failed";
        // A thread nothing has happened on yet has nothing to lose — no need to ask
        // (customize → "restart their computer" is the usual way here).
        if (
          live &&
          t.conversation.turn_count > 0 &&
          !window.confirm(
            `Start a fresh thread with ${t.name} on a new computer? This ends the current conversation and shuts down its computer (anything not committed or pushed from that computer is gone). The thread stays under History; a new computer starts now.`,
          )
        )
          return;
        // End the current computer, then open the new conversation right away: with the old one
        // past resuming, Fountain opens it on a fresh sandbox and provisions immediately, so the
        // thread goes "Starting their computer…" → "ready" without waiting for a first message.
        // Side threads hold the computer up too, so they go first.
        closeSideThreads(agentId)
          .then(() => (live ? client.terminate(t.conversation.id) : Promise.resolve()))
          .then(() => client.freshConversation(agentId))
          .then(() => {
            toast(`Starting ${t.name}'s new computer…`);
            setQueues((q) => withoutConversation(q, agentId));
            return refreshTeam();
          })
          .catch((err) => {
            if (err instanceof ApiError && err.code === "conversation_busy") {
              toast(`${t.name} is still working — interrupt or wait for the turn to end, then try again.`, "error");
              return;
            }
            toast(describeError(err), "error");
          });
        return;
      }
      const keeps = t.conversation.status !== "terminated" && t.conversation.status !== "failed";
      if (
        !window.confirm(
          keeps
            ? `Start a fresh thread with ${t.name}? The current conversation ends and stays under History. ${t.name} keeps the same computer — files and tools stay — and the next message begins the new thread with a clean slate.`
            : `Start a fresh thread with ${t.name}? The old thread stays under History; a new computer is started for the new one.`,
        )
      )
        return;
      client
        .freshConversation(agentId)
        .then(() => {
          toast(keeps ? `Fresh thread — ${t.name} is on the same computer` : `Fresh thread — starting ${t.name}'s computer`);
          setQueues((q) => withoutConversation(q, agentId));
          return refreshTeam();
        })
        .catch((err) => {
          if (err instanceof ApiError && err.code === "conversation_busy") {
            toast(`${t.name} is still working — interrupt or wait for the turn to end, then try again.`, "error");
            return;
          }
          toast(describeError(err), "error");
        });
    },
    [client, team, refreshTeam, toast, closeSideThreads],
  );

  const onRemove = useCallback(() => {
    if (selected) removeTeammate(selected.agent_id);
  }, [selected, removeTeammate]);

  /** Open the "Give email & phone" dialog — or say why not (no keys on the instance). */
  const giveContact = useCallback(
    (agentId: string) => {
      const t = teamRef.current.find((x) => x.agent_id === agentId);
      if (!t) return;
      const offer = contactOffer(comms, t);
      if (offer.kind === "disabled") {
        toast(offer.reason, "error");
        return;
      }
      if (t.contact) {
        toast(`${t.name} already has an email and phone`);
        return;
      }
      setContactFor({ agentId, mode: "give" });
    },
    [comms, toast],
  );

  /** Replace whose texts reach the teammate (also clears a STOP opt-out). */
  const changeContactNumber = useCallback((agentId: string) => {
    const t = teamRef.current.find((x) => x.agent_id === agentId);
    if (!t?.contact) return;
    setContactFor({ agentId, mode: "change" });
  }, []);

  /** Take a teammate's email + phone away: released upstream, then gone from the roster. */
  const releaseContact = useCallback(
    (agentId: string) => {
      const t = teamRef.current.find((x) => x.agent_id === agentId);
      if (!t?.contact) return;
      if (!window.confirm(`Release ${t.name}'s email and phone? The inbox and number are released; texts and mail to them stop arriving.`)) return;
      client
        .releaseContact(agentId)
        .then(() => {
          setTeam((ts) => ts.map((x) => (x.agent_id === agentId ? { ...x, contact: null } : x)));
          toast(`${t.name}'s email and phone are released`);
          return refreshTeam();
        })
        .catch((err) => {
          if (err instanceof ApiError && err.status === 404) {
            // already gone — agree with the server
            setTeam((ts) => ts.map((x) => (x.agent_id === agentId ? { ...x, contact: null } : x)));
            return;
          }
          toast(describeError(err), "error");
        });
    },
    [client, refreshTeam, toast],
  );

  const onRowAction = useCallback(
    (agentId: string, action: RowAction) => {
      const t = team.find((x) => x.agent_id === agentId);
      switch (action) {
        case "pin":
          updatePrefs((p) => ({ ...p, pinned: toggleIn(p.pinned, agentId) }));
          break;
        case "mute":
          updatePrefs((p) => ({ ...p, muted: toggleIn(p.muted, agentId) }));
          break;
        case "unread":
          updatePrefs((p) => ({ ...p, unread: p.unread.includes(agentId) ? p.unread : [...p.unread, agentId] }));
          break;
        case "read":
          updatePrefs((p) => ({ ...p, unread: without(p.unread, agentId) }));
          if (t?.unread) {
            client
              .markRead(t.conversation.id)
              .then(() => setTeam((ts) => ts.map((x) => (x.agent_id === agentId ? { ...x, unread: false } : x))))
              .catch((err) => toast(describeError(err), "error"));
          }
          break;
        case "copy-id":
          if (t) {
            navigator.clipboard
              .writeText(t.conversation.id)
              .then(() => toast("Conversation id copied"))
              .catch(() => toast(t.conversation.id));
          }
          break;
        case "open":
          if (t) window.open(transcriptUrl(client.baseUrl, t.conversation.id), "_blank", "noopener");
          break;
        case "remove":
          removeTeammate(agentId);
          break;
        case "rename":
          select(agentId);
          setRenaming(true);
          break;
        case "history":
          select(agentId);
          setHistoryFor(agentId);
          break;
        case "customize":
        case "computer":
          select(agentId);
          setCustomizeRequested(true);
          break;
        case "thread":
          void openThread(agentId);
          break;
        case "retire":
          retireThread(agentId);
          break;
        case "retire-new":
          retireThread(agentId, { newComputer: true });
          break;
        case "report":
          setReporting(agentId);
          break;
        case "contact":
          giveContact(agentId);
          break;
        case "change-number":
          changeContactNumber(agentId);
          break;
        case "release-contact":
          releaseContact(agentId);
          break;
      }
    },
    [team, client, updatePrefs, removeTeammate, retireThread, toast, select, giveContact, changeContactNumber, releaseContact, openThread],
  );

  const orderedTeam = useMemo(() => sortPinnedFirst(team, prefs.pinned), [team, prefs.pinned]);
  orderedTeamRef.current = orderedTeam;

  const onTeamIds = useMemo(() => new Set(team.map((t) => t.agent_id)), [team]);

  return (
    <div className={`app ${selected || page !== "team" ? "thread-open" : ""}`}>
      <Roster
        client={client}
        loaded={teamLoaded}
        teammates={orderedTeam}
        selectedId={selectedId}
        prefs={prefs}
        notifyPermission={notifyPerm}
        onSelect={select}
        onAdd={() => void addInstant()}
        onAddExisting={() => setAdding(true)}
        adding={instantBusy}
        onSettings={onSettings}
        onSignOut={onSignOut}
        onToggleNotify={() => void onToggleNotify()}
        onRowAction={onRowAction}
        onRoutines={() => openRoutines()}
        onPalette={() => setPaletteOpen(true)}
        onExport={() => void exportTeam()}
        onShortcuts={() => setShortcutsOpen(true)}
        onRunners={openRunners}
        onReport={() => setReporting(selectedId ?? null)}
        connected={connected}
        comms={comms}
        waitingConvIds={waitingConvIds}
        threads={threads}
      />
      {page === "runners" ? (
        <Runners client={client} onBack={() => select(null)} toast={toast} fountainUrl={client.baseUrl} refreshKey={teamVersion} />
      ) : page === "routines" ? (
        <Routines
          client={client}
          teammates={orderedTeam}
          schedules={schedules}
          forAgentId={routinesFor}
          onRefresh={refreshSchedules}
          onBack={() => select(null)}
          onOpenTeammate={select}
          toast={toast}
          fountainUrl={client.baseUrl}
        />
      ) : selected ? (
        <Thread
          client={client}
          teammate={selected}
          thread={selectedThread}
          threads={threads.get(selected.agent_id) ?? []}
          onSelectThread={(id) => select(selected.agent_id, id)}
          onNewThread={() => void openThread(selected.agent_id)}
          onCloseThread={(id) => closeThread(selected.agent_id, id)}
          turns={turns}
          events={events}
          queued={queues.get(selectedThread?.id ?? selected.agent_id) ?? []}
          loading={threadLoading || loadedConvId !== selectedConvId}
          onSend={onSend}
          onCancelQueued={onCancelQueued}
          onInterrupt={onInterrupt}
          onRemove={onRemove}
          onBack={() => select(null)}
          onError={(text) => toast(text, "error")}
          onRoutines={() => openRoutines(selected.agent_id)}
          onHistory={() => setHistoryFor(selected.agent_id)}
          onRetire={() => retireThread(selected.agent_id, { newComputer: true })}
          onRunners={openRunners}
          customizeRequested={customizeRequested}
          onCustomizeOpened={onCustomizeOpened}
          onRename={(name) => renameTeammate(selected.agent_id, name)}
          renaming={renaming}
          onRenamingChange={setRenaming}
          focusTurnId={focusTurnId}
          onFocused={() => setFocusTurnId(null)}
          onAgentChanged={() => void refreshTeam()}
          onlyTeammate={team.length === 1}
          comms={comms}
          onGiveContact={() => giveContact(selected.agent_id)}
          onReleaseContact={() => releaseContact(selected.agent_id)}
          onChangeContactNumber={() => changeContactNumber(selected.agent_id)}
          activityOpen={prefs.activity}
          onActivityChange={(open) => updatePrefs((p) => ({ ...p, activity: open }))}
          fountainUrl={client.baseUrl}
        />
      ) : !teamLoaded ? (
        <section className="thread placeholder" aria-busy="true" />
      ) : team.length === 0 ? (
        <Onboarding onAdd={() => void addInstant()} onAddExisting={() => setAdding(true)} busy={instantBusy} error={teamError} />
      ) : (
        <section className="thread placeholder">
          <div className="centered muted">{teamError ? teamError : "Pick a teammate to open the conversation."}</div>
        </section>
      )}
      {shortcutsOpen && <Shortcuts onClose={() => setShortcutsOpen(false)} />}
      {reporting !== undefined && (
        <ReportDialog
          client={client}
          about={reporting ? (team.find((t) => t.agent_id === reporting)?.name ?? null) : null}
          context={buildReportContext({
            appCommit: __APP_COMMIT__,
            fountainUrl: client.baseUrl,
            connected,
            teammate: reporting ? (team.find((t) => t.agent_id === reporting) ?? null) : null,
            events: reporting && reporting === selectedId ? events : [],
            queued: reporting ? (queues.get(reporting)?.length ?? 0) : 0,
          })}
          onClose={() => setReporting(undefined)}
          toast={toast}
        />
      )}
      {contactFor && team.find((t) => t.agent_id === contactFor.agentId) && (
        <ContactDialog
          client={client}
          teammate={team.find((t) => t.agent_id === contactFor.agentId)!}
          mode={contactFor.mode}
          onClose={() => setContactFor(null)}
          onProvisioned={(updated) => {
            setContactFor(null);
            setTeam((ts) => ts.map((t) => (t.agent_id === updated.agent_id ? { ...t, ...updated } : t)));
            void refreshTeam();
          }}
          toast={toast}
        />
      )}
      {historyFor && team.find((t) => t.agent_id === historyFor) && (
        <History
          client={client}
          teammate={team.find((t) => t.agent_id === historyFor)!}
          onClose={() => setHistoryFor(null)}
          onOpenCurrent={() => {
            select(historyFor);
            setHistoryFor(null);
          }}
          onRetire={(newComputer) => {
            setHistoryFor(null);
            retireThread(historyFor, { newComputer });
          }}
          fountainUrl={client.baseUrl}
        />
      )}
      {paletteOpen && <Palette client={client} teammates={orderedTeam} onChoose={onPaletteChoice} onClose={() => setPaletteOpen(false)} />}
      {adding && (
        <AddDialog
          client={client}
          onTeam={onTeamIds}
          onClose={() => setAdding(false)}
          onAdded={(agentId) => {
            setAdding(false);
            void refreshTeam().then(() => select(agentId));
          }}
        />
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function idFromHash(): string | null {
  const m = /^#\/team\/([0-9a-f-]{36})(?:\/[0-9a-f-]{36})?$/.exec(window.location.hash);
  return m?.[1] ?? null;
}

/** `#/team/<agent>/<conversation>` — a side thread of that teammate. */
function threadFromHash(): string | null {
  const m = /^#\/team\/[0-9a-f-]{36}\/([0-9a-f-]{36})$/.exec(window.location.hash);
  return m?.[1] ?? null;
}

function markThreadRead(m: ReadonlyMap<string, readonly Conversation[]>, conversationId: string): ReadonlyMap<string, readonly Conversation[]> {
  let changed = false;
  const next = new Map<string, readonly Conversation[]>();
  for (const [k, list] of m) {
    if (list.some((c) => c.id === conversationId && c.unread)) {
      changed = true;
      next.set(k, list.map((c) => (c.id === conversationId ? { ...c, unread: false } : c)));
    } else next.set(k, list);
  }
  return changed ? next : m;
}

function pageFromHash(): "team" | "routines" | "runners" {
  if (window.location.hash === "#/routines") return "routines";
  if (window.location.hash === "#/runners") return "runners";
  return "team";
}

function byActivity(a: Teammate, b: Teammate): number {
  return (b.conversation.last_active_at ?? "").localeCompare(a.conversation.last_active_at ?? "");
}
