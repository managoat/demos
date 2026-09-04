/**
 * Getting rid of a machine — the one thing Fountain will not do for you.
 *
 * There is no `DELETE /api/sandboxes/:id`. Sandboxes are read-only over the
 * API; Fountain's own message about the concurrent limit says how they are
 * freed — "terminate a conversation before starting another". And a
 * *persistent* sandbox is the agent identity's home, kept when a conversation
 * ends, so ending every tab does not get you a different machine. It gets you
 * the same machine with nothing running on it.
 *
 * So the only reliable way to a new box is a new identity. Sandbox identity is
 * `(user, agent, environment, vault)`; retiring the **agent** changes it while
 * leaving the environment and vault — and therefore every repository, package
 * and secret — exactly where they were. That is the difference between the two
 * operations here:
 *
 *   rebuild   terminate the tabs, retire the agent. Same settings, new box.
 *   reset     the above, and delete the environment and vault too. Every
 *             secret goes with them. Back to a person who has never been here.
 *
 * Both are owner-only and both run here rather than in the browser, because
 * they are a sequence: a half-done one leaves an account with a machine it
 * cannot reach or an identity pointing at nothing. The report says what
 * actually happened, including what would not go.
 */
import { ownerClient, paddockAccess, requireOwner, type AppContext } from "./context";
import type { ConversationSummary, FountainClient } from "./fountain";
import { asHttpError } from "./fountain";
import { authenticate } from "./context";
import { hub } from "./hub";
import { HttpError, json } from "./http";
import { belongsTo } from "../shared/tabs";
import type { PaddockRow } from "./db";

export interface RetireReport {
  /** Conversations ended. */
  terminated: number;
  /** What was removed from Fountain, in the order it went. */
  removed: string[];
  /** What would not go, and why. Not fatal: the identity is already changed. */
  failed: { what: string; why: string }[];
}

export async function rebuild(ctx: AppContext, req: Request, paddockId: string): Promise<Response> {
  const id = await authenticate(ctx, req);
  const access = paddockAccess(ctx, id, paddockId);
  requireOwner(access.role);
  return json({ data: await retire(ctx, access.paddock, access.original, { settings: false }) });
}

export async function reset(ctx: AppContext, req: Request, paddockId: string): Promise<Response> {
  const id = await authenticate(ctx, req);
  const access = paddockAccess(ctx, id, paddockId);
  requireOwner(access.role);
  return json({ data: await retire(ctx, access.paddock, access.original, { settings: true }) });
}

/**
 * Take one computer apart. Owner-only, and the caller checks that — this is
 * also what `computers.remove` runs before forgetting the row.
 */
export async function retire(ctx: AppContext, paddock: PaddockRow, original: boolean, opts: { settings: boolean }): Promise<RetireReport> {
  const client = await ownerClient(ctx, paddock);

  let all: ConversationSummary[];
  try {
    all = await client.listConversations();
  } catch (err) {
    throw asHttpError(err, "find this machine");
  }
  // This computer's conversations, not every paddock conversation on the
  // account. An owner with two machines who rebuilds one must not have the
  // other's tabs terminated and its agent deleted underneath them.
  const mine = all.filter((c) => belongsTo(c.channel_id, paddock.id, original));
  const live = mine.filter((c) => ["pending", "idle", "running"].includes(c.status ?? ""));

  const report: RetireReport = { terminated: 0, removed: [], failed: [] };

  // Read the identity before dismantling it. The agent is the record that
  // actually names this machine's environment and vault; the conversations
  // usually echo them, but a conversation that did not would make a reset
  // quietly skip the very things it exists to delete.
  const agentId = mine.find((c) => c.agent_id)?.agent_id ?? null;
  const agent = agentId ? await agentRecord(client, agentId) : null;
  const environmentId = agent?.environment_id ?? mine.find((c) => c.environment_id)?.environment_id ?? null;
  const vaultId = agent?.vault_id ?? mine.find((c) => c.vault_id)?.vault_id ?? null;

  // Tabs first. An agent with a conversation still on it is an agent Fountain
  // may refuse to delete, and a machine still holding a turn is one nobody
  // should be pulling out from under.
  for (const c of live) {
    const res = await client.raw("POST", `/api/conversations/${encodeURIComponent(c.id)}/terminate`, { body: "{}", accept: "application/json" }).catch(() => null);
    if (res?.ok) report.terminated += 1;
    else report.failed.push({ what: `tab ${c.title ?? c.id}`, why: await reason(res) });
  }

  // The agent is what actually changes the identity, so it is the one removal
  // that has to work. Deleting is the tidy version; un-marking is the version
  // that works even when Fountain will not delete, and `ensureIdentity` looks
  // for the marker rather than the name, so an un-marked agent is retired as
  // far as paddock is concerned.
  if (agentId) {
    const deleted = await client.raw("DELETE", `/api/agents/${encodeURIComponent(agentId)}`, { accept: "application/json" }).catch(() => null);
    if (deleted?.ok) {
      report.removed.push("agent");
    } else {
      const unmarked = await client
        .raw("PUT", `/api/agents/${encodeURIComponent(agentId)}`, { body: JSON.stringify({ metadata: {} }), accept: "application/json" })
        .catch(() => null);
      if (unmarked?.ok) report.removed.push("agent (retired, not deleted)");
      else {
        // Nothing else is worth attempting: without this the next sign-in
        // finds the same identity and the same machine, and a "rebuild" that
        // quietly did nothing is worse than one that says it failed.
        throw new HttpError(502, "retire_failed", `Could not retire this machine's agent: ${await reason(deleted)}`);
      }
    }
  }

  if (opts.settings) {
    // Secrets are not deleted one by one: they live in these two records and
    // go when the records do. Anything that will not go is reported rather
    // than retried, because by now the identity has already changed and the
    // machine is gone either way.
    const targets: [string, string | null][] = [
      ["environment", environmentId ? `/api/environments/${encodeURIComponent(environmentId)}` : null],
      ["vault", vaultId ? `/api/vaults/${encodeURIComponent(vaultId)}` : null],
    ];
    for (const [what, path] of targets) {
      if (!path) continue;
      const res = await client.raw("DELETE", path, { accept: "application/json" }).catch(() => null);
      if (res?.ok) report.removed.push(what);
      else report.failed.push({ what, why: await reason(res) });
    }
  }

  // Everyone else in the paddock is looking at a machine that no longer
  // exists. Guests came in on a link to *this* box, so a reset takes the link
  // with it; a rebuild leaves them in place for the machine that replaces it.
  if (opts.settings) {
    // Every tab is gone, so every link into every tab is gone with it.
    ctx.db.revokeAllGuests(paddock.id);
  }
  hub.publish(paddock.id, "tabs", { retired: true });

  return report;
}

/** The agent, or null if it cannot be read — in which case the fallbacks stand. */
async function agentRecord(client: FountainClient, agentId: string): Promise<{ environment_id?: string | null; vault_id?: string | null } | null> {
  try {
    const res = await client.raw("GET", `/api/agents/${encodeURIComponent(agentId)}`, { accept: "application/json" });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { environment_id?: string | null; vault_id?: string | null } };
    return body.data ?? null;
  } catch {
    return null;
  }
}

/** Whatever Fountain said, in one short line. */
async function reason(res: Response | null): Promise<string> {
  if (!res) return "could not reach Fountain";
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
  } catch {
    /* not JSON */
  }
  return `HTTP ${res.status}`;
}
