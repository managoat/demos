/**
 * The live store: the conversation list plus one SSE connection
 * (`GET /api/events/stream`) that every page reads from — the list for
 * status/unread, the show and log pages for their conversation's events.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FountainClient, describeError } from "./api/client";
import type { Agent, Billing, Conversation, UserEvent } from "./api/types";
import type { Settings } from "./lib/settings";

export type EventHandler = (ev: UserEvent) => void;


export interface Store {
  client: FountainClient;
  conversations: Conversation[];
  agents: Map<string, Agent>;
  connected: boolean;
  error: string | null;
  /** Billing state, or null where the server has billing disabled (self-hosted). */
  billing: Billing | null;
  /** False only when credits are on and the balance is spent — prompts are refused with 402. */
  canPrompt: boolean;
  refresh: () => Promise<Conversation[] | null>;
  /** Events for one conversation, live. Returns the unsubscribe. */
  subscribe: (conversationId: string, handler: EventHandler) => () => void;
  toast: (text: string, kind?: "info" | "error") => void;
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

export function StoreProvider({ settings, children }: { settings: Settings; children: ReactNode }) {
  const client = useMemo(() => new FountainClient(settings), [settings]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const handlers = useRef(new Map<string, Set<EventHandler>>());

  const toast = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 5000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await client.listConversations();
      setConversations(list);
      setError(null);
      return list;
    } catch (err) {
      setError(describeError(err));
      return null;
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    client
      .listAgents()
      .then((list) => setAgents(new Map(list.map((a) => [a.id, a]))))
      .catch(() => undefined);
    client
      .billing()
      .then(setBilling)
      .catch(() => undefined);
  }, [client, refresh]);

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
      void client.streamAll({
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
          handlers.current.get(ev.conversation_id)?.forEach((h) => h(ev));
          if (ev.kind === "stage") {
            scheduleRefresh();
          } else if (ev.kind === "output") {
            // Bump the row locally; the list re-fetches on the next stage event.
            setConversations((cs) =>
              cs.map((c) =>
                c.id === ev.conversation_id
                  ? { ...c, last_active_at: ev.ts, unread: c.unread || !openConversation(c.id) }
                  : c,
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
  }, [client, refresh, scheduleRefresh]);

  // The server's own gate (ee/lib/fountain/credits.ex check_balance/2): credits
  // off → ok, comped → ok, otherwise the balance must be positive. Billing
  // absent (404/403) means the server does not gate on it at all.
  const canPrompt =
    billing === null || billing.credits === null || billing.comped === true || billing.credits.balance_cents > 0;

  const value = useMemo<Store>(
    () => ({ client, conversations, agents, connected, error, billing, canPrompt, refresh, subscribe, toast }),
    [client, conversations, agents, connected, error, billing, canPrompt, refresh, subscribe, toast],
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
  return window.location.hash.startsWith(`#/c/${id}`);
}
