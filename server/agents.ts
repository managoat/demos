/**
 * Fountain runs an *agent*; Salon offers *settings*. This is the seam.
 *
 * A chat's settings are a model, some skills and some connectors
 * (shared/settings.ts). For each distinct combination one agent is derived,
 * named `Salon · Opus 5 · gmail, pdf`, and found again on the next chat by
 * `metadata.salon.key` — a hash of the whole tuple (`derivedKey`) — so the
 * host's agent list does not grow by one per chat. The agent gets:
 *
 *   - the runtime the model's provider implies (anthropic → claude, …);
 *   - a system prompt written for a chat room, plus the note about the
 *     `[from someone]` tags (shared/author.ts);
 *   - the chosen skills as skills.sh installs, and the chosen connectors as
 *     `mcp_servers` (server/connectors.ts);
 *   - Salon itself as an MCP server (`salon`, server/mcp.ts) so the model can
 *     start a game — on the claude runtime, which is the one that writes an
 *     `http` server with headers into its config, and only when this server
 *     has a public address for the computer to reach;
 *   - no environment: the computer is Fountain's default.
 *
 * The games server is not part of the key: an agent found without it is
 * given it in place, so a pick made before games existed keeps its agent.
 *
 * The menu (server/menu.ts) never lists these agents; they are the result of
 * a pick, not something to pick.
 */
import { modelLabel, runtimeFor } from "../shared/models";
import { canonical, derivedKey, type ChatSettings } from "../shared/settings";
import { skillById, skillEntry } from "../shared/skills";
import { attach, resolveConnectors, type ChosenConnector } from "./connectors";
import type { AgentSummary, FountainClient } from "./fountain";

export const ROOM_PROMPT =
  "You are the assistant in a group chat. Be friendly, concise and plain-spoken: short paragraphs, " +
  "no jargon unless someone uses it first, and no code unless someone asks for code. Answer the " +
  "question that was asked before adding anything else. When you make a file (a PDF, a spreadsheet, a deck), " +
  "say where it is and what is in it in a sentence. If something is unclear, ask one short question rather than guessing.";

export const SALON_NOTE =
  "You are chatting in Salon, a shared chat room. Several people may take part. " +
  'A message that begins with "[from someone@example.com]" was sent by that person, and one ' +
  "with no such tag was sent by the host. Address people by name when it helps, and treat " +
  "everyone in the room as a collaborator. " +
  "Keep replies conversational unless asked for something else.";

export const GAMES_NOTE =
  "People here can play games with each other on a board the chat shows. When someone wants to play " +
  "(\"let's play tic-tac-toe\", \"me against Bob\"), call the start_game tool with the two players — the " +
  "person asking is one of them unless they say otherwise — and then step back: the players click their " +
  "own moves and you are not told about them. Answer \"who's winning?\" with game_state.";

/** The `mcp_servers` entry that lets a chat's computer call this server as the conversation it is running. */
export function salonServer(publicUrl: string): Record<string, unknown> {
  // `$${…}` is Fountain's escape: the literal `${…}` reaches the runtime's config, and the claude
  // runtime expands it from its own environment, where the conversation's key and id are.
  return {
    type: "http",
    url: `${publicUrl}/mcp`,
    headers: { Authorization: "Bearer $${FOUNTAIN_TOKEN}", "X-Fountain-Conversation-Id": "$${FOUNTAIN_CONVERSATION_ID}" },
  };
}

export interface Materialised {
  agentId: string;
  /** The connectors that were attached, with the names the header shows. */
  connectors: ChosenConnector[];
  /** True when an agent was created for this pick (rather than found). */
  created: boolean;
}

export async function agentFor(client: FountainClient, settings: ChatSettings, publicUrl: string | null): Promise<Materialised> {
  // Connectors are resolved first: a stale or unusable one is refused before anything else is asked of Fountain.
  let connectors: ChosenConnector[] = [];
  let mcpServers: Record<string, unknown> = {};
  if (settings.connectorIds.length > 0) {
    const [held, catalog] = await Promise.all([client.connections(), client.catalog()]);
    ({ mcpServers, chosen: connectors } = attach(settings.connectorIds, resolveConnectors(held?.connections ?? [], held?.providers ?? [], catalog)));
  }

  const runtime = runtimeFor(settings.model);
  const games = runtime === "claude" && publicUrl ? salonServer(publicUrl) : null;
  const system = `${ROOM_PROMPT}\n\n${SALON_NOTE}${games ? `\n\n${GAMES_NOTE}` : ""}`;

  const key = derivedKey(settings);
  const agents = await client.agents();
  const existing = agents.find((a) => salonKey(a) === key);
  if (existing) {
    // An agent from before games, from a server without a public address then, or pointed at an old one: given the server in place.
    const held = existing.mcp_servers?.salon as { url?: unknown } | undefined;
    if (games && held?.url !== games.url) {
      await client.updateAgent(existing.id, { system, mcp_servers: { ...(existing.mcp_servers ?? {}), salon: games } });
    }
    return { agentId: existing.id, connectors, created: false };
  }

  const skills = settings.skills.map(skillById).flatMap((s) => (s ? [skillEntry(s)] : []));
  const parts = [...Object.keys(mcpServers), ...settings.skills].sort();
  // Fountain keeps agent names unique, and an environment is part of the key: name it, or the second pick is refused.
  if (settings.environmentId) parts.push(`on ${settings.environmentId.slice(0, 8)}`);
  if (games) mcpServers = { ...mcpServers, salon: games };
  const body: Record<string, unknown> = {
    name: `Salon · ${modelLabel(settings.model)}${parts.length ? ` · ${parts.join(", ")}` : ""}`.slice(0, 200),
    runtime,
    model: settings.model,
    system,
    metadata: { salon: { key, tuple: JSON.parse(canonical(settings)) as unknown } },
  };
  if (skills.length) body.skills = skills;
  if (Object.keys(mcpServers).length) body.mcp_servers = mcpServers;
  const made = await client.createAgent(body);
  return { agentId: made.id, connectors, created: true };
}

export function salonKey(a: AgentSummary): string | null {
  const meta = a.metadata;
  if (!meta || typeof meta !== "object") return null;
  const salon = (meta as { salon?: unknown }).salon;
  if (!salon || typeof salon !== "object") return null;
  const key = (salon as { key?: unknown }).key;
  return typeof key === "string" ? key : null;
}
