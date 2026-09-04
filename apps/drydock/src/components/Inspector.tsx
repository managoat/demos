/**
 * The inspector: what is on the machine, above what you can do to it.
 *
 * Two panes rather than one column of everything, because the two halves are
 * read at different times — you look at a diff while a command is running, and
 * a terminal you have to switch away from to check a file is a terminal you
 * stop using. The splitter is the only piece of state here worth keeping, so
 * it is kept, in `localStorage`, per person rather than per project: how much
 * room a shell needs is a fact about a monitor.
 *
 * The bottom pane collapses to its tab strip. That is not the same as hiding
 * it — the tabs stay visible and clicking one opens the pane again — and it
 * is what makes a 400px column workable on a laptop.
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Capabilities, Project, Thread } from "../../shared/api";
import { Changes, useDiff } from "./Changes";
import { Checks } from "./Checks";
import { FileTree } from "./FileTree";
import { FileViewer } from "./FileViewer";
import type { FileViewerTab } from "./FileViewer";
import { RunPanel } from "./RunPanel";
import { Setup } from "./Setup";
// xterm is ~350 kB and belongs to one tab of one pane, so it is fetched when
// somebody opens the Terminal rather than shipped to everybody who opens the
// app. `Suspense` below covers the one frame it takes on a warm cache.
const Terminal = lazy(() => import("./Terminal").then((m) => ({ default: m.Terminal })));
import "../styles/inspector.css";

export type InspectorTopTab = "files" | "changes" | "checks";
export type InspectorBottomTab = "setup" | "run" | "terminal";
export type InspectorTab = InspectorTopTab | InspectorBottomTab;

export interface InspectorProps {
  /** The thread on screen, or null before one is open. */
  thread: Thread | null;
  project: Project;
  capabilities: Capabilities;
  /**
   * Ask for a tab — the pane it belongs to selects it and opens if collapsed.
   *
   * A loose `string` rather than the union, because the shell holds this in a
   * route and a route is text. A name that is not a tab is ignored rather than
   * refused: an old link should not be a type error.
   */
  openTab?: string;
  /** Called once a request in `openTab` has been applied, so the shell can clear it. */
  onTabHandled?: () => void;
  /** The project as the server returned it after a settings edit. */
  onProjectChange?: (project: Project) => void;
}

const SPLIT_KEY = "drydock.inspector.split";
const SHUT_KEY = "drydock.inspector.collapsed";
const TOP_TABS: readonly InspectorTopTab[] = ["files", "changes", "checks"];

