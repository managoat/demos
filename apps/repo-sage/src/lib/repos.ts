/**
 * Which sage answers for which repo — remembered per Fountain URL, in this
 * browser. Only choices live here (repo → agent id, and which repo is open);
 * everything the sage knows is derived from its conversation.
 */

const KEY = "repo-sage.repos";

interface Store {
  [baseUrl: string]: { selected?: string; repos: Record<string, string> };
}

function load(): Store {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function save(store: Store): void {
  localStorage.setItem(KEY, JSON.stringify(store));
}

/** repo full name → agent id, for one Fountain. */
export function loadRepos(baseUrl: string): Record<string, string> {
  const entry = load()[baseUrl];
  return entry && typeof entry.repos === "object" && entry.repos !== null ? { ...entry.repos } : {};
}

export function saveRepo(baseUrl: string, repo: string, agentId: string): void {
  const store = load();
  const entry = store[baseUrl] ?? { repos: {} };
  entry.repos[repo] = agentId;
  store[baseUrl] = entry;
  save(store);
}

export function removeRepo(baseUrl: string, repo: string): void {
  const store = load();
  const entry = store[baseUrl];
  if (!entry) return;
  delete entry.repos[repo];
  if (entry.selected === repo) delete entry.selected;
  save(store);
}

/** Drop entries whose agent is gone from the team (the roster is the truth). */
export function reconcileRepos(baseUrl: string, live: Record<string, string>): void {
  const store = load();
  const entry = store[baseUrl] ?? { repos: {} };
  entry.repos = { ...live };
  if (entry.selected && !(entry.selected in entry.repos)) delete entry.selected;
  store[baseUrl] = entry;
  save(store);
}

export function loadSelected(baseUrl: string): string | null {
  const entry = load()[baseUrl];
  return entry && typeof entry.selected === "string" ? entry.selected : null;
}

export function saveSelected(baseUrl: string, repo: string | null): void {
  const store = load();
  const entry = store[baseUrl] ?? { repos: {} };
  if (repo) entry.selected = repo;
  else delete entry.selected;
  store[baseUrl] = entry;
  save(store);
}
