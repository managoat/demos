/**
 * Table Talk: one analyst teammate, one conversation per dataset. The left
 * rail is a localStorage index of conversation ids; everything shown is
 * derived from turns + table-report blocks (lib/protocol.ts) — the
 * conversation is the analysis notebook. Streaming/reconnect follows
 * jhgaylor/dns-desk.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, describeError, FountainClient } from "./api/client";
import type { LogEvent, TeamEvent, Teammate, Turn } from "./api/types";
import { blocksForTurn } from "./lib/acp";
import { clearAnalystId, loadAnalystId, saveAnalystId } from "./lib/analyst";
import type { Dataset } from "./lib/csv";
import { forgetDataset, loadDatasets, repointDataset, saveDataset, type DatasetEntry } from "./lib/datasets";
import { fmtNum } from "./lib/format";
import { completeLoginIfCallback, revoke } from "./lib/oauth";
import { buildDataPrompt, hasReportFence, parseDataPrompt, parseReports, stripBlocks, type TableReport } from "./lib/protocol";
import { clearSettings, loadSettings, saveSettings, type Settings } from "./lib/settings";
import { AGENT_DESCRIPTION, AGENT_MODEL, AGENT_NAME, AGENT_RUNTIME, SYSTEM_PROMPT } from "./lib/spec";
import { Connect } from "./components/Connect";
import { NewDataset } from "./components/NewDataset";
import { ReportView, type ToolBlock } from "./components/Report";

const STREAMS = ["acp", "stdout", "stage"];

type Phase = "boot" | "connect" | "app";

interface Entry {
  turn: Turn;
  reply: string;
  tools: ToolBlock[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [phase, setPhase] = useState<Phase>("boot");
  const [connectError, setConnectError] = useState<string | null>(null);

  const [analystId, setAnalystId] = useState<string | null>(null);
  const [teammate, setTeammate] = useState<Teammate | null>(null);
  const [datasets, setDatasets] = useState<DatasetEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const client = useMemo(() => (settings ? new FountainClient(settings) : null), [settings]);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

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
        setConnectError(err instanceof Error ? err.message : String(err));
      }
      const stored = loadSettings();
      if (stored) setSettings(stored);
      else setPhase("connect");
    })();
  }, []);

  // Settings arrived (boot, OAuth callback, or a pasted key): open the desk.
  useEffect(() => {
    if (!settings) return;
    setAnalystId(loadAnalystId(settings.baseUrl));
    const known = loadDatasets(settings.baseUrl);
    setDatasets(known);
    setActiveId(known[0]?.conversationId ?? null);
    setPhase("app");
  }, [settings]);

  const signOut = useCallback(() => {
    if (settings?.via === "oauth") void revoke(settings.baseUrl, settings.apiKey);
    clearSettings();
    setSettings(null);
    setAnalystId(null);
    setTeammate(null);
    setDatasets([]);
    setActiveId(null);
    setPhase("connect");
  }, [settings]);

  // ── the analyst and the active conversation ───────────────────────────────

  const refreshTeammate = useCallback(async () => {
    if (!client || !analystId) return;
    try {
      setTeammate(await client.getTeammate(analystId));
    } catch {
      // Removed in Fountain — hire again on the next analyze.
      setTeammate(null);
      if (settings) clearAnalystId(settings.baseUrl);
      setAnalystId(null);
    }
  }, [client, analystId, settings]);

  useEffect(() => {
    if (phase === "app" && analystId) void refreshTeammate();
  }, [phase, analystId, refreshTeammate]);

  const reloadThread = useCallback(async () => {
    if (!client || !activeId) return;
    try {
      const [t, e] = await Promise.all([client.listTurns(activeId), client.listAllEvents(activeId, STREAMS)]);
      setTurns(t);
      setEvents(e);
    } catch (err) {
      say(describeError(err));
    }
  }, [client, activeId, say]);

  useEffect(() => {
    setTurns([]);
    setEvents([]);
    if (activeId) void reloadThread();
  }, [activeId, reloadThread]);

  // ── stream: append live events, resync on turn boundaries ────────────────

  useEffect(() => {
    if (!client || phase !== "app" || !analystId) return;
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
          if (ev.conversation_id !== activeIdRef.current) {
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

  // ── derived: the thread of the active dataset ─────────────────────────────

  const runtime = teammate?.conversation.runtime ?? "claude";
  const thread: Entry[] = useMemo(() => {
    const sorted = [...turns].sort((a, b) => a.turn_number - b.turn_number);
    const byTurn = new Map<string, LogEvent[]>();
    for (const ev of events) {
      if (!ev.turn_id) continue;
      const list = byTurn.get(ev.turn_id);
      if (list) list.push(ev);
      else byTurn.set(ev.turn_id, [ev]);
    }
    return sorted.map((turn) => {
      const blocks = blocksForTurn(byTurn.get(turn.id) ?? [], runtime);
      return {
        turn,
        reply: blocks
          .filter((b): b is Extract<typeof b, { kind: "text" }> => b.kind === "text")
          .map((b) => b.body)
          .join("")
          .trim(),
        tools: blocks.filter((b): b is ToolBlock => b.kind === "tool"),
      };
    });
  }, [turns, events, runtime]);

  const working = thread.some((t) => t.turn.ended_at === null && t.turn.status !== "failed");
  const live = activeId !== null && teammate?.conversation.id === activeId;
  const activeEntry = datasets.find((d) => d.conversationId === activeId) ?? null;

  // ── hiring and sending, with a patient retry while the computer starts ────

  const withStartupRetry = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof ApiError && (err.code === "provisioning" || err.code === "conversation_busy") && attempt < 20) {
          setStatus(
            err.code === "provisioning"
              ? "Setting up the analyst's computer — the first time takes a minute…"
              : "The analyst is finishing something up — waiting…",
          );
          await sleep(Math.min(err.retryAfter ?? 15, 30) * 1000);
          continue;
        }
        throw err;
      }
    }
  }, []);

  const ensureAnalyst = useCallback(async (): Promise<string> => {
    if (!client || !settings) throw new Error("Not connected.");
    if (analystId) return analystId;
    const team = await client.listTeam();
    let agentId = team.find((t) => t.agent.name === AGENT_NAME)?.agent_id ?? null;
    if (!agentId) {
      setStatus("Hiring your analyst…");
      const existing = (await client.findAgents(AGENT_NAME)).find((a) => a.name === AGENT_NAME);
      const agent = existing
        ? await client.updateAgent(existing.id, { description: AGENT_DESCRIPTION, system: SYSTEM_PROMPT })
        : await client.createAgent({
            name: AGENT_NAME,
            description: AGENT_DESCRIPTION,
            model: AGENT_MODEL,
            runtime: AGENT_RUNTIME,
            system: SYSTEM_PROMPT,
          });
      await client.addTeammate({ agent_id: agent.id });
      agentId = agent.id;
    }
    saveAnalystId(settings.baseUrl, agentId);
    setAnalystId(agentId);
    return agentId;
  }, [client, settings, analystId]);

  const analyze = useCallback(
    async (dataset: Dataset) => {
      if (!client || !settings) return;
      setBusy(true);
      setStatus(null);
      try {
        const agentId = await ensureAnalyst();
        const tm = await client.getTeammate(agentId);
        // Each dataset gets its own conversation: rotate to a fresh thread
        // unless the current one is still unused (a just-hired analyst).
        if (tm.conversation.turn_count > 0 || datasets.some((d) => d.conversationId === tm.conversation.id)) {
          await withStartupRetry(() => client.startFreshThread(agentId));
        }
        setStatus("Sending the data…");
        const res = await withStartupRetry(() =>
          client.sendMessage(agentId, buildDataPrompt(dataset.filename, dataset.csvText, dataset.notice)),
        );
        setDatasets(
          saveDataset(settings.baseUrl, {
            conversationId: res.conversation_id,
            filename: dataset.filename,
            rows: dataset.rows.length,
            cols: dataset.headers.length,
            createdAt: new Date().toISOString(),
          }),
        );
        setActiveId(res.conversation_id);
        void refreshTeammate();
      } catch (err) {
        say(describeError(err));
      } finally {
        setBusy(false);
        setStatus(null);
      }
    },
    [client, settings, datasets, ensureAnalyst, withStartupRetry, refreshTeammate, say],
  );

  const send = useCallback(
    async (text: string) => {
      if (!client || !settings || !analystId || !activeId || !text.trim()) return;
      setBusy(true);
      try {
        const res = await withStartupRetry(() => client.sendMessage(analystId, text.trim()));
        if (res.conversation_id !== activeId) {
          // The old conversation was past resuming; the analysis continues in
          // a replacement (the CSV may need re-dropping — the analyst will say).
          setDatasets(repointDataset(settings.baseUrl, activeId, res.conversation_id));
          setActiveId(res.conversation_id);
        } else {
          await reloadThread();
        }
        void refreshTeammate();
      } catch (err) {
        say(describeError(err));
      } finally {
        setBusy(false);
        setStatus(null);
      }
    },
    [client, settings, analystId, activeId, withStartupRetry, reloadThread, refreshTeammate, say],
  );

  const forget = useCallback(
    (conversationId: string) => {
      if (!settings) return;
      setDatasets(forgetDataset(settings.baseUrl, conversationId));
      if (activeId === conversationId) setActiveId(null);
    },
    [settings, activeId],
  );

  // ── render ────────────────────────────────────────────────────────────────

  if (phase === "boot") return <div className="setup" />;
  if (phase === "connect" || !settings || !client)
    return (
      <Connect
        error={connectError}
        onPaste={(s) => {
          saveSettings(s);
          setConnectError(null);
          setSettings(s);
        }}
      />
    );

  return (
    <div className="shell">
      <aside className="rail">
        <div className="wordmark small">
          Table<span>Talk</span>
        </div>
        <button className="primary newbtn" onClick={() => setActiveId(null)} disabled={busy}>
          + New dataset
        </button>
        <nav className="rail-list">
          {datasets.map((d) => (
            <div key={d.conversationId} className={d.conversationId === activeId ? "railitem active" : "railitem"}>
              <button className="railmain" onClick={() => setActiveId(d.conversationId)}>
                <b>{d.filename}</b>
                <span>
                  {fmtNum(d.rows)} × {fmtNum(d.cols)}
                  {teammate?.conversation.id === d.conversationId ? " · live" : ""}
                </span>
              </button>
              <button className="railx" title="Forget this dataset" onClick={() => forget(d.conversationId)}>
                ×
              </button>
            </div>
          ))}
          {datasets.length === 0 && <p className="fineprint">No datasets yet.</p>}
        </nav>
        <div className="rail-foot">
          <div className="head-status">
            <span className={connected ? "dot on" : "dot"} title={connected ? "live" : analystId ? "reconnecting" : "no analyst yet"} />
            <span className="fineprint">{working ? "analyzing…" : teammate?.presence.label ?? "no analyst yet"}</span>
          </div>
          <button className="linkish" onClick={signOut}>
            sign out
          </button>
          <p className="fineprint">
            Runs on <a href="https://github.com/BinaryBourbon/fountain">Fountain</a> ·{" "}
            <a href="https://github.com/managoat/table-talk">source</a>
          </p>
        </div>
      </aside>

      {toast && <div className="toast">{toast}</div>}

      <main className="main">
        {activeId === null ? (
          <NewDataset busy={busy} status={status} onAnalyze={(d) => void analyze(d)} />
        ) : (
          <DatasetView
            entry={activeEntry}
            thread={thread}
            live={live}
            busy={busy}
            working={working}
            status={status}
            onSend={(text) => void send(text)}
          />
        )}
      </main>
    </div>
  );
}

// ── one dataset's notebook: hand-off, prose, report sections, composer ──────

function DatasetView(props: {
  entry: DatasetEntry | null;
  thread: Entry[];
  live: boolean;
  busy: boolean;
  working: boolean;
  status: string | null;
  onSend: (text: string) => void;
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
    <div className="dataset">
      <div className="feed">
        {props.thread.length === 0 && <p className="fineprint center-text">Loading the analysis…</p>}
        {props.thread.map(({ turn, reply, tools }) => {
          const handoff = parseDataPrompt(turn.prompt);
          const prose = stripBlocks(reply);
          const reports = parseReports(reply);
          const finished = turn.ended_at !== null || turn.status === "failed";
          return (
            <div key={turn.id} className="entry">
              {handoff ? (
                <div className="handoff">
                  You shared <b>{handoff.filename}</b>
                </div>
              ) : (
                <div className="bubble you">{turn.prompt}</div>
              )}
              {prose && <div className="bubble them">{prose}</div>}
              {reports.map((r: TableReport, i: number) => (
                <ReportView key={r.id} report={r} tools={i === 0 ? tools : []} />
              ))}
              {handoff && finished && reply !== "" && reports.length === 0 && (
                <p className="fineprint">
                  {hasReportFence(reply) ? "Couldn't read the charts in this reply." : "No charts in this reply."}
                </p>
              )}
              {!finished && <div className="state-note">{props.status ?? "analyzing…"}</div>}
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      {props.live ? (
        <div className="composer">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Ask about your data — “which month was the best?”"
            disabled={props.busy || props.working}
          />
          <button className="primary" onClick={submit} disabled={props.busy || props.working || !draft.trim()}>
            {props.busy ? "Sending…" : "Ask"}
          </button>
        </div>
      ) : (
        <div className="composer archived">
          <p className="fineprint">
            {props.entry
              ? `This analysis is archived — the analyst has moved on to a newer dataset. Drop ${props.entry.filename} again to keep asking.`
              : "This analysis is archived."}
          </p>
        </div>
      )}
    </div>
  );
}
