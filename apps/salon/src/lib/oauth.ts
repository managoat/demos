/**
 * "Sign in with Fountain": OAuth 2.0 authorization code + PKCE (S256), public
 * client. The token we get back is a Fountain API key; the app hands it to
 * the Salon server (`POST /api/session`), which is the only place it is kept.
 *
 * Fountain registers this client by id and by exact redirect URI
 * (OAUTH_CLIENTS on the server), so the client_id and redirect must match
 * what is registered there. The redirect is this app's own page.
 */
const CLIENT_ID = "salon";
const STASH = "salon.oauth";

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function base64url(bytes: ArrayBuffer): string {
  let s = "";
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return base64url(a.buffer);
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(digest);
}

/** The redirect URI: this app's page with the hash cleared. Must match a registered `redirect_uris` entry exactly. */
export function redirectUri(): string {
  return window.location.origin + window.location.pathname;
}

export async function beginLogin(baseUrl: string): Promise<void> {
  const verifier = randomString();
  const state = randomString(16);
  const challenge = await challengeFor(verifier);
  const base = normalizeBaseUrl(baseUrl);
  // Where to land afterwards: a join link survives the round trip.
  sessionStorage.setItem(STASH, JSON.stringify({ verifier, state, baseUrl: base, hash: window.location.hash }));
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  window.location.href = `${base}/oauth/authorize?${q}`;
}

export interface CallbackResult {
  baseUrl: string;
  apiKey: string;
  /** The hash the app was on when sign-in began, to go back to. */
  hash: string;
}

/** Complete an OAuth redirect back from Fountain; null when this page load is not one. Throws on a real failure. */
export async function completeLoginIfCallback(): Promise<CallbackResult | null> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const error = params.get("error");
  const state = params.get("state");
  if (!code && !error) return null;

  const stashed = sessionStorage.getItem(STASH);
  sessionStorage.removeItem(STASH);
  clearOAuthParams();

  if (error) throw new Error(error === "access_denied" ? "Sign-in was denied." : `Sign-in failed: ${error}`);
  if (!stashed) throw new Error("Sign-in could not be completed (no pending request in this browser).");

  const { verifier, state: expected, baseUrl, hash } = JSON.parse(stashed) as { verifier: string; state: string; baseUrl: string; hash?: string };
  if (!state || state !== expected) throw new Error("Sign-in state did not match — try again.");

  const res = await fetch(`${baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: CLIENT_ID, redirect_uri: redirectUri() }),
  });
  if (!res.ok) throw new Error("Fountain rejected the sign-in. Try again.");
  const body = (await res.json()) as { access_token: string };
  return { baseUrl, apiKey: body.access_token, hash: hash ?? "" };
}

function clearOAuthParams(): void {
  const url = new URL(window.location.href);
  ["code", "state", "error", "error_description"].forEach((k) => url.searchParams.delete(k));
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}
