/**
 * What the composer's menus are made of, on the caller's own key: the model
 * catalog for the pill. Nothing here is a chat yet; that is why it is not
 * behind `/f`.
 *
 * Deliberately thin. The caller's agents are not sent — Salon derives its
 * own (server/agents.ts).
 */
import { authenticate, userClient, type AppContext } from "./context";
import { FountainHttpError } from "./fountain";
import { HttpError, json } from "./http";

export interface MenuDto {
  /** The catalog's suggestions, every provider, in the catalog's order. */
  models: string[];
}

export async function show(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const client = await userClient(ctx, user);
  try {
    const catalog = await client.catalog();
    const models = [...new Set(["claude", "codex", "gemini"].flatMap((rt) => catalog.models?.[rt] ?? []))];
    const dto: MenuDto = { models };
    return json({ data: dto });
  } catch (err) {
    if (err instanceof FountainHttpError) throw err.toHttp("Fountain would not list your models. Is your key still valid? Sign in again to refresh it.");
    throw new HttpError(502, "fountain_unreachable", `Could not reach ${ctx.config.fountainUrl}.`);
  }
}
