import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { foldConversation } from "../lib/protocol";
import type { Schedule } from "../api/types";
import { Incidents } from "./Incidents";
import { SchedulePanel } from "./SchedulePanel";
import { Tile } from "./Tiles";

// Render smoke: a tile shows the numbers and goes amber/red for the right
// reasons; incidents and the schedule panel read as sentences.

const STATE = `\`\`\`watch-state
{"checked_at":"2026-08-19T12:00:00Z","sites":[
  {"url":"https://ok.example","up":true,"status":200,"latency_ms":184,"cert_days_left":42,"cert_expires_at":null,"dns":["203.0.113.7"],"note":null},
  {"url":"https://dying.example","up":false,"status":503,"latency_ms":900,"cert_days_left":5,"cert_expires_at":null,"dns":[],"note":"upstream 503 on every try"}]}
\`\`\``;

const INCIDENT =
  '```watch-incident\n{"url":"https://dying.example","summary":"Origin is throwing 503s.","suspected_cause":"backend deploy gone wrong","evidence":["curl -sSI shows Server: nginx and a 503","traceroute is clean to the edge"],"checked_at":"2026-08-19T12:05:00Z"}\n```';

const view = foldConversation([{ prompt: "Run checks and report watch-state.", reply: `${STATE}\n${INCIDENT}` }]);

describe("Tile", () => {
  test("a healthy site: green, numbers, sparkline placeholder with one sample", () => {
    const html = renderToString(
      <Tile url="https://ok.example" samples={view.samples.get("https://ok.example")!} busy={false} onInvestigate={() => undefined} onRemove={() => undefined} />,
    );
    expect(html).toContain("https://ok.example");
    expect(html).toContain("184ms");
    expect(html).toContain("42d");
    expect(html).toContain("tile-ok");
    expect(html).toContain(">Investigate</button>");
  });

  test("a down site is red and shows the agent's note", () => {
    const html = renderToString(
      <Tile url="https://dying.example" samples={view.samples.get("https://dying.example")!} busy={false} onInvestigate={() => undefined} onRemove={() => undefined} />,
    );
    expect(html).toContain("tile-down");
    expect(html).toContain("upstream 503 on every try");
  });

  test("a site with no samples yet still gets a tile", () => {
    const html = renderToString(
      <Tile url="https://never.example" samples={[]} busy={false} onInvestigate={() => undefined} onRemove={() => undefined} />,
    );
    expect(html).toContain("tile-pending");
    expect(html).toContain("Waiting for the first patrol");
  });
});

describe("Incidents", () => {
  test("renders the incident card with cause and evidence", () => {
    const html = renderToString(<Incidents cards={view.incidents} />);
    expect(html).toContain("Origin is throwing 503s.");
    expect(html).toContain("backend deploy gone wrong");
    expect(html).toContain("traceroute is clean to the edge");
  });
});

describe("SchedulePanel", () => {
  const schedule: Schedule = {
    id: "s1",
    agent_id: "a1",
    name: "patrol",
    cron: "*/30 * * * *",
    prompt: "Run checks and report watch-state.",
    one_off: false,
    enabled: true,
    next_run_at: new Date(Date.now() + 12 * 60000).toISOString(),
    last_run_at: new Date(Date.now() - 4 * 60000).toISOString(),
    last_conversation_id: null,
    last_error: null,
    inserted_at: "2026-08-19T00:00:00Z",
    updated_at: "2026-08-19T00:00:00Z",
  };
  test("reads as a sentence with cadence, next and last run", () => {
    const html = renderToString(
      <SchedulePanel schedule={schedule} busy={false} working={false} onRunNow={() => undefined} onCadence={() => undefined} onToggle={() => undefined} />,
    );
    expect(html).toContain("every 30 min");
    expect(html).toContain("in 12 min");
    expect(html).toContain("4 min ago");
    expect(html).toContain(">Run now</button>");
    expect(html).toContain(">Pause</button>");
  });
  test("paused reads as paused with a Resume button", () => {
    const html = renderToString(
      <SchedulePanel schedule={{ ...schedule, enabled: false }} busy={false} working={false} onRunNow={() => undefined} onCadence={() => undefined} onToggle={() => undefined} />,
    );
    expect(html).toContain("patrol paused");
    expect(html).toContain(">Resume</button>");
  });
});
