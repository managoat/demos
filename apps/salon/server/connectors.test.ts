import { describe, expect, test } from "bun:test";
import { attach, resolveConnectors } from "./connectors";
import type { Catalog, Connection, ConnectionProvider } from "./fountain";
import { HttpError } from "./http";

// Shaped from one real GET /api/connections, /api/connection-providers and /api/catalog on 2026-09-01.
const CONNECTIONS: Connection[] = [
  { id: "c-google", provider: "google", provider_id: null, account_email: "jake@example.com", status: "active" },
  { id: "c-linear", provider: "mcp-linear-app", provider_id: "p-linear", account_email: "mcp-linear-app", status: "active" },
  { id: "c-slack", provider: "slack", provider_id: null, account_email: "jhgaylor", status: "active" },
  { id: "c-ms", provider: "microsoft", provider_id: null, account_email: "jake@example.com", status: "active" },
  { id: "c-gone", provider: "google", provider_id: null, account_email: "old@example.com", status: "revoked" },
  { id: "c-mystery", provider: "mcp-thing", provider_id: "p-thing", account_email: null, status: "active" },
];
const PROVIDERS: ConnectionProvider[] = [
  { id: "google", slug: "google", name: "Google (Gmail, Calendar)", kind: "oauth2", platform: true, mcp_url: null },
  { id: "slack", slug: "slack", name: "Slack", kind: "oauth2", platform: true, mcp_url: null },
  { id: "microsoft", slug: "microsoft", name: "Microsoft (Outlook, Calendar, Teams)", kind: "oauth2", platform: true, mcp_url: null },
  { id: "p-linear", slug: "mcp-linear-app", name: "mcp-linear-app", kind: "mcp", platform: false, mcp_url: "https://mcp.linear.app/mcp" },
  { id: "p-thing", slug: "mcp-thing", name: "mcp-thing", kind: "mcp", platform: false, mcp_url: "https://mcp.thing.example/mcp" },
];
const CATALOG: Catalog = { runtimes: [], models: {}, mcp_servers: [{ name: "Linear", url: "https://mcp.linear.app/mcp", slug: "linear" }] };

describe("connectors", () => {
  const resolved = resolveConnectors(CONNECTIONS, PROVIDERS, CATALOG);

  test("the menu shows active connections with a plain label, and says which cannot be used", () => {
    expect(resolved.map((r) => r.dto)).toEqual([
      { id: "c-google", label: "Gmail", account: "jake@example.com", usable: true, why: null },
      { id: "c-linear", label: "Linear", account: null, usable: true, why: null },
      { id: "c-slack", label: "Slack", account: "jhgaylor", usable: false, why: "Not usable in a Salon chat yet" },
      { id: "c-ms", label: "Outlook", account: "jake@example.com", usable: false, why: "Not usable in a Salon chat yet" },
      { id: "c-mystery", label: "Thing", account: null, usable: true, why: null },
    ]);
  });

  test("google becomes Fountain's gmail server; an mcp provider becomes a remote server on the connection", () => {
    const { mcpServers, chosen } = attach(["c-linear", "c-google", "c-mystery"], resolved);
    expect(mcpServers).toEqual({
      gmail: { connection: "c-google" },
      linear: { type: "http", url: "https://mcp.linear.app/mcp", connection: "c-linear" },
      "mcp-thing": { type: "http", url: "https://mcp.thing.example/mcp", connection: "c-mystery" },
    });
    expect(chosen).toEqual([
      { id: "c-linear", label: "Linear" },
      { id: "c-google", label: "Gmail" },
      { id: "c-mystery", label: "Thing" },
    ]);
  });

  test("a connection that is gone is 404, one Salon cannot use is 422", () => {
    expect(() => attach(["c-gone"], resolved)).toThrow(HttpError);
    try {
      attach(["c-gone"], resolved);
    } catch (e) {
      expect((e as HttpError).status).toBe(404);
      expect((e as HttpError).code).toBe("connector_not_found");
    }
    try {
      attach(["c-slack"], resolved);
    } catch (e) {
      expect((e as HttpError).status).toBe(422);
      expect((e as HttpError).code).toBe("connector_unusable");
    }
  });

  test("nothing chosen attaches nothing", () => {
    expect(attach([], resolved)).toEqual({ mcpServers: {}, chosen: [] });
  });
});
