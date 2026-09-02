/**
 * What the work cost, for the person who pays for it.
 *
 * Every conversation in a project runs on the project *owner's* Fountain key
 * (README, "Sharing") — the owner's agents, computers and bill — including
 * conversations a member started. So the owner is the only person who can be
 * charged and, until this route, the only person who could not see what for.
 *
 * This is an account route, not a project one, and deliberately not behind
 * `server/proxy.ts`. The proxy is the boundary a member crosses into the
 * owner's Fountain; a bill is not something to put on the far side of it.
 * What this answers is the *caller's own* account, on the caller's own key,
 * broken down over the projects the caller owns. A member of someone else's
 * project learns nothing about that owner's spend here: their key holds none
 * of it, and only projects they own are enumerated.
 *
 * Two sets of numbers, kept apart on purpose, because they do not add up to
 * each other:
 *
 *   - **The bill** — Fountain's `GET /api/account/billing`: the plan, and the
 *     turn hours and sandbox minutes used over the period Stripe invoices.
 *     Account-wide. Fountain attributes it to nothing, so neither do we.
 *
 *   - **The breakdown** — the conversation list: each conversation carries
 *     `usage_total` (input and output tokens) and `turn_count`, and carries
 *     the work item it belongs to in its `channel_id`. Summing those by
 *     `workbench:<project>/<item>/<tag>` is where the work went, per project
 *     and per work item.
 *
 * The breakdown is a lifetime figure — a conversation reports a running total,
 * not a per-period one — while the bill covers one period, and tokens are not
 * the unit either is denominated in. Dividing the invoice by token share would
 * be a number we made up, so we do not: the view shows both and says which is
 * which. `lastActiveAt` is served per bucket so a reader can see for themselves
 * which projects were live inside the period.
 *
 * `period` below closes both of those gaps, at a price, which is why it is a
 * second route rather than more of the first. See its own comment.
 */
import { parseChannel } from "../shared/channel";
import { parseItemStatus, type ItemStatus } from "../shared/status";
import { authenticate, userClient, type AppContext } from "./context";
import type { Billing, ConversationSummary, FountainClient, TurnSummary } from "./fountain";
import { HttpError, json } from "./http";

/** What one project, or one work item, used. */
export interface CostBucket {
  conversations: number;
  turns: number;
  /** Input and output tokens, summed over conversations that reported a usage. */
  input: number;
  output: number;
  lastActiveAt: string | null;
}

export interface ItemCostDto extends CostBucket {
  id: string;
  /** Null for an item that has been deleted here but whose conversations still name it. */
  title: string | null;
  status: ItemStatus | null;
}

export interface ProjectCostDto extends CostBucket {
  id: string;
  name: string;
  memberCount: number;
  items: ItemCostDto[];
}

export interface CostDto {
  /** The account's bill, or null when this Fountain has billing switched off. */
  billing: Billing | null;
  /** Why there is no bill: `disabled` (Fountain said 404) or `error` (it would not say). */
  billingUnavailable: "disabled" | "error" | null;
  /** The caller's own projects, biggest first. Projects shared *with* the caller are not theirs to see the cost of. */
  projects: ProjectCostDto[];
  /** Conversations on the account that belong to no project of the caller's: their Fountain use outside the workbench. */
  elsewhere: CostBucket;
  /** Everything on the account, attributed or not. */
  total: CostBucket;
}

function bucket(): CostBucket {
  return { conversations: 0, turns: 0, input: 0, output: 0, lastActiveAt: null };
}

function add(b: CostBucket, c: ConversationSummary): void {
  b.conversations += 1;
  b.turns += c.turn_count ?? 0;
  b.input += c.usage_total?.input ?? 0;
  b.output += c.usage_total?.output ?? 0;
  const at = c.last_active_at ?? c.updated_at ?? c.inserted_at ?? null;
  if (at && (!b.lastActiveAt || at > b.lastActiveAt)) b.lastActiveAt = at;
}

const tokens = (b: CostBucket): number => b.input + b.output;

