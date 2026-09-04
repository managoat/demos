/**
 * Reading the box's side of the contract in `spec.ts`.
 *
 * The receipt is written by a language model, so this parser is deliberately
 * forgiving about everything except the ids. It will dig the JSON object out
 * of a file that picked up a code fence or a sentence of preamble, and it
 * drops entries it cannot understand rather than failing the whole read — a
 * receipt that parses to "four of five items" is useful, and one that throws
 * is not.
 *
 * What it will *not* do is guess. An id is only an id if it is a non-empty
 * string, and an unreadable receipt is `null` (which the panel shows as "the
 * box has not said what is on it", not as an empty box). The difference
 * matters: an empty box means reinstall everything, and we must never do that
 * on the strength of a malformed file.
 */
import type { SandboxFile } from "../api/types";

export interface ReceiptFailure {
  id: string;
  why: string;
}

/** `/home/sprite/.paddock/applied.json`, as the box last wrote it. */
export interface Receipt {
  /** The config revision the box was last brought up to. */
  rev: number | null;
  /** The runtime the box was built with, when it recorded one. */
  runtime: string | null;
  appliedAt: string | null;
  /** Canonical item ids genuinely on the machine. */
  items: string[];
  /** What the last apply could not do, and why. */
  failed: ReceiptFailure[];
}

/** The bytes of a sandbox file as text, whatever encoding it came back in. */
export function decodeFile(file: SandboxFile): string {
  if (file.encoding !== "base64") return file.content;
  try {
    const bin = atob(file.content);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

/**
 * The receipt, or null when the file is missing, empty or not JSON we can use.
 * Null is "the box has not told us", never "the box is empty".
 */
export function parseReceipt(text: string): Receipt | null {
  const obj = firstObject(text);
  if (!obj) return null;

  const items = stringArray(obj.items);
  const failed = failures(obj.failed);
  // A receipt with neither a rev nor a single item is indistinguishable from
  // noise that happened to have braces in it.
  const rev = typeof obj.rev === "number" && Number.isFinite(obj.rev) ? obj.rev : null;
  if (rev === null && items.length === 0 && failed.length === 0) return null;

  return {
    rev,
    runtime: typeof obj.runtime === "string" && obj.runtime.trim() ? obj.runtime.trim() : null,
    appliedAt: typeof obj.applied_at === "string" && obj.applied_at.trim() ? obj.applied_at.trim() : null,
    items,
    failed,
  };
}

/**
 * The JSON object in a blob of text: the whole thing when it parses, else the
 * widest `{…}` span that does. Covers a fence, a stray "Here you go:", and a
 * trailing newline of commentary, without hand-rolling a JSON scanner.
 */
function firstObject(text: string): Record<string, unknown> | null {
  const direct = asObject(text.trim());
  if (direct) return direct;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return asObject(text.slice(start, end + 1));
}

function asObject(s: string): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Non-empty strings only, trimmed, in order, without duplicates. */
function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function failures(v: unknown): ReceiptFailure[] {
  if (!Array.isArray(v)) return [];
  const out: ReceiptFailure[] = [];
  const seen = new Set<string>();
  for (const entry of v) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as { id?: unknown; why?: unknown };
    if (typeof row.id !== "string") continue;
    const id = row.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, why: typeof row.why === "string" && row.why.trim() ? row.why.trim() : "no reason given" });
  }
  return out;
}
