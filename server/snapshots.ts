/**
 * What is on a work item's computer: the git state of its checkouts, posted
 * from inside the sandbox by a hook.
 *
 * Fountain reads a sandbox's disk over the API — `GET /api/sandboxes/:id/{files,file,diff}`
 * (ADR 0039), which the project proxy forwards — and that is where the diff
 * itself comes from: redacted of the sandbox's secrets by Fountain, paged on
 * demand, and with the whole file beside a hunk when review needs it. What
 * those three reads cannot say is which branch the checkout is on, how far
 * ahead of its upstream, which files are untracked (`git diff` never shows
 * one), and *when* something changed — a parked machine is not woken to be
 * read, and nothing announces a write. So a hook inside the sandbox posts
 * exactly that: branch, head, upstream, ahead/behind and porcelain status, on
 * Claude Code's `Stop` and `PostToolUse` and on git's `post-commit`, and the
 * server tells the project. No diff bytes travel this way, on purpose: a hook
 * posting a raw diff would carry a secret an agent pasted into a file, and
 * Fountain's read would not.
 *
 * The hook is a child of the agent's process, so it inherits the
 * per-conversation identity Fountain gives that process — `$FOUNTAIN_TOKEN`
 * and `$FOUNTAIN_CONVERSATION_ID` — and authenticates exactly as `/mcp` does
 * (`server/callers.ts`). Nothing new is issued. The installer is served by
 * this server (`server/hook.ts`).
 *
 * The record is the *computer's*, not the conversation's: on a shared
 * computer (ADR 0023) several conversations edit one disk, so the latest per
 * (item, computer, repo) is what is kept, attributed to whichever conversation
 * posted it. Members read it under the item; a `workbench` event on the
 * project's stream says one landed, and the browser pulls the diff.
 *
 *   POST /api/snapshots                              from the sandbox; bearer + conversation header
 *   GET  /api/projects/:id/items/:item/snapshots     the latest per computer and repo, members
 */
import { computerKey } from "../shared/computers";
import { authenticate as sandboxCaller, requirePinned } from "./callers";
import { authenticate, projectAccess, type AppContext } from "./context";
import { now, type SnapshotRow } from "./db";
import { HttpError, json, readJson, str } from "./http";

const STATUS_MAX = 64 * 1024;
const META_MAX = 8 * 1024;

export const SOURCES = ["stop", "post-tool", "post-commit", "manual"] as const;
export type Source = (typeof SOURCES)[number];

export interface SnapshotDto {
  itemId: string;
  /** The computer's key (shared/computers.ts): its sandbox id, or `conv:<id>`. */
  computer: string;
  /** The checkout's path in the sandbox — what to hand `GET /api/sandboxes/:id/diff?path=`. */
  repo: string;
  conversationId: string;
  agentId: string | null;
  source: Source;
  branch: string;
  head: string;
  upstream: string;
  ahead: number;
  behind: number;
  /** `git status --porcelain=v2 --branch --untracked-files=all`. */
  status: string;
  /** Whatever the hook chose to say about itself, as it said it. */
  meta: unknown;
  takenAt: string;
}

export function dto(r: SnapshotRow): SnapshotDto {
  let meta: unknown = null;
  if (r.meta) {
    try {
      meta = JSON.parse(r.meta);
    } catch {
      meta = r.meta;
    }
  }
  return {
    itemId: r.item_id,
    computer: r.computer,
    repo: r.repo,
    conversationId: r.conversation_id,
    agentId: r.agent_id,
    source: (SOURCES as readonly string[]).includes(r.source) ? (r.source as Source) : "manual",
    branch: r.branch,
    head: r.head,
    upstream: r.upstream,
    ahead: r.ahead,
    behind: r.behind,
    status: r.status,
    meta,
    takenAt: r.taken_at,
  };
}

function count(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function metaOf(v: unknown): string {
  if (v === undefined || v === null) return "";
  const text = JSON.stringify(v);
  return text.length > META_MAX ? JSON.stringify({ truncated: true, head: text.slice(0, META_MAX) }) : text;
}

export async function record(ctx: AppContext, req: Request): Promise<Response> {
  const pinned = requirePinned(await sandboxCaller(ctx, req));
  // The channel names an item; the item may since have been deleted, and a
  // snapshot of work nobody is tracking has nowhere to go.
  const item = ctx.db.getItem(pinned.itemId);
  if (!item || item.project_id !== pinned.project.id) throw new HttpError(404, "not_found", "The work item this conversation was on is gone.");

  const body = await readJson(req);
  const repo = str(body.repo, 500).trim();
  if (!repo.startsWith("/")) throw new HttpError(422, "repo_required", "Say which checkout this is: `repo`, its absolute path in the sandbox.");
  const source: Source = (SOURCES as readonly string[]).includes(body.source as string) ? (body.source as Source) : "manual";

  const row: SnapshotRow = {
    item_id: item.id,
    computer: computerKey(pinned.conversation),
    repo,
    conversation_id: pinned.conversation.id,
    agent_id: pinned.agentId,
    source,
    branch: str(body.branch, 300),
    head: str(body.head, 64),
    upstream: str(body.upstream, 300),
    ahead: count(body.ahead),
    behind: count(body.behind),
    status: str(body.status, STATUS_MAX),
    meta: metaOf(body.meta),
    taken_at: now(),
  };
  ctx.db.upsertSnapshot(row);
  ctx.events.emit(pinned.project.id, { kind: "snapshot", itemId: row.item_id, computer: row.computer, repo: row.repo, source });
  return json({ data: { itemId: row.item_id, computer: row.computer, repo: row.repo, source, takenAt: row.taken_at } }, 201);
}

export async function list(ctx: AppContext, req: Request, projectId: string, itemId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  projectAccess(ctx, user, projectId);
  const item = ctx.db.getItem(itemId);
  if (!item || item.project_id !== projectId) throw new HttpError(404, "not_found", "No such work item.");
  return json({ data: ctx.db.snapshots(itemId).map(dto) });
}
