/**
 * Skills a teammate can pick up — the catalog the Skills tab offers and the
 * pure helpers around an agent's `skills` list.
 *
 * A skill is a SKILL.md (plus whatever files sit beside it) that the runtime
 * reads when it is relevant. Fountain installs GitHub-sourced ones on the
 * teammate's computer through the skills.sh CLI (`{source: "owner/repo",
 * name?, ref?}`) and writes inline ones (`{name, content}`) straight to the
 * skills directory. Either way they land when the computer is set up, so a
 * change here applies on the teammate's next fresh computer.
 */
import type { Skill } from "../api/types";

export interface CatalogSkill {
  /** GitHub owner/repo the skills.sh CLI installs from */
  source: string;
  /** the skill's directory name inside the repo (skills.sh `--skill`) */
  name: string;
  /** what it is, in one line, for the picker */
  blurb: string;
  /** who publishes it, for grouping */
  collection: string;
}

/**
 * A curated slice of skills.sh: well-known collections with one line each.
 * Anything else installs by typing `owner/repo` (and a skill name when the
 * repo holds several).
 */
export const SKILL_CATALOG: CatalogSkill[] = [
  // anthropics/skills — Anthropic's own
  { source: "anthropics/skills", name: "pdf", blurb: "Read, fill, merge and create PDFs", collection: "Anthropic" },
  { source: "anthropics/skills", name: "docx", blurb: "Write and edit Word documents", collection: "Anthropic" },
  { source: "anthropics/skills", name: "xlsx", blurb: "Spreadsheets: formulas, charts, clean data", collection: "Anthropic" },
  { source: "anthropics/skills", name: "pptx", blurb: "Build and revise slide decks", collection: "Anthropic" },
  { source: "anthropics/skills", name: "frontend-design", blurb: "Distinctive, production-grade web UI", collection: "Anthropic" },
  { source: "anthropics/skills", name: "webapp-testing", blurb: "Drive and test web apps in a real browser", collection: "Anthropic" },
  { source: "anthropics/skills", name: "mcp-builder", blurb: "Write an MCP server that exposes an API as tools", collection: "Anthropic" },
  { source: "anthropics/skills", name: "skill-creator", blurb: "Author new skills, the Anthropic way", collection: "Anthropic" },
  { source: "anthropics/skills", name: "canvas-design", blurb: "Posters, art and visual pieces as files", collection: "Anthropic" },
  { source: "anthropics/skills", name: "brand-guidelines", blurb: "Keep output on-brand: colours, type, voice", collection: "Anthropic" },
  { source: "anthropics/skills", name: "internal-comms", blurb: "Status reports, announcements, FAQs", collection: "Anthropic" },
  // vercel-labs/agent-skills
  { source: "vercel-labs/agent-skills", name: "react-best-practices", blurb: "React and Next.js performance patterns", collection: "Vercel" },
  { source: "vercel-labs/agent-skills", name: "web-design-guidelines", blurb: "Review UI against web design guidelines", collection: "Vercel" },
  { source: "vercel-labs/agent-skills", name: "composition-patterns", blurb: "Composable React component patterns", collection: "Vercel" },
  // obra/superpowers — an engineering workflow
  { source: "obra/superpowers", name: "brainstorming", blurb: "Explore intent before building", collection: "Superpowers" },
  { source: "obra/superpowers", name: "test-driven-development", blurb: "Red, green, refactor — tests first", collection: "Superpowers" },
  { source: "obra/superpowers", name: "systematic-debugging", blurb: "Find root causes, not symptoms", collection: "Superpowers" },
  { source: "obra/superpowers", name: "writing-plans", blurb: "Turn a brief into an implementation plan", collection: "Superpowers" },
  { source: "obra/superpowers", name: "executing-plans", blurb: "Work a plan step by step, checking in", collection: "Superpowers" },
  { source: "obra/superpowers", name: "verification-before-completion", blurb: "Prove it works before calling it done", collection: "Superpowers" },
  // others
  { source: "supabase/agent-skills", name: "supabase-postgres-best-practices", blurb: "Postgres schema, queries and RLS, done right", collection: "Supabase" },
  { source: "remotion-dev/skills", name: "remotion-best-practices", blurb: "Programmatic video with Remotion", collection: "Remotion" },
  { source: "expo/skills", name: "expo-native-ui", blurb: "Native-feeling Expo and React Native UI", collection: "Expo" },
  { source: "expo/skills", name: "expo-router", blurb: "Navigation with Expo Router", collection: "Expo" },
  { source: "coreyhaines31/marketingskills", name: "copywriting", blurb: "Landing pages, emails and ads that convert", collection: "Marketing" },
  { source: "coreyhaines31/marketingskills", name: "seo-audit", blurb: "Audit a site's SEO and say what to fix", collection: "Marketing" },
];

