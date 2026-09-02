/** Which teammate is the desk — remembered per Fountain URL, in this browser. */
const KEY = "dns-desk.desk";

export function loadDeskId(baseUrl: string): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, string>;
    return typeof map[baseUrl] === "string" ? map[baseUrl] : null;
  } catch {
    return null;
  }
}

export function saveDeskId(baseUrl: string, agentId: string): void {
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
  } catch {
    // start over
  }
  map[baseUrl] = agentId;
  localStorage.setItem(KEY, JSON.stringify(map));
}

export function clearDeskId(baseUrl: string): void {
  try {
    const map = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
    delete map[baseUrl];
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    localStorage.removeItem(KEY);
  }
}
