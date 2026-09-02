/**
 * Just enough cron for the routines form: presets people actually pick,
 * a shape check for a custom expression (five fields, or a `@name` the
 * server accepts), and a human line for the presets. The server evaluates
 * expressions in UTC and is the authority — `next_run_at` comes back from
 * it — so nothing here computes run times.
 */

export interface CronPreset {
  cron: string;
  label: string;
}

export const CRON_PRESETS: CronPreset[] = [
  { cron: "0 9 * * 1-5", label: "Weekdays at 09:00 UTC" },
  { cron: "0 9 * * *", label: "Every day at 09:00 UTC" },
  { cron: "0 * * * *", label: "Every hour" },
  { cron: "*/30 * * * *", label: "Every 30 minutes" },
  { cron: "0 9 * * 1", label: "Mondays at 09:00 UTC" },
  { cron: "0 0 1 * *", label: "First of the month, 00:00 UTC" },
];

const NAMES = new Set(["@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly"]);
const FIELD = /^(\*|\d+)(-\d+)?(\/\d+)?(,(\*|\d+)(-\d+)?(\/\d+)?)*$/;

/** A five-field expression, or a supported @name. Not a full validator — a shape check so a typo does not reach the server. */
export function isCronLike(s: string): boolean {
  const t = s.trim();
  if (NAMES.has(t.toLowerCase())) return true;
  const fields = t.split(/\s+/);
  return fields.length === 5 && fields.every((f) => FIELD.test(f) || /^[a-z]{3}(-[a-z]{3})?(,[a-z]{3}(-[a-z]{3})?)*$/i.test(f));
}

export function describeCron(cron: string): string {
  const t = cron.trim();
  return CRON_PRESETS.find((p) => p.cron === t)?.label ?? `${t} (UTC)`;
}
