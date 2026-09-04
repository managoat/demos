/**
 * The conversation itself.
 *
 * Three rendering decisions worth naming. Tool calls are one line until you
 * ask for more, because a turn is often twenty of them and a transcript that
 * shows every argument and every byte of output is a log file, not a
 * conversation. Thinking is folded away for the same reason and for one more:
 * it is the model's, not the machine's, and reading it is a choice.
 *
 * And the view follows the newest line only while you are already at the
 * newest line. Scrolling up is a person saying they are reading something;
 * pulling them back down from it is the rudest thing a transcript can do.
 */
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { startsTurn, type TranscriptItem, type ToolItem } from "../lib/blocks";

export interface TranscriptProps {
  items: TranscriptItem[];
  /** Rendered above the first item, inside the scroll area — the thread's card. */
  header?: ReactNode;
  /** History has not arrived yet. */
  loading: boolean;
  /** The server's own words about why there is nothing here. */
  error: string | null;
  onReload: () => void;
  /** What to say when the thread is ready and has said nothing yet. */
  emptyHint?: string;
}

/** Within this many pixels of the bottom counts as "watching the newest line". */
const STICK_WITHIN = 120;

export function Transcript({ items, header, loading, error, onReload, emptyHint }: TranscriptProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  // The same fact twice: the ref is what the scroll effect reads, so following
  // the newest line never depends on a re-render having happened first.
  const stuckRef = useRef(true);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_WITHIN;
    stuckRef.current = near;
    setStuck(near);
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stuckRef.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const toBottom = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stuckRef.current = true;
    setStuck(true);
  }, []);

  return (
    <div className="dd-th-transcript">
      <div className="dd-th-scroll" ref={scroller} onScroll={onScroll}>
        {header}

        {error && (
          <div className="dd-th-fail">
            <span className="dd-th-glyph error">
              <AlertIcon />
            </span>
            <span className="error">{error}</span>
            <button className="ghost" onClick={onReload}>
              Try again
            </button>
          </div>
        )}

        {loading && items.length === 0 && !error && (
          <div className="dd-th-items" aria-busy="true">
            <div className="skeleton dd-th-line-skeleton" />
            <div className="skeleton dd-th-line-skeleton dd-th-line-skeleton-short" />
          </div>
        )}

        {!loading && items.length === 0 && !error && (
          <div className="dd-th-quiet">
            <p>{emptyHint ?? "Nothing said yet."}</p>
          </div>
        )}

        {items.length > 0 && (
          <div className="dd-th-items">
            {items.map((item, i) => (
              <Item key={item.key} item={item} newTurn={startsTurn(item, items[i - 1])} />
            ))}
          </div>
        )}
      </div>

      {!stuck && items.length > 0 && (
        <button className="dd-th-jump" onClick={toBottom}>
          <DownIcon />
          Jump to the newest
        </button>
      )}
    </div>
  );
}

function Item({ item, newTurn }: { item: TranscriptItem; newTurn: boolean }) {
  const cls = newTurn ? "dd-th-item dd-th-item-turn" : "dd-th-item";
  switch (item.kind) {
    case "user":
      return (
        <div className={cls}>
          <div className="dd-th-user" title={item.at}>
            <Prose body={item.text} />
          </div>
        </div>
      );
    case "text":
      return (
        <div className={cls}>
          <Prose body={item.body} />
        </div>
      );
    case "thinking":
      return (
        <div className={cls}>
          <Thinking body={item.body} />
        </div>
      );
    case "tool":
      return (
        <div className={cls}>
          <Tool item={item} />
        </div>
      );
    case "error":
      return (
        <div className={cls}>
          <div className="dd-th-error">
            <span className="dd-th-glyph error">
              <AlertIcon />
            </span>
            <span className="error">{item.body}</span>
          </div>
        </div>
      );
    case "notice":
      return (
        <div className={cls}>
          <details className="dd-th-notice">
            <summary>{item.label}</summary>
            <pre className="dd-th-pre">
              <code>{item.body}</code>
            </pre>
          </details>
        </div>
      );
  }
}

