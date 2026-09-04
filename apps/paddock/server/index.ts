/** The Paddock server: config, database, cipher, routes, listen. */
import { buildRouter } from "./app";
import { loadConfig } from "./config";
import { Cipher } from "./crypto";
import { Db } from "./db";
import type { AppContext } from "./context";

const config = loadConfig();
const ctx: AppContext = {
  config,
  db: new Db(config.dbPath),
  cipher: await Cipher.from(config.secret),
};

const fetch = buildRouter(ctx);

Bun.serve({ port: config.port, fetch, idleTimeout: 0 });

console.log(`paddock on http://localhost:${config.port} (fountain: ${config.fountainUrl}, data: ${config.dataDir})`);