export async function show(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const client = await userClient(ctx, user);

  // Sub-conversations spend too, so `roots_only` is false: every conversation
  // on the key counts, and each one's channel says where it belongs.
  const [billed, listed] = await Promise.allSettled([client.billing(), client.conversations({ roots_only: "false" })]);
  if (listed.status === "rejected") {
    throw new HttpError(502, "fountain_error", "Fountain would not list your conversations, so there is nothing to break down. Is your key still valid? Sign in again to refresh it.");
  }

  const billing = billed.status === "fulfilled" ? billed.value : null;
  const billingUnavailable: CostDto["billingUnavailable"] = billing ? null : billed.status === "fulfilled" ? "disabled" : "error";

  // Only projects the caller owns: theirs is the key the work ran on.
  const owned = ctx.db.projectsFor(user.email).filter((p) => p.owner_email === user.email);
  const projects = new Map<string, { dto: ProjectCostDto; items: Map<string, ItemCostDto> }>();
  for (const p of owned) {
    const items = new Map<string, ItemCostDto>();
    for (const w of ctx.db.items(p.id)) items.set(w.id, { id: w.id, title: w.title, status: parseItemStatus(w.status), ...bucket() });
    projects.set(p.id, { dto: { id: p.id, name: p.name, memberCount: ctx.db.members(p.id).length, items: [], ...bucket() }, items });
  }

  const elsewhere = bucket();
  const total = bucket();
  for (const c of listed.value) {
    add(total, c);
    const ref = parseChannel(c.channel_id);
    const entry = ref ? projects.get(ref.projectId) : null;
    if (!ref || !entry) {
      add(elsewhere, c);
      continue;
    }
    add(entry.dto, c);
    let item = entry.items.get(ref.itemId);
    if (!item) {
      // The item is gone from the workbench but its conversations still name
      // it. Its spend happened; showing it as a hole would understate the project.
      item = { id: ref.itemId, title: null, status: null, ...bucket() };
      entry.items.set(ref.itemId, item);
    }
    add(item, c);
  }

  const byCost = (a: CostBucket, b: CostBucket) => tokens(b) - tokens(a) || b.turns - a.turns;
  const out = [...projects.values()].map((e) => ({ ...e.dto, items: [...e.items.values()].sort(byCost) })).sort(byCost);
  return json({ data: { billing, billingUnavailable, projects: out, elsewhere, total } satisfies CostDto });
}

// ── the same breakdown, in the bill's unit and over the bill's window ─────
//
// `show` above answers two questions with numbers that cannot be held next to
// each other: the bill is turn hours over one period, the breakdown is tokens
// over all time. This route answers the question that was actually being
// asked — *what did this project cost me this month* — by measuring the one
// thing that is both attributable and billed.
//
// A `Turn` carries `started_at` and `ended_at`, and a conversation carries the
// work item in its `channel_id`. Summing turn intervals clipped to the billing
// period, grouped by channel, is per-project turn hours over the bill's own
// window: the same unit and the same window, so it *is* a division of the
// account figure rather than a second, unrelated measurement.
//
// The arithmetic deliberately mirrors Fountain's own meter
// (`Fountain.Billing.turn_hours_used/2` over `SandboxUsage.turn_seconds_for_user/3`):
// each turn's interval clipped to the period and *summed*, not unioned — two
// conversations each running an hour on one sandbox are two hours of work
// (ADR 0023) — a still-running turn accruing only as far as now, never to a
// period end that has not happened, and a turn with no `started_at` counting
// for nothing. One difference we cannot close: Fountain drops providers it
// does not pay for (a tenant's own `runner`) and the API does not say which
// provider a turn ran on, so on an account using `runner` this measures
// slightly more than the meter does. `accountTurnHours` is Fountain's own
// figure, carried here rather than derived, so the two are visibly separate.
//
// The price is the reason this is not folded into `show`: turns are per
// conversation and the endpoint takes no window, so this is one request per
// conversation instead of one request in total. Three things keep that down,
// and each reports what it did rather than quietly shrinking the answer:
//
//   - Only conversations in projects the caller *owns* are fetched. What ran
//     elsewhere on the account is the bill's figure minus this one, which is
//     subtraction, not 200 more round trips.
//   - A conversation whose last activity predates the period, or which was
//     created after it, cannot hold a turn inside it. Skipped without asking.
//   - Turns are cached per conversation against `turn_count` + last activity,
//     so a reload re-fetches only the conversations that moved. A conversation
//     with a turn still in flight is never cached: its figure grows with the
//     clock.

const TURNS_TTL_MS = 10 * 60 * 1000;
/** Enough for a busy account; past it the oldest half goes, since a miss only costs a re-fetch. */
const TURNS_CACHE_MAX = 4000;
/** Requests in flight at once. Fountain is one host and this is a page load, not a batch job. */
const FANOUT_CONCURRENCY = 8;
/** The most conversations one answer will fan out over. Beyond it the page is told what was left out. */
const FANOUT_MAX = 400;

/** A turn reduced to what a bill needs: milliseconds, and end-of-turn tokens. */
interface PeriodTurn {
  started: number;
  /** Null while the turn is still running. */
  ended: number | null;
  input: number;
  output: number;
}

/**
 * conversation id → its turns, and the stamp they were read at. Keyed by
 * conversation id alone, which is safe because an entry is only ever read for
 * a conversation that came back from the caller's *own* conversation list —
 * they hold the key it is on.
 */
const turnsCache = new Map<string, { turns: PeriodTurn[]; stamp: string; at: number }>();

