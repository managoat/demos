/**
 * What the composer's menus are made of, on the caller's own key: their
 * agents (as presets — a prompt, skills and servers to start from), their
 * environments (a computer), their vaults (secrets), and Fountain's model
 * catalog. Nothing here is a chat yet; that is why it is not behind `/f`.
 *
 * Agents Salon made for itself (server/agents.ts) carry `metadata.salon` and
 * are left out: they are the *result* of a pick, not something to pick.
 * The shape is deliberately thin — name, runtime, model, its computer — so
 * a system prompt or an MCP header never reaches a browser for a menu that
 * shows names.
 */
import { authenticate, userClient, type AppContext } from "./context";
import { FountainHttpError, type AgentSummary } from "./fountain";
import { HttpError, json } from "./http";

export interface PresetDto {
  id: string;
  name: string;
  description: string;
  runtime: string;
  model: string;
  environmentId: string | null;
  hasAvatar: boolean;
}

export function isSalonAgent(a: AgentSummary): boolean {
  const meta = a.metadata;
  return !!meta && typeof meta === "object" && "salon" in meta;
}

export function presetOf(a: AgentSummary): PresetDto {
  return {
    id: a.id,
    name: a.name,
    description: typeof a.description === "string" ? a.description : "",
    runtime: a.runtime,
    model: a.model,
    environmentId: a.environment_id ?? null,
    hasAvatar: !!a.avatar_media_type,
  };
}

export async function show(ctx: AppContext, req: Request): Promise<Response> {
  const user = await authenticate(ctx, req);
  const client = await userClient(ctx, user);
  try {
    const [agents, environments, vaults, catalog] = await Promise.all([client.agents(), client.environments(), client.vaults(), client.catalog()]);
    return json({
      data: {
        agents: agents.filter((a) => !isSalonAgent(a)).map(presetOf),
        environments: environments.map(named),
        vaults: vaults.map(named),
        catalog: { runtimes: catalog.runtimes ?? [], models: catalog.models ?? {} },
      },
    });
  } catch (err) {
    if (err instanceof FountainHttpError) throw err.toHttp("Fountain would not list your agents, environments and vaults. Is your key still valid? Sign in again to refresh it.");
    throw new HttpError(502, "fountain_unreachable", `Could not reach ${ctx.config.fountainUrl}.`);
  }
}

function named(x: Record<string, unknown>): { id: string; name: string } {
  return { id: String(x.id ?? ""), name: typeof x.name === "string" ? x.name : String(x.id ?? "") };
}
