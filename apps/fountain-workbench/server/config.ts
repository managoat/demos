/**
 * The server's configuration, from the environment:
 *
 *   FOUNTAIN_URL       the one Fountain every user signs in with (identity is the email there)
 *   DATA_DIR           where the SQLite file (and a generated secret, if none is given) live
 *   WORKBENCH_SECRET   encrypts stored Fountain keys; generated into DATA_DIR/secret when unset
 *   PORT               listen port (8080)
 *   STATIC_DIR         the built SPA to serve (dist/); unset serves no static files (dev, behind Vite)
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
  /** How long a session lives without being used. */
  sessionMaxAgeMs: number;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const fountainUrl = (env.FOUNTAIN_URL ?? "https://fountain.inevitable.fyi").trim().replace(/\/+$/, "");
  const dataDir = env.DATA_DIR ?? "./data";
  mkdirSync(dataDir, { recursive: true });
  let secret = env.WORKBENCH_SECRET?.trim() ?? "";
  if (!secret) {
    const file = join(dataDir, "secret");
    if (existsSync(file)) {
      secret = readFileSync(file, "utf8").trim();
    } else {
      secret = randomToken(32);
      writeFileSync(file, secret + "\n", { mode: 0o600 });
      console.warn(`workbench: WORKBENCH_SECRET is not set; generated one into ${file}. Set it in the environment to keep it apart from the data.`);
    }
  }
  return {
    fountainUrl,
    dataDir,
    dbPath: env.DB_PATH ?? join(dataDir, "workbench.sqlite"),
    secret,
    port: Number(env.PORT ?? 8080),
    staticDir: env.STATIC_DIR === "" ? null : (env.STATIC_DIR ?? (existsSync("dist") ? "dist" : null)),
    sessionMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
  };
}
