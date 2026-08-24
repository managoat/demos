/**
 * ⌘K: one box over the project, for finding anything said in it.
 *
 * Conversations match by name locally, off the list the store already holds,
 * so the first rows appear on the first keystroke. Messages come from
 * `GET /api/search` through the project proxy a beat later — the server runs
 * it on the owner's key and hands back only this project's hits, so what
 * lands here is already narrowed. Enter opens the hit at the turn it matched.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProject } from "../store";
import { navigate } from "../router";
import { describeError } from "../lib/errors";
import { formatTime } from "../lib/format";
import { describeHits, matchConversations, searchMessages, type Context, type Match } from "../lib/search";
import type { SearchHit } from "../types";

const DEBOUNCE_MS = 180;

export function Palette({ onClose }: { onClose: () => void }) {
  const { project, items, conversations, agents, fountain } = useProject();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const ctx = useMemo<Context>(() => ({ conversations, items, agents, projectId: project.id }), [conversations, items, agents, project.id]);
  const rows = useMemo(() => [...matchConversations(q, ctx), ...describeHits(hits, ctx)], [q, hits, ctx]);

  // The query hangs on what was typed and nothing else. Labelling the hits is
  // a separate step above, so a conversation list refreshed by a running turn
  // relabels the rows rather than re-running the search under the reader.
  useEffect(() => {
    const text = q.trim();
    setError(null);
    if (!text) {
      setHits([]);
      setHasMore(false);
      setSearching(false);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchMessages(fountain, text, { signal: ctrl.signal })
        .then((found) => {
          if (ctrl.signal.aborted) return;
          setHits(found.hits);
          setHasMore(found.hasMore);
        })
        .catch((err: unknown) => {
          if (!ctrl.signal.aborted) setError(describeError(err));
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [q, fountain]);

  useEffect(() => setActive(0), [q]);

  const open = useCallback(
    (m: Match | undefined) => {
      if (!m) return;
      navigate(m.href);
      onClose();
    },
    [onClose],
  );

  // Keep the selected row in view as the arrows walk past the fold.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>("li.on")?.scrollIntoView({ block: "nearest" });
  }, [active, rows.length]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => (rows.length ? (i + 1) % rows.length : 0));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            open(rows[active]);
          }
        }}
      >
        <input
          className="palette-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${project.name} — titles, prompts and replies`}
          aria-label="Search this project"
          autoFocus
          spellCheck={false}
        />
        <ul className="palette-list" ref={list}>
          {rows.map((m, i) => (
            <li key={m.key} className={i === active ? "on" : ""} onMouseEnter={() => setActive(i)} onClick={() => open(m)}>
              <span className={`palette-kind ${m.kind}`}>{m.kind === "conversation" ? "go" : m.kind}</span>
              <span className="palette-text">
                <span className="palette-primary">{m.primary}</span>
                <span className="palette-where muted small">{m.secondary}</span>
              </span>
              <span className="palette-when muted small">{formatTime(m.when)}</span>
            </li>
          ))}
        </ul>
        <div className="palette-foot muted small">
          {error ? (
            <span className="error">{error}</span>
          ) : !q.trim() ? (
            <span>Type to search this project's conversations. ↑↓ to move, ↵ to open, esc to close.</span>
          ) : searching && rows.length === 0 ? (
            <span>Searching…</span>
          ) : rows.length === 0 ? (
            <span>Nothing here matches. A reply is searchable once its turn ends.</span>
          ) : (
            <span>
              {rows.length} {rows.length === 1 ? "result" : "results"}
              {hasMore ? " — narrow it for the rest" : ""}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
