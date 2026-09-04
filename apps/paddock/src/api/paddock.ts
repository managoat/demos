/**
 * Paddock's own routes — the ones that are not Fountain.
 *
 * Who the session is, who is in the machine, the invite link, and presence.
 * Same origin, cookie-authenticated, no key anywhere near the browser.
 */
import { readSse, type SseMessage } from "../lib/sse";
import type { SkillHit } from "../lib/skills";

export type Role = "owner" | "member" | "guest";

/** One computer this person can open: theirs, or one shared with them. */
export interface Reachable {
  id: string;
  /** The owner's name for it. Blank on a machine somebody else owns. */
  name: string;
  ownerEmail: string;
  role: Role;
  /**
   * The first computer this account ever had, and so the one that owns
   * anything from before there could be a second — an agent with no computer
   * on it, a tab whose channel names none. Decided by the server, on the row
   * order, and never worked out again here.
   */
  original: boolean;
}

/**
 * An unclaimed computer's terms, as the server states them.
 *
 * Present only on a `starter` — somebody using a computer they started before
 * signing in. Everything the client does with it is an offer rather than a
 * gate: the *server* refuses what an unclaimed computer may not do, and hiding
 * a button is a courtesy on top of that, never instead of it.
 */
export interface ClaimState {
  status: "unclaimed";
  /** When Fountain expires the introductory grant. ISO 8601, or null. */
  expiresAt: string | null;
}

export interface Me {
  label: string;
  /**
   * `starter` is the anonymous *owner* of an unclaimed computer, and is not a
   * guest with fewer rights: a guest borrows one terminal in a machine
   * somebody else owns, a starter possesses a whole machine nobody owns yet.
   */
  kind: "user" | "guest" | "starter";
  email: string | null;
  role: Role | null;
  /** Where to land. */
  paddockId: string | null;
  /** Everywhere this person can go: their own machine, and any shared with them. */
  paddocks: Reachable[];
  /** Set once, on the sign-in that turned a guest into a member. */
  upgradedFrom?: string;
  /** Set on a starter, and on nobody else. */
  claim?: ClaimState | null;
  /** Set once, on the sign-in that claimed an unclaimed computer. Its id. */
  claimedFrom?: string;
  /**
   * Set when the sign-in worked and the claim did not — the computer expired,
   * or somebody else got there first. They are signed in; that machine is not
   * theirs, and saying so is better than a machine quietly disappearing.
   */
  claimFailed?: string;
}

export interface Present {
  label: string;
  role: string;
}

export interface RetireReport {
  terminated: number;
  removed: string[];
  failed: { what: string; why: string }[];
}

export interface PaddockDto {
  id: string;
  name: string;
  role: Role;
  ownerEmail: string;
  /** Null for the owner: every tab is theirs. Otherwise the tabs they may reach. */
  tabs: string[] | null;
  here: Present[];
}

/** Who is in one tab. Invitations name a tab, never the machine. */
export interface TabPeopleDto {
  conversationId: string;
  members: { email: string; addedAt: string }[];
  guests: { handle: string; seenAt: string }[];
  /** The owner only. A link is a credential, so nobody else is shown it. */
  inviteUrl?: string | null;
}

export class PaddockError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const paddock = {
  config: () => call<{ fountainUrl: string; anonymousStart: boolean }>("GET", "/api/config"),
  me: () => call<Me>("GET", "/api/me"),

  /**
   * A computer, for somebody who has nothing.
   *
   * `startKey` is this browser's, kept in `localStorage`, and it is what makes
   * a retry a retry: the server derives the computer's id from it, so a
   * dropped response, a refresh mid-flight or React double-invoking an effect
   * all find the machine that was already started rather than starting a
   * second one on the demo's money.
   */
  start: (startKey: string) => call<Me>("POST", "/api/start", { startKey }),

  /**
   * Sign in — and, from an unclaimed computer, claim it. One call, because it
   * is one decision: the server sees the anonymous session on the way through
   * and attaches this account to the principal the machine already runs on.
   * The answer carries `claimedFrom` when that happened.
   */
  signIn: (apiKey: string) => call<Me>("POST", "/api/auth/session", { apiKey }),
  signOut: () => call<{ ok: true }>("DELETE", "/api/auth/session"),
  join: (token: string) => call<Me>("POST", `/api/join/${encodeURIComponent(token)}`),

  /**
   * The skills.sh index, through this server because skills.sh sends no CORS
   * header and the browser cannot read it directly (`server/skills.ts`).
   *
   * `unavailable` rather than a rejection when the index is down: the Skills
   * editor has a manual form, and search failing must not stop somebody adding
   * an `owner/repo` they already know.
   */
  searchSkills: (q: string) =>
    call<{ data: SkillHit[]; unavailable?: boolean }>("GET", `/api/skills/search?${new URLSearchParams({ q })}`),

