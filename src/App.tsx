/**
 * Arena: one prompt to several brains at once, each in its own Fountain
 * conversation, streaming into equal columns. Contenders are hired lazily
 * (agent + teammate per model), reused across rounds; rounds and votes live
 * in localStorage; everything shown is derived from turns + events.
 * Streaming/reconnect follows jhgaylor/dns-desk.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, describeError, FountainClient } from "./api/client";
import type { Catalog, LogEvent, TeamEvent, Teammate, Turn } from "./api/types";
import { blocksForTurn } from "./lib/acp";
import {
  columnStatus,
  defaultSelection,
  groupByProvider,
  distinctModels,
  keyId,
  loadAgentIds,
  loadRounds,
  pickerKeys,
  saveAgentId,
  saveRounds,
  scoreboard,
  shuffled,
  turnMetrics,
  turnsForRound,
  type ContenderKey,
  type Round,
  type RoundContender,
  type RuntimePhase,
} from "./lib/arena";
import { AGENT_DESCRIPTION, agentNameFor, runtimeFor, SYSTEM_PROMPT } from "./lib/spec";
import { completeLoginIfCallback, revoke } from "./lib/oauth";
import { clearSettings, loadSettings, saveSettings, type Settings } from "./lib/settings";
import { Column, type ColumnData } from "./components/Column";
import { Scoreboard } from "./components/Scoreboard";
import { Setup } from "./components/Setup";

const STREAMS = ["acp", "stdout", "stage"];
const MAX_CONTENDERS = 4;
const MIN_CONTENDERS = 2;

type Phase = "boot" | "setup" | "arena";

interface Runtime {
  phase: RuntimePhase;
  message?: string;
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [phase, setPhase] = useState<Phase>("boot");
  const [setupError, setSetupError] = useState<string | null>(null);

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selection, setSelection] = useState<ContenderKey[]>([]);
  const [blind, setBlind] = useState(true);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [viewedId, setViewedId] = useState<string | null>(null);
  const [turnsByConv, setTurnsByConv] = useState<Record<string, Turn[]>>({});
  const [eventsByConv, setEventsByConv] = useState<Record<string, LogEvent[]>>({});
  const [runtime, setRuntime] = useState<Record<string, Runtime>>({});
  const [fighting, setFighting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [showBoard, setShowBoard] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reloadKey, setReloadKey] = useState(0);

  const client = useMemo(() => (settings ? new FountainClient(settings) : null), [settings]);
  const baseUrl = settings?.baseUrl ?? null;

  const roundsRef = useRef<Round[]>([]);
  roundsRef.current = rounds;
  const blindRef = useRef(blind);
  blindRef.current = blind;
  const timersRef = useRef<Map<string, number>>(new Map());

  const say = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 6000);
  }, []);

  const mutateRounds = useCallback(
    (fn: (rs: Round[]) => Round[]) => {
      setRounds((prev) => {
        const next = fn(prev);
        roundsRef.current = next;
        if (baseUrl) saveRounds(baseUrl, next);
        return next;
      });
    },
    [baseUrl],
  );

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

  useEffect(() => {
    if (!settings) return;
    const stored = loadRounds(settings.baseUrl);
    setRounds(stored);
    roundsRef.current = stored;
    setViewedId(null);
    setPhase("arena");
  }, [settings]);

  const signOut = useCallback(() => {
    if (settings?.via === "oauth") void revoke(settings.baseUrl, settings.apiKey);
    clearSettings();
    for (const t of timersRef.current.values()) window.clearTimeout(t);
    timersRef.current.clear();
    setSettings(null);
    setCatalog(null);
    setRounds([]);
    setRuntime({});
    setPhase("setup");
  }, [settings]);

  // ── catalog → picker ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!client || phase !== "arena") return;
    let cancelled = false;
    client
      .getCatalog()
      .then((c) => {
        if (cancelled) return;
        setCatalog(c);
        setSelection((cur) => (cur.length > 0 ? cur : defaultSelection(distinctModels(c.models))));
      })
      .catch((err) => !cancelled && say(describeError(err)));
    return () => {
      cancelled = true;
    };
  }, [client, phase, say]);

  // ── derived: rounds, the viewed round, live-ness ──────────────────────────

  const activeRound = useMemo(
    () => [...rounds].reverse().find((r) => r.winnerKey === null && r.closedAt === null) ?? null,
    [rounds],
  );
  const viewed = useMemo(() => {
    if (viewedId) {
      const r = rounds.find((x) => x.id === viewedId);
      if (r) return r;
    }
    return activeRound ?? rounds[rounds.length - 1] ?? null;
  }, [rounds, viewedId, activeRound]);
  const isLive = viewed !== null && activeRound !== null && viewed.id === activeRound.id;

  // ── data loading for the viewed round ─────────────────────────────────────

  const viewedConvs = useMemo(
    () => (viewed ? viewed.contenders.map((c) => c.conversationId).filter((x): x is string => !!x) : []),
    [viewed],
  );
  const viewedConvsKey = viewedConvs.join(",");

  useEffect(() => {
    if (!client || viewedConvs.length === 0) return;
    let cancelled = false;
    for (const cid of viewedConvs) {
      void client
        .listTurns(cid)
        .then((t) => !cancelled && setTurnsByConv((prev) => ({ ...prev, [cid]: t })))
        .catch(() => undefined);
      void client
        .listAllEvents(cid, STREAMS)
        .then((evs) => !cancelled && setEventsByConv((prev) => ({ ...prev, [cid]: mergeEvents(prev[cid] ?? [], evs) })))
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, viewedConvsKey, reloadKey]);

  const refreshTurns = useCallback(
    (cid: string) => {
      if (!client) return;
      void client
        .listTurns(cid)
        .then((t) => setTurnsByConv((prev) => ({ ...prev, [cid]: t })))
        .catch(() => undefined);
    },
    [client],
  );

  // ── stream: route team events into columns ────────────────────────────────

  const syncRoster = useCallback(async () => {
    if (!client) return;
    const active = roundsRef.current.find((r) => r.winnerKey === null && r.closedAt === null);
    if (!active) return;
    try {
      const team = await client.listTeam();
      for (const c of active.contenders) {
        if (!c.agentId) continue;
        const tm = team.find((t) => t.agent_id === c.agentId);
        if (tm && tm.conversation.id !== c.conversationId) {
          const cid = tm.conversation.id;
          mutateRounds((rs) =>
            rs.map((r) =>
              r.id === active.id
                ? { ...r, contenders: r.contenders.map((x) => (x.key === c.key ? { ...x, conversationId: cid } : x)) }
                : r,
            ),
          );
        }
      }
    } catch {
      // roster refresh is best-effort
    }
  }, [client, mutateRounds]);

  useEffect(() => {
    if (!client || phase !== "arena") return;
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
          setReloadKey((k) => k + 1);
          void syncRoster();
        },
        onMessage: (msg) => {
          if (msg.id) lastEventId = msg.id;
          if (msg.event === "team") {
            void syncRoster();
            return;
          }
          let ev: TeamEvent;
          try {
            ev = JSON.parse(msg.data) as TeamEvent;
          } catch {
            return;
          }
          if (msg.id) ev.id = Number(msg.id);
          const all = roundsRef.current;
          const known = all.some((r) => r.contenders.some((c) => c.conversationId === ev.conversation_id));
          if (!known) {
            // A fresh conversation for one of our contenders (computer rotated).
            const active = all.find((r) => r.winnerKey === null && r.closedAt === null);
            if (active && ev.agent_id && active.contenders.some((c) => c.agentId === ev.agent_id)) void syncRoster();
            return;
          }
          setEventsByConv((prev) => {
            const list = prev[ev.conversation_id] ?? [];
            if (list.some((e) => e.id === ev.id)) return prev;
            return { ...prev, [ev.conversation_id]: [...list, ev] };
          });
          if (ev.kind === "stage" && ev.stage === "turn") {
            refreshTurns(ev.conversation_id);
            const active = all.find((r) => r.winnerKey === null && r.closedAt === null);
            if (ev.state === "started" && ev.turn_id && active) {
              const c = active.contenders.find((x) => x.conversationId === ev.conversation_id);
              if (c && !c.turnIds.includes(ev.turn_id)) {
                const turnId = ev.turn_id;
                mutateRounds((rs) =>
                  rs.map((r) =>
                    r.id === active.id
                      ? {
                          ...r,
                          contenders: r.contenders.map((x) =>
                            x.key === c.key && !x.turnIds.includes(turnId)
                              ? { ...x, turnIds: [...x.turnIds, turnId] }
                              : x,
                          ),
                        }
                      : r,
                  ),
                );
              }
            }
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
  }, [client, phase, refreshTurns, syncRoster, mutateRounds]);

  // ── the send engine: hire lazily, retry provisioning/busy per column ─────

  const setPhaseFor = useCallback((key: string, p: RuntimePhase | null, message?: string) => {
    setRuntime((prev) => {
      if (p === null) {
        if (!(key in prev)) return prev;
        const { [key]: _drop, ...rest } = prev;
        return rest;
      }
      return { ...prev, [key]: { phase: p, message } };
    });
  }, []);

  const schedule = useCallback((key: string, ms: number, fn: () => void) => {
    const old = timersRef.current.get(key);
    if (old) window.clearTimeout(old);
    timersRef.current.set(
      key,
      window.setTimeout(() => {
        timersRef.current.delete(key);
        fn();
      }, ms),
    );
  }, []);

  const sendTo = useCallback(
    function sendTo(roundId: string, key: string, prompt: string, tries: number): void {
      if (!client) return;
      const round = roundsRef.current.find((r) => r.id === roundId);
      if (!round || round.closedAt !== null) return;
      const contender = round.contenders.find((c) => c.key === key);
      if (!contender?.agentId) return;
      setPhaseFor(key, "sending");
      void client
        .sendMessage(contender.agentId, prompt)
        .then((res) => {
          if (res.conversation_id !== contender.conversationId) {
            mutateRounds((rs) =>
              rs.map((r) =>
                r.id === roundId
                  ? {
                      ...r,
                      contenders: r.contenders.map((x) =>
                        x.key === key ? { ...x, conversationId: res.conversation_id } : x,
                      ),
                    }
                  : r,
              ),
            );
          }
          // stays "sending" until the turn shows up — derivation clears it.
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && (err.code === "provisioning" || err.status === 503)) {
            if (tries >= 40) {
              setPhaseFor(key, "error", "The computer never finished starting.");
              return;
            }
            setPhaseFor(key, "starting");
            schedule(key, Math.min((err.retryAfter ?? 10) * 1000, 30000), () => sendTo(roundId, key, prompt, tries + 1));
            return;
          }
          if (err instanceof ApiError && err.code === "conversation_busy") {
            if (tries >= 60) {
              setPhaseFor(key, "error", "Still busy with the previous turn.");
              return;
            }
            schedule(key, 3000, () => sendTo(roundId, key, prompt, tries + 1));
            return;
          }
          setPhaseFor(key, "error", describeError(err));
        });
    },
    [client, mutateRounds, schedule, setPhaseFor],
  );

  const ensureHired = useCallback(
    async (team: Teammate[], k: ContenderKey): Promise<{ agentId: string; conversationId: string }> => {
      if (!client || !catalog || !baseUrl) throw new Error("not connected");
      const key = keyId(k);
      const name = agentNameFor(k);
      const known = loadAgentIds(baseUrl)[key];
      const onTeam = team.find((t) => t.agent_id === known) ?? team.find((t) => t.agent.name === name);
      if (onTeam) {
        saveAgentId(baseUrl, key, onTeam.agent_id);
        return { agentId: onTeam.agent_id, conversationId: onTeam.conversation.id };
      }
      if (known) {
        // The agent may exist but be off the team — re-hiring is one call.
        try {
          const tm = await client.addTeammate({ agent_id: known, name });
          return { agentId: known, conversationId: tm.conversation.id };
        } catch {
          // agent gone — fall through and create a fresh one
        }
      }
      const agent = await client.createAgent({
        name,
        description: AGENT_DESCRIPTION,
        model: k.model,
        runtime: runtimeFor(k.model, catalog.runtimes),
        system: SYSTEM_PROMPT,
      });
      const tm = await client.addTeammate({ agent_id: agent.id, name });
      saveAgentId(baseUrl, key, agent.id);
      return { agentId: agent.id, conversationId: tm.conversation.id };
    },
    [client, catalog, baseUrl],
  );

  const fight = useCallback(
    async (prompt: string) => {
      if (!client || !catalog) return;
      if (selection.length < MIN_CONTENDERS) {
        say(`Pick at least ${MIN_CONTENDERS} brains.`);
        return;
      }
      setFighting(true);
      try {
        let team: Teammate[];
        try {
          team = await client.listTeam();
        } catch (err) {
          say(describeError(err));
          return;
        }
        const contenders: RoundContender[] = [];
        for (const k of selection) {
          const key = keyId(k);
          setPhaseFor(key, "hiring");
          try {
            const { agentId, conversationId } = await ensureHired(team, k);
            contenders.push({ key, model: k.model, instance: k.instance, agentId, conversationId, turnIds: [] });
            setPhaseFor(key, null);
          } catch (err) {
            contenders.push({ key, model: k.model, instance: k.instance, agentId: null, conversationId: null, turnIds: [] });
            setPhaseFor(key, "error", describeError(err));
          }
        }
        const isBlind = blindRef.current;
        const round: Round = {
          id: `round-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
          prompts: [prompt],
          startedAt: new Date().toISOString(),
          blind: isBlind,
          order: isBlind ? shuffled(contenders.map((c) => c.key)) : contenders.map((c) => c.key),
          contenders,
          winnerKey: null,
          revealed: !isBlind,
          closedAt: null,
        };
        mutateRounds((rs) => [...rs, round]);
        setViewedId(round.id);
        for (const c of contenders) if (c.agentId) sendTo(round.id, c.key, prompt, 0);
      } finally {
        setFighting(false);
      }
    },
    [client, catalog, selection, ensureHired, mutateRounds, sendTo, setPhaseFor, say],
  );

  const followUp = useCallback(
    (prompt: string) => {
      if (!activeRound) return;
      mutateRounds((rs) => rs.map((r) => (r.id === activeRound.id ? { ...r, prompts: [...r.prompts, prompt] } : r)));
      for (const c of activeRound.contenders) if (c.agentId) sendTo(activeRound.id, c.key, prompt, 0);
    },
    [activeRound, mutateRounds, sendTo],
  );

  const interruptAll = useCallback(() => {
    if (!client || !activeRound) return;
    for (const c of activeRound.contenders) {
      const timer = timersRef.current.get(c.key);
      if (timer) {
        window.clearTimeout(timer);
        timersRef.current.delete(c.key);
        setPhaseFor(c.key, "cancelled");
      }
      if (c.conversationId) {
        const turns = turnsForRound(turnsByConv[c.conversationId] ?? [], activeRound, c);
        const last = turns[turns.length - 1];
        if (last && last.status === "running") void client.interrupt(c.conversationId).catch(() => undefined);
      }
    }
  }, [client, activeRound, turnsByConv, setPhaseFor]);

  const vote = useCallback(
    (key: string) => {
      if (!viewed || viewed.winnerKey !== null || viewed.closedAt !== null) return;
      const id = viewed.id;
      mutateRounds((rs) =>
        rs.map((r) => (r.id === id ? { ...r, winnerKey: key, revealed: true, closedAt: new Date().toISOString() } : r)),
      );
      setRuntime({});
    },
    [viewed, mutateRounds],
  );

  const reveal = useCallback(() => {
    if (!viewed) return;
    const id = viewed.id;
    mutateRounds((rs) => rs.map((r) => (r.id === id ? { ...r, revealed: true } : r)));
  }, [viewed, mutateRounds]);

  const closeRound = useCallback(() => {
    if (!activeRound) return;
    const id = activeRound.id;
    for (const t of timersRef.current.values()) window.clearTimeout(t);
    timersRef.current.clear();
    mutateRounds((rs) => rs.map((r) => (r.id === id ? { ...r, closedAt: new Date().toISOString() } : r)));
    setRuntime({});
  }, [activeRound, mutateRounds]);

  // ── columns, settled-ness, ticker ─────────────────────────────────────────

  const latestPrompt = viewed?.prompts[viewed.prompts.length - 1] ?? null;

  const columns: ColumnData[] = useMemo(() => {
    if (!viewed) return [];
    const ordered = viewed.order
      .map((k) => viewed.contenders.find((c) => c.key === k))
      .filter((c): c is RoundContender => c !== undefined);
    return ordered.map((c, index) => {
      const events = c.conversationId ? eventsByConv[c.conversationId] ?? [] : [];
      const roundTurns = turnsForRound(c.conversationId ? turnsByConv[c.conversationId] ?? [] : [], viewed, c);
      const rt = runtime[c.key] ?? null;
      let rtPhase = rt?.phase ?? null;
      const last = roundTurns[roundTurns.length - 1] ?? null;
      // A 202 landed and its turn is visible — the "sending" phase is over.
      if (rtPhase === "sending" && last && last.prompt === latestPrompt) rtPhase = null;
      const rtForStatus = isLive ? rtPhase : null;
      const hasOutput = last ? events.some((e) => e.kind === "output" && e.turn_id === last.id) : false;
      let status = columnStatus(rtForStatus, last, hasOutput);
      if (isLive && rtForStatus === null && roundTurns.length < viewed.prompts.length && status === "done") {
        status = "waiting";
      }
      const runtimeName = catalog ? runtimeFor(c.model, catalog.runtimes) : "claude";
      const segments = roundTurns.map((turn) => {
        const tevents = events.filter((e) => e.turn_id === turn.id);
        return { turn, blocks: blocksForTurn(tevents, runtimeName), metrics: turnMetrics(turn, tevents, now) };
      });
      return {
        key: c.key,
        name: c.instance > 1 ? `${c.model} #${c.instance}` : c.model,
        index,
        segments,
        status,
        statusDetail: rt?.message ?? null,
      };
    });
  }, [viewed, eventsByConv, turnsByConv, runtime, catalog, now, isLive, latestPrompt]);

  const settled = useMemo(() => {
    if (!viewed || !isLive) return true;
    return columns.every((col) => !["waiting", "hiring", "starting", "thinking", "answering"].includes(col.status));
  }, [columns, viewed, isLive]);

  useEffect(() => {
    if (settled) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [settled]);

  const scores = useMemo(() => scoreboard(rounds), [rounds]);

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

  const models = catalog ? distinctModels(catalog.models) : [];
  const chips = pickerKeys(models);
  const groups = groupByProvider(chips.map((k) => keyId(k)));
  const pickerLocked = activeRound !== null;
  const canFollowUp = isLive && settled && viewed !== null;
  const showVotes = viewed !== null && viewed.winnerKey === null && viewed.closedAt === null;

  const toggle = (key: string) => {
    const k = chips.find((x) => keyId(x) === key);
    if (!k) return;
    setSelection((cur) => {
      const has = cur.some((x) => keyId(x) === key);
      if (has) return cur.filter((x) => keyId(x) !== key);
      if (cur.length >= MAX_CONTENDERS) {
        say(`At most ${MAX_CONTENDERS} contenders per round.`);
        return cur;
      }
      return [...cur, k];
    });
  };

  return (
    <div className="arena">
      <header>
        <div className="wordmark small">
          THE<span>ARENA</span>
        </div>
        <label className="blind-toggle" title="hide model names until you vote or reveal">
          <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
          blind
        </label>
        <div className="head-status">
          <button className="linkish" onClick={() => setShowBoard((b) => !b)}>
            scoreboard
          </button>
          <span className={connected ? "dot on" : "dot"} title={connected ? "live" : "reconnecting"} />
          <button className="linkish" onClick={signOut}>
            sign out
          </button>
        </div>
      </header>

      {toast && <div className="toast">{toast}</div>}
      {showBoard && <Scoreboard scores={scores} onClose={() => setShowBoard(false)} />}

      <div className="arena-body">
        <aside className="rail">
          <div className="rail-head">Rounds</div>
          {rounds.length === 0 && <p className="fineprint">No rounds yet.</p>}
          {[...rounds].reverse().map((r) => {
            const winner = r.winnerKey ? r.contenders.find((c) => c.key === r.winnerKey) : null;
            const liveHere = activeRound?.id === r.id;
            return (
              <button
                key={r.id}
                className={`rail-item${viewed?.id === r.id ? " current" : ""}`}
                onClick={() => setViewedId(r.id)}
              >
                <span className="rail-prompt">{r.prompts[0]}</span>
                <span className="rail-meta">
                  {liveHere ? "live" : winner ? `♛ ${winner.model.split("/")[1] ?? winner.model}` : "no vote"}
                </span>
              </button>
            );
          })}
        </aside>

        <main className="ring">
          <div className="fightbar">
            <Composer
              mode={activeRound ? "followup" : "fight"}
              disabled={fighting || (activeRound !== null && (!canFollowUp || !isLive)) || (!activeRound && selection.length < MIN_CONTENDERS)}
              onSubmit={(text) => (activeRound ? followUp(text) : void fight(text))}
            />
            {activeRound && !settled && (
              <button className="danger" onClick={interruptAll}>
                Interrupt all
              </button>
            )}
            {activeRound && settled && (
              <button onClick={closeRound} title="close this round without a vote">
                New round
              </button>
            )}
            {viewed && viewed.blind && !viewed.revealed && (
              <button className="linkish" onClick={reveal}>
                reveal
              </button>
            )}
          </div>

          {!pickerLocked && (
            <div className="picker">
              {groups.map((g) => (
                <div key={g.provider} className="picker-group">
                  <span className="picker-provider">{g.provider}</span>
                  {g.models.map((key) => (
                    <button
                      key={key}
                      className={`chip${selection.some((x) => keyId(x) === key) ? " picked" : ""}`}
                      onClick={() => toggle(key)}
                    >
                      {key.split("/")[1] ?? key}
                    </button>
                  ))}
                </div>
              ))}
              {catalog && chips.length === 0 && <p className="fineprint">The catalog reports no models.</p>}
            </div>
          )}

          {viewed ? (
            <>
              <div className="round-prompts">
                {viewed.prompts.map((p, i) => (
                  <div key={i} className="bubble you">
                    {p}
                  </div>
                ))}
              </div>
              <div className="columns" style={{ ["--cols" as string]: viewed.order.length }}>
                {columns.map((col) => (
                  <Column
                    key={col.key}
                    col={col}
                    revealed={viewed.revealed}
                    winner={viewed.winnerKey === col.key}
                    canVote={showVotes && col.segments.some((s) => s.turn.status === "completed")}
                    onVote={vote}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="hero">
              <p>
                Pick two to four brains, type one prompt, hit <b>Fight</b>. Each contender answers in its own live
                column — blind by default. Your vote decides.
              </p>
            </div>
          )}

          <footer className="fineprint">
            Runs on <a href="https://github.com/BinaryBourbon/fountain">Fountain</a> ·{" "}
            <a href="https://github.com/jhgaylor/arena">source</a> · {__APP_COMMIT__}
          </footer>
        </main>
      </div>
    </div>
  );
}

function Composer(props: { mode: "fight" | "followup"; disabled: boolean; onSubmit: (text: string) => void }) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    const text = draft.trim();
    if (!text || props.disabled) return;
    props.onSubmit(text);
    setDraft("");
  };
  return (
    <div className="composer">
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        placeholder={props.mode === "fight" ? "One prompt for every contender…" : "Follow up — goes to every contender…"}
      />
      <button className="primary" onClick={submit} disabled={props.disabled || !draft.trim()}>
        {props.mode === "fight" ? "Fight" : "Follow up"}
      </button>
    </div>
  );
}

function mergeEvents(existing: LogEvent[], incoming: LogEvent[]): LogEvent[] {
  const seen = new Set(existing.map((e) => e.id));
  const merged = [...existing];
  for (const ev of incoming) {
    if (!seen.has(ev.id)) {
      merged.push(ev);
      seen.add(ev.id);
    }
  }
  return merged.sort((a, b) => a.id - b.id);
}
