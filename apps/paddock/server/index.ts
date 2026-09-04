/** The Paddock server: config, database, cipher, routes, listen, sweep. */
import { buildRouter } from "./app";
import { loadConfig } from "./config";
import { Cipher } from "./crypto";
import { Db } from "./db";
import { sweepExpired } from "./starter";
import type { AppContext } from "./context";

const config = loadConfig();
const ctx: AppContext = {
  config,
  db: new Db(config.dbPath),
  cipher: await Cipher.from(config.secret),
};

const fetch = buildRouter(ctx);

Bun.serve({ port: config.port, fetch, idleTimeout: 0 });

/**
 * Release the computers nobody claimed.
 *
 * Fountain enforces the lifetime and the budget — a grant stops working on its
 * own — but the principal, its sandbox and its money are only *given back*
 * when somebody asks, and this is the only thing that asks. It runs on a
 * timer, is idempotent, and reads Fountain's own status before it destroys
 * anything, so a sweep racing a claim loses to the claim.
 *
 * Not in the request path, and not a cron: an hour is far inside the shortest
 * lifetime anybody would configure, and a demo with one process should not
 * need a second thing to deploy for its own rubbish to go out.
 */
const SWEEP_MS = 60 * 60 * 1000;

if (config.anonymousStart) {
  const sweep = () =>
    void sweepExpired(ctx)
      .then((r) => {
        if (r.released || r.forgotten || r.stranded || r.failed) console.log("paddock: swept unclaimed computers —", r);
      })
      .catch((err) => console.error("paddock: sweep failed:", err));
  sweep();
  setInterval(sweep, SWEEP_MS).unref();
}

console.log(
  `paddock on http://localhost:${config.port} (fountain: ${config.fountainUrl}, data: ${config.dataDir}` +
    `${config.anonymousStart ? ", visitors may start a computer" : ""})`,
);
