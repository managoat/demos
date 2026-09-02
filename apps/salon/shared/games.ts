/**
 * Games people in a chat play with each other, on a board the chat shows.
 *
 * A game is Salon's own record: which chat, which two people, whose move,
 * the board. The model only ever starts one (server/mcp.ts) or reads the
 * score; every move goes from a browser to server/games.ts and out to the
 * other browsers over the chat's game stream, and never through a turn.
 *
 * This file is the rules and the wire shape, shared so the server can refuse
 * a bad move and the browser can grey out the same cell without asking.
 */

export type GameKind = "tictactoe";

export const GAME_KINDS: readonly GameKind[] = ["tictactoe"];

export function isGameKind(v: unknown): v is GameKind {
  return typeof v === "string" && (GAME_KINDS as readonly string[]).includes(v);
}

export function gameLabel(kind: GameKind): string {
  switch (kind) {
    case "tictactoe":
      return "Tic-tac-toe";
  }
}

/** X is `players[0]` and moves first; O is `players[1]`. */
export type Mark = "X" | "O";
export type Cell = Mark | null;

export interface TicTacToe {
  board: Cell[];
  /** Who moves next; meaningless once `winner` is set. */
  next: Mark;
  /** The mark that won, "draw", or null while it is being played. */
  winner: Mark | "draw" | null;
  /** The three cells that won, when someone did. */
  line: number[] | null;
}

export interface GameDto {
  id: string;
  chatId: string;
  kind: GameKind;
  /** Emails, in mark order: X then O. */
  players: string[];
  state: TicTacToe;
  status: "playing" | "done";
  /** The email that won, null for a draw or a game still going. */
  winnerEmail: string | null;
  /** Bumped on every change; a browser keeps the highest it has seen. */
  seq: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export function newTicTacToe(): TicTacToe {
  return { board: Array<Cell>(9).fill(null), next: "X", winner: null, line: null };
}

/** The mark a player holds, or null for someone not in the game. */
export function markOf(game: Pick<GameDto, "players">, email: string): Mark | null {
  if (game.players[0] === email) return "X";
  if (game.players[1] === email) return "O";
  return null;
}

/** The email whose move it is, or null once the game is over. */
export function toMove(game: Pick<GameDto, "players" | "state">): string | null {
  if (game.state.winner) return null;
  return game.state.next === "X" ? (game.players[0] ?? null) : (game.players[1] ?? null);
}

/** The state after `email` plays `cell`, or the sentence that says why not. */
export function play(game: Pick<GameDto, "players" | "state">, email: string, cell: unknown): TicTacToe | string {
  const s = game.state;
  if (s.winner) return "That game is over.";
  const mark = markOf(game, email);
  if (!mark) return "You are not playing this game.";
  if (mark !== s.next) return "It is not your move.";
  if (typeof cell !== "number" || !Number.isInteger(cell) || cell < 0 || cell > 8) return "Pick a square on the board.";
  if (s.board[cell] !== null) return "That square is taken.";
  const board = s.board.slice();
  board[cell] = mark;
  const line = LINES.find((l) => l.every((i) => board[i] === mark)) ?? null;
  const winner: TicTacToe["winner"] = line ? mark : board.every((c) => c !== null) ? "draw" : null;
  return { board, next: mark === "X" ? "O" : "X", winner, line };
}

/** Who won, as an email, once the state says a mark did. */
export function winnerEmail(game: Pick<GameDto, "players" | "state">): string | null {
  const w = game.state.winner;
  if (w === "X") return game.players[0] ?? null;
  if (w === "O") return game.players[1] ?? null;
  return null;
}
