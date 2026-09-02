/**
 * DNS Desk: one dedicated teammate, two views of its one conversation —
 * Zones (the latest dns-state) and Activity (requests, plans, decisions).
 * The desk protocol itself lives in lib/protocol.ts; the agent's rules in
 * lib/spec.ts. Streaming/reconnect follows jhgaylor/fountain-team.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeError, FountainClient } from "./api/client";
import type { LogEvent, TeamEvent, Teammate, Turn } from "./api/types";
import { assistantText } from "./lib/acp";
import { clearDeskId, loadDeskId, saveDeskId } from "./lib/desk";
import { completeLoginIfCallback, revoke } from "./lib/oauth";
import { clearSettings, loadSettings, saveSettings, type Settings } from "./lib/settings";
import { foldConversation, parseDecision, pendingPlan, stripBlocks, type DeskView } from "./lib/protocol";
import { Connect } from "./components/Connect";
import { PlanCardView } from "./components/PlanCard";
import { Setup } from "./components/Setup";
import { Zones } from "./components/Zones";

const STREAMS = ["acp", "stdout", "stage"];

type Phase = "boot" | "setup" | "connect" | "desk";

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [deskId, setDeskId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("boot");
  const [setupError, setSetupError] = useState<string | null>(null);

  const [teammate, setTeammate] = useState<Teammate | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"zones" | "activity">("zones");
  const [toast, setToast] = useState<string | null>(null);

  const client = useMemo(() => (settings ? new FountainClient(settings) : null), [settings]);
  const convId = teammate?.conversation.id ?? null;
  const convIdRef = useRef<string | null>(null);
  convIdRef.current = convId;

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
        setSetupError(err instanceof Error ? err.message : String(err));
      }
      const stored = loadSettings();
      if (stored) setSettings(stored);
      else setPhase("setup");
    })();
  }, []);

  // Settings arrived (boot, OAuth callback, or a pasted key): pick the screen.
  useEffect(() => {
    if (!settings) return;
    const desk = loadDeskId(settings.baseUrl);
    setDeskId(desk);
    setPhase(desk ? "desk" : "connect");
  }, [settings]);

  const signOut = useCallback(() => {
    if (settings?.via === "oauth") void revoke(settings.baseUrl, settings.apiKey);
    clearSettings();
    setSettings(null);
    setDeskId(null);
    setTeammate(null);
    setPhase("setup");
  }, [settings]);

  const changeDesk = useCallback(() => {
    if (settings) clearDeskId(settings.baseUrl);
    setDeskId(null);
    setTeammate(null);
    setPhase("connect");
  }, [settings]);

  // ── the desk's conversation ───────────────────────────────────────────────

  const refreshTeammate = useCallback(async () => {
    if (!client || !deskId) return;
    try {
      setTeammate(await client.getTeammate(deskId));
    } catch (err) {
      // The teammate is gone (removed in Fountain) — back to connect.
      setTeammate(null);
      if (settings) clearDeskId(settings.baseUrl);
      setDeskId(null);
      setPhase("connect");
      say(describeError(err));
    }
  }, [client, deskId, settings, say]);

  useEffect(() => {
    if (phase === "desk") void refreshTeammate();
  }, [phase, refreshTeammate]);

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
    if (!client || phase !== "desk" || !deskId) return;
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
          void refreshTeammate();
          void reloadThread();
        },
        onMessage: (msg) => {
          if (msg.id) lastEventId = msg.id;
          if (msg.event === "team") {
            void refreshTeammate();
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
            // A new conversation for our agent (fresh computer): re-point.
            if (ev.agent_id === deskId) void refreshTeammate();
            return;
          }
          setEvents((es) => (es.some((e) => e.id === ev.id) ? es : [...es, ev]));
          if (ev.kind === "stage" && ev.stage === "turn") {
            void client.listTurns(ev.conversation_id).then(setTurns).catch(() => undefined);
            if (ev.state !== "started") void client.markRead(ev.conversation_id).catch(() => undefined);
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
  }, [client, phase, deskId, refreshTeammate, reloadThread]);

  // ── derived: replies per turn, the folded desk view ──────────────────────

  const runtime = teammate?.conversation.runtime ?? "claude";
  const thread = useMemo(() => {
    const sorted = [...turns].sort((a, b) => a.turn_number - b.turn_number);
    const byTurn = new Map<string, LogEvent[]>();
    for (const ev of events) {
      if (!ev.turn_id) continue;
      const list = byTurn.get(ev.turn_id);
      if (list) list.push(ev);
      else byTurn.set(ev.turn_id, [ev]);
    }
    return sorted.map((turn) => ({
      turn,
      reply: assistantText(byTurn.get(turn.id) ?? [], runtime),
    }));
  }, [turns, events, runtime]);

  const view: DeskView = useMemo(
    () => foldConversation(thread.map((t) => ({ prompt: t.turn.prompt, reply: t.reply }))),
    [thread],
  );
  const pending = pendingPlan(view);
  const working = thread.some((t) => t.turn.ended_at === null && t.turn.status !== "failed");

  // ── actions ───────────────────────────────────────────────────────────────

  const send = useCallback(
    async (text: string) => {
      if (!client || !deskId || !text.trim()) return;
      setBusy(true);
      try {
        await client.sendMessage(deskId, text.trim());
        await Promise.all([refreshTeammate(), reloadThread()]);
      } catch (err) {
        say(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [client, deskId, refreshTeammate, reloadThread, say],
  );

  const decide = useCallback(
    (verb: "approve" | "reject", planId: string) => {
      void send(`${verb.toUpperCase()} ${planId}`);
    },
    [send],
  );

  const refreshZones = useCallback(() => {
    void send("Read all zones and their DNS records from Cloudflare and report the current dns-state.");
  }, [send]);

  // ── render ────────────────────────────────────────────────────────────────

  if (phase === "boot") return <div className="setup" />;
  if (phase === "setup" || !settings || !client)
    return (
      <Setup
        error={setupError}
        onPaste={(s) => {
          saveSettings(s);
          setSetupError(null);
          setSettings(s);
        }}
      />
    );
  if (phase === "connect" || !deskId)
    return (
      <Connect
        client={client}
        onSignOut={signOut}
        onReady={(agentId) => {
          saveDeskId(settings.baseUrl, agentId);
          setDeskId(agentId);
          setPhase("desk");
        }}
      />
    );

  return (
    <div className="desk">
      <header>
        <div className="wordmark small">
          DNS<span>Desk</span>
        </div>
        <nav>
          <button className={tab === "zones" ? "tab active" : "tab"} onClick={() => setTab("zones")}>
            Zones
          </button>
          <button className={tab === "activity" ? "tab active" : "tab"} onClick={() => setTab("activity")}>
            Activity{pending ? <span className="dot-badge" /> : null}
          </button>
        </nav>
        <div className="head-status">
          <span className={connected ? "dot on" : "dot"} title={connected ? "live" : "reconnecting"} />
          <span className="fineprint">{working ? "working…" : teammate?.presence.label ?? "…"}</span>
          <button className="linkish" onClick={changeDesk}>
            change desk
          </button>
          <button className="linkish" onClick={signOut}>
            sign out
          </button>
        </div>
      </header>

      {toast && <div className="toast">{toast}</div>}

      {pending && (
        <div className="pending-bar">
          <PlanCardView card={pending} busy={busy || working} onDecide={decide} />
        </div>
      )}

      {tab === "zones" ? (
        <Zones state={view.state} onRefresh={refreshZones} refreshing={busy || working} />
      ) : (
        <Activity
          thread={thread}
          view={view}
          busy={busy}
          working={working}
          onSend={(text) => void send(text)}
          onDecide={decide}
        />
      )}
    </div>
  );
}

// ── the activity tab: the conversation, desk-shaped ─────────────────────────

function Activity(props: {
  thread: Array<{ turn: Turn; reply: string }>;
  view: DeskView;
  busy: boolean;
  working: boolean;
  onSend: (text: string) => void;
  onDecide: (verb: "approve" | "reject", planId: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  const count = props.thread.length;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [count, props.working]);

  const submit = () => {
    if (!draft.trim()) return;
    props.onSend(draft);
    setDraft("");
  };

  return (
    <div className="activity">
      <div className="feed">
        {props.thread.length === 0 && (
          <p className="fineprint center">
            Nothing yet. Ask for something — “what zones do you see?”, “add an A record demo → 203.0.113.7”.
          </p>
        )}
        {props.thread.map(({ turn, reply }, i) => {
          const decision = parseDecision(turn.prompt);
          const prose = stripBlocks(reply);
          const cards = props.view.plans.filter((c) => c.turnIndex === i);
          const stateHere = props.view.stateTurnIndex === i;
          return (
            <div key={turn.id} className="entry">
              {decision ? (
                <div className={`decision decision-${decision.verb}`}>
                  You {decision.verb === "approve" ? "approved" : "rejected"} <code>{decision.planId}</code>
                </div>
              ) : (
                <div className="bubble you">{turn.prompt}</div>
              )}
              {prose && <div className="bubble them">{prose}</div>}
              {cards.map((c) => (
                <PlanCardView key={c.plan.id} card={c} busy={props.busy || props.working} onDecide={c.status === "awaiting" ? props.onDecide : undefined} />
              ))}
              {stateHere && <div className="state-note">zone state updated</div>}
              {turn.ended_at === null && turn.status !== "failed" && <div className="state-note">working…</div>}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <div className="composer">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Ask the desk — “point www at the new load balancer”"
          disabled={props.busy}
        />
        <button className="primary" onClick={submit} disabled={props.busy || !draft.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
