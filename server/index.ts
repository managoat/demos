/** The Salon server: its own API, the chat-scoped Fountain proxy, and the built SPA. `bun run server`. */
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { Cipher } from "./crypto";
import { Db } from "./db";

const config = loadConfig();
const db = new Db(config.dbPath);
const cipher = await Cipher.from(config.secret);
const app = buildApp({ db, cipher, config });

const server = Bun.serve({
  port: config.port,
  // Streams stay open as long as Fountain keeps them (60 s idle, heartbeats every 15 s).
  idleTimeout: 120,
  fetch: app,
});

console.log(`salon: listening on http://localhost:${server.port} · Fountain ${config.fountainUrl} · data ${config.dbPath}${config.staticDir ? ` · serving ${config.staticDir}` : ""}`);
