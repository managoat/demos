/**
 * What a "Report a problem" carries besides the words: the facts triage
 * needs, taken from the client's state — conversation, agent, sandbox,
 * presence, the last stage events, the app build, the page. Never secrets:
 * no API key, no message bodies beyond what the user types, no tool output.
 */
import type { LogEvent, Teammate } from "../api/types";

export const REPORT_CATEGORIES: Array<{ id: string; label: string; hint: string }> = [
  { id: "bug", label: "Something's broken", hint: "an error, a wrong result, a crash" },
  { id: "stuck", label: "A teammate is stuck", hint: "starting forever, never replies, queued and nothing happens" },
  { id: "question", label: "A question", hint: "how do I…" },
  { id: "idea", label: "An idea", hint: "it would be better if…" },
  { id: "other", label: "Something else", hint: "" },
];

export interface ReportContext {
  app: string;
  url: string;
  user_agent: string;
  fountain_url: string;
  connected: boolean;
  queued: number;
  teammate?: {
    agent_id: string;
    agent_name: string;
    name: string;
    runtime: string;
    model: string;
    presence: { state: string; label: string };
  };
  conversation_id?: string;
  conversation_status?: string;
  turn_count?: number;
  last_active_at?: string | null;
  sandbox?: { id: string; status: string; provider?: string | null; runner?: { name: string; online: boolean } | null } | null;
  recent_events?: Array<{ id: number; kind: string; stream?: string | null; stage?: string | null; state?: string | null; ts: string; data?: string }>;
  // flattened for the forwarder's summary lines
  agent_id?: string;
  agent_name?: string;
  runtime?: string;
  model?: string;
  presence?: { state: string; label: string };
}

export function buildReportContext(input: {
  appCommit: string;
  fountainUrl: string;
  connected: boolean;
  teammate: Teammate | null;
  events: LogEvent[];
  queued: number;
  now?: () => string;
}): ReportContext {
  const t = input.teammate;
  const ctx: ReportContext = {
    app: `fountain-team ${input.appCommit}`,
    url: typeof location !== "undefined" ? location.href : "",
    user_agent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    fountain_url: input.fountainUrl,
    connected: input.connected,
    queued: input.queued,
  };
  if (t) {
    ctx.teammate = {
      agent_id: t.agent_id,
      agent_name: t.agent.name,
      name: t.name,
      runtime: t.agent.runtime,
      model: t.agent.model,
      presence: t.presence,
    };
    ctx.agent_id = t.agent_id;
    ctx.agent_name = t.name;
    ctx.runtime = t.agent.runtime;
    ctx.model = t.agent.model;
    ctx.presence = t.presence;
    ctx.conversation_id = t.conversation.id;
    ctx.conversation_status = t.conversation.status;
    ctx.turn_count = t.conversation.turn_count;
    ctx.last_active_at = t.conversation.last_active_at;
    ctx.sandbox = t.conversation.sandbox
      ? {
          id: t.conversation.sandbox.id,
          status: t.conversation.sandbox.status,
          provider: t.conversation.sandbox.provider ?? null,
          runner: t.conversation.sandbox.runner ? { name: t.conversation.sandbox.runner.name, online: t.conversation.sandbox.runner.online } : null,
        }
      : null;
    // stage events and errors only — never the agent's output or the user's prompts
    ctx.recent_events = input.events
      .filter((e) => e.kind !== "output" || e.stream === "stderr")
      .slice(-25)
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        stream: e.stream,
        stage: e.stage,
        state: e.state,
        ts: e.ts,
        data: typeof e.data === "string" ? e.data.slice(0, 300) : undefined,
      }));
  }
  return ctx;
}
