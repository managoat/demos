#!/usr/bin/env node
/**
 * Mint a GitHub App installation token for one repository.
 *
 *   gh-app-token owner/repo   →   prints a token on stdout, nothing else
 *
 * Reads GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY from the environment (the
 * Rounds toolkit environment, or a repo's vault). Deterministic on purpose:
 * an agent should not be hand-rolling JWT signing every round, and a token
 * mint that fails should fail loudly with a reason rather than silently
 * producing something unusable.
 *
 * Tokens last an hour, which is longer than any round.
 */
import crypto from "node:crypto";

const b64url = (input) => Buffer.from(input).toString("base64url");

function die(message) {
  process.stderr.write(`gh-app-token: ${message}\n`);
  process.exit(1);
}

/** A signed app JWT, valid for ten minutes — GitHub's maximum. */
export function appJwt(appId, privateKey, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat is backdated a minute to survive clock skew between us and GitHub.
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const signature = crypto.createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * A private key pasted through a web form often arrives with literal "\n"
 * instead of newlines. That produces an unhelpful OpenSSL error deep in the
 * signing call, so normalise it here where the message can be clear.
 */
export function normalizeKey(raw) {
  if (!raw) return null;
  const key = raw.includes("\\n") && !raw.includes("\n") ? raw.replace(/\\n/g, "\n") : raw;
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key) ? key.trim() + "\n" : null;
}

async function gh(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "rounds-gh-app-token",
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 300);
    try {
      detail = JSON.parse(body).message ?? detail;
    } catch {
      // keep the raw body
    }
    throw new Error(`${init.method ?? "GET"} ${url} → ${res.status}: ${detail}`);
  }
  return body ? JSON.parse(body) : null;
}

export async function installationToken(slug, { appId, privateKey, api = "https://api.github.com" }) {
  const jwt = appJwt(appId, privateKey);
  // Which installation covers this repo? 404 here means the App is not
  // installed on it — the single most common failure, so name it plainly.
  let installation;
  try {
    installation = await gh(`${api}/repos/${slug}/installation`, jwt);
  } catch (err) {
    if (String(err).includes("→ 404")) {
      throw new Error(`the GitHub App is not installed on ${slug} (or cannot see it)`);
    }
    throw err;
  }
  const token = await gh(`${api}/app/installations/${installation.id}/access_tokens`, jwt, { method: "POST" });
  if (!token?.token) throw new Error("GitHub returned no token");
  return token.token;
}

// Run as a CLI only when invoked directly, so the functions above stay testable.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=\/)/, ""))) {
  const slug = process.argv[2];
  if (!slug || !/^[^/]+\/[^/]+$/.test(slug)) die("usage: gh-app-token <owner>/<repo>");
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = normalizeKey(process.env.GITHUB_APP_PRIVATE_KEY);
  if (!appId) die("GITHUB_APP_ID is not set");
  if (!privateKey) die("GITHUB_APP_PRIVATE_KEY is not set, or is not a PEM private key");
  try {
    process.stdout.write((await installationToken(slug, { appId, privateKey })) + "\n");
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}
