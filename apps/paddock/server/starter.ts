/**
 * Starting a computer before there is anybody to own it, and claiming it
 * afterwards. Issue #14, on fountain#1551.
 *
 *   POST /api/start   open one, or hand back the one this browser already has
 *
 * The claim itself is not a route. It happens inside `POST /api/auth/session`
 * — see `auth.signIn` — because "sign in" and "claim this computer" are one
 * action from the visitor's side, and two routes would be two ways to end up
 * half-registered.
 *
 * ## What an unclaimed computer actually is
 *
 * A **claimable principal**: a tenant of its own inside Fountain, with its own
 * agents, environments, vaults, conversations and sandboxes, opened on this
 * application's credential and paid for out of an introductory grant. Not a
 * shared service account. The difference is the whole security argument —
 * a shared account would make paddock re-implement the tenant isolation
 * Fountain already enforces at the query level, and one leaked visitor
 * credential would reach every visitor's machine.
 *
 * ## Why a claim keeps the machine
 *
 * A sandbox's name contains its tenant id, so moving resources between
 * accounts does not move the machine — it abandons one and builds another.
 * Claiming attaches an *owner* to the principal and touches no resource at
 * all, so the sandbox, the disk, the agent, the conversations and every id
 * under them are the same values afterwards. That is why the flow reads
 * "claim" and not "transfer".
 *
 * ## Idempotence, twice
 *
 * Both calls to Fountain carry an `Idempotency-Key` derived from the paddock
 * id, and the paddock id is itself derived from a key the browser keeps. So a
 * refresh, a double-invoked effect, a retry after a dropped response and a
 * server restart mid-flight all converge on the same principal and the same
 * row rather than a second machine nobody is looking at and this application
 * is paying for.
 */
import { authenticate, meDto, type AppContext, type Identity } from "./context";
import { randomToken, sha256 } from "./crypto";
import { FIRST_NAME, type PaddockRow } from "./db";
import { asHttpError, FountainClient, FountainHttpError, type ClaimedPrincipal } from "./fountain";
import { HttpError, json, readJson, sessionCookie, str } from "./http";

/** How this application names itself to Fountain when it opens a principal. */
const APPLICATION_ID = "paddock";

/**
 * What this feature reports about itself, as one grep-able line each.
 *
 * Not a metrics client, and deliberately not: paddock has no telemetry of any
 * kind, and adding one for a single feature would be more moving parts than
 * the feature. What an operator actually needs is the four numbers that say
 * whether the demo is working and what it is costing — starts attempted,
 * starts opened, claims, and refusals — plus the sweep, which already logs.
 * `paddock: start …` is the prefix to alert on; unexpected creation volume and
 * a rising `refused` are the two shapes worth an alarm.
 */
function report(event: string, detail: Record<string, unknown> = {}): void {
  console.log(`paddock: ${event}`, JSON.stringify(detail));
}

/** One live sandbox, which is what a computer is. Fountain enforces it. */
const MAX_LIVE_SANDBOXES = 1;

/** This application's own Fountain key: opens, reads and releases grants. */
function appClient(ctx: AppContext): FountainClient {
  if (!ctx.config.anonymousStart || !ctx.config.fountainAppKey) {
    throw new HttpError(503, "start_unavailable", "This Paddock does not start computers for visitors. Sign in instead.");
  }
  return new FountainClient(ctx.config.fountainUrl, ctx.config.fountainAppKey);
}

/**
 * The computer this browser gets, derived rather than random.
 *
 * The browser keeps a `startKey` and sends it; the paddock id is a hash of it
 * under this server's secret. Two things fall out of that and both are the
 * point. A retry finds the row it made last time instead of making a second
 * one — which no random id could do, because a browser that lost the response
 * also lost the id. And the id is not computable from the `startKey` alone, so
 * what sits in somebody's `localStorage` is not a name anybody else can use to
 * go looking for the computer.
 *
 * It is not a credential either way: reaching a computer needs the session
 * cookie, and `paddockAccess` checks that the session names *this* one.
 */
async function paddockIdFor(ctx: AppContext, startKey: string): Promise<string> {
  return (await sha256(`start:${ctx.config.secret}:${startKey}`)).slice(0, 12);
}

