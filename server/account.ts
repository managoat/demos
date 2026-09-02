/** Account setup, the reusable workspace roster, and in-app notifications. */
import type { UserRow } from "./db";
import { authenticate, type AppContext } from "./context";
import { FountainClient, FountainHttpError } from "./fountain";
import { HttpError, isEmail, json, normalizeEmail, readJson, str } from "./http";

export function meDto(ctx: AppContext, user: UserRow) {
  return {
    email: user.email,
    fountainUrl: ctx.config.fountainUrl,
    onboardingComplete: user.onboarding_complete === 1,
    inferenceToken: { connected: !!user.key_enc, updatedAt: user.key_updated_at },
  };
}

export async function updateToken(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const body = await readJson(req);
  const apiKey = str(body.apiKey, 2000).trim();
  if (!apiKey) throw new HttpError(400, "missing_key", "An inference token is required.");
  let who: { id: string; email: string };
  try {
    who = await new FountainClient(ctx.config.fountainUrl, apiKey).me();
  } catch (err) {
    if (err instanceof FountainHttpError && (err.status === 401 || err.status === 403)) throw new HttpError(401, "bad_key", "Fountain rejected that token.");
    throw new HttpError(502, "fountain_unreachable", `Could not reach ${ctx.config.fountainUrl} to verify the token.`);
  }
  if (who.email.trim().toLowerCase() !== user.email) throw new HttpError(403, "token_owner_mismatch", "That token belongs to a different Fountain account.");
  const updated = ctx.db.updateUserKey(user.email, who.id ?? null, await ctx.cipher.encrypt(apiKey));
  return json({ data: meDto(ctx, updated) });
}

export async function completeOnboarding(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  // A token is always collected at sign-in and can be replaced above. GitHub
  // is optional only when this installation has not configured its App.
  if (!user.key_enc) throw new HttpError(409, "token_required", "Add an inference token first.");
  if (ctx.config.githubApp && !ctx.db.githubAccount(user.email)) throw new HttpError(409, "github_required", "Connect the GitHub App first.");
  return json({ data: meDto(ctx, ctx.db.completeOnboarding(user.email)) });
}

export async function workspace(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  return json({ data: ctx.db.workspaceMembers(user.email).map((m) => ({ email: m.email, addedAt: m.added_at })) });
}

export async function addWorkspaceMember(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const body = await readJson(req);
  const email = normalizeEmail(body.email);
  if (!isEmail(email)) throw new HttpError(422, "bad_email", "That is not an email address.");
  if (email === user.email) throw new HttpError(422, "is_owner", "You are already in your workspace.");
  ctx.db.addWorkspaceMember(user.email, email);
  return workspace(ctx, req);
}

export async function removeWorkspaceMember(ctx: AppContext, req: Request, rawEmail: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  ctx.db.removeWorkspaceMember(user.email, normalizeEmail(decodeURIComponent(rawEmail)));
  return json({ ok: true });
}

export async function notifications(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const data = ctx.db.notificationsFor(user.email).flatMap((n) => {
    const chat = ctx.db.getChat(n.chat_id);
    if (!chat) return [];
    return [{ id: n.id, chatId: n.chat_id, chatTitle: chat.title || "New chat", actorEmail: n.actor_email, kind: n.kind, createdAt: n.created_at, readAt: n.read_at }];
  });
  return json({ data });
}

export async function readNotification(ctx: AppContext, req: Request, id: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  if (!ctx.db.readNotification(id, user.email)) throw new HttpError(404, "not_found", "No such notification.");
  return json({ ok: true });
}

/** Workspace teammates named by `@email` or an unambiguous `@handle`. */
export function mentionedWorkspaceMembers(ctx: AppContext, ownerEmail: string, prompt: string): string[] {
  const lower = prompt.toLowerCase();
  const members = ctx.db.workspaceMembers(ownerEmail).map((m) => m.email);
  const handles = new Map<string, string[]>();
  for (const email of members) {
    const handle = email.split("@")[0]!;
    handles.set(handle, [...(handles.get(handle) ?? []), email]);
  }
  return members.filter((email) => {
    if (lower.includes(`@${email}`)) return true;
    const handle = email.split("@")[0]!;
    if (handles.get(handle)?.length !== 1) return false;
    return new RegExp(`(^|\\s)@${escapeRegExp(handle)}(?=\\s|[.,!?;:]|$)`, "i").test(prompt);
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
