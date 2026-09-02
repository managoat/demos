/**
 * A cluster's change, rendered inline.
 *
 * Mend shows a patch you are about to apply, so its viewer is a workspace —
 * copyable, downloadable, per-file collapsible. This one is evidence. The
 * work is already done: either it is on GitHub, where the real review
 * happens, or it never went up and this is the only place it exists. So it is
 * read-only and starts collapsed, and the thing it has to do well is answer
 * "what would it have changed?" in one click.
 */
import { useState } from "react";
import { parseDiff, pathOf } from "../lib/diff";

export function Diff(props: { diff: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const files = parseDiff(props.diff);
  if (files.length === 0) return null;

  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <div className="cdiff">
      <button className="cdiff-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        <span>{props.label ?? (open ? "Hide the change" : "See the change")}</span>
        <span className="counts">
          <i className="plus">{`+${additions}`}</i> <i className="minus">{`−${deletions}`}</i>
        </span>
      </button>
      {open && (
        <div className="cdiff-body">
          {files.map((f, i) => (
            <div key={pathOf(f) + i} className="filediff">
              {files.length > 1 && (
                <div className="filediff-head">
                  <code>{pathOf(f)}</code>
                  {f.status !== "modified" && <span className={`fstatus ${f.status}`}>{f.status}</span>}
                </div>
              )}
              {f.hunks.map((h, j) => (
                <div key={j} className="hunk">
                  <div className="hunk-header">{h.header}</div>
                  {h.lines.map((l, k) => (
                    <div key={k} className={`dline ${l.kind}`}>
                      <span className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                      <span className="dtext">{l.text || " "}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