export function Inspector({ thread, project, capabilities, openTab, onTabHandled, onProjectChange }: InspectorProps) {
  const [top, setTop] = useState<InspectorTopTab>("files");
  const [bottom, setBottom] = useState<InspectorBottomTab>("setup");
  const [split, setSplit] = useState(() => readNumber(SPLIT_KEY, 0.58));
  const [shut, setShut] = useState(() => readFlag(SHUT_KEY, false));
  const [dragging, setDragging] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [viewing, setViewing] = useState<{ path: string; tab: FileViewerTab } | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  // The diff is fetched here rather than in the Changes tab: the tab strip
  // shows the file count whether or not that tab is the one open, and the
  // viewer needs the same text to slice one file's hunks out of.
  const diff = useDiff(thread?.id ?? null, nonce);

  useEffect(() => {
    if (!openTab) return;
    if (isTopTab(openTab)) setTop(openTab);
    else if (isBottomTab(openTab)) {
      setBottom(openTab);
      setShut(false);
      write(SHUT_KEY, "false");
    } else return;
    onTabHandled?.();
  }, [openTab, onTabHandled]);

  useEffect(() => {
    setViewing(null);
  }, [thread?.id]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (shut) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const host = hostRef.current;
    if (!host) return;
    const box = host.getBoundingClientRect();
    if (box.height <= 0) return;
    setSplit(clamp((event.clientY - box.top) / box.height, 0.16, 0.86));
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
    write(SPLIT_KEY, String(split));
  };

  const toggleShut = useCallback(() => {
    setShut((prev) => {
      write(SHUT_KEY, String(!prev));
      return !prev;
    });
  }, []);

  const pickBottom = (tab: InspectorBottomTab) => {
    setBottom(tab);
    if (shut) {
      setShut(false);
      write(SHUT_KEY, "false");
    }
  };

  const refresh = () => {
    setNonce((n) => n + 1);
    diff.reload();
  };

  const changeCount = diff.report?.files.length ?? null;

  return (
    <div className="dd-in" ref={hostRef}>
      <section
        className="dd-in-pane"
        style={shut ? { flex: "1 1 auto" } : { flex: `0 0 ${(split * 100).toFixed(2)}%` }}
        aria-label="Files, changes and checks"
      >
        <div className="tabs">
          {TOP_TABS.map((tab) => (
            <button key={tab} className={`tab${top === tab ? " on" : ""}`} onClick={() => setTop(tab)}>
              {topLabel(tab)}
              {tab === "changes" && changeCount !== null ? <span className="count">{changeCount}</span> : null}
            </button>
          ))}
          <span className="dd-in-strip">
            <button className="icon" onClick={refresh} title="Read the machine again">
              <RefreshIcon />
            </button>
          </span>
        </div>
        <div className="dd-in-pane-body">
          {!thread ? (
            <div className="empty dd-in-empty">
              <h3>No thread open</h3>
              <p>Each thread has a machine of its own. Open one and its files, its changes and its checks are here.</p>
            </div>
          ) : top === "files" ? (
            <FileTree thread={thread} refreshKey={nonce} onOpenFile={(path) => setViewing({ path, tab: "file" })} />
          ) : top === "changes" ? (
            <Changes state={diff} onOpen={(path) => setViewing({ path, tab: "diff" })} />
          ) : (
            <Checks thread={thread} capabilities={capabilities} refreshKey={nonce} />
          )}
        </div>
      </section>

      {!shut ? (
        <div
          className={`dd-in-split${dragging ? " on" : ""}`}
          role="separator"
          aria-orientation="horizontal"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => setSplit(0.58)}
        />
      ) : null}

      <section className="dd-in-pane" style={shut ? { flex: "0 0 auto" } : { flex: "1 1 0" }} aria-label="Setup, run and terminal">
        <div className="tabs">
          <button className={`icon dd-in-collapse${shut ? " shut" : ""}`} onClick={toggleShut} title={shut ? "Open this pane" : "Collapse this pane"}>
            <ChevronIcon />
          </button>
          <button className={`tab${bottom === "setup" ? " on" : ""}`} onClick={() => pickBottom("setup")}>
            Setup
          </button>
          <button className={`tab${bottom === "run" ? " on" : ""}`} onClick={() => pickBottom("run")}>
            Run
          </button>
          <button className={`tab${bottom === "terminal" ? " on" : ""}`} onClick={() => pickBottom("terminal")}>
            Terminal
          </button>
        </div>
        {/* Unmounted rather than hidden: the terminal holds a PTY, and a shell
            nothing is looking at is a machine somebody is paying for. */}
        {!shut ? (
          <div className="dd-in-pane-body">
            {bottom === "setup" ? (
              <Setup
                project={project}
                thread={thread}
                capabilities={capabilities}
                refreshKey={nonce}
                onProjectChange={onProjectChange}
              />
            ) : bottom === "run" ? (
              <RunPanel projectId={project.id} thread={thread} capabilities={capabilities} />
            ) : (
              <Suspense fallback={<div className="dd-in-loading skeleton" />}>
                <Terminal thread={thread} capabilities={capabilities} />
              </Suspense>
            )}
          </div>
        ) : null}
      </section>

      {viewing && thread ? (
        <FileViewer
          threadId={thread.id}
          path={viewing.path}
          diff={diff.report?.diff ?? ""}
          initialTab={viewing.tab}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </div>
  );
}

function topLabel(tab: InspectorTopTab): string {
  return tab === "files" ? "All files" : tab === "changes" ? "Changes" : "Checks";
}

function isTopTab(tab: string): tab is InspectorTopTab {
  return tab === "files" || tab === "changes" || tab === "checks";
}

function isBottomTab(tab: string): tab is InspectorBottomTab {
  return tab === "setup" || tab === "run" || tab === "terminal";
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/* localStorage is a preference store here, not a source of truth — a browser
   that refuses it gets the defaults and everything else still works. */
function readNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? clamp(value, 0.16, 0.86) : fallback;
  } catch {
    return fallback;
  }
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "true";
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private browsing, or a quota; not worth telling anybody about */
  }
}

function RefreshIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.7-4" strokeLinecap="round" />
      <path d="M13 2v3h-3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="m4 6.5 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
