/**
 * The Skills submenu: a short list of things a chat can be good at, each a
 * SKILL.md on GitHub that Fountain installs on the chat's computer with the
 * skills.sh CLI (`npx skills add <source> --skill <skill>`). Plain names
 * here; the `source`/`skill` pair is what goes on the agent
 * (`server/agents.ts`).
 *
 * Every source was checked on skills.sh and GitHub on 2026-09-01. `ref`
 * pins the commit those checks were made against: anthropics/skills has no
 * tags, and Fountain resolves an unpinned source at spawn time, so two
 * chats a week apart would otherwise install different code.
 */

export interface Skill {
  /** What settings carry (`ChatSettings.skills`). Stable; changing one orphans derived agents. */
  id: string;
  name: string;
  blurb: string;
  /** GitHub `owner/repo`, as skills.sh takes it. */
  source: string;
  /** The skill inside that repo (`--skill`). */
  skill: string;
  /** A tag, branch or sha to install, or undefined for the default branch. */
  ref?: string;
}

const ANTHROPIC = { source: "anthropics/skills", ref: "53048666b05b4799081517d00e09e0a2dd688678" };

export const SKILLS: readonly Skill[] = [
  { id: "pdf", name: "PDFs", blurb: "Read, fill in, combine or make PDF files", skill: "pdf", ...ANTHROPIC },
  { id: "docx", name: "Word documents", blurb: "Write and edit .docx files", skill: "docx", ...ANTHROPIC },
  { id: "xlsx", name: "Spreadsheets", blurb: "Build, fix and chart spreadsheets", skill: "xlsx", ...ANTHROPIC },
  { id: "pptx", name: "Slides", blurb: "Make and edit slide decks", skill: "pptx", ...ANTHROPIC },
  { id: "canvas-design", name: "Posters & visuals", blurb: "Design a poster, card or graphic", skill: "canvas-design", ...ANTHROPIC },
];

export function skillById(id: string): Skill | undefined {
  return SKILLS.find((s) => s.id === id);
}

export function isSkillId(v: unknown): v is string {
  return typeof v === "string" && SKILLS.some((s) => s.id === v);
}

/** One entry of an agent's `skills`, as Fountain's create request takes it. */
export function skillEntry(s: Skill): { source: string; name: string; ref?: string } {
  const entry: { source: string; name: string; ref?: string } = { source: s.source, name: s.skill };
  if (s.ref) entry.ref = s.ref;
  return entry;
}

/** "PDFs, Slides" — the names of the chosen skills, in menu order. */
export function skillNames(ids: readonly string[]): string[] {
  return SKILLS.filter((s) => ids.includes(s.id)).map((s) => s.name);
}
