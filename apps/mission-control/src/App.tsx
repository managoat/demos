/**
 * Mission Control: one coordinator teammate plans; the app fans out one
 * worker conversation per approved task; every computer streams back on one
 * SSE connection. The coordinator conversation is the system of record —
 * missions, assignments and reports are folded out of it on every render
 * (lib/protocol.ts); localStorage remembers only the crew and the last
 * mission looked at. Client patterns follow jhgaylor/dns-desk.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, describeError, FountainClient } from "./api/client";
import type { Conversation, LogEvent, StreamEvent, Teammate, Turn } from "./api/types";
import { bootSequence, eventsByTurn, replyText, sessionReady, viewBlocks, type ViewBlock } from "./lib/blocks";
import { clearCrew, loadCrew, saveCrew, type Crew } from "./lib/crew";
import { completeLoginIfCallback, revoke } from "./lib/oauth";
import {
  approveMessage,
  foldMissions,
  launchedMessage,
  pendingMission,
  resultsMessage,
  taskResultOf,
  taskStatus,
  workerPrompt,
  workerTitle,
  type Mission,
  type TaskResult,
} from "./lib/protocol";
import { clearSettings, loadSettings, saveSettings, type Settings } from "./lib/settings";
import { Connect } from "./components/Connect";
import { Setup } from "./components/Setup";
import { PlanView } from "./components/PlanView";
import { elapsed, TaskCard, type TaskView } from "./components/Board";
import { Report, reportMarkdown, type AppendixEntry } from "./components/Report";

const STREAMS = ["acp", "stdout", "stage"];

type Phase = "boot" | "setup" | "connect" | "control";

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [crew, setCrew] = useState<Crew | null>(null);
  const [phase, setPhase] = useState<Phase>("boot");
  const [setupError, setSetupError] = useState<string | null>(null);

  const client = useMemo(() => (settings ? new FountainClient(settings) : null), [settings]);

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

  useEffect(() => {
    if (!settings) return;
    const stored = loadCrew(settings.baseUrl);
    setCrew(stored);
    setPhase(stored ? "control" : "connect");
  }, [settings]);

  const signOut = useCallback(() => {
    if (settings?.via === "oauth") void revoke(settings.baseUrl, settings.apiKey);
    clearSettings();
    setSettings(null);
    setCrew(null);
    setPhase("setup");
  }, [settings]);

  const changeCrew = useCallback(() => {
    if (settings) clearCrew(settings.baseUrl);
    setCrew(null);
    setPhase("connect");
  }, [settings]);

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
  if (phase === "connect" || !crew)
    return (
      <Connect
        client={client}
        onSignOut={signOut}
        onReady={(c) => {
          saveCrew(settings.baseUrl, c);
          setCrew(c);
          setPhase("control");
        }}
      />
    );

  return <Control client={client} settings={settings} crew={crew} onChangeCrew={changeCrew} onSignOut={signOut} />;
}

// ── the console ──────────────────────────────────────────────────────────────

function Control(props: {
  client: FountainClient;
  settings: Settings;
  crew: Crew;
  onChangeCrew: () => void;
  onSignOut: () => void;
}) {
  const { client, settings, crew } = props;

  const [teammate, setTeammate] = useState<Teammate | null>(null);
  const [coordTurns, setCoordTurns] = useState<Turn[]>([]);
  const [coordEvents, setCoordEvents] = useState<LogEvent[]>([]);
  const [workerConvs, setWorkerConvs] = useState<Record<string, Conversation>>({});
  const [workerEvents, setWorkerEvents] = useState<Record<string, LogEvent[]>>({});
  /** Optimistic task→conversation ids from THIS session's launches, so cards
   *  appear before the LAUNCHED line lands in the thread. The thread wins. */
  const [localAssign, setLocalAssign] = useState<Record<string, Record<string, string>>>({});
  const [selectedId, setSelectedId] = useState<string | null>(crew.lastMissionId ?? null);
  const [pickedDefault, setPickedDefault] = useState(!!crew.lastMissionId);
  const [connected, setConnected] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const coordConvId = teammate?.conversation.id ?? null;
  const coordConvIdRef = useRef<string | null>(null);
  coordConvIdRef.current = coordConvId;
  const workerConvsRef = useRef(workerConvs);
  workerConvsRef.current = workerConvs;

  const say = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 6000);
  }, []);

  // ── the coordinator ────────────────────────────────────────────────────────

  const onChangeCrewRef = useRef(props.onChangeCrew);
  onChangeCrewRef.current = props.onChangeCrew;

  const refreshTeammate = useCallback(async () => {
    try {
      setTeammate(await client.getTeammate(crew.coordinatorId));
    } catch (err) {
      // The coordinator is gone (removed in Fountain) — back to connect.
      say(describeError(err));
      onChangeCrewRef.current();
    }
  }, [client, crew.coordinatorId, say]);

  useEffect(() => {
    void refreshTeammate();
  }, [refreshTeammate]);

  const reloadThread = useCallback(async () => {
    const convId = coordConvIdRef.current;
    if (!convId) return;
    try {
      const [t, e] = await Promise.all([client.listTurns(convId), client.listAllEvents(convId, STREAMS)]);
      setCoordTurns(t);
      setCoordEvents(e);
    } catch (err) {
      say(describeError(err));
    }
  }, [client, say]);

  useEffect(() => {
    if (coordConvId) void reloadThread();
  }, [coordConvId, reloadThread]);

  const refreshWorker = useCallback(
    async (convId: string) => {
      try {
        const conv = await client.getConversation(convId);
        setWorkerConvs((m) => ({ ...m, [convId]: conv }));
      } catch {
        // deleted out from under us; the card keeps its last known state
      }
    },
    [client],
  );

  // ── sending to the coordinator: no server queue, so keep one here ─────────
  // 400 conversation_busy / 503 provisioning park the message; the queue is
  // pumped again on the coordinator's terminal turn event (or after
  // Retry-After). Order is preserved — APPROVE, LAUNCHED, RESULTS land in
  // sequence even when the coordinator is mid-turn.

  const queueRef = useRef<string[]>([]);
  const pumpingRef = useRef(false);

  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const prompt = queueRef.current[0]!;
        try {
          const res = await client.sendTeamMessage(crew.coordinatorId, prompt);
          queueRef.current.shift();
          setQueuedCount(queueRef.current.length);
          if (res.conversation_id !== coordConvIdRef.current) await refreshTeammate();
          await reloadThread();
        } catch (err) {
          if (err instanceof ApiError && err.code === "conversation_busy") return; // pumped again on turn end
          if (err instanceof ApiError && (err.code === "provisioning" || err.status === 503)) {
            window.setTimeout(() => void pump(), (err.retryAfter ?? 15) * 1000);
            return;
          }
          queueRef.current.shift();
          setQueuedCount(queueRef.current.length);
          say(describeError(err));
        }
      }
    } finally {
      pumpingRef.current = false;
    }
  }, [client, crew.coordinatorId, refreshTeammate, reloadThread, say]);

  const send = useCallback(
    (prompt: string) => {
      queueRef.current.push(prompt);
      setQueuedCount(queueRef.current.length);
      void pump();
    },
    [pump],
  );

  // ── one SSE connection for the whole fleet ─────────────────────────────────

  const pumpRef = useRef(pump);
  pumpRef.current = pump;
  const refreshTeammateRef = useRef(refreshTeammate);
  refreshTeammateRef.current = refreshTeammate;
  const reloadThreadRef = useRef(reloadThread);
  reloadThreadRef.current = reloadThread;
  const refreshWorkerRef = useRef(refreshWorker);
  refreshWorkerRef.current = refreshWorker;

  useEffect(() => {
    const ctrl = new AbortController();
    let lastEventId: string | null = null;
    let backoff = 1000;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      void client.streamAllEvents({
        lastEventId,
        streams: STREAMS,
        signal: ctrl.signal,
        onOpen: () => {
          setConnected(true);
          backoff = 1000;
          void refreshTeammateRef.current();
          void reloadThreadRef.current();
        },
        onMessage: (msg) => {
          if (msg.id) lastEventId = msg.id;
          if (msg.event === "conversations") {
            // The list changed — a fresh coordinator thread, a worker
            // finishing, a title landing. Cheap to re-fetch what we follow.
            void refreshTeammateRef.current();
            return;
          }
          let ev: StreamEvent;
          try {
            ev = JSON.parse(msg.data) as StreamEvent;
          } catch {
            return;
          }
          if (msg.id) ev.id = Number(msg.id);
          if (ev.conversation_id === coordConvIdRef.current) {
            setCoordEvents((es) => (es.some((e) => e.id === ev.id) ? es : [...es, ev]));
            if (ev.kind === "stage" && ev.stage === "turn") {
              void client.listTurns(ev.conversation_id).then(setCoordTurns).catch(() => undefined);
              if (ev.state !== "started") {
                void client.markRead(ev.conversation_id).catch(() => undefined);
                void pumpRef.current(); // a parked message can go now
              }
            }
            return;
          }
          if (workerConvsRef.current[ev.conversation_id]) {
            setWorkerEvents((m) => {
              const list = m[ev.conversation_id] ?? [];
              return list.some((e) => e.id === ev.id) ? m : { ...m, [ev.conversation_id]: [...list, ev] };
            });
            if (
              ev.kind === "stage" &&
              ((ev.stage === "turn" && ev.state !== "started") || ev.state === "failed" || ev.stage === "terminate")
            ) {
              void refreshWorkerRef.current(ev.conversation_id); // status + token usage
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
  }, [client]);

  // ── derived: the coordinator thread, folded into missions ─────────────────

  const runtime = teammate?.conversation.runtime ?? "claude";
  const coordThread = useMemo(() => {
    const sorted = [...coordTurns].sort((a, b) => a.turn_number - b.turn_number);
    const byTurn = eventsByTurn(coordEvents);
    return sorted.map((turn) => ({ turn, reply: replyText(byTurn.get(turn.id) ?? [], runtime) }));
  }, [coordTurns, coordEvents, runtime]);

  const missions = useMemo(
    () => foldMissions(coordThread.map((t) => ({ prompt: t.turn.prompt, reply: t.reply }))),
    [coordThread],
  );
  const missionsRef = useRef(missions);
  missionsRef.current = missions;

  // First load with no remembered mission: land on the one that needs you.
  useEffect(() => {
    if (pickedDefault || missions.length === 0) return;
    setPickedDefault(true);
    setSelectedId((pendingMission(missions) ?? missions[missions.length - 1]!).plan.id);
  }, [missions, pickedDefault]);

  useEffect(() => {
    if (selectedId) saveCrew(settings.baseUrl, { ...crew, lastMissionId: selectedId });
  }, [selectedId, settings.baseUrl, crew]);

  const mission = selectedId ? missions.find((m) => m.plan.id === selectedId) ?? null : null;

  // A plan just landed (new mission, or a revision superseding the one on
  // screen): jump to it. Known ids seed from the first thread load so a
  // reload doesn't yank the user off the composer.
  const knownIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (knownIdsRef.current === null) {
      if (missions.length > 0 || coordTurns.length > 0) knownIdsRef.current = new Set(missions.map((m) => m.plan.id));
      return;
    }
    const fresh = missions.filter((m) => !knownIdsRef.current!.has(m.plan.id));
    if (fresh.length === 0) return;
    for (const m of fresh) knownIdsRef.current!.add(m.plan.id);
    const current = selectedId ? missions.find((m) => m.plan.id === selectedId) : null;
    if (selectedId === null || current?.status === "superseded") setSelectedId(fresh[fresh.length - 1]!.plan.id);
  }, [missions, selectedId, coordTurns.length]);

  /** task id → conversation id: the thread's LAUNCHED lines, over this session's optimistic launches. */
  const assignmentsOf = useCallback(
    (m: Mission): Record<string, string> => ({ ...(localAssign[m.plan.id] ?? {}), ...m.assignments }),
    [localAssign],
  );
  const localAssignRef = useRef(localAssign);
  localAssignRef.current = localAssign;

  const assignments = mission ? assignmentsOf(mission) : {};

  // ── worker conversations of the selected mission ───────────────────────────

  const fetchingRef = useRef(new Set<string>());
  useEffect(() => {
    if (!mission) return;
    for (const convId of Object.values(assignments)) {
      if (workerConvs[convId] || fetchingRef.current.has(convId)) continue;
      fetchingRef.current.add(convId);
      void (async () => {
        try {
          const [conv, events] = await Promise.all([client.getConversation(convId), client.listAllEvents(convId, STREAMS)]);
          setWorkerConvs((m) => ({ ...m, [convId]: conv }));
          setWorkerEvents((m) => ({ ...m, [convId]: [...events, ...(m[convId] ?? []).filter((e) => !events.some((x) => x.id === e.id))] }));
        } catch (err) {
          say(describeError(err));
        } finally {
          fetchingRef.current.delete(convId);
        }
      })();
    }
    // assignments is derived from mission + localAssign, both in deps
  }, [mission, localAssign, workerConvs, client, say]); // eslint-disable-line

  // ── the board, derived ─────────────────────────────────────────────────────

  const taskViews: TaskView[] = useMemo(() => {
    if (!mission) return [];
    return mission.plan.tasks.map((task) => {
      const convId = assignments[task.id] ?? null;
      const conv = convId ? workerConvs[convId] ?? null : null;
      const events = convId ? workerEvents[convId] ?? [] : [];
      const result = taskResultOf(replyText(events, conv?.runtime ?? "claude"));
      const failure = events.find((e) => e.kind === "stage" && e.state === "failed");
      return {
        task,
        convId,
        status: taskStatus({ assigned: !!convId, conversation: conv, sessionReady: sessionReady(events), result }),
        boot: bootSequence(events),
        blocks: viewBlocks(events, conv?.runtime ?? "claude"),
        result,
        usage: conv?.usage_total ?? null,
        startedAt: conv?.inserted_at ?? null,
        failureStage: failure?.stage ?? null,
      };
    });
    // eslint-disable-next-line
  }, [mission, localAssign, workerConvs, workerEvents]);

  const results: TaskResult[] = useMemo(
    () => taskViews.map((v) => v.result).filter((r): r is TaskResult => r !== null),
    [taskViews],
  );
  const liveCount = taskViews.filter((v) => v.status === "provisioning" || v.status === "working").length;
  const queuedTasks = taskViews.filter((v) => v.status === "queued");
  const settledCount = taskViews.length - liveCount - queuedTasks.length;
  const allSettled = taskViews.length > 0 && liveCount === 0 && queuedTasks.length === 0;

  // Mission clock: since the first computer came up, while any is still working.
  const missionStart = useMemo(() => {
    const starts = taskViews.map((v) => v.startedAt).filter((s): s is string => !!s);
    return starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : null;
  }, [taskViews]);

  useEffect(() => {
    if (liveCount === 0 && queuedCount === 0) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [liveCount, queuedCount]);

  // ── fan-out ────────────────────────────────────────────────────────────────

  const launchingRef = useRef(new Set<string>());
  const autoLaunchRef = useRef(new Set<string>());

  const launchRemaining = useCallback(
    async (missionId: string) => {
      const m = missionsRef.current.find((x) => x.plan.id === missionId);
      if (!m || launchingRef.current.has(missionId)) return;
      launchingRef.current.add(missionId);
      const launched: Record<string, string> = {};
      try {
        const already = { ...(localAssignRef.current[missionId] ?? {}), ...m.assignments };
        for (const task of m.plan.tasks) {
          if (already[task.id]) continue;
          try {
            const conv = await client.createConversation({
              agent_id: crew.workerId,
              prompt: workerPrompt(m.plan, task),
              title: workerTitle(m.plan.id, task),
            });
            launched[task.id] = conv.id;
            setWorkerConvs((map) => ({ ...map, [conv.id]: conv }));
            setWorkerEvents((map) => (map[conv.id] ? map : { ...map, [conv.id]: [] }));
            setLocalAssign((map) => ({ ...map, [missionId]: { ...(map[missionId] ?? {}), [task.id]: conv.id } }));
          } catch (err) {
            if (err instanceof ApiError && err.code === "sandbox_quota_exceeded") {
              if (!autoLaunchRef.current.has(missionId)) {
                autoLaunchRef.current.add(missionId);
                say(`${describeError(err)} Launching what fits — the rest go as computers free up.`);
              }
              break;
            }
            say(describeError(err));
            break;
          }
        }
      } finally {
        launchingRef.current.delete(missionId);
      }
      // The LAUNCHED line makes the mission recoverable from the conversation
      // alone — the coordinator is told to just acknowledge it.
      if (Object.keys(launched).length > 0) send(launchedMessage(missionId, launched));
    },
    [client, crew.workerId, say, send],
  );

  const approveAndLaunch = useCallback(
    (m: Mission) => {
      send(approveMessage(m.plan.id));
      void launchRemaining(m.plan.id);
    },
    [send, launchRemaining],
  );

  // Sequential fallback: a task settling frees a computer — launch a queued one.
  useEffect(() => {
    if (!mission || !autoLaunchRef.current.has(mission.plan.id)) return;
    if (queuedTasks.length === 0) {
      autoLaunchRef.current.delete(mission.plan.id);
      return;
    }
    if (settledCount > 0) void launchRemaining(mission.plan.id);
  }, [mission, settledCount, queuedTasks.length, launchRemaining]);

  // ── synthesis ──────────────────────────────────────────────────────────────

  const synthesizedRef = useRef(new Set<string>());
  const synthesize = useCallback(
    (m: Mission, rs: TaskResult[]) => {
      if (m.resultsSent || m.report || synthesizedRef.current.has(m.plan.id)) return;
      synthesizedRef.current.add(m.plan.id);
      send(resultsMessage(m.plan.id, rs));
    },
    [send],
  );

  // When every task has reported, hand the coordinator the lot.
  useEffect(() => {
    if (!mission || mission.status !== "flight") return;
    const allAssigned = mission.plan.tasks.every((t) => assignments[t.id]);
    if (allAssigned && results.length === mission.plan.tasks.length) synthesize(mission, results);
    // eslint-disable-next-line
  }, [mission, results, synthesize]);

  // ── actions ────────────────────────────────────────────────────────────────

  const interruptTask = useCallback(
    async (convId: string) => {
      try {
        await client.interrupt(convId).catch(() => undefined); // 409 no_turn_running is fine
        await client.terminate(convId);
        await refreshWorker(convId);
      } catch (err) {
        say(describeError(err));
      }
    },
    [client, refreshWorker, say],
  );

  const abortMission = useCallback(() => {
    for (const v of taskViews) {
      if (v.convId && (v.status === "provisioning" || v.status === "working")) void interruptTask(v.convId);
    }
    if (mission) autoLaunchRef.current.delete(mission.plan.id);
  }, [taskViews, interruptTask, mission]);

  const download = useCallback(() => {
    if (!mission) return;
    const appendix: AppendixEntry[] = taskViews.map((v) => ({ task: v.task, result: v.result }));
    const blob = new Blob([reportMarkdown(mission, appendix)], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${mission.plan.id}-report.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [mission, taskViews]);

  // ── render ─────────────────────────────────────────────────────────────────

  const coordWorking = coordThread.some((t) => t.turn.ended_at === null && t.turn.status !== "failed");
  const lastCoordTurn = coordThread[coordThread.length - 1] ?? null;
  const coordTail: ViewBlock[] = useMemo(() => {
    if (!coordWorking || !lastCoordTurn) return [];
    const byTurn = eventsByTurn(coordEvents);
    return viewBlocks(byTurn.get(lastCoordTurn.turn.id) ?? [], runtime);
  }, [coordWorking, lastCoordTurn, coordEvents, runtime]);

  const appendix: AppendixEntry[] = taskViews.map((v) => ({ task: v.task, result: v.result }));
  const inFlight = mission?.status === "flight" && !allSettled;

  return (
    <div className="console">
      <header>
        <div className="wordmark small">
          MISSION<span>CONTROL</span>
        </div>
        {inFlight && missionStart && (
          <div className="mission-clock mono" title="mission elapsed">
            T+{elapsed(missionStart, now)}
          </div>
        )}
        <div className="head-status">
          <span className={connected ? "dot on" : "dot"} title={connected ? "live" : "reconnecting"} />
          <span className="fineprint">
            {queuedCount > 0
              ? `${queuedCount} message${queuedCount === 1 ? "" : "s"} queued for the coordinator`
              : coordWorking
                ? "coordinator working…"
                : teammate?.presence.label ?? "…"}
          </span>
          <button className="linkish" onClick={props.onChangeCrew}>
            change crew
          </button>
          <button className="linkish" onClick={props.onSignOut}>
            sign out
          </button>
        </div>
      </header>

      {toast && <div className="toast">{toast}</div>}

      <div className="body">
        <aside className="rail">
          <button className="primary newmission" onClick={() => setSelectedId(null)}>
            + New mission
          </button>
          <div className="rail-list">
            {[...missions].reverse().map((m) => (
              <button
                key={m.plan.id}
                className={`rail-item ${m.plan.id === selectedId ? "active" : ""}`}
                onClick={() => setSelectedId(m.plan.id)}
              >
                <span className={`chip chip-${m.status}`}>{m.status}</span>
                <span className="rail-objective">{m.plan.objective}</span>
                <span className="rail-id mono">{m.plan.id}</span>
              </button>
            ))}
            {missions.length === 0 && <p className="fineprint">No missions yet.</p>}
          </div>
          <footer className="fineprint">
            Runs on <a href="https://github.com/BinaryBourbon/fountain">Fountain</a> ·{" "}
            <a href="https://github.com/managoat/mission-control">source</a>
          </footer>
        </aside>

        <main className="stage">
          {!mission && (
            <Composer
              busy={coordWorking || queuedCount > 0}
              tail={coordTail}
              onSubmit={(text) => send(text)}
            />
          )}
          {mission && (mission.status === "awaiting" || mission.status === "superseded") && (
            <>
              {mission.status === "superseded" && <p className="banner">Superseded by a newer plan.</p>}
              {coordWorking && <CoordinatorTail tail={coordTail} />}
              <PlanView
                mission={mission}
                busy={mission.status !== "awaiting" || coordWorking || queuedCount > 0}
                onApprove={approveAndLaunch}
                onRevise={send}
              />
            </>
          )}
          {mission && (mission.status === "launching" || mission.status === "flight") && (
            <div className="board">
              <div className="mission-head">
                <span className="mission-id">{mission.plan.id}</span>
                <h2>{mission.plan.objective}</h2>
                <div className="board-actions">
                  {queuedTasks.length > 0 && (
                    <button onClick={() => void launchRemaining(mission.plan.id)}>
                      Launch remaining {queuedTasks.length}
                    </button>
                  )}
                  {results.length > 0 && !mission.report && !mission.resultsSent && allSettled && (
                    <button onClick={() => synthesize(mission, results)}>Synthesize anyway</button>
                  )}
                  {liveCount > 0 && (
                    <button className="danger" onClick={abortMission}>
                      Abort mission
                    </button>
                  )}
                </div>
              </div>
              {mission.status === "launching" && taskViews.every((v) => !v.convId) && (
                <p className="fineprint">Ignition — launching one computer per task…</p>
              )}
              <div className="task-grid">
                {taskViews.map((v) => (
                  <TaskCard key={v.task.id} view={v} now={now} onInterrupt={(id) => void interruptTask(id)} />
                ))}
              </div>
              {mission.resultsSent && !mission.report && (
                <p className="fineprint synth-note">All results in — the coordinator is writing the report…</p>
              )}
            </div>
          )}
          {mission && mission.status === "complete" && <Report mission={mission} appendix={appendix} onDownload={download} />}
        </main>
      </div>
    </div>
  );
}

// ── the mission composer ─────────────────────────────────────────────────────

function Composer(props: { busy: boolean; tail: ViewBlock[]; onSubmit: (text: string) => void }) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    if (!draft.trim() || props.busy) return;
    props.onSubmit(draft.trim());
    setDraft("");
  };
  return (
    <div className="composer-view">
      <h1>What's the mission?</h1>
      <p className="fineprint">
        The coordinator breaks it into up to 5 independent tasks — one sandboxed agent each. Nothing launches until you
        approve the plan.
      </p>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && submit()}
        placeholder={
          "Research the top 5 static site generators and recommend one…\nWrite a launch plan for our new CLI…\nCompare three approaches to caching for a read-heavy API…"
        }
        rows={6}
        autoFocus
      />
      <div className="composer-actions">
        <button className="primary big" onClick={submit} disabled={props.busy || !draft.trim()}>
          {props.busy ? "Coordinator working…" : "Plan the mission"}
        </button>
        <span className="fineprint">⌘⏎ to send</span>
      </div>
      {props.busy && <CoordinatorTail tail={props.tail} />}
    </div>
  );
}

function CoordinatorTail(props: { tail: ViewBlock[] }) {
  const text = props.tail
    .filter((b): b is Extract<ViewBlock, { kind: "text" | "thinking" }> => b.kind === "text" || b.kind === "thinking")
    .map((b) => b.body)
    .join("")
    .trim();
  return (
    <div className="coord-tail">
      <span className="pulse" /> coordinator: {text ? "…" + text.slice(-280) : "thinking…"}
    </div>
  );
}
