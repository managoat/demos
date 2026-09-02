import { useMemo, useState, type CSSProperties } from "react";
import type { FountainClient } from "../api/client";
import { describeError } from "../api/client";
import type { Agent, Skill } from "../api/types";
import { SKILL_CATALOG, catalogByCollection, hasSkill, isInline, parseSkillSource, searchCatalog, skillFromCatalog, skillLabel, skillTemplate, validSkillName, withSkill, withoutSkill, type CatalogSkill } from "../lib/skills";

/**
 * The Skills tab: what the teammate has, a catalog to pick from (skills.sh
 * collections, one line each), any GitHub repo by name or URL, or a skill
 * written right here. Each change is one PUT of the whole list.
 */
export function SkillsTab({ client, agent, name, onAgent }: { client: FountainClient; agent: Agent | null; name: string; onAgent: (a: Agent) => void }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<"github" | "inline" | null>(null);
  // from GitHub
  const [source, setSource] = useState("");
  const [sourceName, setSourceName] = useState("");
  // write your own
  const [inlineName, setInlineName] = useState("");
  const [inlineContent, setInlineContent] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  const skills: Skill[] = agent?.skills ?? [];
  const groups = useMemo(() => catalogByCollection(searchCatalog(query, SKILL_CATALOG)), [query]);

  const save = async (next: Skill[], key: string) => {
    if (!agent) return;
    setBusy(key);
    setError(null);
    try {
      onAgent(await client.updateAgent(agent.id, { skills: next }));
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const keyOf = (s: Skill) => (isInline(s) ? `inline:${s.name}` : `${s.source}#${s.name ?? ""}`);
  const add = (s: Skill) => void save(withSkill(skills, s), keyOf(s));
  const remove = (s: Skill) => void save(withoutSkill(skills, s), keyOf(s));

  const parsed = parseSkillSource(source, sourceName);
  const addFromGithub = async () => {
    if (!parsed) return;
    if (await save(withSkill(skills, parsed), "github")) {
      setSource("");
      setSourceName("");
      setAdding(null);
    }
  };

  const openEditor = (s?: { name: string; content: string }) => {
    setEditing(s?.name ?? null);
    setInlineName(s?.name ?? "");
    setInlineContent(s?.content ?? skillTemplate(""));
    setAdding("inline");
  };
  const inlineOk = validSkillName(inlineName.trim()) && inlineContent.trim().length > 0;
  const saveInline = async () => {
    if (!inlineOk) return;
    const entry: Skill = { name: inlineName.trim(), content: inlineContent };
    // editing under a new name: the old entry goes
    const base = editing && editing !== entry.name ? withoutSkill(skills, { name: editing, content: "" }) : withoutSkill(skills, entry);
    if (await save([...base, entry], "inline")) {
      setAdding(null);
      setEditing(null);
    }
  };

  return (
    <div className="tab-body">
      <p className="muted small tab-lede">
        Skills are know-how {name} reads when it is relevant — a SKILL.md on their computer. Pick from the catalog, add any GitHub repo, or write one.
      </p>

      {error && <div className="error">{error}</div>}

      <section>
        <div className="section-head">
          <h3>{name} has</h3>
          <span className="muted small">{skills.length === 0 ? "nothing yet" : `${skills.length} skill${skills.length === 1 ? "" : "s"}`}</span>
        </div>
        {skills.length > 0 && (
          <ul className="pick-list">
            {skills.map((s) => {
              const k = keyOf(s);
              const fromCatalog = !isInline(s) && SKILL_CATALOG.find((c) => c.source.toLowerCase() === s.source.toLowerCase() && c.name === s.name);
              return (
                <li key={k} className="pick-row">
                  <Tile text={skillLabel(s)} />
                  <div className="pick-text">
                    <div className="pick-title">
                      {skillLabel(s)}
                      {isInline(s) && <span className="tag">written here</span>}
                      {!isInline(s) && s.ref && <span className="tag mono">@{s.ref}</span>}
                    </div>
                    <div className="pick-sub">
                      {isInline(s) ? (
                        <button type="button" className="linkish" onClick={() => openEditor(s)}>
                          edit
                        </button>
                      ) : (
                        <>
                          {fromCatalog ? `${fromCatalog.blurb} · ` : ""}
                          <a href={`https://github.com/${s.source}`} target="_blank" rel="noreferrer">
                            {s.source}
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                  <button type="button" className="secondary small" disabled={!agent || busy !== null} onClick={() => remove(s)} title="Remove this skill">
                    {busy === k ? "…" : "Remove"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <div className="section-head">
          <h3>Add a skill</h3>
          <div className="row">
            <button type="button" className={`secondary small ${adding === "github" ? "active" : ""}`} onClick={() => setAdding(adding === "github" ? null : "github")}>
              From GitHub…
            </button>
            <button type="button" className={`secondary small ${adding === "inline" ? "active" : ""}`} onClick={() => (adding === "inline" ? setAdding(null) : openEditor())}>
              Write your own…
            </button>
          </div>
        </div>

        {adding === "github" && (
          <form
            className="add-form"
            onSubmit={(e) => {
              e.preventDefault();
              void addFromGithub();
            }}
          >
            <label>
              Repository
              <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="owner/repo, owner/repo@ref, or a GitHub / skills.sh link" autoFocus />
            </label>
            <label>
              Skill <span className="muted">(when the repo holds several)</span>
              <input value={sourceName} onChange={(e) => setSourceName(e.target.value)} placeholder="e.g. pdf — blank installs all of them" />
            </label>
            <div className="row end">
              <span className="hint" style={{ flex: 1, marginTop: 0 }}>
                Installed on their computer with the skills.sh CLI.
              </span>
              <button type="button" className="secondary small" onClick={() => setAdding(null)}>
                Cancel
              </button>
              <button type="submit" className="small" disabled={!parsed || !agent || busy !== null}>
                {busy === "github" ? "Adding…" : "Add"}
              </button>
            </div>
          </form>
        )}

        {adding === "inline" && (
          <form
            className="add-form"
            onSubmit={(e) => {
              e.preventDefault();
              void saveInline();
            }}
          >
            <label>
              Name
              <input value={inlineName} onChange={(e) => setInlineName(e.target.value)} placeholder="house-style" autoFocus className={inlineName && !validSkillName(inlineName.trim()) ? "invalid" : ""} />
              <span className="hint">Letters, digits, dots, dashes — it is the folder name.</span>
            </label>
            <label>
              SKILL.md
              <textarea value={inlineContent} onChange={(e) => setInlineContent(e.target.value)} rows={10} className="mono" spellCheck={false} />
              <span className="hint">The front matter's description is what {name} matches against to decide the skill applies.</span>
            </label>
            <div className="row end">
              <button type="button" className="secondary small" onClick={() => setAdding(null)}>
                Cancel
              </button>
              <button type="submit" className="small" disabled={!inlineOk || !agent || busy !== null}>
                {busy === "inline" ? "Saving…" : editing ? "Save" : "Add"}
              </button>
            </div>
          </form>
        )}

        <label className="search">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the catalog — pdf, react, debugging, marketing…" aria-label="Search skills" />
        </label>
        {groups.length === 0 && (
          <div className="muted small pick-empty">
            Nothing in the catalog matches. Any skill on GitHub installs with <b>From GitHub…</b> above.
          </div>
        )}
        {groups.map((g) => (
          <div key={g.collection} className="pick-group">
            <div className="pick-group-head">{g.collection}</div>
            <ul className="pick-list">
              {g.skills.map((c: CatalogSkill) => {
                const entry = skillFromCatalog(c);
                const has = hasSkill(skills, entry);
                const k = keyOf(entry);
                return (
                  <li key={k} className={`pick-row ${has ? "has" : ""}`}>
                    <Tile text={c.name} />
                    <div className="pick-text">
                      <div className="pick-title">{c.name}</div>
                      <div className="pick-sub">{c.blurb}</div>
                    </div>
                    {has ? (
                      <button type="button" className="secondary small added" disabled={!agent || busy !== null} onClick={() => remove(entry)} title="Remove">
                        {busy === k ? "…" : "✓ Added"}
                      </button>
                    ) : (
                      <button type="button" className="small" disabled={!agent || busy !== null} onClick={() => add(entry)}>
                        {busy === k ? "…" : "Add"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        <div className="muted small pick-foot">
          The catalog is a slice of{" "}
          <a href="https://skills.sh" target="_blank" rel="noreferrer">
            skills.sh
          </a>
          ; anything there installs by repository.
        </div>
      </section>
    </div>
  );
}

/** A little monogram tile, the same shape the Apps tab uses for connectors. */
export function Tile({ text, domain }: { text: string; domain?: string }) {
  const hue = useMemo(() => {
    let h = 0;
    for (const ch of domain ?? text) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }, [text, domain]);
  return (
    <div className="tile" style={{ "--h": hue } as CSSProperties} aria-hidden>
      {text.replace(/^[^a-z0-9]+/i, "").slice(0, 1).toUpperCase() || "?"}
    </div>
  );
}
