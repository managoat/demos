/**
 * Games: a board two people in a chat play on, kept here and shown by every
 * browser in the chat. The model may start one (server/mcp.ts calls
 * `startGame` too) but no move is a turn — a move is a POST from the player
 * whose go it is, and the change reaches the other browsers on the chat's
 * game stream, a server-sent stream of this server's own.
 *
 *   GET  /api/chats/:id/games                 every game in the chat, oldest first
 *   POST /api/chats/:id/games                 { kind, players: [email, email] } — anyone in the chat
 *   GET  /api/chats/:id/games/:game
 *   POST /api/chats/:id/games/:game/moves     { cell } — the player whose move it is
 *
 * Every change goes out as a `game` event on the chat's stream (server/hub.ts).
 */
import { shortName } from "../shared/author";
import { gameLabel, isGameKind, newTicTacToe, play, winnerEmail, type GameDto, type GameKind, type TicTacToe } from "../shared/games";
import { authenticate, chatAccess, type AppContext } from "./context";
import { now, type ChatRow, type GameRow } from "./db";
import { hub } from "./hub";
import { HttpError, json, readJson } from "./http";

export function toDto(g: GameRow): GameDto {
  return {
    id: g.id,
    chatId: g.chat_id,
    kind: g.kind as GameKind,
    players: JSON.parse(g.players) as string[],
    state: JSON.parse(g.state) as TicTacToe,
    status: g.status,
    winnerEmail: g.winner_email,
    seq: g.seq,
    createdBy: g.created_by,
    createdAt: g.created_at,
    updatedAt: g.updated_at,
  };
}

// ── the rules of starting and moving, for the routes and for the model ──

/** Why a game with these players cannot start, or null. Both must be in the chat, and be two different people. */
export function playersProblem(ctx: AppContext, chat: ChatRow, players: readonly string[]): string | null {
  const here = ctx.db.participants(chat);
  if (players.length !== 2) return "A game takes two players.";
  const [a, b] = players as [string, string];
  if (a === b) return "The two players have to be different people.";
  const out = players.find((p) => !here.includes(p));
  if (out) return `${out} is not in this chat. Here: ${here.join(", ")}.`;
  return null;
}

export function startGame(ctx: AppContext, chat: ChatRow, kind: GameKind, players: readonly string[], by: string): GameDto {
  const problem = playersProblem(ctx, chat, players);
  if (problem) throw new HttpError(422, "bad_players", problem);
  const t = now();
  const row: GameRow = {
    id: crypto.randomUUID(),
    chat_id: chat.id,
    kind,
    players: JSON.stringify(players),
    state: JSON.stringify(newTicTacToe()),
    status: "playing",
    winner_email: null,
    seq: 1,
    created_by: by,
    created_at: t,
    updated_at: t,
  };
  ctx.db.insertGame(row);
  const dto = toDto(row);
  hub.publish(chat.id, "game", dto);
  return dto;
}

export function move(ctx: AppContext, chat: ChatRow, gameId: string, email: string, cell: unknown): GameDto {
  const row = ctx.db.getGame(gameId);
  if (!row || row.chat_id !== chat.id) throw new HttpError(404, "not_found", "No such game in this chat.");
  const game = toDto(row);
  const next = play(game, email, cell);
  if (typeof next === "string") throw new HttpError(409, "bad_move", next);
  const after = { players: game.players, state: next };
  const updated = ctx.db.updateGame(row.id, {
    state: JSON.stringify(next),
    status: next.winner ? "done" : "playing",
    winner_email: winnerEmail(after),
  });
  const dto = toDto(updated!);
  hub.publish(chat.id, "game", dto);
  return dto;
}

/**
 * A person in the chat, from what someone called them: an email, or enough
 * of one — "bob" finds bob@example.com. Ambiguity and absence are sentences
 * that name everyone here, so the caller can try again without guessing.
 */
export function resolvePlayer(ctx: AppContext, chat: ChatRow, ref: string): string {
  const here = ctx.db.participants(chat);
  const want = ref.trim().toLowerCase();
  if (!want) throw new HttpError(422, "bad_players", `Name a player. Here: ${here.join(", ")}.`);
  const exact = here.find((e) => e === want);
  if (exact) return exact;
  const near = here.filter((e) => e.startsWith(want) || (e.split("@")[0] ?? "").includes(want) || shortName(e).toLowerCase().includes(want));
  if (near.length === 1) return near[0]!;
  if (near.length > 1) throw new HttpError(422, "bad_players", `"${ref}" could be ${near.join(" or ")}. Use the email.`);
  throw new HttpError(422, "bad_players", `Nobody called "${ref}" is in this chat. Here: ${here.join(", ")}.`);
}

/** "Tic-tac-toe: Jake (X) vs Bob (O)". */
export function describe(g: GameDto): string {
  const [x, o] = g.players;
  return `${gameLabel(g.kind)}: ${shortName(x ?? "?")} (X) vs ${shortName(o ?? "?")} (O)`;
}

// ── the routes ───────────────────────────────────────────────────────────

export async function list(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  return json({ data: ctx.db.games(chat.id).map(toDto) });
}

export async function create(ctx: AppContext, req: Request, chatId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const body = await readJson(req);
  if (!isGameKind(body.kind)) throw new HttpError(422, "bad_game", "Salon does not have that game.");
  const players = Array.isArray(body.players) ? body.players.map((p) => (typeof p === "string" ? p.trim().toLowerCase() : "")) : [];
  return json({ data: startGame(ctx, chat, body.kind, players, user.email) }, 201);
}

export async function show(ctx: AppContext, req: Request, chatId: string, gameId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const row = ctx.db.getGame(gameId);
  if (!row || row.chat_id !== chat.id) throw new HttpError(404, "not_found", "No such game in this chat.");
  return json({ data: toDto(row) });
}

export async function makeMove(ctx: AppContext, req: Request, chatId: string, gameId: string): Promise<Response> {
  const user = await authenticate(ctx, req);
  const { chat } = chatAccess(ctx, user, chatId);
  const body = await readJson(req);
  return json({ data: move(ctx, chat, gameId, user.email, body.cell) });
}