  show: () => call<{ data: PaddockDto }>("GET", "/api/paddock").then((r) => r.data),
  showOne: (id: string) => call<{ data: PaddockDto }>("GET", `/api/paddock/${id}`).then((r) => r.data),

  /**
   * Another computer. This makes a row and nothing else — the agent,
   * environment, vault and box are built by `ensureIdentity` the first time
   * the machine is actually opened, so an unvisited computer costs nothing.
   */
  addComputer: (name?: string) => call<{ data: Reachable }>("POST", "/api/paddocks", { name: name ?? "" }).then((r) => r.data),
  renameComputer: (id: string, name: string) => call<{ data: Reachable }>("PATCH", `/api/paddock/${id}`, { name }).then((r) => r.data),
  /** Retire the machine and forget the computer. The account's last one stays. */
  removeComputer: (id: string) => call<{ data: RetireReport }>("DELETE", `/api/paddock/${id}`).then((r) => r.data),

  tabPeople: (id: string, conv: string) => call<{ data: TabPeopleDto }>("GET", `/api/paddock/${id}/tabs/${conv}/people`).then((r) => r.data),
  addMember: (id: string, conv: string, email: string) =>
    call<{ data: TabPeopleDto }>("POST", `/api/paddock/${id}/tabs/${conv}/members`, { email }).then((r) => r.data),
  removeMember: (id: string, conv: string, email: string) =>
    call<{ data: TabPeopleDto }>("DELETE", `/api/paddock/${id}/tabs/${conv}/members/${encodeURIComponent(email)}`).then((r) => r.data),
  mintInvite: (id: string, conv: string) => call<{ data: TabPeopleDto; evicted: number }>("POST", `/api/paddock/${id}/tabs/${conv}/invite`),
  closeInvite: (id: string, conv: string) => call<{ data: TabPeopleDto; evicted: number }>("DELETE", `/api/paddock/${id}/tabs/${conv}/invite`),

  /**
   * A new machine, keeping everything you declared. Fountain cannot delete a
   * sandbox, so this retires the agent — the identity is what decides which
   * box you get, and a retired one means the next sign-in builds a fresh one.
   */
  rebuild: (id: string) => call<{ data: RetireReport }>("POST", `/api/paddock/${id}/rebuild`).then((r) => r.data),
  /** The above, and the environment and vault with every secret in them. */
  reset: (id: string) => call<{ data: RetireReport }>("POST", `/api/paddock/${id}/reset`).then((r) => r.data),

  presence: (id: string, clientId: string) => call<{ data: Present[] }>("POST", `/api/paddock/${id}/presence`, { clientId }).then((r) => r.data),

  /** The paddock's own channel: who is here, tabs opening, turns starting. */
  stream(id: string, opts: { signal: AbortSignal; onMessage: (m: SseMessage) => void; onClose: (err?: unknown) => void }): Promise<void> {
    return readSse(`/api/paddock/${id}/stream`, { signal: opts.signal, onMessage: opts.onMessage, onClose: opts.onClose });
  },
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const obj = (parsed ?? {}) as { error?: unknown; message?: unknown };
    const code = typeof obj.error === "string" ? obj.error : "error";
    const message = typeof obj.message === "string" ? obj.message : code;
    throw new PaddockError(res.status, code, message);
  }
  return parsed as T;
}

/** A human line for a paddock failure, in the app's voice. */
export function describePaddockError(err: unknown): string {
  if (err instanceof PaddockError) {
    switch (err.code) {
      case "invite_revoked":
        return "That invite link was replaced. Ask whoever shared it for a new one.";
      case "bad_invite":
        return "That invite link is not valid any more.";
      case "owner_only":
        return "Only the owner of this machine can change it.";
      case "last_computer":
        return "This is your only computer. Start over instead, which empties it without removing it.";
      case "account_required":
        return "Sign in to add a computer of your own.";
      case "claim_required":
        // The server's message names the thing that was refused, which is more
        // use than a generic sentence about claiming.
        return err.message;
      case "start_unavailable":
        return "This Paddock does not start computers for visitors. Sign in with a Fountain account.";
      case "start_busy":
        return "A lot of people are starting computers right now. Try again in a moment.";
      case "start_budget":
      case "start_at_capacity":
        return `${err.message}`;
      case "start_expired":
        return "That computer's free time is up. Sign in to start a new one.";
      case "already_claimed":
        return "That computer has been claimed. Sign in to open it.";
      case "claimed_by_other":
        return "Somebody else claimed that computer first.";
      case "claim_expired":
        return "That computer's free time ran out before it was claimed.";
      case "bad_key":
        return "Fountain rejected that key.";
      case "unauthenticated":
        return "Sign in, or open an invite link.";
      default:
        return err.message;
    }
  }
  if (err instanceof TypeError) return "Could not reach the Paddock server.";
  return err instanceof Error ? err.message : String(err);
}
