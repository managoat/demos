/**
 * Watchtower: one dedicated teammate on a cron schedule, and a dashboard that
 * is nothing but a fold over its conversation — watch-state blocks are the
 * metric history, watch-incident blocks are the feed, the newest watch-config
 * is the watchlist. The protocol lives in lib/protocol.ts; the agent's rules
 * in lib/spec.ts. Streaming/reconnect follows jhgaylor/dns-desk.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, describeError, FountainClient } from "./api/client";
import type { LogEvent, Schedule, TeamEvent, Teammate, Turn } from "./api/types";
import { assistantText, blocksForTurn, type Block } from "./lib/acp";
import { completeLoginIfCallback, revoke } from "./lib/oauth";
import { clearSettings, loadSettings, saveSettings, type Settings } from "./lib/settings";
import { clearTowerId, loadTowerId, saveTowerId } from "./lib/tower";
import { effectiveWatchlist, foldConversation, watchlistMessage, type TowerView } from "./lib/protocol";
import { DEFAULT_CRON, timeAgo } from "./lib/schedule";
import { PATROL_PROMPT } from "./lib/spec";
import { Connect } from "./components/Connect";
import { Hire } from "./components/Hire";
import { Incidents } from "./components/Incidents";
import { SchedulePanel } from "./components/SchedulePanel";
import { Tile } from "./components/Tiles";

const STREAMS = ["acp", "stdout", "stage"];

type Phase = "boot" | "connect" | "hire" | "tower";

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [towerId, setTowerId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("boot");
  const [connectError, setConnectError] = useState<string | null>(null);

  const [teammate, setTeammate] = useState<Teammate | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const client = useMemo(() => (settings ? new FountainClient(settings) : null), [settings]);
  const convId = teammate?.conversation.id ?? null;
  const convIdRef = useRef<string | null>(null);
  convIdRef.current = convId;
  /** Messages waiting for the running turn to end — Fountain has no queue. */
  const queueRef = useRef<string[]>([]);

  // Re-render every 30 s so "4 min ago" stays honest.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 30000);
    return () => window.clearInterval(id);
  }, []);

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

  // Settings arrived (boot, OAuth callback, or a pasted key): pick the screen.
  useEffect(() => {
    if (!settings) return;
    const tower = loadTowerId(settings.baseUrl);
    setTowerId(tower);
    setPhase(tower ? "tower" : "hire");
  }, [settings]);

  const signOut = useCallback(() => {
    if (settings?.via === "oauth") void revoke(settings.baseUrl, settings.apiKey);
    clearSettings();
    setSettings(null);
    setTowerId(null);
    setTeammate(null);
    setPhase("connect");
  }, [settings]);

  const changeTower = useCallback(() => {
    if (settings) clearTowerId(settings.baseUrl);
    setTowerId(null);
    setTeammate(null);
    setSchedules(null);
    setPhase("hire");
  }, [settings]);

  // ── the tower's conversation ──────────────────────────────────────────────

  const refreshTeammate = useCallback(async () => {
    if (!client || !towerId) return;
    try {
      setTeammate(await client.getTeammate(towerId));
    } catch (err) {
      // The teammate is gone (removed in Fountain) — back to hire.
      setTeammate(null);
      if (settings) clearTowerId(settings.baseUrl);
      setTowerId(null);
      setPhase("hire");
      say(describeError(err));
    }
  }, [client, towerId, settings, say]);

  useEffect(() => {
    if (phase === "tower") void refreshTeammate();
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

  const reloadSchedules = useCallback(async () => {
    if (!client || !towerId) return;
    try {
      setSchedules(await client.listSchedules(towerId));
    } catch (err) {
      say(describeError(err));
    }
  }, [client, towerId, say]);

  useEffect(() => {
    if (phase === "tower") void reloadSchedules();
  }, [phase, reloadSchedules]);

  // ── send, with a client-side queue behind the running turn ───────────────

  const send = useCallback(
    async (text: string) => {
      if (!client || !towerId || !text.trim()) return;
      setBusy(true);
      try {
        await client.sendMessage(towerId, text.trim());
        await Promise.all([refreshTeammate(), reloadThread()]);
      } catch (err) {
        if (err instanceof ApiError && err.code === "conversation_busy") {
          queueRef.current.push(text);
          say("Watchtower is mid-patrol — queued, sends when it's done.");
        } else if (err instanceof ApiError && err.code === "provisioning") {
          const wait = (err.retryAfter ?? 30) * 1000;
          window.setTimeout(() => void send(text), wait);
          say("Watchtower's computer is still starting — will retry.");
        } else {
          say(describeError(err));
        }
      } finally {
        setBusy(false);
      }
    },
    [client, towerId, refreshTeammate, reloadThread, say],
  );
  const sendRef = useRef(send);
  sendRef.current = send;

  // ── stream: append live events, flush the queue on turn boundaries ───────

  useEffect(() => {
    if (!client || phase !== "tower" || !towerId) return;
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
          if (msg.event === "schedule") {
            void reloadSchedules();
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
            if (ev.agent_id === towerId) void refreshTeammate();
            return;
          }
          setEvents((es) => (es.some((e) => e.id === ev.id) ? es : [...es, ev]));
          if (ev.kind === "stage" && ev.stage === "turn") {
            void client.listTurns(ev.conversation_id).then(setTurns).catch(() => undefined);
            if (ev.state !== "started") {
              void client.markRead(ev.conversation_id).catch(() => undefined);
              const queued = queueRef.current.shift();
              if (queued) void sendRef.current(queued);
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
  }, [client, phase, towerId, refreshTeammate, reloadThread, reloadSchedules]);

  // ── derived: replies per turn, the folded tower view ─────────────────────

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

  const view: TowerView = useMemo(
    () => foldConversation(thread.map((t) => ({ prompt: t.turn.prompt, reply: t.reply }))),
    [thread],
  );
  const sites = effectiveWatchlist(view);
  const working = thread.some((t) => t.turn.ended_at === null && t.turn.status !== "failed");

  /** The in-flight turn's blocks — the tool chips streaming while it digs. */
  const liveBlocks: Block[] = useMemo(() => {
    const running = thread.find((t) => t.turn.ended_at === null && t.turn.status !== "failed");
    return running ? blocksForTurn(running.events, runtime) : [];
  }, [thread, runtime]);

  const patrol = useMemo(() => {
    if (!schedules) return null;
    return schedules.find((s) => !s.one_off && s.prompt === PATROL_PROMPT) ?? schedules.find((s) => !s.one_off) ?? schedules[0] ?? null;
  }, [schedules]);

  // ── actions ───────────────────────────────────────────────────────────────

  const setWatchlist = useCallback(
    async (list: string[]) => {
      await send(watchlistMessage(list));
      // The schedule IS the product: make sure the patrol exists on first setup.
      if (!client || !towerId) return;
      try {
        const cur = schedules ?? (await client.listSchedules(towerId));
        if (!cur.some((s) => !s.one_off && s.prompt === PATROL_PROMPT)) {
          await client.createSchedule(towerId, { cron: DEFAULT_CRON, prompt: PATROL_PROMPT, name: "patrol", one_off: false });
        }
        await reloadSchedules();
      } catch (err) {
        say(describeError(err));
      }
    },
    [send, client, towerId, schedules, reloadSchedules, say],
  );

  const addSite = useCallback(
    (url: string) => {
      const u = url.trim();
      if (!u) return;
      const cur = sites ?? [];
      if (cur.includes(u)) return;
      void setWatchlist([...cur, u]);
    },
    [sites, setWatchlist],
  );

  const removeSite = useCallback(
    (url: string) => {
      const cur = sites ?? [];
      void setWatchlist(cur.filter((s) => s !== url));
    },
    [sites, setWatchlist],
  );

  const investigate = useCallback((url: string) => void send(`Investigate ${url}`), [send]);

  const runNow = useCallback(async () => {
    if (!client || !towerId) return;
    if (!patrol) {
      void send(PATROL_PROMPT);
      return;
    }
    try {
      await client.runSchedule(towerId, patrol.id);
      await reloadSchedules();
    } catch (err) {
      say(describeError(err));
    }
  }, [client, towerId, patrol, send, reloadSchedules, say]);

  const setCadence = useCallback(
    async (cron: string) => {
      if (!client || !towerId || !patrol) return;
      try {
        await client.updateSchedule(towerId, patrol.id, { cron });
        await reloadSchedules();
      } catch (err) {
        say(describeError(err));
      }
    },
    [client, towerId, patrol, reloadSchedules, say],
  );

  const togglePatrol = useCallback(
    async (enabled: boolean) => {
      if (!client || !towerId || !patrol) return;
      try {
        await client.updateSchedule(towerId, patrol.id, { enabled });
        await reloadSchedules();
      } catch (err) {
        say(describeError(err));
      }
    },
    [client, towerId, patrol, reloadSchedules, say],
  );

  // ── render ────────────────────────────────────────────────────────────────

  if (phase === "boot") return <div className="setup" />;
  if (phase === "connect" || !settings || !client)
    return (
      <>
        <Connect
          error={connectError}
          onPaste={(s) => {
            saveSettings(s);
            setConnectError(null);
            setSettings(s);
          }}
        />
        <Footer />
      </>
    );
  if (phase === "hire" || !towerId)
    return (
      <>
        <Hire
          client={client}
          onSignOut={signOut}
          onReady={(agentId) => {
            saveTowerId(settings.baseUrl, agentId);
            setTowerId(agentId);
            setPhase("tower");
          }}
        />
        <Footer />
      </>
    );

  const firstRun = !sites || sites.length === 0;

  return (
    <div className="tower">
      <header>
        <div className="wordmark small">
          WATCH<span>TOWER</span>
        </div>
        {view.lastCheckedAt && <span className="fineprint headline">last patrol {timeAgo(view.lastCheckedAt)}</span>}
        <div className="head-status">
          <span className={connected ? "dot on" : "dot"} title={connected ? "live" : "reconnecting"} />
          <span className="fineprint">{working ? "on patrol…" : teammate?.presence.label ?? "…"}</span>
          <button className="linkish" onClick={changeTower}>
            change tower
          </button>
          <button className="linkish" onClick={signOut}>
            sign out
          </button>
        </div>
      </header>

      {toast && <div className="toast">{toast}</div>}

      {firstRun ? (
        <FirstWatch busy={busy} pending={view.pending !== null} onStart={(list) => void setWatchlist(list)} />
      ) : (
        <div className="board">
          <div className="main">
            <SchedulePanel
              schedule={patrol}
              busy={busy}
              working={working}
              onRunNow={() => void runNow()}
              onCadence={(cron) => void setCadence(cron)}
              onToggle={(enabled) => void togglePatrol(enabled)}
            />
            <div className="tiles">
              {sites.map((url) => (
                <Tile
                  key={url}
                  url={url}
                  samples={view.samples.get(url) ?? []}
                  busy={busy}
                  onInvestigate={investigate}
                  onRemove={removeSite}
                />
              ))}
              <AddSite busy={busy} onAdd={addSite} />
            </div>
            <p className="fineprint">
              History straight from the agent's reports — every point above is a watch-state block in the conversation.
              The conversation is the metrics database.
            </p>
          </div>
          <aside className="side">
            {working && <LiveActivity blocks={liveBlocks} />}
            <h3>Incidents</h3>
            <Incidents cards={view.incidents} />
            <Composer busy={busy} onSend={(text) => void send(text)} />
          </aside>
        </div>
      )}
      <Footer />
    </div>
  );
}

// ── first run: what should I watch? ─────────────────────────────────────────

function FirstWatch(props: { busy: boolean; pending: boolean; onStart: (sites: string[]) => void }) {
  const [list, setList] = useState<string[]>([]);
  const [draft, setDraft] = useState("");

  const add = () => {
    const u = draft.trim();
    if (!u || list.includes(u)) return;
    setList([...list, u]);
    setDraft("");
  };

  return (
    <div className="setup">
      <div className="setup-card">
        <h2 className="firstwatch-title">What should I watch?</h2>
        <p className="fineprint">
          URLs or bare hostnames. Every patrol probes each one for status, latency, TLS expiry and DNS — with real
          tools, from Watchtower's own computer.
        </p>
        {props.pending && <p className="fineprint">Sending the watchlist to Watchtower…</p>}
        <div className="addrow">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="https://example.com"
            autoFocus
          />
          <button onClick={add} disabled={!draft.trim()}>
            Add
          </button>
        </div>
        {list.map((u) => (
          <div key={u} className="sitelist-row">
            <code>{u}</code>
            <button className="linkish" onClick={() => setList(list.filter((x) => x !== u))}>
              remove
            </button>
          </div>
        ))}
        <button className="primary" disabled={props.busy || props.pending || list.length === 0} onClick={() => props.onStart(list)}>
          Start watching {list.length > 0 ? `${list.length} site${list.length === 1 ? "" : "s"}` : ""}
        </button>
      </div>
    </div>
  );
}

function AddSite(props: { busy: boolean; onAdd: (url: string) => void }) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    if (!draft.trim()) return;
    props.onAdd(draft);
    setDraft("");
  };
  return (
    <div className="tile tile-add">
      <span className="fineprint">Watch another site</span>
      <div className="addrow">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="https://…"
        />
        <button onClick={submit} disabled={props.busy || !draft.trim()}>
          Add
        </button>
      </div>
    </div>
  );
}

// ── the live feed: tool chips streaming while the agent digs ────────────────

function LiveActivity(props: { blocks: Block[] }) {
  const tools = props.blocks.filter((b): b is Extract<Block, { kind: "tool" }> => b.kind === "tool");
  const lastText = [...props.blocks].reverse().find((b): b is Extract<Block, { kind: "text" }> => b.kind === "text");
  return (
    <div className="live">
      <h3>
        On it <span className="pulse" />
      </h3>
      {tools.map((t, i) => (
        <div key={t.id ?? i} className={`toolchip tool-${t.status}`}>
          <b>{t.name}</b>
          {t.summary && <span className="toolsum">{t.summary}</span>}
        </div>
      ))}
      {lastText && <p className="live-text">{lastText.body.slice(-280)}</p>}
    </div>
  );
}

function Composer(props: { busy: boolean; onSend: (text: string) => void }) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    if (!draft.trim()) return;
    props.onSend(draft);
    setDraft("");
  };
  return (
    <div className="composer">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder="Ask Watchtower — “why is checkout slow?”"
        disabled={props.busy}
      />
      <button className="primary" onClick={submit} disabled={props.busy || !draft.trim()}>
        Send
      </button>
    </div>
  );
}

function Footer() {
  return (
    <footer className="footer fineprint">
      Runs on <a href="https://github.com/BinaryBourbon/fountain">Fountain</a> ·{" "}
      <a href="https://github.com/managoat/watchtower">source</a>
    </footer>
  );
}
