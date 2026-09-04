/**
 * Paddock's own routes — the ones that are not Fountain.
 *
 * Who the session is, who is in the machine, the invite link, and presence.
 * Same origin, cookie-authenticated, no key anywhere near the browser.
 */
import { readSse, type SseMessage } from "../lib/sse";

export type Role = "owner" | "member" | "guest";

export interface Me {
  label: string;
  kind: "user" | "guest";
  email: string | null;
  role: Role | null;
  paddockId: string | null;
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
  config: () => call<{ fountainUrl: string }>("GET", "/api/config"),
  me: () => call<Me>("GET", "/api/me"),
  signIn: (apiKey: string) => call<Me>("POST", "/api/auth/session", { apiKey }),
  signOut: () => call<{ ok: true }>("DELETE", "/api/auth/session"),
  join: (token: string) => call<Me>("POST", `/api/join/${encodeURIComponent(token)}`),

  show: () => call<{ data: PaddockDto }>("GET", "/api/paddock").then((r) => r.data),
  claim: () => call<{ data: PaddockDto }>("POST", "/api/paddock").then((r) => r.data),

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
      case "no_paddock":
        return "You have no machine here yet.";
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
