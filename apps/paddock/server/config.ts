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
 * And the ones that let a visitor start a computer before they have an account
 * (issue #14). All four are inert unless the first two are set, which is the
 * feature flag: a deployment that has not been given an application credential
 * cannot open a claimable principal, so it shows the sign-in screen exactly as
 * it does today.
 *
 *   ANONYMOUS_START      "1"/"true" to offer it at all
 *   FOUNTAIN_APP_KEY     this application's own Fountain key, full scope. It
 *                        opens, reads and releases claimable principals, and it
 *                        pays for what they spend. Never leaves this server.
 *   ANONYMOUS_TTL_SECONDS  how long an unclaimed computer lives (a day)
 *   ANONYMOUS_BUDGET_USD   what its introductory grant is worth (one dollar)
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
  /**
   * Whether a visitor with no account may start a computer.
   *
   * True only when the flag is on *and* there is an application key to open a
   * claimable principal with. The two are one setting on purpose: a flag
   * without a credential would turn every first visit into a 500, and a
   * credential without a flag is how the feature ships dark.
   */
  anonymousStart: boolean;
  /** The application's own Fountain key. Full scope, and never sent anywhere but Fountain. */
  fountainAppKey: string | null;
  /** How long an unclaimed computer lives before Fountain expires the grant. */
  anonymousTtlSeconds: number;
  /** What the introductory grant on one unclaimed computer is worth. */
  anonymousBudgetUsd: number;
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

  const fountainAppKey = env.FOUNTAIN_APP_KEY?.trim() || null;
  const flagged = /^(1|true|yes|on)$/i.test(env.ANONYMOUS_START?.trim() ?? "");

  return {
    fountainUrl,
    dataDir,
    dbPath: join(dataDir, "paddock.sqlite"),
    secret,
    port: Number(env.PORT ?? 8080),
    staticDir,
    publicUrl,
    sessionMaxAgeMs: 30 * DAY_MS,
    anonymousStart: flagged && !!fountainAppKey,
    fountainAppKey,
    anonymousTtlSeconds: positive(env.ANONYMOUS_TTL_SECONDS, 24 * 60 * 60),
    anonymousBudgetUsd: positive(env.ANONYMOUS_BUDGET_USD, 1),
  };
}

/** A number from the environment, or the default when it is missing or silly. */
function positive(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
