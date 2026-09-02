/** The running tally, fight-night style: a bar per model, wins over rounds. */
import type { Score } from "../lib/arena";

export function Scoreboard(props: { scores: Score[]; onClose: () => void }) {
  const max = Math.max(1, ...props.scores.map((s) => s.wins));
  return (
    <div className="board">
      <div className="board-head">
        <h3>Scoreboard</h3>
        <button className="linkish" onClick={props.onClose}>
          close
        </button>
      </div>
      {props.scores.length === 0 ? (
        <p className="fineprint">No votes yet. Fight a round and crown a winner.</p>
      ) : (
        <div className="board-rows">
          {props.scores.map((s) => (
            <div key={s.model} className="board-row">
              <span className="board-model">{s.model}</span>
              <span className="board-bar">
                <span className="board-fill" style={{ width: `${(s.wins / max) * 100}%` }} />
              </span>
              <span className="board-tally">
                {s.wins}/{s.rounds}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
