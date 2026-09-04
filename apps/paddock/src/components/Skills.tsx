/**
 * The Skills editor, on [Setup](./Setup.tsx).
 *
 * It has a file of its own because it is the one part of the panel that talks
 * to something outside this app — skills.sh, through paddock's own server —
 * and that gives it a state machine (idle, searching, unavailable) and two
 * add-by-hand shapes that none of the other editors have.
 */
import { useState } from "react";
import type { Agent } from "../api/types";
import { paddock } from "../api/paddock";
import type { SkillEntry, SkillHit } from "../lib/skills";
import { githubSkill, hitToSkill, inlineSkill, parseSource, readSkills, skillKey, skillLabel } from "../lib/skills";
import { Editor } from "./Panel";

/**
 * Skills: the skills.sh index, then the two shapes by hand.
 *
 * This editor used to append a bare string, which Fountain refuses outright —
 * `skills` is an array of objects and always has been. See `lib/skills.ts` for
 * the shapes and for why the bug survived as long as it did.
 *
 * The index is skills.sh and the panel says so, because the MCP section two
 * blocks up looks similar and is not the same kind of list: those entries are
 * dated claims Fountain checked, and these are whatever the ecosystem uploaded.
 * A github skill is `npx skills add owner/repo` run on the machine, from a
 * repository nobody here vouches for, and the person clicking `+` is the only
 * one in a position to judge that.
 */
export function Skills({ agent, onSave }: { agent: Agent; onSave: (patch: Partial<Agent>) => Promise<void> }) {
  const entries = readSkills(agent.skills);
  const [error, setError] = useState<string | null>(null);

  function save(next: SkillEntry[]) {
    setError(null);
    return onSave({ skills: next });
  }

  const have = new Set(entries.map(skillKey));

  async function add(entry: SkillEntry) {
    if (have.has(skillKey(entry))) return;
    await save([...entries, entry]);
  }

  return (
    <Editor
      title="Skills"
      summary={entries.length ? entries.map(skillLabel).join(", ") : "none"}
      info={
        <>
          Search is skills.sh, not Fountain — Fountain curates no list of skills, so nothing here is verified by anyone, and
          adding one runs its installer on your machine. A repository can hold many skills; naming one installs only that one.
          Without a ref, Fountain resolves the default branch <em>when a tab opens</em>, so two tabs a week apart can get
          different code — pin anything you depend on. <em>Write it here</em> runs no installer: Fountain writes what you type
          to the machine as <code>SKILL.md</code>.
        </>
      }
    >
      <div className="chips">
        {entries.map((entry, i) => (
          <span className="chip" key={`${skillKey(entry)}-${i}`}>
            {skillLabel(entry)}
            <button className="x" onClick={() => void save(entries.filter((_, j) => j !== i))} title="remove">
              ×
            </button>
          </span>
        ))}
        {entries.length === 0 && <span className="fine">none</span>}
      </div>

      <SkillSearch have={have} onAdd={add} />
      <SkillByHand onAdd={add} onError={setError} />

      {error && <p className="fine error">{error}</p>}
    </Editor>
  );
}

/**
 * The index, through paddock's own server.
 *
 * It has to be: skills.sh sends no CORS header, so this browser cannot read it
 * directly. `server/skills.ts` carries the rest of that note.
 *
 * Search being unavailable is a normal state, not an error — the form below
 * still works and somebody who knows the `owner/repo` should not be stopped by
 * a search box.
 */
function SkillSearch({ have, onAdd }: { have: Set<string>; onAdd: (entry: SkillEntry) => Promise<void> }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SkillHit[] | null>(null);
  const [state, setState] = useState<"idle" | "searching" | "unavailable">("idle");

  async function run() {
    const query = q.trim();
    if (query.length < 2) return;
    setState("searching");
    try {
      const res = await paddock.searchSkills(query);
      setHits(res.data);
      setState(res.unavailable ? "unavailable" : "idle");
    } catch {
      setHits([]);
      setState("unavailable");
    }
  }

  return (
    <>
      <div className="editor-row">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search skills.sh — pdf, postgres, code review"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
        />
        <button onClick={() => void run()} disabled={q.trim().length < 2 || state === "searching"}>
          {state === "searching" ? "…" : "search"}
        </button>
      </div>

      {/* skills.sh answers in two to eight seconds when it answers at all, so
          the wait is said out loud rather than left as a spinner somebody
          assumes is broken. `server/skills.ts` has the measurements. */}
      {state === "searching" && <p className="fine">Asking skills.sh — it can take a few seconds.</p>}
      {state === "unavailable" && <p className="fine">skills.sh did not answer. Add an owner/repo below instead.</p>}
      {state === "idle" && hits?.length === 0 && <p className="fine">Nothing found.</p>}

      {hits && hits.length > 0 && (
        <ul className="rows hits">
          {hits.map((hit) => {
            const entry = hitToSkill(hit);
            const already = have.has(skillKey(entry));
            return (
              <li className="row" key={`${hit.source}#${hit.skill}`}>
                <span className="row-label">{hit.label}</span>
                <code className="dim">{hit.source}</code>
                <span className="fine">{installs(hit.installs)}</span>
                <button className="ghost" onClick={() => void onAdd(entry)} disabled={already} title={already ? "already added" : `add ${hit.skill}`}>
                  {already ? "added" : "add"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** Both shapes, typed out. Everything the index can offer, and everything it cannot. */
function SkillByHand({ onAdd, onError }: { onAdd: (entry: SkillEntry) => Promise<void>; onError: (why: string | null) => void }) {
  const [kind, setKind] = useState<"github" | "inline">("github");
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const [pick, setPick] = useState("");
  const [name, setName] = useState("");
  const [content, setContent] = useState("");

  async function submit() {
    onError(null);
    if (kind === "inline") {
      const made = inlineSkill({ name, content });
      if ("error" in made) return onError(made.error);
      await onAdd(made.entry);
      setName("");
      setContent("");
      return;
    }
    // A pasted GitHub URL or an `owner/repo@ref` is obviously the same intent
    // as the two fields, so it is read rather than refused.
    const parsed = parseSource(source);
    const made = githubSkill({ source: parsed.source, ref: ref.trim() || parsed.ref, name: pick });
    if ("error" in made) return onError(made.error);
    await onAdd(made.entry);
    setSource("");
    setRef("");
    setPick("");
  }

  return (
    <>
      <div className="editor-row">
        <select className="narrow" value={kind} onChange={(e) => setKind(e.target.value as "github" | "inline")}>
          <option value="github">from GitHub</option>
          <option value="inline">write it here</option>
        </select>
        {kind === "github" ? (
          <>
            <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="anthropics/skills" spellCheck={false} />
            <input className="narrow" value={pick} onChange={(e) => setPick(e.target.value)} placeholder="skill (optional)" spellCheck={false} />
            <input className="narrow" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="ref (optional)" spellCheck={false} />
          </>
        ) : (
          <input className="narrow" value={name} onChange={(e) => setName(e.target.value)} placeholder="house-style" spellCheck={false} />
        )}
        <button onClick={() => void submit()} disabled={kind === "github" ? !source.trim() : !name.trim() || !content.trim()}>
          add
        </button>
      </div>

      {kind === "inline" && (
        <textarea
          className="script"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={6}
          spellCheck={false}
          placeholder={"---\nname: house-style\ndescription: Our commit and PR conventions.\n---\n\n# House style"}
        />
      )}
    </>
  );
}

/** `190279` → `190k`. A rough sense of scale is the whole value of the number. */
function installs(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M ↓`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k ↓`;
  return `${n} ↓`;
}
