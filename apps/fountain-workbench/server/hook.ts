/**
 * `GET /hook/install.sh`: the snapshot hook's installer, served by the server
 * that receives its posts, so there is one copy and it versions with the route
 * it talks to. An environment's setup script is one line:
 *
 *   curl -fsSL https://<workbench>/hook/install.sh | bash
 *
 * What the hook is for is in `server/snapshots.ts`; the script itself is
 * `server/hook.sh`, with the workbench's own origin written in where the
 * script says `__WORKBENCH_URL__`, so a sandbox needs no `WORKBENCH_URL` in
 * its environment (one there still wins, for a dev server behind a tunnel).
 *
 * Two facts about Fountain fix the paths the script writes to, both checked
 * against `apps/fountain/lib/fountain` and proved live on 2026-09-02
 * (`fountain/snapshot-smoke.yml`):
 *
 *   1. Provisioning runs the user's setup script as step 5 and writes runtime
 *      config as step 6 (`Conversations.Provisioning`). For claude that step
 *      writes `~/.claude/settings.json` wholesale, as exactly
 *      `{"enableAllProjectMcpServers": true}`, whenever the agent has an MCP
 *      server (`Runtimes.Claude.write_config/2`). Claude's cwd and HOME are
 *      both `/home/sprite` (`Runtimes.Layout`), so user-scope and
 *      project-scope settings are one file, and a hook written there is gone
 *      before the first turn. `settings.local.json` is the project's local
 *      scope, at the same directory, and Fountain never writes it.
 *
 *   2. `FOUNTAIN_TOKEN` and `FOUNTAIN_CONVERSATION_ID` are spawn env on the
 *      agent's process and deliberately kept out of `/home/sprite/.env`
 *      (`Conversations.Identity`, ADR 0023): a machine may serve several
 *      conversations, and the identity is per process. A hook is a child of
 *      that process and inherits both, as does a git hook run from the
 *      agent's shell. A daemon started by the setup script would have
 *      neither, which is why the hook is a hook and not a watcher.
 *
 * Public and unauthenticated: it is a script anyone could write, and it holds
 * no secret — the URL it posts to is this server's own.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT = readFileSync(fileURLToPath(new URL("./hook.sh", import.meta.url)), "utf8");

/** The origin the sandbox should post back to: what the request came in on, behind a proxy included. */
export function originOf(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(/:$/, "");
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

export function installer(req: Request): Response {
  const body = SCRIPT.replaceAll("__WORKBENCH_URL__", originOf(req));
  return new Response(body, { headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-cache" } });
}
