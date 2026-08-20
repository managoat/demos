/**
 * The patrol cadence, as the app offers it: a few presets over the schedule's
 * 5-field UTC cron. Anything else is shown as "custom" and left alone.
 */

export type Cadence = "5m" | "30m" | "hourly" | "daily";

export const DEFAULT_CRON = "*/30 * * * *";

const CRON_OF: Record<Cadence, string> = {
  "5m": "*/5 * * * *",
  "30m": "*/30 * * * *",
  hourly: "0 * * * *",
  daily: "0 0 * * *",
};

const LABEL_OF: Record<Cadence, string> = {
  "5m": "every 5 min",
  "30m": "every 30 min",
  hourly: "hourly",
  daily: "daily",
};

export const CADENCES: Cadence[] = ["5m", "30m", "hourly", "daily"];

export function cronFor(cadence: Cadence): string {
  return CRON_OF[cadence];
}

export function cadenceOf(cron: string): Cadence | null {
  const c = cron.trim().replace(/\s+/g, " ");
  for (const cadence of CADENCES) if (CRON_OF[cadence] === c) return cadence;
  return null;
}

export function cadenceLabel(cron: string): string {
  const cadence = cadenceOf(cron);
  return cadence ? LABEL_OF[cadence] : cron;
}

// ── relative time, for checked_at / last run / next run ─────────────────────

/** "just now", "4 min ago", "3 h ago", "2 d ago". */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** "in under a minute", "in 12 min", "in 3 h", "in 2 d"; "now" when past. */
export function timeUntil(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.floor((t - now) / 1000);
  if (s <= 0) return "now";
  if (s < 90) return "in under a minute";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86400)} d`;
}
