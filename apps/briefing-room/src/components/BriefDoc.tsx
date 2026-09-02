/**
 * A brief, rendered as a document, not a bubble: title, TL;DR box, sections
 * with generous type, numbered sources, caveats as a quiet footnote. Version
 * chips flip between revisions; analyst's notes and the follow-up input live
 * under the document. ⌘P prints just the document (see the print styles).
 */
import { useEffect, useState, type ReactNode } from "react";
import { parseMd, type Inline } from "../lib/md";
import type { BriefThread } from "../lib/protocol";

function Inlines({ kids }: { kids: Inline[] }) {
  return (
    <>
      {kids.map((k, i) => {
        switch (k.t) {
          case "text":
            return k.s;
          case "b":
            return (
              <strong key={i}>
                <Inlines kids={k.kids} />
              </strong>
            );
          case "i":
            return (
              <em key={i}>
                <Inlines kids={k.kids} />
              </em>
            );
          case "code":
            return <code key={i}>{k.s}</code>;
          case "a":
            return (
              <a key={i} href={k.href} target="_blank" rel="noopener">
                <Inlines kids={k.kids} />
              </a>
            );
        }
      })}
    </>
  );
}

export function MdBody({ src }: { src: string }) {
  return (
    <>
      {parseMd(src).map((block, i) =>
        block.t === "p" ? (
          <p key={i}>
            <Inlines kids={block.kids} />
          </p>
        ) : (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>
                <Inlines kids={item} />
              </li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}

function dateLine(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

const DEPTH_LABEL: Record<string, string> = { quick: "Quick scan", standard: "Standard", deep: "Deep dive" };

export function BriefDoc(props: {
  thread: BriefThread;
  busy: boolean;
  working: boolean;
  onFollowup: (text: string) => void;
  progress?: ReactNode;
}) {
  const { thread } = props;
  const versionCount = thread.versions.length;
  const [versionIdx, setVersionIdx] = useState(versionCount - 1);
  const [draft, setDraft] = useState("");

  // A new revision arrived (or another thread was opened): show its latest.
  useEffect(() => {
    setVersionIdx(versionCount - 1);
  }, [thread.id, versionCount]);

  const current = thread.versions[Math.min(versionIdx, versionCount - 1)]!;
  const brief = current.brief;
  const written = dateLine(brief.written_at);

  const submit = () => {
    if (!draft.trim() || props.busy || props.working) return;
    props.onFollowup(draft.trim());
    setDraft("");
  };

  return (
    <div>
      {props.progress}
      <article className="doc">
        <div className="kicker">
          {brief.depth && <span>{DEPTH_LABEL[brief.depth] ?? brief.depth}</span>}
          {written && <span>{written}</span>}
          {versionCount > 1 && (
            <span className="versions">
              {thread.versions.map((_, i) => (
                <button key={i} className={i === versionIdx ? "chip active" : "chip"} onClick={() => setVersionIdx(i)}>
                  {`v${i + 1}`}
                </button>
              ))}
            </span>
          )}
        </div>
        <h1>{brief.title}</h1>
        {brief.asked && <p className="asked">{brief.asked}</p>}
        {brief.tldr.length > 0 && (
          <div className="tldr">
            <div className="label">The short version</div>
            <p>{brief.tldr.join(" ")}</p>
          </div>
        )}
        {brief.sections.map((s, i) => (
          <section key={i}>
            {s.heading && <h2>{s.heading}</h2>}
            <MdBody src={s.body_md} />
          </section>
        ))}
        {brief.sources.length > 0 && (
          <div className="sources">
            <h2>Sources</h2>
            <ol>
              {brief.sources.map((s, i) => (
                <li key={i}>
                  <a href={s.url} target="_blank" rel="noopener">
                    {s.title}
                  </a>
                  {s.note && <span className="note"> — {s.note}</span>}
                </li>
              ))}
            </ol>
          </div>
        )}
        {brief.caveats.length > 0 && (
          <div className="caveats">
            <h2>What this could not verify</h2>
            <ul>
              {brief.caveats.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </div>
        )}
        {thread.notes.length > 0 && (
          <div className="notes">
            {thread.notes.map((n, i) => (
              <div className="note" key={i}>
                {n.question && <div className="q">{`You asked: ${n.question}`}</div>}
                <div className="label">Analyst's note</div>
                <MdBody src={n.text} />
              </div>
            ))}
          </div>
        )}
      </article>
      <div className="followup">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={props.working ? "The researcher is working…" : "Ask a follow-up or request a revision"}
          disabled={props.busy || props.working}
        />
        <button className="primary" onClick={submit} disabled={props.busy || props.working || !draft.trim()}>
          Ask
        </button>
      </div>
      <p className="fineprint print-hint">Print (⌘P) for a clean handout of this brief.</p>
    </div>
  );
}
