/**
 * The server's configuration, from the environment:
 *
 *   FOUNTAIN_URL    the one Fountain everybody signs in with (identity is the email there)
 *   DATA_DIR        where the SQLite file (and a generated secret, if none is given) live
 *   PADDOCK_SECRET  encrypts stored Fountain keys; generated into DATA_DIR/secret when unset
 *   PORT            listen port (8080)
 *   STATIC_DIR      the built SPA to serve (dist/); unset serves no static files (dev, behind Vite)
 *   PUBLIC_URL      this server as the outside world reaches it; used for invite links
 *
 * Ported from `apps/salon/server/config.ts` minus the GitHub App, which
 * paddock has no use for.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomToken } from "./crypto";

export interface Config {
  fountainUrl: string;
  dataDir: string;
  dbPath: string;
  secret: string;
  port: number;
  staticDir: string | null;
  /** Without a trailing slash; null when unset. */
  publicUrl: string | null;
  sessionMaxAgeMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const fountainUrl = (env.FOUNTAIN_URL ?? "https://managoat.com").trim().replace(/\/+$/, "");
  const dataDir = env.DATA_DIR ?? "./data";
  mkdirSync(dataDir, { recursive: true });

  // A generated secret keeps a fresh deployment working, but it then lives
  // beside the data it protects — which is why the k8s Secret is the right
  // answer and this is only the fallback. Same trade as salon.
  let secret = env.PADDOCK_SECRET?.trim() ?? "";
  if (!secret) {
    const file = join(dataDir, "secret");
    if (existsSync(file)) secret = readFileSync(file, "utf8").trim();
    else {
      secret = randomToken();
      writeFileSync(file, secret, { mode: 0o600 });
    }
  }

  const staticDir = env.STATIC_DIR === undefined ? null : env.STATIC_DIR.trim() || null;
  const publicUrl = env.PUBLIC_URL?.trim().replace(/\/+$/, "") || null;

  return {
    fountainUrl,
    dataDir,
    dbPath: join(dataDir, "paddock.sqlite"),
    secret,
    port: Number(env.PORT ?? 8080),
    staticDir,
    publicUrl,
    sessionMaxAgeMs: 30 * DAY_MS,
  };
}