function Thinking({ body }: { body: string }) {
  return (
    <details className="dd-th-thinking">
      <summary>
        <ChevronIcon />
        Thinking
      </summary>
      <div className="dd-th-thinking-body">
        <Prose body={body} />
      </div>
    </details>
  );
}

function Tool({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const has = item.input.length > 0 || item.output.length > 0;
  return (
    <div className={`dd-th-tool dd-th-tool-${item.status}`}>
      <button className="dd-th-tool-row" onClick={() => setOpen((o) => !o)} disabled={!has} title={item.at}>
        <span className={`dd-th-tool-caret${open ? " on" : ""}`}>{has ? <ChevronIcon /> : <DotIcon />}</span>
        <span className="dd-th-glyph">
          <ToolIcon />
        </span>
        <span className="dd-th-tool-name mono">{item.name}</span>
        <span className="dd-th-tool-summary clip">{item.summary}</span>
        <span className="dd-th-tool-state">
          {item.status === "running" && <span className="dot run" />}
          {item.status === "error" && <span className="chip bad">failed</span>}
        </span>
      </button>
      {open && (
        <div className="dd-th-tool-body">
          {item.input && (
            <>
              <h4>Input</h4>
              <pre className="dd-th-pre">
                <code>{item.input}</code>
              </pre>
            </>
          )}
          {item.output && (
            <>
              <h4>Output</h4>
              <pre className="dd-th-pre">
                <code>{item.output}</code>
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Prose, with fenced code blocks and inline code.
 *
 * Deliberately not a Markdown renderer: an agent's reply is mostly plain
 * sentences and shell, and the two things that genuinely change meaning when
 * they are not set apart are a code fence and an inline path. Everything else
 * — the asterisks, the hashes — is left exactly as it was written rather than
 * half-interpreted by a hundred lines of regex.
 */
function Prose({ body }: { body: string }) {
  return (
    <div className="dd-th-prose">
      {splitFences(body).map((part, i) =>
        part.code ? (
          <pre className="dd-th-pre" key={i}>
            {part.lang && <span className="dd-th-lang">{part.lang}</span>}
            <code>{part.body}</code>
          </pre>
        ) : (
          <p key={i}>{inlineCode(part.body)}</p>
        ),
      )}
    </div>
  );
}

interface Part {
  code: boolean;
  lang: string;
  body: string;
}

/** Split on ``` fences. An unclosed fence runs to the end, which is what a stream does. */
function splitFences(body: string): Part[] {
  const parts: Part[] = [];
  const fence = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g;
  let at = 0;
  for (let m = fence.exec(body); m !== null; m = fence.exec(body)) {
    const before = body.slice(at, m.index);
    if (before.trim()) parts.push({ code: false, lang: "", body: trimEdges(before) });
    parts.push({ code: true, lang: (m[1] ?? "").trim(), body: (m[2] ?? "").replace(/\n$/, "") });
    at = m.index + m[0].length;
  }
  const rest = body.slice(at);
  if (rest.trim() || parts.length === 0) parts.push({ code: false, lang: "", body: trimEdges(rest) });
  return parts;
}

/** `like this` becomes a code span; nothing else is touched. */
function inlineCode(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`)/g).map((piece, i) =>
    piece.startsWith("`") && piece.endsWith("`") && piece.length > 2 ? (
      <code key={i}>{piece.slice(1, -1)}</code>
    ) : (
      <span key={i}>{piece}</span>
    ),
  );
}

const trimEdges = (s: string) => s.replace(/^\n+/, "").replace(/\s+$/, "");

function ToolIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M6.4 2.6a3.4 3.4 0 0 0 4.2 4.4l2.9 2.9a1.4 1.4 0 0 1-2 2L8.6 9a3.4 3.4 0 0 1-4.4-4.2l1.8 1.8 1.6-1.6z" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DownIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3.5 6 8 10.5 12.5 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DotIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="8" cy="8" r="1.4" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M8 2.6 14 13H2z" strokeLinejoin="round" />
      <path d="M8 6.6v3M8 11.2v.2" strokeLinecap="round" />
    </svg>
  );
}
