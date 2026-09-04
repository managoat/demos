/**
 * Terminal tabs: several conversations on one machine.
 *
 * Fountain lets more than one conversation run on a sandbox as long as they
 * belong to the same agent — `sandbox_id` on `POST /api/conversations`, which
 * provisions nothing and attaches. So a tab is just a conversation that points
 * at the box, and the tab strip is derived from `GET /api/conversations`
 * rather than stored: clear this browser and your tabs are still there. The
 * same derivation, for teammates rather than tabs, is in
 * `apps/fountain-team/src/lib/threads.ts`.
 *
 * Three things ride in the `channel_id`, as `paddock:<computer>/<slug>@r<rev>`:
 *
 *   - the **computer** is the paddock this tab belongs to. One account can own
 *     several machines, and the only thing that tells them apart from outside
 *     is which agent they are on — which the server would have to ask Fountain
 *     for. Writing it into the channel keeps the answer derivable from the
 *     conversation list alone, which is the property everything else here is
 *     built on;
 *   - the **slug** names the tab's working directory under `~/work`, so the
 *     directory survives a reload and a different browser;
 *   - the **rev** is the config revision current when the tab opened, which is
 *     the whole of tier-`session` drift detection. A tab whose rev is behind
 *     the agent's rev started before the change and did not get it. Nothing
 *     needs to be stored to know that, and nothing can get it wrong.
 *
 * It lives in `shared/` rather than `src/lib/` because the server needs the
 * *same* answer to "is this conversation a tab on that box?" that the client
 * renders. The guest proxy admits a conversation only if this derivation says
 * it is a tab, so a second implementation of it would be a hole the day the
 * two disagreed. One function, both sides.
 *
 * The other fact this file encodes: **turns on one box serialise.** Fountain
 * answers `sandbox_at_capacity` when a second tab prompts mid-turn. That is
 * ordinary rather than exceptional, so `holder` names the tab that has the
 * machine and the UI queues behind it instead of showing an error.
 */
import type { Conversation } from "../src/api/types";

export const CHANNEL_PREFIX = "paddock";

/** The hidden tab paddock uses to change the machine. Never in the strip. */
export const OPS_SLUG = "ops";

/** The statuses a tab can be in and still be talked to. */
export const LIVE_STATUSES = ["pending", "idle", "running"] as const;

export function isLive(c: Pick<Conversation, "status">): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(c.status);
}

export interface ChannelParts {
  /**
   * Which computer this tab is on, or `null` for a channel written before an
   * account could have more than one. An unnamed tab is not homeless — see
   * `belongsTo`, which gives it to the account's original machine.
   */
  paddock: string | null;
  slug: string;
  rev: number;
}

/** `paddock:kZ3q…/t2@r7`. */
export function channelFor(paddockId: string, slug: string, rev: number): string {
  return `${CHANNEL_PREFIX}:${paddockId}/${slug}@r${rev}`;
}

/**
 * The computer, slug and rev out of a channel id, or null when it is not one
 * of ours.
 *
 * Two older shapes still parse, because tabs opened under them are still open:
 * a channel with no `/` names no computer, and a channel with no `@r…` reads
 * as rev 0 — which correctly marks it behind everything.
 */
export function parseChannel(channel: string | null | undefined): ChannelParts | null {
  if (!channel || !channel.startsWith(`${CHANNEL_PREFIX}:`)) return null;
  const body = channel.slice(CHANNEL_PREFIX.length + 1);
  if (!body) return null;
  const slash = body.indexOf("/");
  const paddock = slash === -1 ? null : body.slice(0, slash);
  const rest = slash === -1 ? body : body.slice(slash + 1);
  if (!rest || (slash !== -1 && !paddock)) return null;
  const at = rest.lastIndexOf("@r");
  if (at === -1) return { paddock, slug: rest, rev: 0 };
  const slug = rest.slice(0, at);
  const rev = Number(rest.slice(at + 2));
  if (!slug || !Number.isFinite(rev) || rev < 0) return null;
  return { paddock, slug, rev: Math.floor(rev) };
}

/**
 * Is this conversation a tab on that computer?
 *
 * `original` is the one concession to history: an account that had a machine
 * before it could have two has tabs whose channel names no computer, and they
 * belong to the machine it already had. Only the account's oldest paddock ever
 * passes that flag, so an unnamed tab can be claimed by exactly one computer
 * and never migrates to another.
 */
export function belongsTo(channel: string | null | undefined, paddockId: string, original: boolean): boolean {
  const parts = parseChannel(channel);
  if (!parts) return false;
  return parts.paddock === paddockId || (parts.paddock === null && original);
}

export interface Tab {
  conversation: Conversation;
  slug: string;
  /** The config revision this tab started with. */
  rev: number;
  title: string;
  /** The hidden ops tab, through which the machine is changed. */
  isOps: boolean;
  /** Opened before the current config revision: it did not get the newer settings. */
  stale: boolean;
  /** This tab is mid-turn. At most one tab on a box can be. */
  busy: boolean;
  /** The tab's working directory on the box. */
  cwd: string;
}

