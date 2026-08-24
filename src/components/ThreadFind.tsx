/**
 * ⌘F: find inside the conversation you are reading.
 *
 * ⌘K reaches across the project; this is the other half, and a long transcript
 * is where it hurts — today you scroll. It is `GET /api/search` with
 * `conversation_id` on it, the one case the proxy hands straight to Fountain
 * to scope, so a keystroke here fetches nothing outside this conversation.
 *
 * The hits are walked, not listed: next and previous move the transcript to
 * the turn that matched and mark it, the way the palette's Enter already does
 * — no navigation, no second panel of results to read. The bar is a plain
 * component and the keyboard is a plain predicate (`findIsOurs`), so both are
 * testable; only the hook needs a Fountain.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { useProject } from "../store";
import { describeError } from "../lib/errors";
import { findIsOurs, searchMessages, threadHits, type ThreadHit } from "../lib/search";

const DEBOUNCE_MS = 180;
/** One window over the thread's hits: a transcript long enough to need this is not longer than this. */
const HITS = 100;

export interface Find {
  open: boolean;
  q: string;
  setQ: (v: string) => void;
  hits: ThreadHit[];
  index: number;
  step: (delta: number) => void;
  show: () => void;
  toggle: () => void;
  close: () => void;
  searching: boolean;
  error: string | null;
  hasMore: boolean;
  input: RefObject<HTMLInputElement | null>;
  onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  /** The turn the current hit is on — what the transcript scrolls to and marks. */
  at: string | null;
  /** Every turn with a hit on it, for the fainter marks in the margin. */
  marked: Set<string>;
}

/**
 * The find's state and its keyboard. `root` is the thread's own element: it is
 * what decides whether a ⌘F belongs to us, and it keeps n/N off the composer.
 */
export function useThreadFind({ conversationId, root }: { conversationId: string; root: RefObject<HTMLElement | null> }): Find {
  const { fountain } = useProject();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<ThreadHit[]>([]);
  const [index, setIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // Closed is closed: no request, no marks left in the margin.
  useEffect(() => {
    const text = q.trim();
    setError(null);
    if (!open || !text) {
      setHits([]);
      setHasMore(false);
      setSearching(false);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchMessages(fountain, text, { conversationId, limit: HITS, signal: ctrl.signal })
        .then((found) => {
          if (ctrl.signal.aborted) return;
          setHits(threadHits(found.hits));
          setHasMore(found.hasMore);
          setIndex(0);
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
  }, [q, open, conversationId, fountain]);

  const step = useCallback((delta: number) => setIndex((i) => (hits.length ? (i + delta + hits.length) % hits.length : 0)), [hits.length]);

  const show = useCallback(() => {
    setOpen(true);
    // Already open, and ⌘F again: back to the box, with what is in it selected.
    input.current?.focus();
    input.current?.select();
  }, []);
  // The query survives a close, so ⌘F picks up where it left off; the marks do not.
  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => (open ? close() : show()), [open, close, show]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const inThread = !!el && !!root.current?.contains(el);
      // Clicking the transcript focuses nothing, which still counts as reading it.
      const loose = !el || el === document.body;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") {
        if (!findIsOurs({ inThread, focusedElsewhere: !loose && !inThread, modal: !!document.querySelector(".modal-backdrop") })) return;
        e.preventDefault();
        show();
        return;
      }
      if (!open || e.metaKey || e.ctrlKey || e.altKey || !(inThread || loose)) return;
      // Escape puts it away from anywhere in the thread, the composer included.
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      // n/N walk the hits from the transcript, where nothing is focused; in the
      // composer they are letters someone is typing.
      if (editing(el)) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        step(e.key === "n" ? 1 : -1);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        step(e.key === "ArrowDown" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [open, show, close, step, root]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    },
    [step, close],
  );

  const marked = useMemo(() => new Set(hits.map((h) => h.turnId)), [hits]);

  return {
    open,
    q,
    setQ,
    hits,
    index,
    step,
    show,
    toggle,
    close,
    searching,
    error,
    hasMore,
    input,
    onKeyDown,
    at: open ? hits[index]?.turnId ?? null : null,
    marked: open ? marked : EMPTY,
  };
}

const EMPTY: Set<string> = new Set();

function editing(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable === true;
}

/**
 * The bar itself. `pending` is the one thing the search cannot tell you:
 * Fountain materialises a reply when its turn *ends*, so the turn still
 * running will not match however plainly the words are on screen. Saying so is
 * the difference between a limit and a bug.
 */
export function FindBar({
  q,
  onQ,
  onKeyDown,
  input,
  count,
  index,
  onStep,
  onClose,
  searching,
  error,
  hasMore,
  pending,
}: {
  q: string;
  onQ: (v: string) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void;
  input?: RefObject<HTMLInputElement | null>;
  count: number;
  index: number;
  onStep: (delta: number) => void;
  onClose: () => void;
  searching: boolean;
  error: string | null;
  hasMore: boolean;
  pending: boolean;
}) {
  const typed = q.trim().length > 0;
  return (
    <div className="find-bar" role="search">
      <span className="ps1" aria-hidden="true">
        ⌕
      </span>
      <input
        ref={input}
        className="find-input"
        value={q}
        onChange={(e) => onQ(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find in this conversation"
        aria-label="Find in this conversation"
        autoFocus
        spellCheck={false}
      />
      <span className="find-count muted small" aria-live="polite">
        {!typed ? "" : searching && count === 0 ? "searching…" : count === 0 ? "no match" : `${index + 1} of ${count}${hasMore ? "+" : ""}`}
      </span>
      <button className="icon" onClick={() => onStep(-1)} disabled={count === 0} title="Previous match (⇧↵ or N)" aria-label="Previous match">
        ‹
      </button>
      <button className="icon" onClick={() => onStep(1)} disabled={count === 0} title="Next match (↵ or n)" aria-label="Next match">
        ›
      </button>
      <button className="icon" onClick={onClose} title="Close (esc)" aria-label="Close find">
        ×
      </button>
      <span className="find-note muted small">
        {error ? (
          <span className="error">{error}</span>
        ) : !typed ? (
          // Fountain matches whole words with no stemming, and takes websearch
          // syntax — surprising for prose, exactly right for an identifier.
          <>whole words · "a quoted phrase" · -excluded · or</>
        ) : pending ? (
          <>the turn still running will match once it ends</>
        ) : null}
      </span>
    </div>
  );
}
