/** What every handler needs: the database, the cipher, the config, the per-project event bus, and who is asking. */
import type { Config } from "./config";
import type { Cipher } from "./crypto";
import { sha256 } from "./crypto";
import { Db, type ProjectRow, type Role, type UserRow } from "./db";
import { FountainClient } from "./fountain";
import { HttpError, SESSION_COOKIE, cookieValue } from "./http";

export interface AppContext {
  db: Db;
  cipher: Cipher;
  config: Config;
  events: ProjectEvents;
}

/**
 * Changes to a project's own records (items, members, settings) are pushed
 * to every open stream of that project as `event: workbench`, so a member's
 * edit shows up on the owner's screen without a reload.
 */
export class ProjectEvents {
  private subs = new Map<string, Set<(data: unknown) => void>>();

  subscribe(projectId: string, fn: (data: unknown) => void): () => void {
    let set = this.subs.get(projectId);
    if (!set) {
      set = new Set();
      this.subs.set(projectId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.subs.delete(projectId);
    };
  }

  emit(projectId: string, data: unknown): void {
    this.subs.get(projectId)?.forEach((fn) => {
      try {
        fn(data);
      } catch {
        // a dead stream is dropped by its own cancel
      }
    });
  }
}

/** The signed-in user, from the session cookie. 401 otherwise. */
export async function authenticate(ctx: AppContext, req: Request): Promise<UserRow> {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) throw new HttpError(401, "unauthenticated", "Sign in first.");
  const user = ctx.db.sessionUser(await sha256(token));
  if (!user) throw new HttpError(401, "unauthenticated", "That session has ended. Sign in again.");
  return user;
}

/** The project and the caller's role in it. 404 for a project the caller is not part of — its existence is not theirs to learn. */
export function projectAccess(ctx: AppContext, user: UserRow, projectId: string): { project: ProjectRow; role: Role } {
  const role = ctx.db.roleIn(projectId, user.email);
  const project = role ? ctx.db.getProject(projectId) : null;
  if (!role || !project) throw new HttpError(404, "not_found", "No such project.");
  return { project, role };
}

export function requireOwner(role: Role): void {
  if (role !== "owner") throw new HttpError(403, "owner_only", "Only the project's owner can do that.");
}

/** A Fountain client on the project owner's key — what every conversation in the project runs on. */
export async function ownerClient(ctx: AppContext, project: ProjectRow): Promise<FountainClient> {
  const owner = ctx.db.getUser(project.owner_email);
  if (!owner) throw new HttpError(409, "owner_gone", "The project's owner no longer has an account here.");
  return new FountainClient(ctx.config.fountainUrl, await ctx.cipher.decrypt(owner.key_enc));
}

/** A client on the caller's own key. */
export async function userClient(ctx: AppContext, user: UserRow): Promise<FountainClient> {
  return new FountainClient(ctx.config.fountainUrl, await ctx.cipher.decrypt(user.key_enc));
}
