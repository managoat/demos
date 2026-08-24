export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " " +
        d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** A day, no clock: billing periods and trial ends are dates, and the time of day is noise. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Big counts at a glance: 812, 1.3k, 47k, 2.4M. Token totals are long and nobody reads the digits. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  const round = (x: number) => String(Math.round(x * 10) / 10);
  if (abs >= 1e9) return round(n / 1e9) + "B";
  if (abs >= 1e6) return round(n / 1e6) + "M";
  if (abs >= 1e4) return String(Math.round(n / 1e3)) + "k";
  if (abs >= 1e3) return round(n / 1e3) + "k";
  return String(Math.round(n));
}

/** Turn hours, in the unit that reads: minutes under the hour, hours over it. */
export function formatHours(h: number | null | undefined): string {
  if (h === null || h === undefined || !Number.isFinite(h)) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  return `${Math.round(h * 10) / 10} h`;
}

/** Turn time measured in seconds, in the unit that reads: seconds under the minute, then minutes, then hours. */
export function formatTurnTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  if (seconds <= 0) return "0";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  return formatHours(seconds / 3600);
}

/** Fountain prices plans in USD cents, and shows whole dollars when it can (`Fountain.Plans.format_usd/1`). */
export function formatUsd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/** A conversation's display line: its title, else a trimmed first prompt, else the id. */
export function conversationLabel(c: { title?: string | null; id: string }, firstPrompt?: string | null): string {
  if (c.title) return c.title;
  if (firstPrompt) {
    const t = firstPrompt.replace(/\s+/g, " ").trim();
    return t.length > 80 ? t.slice(0, 80) + "…" : t;
  }
  return shortId(c.id);
}
