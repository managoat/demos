/**
 * What the composer's menus are made of, on the caller's own key: the model
 * catalog for the pill, and the caller's Fountain connections for the
 * Connectors submenu. Nothing here is a chat yet; that is why it is not
 * behind `/f`.
 *
 * Deliberately thin. The caller's agents are not sent — Salon derives its
 * own (server/agents.ts) — and a connection is an id, a label and an
 * account, never a token or a server config.
 */
import { authenticate, userClient, type AppContext } from "./context";
import { resolveConnectors, type ConnectorDto } from "./connectors";
import { FountainHttpError } from "./fountain";
import { HttpError, json } from "./http";

export interface MenuDto {
  /** The catalog's suggestions, every provider, in the catalog's order. */
  models: string[];
  connectors: {
    /** False for an account the egress broker is not on for: Fountain has no Connections page there. */
    enabled: boolean;
    items: ConnectorDto[];
    /** Where to connect another account — Fountain's Connections page. */
    connectUrl: string;
  };
}

export async function show(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const client = await userClient(ctx, user);
  try {
    const [catalog, held] = await Promise.all([client.catalog(), client.connections()]);
    const models = [...new Set(["claude", "codex", "gemini"].flatMap((rt) => catalog.models?.[rt] ?? []))];
    const dto: MenuDto = {
      models,
      connectors: {
        enabled: held !== null,
        items: held ? resolveConnectors(held.connections, held.providers, catalog).map((r) => r.dto) : [],
        connectUrl: `${ctx.config.fountainUrl}/account/connections`,
      },
    };
    return json({ data: dto });
  } catch (err) {
    if (err instanceof FountainHttpError) throw err.toHttp("Fountain would not list your models and connections. Is your key still valid? Sign in again to refresh it.");
    throw new HttpError(502, "fountain_unreachable", `Could not reach ${ctx.config.fountainUrl}.`);
  }
}
