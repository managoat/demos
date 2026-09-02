/** Token counts the way a chat app shows them: 950, 12.3k, 1.2M (after OpenMausBot's format-tokens). */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim((n / 1000).toFixed(1))}k`;
  return `${trim((n / 1_000_000).toFixed(1))}M`;
}

function trim(s: string): string {
  return s.replace(/\.0$/, "");
}

/** "12.3k in · 4.5k out", or null when there is nothing to show. */
export function formatUsage(u: { input: number; output: number } | null | undefined): string | null {
  if (!u || (!u.input && !u.output)) return null;
  return `${formatTokens(u.input)} in · ${formatTokens(u.output)} out`;
}
