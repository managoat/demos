/**
 * The signed-in person's own GitHub token, kept in this browser only.
 *
 * It comes from "Sign in with GitHub" and it never leaves this browser except
 * to ask our own server for a grant — which it can only get for a repository
 * the person can already push to. Nothing unattended ever holds it: the agents
 * carry grants, and grants are not GitHub credentials.
 */

const KEY = "rounds.github";

export interface GhAuth {
  token: string;
  login: string;
  avatarUrl?: string;
}

export function loadGhAuth(): GhAuth | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<GhAuth>;
    if (typeof parsed.token !== "string" || typeof parsed.login !== "string") return null;
    const auth: GhAuth = { token: parsed.token, login: parsed.login };
    if (typeof parsed.avatarUrl === "string") auth.avatarUrl = parsed.avatarUrl;
    return auth;
  } catch {
    return null;
  }
}

export function saveGhAuth(auth: GhAuth): void {
  localStorage.setItem(KEY, JSON.stringify(auth));
}

export function clearGhAuth(): void {
  localStorage.removeItem(KEY);
}
