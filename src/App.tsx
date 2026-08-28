/**
 * Briefing Room: one researcher teammate, its conversation folded into a
 * library of briefs. The protocol lives in lib/protocol.ts; the agent's rules
 * in lib/spec.ts. Streaming/reconnect follows jhgaylor/dns-desk.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeError, FountainClient } from "./api/client";
import type { LogEvent, TeamEvent, Teammate, Turn } from "./api/types";
import { assistantText, blocksForTurn } from "./lib/acp";
import { clearAnalystId, loadAnalystId, saveAnalystId } from "./lib/analyst";
import { completeLoginIfCallback, revoke } from "./lib/oauth";
import { clearSettings, loadSettings, saveSettings, type Settings } from "./lib/settings";
import { fetchedUrls, foldConversation, latestOrphan, parseRequest, type RoomView } from "./lib/protocol";
import { commissionPrompt, followupPrompt, reformatPrompt, type Depth } from "./lib/spec";
import { BriefDoc } from "./components/BriefDoc";
import { CommissionForm } from "./components/CommissionForm";
import { Connect } from "./components/Connect";
import { Library } from "./components/Library";
import { Progress } from "./components/Progress";
import { Setup } from "./components/Setup";

const STREAMS = ["acp", "stdout", "stage"];

type Phase = "boot" | "setup" | "connect" | "room";

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [analystId, setAnalystId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("boot");
  const [setupError, setSetupError] = useState<string | null>(null);

  const [teammate, setTeammate] = useState<Teammate | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
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
    const analyst = loadAnalystId(settings.baseUrl);
    setAnalystId(analyst);
    setPhase(analyst ? "room" : "connect");
  }, [settings]);

  const signOut = useCallback(() => {
    if (settings?.via === "oauth") void revoke(settings.baseUrl, settings.apiKey);
    clearSettings();
    setSettings(null);
    setAnalystId(null);
    setTeammate(null);
    setPhase("setup");
  }, [settings]);

  const changeAnalyst = useCallback(() => {
    if (settings) clearAnalystId(settings.baseUrl);
    setAnalystId(null);
    setTeammate(null);
    setPhase("connect");
  }, [settings]);

  // ── the researcher's conversation ─────────────────────────────────────────

  const refreshTeammate = useCallback(async () => {
    if (!client || !analystId) return;
    try {
      setTeammate(await client.getTeammate(analystId));
    } catch (err) {
      // The teammate is gone (removed in Fountain) — back to connect.
      setTeammate(null);
      if (settings) clearAnalystId(settings.baseUrl);
      setAnalystId(null);
      setPhase("connect");
      say(describeError(err));
    }
  }, [client, analystId, settings, say]);

  useEffect(() => {
    if (phase === "room") void refreshTeammate();
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
    if (!client || phase !== "room" || !analystId) return;
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
            if (ev.agent_id === analystId) void refreshTeammate();
            return;
          }
          setEvents((es) => (es.some((e) => e.id === ev.id) ? es : [...es, ev]));
          if (ev.kind === "stage" && ev.stage === "turn") {
            void client.listTurns(ev.conversation_id).then(setTurns).catch(() => undefined);
            if (ev.state !== "started") void client.markRead(ev.conversation_id).catch(() => undefined);
          }
        },
        onClose: () => {
          // The server closes at 60 s idle by design — reconnect silently.
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
  }, [client, phase, analystId, refreshTeammate, reloadThread]);

  // ── derived: replies per turn, the folded library ─────────────────────────

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
      events: byTurn.get(turn.id) ?? [],
      reply: assistantText(byTurn.get(turn.id) ?? [], runtime),
    }));
  }, [turns, events, runtime]);

  const view: RoomView = useMemo(
    () =>
      foldConversation(
        thread.map((t) => ({
          prompt: t.turn.prompt,
          reply: t.reply,
          done: t.turn.ended_at !== null || t.turn.status === "failed",
        })),
      ),
    [thread],
  );

  const running = thread.find((t) => t.turn.ended_at === null && t.turn.status !== "failed") ?? null;
  const working = running !== null;
  const runningReq = running ? parseRequest(running.turn.prompt) : null;
  const runningUrls = useMemo(() => {
    if (!running) return [];
    const tools = blocksForTurn(running.events, runtime).filter((b) => b.kind === "tool");
    return fetchedUrls(tools.map((b) => `${b.summary}\n${b.output}`));
  }, [running, runtime]);

  const orphan = latestOrphan(view);
  const selectedThread = selected ? view.threads.find((t) => t.id === selected) ?? null : null;

  // First load with briefs: open the newest one.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current || view.threads.length === 0) return;
    bootedRef.current = true;
    setSelected((cur) => cur ?? view.threads[0]!.id);
  }, [view.threads]);

  // After a send, follow the work: a new version opens its thread; a reply
  // with no brief at all lands back on the form, where the orphan banner is.
  const newestVersionTurn = useMemo(
    () => view.threads.reduce((max, t) => t.versions.reduce((m, v) => Math.max(m, v.turnIndex), max), -1),
    [view],
  );
  const autoFollowRef = useRef(false);
  const prevNewestRef = useRef(newestVersionTurn);
  const prevWorkingRef = useRef(working);
  useEffect(() => {
    if (newestVersionTurn > prevNewestRef.current && autoFollowRef.current) {
      const t = view.threads.find((th) => th.versions.some((v) => v.turnIndex === newestVersionTurn));
      if (t) {
        setSelected(t.id);
        autoFollowRef.current = false;
      }
    }
    prevNewestRef.current = Math.max(prevNewestRef.current, newestVersionTurn);
    if (prevWorkingRef.current && !working && autoFollowRef.current) {
      autoFollowRef.current = false;
      if (latestOrphan(view)) setSelected(null);
    }
    prevWorkingRef.current = working;
  }, [newestVersionTurn, working, view]);

  // ── actions ───────────────────────────────────────────────────────────────

  const send = useCallback(
    async (text: string) => {
      if (!client || !analystId || !text.trim()) return;
      setBusy(true);
      try {
        await client.sendMessage(analystId, text.trim());
        autoFollowRef.current = true;
        await Promise.all([refreshTeammate(), reloadThread()]);
      } catch (err) {
        say(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [client, analystId, refreshTeammate, reloadThread, say],
  );

  const commission = useCallback(
    (topic: string, why: string, depth: Depth) => void send(commissionPrompt(topic, why, depth)),
    [send],
  );
  const followup = useCallback(
    (text: string) => {
      if (selectedThread) void send(followupPrompt(selectedThread.id, text));
    },
    [send, selectedThread],
  );
  const reask = useCallback(() => void send(reformatPrompt()), [send]);

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
  if (phase === "connect" || !analystId)
    return (
      <Connect
        client={client}
        onSignOut={signOut}
        onReady={(agentId) => {
          saveAnalystId(settings.baseUrl, agentId);
          setAnalystId(agentId);
          setPhase("room");
        }}
      />
    );

  const progressTopic =
    runningReq?.kind === "commission" ? runningReq.topic : runningReq?.kind === "followup" ? `Following up: ${runningReq.text}` : null;
  const progress = working ? <Progress topic={progressTopic} urls={runningUrls} /> : null;

  return (
    <div className="room">
      <header>
        <div className="wordmark small">
          Briefing <span>Room</span>
        </div>
        <button className="ghost rail-toggle" onClick={() => setRailOpen((o) => !o)}>
          {railOpen ? "Close" : "Library"}
        </button>
        <div className="grow" />
        <div className="head-status">
          <span className={connected ? "dot on" : "dot"} title={connected ? "live" : "reconnecting"} />
          <span className="fineprint">{working ? "researching…" : teammate?.presence.label ?? "…"}</span>
          <button className="linkish" onClick={changeAnalyst}>
            change researcher
          </button>
          <button className="linkish" onClick={signOut}>
            sign out
          </button>
        </div>
      </header>

      {toast && <div className="toast">{toast}</div>}

      <div className="body">
        <Library
          threads={view.threads}
          selectedId={selected}
          open={railOpen}
          onSelect={(id) => {
            setSelected(id);
            setRailOpen(false);
          }}
        />
        <main className="main">
          <div className="main-inner">
            {selectedThread ? (
              <BriefDoc thread={selectedThread} busy={busy} working={working} onFollowup={followup} progress={progress} />
            ) : (
              <>
                {progress}
                {orphan && !working && (
                  <div className="orphan">
                    <div className="label">The researcher answered in prose, not a brief</div>
                    {orphan.topic && <p className="fineprint">On: {orphan.topic}</p>}
                    <p>{orphan.text || "(no reply text)"}</p>
                    <button className="ghost" onClick={reask} disabled={busy}>
                      Ask again for the full brief
                    </button>
                  </div>
                )}
                <CommissionForm busy={busy} working={working} hasBriefs={view.threads.length > 0} onCommission={commission} />
              </>
            )}
          </div>
        </main>
      </div>

      <footer className="room-footer fineprint">
        Runs on <a href="https://github.com/BinaryBourbon/fountain">Fountain</a> ·{" "}
        <a href="https://github.com/managoat/briefing-room">source</a>
      </footer>
    </div>
  );
}
