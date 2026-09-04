/**
 * More than one computer.
 *
 *   POST   /api/paddocks       another machine for the caller
 *   PATCH  /api/paddock/:id    owner: rename it
 *   DELETE /api/paddock/:id    owner: retire it and forget the row
 *
 * The interesting thing about adding a computer is how little it does. A
 * paddock is a row and nothing else — no agent, no environment, no vault, no
 * sandbox — because everything on Fountain is made by the browser the first
 * time somebody actually opens the machine (`lib/identity.ts`), exactly as the
 * first computer always was. So this route spends nothing, and a person who
 * makes one and never visits it is charged for nothing.
 *
 * What the row *does* carry is an identity for the tabs on it: the id goes
 * into every `channel_id` (`tabs.channelFor`), which is how the server tells
 * one of your machines from another without storing a mapping that could
 * drift. See `shared/tabs.ts`.
 *
 * Deleting is the same operation as **Start over** followed by forgetting the
 * row, and it reuses `lifecycle.retire` rather than repeating it — one
 * sequence for taking a machine apart, however it was asked for.
 */
import { authenticate, paddockAccess, requireClaimed, requireOwner, type AppContext } from "./context";
import { randomToken } from "./crypto";
import type { PaddockRow } from "./db";
import { hub } from "./hub";
import { HttpError, json, readJson, str } from "./http";
import { retire } from "./lifecycle";

/**
 * How many machines one account may hold at once.
 *
 * Not a licensing decision — a stop on a loop. Every computer that gets opened
 * is a real sandbox on the owner's key and the owner's bill, and a browser
 * that got stuck asking for another would otherwise keep being given one. Ten
 * is far past what anybody has wanted and near enough to notice a runaway.
 */
export const MAX_COMPUTERS = 10;

/** The longest a name can be. It has to fit a sidebar row, not a paragraph. */
const MAX_NAME = 60;

export interface ComputerDto {
  id: string;
  name: string;
  ownerEmail: string;
  role: "owner";
  original: boolean;
}

/**
 * `Computer 2`, `Computer 3`, … skipping anything already taken, so renaming
 * one to "Computer 3" does not make the next one a duplicate. The first
 * machine is not named here: it is `db.FIRST_NAME`, because nobody asked for
 * it and it should not read as one of a numbered set.
 */
export function nextName(existing: readonly PaddockRow[]): string {
  const taken = new Set(existing.map((p) => p.name.trim().toLowerCase()));
  for (let n = 2; ; n++) {
    const name = `Computer ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** A name somebody typed, or nothing — in which case one is picked for them. */
function cleanName(raw: unknown): string {
  return str(raw, MAX_NAME).replace(/\s+/g, " ").trim();
}

export async function create(ctx: AppContext, req: Request): Promise<Response> {
  const id = await authenticate(ctx, req);
  // A guest has no account to hang a second machine off, and telling them to
  // sign in is what the Sign in panel is already for. Somebody on an unclaimed
  // computer has the same problem and a better answer: claiming the one they
  // are standing on is what gives them an account to hang a second off.
  if (id.kind === "starter") throw new HttpError(403, "claim_required", "Claim this computer to add another.");
  if (id.kind !== "user") throw new HttpError(403, "account_required", "Sign in to add a computer of your own.");

  const owned = ctx.db.paddocksOf(id.user.email);
  if (owned.length >= MAX_COMPUTERS) {
    throw new HttpError(409, "too_many", `${MAX_COMPUTERS} computers is the limit. Remove one before adding another.`);
  }

  const asked = cleanName((await readJson(req)).name);
  const row = ctx.db.createPaddock(randomToken(9), id.user.email, asked || nextName(owned));
  return json({ data: dto(row, false) }, 201);
}

export async function rename(ctx: AppContext, req: Request, paddockId: string): Promise<Response> {
  const id = await authenticate(ctx, req);
  const access = paddockAccess(ctx, id, paddockId);
  requireOwner(access.role);

  const name = cleanName((await readJson(req)).name);
  if (!name) throw new HttpError(422, "bad_name", "A computer needs a name.");
  ctx.db.renamePaddock(access.paddock.id, name);
  // Anybody else looking at this machine sees the new name without a reload;
  // the name is on the row, so there is nothing for them to re-derive.
  hub.publish(access.paddock.id, "computer", { renamed: name });
  return json({ data: dto({ ...access.paddock, name }, access.original) });
}

/**
 * Remove a computer: the machine on Fountain, then the row, then everybody
 * who was in it.
 *
 * Retiring first is deliberate. If the row went first and Fountain then
 * refused, the machine would still be running on the owner's key with nothing
 * left pointing at it — a box nobody can reach and nobody can stop. The other
 * order leaves, at worst, a row whose machine is already gone, which is the
 * state a failed **Start over** leaves too and which the app handles.
 *
 * The last one cannot go. An account always has a computer — `/api/me` makes
 * one for anybody who signs in — so deleting the only row would hand back an
 * empty new machine and read as the delete having silently failed. **Start
 * over** is the operation for "I want this one back to nothing", and this says
 * so instead of guessing.
 */
export async function remove(ctx: AppContext, req: Request, paddockId: string): Promise<Response> {
  const id = await authenticate(ctx, req);
  const access = paddockAccess(ctx, id, paddockId);
  requireOwner(access.role);
  requireClaimed(access, "remove it");

  const owned = ctx.db.paddocksOf(access.paddock.owner_email!);
  if (owned.length <= 1) {
    throw new HttpError(409, "last_computer", "This is your only computer. Start over instead, which empties it without removing it.");
  }

  const report = await retire(ctx, access.paddock, access.original, { settings: true });
  ctx.db.deletePaddock(access.paddock.id);
  hub.publish(access.paddock.id, "computer", { removed: true });
  return json({ data: report });
}

function dto(row: PaddockRow, original: boolean): ComputerDto {
  return { id: row.id, name: row.name, ownerEmail: row.owner_email ?? "", role: "owner", original };
}
