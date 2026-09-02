/**
 * Salon as an MCP server for the model in a chat: `POST /mcp` is how "let's
 * play tic-tac-toe" becomes a board on everyone's screen. The tools start a
 * game and read one; they never move a piece — moves are the players'
 * (server/games.ts), and a turn spent on each would make the game slower
 * than the people playing it.
 *
 * Who is asking is the computer's own conversation key and id
 * (server/sandbox.ts — server/agents.ts writes the headers as
 * `$${FOUNTAIN_TOKEN}` and `$${FOUNTAIN_CONVERSATION_ID}`, Fountain's escape
 * for a ref the runtime expands itself). The tools then reach that one chat:
 * its people and its games, and nothing else on this server.
 *
 * Streamable HTTP, one JSON-RPC 2.0 message per POST, answered as JSON —
 * the shape Fountain's own MCP endpoints use, and the workbench's.
 */
import { gameLabel, isGameKind, GAME_KINDS, type GameKind } from "../shared/games";
import type { AppContext } from "./context";
import { describe, resolvePlayer, startGame, toDto } from "./games";
import { HttpError, json, readJson, str } from "./http";
import { sandboxCaller, type SandboxCaller } from "./sandbox";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "salon", version: "1" };

const TOOLS = [
  {
    name: "start_game",
    description:
      "Put a game on everyone's screen in this chat. Say which two people are playing — by email, or by " +
      "enough of a name to be unambiguous; the first named plays X and moves first. Once the board is up, " +
      "the players click their own moves and you are not needed for them: say the game is on in one line, " +
      "name who moves first, and stop. Do not describe the board or narrate moves. If someone asks who is " +
      "winning, call game_state.",
    inputSchema: {
      type: "object",
      properties: {
        game: { type: "string", enum: GAME_KINDS, description: "Which game. Only tic-tac-toe so far." },
        players: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2, description: "The two players, X first: emails, or names that pick out one person here." },
      },
      required: ["game", "players"],
    },
  },
  {
    name: "game_state",
    description:
      "The board and whose move it is, for the latest game in this chat or the one named. Read it when " +
      "someone asks how a game is going; do not poll it.",
    inputSchema: {
      type: "object",
      properties: { game_id: { type: "string", description: "A game id from start_game; omit for the latest game." } },
    },
  },
];

export async function handleMcp(ctx: AppContext, req: Request): Promise<Response> {
  if (req.method.toUpperCase() !== "POST") throw new HttpError(405, "method_not_allowed", "Salon's MCP server takes one JSON-RPC message per POST.");
  const caller = await sandboxCaller(ctx, req);
  const body = await readJson<Record<string, unknown>>(req);
  if (Array.isArray(body)) return rpcError(null, -32600, "batched requests are not supported");

  const id = typeof body.id === "string" || typeof body.id === "number" ? body.id : null;
  const method = typeof body.method === "string" ? body.method : "";
  if (!method) return rpcError(id, -32600, "invalid request");
  if (id === null && method.startsWith("notifications/")) return new Response(null, { status: 202 });
  const params = (body.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case "initialize":
      return rpcResult(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call":
      return rpcResult(id, callTool(ctx, caller, params));
    default:
      return id === null ? new Response(null, { status: 202 }) : rpcError(id, -32601, `method not found: ${method}`);
  }
}

function callTool(ctx: AppContext, caller: SandboxCaller, params: Record<string, unknown>): unknown {
  const name = typeof params.name === "string" ? params.name : "";
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "start_game":
        return content(start(ctx, caller, args));
      case "game_state":
        return content(state(ctx, caller, args));
      default:
        return toolError(`no such tool: ${name || "(unnamed)"} — call tools/list`);
    }
  } catch (err) {
    // A bad argument is the model's to fix and reads as a tool result; anything else is the server's problem.
    if (err instanceof HttpError && err.status < 500) return toolError(err.message);
    throw err;
  }
}

function start(ctx: AppContext, caller: SandboxCaller, args: Record<string, unknown>): unknown {
  const kind = str(args.game, 40).trim().toLowerCase();
  if (!isGameKind(kind)) throw new HttpError(422, "bad_game", `Salon has ${GAME_KINDS.map(gameLabel).join(", ")} — not "${kind || "(none)"}".`);
  const refs = Array.isArray(args.players) ? args.players.map((p) => str(p, 320)) : [];
  if (refs.length !== 2) throw new HttpError(422, "bad_players", `Name two players. Here: ${ctx.db.participants(caller.chat).join(", ")}.`);
  const players = refs.map((r) => resolvePlayer(ctx, caller.chat, r));
  const game = startGame(ctx, caller.chat, kind as GameKind, players, caller.email);
  return {
    started: true,
    game,
    hint: `${describe(game)}. The board is on everyone's screen; ${game.players[0]} moves first. Say so in a line and leave the moves to them.`,
  };
}

function state(ctx: AppContext, caller: SandboxCaller, args: Record<string, unknown>): unknown {
  const wanted = str(args.game_id, 64).trim();
  const rows = ctx.db.games(caller.chat.id);
  const row = wanted ? rows.find((g) => g.id === wanted) : rows[rows.length - 1];
  if (!row) throw new HttpError(404, "no_game", wanted ? `No game ${wanted} in this chat.` : "No game has been played in this chat yet.");
  const game = toDto(row);
  const s = game.state;
  const outcome = game.status === "done" ? (game.winnerEmail ? `${game.winnerEmail} won.` : "It was a draw.") : `${s.next === "X" ? game.players[0] : game.players[1]} to move.`;
  return { game, summary: `${describe(game)}. ${outcome}`, board: rows3(s.board) };
}

function rows3(board: readonly (string | null)[]): string[] {
  return [0, 3, 6].map((i) => board.slice(i, i + 3).map((c) => c ?? ".").join(" "));
}

// ── JSON-RPC ─────────────────────────────────────────────────────────────

function rpcResult(id: string | number | null, result: unknown): Response {
  return json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: string | number | null, code: number, message: string): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } });
}

function content(value: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError: false };
}

function toolError(message: string): unknown {
  return { content: [{ type: "text", text: message }], isError: true };
}
