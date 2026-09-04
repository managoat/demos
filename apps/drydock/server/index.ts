/**
 * Boot.
 *
 * One `Bun.serve` doing three jobs: the JSON API, the built SPA, and the
 * WebSocket the terminal rides on. `idleTimeout: 0` is required rather than
 * tidy — the project stream and the transcript proxy are both long-lived
 * responses that Bun would otherwise cut at the default timeout, and the
 * symptom is a UI that stops updating after a couple of minutes with nothing
 * in any log.
 */
import { buildRouter } from "./app";
import { loadConfig } from "./config";
import { Cipher } from "./crypto";
import { Db } from "./db";
import { buildContext } from "./context";
import { attachTerminal, type TerminalData } from "./terminal";

const config = loadConfig();
const ctx = buildContext({ config, db: new Db(config.dbPath), cipher: await Cipher.from(config.secret) });
const route = buildRouter(ctx);

const server = Bun.serve<TerminalData, never>({
  port: config.port,
  idleTimeout: 0,
  fetch: (req, srv) => route(req, srv),
  websocket: attachTerminal(() => ctx.sprites),
});

// What is switched on, said once at boot rather than discovered by a person
// clicking a button that turns out to do nothing. Each `off` here has a
// designed empty state behind it — see `Capabilities` in `shared/api.ts`.
console.log(
  [
    `drydock on http://localhost:${server.port}`,
    `fountain: ${config.fountainKey ? config.fountainUrl : "OFF (no FOUNTAIN_API_KEY — no machines)"}`,
    `github: ${config.github ? `app ${config.github.appId}` : "OFF (no GitHub App — no repositories)"}`,
    `exec: ${config.sprites ? config.sprites.baseUrl : "OFF (no SPRITES_TOKEN — no terminal)"}`,
    `data: ${config.dataDir}`,
  ].join("\n  "),
);