/** For tests: forget every cached turn list. */
export function resetCostCache(): void {
  turnsCache.clear();
}

/** What one project, or one work item, used inside the window. */
export interface PeriodBucket {
  /** Conversations with at least one turn touching the window. */
  conversations: number;
  /** Turns touching the window. */
  turns: number;
  /** Turn time inside the window, clipped as Fountain clips it. */
  seconds: number;
  /** Tokens on turns that *ended* inside the window — a turn reports its usage once, at the end. */
  input: number;
  output: number;
}

export interface ItemPeriodDto extends PeriodBucket {
  id: string;
  title: string | null;
  status: ItemStatus | null;
}

export interface ProjectPeriodDto extends PeriodBucket {
  id: string;
  name: string;
  items: ItemPeriodDto[];
}

/** What the fan-out actually did, so the page can say so rather than imply it read everything. */
export interface FanoutDto {
  /** Conversations in the caller's own projects. */
  candidates: number;
  /** Asked Fountain for turns and got them. */
  fetched: number;
  /** Answered from the turn cache. */
  cached: number;
  /** Ruled out by their timestamps without a request. */
  skipped: number;
  /** Over `FANOUT_MAX`, so not measured at all. Their work is missing from the figures below. */
  dropped: number;
  /** Fountain would not answer for these. Their work is missing too. */
  failed: number;
}

export interface PeriodCostDto {
  /** The bill's own period, or the calendar month when this Fountain has billing switched off. */
  period: { start: string; end: string; source: string };
  /** Where measuring stops: the period's end, or now while the period is still running. */
  measuredTo: string;
  /** Fountain's account-wide turn hours for this window — the figure these are a share of. Null with no bill. */
  accountTurnHours: number | null;
  /** The caller's own projects, most turn time first. */
  projects: ProjectPeriodDto[];
  /** Every project above, summed: the part of the account this workbench can account for. */
  measured: PeriodBucket;
  fanout: FanoutDto;
}

function periodBucket(): PeriodBucket {
  return { conversations: 0, turns: 0, seconds: 0, input: 0, output: 0 };
}

/**
 * The window to measure over. Fountain falls back to the calendar month when
 * an account has no invoiced period (`period.source: "calendar_month"`), and
 * so do we when it reports no period at all — with no `accountTurnHours` to
 * be a share of, which the page says.
 */
function windowOf(billing: Billing | null): { start: string; end: string; source: string } {
  const start = billing?.period?.start;
  const end = billing?.period?.end;
  if (start && end && Number.isFinite(Date.parse(start)) && Number.isFinite(Date.parse(end))) {
    return { start, end, source: billing?.period?.source ?? "subscription" };
  }
  const now = new Date();
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
    source: "calendar_month",
  };
}

/** When a conversation was last touched, by whichever field this Fountain filled in. */
const activeAt = (c: ConversationSummary): string | null => c.last_active_at ?? c.updated_at ?? c.inserted_at ?? null;

/** The stamp a cached turn list is valid against: neither can move without a turn having changed. */
const stampOf = (c: ConversationSummary): string => `${c.turn_count ?? "?"}|${activeAt(c) ?? "?"}`;

function distil(turns: TurnSummary[]): PeriodTurn[] {
  const out: PeriodTurn[] = [];
  for (const t of turns) {
    const started = t.started_at ? Date.parse(t.started_at) : NaN;
    // Fountain's meter requires a start too: a turn that never ran bills nothing.
    if (!Number.isFinite(started)) continue;
    const ended = t.ended_at ? Date.parse(t.ended_at) : NaN;
    out.push({ started, ended: Number.isFinite(ended) ? ended : null, input: t.usage?.input ?? 0, output: t.usage?.output ?? 0 });
  }
  return out;
}

/** Fold one turn into a bucket, if it touches `[startMs, ceilingMs)`. */
function foldTurn(t: PeriodTurn, startMs: number, ceilingMs: number, into: PeriodBucket[]): boolean {
  if (t.started >= ceilingMs) return false;
  // A running turn accrues to the ceiling and no further.
  const finish = t.ended ?? ceilingMs;
  if (finish < startMs) return false;
  const seconds = Math.max(0, Math.min(finish, ceilingMs) - Math.max(t.started, startMs)) / 1000;
  // Tokens land once, when the turn ends; a turn that ended in a later period
  // spent its tokens there, not here.
  const banked = t.ended !== null && t.ended >= startMs && t.ended < ceilingMs;
  for (const b of into) {
    b.turns += 1;
    b.seconds += seconds;
    if (banked) {
      b.input += t.input;
      b.output += t.output;
    }
  }
  return true;
}

