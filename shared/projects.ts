/**
 * Projects: a repository a chat's computer starts with a checkout of. A
 * project is the host's — it is an Environment on their Fountain, made by
 * server/projects.ts, holding the clone, the setup, the GitHub token as a
 * write-only secret, and the hook that reports changes (server/sandbox.ts).
 * The people in a project are in every chat started in it, and every such
 * chat runs on the project owner's key: they pay, as a host does.
 *
 * This file is the wire shape and the rules both sides check before the
 * server is asked: what a repository URL is, and where it is checked out.
 */

export interface ProjectDto {
  id: string;
  name: string;
  ownerEmail: string;
  role: "owner" | "member";
  members: { email: string; addedAt: string }[];
  repoUrl: string;
  /** The branch chats start from and diff against: "main". */
  base: string;
  /** True when a token was given, so a private repository clones and `gh` can open a pull request. */
  hasToken: boolean;
  createdAt: string;
}

export interface RepoRef {
  /** The https clone URL, no `.git`, no trailing slash. */
  url: string;
  host: string;
  owner: string;
  name: string;
}

/** Where a project's repository is checked out in the computer. */
export const WORK_DIR = "/home/sprite/work";

/**
 * A repository URL as people paste them — `https://github.com/o/r`,
 * `github.com/o/r.git`, `git@github.com:o/r.git` — as an https clone URL,
 * or null. Anything but https is refused later: the clone Fountain runs is
 * https with a token.
 */
export function parseRepoUrl(input: string): RepoRef | null {
  let s = input.trim();
  if (!s) return null;
  const ssh = /^git@([^:/\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(s);
  if (ssh) return ref(ssh[1]!, ssh[2]!, ssh[3]!);
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0]!;
  const name = parts[1]!.replace(/\.git$/, "");
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name) || name === "." || name === "..") return null;
  return ref(u.hostname.toLowerCase(), owner, name);
}

function ref(host: string, owner: string, name: string): RepoRef {
  return { url: `https://${host}/${owner}/${name}`, host, owner, name };
}

/** `/home/sprite/work/<repo>`. */
export function mountPathFor(repo: RepoRef): string {
  return `${WORK_DIR}/${repo.name}`;
}

/** A branch name git would accept, trimmed; "main" when blank. */
export function baseBranch(input: unknown): string | null {
  const s = typeof input === "string" ? input.trim() : "";
  if (!s) return "main";
  if (s.length > 200 || /[\s~^:?*[\\]|\.\.|^\/|\/$|\.lock$|^-|@\{/.test(s)) return null;
  return s;
}

/** The name a project shows: what was given, or the repository's. */
export function projectName(given: unknown, repo: RepoRef): string {
  const s = typeof given === "string" ? given.trim().slice(0, 80) : "";
  return s || repo.name;
}
