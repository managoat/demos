/**
 * Who is calling from inside a sandbox.
 *
 * A teammate in a sandbox already holds a Fountain key (`$FOUNTAIN_TOKEN`,
 * minted per conversation, `sprite` scope) and the id of the conversation it
 * is running (`$FOUNTAIN_CONVERSATION_ID`). Two things on this server accept
 * that pair instead of a session cookie — the MCP endpoint (`server/mcp.ts`)
 * and the snapshot route (`server/snapshots.ts`) — and they must agree on
 * what it proves, so the rule lives here once:
 *
 *   - **The bearer token says who is asking.** The workbench asks Fountain
 *     `GET /api/auth/me` and takes the email, which is exactly what sign-in
 *     does — a Fountain key is already how a person proves who they are
 *     here. A key whose email has never signed in is refused: the workbench
 *     does not learn about people from a header. The verdict is cached
 *     briefly, under a hash of the key, so a revoke still bites.
 *
 *   - **`X-Fountain-Conversation-Id` pins the caller to one project.** With
 *     it, the workbench reads that conversation on the caller's own key and
 *     takes the project and item out of its `channel_id`, so a sandbox
 *     reaches only the work it is on. A conversation Fountain will not show
 *     that key is not one this caller is in.
 *
 * Nothing here forwards to Fountain beyond those two identity reads;
 * `server/proxy.ts` remains the only boundary a member's conversations cross.
 */
import { parseChannel } from "../shared/channel";
import { projectAccess, type AppContext } from "./context";
import { sha256 } from "./crypto";
import type { ProjectRow, Role, UserRow } from "./db";
import { FountainClient, FountainHttpError, type ConversationSummary } from "./fountain";
import { HttpError } from "./http";

export const CONVERSATION_HEADER = "x-fountain-conversation-id";

/** How long a key's verdict from Fountain is reused. Short: a revoked key must stop working. */
const KEY_CACHE_TTL_MS = 60 * 1000;

/** sha256(key) → the email Fountain said it belongs to, and when it said so. */
const verified = new Map<string, { email: string; at: number }>();

/** For tests: forget every verified key. */
export function resetKeyCache(): void {
  verified.clear();
}

/** The project, item and agent of the conversation the caller named. */
export interface Pinned {
  project: ProjectRow;
  role: Role;
  itemId: string;
  agentId: string | null;
  /** The conversation itself, as Fountain showed it to the caller's key — its sandbox id is what names the computer. */
  conversation: ConversationSummary;
}

export interface Caller {
  user: UserRow;
  pinned: Pinned | null;
}

export async function authenticate(ctx: AppContext, req: Request): Promise<Caller> {
  const header = req.headers.get("authorization") ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!key) {
    throw new HttpError(401, "unauthenticated", "Send a Fountain API key as `Authorization: Bearer …`; inside a sandbox that is $FOUNTAIN_TOKEN.");
  }
  const email = await whose(ctx, key);
  const user = ctx.db.getUser(email);
  if (!user) throw new HttpError(401, "unknown_user", `${email} has never signed in to the workbench, so there is nothing here to reach. Sign in once first.`);
  return { user, pinned: await pin(ctx, user, key, req) };
}

/** The pin, for a route that makes no sense without one. */
export function requirePinned(caller: Caller): Pinned {
  if (!caller.pinned) {
    throw new HttpError(422, "conversation_required", `Send the conversation this comes from as \`X-Fountain-Conversation-Id\`; inside a sandbox that is $FOUNTAIN_CONVERSATION_ID.`);
  }
  return caller.pinned;
}

/** The email Fountain says a key belongs to. */
async function whose(ctx: AppContext, key: string): Promise<string> {
  const hash = await sha256(key);
  const hit = verified.get(hash);
  if (hit && Date.now() - hit.at < KEY_CACHE_TTL_MS) return hit.email;

  let who: { email: string };
  try {
    who = await new FountainClient(ctx.config.fountainUrl, key).me();
  } catch (err) {
    if (err instanceof FountainHttpError && (err.status === 401 || err.status === 403)) throw new HttpError(401, "bad_key", "Fountain rejected that key.");
    throw new HttpError(502, "fountain_unreachable", `Could not reach ${ctx.config.fountainUrl} to verify the key.`);
  }
  const email = who.email.trim().toLowerCase();
  if (!email) throw new HttpError(502, "no_email", "Fountain did not say who the key belongs to.");
  verified.set(hash, { email, at: Date.now() });
  return email;
}

/**
 * The project a caller is confined to, from the conversation it named. Read
 * on the caller's own key — a conversation Fountain will not show that key
 * is not one this caller is in.
 */
async function pin(ctx: AppContext, user: UserRow, key: string, req: Request): Promise<Pinned | null> {
  const id = req.headers.get(CONVERSATION_HEADER)?.trim();
  if (!id) return null;
  const conv = await new FountainClient(ctx.config.fountainUrl, key).conversation(id);
  if (!conv) throw new HttpError(404, "no_conversation", `Fountain has no conversation ${id} for this key.`);
  const ref = parseChannel(conv.channel_id);
  if (!ref) {
    throw new HttpError(404, "not_a_workbench_conversation", "That conversation is not on a workbench work item, so there is no project to be in. Drop the header to reach your projects by name.");
  }
  const { project, role } = projectAccess(ctx, user, ref.projectId);
  return { project, role, itemId: ref.itemId, agentId: conv.agent_id ?? null, conversation: conv };
}
