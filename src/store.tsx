/**
 * The live store: one Fountain SDK client, the conversation list, the
 * agent/environment/vault catalogs, one SSE connection
 * (`GET /api/events/stream`) every open thread reads from, and the workbench
 * tree (projects, items, members) persisted in this browser.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Fountain } from "@agentshit/fountain-sdk";
import type { Agent, Conversation, Environment, UserEvent, Vault } from "./types";
import type { Settings } from "./lib/settings";
import { readSse } from "./lib/sse";
import { describeError } from "./lib/errors";
import { loadState, reconcile, saveState, type WorkbenchState } from "./lib/workbench";

export type EventHandler = (ev: UserEvent) => void;

const THREAD_STREAMS = ["acp", "stdout", "stage"];

export interface Store {
  fountain: Fountain;
  settings: Settings;
  conversations: Conversation[];
  agents: Map<string, Agent>;
  environments: Map<string, Environment>;
  vaults: Map<string, Vault>;
  resourcesLoaded: boolean;
  connected: boolean;
  error: string | null;
  refresh: () => Promise<Conversation[] | null>;
  refreshResources: () => Promise<void>;
  /** Events for one conversation, live. Returns the unsubscribe. */
  subscribe: (conversationId: string, handler: EventHandler) => () => void;
  toast: (text: string, kind?: "info" | "error") => void;
  /** The workbench tree. `update` persists. */
  state: WorkbenchState;
  update: (fn: (s: WorkbenchState) => WorkbenchState) => void;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}

interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

export function makeClient(settings: Settings): Fountain {
  // `appUrl: ""` — this app is where a human watches the conversation.
  return new Fountain({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, appUrl: "" });
}

export function StoreProvider({ settings, children }: { settings: Settings; children: ReactNode }) {
  const fountain = useMemo(() => makeClient(settings), [settings]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [environments, setEnvironments] = useState<Map<string, Environment>>(new Map());
  const [vaults, setVaults] = useState<Map<string, Vault>>(new Map());
  const [resourcesLoaded, setResourcesLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [state, setState] = useState<WorkbenchState>(() => loadState());
  const handlers = useRef(new Map<string, Set<EventHandler>>());

  const update = useCallback((fn: (s: WorkbenchState) => WorkbenchState) => {
    setState((prev) => {
      const next = fn(prev);
      if (next !== prev) saveState(next);
      return next;
    });
  }, []);

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 5000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await fountain.conversations();
      setConversations(list);
      setError(null);
      // Anything the server knows about that this browser does not becomes a placeholder.
      update((s) => reconcile(s, list));
      return list;
    } catch (err) {
      setError(describeError(err));
      return null;
    }
  }, [fountain, update]);

  const refreshResources = useCallback(async () => {
    try {
      const [a, e, v] = await Promise.all([fountain.agents.list(), fountain.environments.list(), fountain.vaults.list()]);
      setAgents(new Map(a.map((x) => [x.id, x])));
      setEnvironments(new Map(e.map((x) => [x.id, x])));
      setVaults(new Map(v.map((x) => [x.id, x])));
      setResourcesLoaded(true);
    } catch (err) {
      setError(describeError(err));
    }
  }, [fountain]);

  useEffect(() => {
    void refresh();
    void refreshResources();
  }, [refresh, refreshResources]);

  // Debounced refresh for stage events, which arrive in bursts.
  const timer = useRef<number | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void refresh();
    }, 300);
  }, [refresh]);

  const subscribe = useCallback((conversationId: string, handler: EventHandler) => {
    let set = handlers.current.get(conversationId);
    if (!set) {
      set = new Set();
      handlers.current.set(conversationId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    let lastEventId: string | null = null;
    let backoff = 1000;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      const qs = new URLSearchParams({ streams: THREAD_STREAMS.join(","), blocks: "true" });
      void readSse(`${settings.baseUrl}/api/events/stream?${qs}`, {
        headers: { authorization: `Bearer ${settings.apiKey}` },
        lastEventId,
        signal: ctrl.signal,
        onOpen: () => {
          setConnected(true);
          backoff = 1000;
          void refresh();
        },
        onMessage: (msg) => {
          if (msg.id) lastEventId = msg.id;
          if (msg.event === "conversations") {
            scheduleRefresh();
            return;
          }
          let ev: UserEvent;
          try {
            ev = JSON.parse(msg.data) as UserEvent;
          } catch {
            return;
          }
          if (msg.id) ev.id = Number(msg.id);
          if (!ev.kind && (msg.event === "output" || msg.event === "stage")) ev.kind = msg.event;
          handlers.current.get(ev.conversation_id)?.forEach((h) => h(ev));
          if (ev.kind === "stage") {
            scheduleRefresh();
          } else if (ev.kind === "output") {
            setConversations((cs) =>
              cs.map((c) =>
                c.id === ev.conversation_id ? { ...c, last_active_at: ev.ts, unread: c.unread || !openConversation(c.id) } : c,
              ),
            );
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
  }, [settings, refresh, scheduleRefresh]);

  const value = useMemo<Store>(
    () => ({
      fountain,
      settings,
      conversations,
      agents,
      environments,
      vaults,
      resourcesLoaded,
      connected,
      error,
      refresh,
      refreshResources,
      subscribe,
      toast,
      state,
      update,
    }),
    [fountain, settings, conversations, agents, environments, vaults, resourcesLoaded, connected, error, refresh, refreshResources, subscribe, toast, state, update],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

/** Whether the conversation is the one open on screen (its unread state is being cleared). */
function openConversation(id: string): boolean {
  return window.location.hash.endsWith(`/c/${id}`);
}
