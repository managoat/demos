import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { Column, type ColumnData } from "./Column";
import { Scoreboard } from "./Scoreboard";

// Render smoke: a blind column hides its name and offers a vote once a turn
// completed; the winner wears the crown; the scoreboard tallies with bars.

const col: ColumnData = {
  key: "anthropic/claude-sonnet-5",
  name: "anthropic/claude-sonnet-5",
  index: 1,
  status: "done",
  statusDetail: null,
  segments: [
    {
      turn: {
        id: "t1",
        turn_number: 1,
        prompt: "p",
        status: "completed",
        exit_code: 0,
        started_at: "2026-08-19T12:00:00Z",
        ended_at: "2026-08-19T12:00:08Z",
        inserted_at: "2026-08-19T12:00:00Z",
        usage: { input: 900, output: 120 },
      },
      blocks: [{ kind: "text", body: "The answer is 42.", startedAt: null, endedAt: null }],
      metrics: { ttfbMs: 1500, durationMs: 8000, usage: { input: 900, output: 120 } },
    },
  ],
};

describe("Column", () => {
  test("blind: label B, name hidden, reply and numbers shown, vote offered", () => {
    const html = renderToString(<Column col={col} revealed={false} winner={false} canVote onVote={() => undefined} />)
      .replace(/<!-- -->/g, "");
    expect(html).toContain(">B<");
    expect(html).not.toContain("claude-sonnet-5");
    expect(html).toContain("The answer is 42.");
    expect(html).toContain("first 1.5s");
    expect(html).toContain("total 8.0s");
    expect(html).toContain("900▸120 tok");
    expect(html).toContain(">Winner</button>");
  });

  test("revealed winner: name shown, crown on, no vote button", () => {
    const html = renderToString(<Column col={col} revealed winner canVote={false} />);
    expect(html).toContain("anthropic/claude-sonnet-5");
    expect(html).toContain("♛");
    expect(html).not.toContain(">Winner</button>");
  });

  test("an erroring column states the error", () => {
    const bad: ColumnData = { ...col, segments: [], status: "error", statusDetail: "That API key was not accepted." };
    const html = renderToString(<Column col={bad} revealed={false} winner={false} canVote={false} />);
    expect(html).toContain("error");
    expect(html).toContain("That API key was not accepted.");
  });
});

describe("Scoreboard", () => {
  test("renders a bar and a tally per model", () => {
    const html = renderToString(
      <Scoreboard
        scores={[
          { model: "anthropic/claude-opus-5", wins: 3, rounds: 4 },
          { model: "openai/gpt-5", wins: 1, rounds: 4 },
        ]}
        onClose={() => undefined}
      />,
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("anthropic/claude-opus-5");
    expect(html).toContain("3/4");
    expect(html).toContain("1/4");
    expect(html).toContain("width:100%");
  });

  test("empty tally says so", () => {
    const html = renderToString(<Scoreboard scores={[]} onClose={() => undefined} />);
    expect(html).toContain("No votes yet");
  });
});
