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
 */
import { parseChannel } from "../shared/channel";
import { parseItemStatus, type ItemStatus } from "../shared/status";
import { authenticate, userClient, type AppContext } from "./context";
import type { Billing, ConversationSummary } from "./fountain";
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
