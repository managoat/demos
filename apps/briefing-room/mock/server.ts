/**
 * A tiny mock Fountain, for developing Briefing Room without a live server:
 * one teammate, one conversation, canned turns that walk the whole protocol
 * (commission → brief → prose follow-up → revision). Run with `bun run mock`,
 * start the app with `FOUNTAIN_PROXY=http://localhost:8787 bun run dev`,
 * and paste any string as the API key with http://localhost:5175 as the URL.
 */

const chunk = (text: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });

const BRIEF_V1 = `Done — brief below.

\`\`\`brief
{"id":"brf-hp01","title":"Heat pumps for an older house","asked":"How do heat pumps work in an older house, and are they worth it?","tldr":["A heat pump moves heat instead of making it, which is why it can beat a furnace on running cost.","Modern cold-climate models hold their rated output well below freezing.","For most older houses the real question is sizing and ductwork, not the technology.","Expect the install quote, not the hardware, to dominate the price."],"sections":[{"heading":"How they work","body_md":"A refrigerant loop moves heat **against** the temperature gradient — the same trick as a refrigerator, run in either direction. Efficiency is stated as COP: a COP of 3 means *three units of heat per unit of electricity*."},{"heading":"What to watch for in an older house","body_md":"- Sizing: an oversized unit short-cycles and never dehumidifies.\\n- Ductwork: leaky or undersized ducts quietly eat the savings.\\n- Backup heat: below the balance point you still want resistance strips or the old furnace."}],"sources":[{"title":"DOE heat pump explainer","url":"https://www.energy.gov/energysaver/heat-pump-systems","note":"the basics and COP"},{"title":"NEEP cold-climate list","url":"https://ashp.neep.org/","note":"cold-climate performance data"}],"caveats":["Could not verify 2026 federal rebate amounts — the source pages disagreed."],"depth":"standard","written_at":"2026-08-19T16:00:00Z"}
\`\`\``;

const NOTE = "Rentals rarely qualify for the rebates — they attach to the property owner, who has to file. Worth confirming with the landlord before budgeting around them.";

const BRIEF_V2 = `Revised for the rental angle — v2 below.

\`\`\`brief
{"id":"brf-hp01","title":"Heat pumps for an older house (renter's edition)","asked":"How do heat pumps work in an older house, and are they worth it — as a renter?","tldr":["A heat pump moves heat instead of making it, which is why it can beat a furnace on running cost.","As a renter your lever is the landlord: the rebates attach to the owner.","Window and portable units are the renter-friendly path — no ductwork, no permission."],"sections":[{"heading":"The renter's version","body_md":"Packaged window heat pumps need **no installer and no permission** in most leases. They heat and cool one room well; whole-house economics stay the landlord's problem."}],"sources":[{"title":"DOE heat pump explainer","url":"https://www.energy.gov/energysaver/heat-pump-systems","note":"the basics"}],"caveats":["Lease terms vary — check yours before mounting anything."],"depth":"standard","written_at":"2026-08-19T16:20:00Z"}
\`\`\``;

const now = "2026-08-19T16:05:00.000000Z";
const turns = [
  { id: "t1", turn_number: 1, prompt: "Commission a brief.\nTopic: Heat pumps for an older house\nWhy: Deciding whether to replace the furnace\nDepth: standard", status: "completed", exit_code: 0, started_at: now, ended_at: now, inserted_at: now, reply: BRIEF_V1 },
  { id: "t2", turn_number: 2, prompt: "Follow-up on brief brf-hp01: what about rentals?", status: "completed", exit_code: 0, started_at: now, ended_at: now, inserted_at: now, reply: NOTE },
  { id: "t3", turn_number: 3, prompt: "Follow-up on brief brf-hp01: revise it for a renter", status: "completed", exit_code: 0, started_at: now, ended_at: now, inserted_at: now, reply: BRIEF_V2 },
];

const events = turns.map((t, i) => ({
  id: i + 1,
  kind: "output",
  stream: "acp",
  data: chunk(t.reply),
  stage: null,
  state: null,
  turn_id: t.id,
  ts: now,
}));

const teammate = {
  agent_id: "agent-briefs",
  name: "Briefing Room",
  agent: { id: "agent-briefs", name: "briefing-room", model: "anthropic/claude-sonnet-5", runtime: "claude", environment_id: null, allowed_vault_ids: null, allowed_environment_ids: null },
  conversation: { id: "c1", title: "Briefing Room", agent_id: "agent-briefs", vault_id: null, environment_id: null, runtime: "claude", acp: true, status: "idle", turn_count: turns.length, last_active_at: now, unread: false, inserted_at: now, updated_at: now },
  presence: { state: "online", label: "online" },
  unread: false,
  last_turn: null,
};

const json = (data: unknown) => Response.json({ data });

Bun.serve({
  port: 8787,
  idleTimeout: 120,
  routes: {
    "/api/auth/me": json({ id: "u1", email: "dev@example.com", role: "user" }),
    "/api/team": json([teammate]),
    "/api/team/agent-briefs": json(teammate),
    "/api/catalog": json({ runtimes: ["claude"], models: { claude: ["anthropic/claude-sonnet-5"] } }),
    "/api/conversations/c1/turns": json(turns.map(({ reply: _r, ...t }) => t)),
    "/api/conversations/c1/events": () =>
      Response.json({ data: events, meta: { has_more: false, next_cursor: null } }),
    "/api/conversations/c1/read": new Response(null, { status: 204 }),
    "/api/team/agent-briefs/messages": () => Response.json({ status: "queued", conversation_id: "c1" }),
    "/api/team/stream": () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": hello\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  },
  fetch: () => Response.json({ error: "not_found" }, { status: 404 }),
});

console.log("mock Fountain on http://localhost:8787");