/**
 * Start a computer, or hand back the one already started.
 *
 * Deliberately does not authenticate first, and deliberately does not refuse
 * somebody who *is* authenticated: the client calls this when it has nothing,
 * and a session that turns out to be live is answered with the ordinary `Me`
 * rather than a second machine. An invite link is handled before this on the
 * client, so a guest never arrives here at all — but a guest who did would get
 * their guest identity back, not a computer of their own.
 */
export async function start(ctx: AppContext, req: Request): Promise<Response> {
  const existing = await currentIdentity(ctx, req);
  if (existing) return json(meFor(ctx, existing));

  const client = appClient(ctx);
  const startKey = str((await readJson(req)).startKey, 200).trim();
  if (!startKey) throw new HttpError(422, "missing_start_key", "A start needs a key from the browser, so a retry is not a second computer.");
  const paddockId = await paddockIdFor(ctx, startKey);

  // The row this browser already has. Claimed means they came back without
  // their cookie to a computer that is now somebody's: signing in is the way
  // back to it, and starting another would be quietly abandoning it.
  const already = ctx.db.getPaddock(paddockId);
  if (already?.claim_status === "claimed") {
    throw new HttpError(409, "already_claimed", "That computer has been claimed. Sign in to open it.");
  }

  report("start attempted", { paddock: paddockId, resumed: !!already });
  let paddock: PaddockRow;
  try {
    paddock = already ?? (await openOnce(ctx, client, paddockId));
  } catch (err) {
    report("start refused", { paddock: paddockId, why: err instanceof HttpError ? err.code : "error" });
    throw err;
  }
  const token = randomToken();
  ctx.db.createStarterSession(await sha256(token), paddock.id);
  ctx.db.expireSessions(ctx.config.sessionMaxAgeMs);

  return json(meFor(ctx, { kind: "starter", paddock }), 201, {
    "set-cookie": sessionCookie(token, req, ctx.config.sessionMaxAgeMs / 1000),
  });
}

/**
 * Opens in flight, so two requests for one computer are one open.
 *
 * The idempotency key alone is not enough here, and the reason is specific:
 * Fountain keeps no secret it could hand back twice, so a *replayed* create
 * answers with the same principal and a **new** pair of secrets, and the first
 * pair stops working. Two overlapping creates would therefore both succeed
 * upstream and leave whichever row was written first holding a dead key — a
 * computer this server can no longer run or claim.
 *
 * So they share one call. React double-invoking the boot effect and a
 * double-clicked reload are the two ways this actually happens, and both are
 * within one process; a start racing across a restart is left to the
 * idempotency key, which handles it because only one of them is still waiting
 * for an answer.
 */
const opening = new Map<string, Promise<PaddockRow>>();

function openOnce(ctx: AppContext, client: FountainClient, paddockId: string): Promise<PaddockRow> {
  const inflight = opening.get(paddockId);
  if (inflight) return inflight;
  // The row is re-read inside the flight, not outside it: a caller that queued
  // behind an open which has already landed wants the row, not a second open.
  const started = (async () => ctx.db.getPaddock(paddockId) ?? (await open(ctx, client, paddockId)))();
  opening.set(paddockId, started);
  void started
    .finally(() => opening.delete(paddockId))
    .catch(() => undefined);
  return started;
}

/** Open one principal upstream and write the row that owns it. */
async function open(ctx: AppContext, client: FountainClient, paddockId: string): Promise<PaddockRow> {
  let grant;
  try {
    grant = await client.openClaimable(
      {
        application_id: APPLICATION_ID,
        expires_in: ctx.config.anonymousTtlSeconds,
        limits: { max_live_sandboxes: MAX_LIVE_SANDBOXES, max_cost_usd: ctx.config.anonymousBudgetUsd },
        metadata: { paddock_id: paddockId },
      },
      paddockId,
    );
  } catch (err) {
    throw startFailure(err);
  }
  if (!grant.api_key || !grant.claim_token) {
    // Fountain shows both exactly once, on create. Without them there is no
    // machine to run and no way to claim it, and a row saying otherwise would
    // be a tenant this server can neither use nor release.
    throw new HttpError(502, "start_incomplete", "Fountain opened a computer without giving back its credentials.");
  }

  const row = ctx.db.createUnclaimedPaddock({
    id: paddockId,
    name: FIRST_NAME,
    principalId: grant.principal_id,
    claimableUserId: grant.id,
    claimTokenEnc: await ctx.cipher.encrypt(grant.claim_token),
    computeKeyEnc: await ctx.cipher.encrypt(grant.api_key),
    expiresAt: grant.expires_at,
  });
  // Reported here rather than in `start`, and the difference is the number an
  // operator alerts on. Callers that queued behind one flight all come back
  // holding the same row, so reporting it there counted one principal as two
  // — which is exactly the shape of "unexpected creation volume".
  report("start opened", { paddock: row.id, principal: row.fountain_principal_id, expires: row.claim_expires_at });
  return row;
}

