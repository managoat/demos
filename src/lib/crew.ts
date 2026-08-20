/**
 * Which agents are the crew (coordinator teammate + worker agent), and the
 * mission last looked at — remembered per Fountain URL, in this browser.
 * Fast-load hints only: the coordinator conversation is the system of record.
 */

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
