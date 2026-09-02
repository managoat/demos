/**
 * "Sign in with GitHub", against our own GitHub App.
 *
 * The browser sends the person to GitHub, GitHub sends them back here with a
 * code, and the code is handed to /gh/callback — which is the only part that
 * needs the client secret, and therefore the only part that cannot happen in a
 * page.
 *
 * The complication worth naming: Rounds already completes a *Fountain* OAuth
 * callback on this same URL, and both arrive as `?code=…&state=…`. So each
 * flow stashes its own state under its own key and only claims a callback
 * whose state it recognizes. Whichever one stashed the state gets the code;
 * the other leaves it alone.
 */

import type { AccessibleRepo } from "./repos";

const STASH = "rounds.github.oauth";

export interface GhLogin {
  token: string;
  login: string;
  /** Seconds until expiry, when the App expires user tokens. */
  expiresIn: number | null;
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** This page, with no query or hash — must match a redirect URI on the App. */
export function redirectUri(): string {
  return window.location.origin + window.location.pathname;
}

/** Send the browser to GitHub. Never returns. */
export function beginGithubLogin(clientId: string): void {
  const state = randomState();
  sessionStorage.setItem(STASH, JSON.stringify({ state, redirectUri: redirectUri() }));
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri(), state });
  window.location.href = `https://github.com/login/oauth/authorize?${q}`;
}

/**
 * True when GitHub has just bounced back from installing the App.
 *
 * This used to be dropped on the floor: `clearParams` stripped
 * `installation_id` and `setup_action` and nothing ever looked at them, so the
 * step between signing in and enrolling had no completion at all — you found
 * out whether the App was installed when a grant request 404'd halfway through
 * an enrollment.
 */
export function isInstallCallback(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get("setup_action") !== null || params.get("installation_id") !== null;
}

/** Consume that callback, leaving the URL clean. */
export function takeInstallCallback(): { installationId: string | null; action: string | null } | null {
  if (!isInstallCallback()) return null;
  const params = new URLSearchParams(window.location.search);
  const out = { installationId: params.get("installation_id"), action: params.get("setup_action") };
  clearParams(["installation_id", "setup_action"]);
  return out;
}

/** True when the URL carries a callback this flow started — and not Fountain's. */
export function isGithubCallback(): boolean {
  const params = new URLSearchParams(window.location.search);
  const state = params.get("state");
  if (!params.get("code") && !params.get("error")) return false;
  const stashed = sessionStorage.getItem(STASH);
  if (!stashed || !state) return false;
  try {
    return (JSON.parse(stashed) as { state?: string }).state === state;
  } catch {
    return false;
  }
}

/**
 * Complete the flow if this page load is our callback. Returns null when it is
 * not — including when it is Fountain's callback, which is left untouched.
 */
export async function completeGithubLoginIfCallback(): Promise<GhLogin | null> {
  if (!isGithubCallback()) return null;
  const params = new URLSearchParams(window.location.search);
  const stashed = sessionStorage.getItem(STASH);
  sessionStorage.removeItem(STASH);
  clearParams(["code", "state", "error", "error_description"]);

  const error = params.get("error");
  if (error) {
    throw new Error(error === "access_denied" ? "GitHub sign-in was declined." : `GitHub sign-in failed: ${error}`);
  }
  const code = params.get("code");
  if (!code || !stashed) return null;
  const { redirectUri: used } = JSON.parse(stashed) as { redirectUri: string };

  const res = await fetch(`/gh/callback?code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(used)}`);
  const body = (await res.json().catch(() => ({}))) as { token?: string; login?: string; expiresIn?: number | null; error?: string };
  if (!res.ok || !body.token || !body.login) {
    throw new Error(body.error ?? "GitHub sign-in could not be completed.");
  }
  return { token: body.token, login: body.login, expiresIn: body.expiresIn ?? null };
}

/**
 * Strip the named parameters without reloading.
 *
 * Each flow clears only its own. GitHub can land a sign-in and an install on
 * the same URL — `?code=…&installation_id=…` — and a clear that took both
 * would delete whichever half had not run yet.
 */
function clearParams(keys: string[]): void {
  const url = new URL(window.location.href);
  for (const k of keys) url.searchParams.delete(k);
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}

export interface AppInfo {
  configured: boolean;
  slug: string | null;
  clientId: string | null;
  installUrl: string | null;
}

export interface Installations {
  installed: boolean;
  installations: Array<{ id: number; account: string; repositorySelection: string }>;
}

/** Where this person has the App installed. The gate between signing in and enrolling. */
export async function fetchInstallations(token: string): Promise<Installations> {
  const res = await fetch("/gh/installations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<Installations> & { error?: string };
  if (!res.ok) throw new Error(body.error ?? "Could not ask GitHub where the App is installed.");
  return { installed: body.installed === true, installations: body.installations ?? [] };
}

/**
 * Which repositories this person could enroll.
 *
 * Answered from their own token against their own installations, so it adds no
 * access — it only means the first enrollment is a choice from a list rather
 * than a slug typed from memory.
 */
export async function fetchRepos(token: string): Promise<AccessibleRepo[]> {
  const res = await fetch("/gh/repos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const body = (await res.json().catch(() => ({}))) as { repos?: AccessibleRepo[]; error?: string };
  if (!res.ok) throw new Error(body.error ?? "Could not ask GitHub which repositories are available.");
  return body.repos ?? [];
}

/** What this deployment's GitHub App is, or a not-configured answer. */
export async function fetchAppInfo(): Promise<AppInfo> {
  try {
    const res = await fetch("/gh/app");
    if (!res.ok) throw new Error(String(res.status));
    return (await res.json()) as AppInfo;
  } catch {
    return { configured: false, slug: null, clientId: null, installUrl: null };
  }
}
