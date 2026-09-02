/**
 * Where rounds points and how it authenticates — see
 * `@managoat/fountain-app/settings`. Stored under `rounds.settings`, in this
 * browser only.
 *
 * Below the re-export are the two preferences that belong to the rail itself
 * rather than to signing in, and so stayed here.
 */
import { cronError } from "./cron";
import { createSettings } from "@managoat/fountain-app/settings";

export { normalizeBaseUrl } from "@managoat/fountain-app/settings";
export type { Settings } from "@managoat/fountain-app/settings";

export const { loadSettings, saveSettings, clearSettings } = createSettings("rounds");

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
