/**
 * The All files tab: the machine's disk, one directory at a time.
 *
 * Lazy on purpose. A thread is a fresh clone of a real repository — the header
 * card on a new thread says "copied 1480 files" and means it — so the tree
 * asks for a directory when somebody opens it and never before. Each
 * directory's entries are kept once fetched, which is safe here in a way it
 * would not be in a shared workspace: a thread owns its whole machine, so the
 * only thing that changes the disk under this tree is the agent, and the
 * refresh button in the tab strip is how you say so.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { FileEntry, Thread } from "../../shared/api";
import type { ApiError } from "../api/client";
import * as api from "../api/client";
import { asApiError, isStillBuilding } from "./Changes";

export interface FileTreeProps {
  thread: Thread;
  /** Bumped by the tab strip's refresh button; drops every cached directory. */
  refreshKey: number;
  onOpenFile: (path: string) => void;
}

interface DirState {
  status: "loading" | "ready" | "error";
  entries: FileEntry[];
  truncated: boolean;
  error: ApiError | null;
}

export function FileTree({ thread, refreshKey, onOpenFile }: FileTreeProps) {
  const root = thread.workdir || "/";
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set([root]));
  const [building, setBuilding] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const wanted = useRef<Set<string>>(new Set());

  const load = useCallback(
    async (path: string) => {
      if (wanted.current.has(path)) return;
      wanted.current.add(path);
      setDirs((prev) => ({ ...prev, [path]: { status: "loading", entries: [], truncated: false, error: null } }));
      try {
        const listing = await api.listFiles(thread.id, path);
        setDirs((prev) => ({
          ...prev,
          [path]: { status: "ready", entries: sortEntries(listing.entries), truncated: listing.truncated, error: null },
        }));
        setBuilding(false);
      } catch (err) {
        const failure = asApiError(err);
        if (isStillBuilding(failure)) setBuilding(true);
        setDirs((prev) => ({ ...prev, [path]: { status: "error", entries: [], truncated: false, error: failure } }));
      } finally {
        wanted.current.delete(path);
      }
    },
    [thread.id],
  );

  // The whole tree is re-read on refresh and whenever the thread changes,
  // because a directory listing from another machine is not stale — it is
  // somebody else's disk.
  useEffect(() => {
    wanted.current.clear();
    setDirs({});
    setOpen(new Set([root]));
    setBuilding(false);
    setAttempt(0);
    void load(root);
  }, [load, root, refreshKey]);

  // While the machine is being built there is nothing to ask for yet, so this
  // asks again rather than making a person press a button to find out. The
  // attempt counter is what re-arms the timer after each failed retry.
  useEffect(() => {
    if (!building) return;
    const timer = setTimeout(() => {
      wanted.current.delete(root);
      setAttempt((n) => n + 1);
      void load(root);
    }, 4000);
    return () => clearTimeout(timer);
  }, [building, attempt, load, root]);

  const toggle = (path: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!dirs[path]) void load(path);
      }
      return next;
    });
  };

  const rootState = dirs[root];

  if (building) {
    return (
      <div className="dd-in-wait">
        <span className="dd-in-spin" />
        <span>This thread's machine is still being built.</span>
      </div>
    );
  }
  if (rootState?.status === "error" && rootState.error) {
    return (
      <div className="dd-in-msg error">
        {rootState.error.message}
        <div style={{ marginTop: 10 }}>
          <button
            onClick={() => {
              wanted.current.delete(root);
              void load(root);
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!rootState || rootState.status === "loading") {
    return (
      <div className="dd-in-sk">
        {[52, 68, 44, 60, 72, 48, 64].map((w, i) => (
          <div key={i} className="skeleton" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  }

  return (
    <div className="dd-in-tree">
      <Level dir={root} depth={0} dirs={dirs} open={open} onToggle={toggle} onOpenFile={onOpenFile} />
    </div>
  );
}

interface LevelProps {
  dir: string;
  depth: number;
  dirs: Record<string, DirState>;
  open: Set<string>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}

function Level({ dir, depth, dirs, open, onToggle, onOpenFile }: LevelProps) {
  const state = dirs[dir];
  const pad = 8 + depth * 13;

  if (!state || state.status === "loading") {
    return <div className="dd-in-node-note" style={{ paddingLeft: pad + 17 }}>reading…</div>;
  }
  if (state.status === "error") {
    return (
      <div className="dd-in-node-note" style={{ paddingLeft: pad + 17, color: "var(--bad)" }}>
        {state.error?.message ?? "That directory could not be read."}
      </div>
    );
  }
  if (state.entries.length === 0) {
    return <div className="dd-in-node-note" style={{ paddingLeft: pad + 17 }}>empty</div>;
  }

  return (
    <>
      {state.entries.map((entry) => {
        const path = join(dir, entry.name);
        const isDir = entry.type === "directory";
        const expanded = open.has(path);
        return (
          <div key={path} className="dd-in-kids">
            <button
              className="dd-in-node"
              style={{ paddingLeft: pad }}
              onClick={() => (isDir ? onToggle(path) : onOpenFile(path))}
              title={path}
            >
              <span className={`dd-in-node-caret${expanded ? " open" : ""}`}>{isDir ? <CaretIcon /> : null}</span>
              <span className="dd-in-node-icon">{isDir ? <FolderIcon open={expanded} /> : <FileIcon />}</span>
              <span>{entry.name}</span>
              {entry.change ? <span className="dd-in-node-change">{entry.change}</span> : null}
            </button>
            {isDir && expanded ? (
              <Level dir={path} depth={depth + 1} dirs={dirs} open={open} onToggle={onToggle} onOpenFile={onOpenFile} />
            ) : null}
          </div>
        );
      })}
      {state.truncated ? (
        <div className="dd-in-node-note" style={{ paddingLeft: pad + 17 }}>
          …the machine stopped listing here
        </div>
      ) : null}
    </>
  );
}

/** Directories first, then by name — the order a person scans a repository in. */
function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    const ad = a.type === "directory" ? 0 : 1;
    const bd = b.type === "directory" ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function join(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function CaretIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      {open ? (
        <path d="M2 12.5V4a1 1 0 0 1 1-1h3l1.5 1.5H12a1 1 0 0 1 1 1V7M2 12.5 3.6 7.6a1 1 0 0 1 1-.7h9.1a.6.6 0 0 1 .57.8l-1.4 4.3a1 1 0 0 1-.95.7H3a1 1 0 0 1-1-1Z" strokeLinejoin="round" />
      ) : (
        <path d="M2 12.5v-9a.5.5 0 0 1 .5-.5H6l1.5 1.5H13a.5.5 0 0 1 .5.5v7.5a.5.5 0 0 1-.5.5H2.5a.5.5 0 0 1-.5-.5Z" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M9 2H4.5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5V5L9 2Z" strokeLinejoin="round" />
      <path d="M9 2v3h3" strokeLinejoin="round" />
    </svg>
  );
}
