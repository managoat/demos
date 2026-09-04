/**
 * Who is in a machine, and how they got there.
 *
 *   GET    /api/paddock                    the caller's paddock: role, people, the link
 *   POST   /api/paddock                    owner: claim this account's machine as a paddock
 *   POST   /api/paddock/:id/members        owner: { email }
 *   DELETE /api/paddock/:id/members/:email owner, or yourself (leave)
 *   POST   /api/paddock/:id/invite         owner: mint (or re-mint) the join link
 *   DELETE /api/paddock/:id/invite         owner: close the link and evict every guest
 *   POST   /api/paddock/:id/presence       heartbeat; returns who is here
 *   GET    /api/paddock/:id/stream         the paddock's own live channel
 *
 * Everything that changes the *machine* — repositories, packages, the setup
 * script, secrets, MCP servers, skills, apply — stays out of this file and
 * out of the proxy, on owner-only routes. That separation is the permission
 * model: a guest can reach tabs and nothing else.
 */
import { actorLabel, authenticate, paddockAccess, requireOwner, type AppContext } from "./context";
import { randomToken } from "./crypto";
import type { Role } from "./db";
import { hub } from "./hub";
import { HttpError, isEmail, json, normalizeEmail, readJson, str } from "./http";

export interface PaddockDto {
  id: string;
  role: Role;
  ownerEmail: string;
  members: { email: string; addedAt: string }[];
  guests: { handle: string; seenAt: string }[];
  here: { label: string; role: string }[];
  /** The owner only: the join link, when one has been minted. */
  inviteUrl?: string | null;
}

function dto(ctx: AppContext, paddockId: string, role: Role): PaddockDto {
  const paddock = ctx.db.getPaddock(paddockId)!;
  const out: PaddockDto = {
    id: paddock.id,
    role,
    ownerEmail: paddock.owner_email,
    members: ctx.db.members(paddock.id).map((m) => ({ email: m.email, addedAt: m.added_at })),
    guests: ctx.db.guests(paddock.id).map((g) => ({ handle: g.handle, seenAt: g.seen_at })),
    here: hub.present(paddock.id),
  };
  // The link is a credential. Only the owner is ever shown it.
  if (role === "owner") {
    out.inviteUrl = paddock.invite_token ? `${ctx.config.publicUrl ?? ""}/#/join/${paddock.invite_token}` : null;
  }
  return out;
}

export async function show(ctx: AppContext, req: Request): Promise<Response> {
  const id = await authenticate(ctx, req);
  if (id.kind === "guest") return json({ data: dto(ctx, id.guest.paddock_id, "guest") });
  const own = ctx.db.paddockOf(id.user.email);
  if (own) return json({ data: dto(ctx, own.id, "owner") });
  const shared = ctx.db.sql
    .query("SELECT paddock_id FROM paddock_members WHERE email = $e ORDER BY added_at LIMIT 1")
    .get({ e: id.user.email }) as { paddock_id: string } | null;
  if (!shared) throw new HttpError(404, "no_paddock", "You have no machine here yet.");
  return json({ data: dto(ctx, shared.paddock_id, "member") });
}

/** Claim this account's machine. Idempotent: one paddock per owner. */
export async function claim(ctx: AppContext, req: Request): Promise<Response> {
  const id = await authenticate(ctx, req);
  if (id.kind !== "user") throw new HttpError(403, "guest", "A guest cannot own a machine.");
  const paddock = ctx.db.ensurePaddock(randomToken(9), id.user.email);
  return json({ data: dto(ctx, paddock.id, "owner") }, 201);
}

export async function addMember(ctx: AppContext, req: Request, paddockId: string): Promise<Response> {
  const id = await authenticate(ctx, req);
  const { paddock, role } = paddockAccess(ctx, id, paddockId);
  requireOwner(role);
  const email = normalizeEmail((await readJson(req)).email);
  if (!isEmail(email)) throw new HttpError(422, "bad_email", "That is not an email address.");
  if (email === paddock.owner_email) throw new HttpError(422, "already_owner", "That is you.");
  ctx.db.addMember(paddock.id, email, actorLabel(id));
  hub.publish(paddock.id, "people", { added: email });
  return json({ data: dto(ctx, paddock.id, role) });
}

export async function removeMember(ctx: AppContext, req: Request, paddockId: string, email: string): Promise<Response> {
  const id = await authenticate(ctx, req);
  const { paddock, role } = paddockAccess(ctx, id, paddockId);
  const target = normalizeEmail(decodeURIComponent(email));
  // The owner may remove anyone; anyone may remove themselves.
  const isSelf = id.kind === "user" && id.user.email === target;
  if (role !== "owner" && !isSelf) throw new HttpError(403, "owner_only", "Only the owner can remove someone else.");
  ctx.db.removeMember(paddock.id, target);
  hub.publish(paddock.id, "people", { removed: target });
  return json({ data: dto(ctx, paddock.id, role) });
}

/**
 * Mint the join link. Re-minting is the revocation story for anonymous
 * guests, so it has to actually evict them — a new token that left the old
 * sessions working would be a revoke button that does nothing.
 */
export async function mintInvite(ctx: AppContext, req: Request, paddockId: string): Promise<Response> {
  const id = await authenticate(ctx, req);
  const { paddock, role } = paddockAccess(ctx, id, paddockId);
  requireOwner(role);
  const evicted = ctx.db.revokeGuests(paddock.id);
  ctx.db.setInviteToken(paddock.id, randomToken(18));
  hub.publish(paddock.id, "people", { relinked: true, evicted });
  return json({ data: dto(ctx, paddock.id, role), evicted });
}

export async function closeInvite(ctx: AppContext, req: Request, paddockId: string): Promise<Response> {
  const id = await authenticate(ctx, req);
  const { paddock, role } = paddockAccess(ctx, id, paddockId);
  requireOwner(role);
  const evicted = ctx.db.revokeGuests(paddock.id);
  ctx.db.setInviteToken(paddock.id, null);
  hub.publish(paddock.id, "people", { closed: true, evicted });
  return json({ data: dto(ctx, paddock.id, role), evicted });
}

export async function presence(ctx: AppContext, req: Request, paddockId: string): Promise<Response> {
  const id = await authenticate(ctx, req);
  const { paddock, role } = paddockAccess(ctx, id, paddockId);
  const clientId = str((await readJson(req)).clientId, 100) || "anon";
  const here = hub.heartbeat(paddock.id, actorLabel(id), role, clientId);
  return json({ data: here });
}

/** The paddock's own event stream: presence, tabs, turns. Not the transcript. */
export async function stream(ctx: AppContext, req: Request, paddockId: string): Promise<Response> {
  const id = await authenticate(ctx, req);
  const { paddock } = paddockAccess(ctx, id, paddockId);
  const enc = new TextEncoder();
  let unsubscribe = () => {};

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(": connected\n\n"));
      unsubscribe = hub.subscribe(paddock.id, (e) => {
        try {
          controller.enqueue(enc.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
        } catch {
          /* the browser went away; cancel() cleans up */
        }
      });
    },
    cancel() {
      unsubscribe();
    },
  });
  req.signal.addEventListener("abort", () => unsubscribe());
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
