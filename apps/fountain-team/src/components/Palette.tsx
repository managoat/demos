import { useEffect, useMemo, useRef, useState } from "react";
import type { FountainClient } from "../api/client";
import type { SearchHit, Teammate } from "../api/types";
import { Avatar } from "./Avatar";
import { formatTime } from "./Roster";

export type PaletteChoice =
  | { kind: "teammate"; agentId: string }
  | { kind: "hit"; hit: SearchHit }
  | { kind: "routines" }
  | { kind: "runners" }
  | { kind: "export" };

interface Props {
  client: FountainClient;
  teammates: Teammate[];
  onChoose: (choice: PaletteChoice) => void;
  onClose: () => void;
}

/**
 * ⌘K (after OpenMausBot's command palette): jump to a teammate by name,
 * a couple of commands, and — after a pause in typing — full-text search
 * across every conversation via GET /api/search, "jump to the message".
 */
export function Palette({ client, teammates, onChoose, onClose }: Props) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const query = q.trim();
  const matches = useMemo(() => {
    const needle = query.toLowerCase();
    const rows = needle ? teammates.filter((t) => `${t.name} ${t.agent.name}`.toLowerCase().includes(needle)) : teammates;
    return rows.slice(0, 6);
  }, [teammates, query]);

  const commands = useMemo(() => {
    const all: Array<{ id: "routines" | "runners" | "export"; label: string; hint: string }> = [
      { id: "routines", label: "Routines", hint: "schedules that run a teammate" },
      { id: "runners", label: "Runners", hint: "your own machines as computers" },
      { id: "export", label: "Export team as a fountain apply manifest", hint: "team.yml" },
    ];
    if (!query) return all;
    return all.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()));
  }, [query]);

  // search, debounced, cancelling the previous request
  useEffect(() => {
    if (query.length < 2) {
      setHits(null);
      setSearching(false);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      setSearching(true);
      client
        .search(query, { limit: 12, signal: ctrl.signal })
        .then((h) => {
          setHits(h);
          setError(null);
        })
        .catch((err) => {
          if (ctrl.signal.aborted) return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => !ctrl.signal.aborted && setSearching(false));
    }, 250);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [client, query]);

  const choices: PaletteChoice[] = useMemo(
    () => [
      ...matches.map((t): PaletteChoice => ({ kind: "teammate", agentId: t.agent_id })),
      ...commands.map((c): PaletteChoice => ({ kind: c.id })),
      ...(hits ?? []).map((hit): PaletteChoice => ({ kind: "hit", hit })),
    ],
    [matches, commands, hits],
  );

  useEffect(() => setCursor(0), [query, hits]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, choices.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = choices[cursor];
      if (c) onChoose(c);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  const nameOf = (agentId: string | null) => teammates.find((t) => t.agent_id === agentId)?.name ?? null;
  let index = -1;

  return (
    <div className="modal-root palette-root" onKeyDown={onKey}>
      <div className="backdrop" onClick={onClose} />
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Jump to a teammate, or search every conversation…"
          aria-label="Search"
          spellCheck={false}
        />
        <div className="palette-list" ref={listRef}>
          {matches.length > 0 && <div className="palette-head">Teammates</div>}
          {matches.map((t) => {
            index += 1;
            const i = index;
            return (
              <button
                key={t.agent_id}
                data-index={i}
                className={`palette-item ${cursor === i ? "active" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => onChoose({ kind: "teammate", agentId: t.agent_id })}
              >
                <Avatar agent={t.agent} name={t.name} client={client} size={24} />
                <span className="name">{t.name}</span>
                <span className="muted small">{t.presence.label}</span>
              </button>
            );
          })}
          {commands.length > 0 && <div className="palette-head">Commands</div>}
          {commands.map((c) => {
            index += 1;
            const i = index;
            return (
              <button
                key={c.id}
                data-index={i}
                className={`palette-item ${cursor === i ? "active" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => onChoose({ kind: c.id })}
              >
                <span className="glyph">{c.id === "routines" ? "⏰" : c.id === "runners" ? "🖥" : "⤓"}</span>
                <span className="name">{c.label}</span>
                <span className="muted small">{c.hint}</span>
              </button>
            );
          })}
          {query.length >= 2 && (
            <div className="palette-head">
              Messages {searching && <span className="muted">· searching…</span>}
              {error && <span className="error-inline"> · {error}</span>}
            </div>
          )}
          {hits && hits.length === 0 && !searching && <div className="palette-empty muted">No messages match.</div>}
          {(hits ?? []).map((h) => {
            index += 1;
            const i = index;
            const who = nameOf(h.agent_id);
            return (
              <button
                key={`${h.conversation_id}:${h.turn_id ?? "t"}:${h.kind}`}
                data-index={i}
                className={`palette-item hit ${cursor === i ? "active" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => onChoose({ kind: "hit", hit: h })}
              >
                <span className={`tag kind-${h.kind}`}>{h.kind === "reply" ? "them" : h.kind === "prompt" ? "you" : "title"}</span>
                <span className="snippet">{h.snippet}</span>
                <span className="muted small who">
                  {who ?? "not on the team"} · {formatTime(h.ts)}
                </span>
              </button>
            );
          })}
        </div>
        <div className="palette-foot muted small">↑↓ to move · Enter to open · Esc to close</div>
      </div>
    </div>
  );
}
