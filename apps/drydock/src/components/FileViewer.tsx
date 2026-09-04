/**
 * One file, over the shell: its diff, or its contents.
 *
 * The diff half re-uses the exact text git produced for this path — `diffFor`
 * slices it out of the whole diff without re-serialising it — which is the
 * only way a line number here agrees with a line number in the repository.
 * The hunk header carries both starting numbers, so both gutters are counted
 * from git's own arithmetic rather than guessed from the surrounding lines.
 */
import { useEffect, useMemo, useState } from "react";
import type { FileContent } from "../../shared/api";
import { diffFor } from "../../shared/diff";
import type { ApiError } from "../api/client";
import * as api from "../api/client";
import { Path, asApiError } from "./Changes";

export type FileViewerTab = "diff" | "file";

export interface FileViewerProps {
  threadId: string;
  path: string;
  /** The thread's whole diff. Empty when nothing has changed. */
  diff: string;
  initialTab?: FileViewerTab;
  onClose: () => void;
}

export function FileViewer({ threadId, path, diff, initialTab = "diff", onClose }: FileViewerProps) {
  const [tab, setTab] = useState<FileViewerTab>(initialTab);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const text = useMemo(() => diffFor(diff, path), [diff, path]);

  return (
    <div className="dd-in-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dd-in-modal-card" role="dialog" aria-label={path}>
        <div className="dd-in-modal-head">
          <Path path={path} />
          <button className="icon" onClick={onClose} title="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="tabs dd-in-modal-tabs">
          <button className={`tab${tab === "diff" ? " on" : ""}`} onClick={() => setTab("diff")}>
            Diff
          </button>
          <button className={`tab${tab === "file" ? " on" : ""}`} onClick={() => setTab("file")}>
            File
          </button>
        </div>
        <div className="dd-in-modal-body">{tab === "diff" ? <DiffView text={text} /> : <FileView threadId={threadId} path={path} />}</div>
      </div>
    </div>
  );
}

// ── the diff half ──────────────────────────────────────────────────────

function DiffView({ text }: { text: string }) {
  const hunks = useMemo(() => parseHunks(text), [text]);

  if (!text) {
    return (
      <div className="empty dd-in-empty">
        <h3>Not in this diff</h3>
        <p>Git reports no change to this file on this machine. The File tab shows what is on disk.</p>
      </div>
    );
  }
  if (hunks.length === 0) {
    return (
      <div className="empty dd-in-empty">
        <h3>{/Binary files |GIT binary patch/.test(text) ? "A binary file" : "No lines changed"}</h3>
        <p>
          {/Binary files |GIT binary patch/.test(text)
            ? "Git recorded that this file changed but not how — binary files have no lines to compare."
            : "Git recorded this change without any hunks, which is what a pure rename or a mode change looks like."}
        </p>
      </div>
    );
  }

  return (
    <div className="dd-in-code">
      <div className="dd-in-code-inner">
        {hunks.map((hunk, hi) => (
          <div key={hi}>
            <div className="dd-in-dl hunk">
              <span className="dd-in-dl-n a" />
              <span className="dd-in-dl-n b" />
              <span className="dd-in-dl-t">{hunk.header}</span>
            </div>
            {hunk.lines.map((line, li) => (
              <div key={li} className={`dd-in-dl ${line.kind}`}>
                <span className="dd-in-dl-n a">{line.oldNo ?? ""}</span>
                <span className="dd-in-dl-n b">{line.newNo ?? ""}</span>
                <span className="dd-in-dl-t">
                  {line.kind === "add" ? "+" : line.kind === "del" ? "-" : line.kind === "note" ? "" : " "}
                  {line.text}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

interface DiffLine {
  kind: "add" | "del" | "ctx" | "note";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

interface Hunk {
  header: string;
  lines: DiffLine[];
}

/**
 * Hunks, with both sides numbered.
 *
 * `shared/diff.ts` counts a file; this counts its lines, which is a different
 * job and only the viewer needs it. The traps are the same ones that file
 * documents: `\ No newline at end of file` is not a change, and a header line
 * starts with a character the counter otherwise cares about.
 */
function parseHunks(text: string): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of text.split("\n")) {
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (at) {
      hunk = { header: line, lines: [] };
      hunks.push(hunk);
      oldNo = Number(at[1]);
      newNo = Number(at[2]);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("\\")) {
      hunk.lines.push({ kind: "note", oldNo: null, newNo: null, text: line });
    } else if (line.startsWith("+")) {
      hunk.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      hunk.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
    } else if (line.startsWith(" ") || line === "") {
      hunk.lines.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
    } else {
      // Anything else is the start of the next file's metadata, which
      // `diffFor` should already have cut off — so this only ends the hunk.
      hunk = null;
    }
  }
  return hunks;
}

// ── the file half ──────────────────────────────────────────────────────

function FileView({ threadId, path }: { threadId: string; path: string }) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setContent(null);
    setError(null);
    api
      .readFile(threadId, path)
      .then((next) => live && setContent(next))
      .catch((err: unknown) => live && setError(asApiError(err)))
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [threadId, path]);

  if (loading) {
    return (
      <div className="dd-in-sk">
        {[70, 84, 52, 78, 61, 88, 45].map((w, i) => (
          <div key={i} className="skeleton" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  }
  if (error) return <div className="dd-in-msg error">{error.message}</div>;
  if (!content) return null;

  if (content.encoding === "base64") {
    return (
      <div className="empty dd-in-empty">
        <h3>A binary file</h3>
        <p>This is {formatBytes(content.size)} of bytes rather than text, so there is nothing legible to print here.</p>
        <p className="dd-in-empty-what">{content.path}</p>
      </div>
    );
  }

  const lines = content.content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  return (
    <>
      {content.truncated ? (
        <div className="dd-in-note-bar">
          The machine sent the first part of this file. It is {formatBytes(content.size)} on disk.
        </div>
      ) : null}
      <div className="dd-in-code">
        <div className="dd-in-code-inner">
          {lines.map((line, i) => (
            <div key={i} className="dd-in-fl">
              <span className="dd-in-fl-n">{i + 1}</span>
              <span className="dd-in-fl-t">{line || " "}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} bytes`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} kB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="m4 4 8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  );
}
