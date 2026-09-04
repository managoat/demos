/**
 * Names, and the fact that a name here is load-bearing in four places at once.
 *
 * A thread's slug is its branch's tail, the tail of its `channel_id`, the last
 * segment of its URL, and the thing a person reads in the sidebar. One
 * function makes it so the four cannot drift, and `parseChannel` is the
 * inverse — the server derives a thread's identity from Fountain's own record
 * rather than trusting a row in this database to still be right.
 */

/** Every conversation drydock owns starts with this. */
export const CHANNEL_PREFIX = "drydock";

/** Where a project's repository is cloned. Fountain's own convention. */
export const WORKSPACE_ROOT = "/workspace";

/** A machine with no repository. The agent's cwd on claude and codex. */
export const HOME = "/home/sprite";

/** Drydock's corner of the machine — the receipt, and nothing a person edits. */
export const STATE_DIR = "/home/sprite/.drydock";

/**
 * A slug fit for a directory, a git branch and a URL at the same time.
 *
 * Git refuses a fair amount that a directory would take (`..`, a trailing
 * `.lock`, a leading dot), so the strictest of the four rules wins for all of
 * them rather than each place having its own idea of what is legal.
 */
export function slugify(input: string, fallback = "thread"): string {
  const base = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");
  return base || fallback;
}

/**
 * `drydock:<project>:<thread>@r<rev>` — a thread's conversation.
 *
 * The revision is the project's settings revision at the moment the thread
 * opened. Fountain injects secrets, MCP servers and skills when a session
 * starts, so a thread that opened before a change is genuinely running older
 * settings; carrying the number in an id it already has means nothing is
 * stored to work that out and nothing can get it wrong. Paddock's trick,
 * unchanged — it is the one piece of that app that transfers whole, because
 * the fact underneath it is Fountain's rather than paddock's.
 */
export function threadChannel(projectId: string, slug: string, rev: number): string {
  return `${CHANNEL_PREFIX}:${projectId}:${slug}@r${rev}`;
}

export interface ParsedChannel {
  projectId: string;
  slug: string;
  rev: number;
}

/** The inverse. Null for anything that is not one of ours. */
export function parseChannel(channelId: string | null | undefined): ParsedChannel | null {
  if (!channelId) return null;
  const m = /^drydock:([^:@]+):([^:@]+)@r(\d+)$/.exec(channelId);
  if (!m) return null;
  return { projectId: m[1]!, slug: m[2]!, rev: Number(m[3]) };
}

/** Is this conversation part of the given project, whatever revision it opened at? */
export function isProjectChannel(channelId: string | null | undefined, projectId: string): boolean {
  return parseChannel(channelId)?.projectId === projectId;
}

/**
 * A thread's branch.
 *
 * Namespaced under the person who asked for it, the way somebody would name a
 * branch they intend to push: `jhgaylor/kyoto`. The login comes from GitHub,
 * so it is the same name that will appear on the pull request.
 */
export function branchFor(login: string, slug: string): string {
  return `${slugify(login, "sy")}/${slug}`;
}

/** `/workspace/<name>` for `owner/name` — where the clone lands, and the thread's cwd. */
export function mountPathFor(repoFullName: string): string {
  const name = repoFullName.split("/").pop() ?? repoFullName;
  return `${WORKSPACE_ROOT}/${name}`;
}

/** The name Fountain's records carry, so a person reading them upstream knows whose they are. */
export function fountainName(kind: "agent" | "env" | "vault", projectName: string, projectId: string): string {
  return `drydock-${kind}-${slugify(projectName, "project")}-${projectId.slice(0, 8)}`;
}
