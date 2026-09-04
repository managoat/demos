/**
 * Who is in a *tab*, and how they got there.
 *
 *   GET    /api/paddock                      the caller's paddock and role
 *   POST   /api/paddock                      owner: claim this account's machine
 *   GET    /api/paddock/:id/tabs/:c/people    who is in one tab
 *   POST   /api/paddock/:id/tabs/:c/members   owner: { email }
 *   DELETE /api/paddock/:id/tabs/:c/members/:email  owner, or yourself (leave)
 *   POST   /api/paddock/:id/tabs/:c/invite    owner: mint the link for this tab
 *   DELETE /api/paddock/:id/tabs/:c/invite    owner: close it, evicting its guests
 *   POST   /api/paddock/:id/presence          heartbeat
 *   GET    /api/paddock/:id/stream            presence, tabs, turns
 *
 * The unit is the tab, not the machine. Somebody invited to Terminal 2 gets
 * Terminal 2: they do not see the other terminals, they cannot open one, and
 * the link that let them in dies with that tab. The original brief asked for
 * "people invited to a thread" and this is that.
 *
 * Everything that changes the *machine* — repositories, packages, secrets,
 * MCP servers, skills, apply, rebuild — stays out of this file entirely. That
 * separation is the permission model.
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
  /** Null for the owner: every tab is theirs. Otherwise the tabs they may reach. */
  tabs: string[] | null;
  here: { label: string; role: string }[];
}

/** Who is in one tab, and — for the owner — how to let somebody else in. */
export interface TabPeopleDto {
  conversationId: string;
  members: { email: string; addedAt: string }[];
  guests: { handle: string; seenAt: string }[];
  /** The owner only: a link is a credential. */
  inviteUrl?: string | null;
}

function paddockDto(ctx: AppContext, paddockId: string, role: Role, tabs: string[] | null): PaddockDto {
  const paddock = ctx.db.getPaddock(paddockId)!;
  return { id: paddock.id, role, ownerEmail: paddock.owner_email, tabs, here: hub.present(paddock.id) };
}

function tabDto(ctx: AppContext, paddockId: string, conversationId: string, role: Role): TabPeopleDto {
  const out: TabPeopleDto = {
    conversationId,
    members: ctx.db.members(paddockId, conversationId).map((m) => ({ email: m.email, addedAt: m.added_at })),
    guests: ctx.db.guests(paddockId, conversationId).map((g) => ({ handle: g.handle, seenAt: g.seen_at })),
  };
  if (role === "owner") {
    const invite = ctx.db.inviteFor(paddockId, conversationId);
    out.inviteUrl = invite ? `${ctx.config.publicUrl ?? ""}/#/join/${invite.token}` : null;
  }
  return out;
}

export async function show(ctx: AppContext, req: Request): Promise<Response> {
  const id = await authenticate(ctx, req);
  if (id.kind === "guest") {
    return json({ data: paddockDto(ctx, id.guest.paddock_id, "guest", [id.guest.conversation_id]) });
  }
  const own = ctx.db.paddockOf(id.user.email);
  if (own) return json({ data: paddockDto(ctx, own.id, "owner", null) });
  const shared = ctx.db.sql
    .query("SELECT paddock_id FROM paddock_members WHERE email = $e ORDER BY added_at LIMIT 1")
    .get({ e: id.user.email }) as { paddock_id: string } | null;
  if (!shared) throw new HttpError(404, "no_paddock", "You have no machine here yet.");
  return json({ data: paddockDto(ctx, shared.paddock_id, "member", ctx.db.memberTabs(shared.paddock_id, id.user.email)) });
}

/** One named paddock, for somebody who can reach more than one. */
export async function showOne(ctx: AppContext, req: Request, paddockId: string): Promise<Response> {
  const id = await authenticate(ctx, req);
  const access = paddockAccess(ctx, id, paddockId);
  return json({ data: paddockDto(ctx, access.paddock.id, access.role, access.tabs) });
}

/** Claim this account's machine. Idempotent: one paddock per owner. */
export async function claim(ctx: AppContext, req: Request): Promise<Response> {
  const id = await authenticate(ctx, req);
  if (id.kind !== "user") throw new HttpError(403, "guest", "A guest cannot own a machine.");
  const paddock = ctx.db.ensurePaddock(randomToken(9), id.user.email);
  return json({ data: paddockDto(ctx, paddock.id, "owner", null) }, 201);
}

