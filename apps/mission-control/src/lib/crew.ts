/**
 * Which agents are the crew (coordinator + worker agent), and the mission
 * last looked at — remembered per Fountain URL, in this browser. Fast-load
 * hints only: the coordinator conversation is the system of record.
 *
 * That conversation is the one bound to the `mission-control` channel:
 * `POST /api/conversations` with that `channel_id` resumes the latest live
 * one for the coordinator, or opens one when there is none. So the app keeps
 * no conversation id of its own; it asks.
 */
import type { Conversation } from "../api/types";

/** The channel the coordinator's conversation is bound to. */
export const CHANNEL = "mission-control";

/** A one-word status for the header, from the coordinator's conversation. */
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

export interface Crew {
  coordinatorId: string;
  workerId: string;
  lastMissionId?: string;
}

const KEY = "mission-control.crew";

export function loadCrew(baseUrl: string): Crew | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, Partial<Crew>>;
    const c = map[baseUrl];
    if (!c || typeof c.coordinatorId !== "string" || typeof c.workerId !== "string") return null;
    return { coordinatorId: c.coordinatorId, workerId: c.workerId, ...(typeof c.lastMissionId === "string" ? { lastMissionId: c.lastMissionId } : {}) };
  } catch {
    return null;
  }
}

export function saveCrew(baseUrl: string, crew: Crew): void {
  let map: Record<string, Crew> = {};
  try {
    map = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Crew>;
  } catch {
    // start over
  }
  map[baseUrl] = crew;
  localStorage.setItem(KEY, JSON.stringify(map));
}

export function clearCrew(baseUrl: string): void {
  try {
    const map = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Crew>;
    delete map[baseUrl];
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    localStorage.removeItem(KEY);
  }
}
