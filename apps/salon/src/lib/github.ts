/** GitHub App user authorization, alongside (but distinct from) Fountain sign-in. */
const STASH = "salon.github.oauth";

function redirectUri(): string {
  return `${window.location.origin}/`;
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function beginGitHubConnect(clientId: string): void {
  const state = randomState();
  sessionStorage.setItem(STASH, JSON.stringify({ state, hash: window.location.hash }));
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri(), state });
  window.location.href = `https://github.com/login/oauth/authorize?${query}`;
}

/** Complete only our own callback; a Fountain callback is left for oauth.ts. */
export async function completeGitHubConnectIfCallback(): Promise<string | null> {
  const params = new URLSearchParams(window.location.search);
  const stashed = sessionStorage.getItem(STASH);
  if (!stashed || (!params.has("code") && !params.has("error"))) return null;
  sessionStorage.removeItem(STASH);
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");
  const saved = JSON.parse(stashed) as { state: string; hash?: string };
  clearParams();
  if (saved.hash) window.location.hash = saved.hash;
  if (error) throw new Error(error === "access_denied" ? "GitHub connection was denied." : `GitHub connection failed: ${error}`);
  if (!code || state !== saved.state) throw new Error("GitHub connection state did not match. Try again.");
  const res = await fetch("/api/github/callback", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ code, redirectUri: redirectUri() }),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: { login?: string }; message?: string };
  if (!res.ok || !body.data?.login) throw new Error(body.message ?? "GitHub would not connect. Try again.");
  return body.data.login;
}

function clearParams(): void {
  const url = new URL(window.location.href);
  ["code", "state", "error", "error_description", "iss", "installation_id", "setup_action"].forEach((key) => url.searchParams.delete(key));
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}
