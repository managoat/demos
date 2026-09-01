/**
 * Connectors: the host's Fountain connections, as the menu shows them and as
 * an agent uses them.
 *
 * A connection is an account the host signed in to once on Fountain (Google,
 * Slack, a remote MCP server…); Fountain holds the token and the chat's
 * computer never sees it. Which connections Salon can put to use:
 *
 *   - Google → Fountain's own Gmail server: `{ gmail: { connection: id } }`.
 *   - A tenant `mcp` provider (Linear, Notion, …) → a remote server with the
 *     connection's bearer: `{ linear: { type: "http", url, connection: id } }`.
 *
 * Microsoft, Slack and a tenant's own `oauth2` app hand the computer a
 * brokered env var and no server to speak through, so an agent would have to
 * bring its own client. Those show in the menu as not usable here yet rather
 * than as a toggle that does nothing.
 */
import type { Catalog, Connection, ConnectionProvider } from "./fountain";
import { HttpError } from "./http";

export interface ConnectorDto {
  id: string;
  /** "Gmail", "Linear", "Slack" … */
  label: string;
  /** "jake@example.com", or null when the provider reports no account. */
  account: string | null;
  /** True when a chat can actually use it. */
  usable: boolean;
  /** Why not, when it cannot. */
  why: string | null;
}

/** A chosen connector on a chat row and in the header: "Gmail". */
export interface ChosenConnector {
  id: string;
  label: string;
}

interface Resolved {
  dto: ConnectorDto;
  /** The `mcp_servers` entry, keyed by server name, when usable. */
  server: { name: string; entry: Record<string, unknown> } | null;
}

export function resolveConnectors(connections: Connection[], providers: ConnectionProvider[], catalog: Catalog | null): Resolved[] {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const bySlug = new Map(providers.map((p) => [p.slug, p]));
  const known = new Map((catalog?.mcp_servers ?? []).map((s) => [s.url, s]));
  return connections
    .filter((c) => c.status === "active")
    .map((c) => {
      const provider = (c.provider_id && byId.get(c.provider_id)) || bySlug.get(c.provider) || null;
      const account = c.account_email && c.account_email !== c.provider ? c.account_email : null;
      if (c.provider === "google") {
        return { dto: { id: c.id, label: "Gmail", account, usable: true, why: null }, server: { name: "gmail", entry: { connection: c.id } } };
      }
      if (provider?.kind === "mcp" && provider.mcp_url) {
        const listed = known.get(provider.mcp_url);
        const name = serverName(listed?.slug ?? provider.slug);
        const label = listed?.name ?? friendly(provider.name);
        return { dto: { id: c.id, label, account, usable: true, why: null }, server: { name, entry: { type: "http", url: provider.mcp_url, connection: c.id } } };
      }
      const label = c.provider === "microsoft" ? "Outlook" : c.provider === "slack" ? "Slack" : friendly(provider?.name ?? c.provider);
      return { dto: { id: c.id, label, account, usable: false, why: "Not usable in a Salon chat yet" }, server: null };
    });
}

/**
 * What the chosen connector ids add to an agent: its `mcp_servers`, and the
 * names for the header and the agent's name. A connector the host no longer
 * has is a 404; one Salon cannot use is a 422 — both before Fountain is asked.
 */
export function attach(connectorIds: readonly string[], resolved: Resolved[]): { mcpServers: Record<string, unknown>; chosen: ChosenConnector[] } {
  const mcpServers: Record<string, unknown> = {};
  const chosen: ChosenConnector[] = [];
  for (const id of connectorIds) {
    const r = resolved.find((x) => x.dto.id === id);
    if (!r) throw new HttpError(404, "connector_not_found", "That connection is not on your Fountain any more.");
    if (!r.server) throw new HttpError(422, "connector_unusable", `${r.dto.label} cannot be used in a Salon chat yet.`);
    mcpServers[r.server.name] = r.server.entry;
    chosen.push({ id, label: r.dto.label });
  }
  return { mcpServers, chosen };
}

/** A safe MCP server name from a slug: "mcp-linear-app" stays, "Weird Slug!" does not. */
function serverName(slug: string): string {
  const s = slug.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "server";
}

/** "mcp-linear-app" → "Linear App"; "Google (Gmail, Calendar)" → "Google". */
function friendly(name: string): string {
  const base = name.replace(/\s*\(.*\)\s*$/, "").trim();
  const words = base
    .replace(/^mcp[-_ ]/i, "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (/^[a-z]/.test(w) ? w[0]!.toUpperCase() + w.slice(1) : w));
  return words.join(" ") || name;
}
