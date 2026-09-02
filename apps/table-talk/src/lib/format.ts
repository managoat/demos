/** Numbers and labels the way a person reads them. */

const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** 1234.5 → "1,234.5". Non-numbers show as a dash, never NaN. */
export function fmtNum(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n) ? nf.format(n) : "–";
}

/** Category axis labels get only so much room. */
export function truncateLabel(s: string, max = 12): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