/** Run `fn` over `items`, `limit` at a time, keeping the order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The turns of one conversation, from cache when nothing about it has moved. */
async function turnsOf(client: FountainClient, c: ConversationSummary, tally: FanoutDto): Promise<PeriodTurn[] | null> {
  const stamp = stampOf(c);
  const hit = turnsCache.get(c.id);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < TURNS_TTL_MS) {
    tally.cached += 1;
    return hit.turns;
  }
  let turns: PeriodTurn[];
  try {
    turns = distil(await client.turns(c.id));
  } catch {
    // One unreadable conversation is a hole in the figures, not a failed page.
    tally.failed += 1;
    return null;
  }
  tally.fetched += 1;
  // A turn still in flight grows with the clock, so its list is not cacheable.
  if (turns.every((t) => t.ended !== null)) {
    if (turnsCache.size >= TURNS_CACHE_MAX) for (const k of [...turnsCache.keys()].slice(0, TURNS_CACHE_MAX / 2)) turnsCache.delete(k);
    turnsCache.set(c.id, { turns, stamp, at: Date.now() });
  }
  return turns;
}

export async function period(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const client = await userClient(ctx, user);

  const [billed, listed] = await Promise.allSettled([client.billing(), client.conversations({ roots_only: "false" })]);
  if (listed.status === "rejected") {
    throw new HttpError(502, "fountain_error", "Fountain would not list your conversations, so there is nothing to break down. Is your key still valid? Sign in again to refresh it.");
  }
  const billing = billed.status === "fulfilled" ? billed.value : null;

  const win = windowOf(billing);
  const startMs = Date.parse(win.start);
  const endMs = Date.parse(win.end);
  // Never measure into a period that has not happened yet.
  const ceilingMs = Math.min(endMs, Date.now());

  const owned = ctx.db.projectsFor(user.email).filter((p) => p.owner_email === user.email);
  const projects = new Map<string, { dto: ProjectPeriodDto; items: Map<string, ItemPeriodDto> }>();
  for (const p of owned) {
    const items = new Map<string, ItemPeriodDto>();
    for (const w of ctx.db.items(p.id)) items.set(w.id, { id: w.id, title: w.title, status: parseItemStatus(w.status), ...periodBucket() });
    projects.set(p.id, { dto: { id: p.id, name: p.name, items: [], ...periodBucket() }, items });
  }

  const tally: FanoutDto = { candidates: 0, fetched: 0, cached: 0, skipped: 0, dropped: 0, failed: 0 };
  const candidates: { conv: ConversationSummary; projectId: string; itemId: string }[] = [];
  for (const c of listed.value) {
    const ref = parseChannel(c.channel_id);
    if (!ref || !projects.has(ref.projectId)) continue;
    tally.candidates += 1;
    const last = activeAt(c);
    const first = c.inserted_at ?? null;
    // Nothing it did can be inside the window: last touched before it opened,
    // or opened after it closed. Ruled out without a request.
    if ((last && Date.parse(last) < startMs) || (first && Date.parse(first) >= ceilingMs)) {
      tally.skipped += 1;
      continue;
    }
    candidates.push({ conv: c, projectId: ref.projectId, itemId: ref.itemId });
  }

  // Most recently active first, so a cap that bites drops the stalest work.
  candidates.sort((a, b) => (activeAt(b.conv) ?? "").localeCompare(activeAt(a.conv) ?? ""));
  if (candidates.length > FANOUT_MAX) {
    tally.dropped = candidates.length - FANOUT_MAX;
    candidates.length = FANOUT_MAX;
  }

  const measured = periodBucket();
  const fetched = await pool(candidates, FANOUT_CONCURRENCY, (c) => turnsOf(client, c.conv, tally));
  candidates.forEach((c, i) => {
    const turns = fetched[i];
    if (!turns) return;
    const entry = projects.get(c.projectId)!;
    let item = entry.items.get(c.itemId);
    if (!item) {
      // Deleted here, but its conversations still name it and its time still ran.
      item = { id: c.itemId, title: null, status: null, ...periodBucket() };
      entry.items.set(c.itemId, item);
    }
    const before = item.turns;
    for (const t of turns) foldTurn(t, startMs, ceilingMs, [measured, entry.dto, item]);
    if (item.turns > before) {
      measured.conversations += 1;
      entry.dto.conversations += 1;
      item.conversations += 1;
    }
  });

  const byTime = (a: PeriodBucket, b: PeriodBucket) => b.seconds - a.seconds || b.turns - a.turns;
  const out = [...projects.values()].map((e) => ({ ...e.dto, items: [...e.items.values()].sort(byTime) })).sort(byTime);
  return json({
    data: {
      period: win,
      measuredTo: new Date(ceilingMs).toISOString(),
      accountTurnHours: billing?.usage?.turn_hours ?? null,
      projects: out,
      measured,
      fanout: tally,
    } satisfies PeriodCostDto,
  });
}