/**
 * The caller may only ask about a tab they can reach. Without this an invited
 * guest could enumerate who is in every other terminal on the machine.
 */
function reachable(access: { tabs: string[] | null }, conversationId: string): boolean {
  return access.tabs === null || access.tabs.includes(conversationId);
}

export async function tabPeople(ctx: AppContext, req: Request, paddockId: string, conversationId: string): Promise<Response> {
  const id = await authenticate(ctx, req);
  const access = paddockAccess(ctx, id, paddockId);
  if (!reachable(access, conversationId)) throw new HttpError(404, "not_found", "No such tab.");
  return json({ data: tabDto(ctx, access.paddock.id, conversationId, access.role) });
}

export async function addMember(ctx: AppContext, req: Request, paddockId: string, conversationId: string): Promise<Response> {
  const id = await authenticate(ctx, req);
  const access = paddockAccess(ctx, id, paddockId);
  requireOwner(access.role);
  const email = normalizeEmail((await readJson(req)).email);
  if (!isEmail(email)) throw new HttpError(422, "bad_email", "That is not an email address.");
  if (email === access.paddock.owner_email) throw new HttpError(422, "already_owner", "That is you.");
  ctx.db.addMember(access.paddock.id, conversationId, email, actorLabel(id));
  hub.publish(access.paddock.id, "people", { tab: conversationId, added: email });
  return json({ data: tabDto(ctx, access.paddock.id, conversationId, access.role) });
}

export async function removeMember(ctx: AppContext, req: Request, paddockId: string, conversationId: string, email: string): Promise<Response> {
  const id = await authenticate(ctx, req);
  const access = paddockAccess(ctx, id, paddockId);
  const target = normalizeEmail(decodeURIComponent(email));
  const isSelf = id.kind === "user" && id.user.email === target;
  if (access.role !== "owner" && !isSelf) throw new HttpError(403, "owner_only", "Only the owner can remove someone else.");
  if (!reachable(access, conversationId)) throw new HttpError(404, "not_found", "No such tab.");
  ctx.db.removeMember(access.paddock.id, conversationId, target);
  hub.publish(access.paddock.id, "people", { tab: conversationId, removed: target });
  return json({ data: tabDto(ctx, access.paddock.id, conversationId, access.role) });
}

/**
 * Mint this tab's link. Minting again replaces it, and replacing it evicts the
 * guests who came in on the old one — that is the whole revocation story, so
 * it has to actually happen rather than just issue a new string.
 */
export async function mintInvite(ctx: AppContext, req: Request, paddockId: string, conversationId: string): Promise<Response> {
  const id = await authenticate(ctx, req);
  const access = paddockAccess(ctx, id, paddockId);
  requireOwner(access.role);
  const evicted = ctx.db.revokeGuests(access.paddock.id, conversationId);
  ctx.db.setInvite(access.paddock.id, conversationId, randomToken(18));
  hub.publish(access.paddock.id, "people", { tab: conversationId, relinked: true, evicted });
  return json({ data: tabDto(ctx, access.paddock.id, conversationId, access.role), evicted });
}

export async function closeInvite(ctx: AppContext, req: Request, paddockId: string, conversationId: string): Promise<Response> {
  const id = await authenticate(ctx, req);
  const access = paddockAccess(ctx, id, paddockId);
  requireOwner(access.role);
  const evicted = ctx.db.revokeGuests(access.paddock.id, conversationId);
  ctx.db.clearInvite(access.paddock.id, conversationId);
  hub.publish(access.paddock.id, "people", { tab: conversationId, closed: true, evicted });
  return json({ data: tabDto(ctx, access.paddock.id, conversationId, access.role), evicted });
}

export async function presence(ctx: AppContext, req: Request, paddockId: string): Promise<Response> {
  const id = await authenticate(ctx, req);
  const access = paddockAccess(ctx, id, paddockId);
  const clientId = str((await readJson(req)).clientId, 100) || "anon";
  const here = hub.heartbeat(access.paddock.id, actorLabel(id), access.role, clientId);
  return json({ data: here });
}

/** The paddock's own event stream: presence, tabs, turns. Not the transcript. */
export async function stream(ctx: AppContext, req: Request, paddockId: string): Promise<Response> {
  const id = await authenticate(ctx, req);
  const access = paddockAccess(ctx, id, paddockId);
  const enc = new TextEncoder();
  let unsubscribe = () => {};

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(": connected\n\n"));
      unsubscribe = hub.subscribe(access.paddock.id, (e) => {
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
