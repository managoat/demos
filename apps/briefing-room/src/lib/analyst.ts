/**
 * Which agent is the researcher — remembered per Fountain URL, in this
 * browser — and how its one conversation is found.
 *
 * The researcher's conversation is the one bound to the `briefing-room`
 * channel: `POST /api/conversations` with that `channel_id` resumes the latest
 * live conversation for the agent, or opens one when there is none (the
 * machine was retired, or this is the first brief). So the app keeps no
 * conversation id of its own; it asks.
 */
import type { Conversation } from "../api/types";

const KEY = "briefing-room.analyst";

/** The channel every researcher conversation is bound to. */
export const CHANNEL = "briefing-room";

/** A one-word status for the header, from the researcher's conversation. */
export function presenceLabel(conv: Conversation | null): string {
  if (!conv) return "ready";
  switch (conv.status) {
    case "pending":
      return "starting";
    case "running":
      return "working";
    case "idle":
      return "online";
    default:
      return conv.status;
  }
}

export function loadAnalystId(baseUrl: string): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, string>;
    return typeof map[baseUrl] === "string" ? map[baseUrl] : null;
  } catch {
    return null;
  }
}

export function saveAnalystId(baseUrl: string, agentId: string): void {
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
  } catch {
    // start over
  }
  map[baseUrl] = agentId;
  localStorage.setItem(KEY, JSON.stringify(map));
}

export function clearAnalystId(baseUrl: string): void {
  try {
    const map = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
    delete map[baseUrl];
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    localStorage.removeItem(KEY);
  }
}