/** Collections in catalog order, each with its skills. */
export function catalogByCollection(catalog: CatalogSkill[] = SKILL_CATALOG): Array<{ collection: string; skills: CatalogSkill[] }> {
  const out: Array<{ collection: string; skills: CatalogSkill[] }> = [];
  for (const s of catalog) {
    let g = out.find((x) => x.collection === s.collection);
    if (!g) out.push((g = { collection: s.collection, skills: [] }));
    g.skills.push(s);
  }
  return out;
}

/** Catalog rows matching a search (name, blurb, source, collection), or all of them for a blank query. */
export function searchCatalog(query: string, catalog: CatalogSkill[] = SKILL_CATALOG): CatalogSkill[] {
  const q = query.trim().toLowerCase();
  if (!q) return catalog;
  const words = q.split(/\s+/);
  return catalog.filter((s) => {
    const hay = `${s.name} ${s.blurb} ${s.source} ${s.collection}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function isInline(s: Skill): s is { name: string; content: string } {
  return typeof (s as { content?: unknown }).content === "string";
}

/** What to call a skill in a list: its name, or the repo when a GitHub entry has no name. */
export function skillLabel(s: Skill): string {
  if (isInline(s)) return s.name;
  return s.name || s.source.split("/")[1] || s.source;
}

/** Same installed skill? GitHub entries match on source+name; inline ones on name. */
export function sameSkill(a: Skill, b: Skill): boolean {
  if (isInline(a) || isInline(b)) return isInline(a) && isInline(b) && a.name === b.name;
  return a.source.toLowerCase() === b.source.toLowerCase() && (a.name ?? "") === (b.name ?? "");
}

export function hasSkill(skills: Skill[], s: Skill): boolean {
  return skills.some((x) => sameSkill(x, s));
}

/** The list with `s` added (no-op when an equal entry is already there). */
export function withSkill(skills: Skill[], s: Skill): Skill[] {
  return hasSkill(skills, s) ? skills : [...skills, s];
}

export function withoutSkill(skills: Skill[], s: Skill): Skill[] {
  return skills.filter((x) => !sameSkill(x, s));
}

/** The agent entry for a catalog row. */
export function skillFromCatalog(c: CatalogSkill): Skill {
  return { source: c.source, name: c.name };
}

const SOURCE_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF_RE = /^[A-Za-z0-9._/-]+$/;
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Turn what someone typed into a GitHub skill entry. Accepts `owner/repo`,
 * `owner/repo@ref`, a github.com URL to the repo (optionally deep into
 * `…/tree/<ref>/<path>/<skill>`), or a skills.sh URL `skills.sh/owner/repo/skill`.
 * Returns null when it is none of those.
 */
export function parseSkillSource(input: string, skillName = ""): { source: string; name?: string; ref?: string } | null {
  let text = input.trim();
  let name = skillName.trim();
  let ref: string | undefined;
  const url = text.match(/^(?:https?:\/\/)?(?:www\.)?(github\.com|skills\.sh)\/([^/\s]+)\/([^/\s#?]+)(?:\/(.*))?$/i);
  if (url) {
    const [, host, owner, repoRaw, rest = ""] = url;
    const repo = repoRaw!.replace(/\.git$/, "");
    text = `${owner}/${repo}`;
    const parts = rest.split("/").filter(Boolean);
    if (host!.toLowerCase() === "github.com") {
      // github.com/o/r/tree/<ref>/a/b/<skill>: the last segment is the skill
      if ((parts[0] === "tree" || parts[0] === "blob") && parts.length >= 2) {
        ref = parts[1];
        const tail = parts.slice(2).filter((p) => p !== "SKILL.md");
        if (!name && tail.length) name = tail[tail.length - 1]!;
      }
    } else if (!name && parts[0]) {
      name = parts[0];
    }
  }
  const at = text.indexOf("@");
  if (at > 0) {
    ref = text.slice(at + 1) || undefined;
    text = text.slice(0, at);
  }
  if (!SOURCE_RE.test(text)) return null;
  if (ref !== undefined && !REF_RE.test(ref)) return null;
  if (name && !NAME_RE.test(name)) return null;
  const out: { source: string; name?: string; ref?: string } = { source: text };
  if (name) out.name = name;
  if (ref) out.ref = ref;
  return out;
}

/** Is this a name a skill directory can have (skills.sh and the runtimes want a simple slug)? */
export function validSkillName(name: string): boolean {
  return NAME_RE.test(name) && !name.startsWith(".");
}

/** A starting SKILL.md for the "write your own" form. */
export function skillTemplate(name: string): string {
  const title = name || "my-skill";
  return `---\nname: ${title}\ndescription: When to use this skill — one sentence the agent matches against.\n---\n\n# ${title}\n\nWhat to do, step by step. Keep it to what is not obvious.\n`;
}
