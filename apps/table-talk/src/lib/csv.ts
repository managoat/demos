/**
 * A small, honest CSV parser — enough to preview a file and hand a clean copy
 * to the analyst. RFC 4180-ish: quoted fields, commas and newlines inside
 * quotes, `""` as an escaped quote, CRLF/CR/LF line ends. No type inference —
 * every cell stays a string; the analyst does the real work.
 */

export const MAX_BYTES = 400 * 1024;
export const MAX_ROWS = 5000;

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

/** Parse CSV text into headers (first row) + data rows. Throws on nothing usable. */
export function parseCsv(text: string): ParsedCsv {
  if (text.includes("\u0000")) throw new Error("That file doesn't look like text.");
  const grid = parseGrid(text);
  const headers = grid[0];
  if (!headers || headers.length === 0 || headers.every((h) => h.trim() === "")) {
    throw new Error("That doesn't look like a CSV — no header row found.");
  }
  const rows = grid.slice(1).filter((r) => !(r.length === 1 && r[0] === ""));
  if (rows.length === 0) throw new Error("That CSV has a header but no rows.");
  return { headers, rows };
}

function parseGrid(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const push = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    push();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      push();
      i++;
      continue;
    }
    if (ch === "\r") {
      endRow();
      i += text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** Serialize back to CSV, quoting only where needed — what gets sent to the analyst. */
export function serializeCsv(headers: string[], rows: string[][]): string {
  const cell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const line = (r: string[]) => r.map(cell).join(",");
  return [line(headers), ...rows.map(line)].join("\n");
}

export interface Dataset {
  filename: string;
  headers: string[];
  /** every row that survived the caps */
  rows: string[][];
  /** the exact text sent to the analyst */
  csvText: string;
  truncated: boolean;
  /** human sentence about what was cut, when something was */
  notice: string | null;
}

/**
 * Parse a dropped/pasted file into a dataset, applying the caps: at most
 * MAX_BYTES of text and MAX_ROWS data rows, cut at row boundaries with a
 * notice. Throws a friendly Error when it isn't a CSV at all.
 */
export function prepareDataset(filename: string, text: string): Dataset {
  const oversize = text.length > MAX_BYTES;
  const parsed = parseCsv(oversize ? withoutPartialLastRow(text.slice(0, MAX_BYTES)) : text);
  let rows = parsed.rows;
  const overRows = rows.length > MAX_ROWS;
  if (overRows) rows = rows.slice(0, MAX_ROWS);
  const truncated = oversize || overRows;
  const notice = truncated
    ? `That file is big, so only the first ${fmtCount(rows.length)} rows go to the analyst.`
    : null;
  return {
    filename,
    headers: parsed.headers,
    rows,
    csvText: serializeCsv(parsed.headers, rows),
    truncated,
    notice,
  };
}

function withoutPartialLastRow(text: string): string {
  const cut = text.lastIndexOf("\n");
  return cut > 0 ? text.slice(0, cut) : text;
}

function fmtCount(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}
