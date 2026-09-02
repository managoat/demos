/**
 * GitHub-shaped helpers: what counts as a repo, and how a citation becomes a
 * deep link. Pure string work, no network — the agent's clone is the only
 * thing that ever talks to GitHub.
 */

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const NAME = /^[A-Za-z0-9._-]+$/;

/**
 * `owner/name`, `github.com/owner/name`, or a full GitHub URL (with or
 * without .git / a trailing path) → canonical `owner/name`. Null when it is
 * not recognisably a GitHub repo.
 */
export function parseRepoInput(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  if (/^github\.com\//i.test(s)) s = s.slice("github.com/".length);
  else if (s.includes(".com/") || s.includes("://")) return null; // some other host
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  let name = parts[1]!;
  name = name.replace(/\.git$/i, "");
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return null;
  return `${owner}/${name}`;
}

/**
 * The GitHub blob URL a citation points at. Path and branch segments are
 * URL-encoded (branches may contain slashes); the line fragment degrades:
 * start+end → a range, start only → one line, neither → the file.
 */
export function blobUrl(repo: string, branch: string, path: string, start?: number, end?: number): string {
  const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  let url = `https://github.com/${repo}/blob/${enc(branch)}/${enc(path.replace(/^\/+/, ""))}`;
  if (typeof start === "number" && start > 0) {
    url += `#L${start}`;
    if (typeof end === "number" && end > start) url += `-L${end}`;
  }
  return url;
}

export type ProseSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string };

// A path mention: at least one slash, a file-ish last segment, optional
// :line or :line-line. The leading boundary (no word char, slash, @ or dot)
// keeps us from starting mid-URL or mid-hostname.
const MENTION = /(?<![\w/@.])((?:[\w.-]+\/)+[\w.-]*\w)(?::(\d+)(?:[-–](\d+))?)?/g;

/**
 * Split prose into text and repo-relative `path` / `path:line` mentions,
 * linked into the repo on GitHub. Only paths the repo plausibly contains are
 * linked: they must exist in `knownPaths` (the repo-map's components and
 * entry points) or carry a line number / file extension — bare `either/or`
 * prose stays prose.
 */
export function splitPathMentions(text: string, repo: string, branch: string, knownPaths: string[] = []): ProseSegment[] {
  const known = new Set(knownPaths.map((p) => p.replace(/^\/+|\/+$/g, "")));
  const out: ProseSegment[] = [];
  let cursor = 0;
  for (const m of text.matchAll(MENTION)) {
    const whole = m[0]!;
    const path = m[1]!;
    const startS = m[2];
    const endS = m[3];
    const clean = path.replace(/^\/+/, "");
    const hasLine = startS !== undefined;
    const hasExt = /\.\w{1,10}$/.test(clean);
    const isKnown = known.has(clean) || [...known].some((k) => clean.startsWith(k + "/"));
    if (!hasLine && !hasExt && !isKnown) continue;
    if (m.index > cursor) out.push({ kind: "text", text: text.slice(cursor, m.index) });
    const start = startS ? Number(startS) : undefined;
    const end = endS ? Number(endS) : undefined;
    out.push({ kind: "link", text: whole, href: blobUrl(repo, branch, clean, start, end) });
    cursor = m.index + whole.length;
  }
  if (cursor < text.length) out.push({ kind: "text", text: text.slice(cursor) });
  return out;
}