/**
 * Why a start could not happen, said in terms of the visitor rather than of
 * Fountain. Capacity, rate limits and an exhausted application balance are
 * ordinary operating states here — this feature has a budget — and each one
 * has a different honest sentence.
 */
function startFailure(err: unknown): HttpError {
  if (err instanceof FountainHttpError) {
    if (err.status === 429) return new HttpError(429, "start_busy", "A lot of people are starting computers right now. Try again in a moment.");
    if (err.status === 402 || err.code === "insufficient_credits") {
      return new HttpError(503, "start_budget", "This demo has run out of introductory credit for now. Sign in with a Fountain account to keep going.");
    }
    if (err.status === 409 || err.status === 422) return new HttpError(503, "start_at_capacity", "This demo is at its limit of free computers. Sign in with a Fountain account to keep going.");
  }
  return asHttpError(err, "start a computer");
}

/**
 * Attach an owner to the computer this browser has been using.
 *
 * Called from `auth.signIn` with the key that just signed in, because it is
 * *that account* Fountain records as the owner — this application's own
 * credential cannot claim on somebody's behalf, and should not be able to.
 *
 * The idempotency key is the paddock id, so every retry is a replay. That is
 * what makes the two failure modes below recoverable rather than a machine
 * lost between two systems: a claim that succeeded upstream and then failed to
 * land here is finished by signing in again.
 */
export async function claim(ctx: AppContext, paddock: PaddockRow, apiKey: string, email: string): Promise<ClaimedPrincipal> {
  if (!paddock.claimable_user_id || !paddock.claim_token_enc) {
    throw new HttpError(409, "not_claimable", "This computer cannot be claimed.");
  }
  const token = await ctx.cipher.decrypt(paddock.claim_token_enc);
  const client = new FountainClient(ctx.config.fountainUrl, apiKey);

  let claimed: ClaimedPrincipal;
  try {
    claimed = await client.claim(paddock.claimable_user_id, token, `claim:${paddock.id}`);
  } catch (err) {
    const failure = claimFailure(err);
    report("start claim failed", { paddock: paddock.id, why: failure.code, retryable: !(failure instanceof ClaimRefused) });
    throw failure;
  }

  // One statement, and its `WHERE claim_status = 'unclaimed'` is the race.
  // Losing it is not a failure: somebody — another tab of the same person,
  // finishing the same sign-in — already wrote exactly this. What would be a
  // failure is a *different* account having won, which is why the owner is
  // checked rather than assumed.
  if (!ctx.db.claimPaddock(paddock.id, email, await ctx.cipher.encrypt(claimed.api_key))) {
    const now = ctx.db.getPaddock(paddock.id);
    if (now?.owner_email !== email) throw new HttpError(409, "claimed_by_other", "Somebody else claimed that computer first.");
  }
  // The conversion, and the one number this feature exists to move.
  report("start claimed", { paddock: paddock.id, principal: paddock.fountain_principal_id, age_ms: Date.now() - Date.parse(paddock.created_at) });
  return claimed;
}

/**
 * A claim that did not happen, split by whether trying again could help.
 *
 * The split is load-bearing rather than cosmetic. A terminal failure lets the
 * sign-in finish without the computer, because the alternative is a person who
 * cannot sign in at all. A retryable one has to *refuse* the sign-in and keep
 * the starter session, because signing them in would drop the only session
 * that knows which computer was being claimed — and the machine would then sit
 * there, claimable by nobody, until it expired.
 */
