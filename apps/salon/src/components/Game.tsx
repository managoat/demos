/**
 * A game on the board: the card the transcript shows for one, whoever
 * started it. Every browser in the chat renders the same record; a click on
 * a free square by the player whose move it is goes to the server, and the
 * new board comes back to everyone on the chat's game stream (Thread.tsx).
 */
import { useState } from "react";
import { shortName } from "../../shared/author";
import { gameLabel, markOf, toMove, type GameDto } from "../../shared/games";
import { Avatar } from "./Avatar";

export interface GameHandlers {
  me: string;
  onMove: (gameId: string, cell: number) => Promise<void>;
}

export function GameCard({ game, me, onMove }: { game: GameDto } & GameHandlers) {
  const [busy, setBusy] = useState<number | null>(null);
  const s = game.state;
  const mine = markOf(game, me);
  const mover = toMove(game);
  const myMove = mover !== null && mover === me;
  const [x, o] = game.players;

  const name = (email: string | undefined) => (email === me ? "You" : shortName(email ?? "?"));
  let status: string;
  if (s.winner === "draw") status = "A draw.";
  else if (game.winnerEmail) status = game.winnerEmail === me ? "You won." : `${shortName(game.winnerEmail)} won.`;
  else if (myMove) status = "Your move.";
  else status = `${name(mover ?? undefined)} to move.`;

  const click = async (i: number) => {
    if (!myMove || s.board[i] !== null || busy !== null) return;
    setBusy(i);
    try {
      await onMove(game.id, i);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={`game${game.status === "done" ? " done" : ""}${myMove ? " my-move" : ""}`}>
      <div className="game-head">
        <span className="game-kind">{gameLabel(game.kind)}</span>
        <span className="game-players">
          <Player email={x} mark="X" label={name(x)} active={mover === x} />
          <span className="muted">vs</span>
          <Player email={o} mark="O" label={name(o)} active={mover === o} />
        </span>
      </div>
      <div className="board" role="grid" aria-label={`${gameLabel(game.kind)} board`}>
        {s.board.map((c, i) => {
          const won = s.line?.includes(i) ?? false;
          const free = c === null && game.status === "playing";
          return (
            <button
              key={i}
              type="button"
              role="gridcell"
              className={`cell${c ? ` ${c.toLowerCase()}` : ""}${won ? " won" : ""}${free && myMove ? " open" : ""}`}
              disabled={!free || !myMove || busy !== null}
              onClick={() => void click(i)}
              aria-label={c ? `${c}` : free ? `square ${i + 1}` : "empty"}
            >
              {c ?? (busy === i ? mine : "")}
            </button>
          );
        })}
      </div>
      <div className={`game-status${myMove ? " mine" : ""}`}>{status}</div>
    </div>
  );
}

function Player({ email, mark, label, active }: { email: string | undefined; mark: "X" | "O"; label: string; active: boolean }) {
  return (
    <span className={`game-player${active ? " active" : ""}`}>
      {email && <Avatar email={email} size={18} />}
      <span>{label}</span>
      <span className="game-mark">{mark}</span>
    </span>
  );
}
