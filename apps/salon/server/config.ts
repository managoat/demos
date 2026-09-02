/**
 * The server's configuration, from the environment:
 *
 *   FOUNTAIN_URL   the one Fountain every user signs in with (identity is the email there)
 *   DATA_DIR       where the SQLite file (and a generated secret, if none is given) live
 *   SALON_SECRET   encrypts stored Fountain keys; generated into DATA_DIR/secret when unset
 *   PORT           listen port (8080)
 *   STATIC_DIR     the built SPA to serve (dist/); unset serves no static files (dev, behind Vite)
 *   PUBLIC_URL     where a chat's computer can reach this server (https://salon.demo.managoat.com);
 *                  unset, the model cannot start games — a computer cannot reach localhost
 *   GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_SLUG
 *   GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET
 *                  the GitHub App used to select and access repositories
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomToken } from "./crypto";
import { normalizePrivateKey, type GitHubAppConfig } from "./github";

export interface Config {
  fountainUrl: string;
  dataDir: string;
  dbPath: string;
  secret: string;
  port: number;
  staticDir: string | null;
  /** This server as a chat's computer reaches it, without a trailing slash; null when it cannot. */
  publicUrl: string | null;
  sessionMaxAgeMs: number;
  /** The GitHub App that replaces repository tokens pasted by users. */
  githubApp?: GitHubAppConfig | null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const fountainUrl = (env.FOUNTAIN_URL ?? "https://managoat.com").trim().replace(/\/+$/, "");
  const dataDir = env.DATA_DIR ?? "./data";
  mkdirSync(dataDir, { recursive: true });
  let secret = env.SALON_SECRET?.trim() ?? "";
  if (!secret) {
    const file = join(dataDir, "secret");
    if (existsSync(file)) {
      secret = readFileSync(file, "utf8").trim();
    } else {
      secret = randomToken(32);
      writeFileSync(file, secret + "\n", { mode: 0o600 });
      console.warn(`salon: SALON_SECRET is not set; generated one into ${file}. Set it in the environment to keep it apart from the data.`);
    }
  }
  const appId = env.GITHUB_APP_ID?.trim();
  const privateKey = normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const clientId = (env.GITHUB_OAUTH_CLIENT_ID ?? env.GITHUB_CLIENT_ID)?.trim();
  const clientSecret = (env.GITHUB_OAUTH_CLIENT_SECRET ?? env.GITHUB_CLIENT_SECRET)?.trim();
  const slug = env.GITHUB_APP_SLUG?.trim();
  const githubApp = appId && privateKey && clientId && clientSecret && slug ? { appId, privateKey, clientId, clientSecret, slug } : null;
  if (env.GITHUB_APP_PRIVATE_KEY && !privateKey) console.warn("salon: GITHUB_APP_PRIVATE_KEY is not a PEM private key; GitHub access is disabled.");
  return {
    fountainUrl,
    dataDir,
    dbPath: env.DB_PATH ?? join(dataDir, "salon.sqlite"),
    secret,
    port: Number(env.PORT ?? 8080),
    staticDir: env.STATIC_DIR === "" ? null : (env.STATIC_DIR ?? (existsSync("dist") ? "dist" : null)),
    publicUrl: env.PUBLIC_URL?.trim().replace(/\/+$/, "") || null,
    sessionMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
    githubApp,
  };
}
