/** Citation cards under an answer — path, line range, why, deep-linked to GitHub. */
import { blobUrl } from "../lib/github";
import type { Citation } from "../lib/protocol";

function lines(c: Citation): string {
  if (c.start === undefined) return "whole file";
  if (c.end === undefined || c.end === c.start) return `line ${c.start}`;
  return `lines ${c.start}–${c.end}`;
}

export function CitationCards(props: { citations: Citation[]; repo: string; branch: string }) {
  if (props.citations.length === 0) return null;
  return (
    <div className="citations">
      {props.citations.map((c, i) => (
        <a
          key={`${c.path}:${c.start ?? 0}:${i}`}
          className="citation"
          href={blobUrl(props.repo, props.branch, c.path, c.start, c.end)}
          target="_blank"
          rel="noreferrer"
        >
          <code>{c.path}</code>
          <span className="citation-lines">{lines(c)}</span>
          {c.why && <span className="citation-why">{c.why}</span>}
        </a>
      ))}
    </div>
  );
}