export interface TabsInput {
  /**
   * The computer these are tabs on, and whether it may claim a tab whose
   * channel names none (`belongsTo`).
   *
   * Not redundant with the agent below, and the day it looked redundant it was
   * a bug: a box and an agent identify a *machine*, and two paddocks that
   * somehow ended up on one machine — recycled ids, a hand-edited agent —
   * would then show each other's terminals. The computer is the narrower
   * question and the one the invitations are written against, so it is asked.
   */
  paddock: { id: string; original: boolean };
  /** The machine every tab must be on. */
  sandboxId: string;
  agentId: string;
  /** The agent's current config revision (`machine.configRev`). */
  rev: number;
  /** Where tab working directories live (`spec.WORK_ROOT`). */
  workRoot: string;
}

/**
 * Every live tab on this computer's box, oldest first so the strip does not
 * reorder itself. Conversations on the same machine that are not paddock's — a
 * tab opened by some other app on the same agent, or a tab on another one of
 * your computers — are left out rather than adopted.
 */
export function tabsOf(all: readonly Conversation[], input: TabsInput): Tab[] {
  const out: Tab[] = [];
  for (const c of all) {
    if (c.sandbox_id !== input.sandboxId) continue;
    if (c.agent_id !== input.agentId) continue;
    if (!isLive(c)) continue;
    if (!belongsTo(c.channel_id, input.paddock.id, input.paddock.original)) continue;
    const parts = parseChannel(c.channel_id);
    if (!parts) continue;
    out.push({
      conversation: c,
      slug: parts.slug,
      rev: parts.rev,
      title: titleOf(c, parts.slug),
      isOps: parts.slug === OPS_SLUG,
      stale: parts.rev < input.rev,
      busy: c.status === "running",
      cwd: `${input.workRoot}/${parts.slug}`,
    });
  }
  out.sort((a, b) => a.conversation.inserted_at.localeCompare(b.conversation.inserted_at));

  // Two conversations can end up claiming one slug — a tab opened out of band,
  // or two browsers racing `nextSlug`. They would then share a working
  // directory, and the strip would show two identically named tabs. The older
  // one keeps the slug; the newer is disambiguated rather than hidden, because
  // a tab somebody is typing into must not silently vanish from the strip.
  const seen = new Map<string, number>();
  return out.map((tab) => {
    const n = (seen.get(tab.slug) ?? 0) + 1;
    seen.set(tab.slug, n);
    return n === 1 ? tab : { ...tab, title: `${tab.title} (${n})` };
  });
}

/** The tabs the strip shows: everything but ops. */
export function visibleTabs(tabs: readonly Tab[]): Tab[] {
  return tabs.filter((t) => !t.isOps);
}

export function opsTab(tabs: readonly Tab[]): Tab | null {
  return tabs.find((t) => t.isOps) ?? null;
}

/**
 * The tab currently holding the machine, if any. While this is non-null every
 * other tab's prompt has to wait — not an error, just the shape of one box.
 */
export function holder(tabs: readonly Tab[]): Tab | null {
  return tabs.find((t) => t.busy) ?? null;
}

/** Can this tab take a prompt right now? */
export function canPrompt(tabs: readonly Tab[], slug: string): boolean {
  const h = holder(tabs);
  return h === null || h.slug === slug;
}

/** Any live tab opened before the current config revision. */
export function staleTabs(tabs: readonly Tab[]): Tab[] {
  return tabs.filter((t) => t.stale && !t.isOps);
}

/**
 * The next free tab slug: `t1`, `t2`, … skipping ones in use. Slugs are reused
 * once a tab is closed, which keeps `~/work` from growing a directory per tab
 * ever opened.
 */
export function nextSlug(tabs: readonly Tab[]): string {
  const taken = new Set(tabs.map((t) => t.slug));
  for (let n = 1; ; n++) {
    const slug = `t${n}`;
    if (!taken.has(slug)) return slug;
  }
}

/** What a tab is called: its own title, else "Terminal n" from the slug. */
export function titleOf(c: Pick<Conversation, "title">, slug: string): string {
  const own = c.title?.trim();
  if (own) return own;
  if (slug === OPS_SLUG) return "Machine";
  const n = /^t(\d+)$/.exec(slug);
  return n ? `Terminal ${n[1]}` : slug;
}

/**
 * The box this account's paddock is on, found from the conversation list
 * alone: the newest live paddock conversation's sandbox. This is why nothing
 * about the box is kept in the browser — sign in anywhere and the machine is
 * found the same way.
 */
export function findBox(all: readonly Conversation[], agentId: string): string | null {
  const mine = all
    .filter((c) => c.agent_id === agentId && c.sandbox_id && isLive(c) && parseChannel(c.channel_id))
    .sort((a, b) => b.inserted_at.localeCompare(a.inserted_at));
  return mine[0]?.sandbox_id ?? null;
}
