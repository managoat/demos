import { cronError } from "./cron";

/** Where the app points and how it authenticates. Stored locally, in this browser only. */
export interface Settings {
  baseUrl: string;
  apiKey: string;
  /** How the key was obtained — an OAuth key is revoked on sign-out. */
  via?: "paste" | "oauth";
}

const KEY = "rounds.settings";

export function loadSettings(): Settings | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    if (typeof parsed.baseUrl !== "string" || typeof parsed.apiKey !== "string") return null;
    return { baseUrl: normalizeBaseUrl(parsed.baseUrl), apiKey: parsed.apiKey, via: parsed.via === "oauth" ? "oauth" : "paste" };
  } catch {
    return null;
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify({ baseUrl: normalizeBaseUrl(s.baseUrl), apiKey: s.apiKey, via: s.via ?? "paste" }));
}

export function clearSettings(): void {
  localStorage.removeItem(KEY);
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Repositories waved away in the rail, by `owner/name`.
 *
 * A list of things to get through needs a way to say "not this one" that
 * sticks, or the same repository is a decision again on every visit. Kept in
 * this browser rather than in Fountain because it is a preference about a
 * list, not a fact about a repository — and because nothing unattended ever
 * reads it.
 */
const SKIPPED = "rounds.skipped";

export function loadSkipped(): string[] {
  try {
    const raw = localStorage.getItem(SKIPPED);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function saveSkipped(slugs: string[]): void {
  try {
    localStorage.setItem(SKIPPED, JSON.stringify(slugs));
  } catch {
    // A browser with storage switched off still gets a working rail; the list
    // simply forgets between visits.
  }
}

/**
 * The cadence the rail enrolls with, remembered between visits.
 *
 * Somebody enrolling five repositories in a sitting wants them on the same
 * schedule, and picking it once should be enough. It is a starting point
 * rather than a setting: each repository's own page owns its cron after that.
 */
const CADENCE = "rounds.cadence";

export function loadCadence(fallback: string): string {
  try {
    const raw = localStorage.getItem(CADENCE);
    // Validated on the way out, not just in: a hand-edited or stale value
    // would otherwise become a schedule Fountain rejects at enrollment.
    return raw && !cronError(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

export function saveCadence(cron: string): void {
  try {
    if (!cronError(cron)) localStorage.setItem(CADENCE, cron);
  } catch {
    // Storage off: the picker still works, it just forgets between visits.
  }
}
