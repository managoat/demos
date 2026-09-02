/**
 * One sage's thread: your questions, the tool chips while it digs, the
 * answers with citation cards. Everything shown is derived from turns +
 * blocks — the conversation is the system of record.
 */
import { useEffect, useRef, useState } from "react";
import type { Turn } from "../api/types";
import type { Block } from "../lib/acp";
import { splitPathMentions } from "../lib/github";
import { citationsOf, stripBlocks, type RepoMap } from "../lib/protocol";
import { STARTERS, STUDY_PROMPT } from "../lib/spec";
import { CitationCards } from "./Citations";

export interface ThreadEntry {
  turn: Turn;
  blocks: Block[];
  reply: string;
}

export function Chat(props: {
  thread: ThreadEntry[];
  map: RepoMap | null;
  repo: string;
  busy: boolean;
  working: boolean;
  onSend: (text: string) => void;
}) {
  const { map, repo } = props;
  const branch = map?.default_branch ?? "main";
  const knownPaths = map ? [...map.components.map((c) => c.path), ...map.entry_points] : [];
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  const count = props.thread.reduce((n, e) => n + e.blocks.length, 0);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [count, props.working]);

  const submit = () => {
    if (!draft.trim() || props.busy || props.working) return;
    props.onSend(draft.trim());
    setDraft("");
  };

  const showStarters = map !== null && !props.working && props.thread.filter((e) => e.turn.prompt !== STUDY_PROMPT).length === 0;

  return (
    <div className="chat">
      <div className="feed">
        {props.thread.map(({ turn, blocks, reply }) => {
          const citations = citationsOf(reply);
          return (
            <div key={turn.id} className="entry">
              {turn.prompt === STUDY_PROMPT ? (
                <div className="study-note">
                  studying <code>{repo}</code>
                </div>
              ) : (
                <div className="bubble you">{turn.prompt}</div>
              )}
              {blocks.map((b, i) => {
                if (b.kind === "tool") {
                  return (
                    <span key={i} className={`toolchip tool-${b.status}`} title={b.output ? b.output.slice(0, 400) : undefined}>
                      <i />
                      {b.name}
                      {b.summary && <code>{b.summary}</code>}
                    </span>
                  );
                }
                if (b.kind !== "text") return null;
                const prose = stripBlocks(b.body);
                if (!prose) return null;
                return (
                  <div key={i} className="bubble them">
                    <Prose text={prose} repo={repo} branch={branch} knownPaths={knownPaths} />
                  </div>
                );
              })}
              {citations.length > 0 && <CitationCards citations={citations} repo={repo} branch={branch} />}
              {turn.ended_at === null && turn.status !== "failed" && <div className="state-note">digging…</div>}
            </div>
          );
        })}
        {showStarters && (
          <div className="starters">
            {STARTERS.map((q) => (
              <button key={q} className="starter" onClick={() => props.onSend(q)} disabled={props.busy}>
                {q}
              </button>
            ))}
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="composer">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={`Ask about ${repo} — “where is the entry point?”`}
          disabled={props.busy}
        />
        <button className="primary" onClick={submit} disabled={props.busy || props.working || !draft.trim()}>
          {props.working ? "Working…" : "Ask"}
        </button>
      </div>
    </div>
  );
}

/** Prose with `path` / `path:line` mentions linked into the repo on GitHub. */
function Prose(props: { text: string; repo: string; branch: string; knownPaths: string[] }) {
  const segments = splitPathMentions(props.text, props.repo, props.branch, props.knownPaths);
  return (
    <>
      {segments.map((s, i) =>
        s.kind === "link" ? (
          <a key={i} href={s.href} target="_blank" rel="noreferrer">
            <code>{s.text}</code>
          </a>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}