export class ClaimRefused extends HttpError {}

function claimFailure(err: unknown): HttpError {
  if (err instanceof FountainHttpError) {
    if (err.status === 409) return new ClaimRefused(409, "claimed_by_other", "Somebody else claimed that computer first.");
    if (err.status === 410) return new ClaimRefused(410, "claim_expired", "That computer's free time ran out before it was claimed.");
    if (err.status === 403 || err.status === 402) {
      return new ClaimRefused(403, "claim_refused", `Fountain would not let that account take the computer on: ${err.message}`);
    }
  }
  return asHttpError(err, "claim this computer");
}

// ── cleanup ───────────────────────────────────────────────────────────────

export interface SweepReport {
  released: number;
  forgotten: number;
  /** Grants Fountain says are claimed while paddock still says otherwise. */
  stranded: number;
  failed: number;
}

/**
 * Release expired computers and forget them. Idempotent and retryable, which
 * it has to be: this runs on a timer and every state it can find is a state
 * some previous run may have left half-finished.
 *
 * Fountain is asked first and believed. It owns the lifetime, the budget and
 * the answer to "did somebody claim this after all" — a race between a claim
 * and a sweep is settled by reading, not by whoever ran second. A grant that
 * comes back `claimed` while the local row says otherwise is a lost claim
 * response: it is counted and left alone rather than released, because
 * releasing it would destroy a machine that now belongs to somebody.
 */
export async function sweepExpired(ctx: AppContext): Promise<SweepReport> {
  const report: SweepReport = { released: 0, forgotten: 0, stranded: 0, failed: 0 };
  if (!ctx.config.anonymousStart) return report;
  const client = appClient(ctx);

  for (const paddock of ctx.db.expiredUnclaimed(new Date().toISOString())) {
    if (!paddock.claimable_user_id) {
      forget(ctx, paddock);
      report.forgotten += 1;
      continue;
    }
    try {
      const grant = await client.readClaimable(paddock.claimable_user_id).catch((err) => {
        // Gone from Fountain entirely: the purge already ran. Nothing upstream
        // to release, and the row is only a tombstone now.
        if (err instanceof FountainHttpError && err.status === 404) return null;
        throw err;
      });
      if (grant?.status === "claimed") {
        report.stranded += 1;
        console.error(`paddock: claimable ${paddock.claimable_user_id} is claimed upstream but unclaimed here — leaving it alone`);
        continue;
      }
      if (grant?.status === "unclaimed") {
        await client.releaseClaimable(paddock.claimable_user_id);
        report.released += 1;
      }
      forget(ctx, paddock);
      report.forgotten += 1;
    } catch (err) {
      report.failed += 1;
      console.error(`paddock: could not release claimable ${paddock.claimable_user_id}:`, err);
    }
  }
  return report;
}

/**
 * Forget one expired computer — the row, and deliberately not the sessions
 * that point at it.
 *
 * `sessions.starter_paddock_id` carries no foreign key precisely so those rows
 * survive this, exactly as a guest's session survives a re-mint. A browser
 * that comes back afterwards names a computer that is not there any more, and
 * `authenticate` reads that as "this computer's free time is up" — which is
 * what actually happened. Deleting the session instead would replace that with
 * "your session ended", which is true of nothing and explains nothing. The
 * orphans are harmless and `expireSessions` sweeps them.
 */
function forget(ctx: AppContext, paddock: PaddockRow): void {
  ctx.db.deletePaddock(paddock.id);
}

// ── plumbing ──────────────────────────────────────────────────────────────

/** The session's identity, or null where there is none. Never throws. */
async function currentIdentity(ctx: AppContext, req: Request): Promise<Identity | null> {
  try {
    return await authenticate(ctx, req);
  } catch {
    return null;
  }
}

function meFor(ctx: AppContext, id: Identity): Record<string, unknown> {
  if (id.kind === "guest") return meDto(ctx, id, "guest", id.guest.paddock_id);
  if (id.kind === "starter") return meDto(ctx, id, "owner", id.paddock.id);
  const own = ctx.db.paddocksOf(id.user.email)[0];
  return meDto(ctx, id, own ? "owner" : null, own?.id ?? null);
}
