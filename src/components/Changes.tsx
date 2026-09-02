/**
 * The Changes panel: what the chat's computer has done to the repository,
 * as the latest snapshot the server holds (shared/changes.ts) — the branch
 * and where it stands, the pull request when there is one, the files, and
 * each file's diff. Every browser in the chat draws the same record.
 */
import { useMemo, useState } from "react";
import { changesLine, parseDiff, shortSha, type ChangesDto, type FileDiff, type FileStatus } from "../../shared/changes";
import { formatTime } from "../lib/format";

/** A file with more lines than this starts folded. */
const FOLD_OVER = 400;

export function ChangesPanel({ changes, onClose }: { changes: ChangesDto | null; onClose: () => void }) {
  const files = useMemo(() => (changes ? parseDiff(changes.diff) : []), [changes]);
  const [current, setCurrent] = useState<string | null>(null);

  return (
    <aside className="changes-panel" aria-label="Changes">
      <div className="changes-head">
        <div className="changes-title">
          <span className="display">Changes</span>
          {changes && <span className="muted small">{changesLine(changes.files)}</span>}
        </div>
        <button type="button" className="icon" onClick={onClose} aria-label="Close changes">
          ×
        </button>
      </div>
      {!changes && (
        <p className="muted small pad">
          Nothing yet. Once the computer has a repository and touches it, what changed shows here for everyone in the chat.
        </p>
      )}
      {changes && (
        <>
          <div className="changes-where small">
            <span className="mono">{changes.branch || shortSha(changes.head)}</span>
            {changes.head && <span className="muted mono">{shortSha(changes.head)}</span>}
            <span className="muted">
              against <span className="mono">{changes.base}</span>
            </span>
            <span className="muted">· {formatTime(changes.at)}</span>
            {changes.pr && (
              <a className="pr-link" href={changes.pr.url} target="_blank" rel="noreferrer">
                Pull request · {prWord(changes.pr.state)}
              </a>
            )}
          </div>
          {changes.truncated && <div className="changes-note small">The diff was too long to keep whole; what is here is the first part of it.</div>}
          {files.length === 0 && <p className="muted small pad">The tree is clean: nothing differs from {changes.base}.</p>}
          {files.length > 0 && (
            <nav className="changes-files">
              {files.map((f) => (
                <a key={f.path} href={`#file-${encodeURIComponent(f.path)}`} className={`changes-file${current === f.path ? " on" : ""}`} onClick={() => setCurrent(f.path)}>
                  <span className={`file-status ${f.status}`}>{statusMark(f.status)}</span>
                  <span className="file-path">{f.path}</span>
                  <span className="file-counts">
                    {f.additions > 0 && <span className="add">+{f.additions}</span>}
                    {f.deletions > 0 && <span className="del">−{f.deletions}</span>}
                  </span>
                </a>
              ))}
            </nav>
          )}
          <div className="changes-body">
            {files.map((f) => (
              <FileView key={f.path} file={f} />
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

function FileView({ file }: { file: FileDiff }) {
  const lines = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const [open, setOpen] = useState(lines <= FOLD_OVER);
  return (
    <section className="file" id={`file-${encodeURIComponent(file.path)}`}>
      <header className="file-head" onClick={() => setOpen((o) => !o)}>
        <span className={`file-status ${file.status}`}>{statusMark(file.status)}</span>
        <span className="file-path">
          {file.oldPath && (
            <>
              <span className="muted">{file.oldPath}</span> →{" "}
            </>
          )}
          {file.path}
        </span>
        <span className="file-counts">
          {file.additions > 0 && <span className="add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="del">−{file.deletions}</span>}
        </span>
        <span className="muted tiny">{open ? "▾" : "▸"}</span>
      </header>
      {open && file.binary && <div className="muted small pad">A binary file.</div>}
      {open && !file.binary && file.hunks.length === 0 && <div className="muted small pad">{file.status === "renamed" ? "Renamed, unchanged." : "No lines changed."}</div>}
      {open && !file.binary && file.hunks.length > 0 && (
        <table className="diff">
          <tbody>
            {file.hunks.map((h, hi) => (
              <HunkRows key={hi} hunk={h} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function HunkRows({ hunk }: { hunk: FileDiff["hunks"][number] }) {
  return (
    <>
      <tr className="hunk">
        <td className="no" />
        <td className="no" />
        <td className="code">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@ {hunk.heading}
        </td>
      </tr>
      {hunk.lines.map((l, i) => (
        <tr key={i} className={l.type}>
          <td className="no">{l.oldNo ?? ""}</td>
          <td className="no">{l.newNo ?? ""}</td>
          <td className="code">
            <span className="sign">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
            {l.text}
          </td>
        </tr>
      ))}
    </>
  );
}

function statusMark(s: FileStatus): string {
  switch (s) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "modified":
      return "M";
  }
}

function prWord(state: string): string {
  switch (state.toUpperCase()) {
    case "OPEN":
      return "open";
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return state.toLowerCase();
  }
}
