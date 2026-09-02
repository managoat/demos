/**
 * A small, safe Markdown parser for chat bubbles (after OpenMausBot's
 * ChatMarkdown, minus the dependency): the subset agents actually write —
 * paragraphs, headings, bold / italic / strikethrough, inline code, fenced
 * and indented code, links, bullet and numbered lists (nested by indent),
 * blockquotes, rules, and pipe tables. It produces a tree, never HTML, so
 * the renderer emits React elements and nothing an agent writes can inject
 * markup; only http(s)/mailto links are kept as links.
 */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "code"; lang: string | null; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "hr" }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] };

export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, "\n").split("\n"));
}

// ── blocks ─────────────────────────────────────────────────────────────────

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const NUMBER = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  const flushPara = (buf: string[]) => {
    if (buf.length) out.push({ t: "p", c: parseInline(buf.join("\n")) });
    buf.length = 0;
  };
  const para: string[] = [];

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      flushPara(para);
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flushPara(para);
      const marker = fence[2]!;
      const lang = fence[3] || null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // closing fence (or EOF)
      out.push({ t: "code", lang, v: body.join("\n") });
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      flushPara(para);
      out.push({ t: "h", level: h[1]!.length, c: parseInline(h[2]!) });
      i++;
      continue;
    }

    if (HR.test(line)) {
      flushPara(para);
      out.push({ t: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      flushPara(para);
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        inner.push(QUOTE.exec(lines[i]!)![1]!);
        i++;
      }
      out.push({ t: "quote", c: parseBlocks(inner) });
      continue;
    }

    if (BULLET.test(line) || NUMBER.test(line)) {
      flushPara(para);
      const [list, next] = parseList(lines, i);
      out.push(list);
      i = next;
      continue;
    }

    // indented code (4 spaces / tab) only when it does not continue a paragraph
    if (/^(\t| {4})/.test(line) && para.length === 0) {
      const body: string[] = [];
      while (i < lines.length && (/^(\t| {4})/.test(lines[i]!) || (!lines[i]!.trim() && i + 1 < lines.length && /^(\t| {4})/.test(lines[i + 1]!)))) {
        body.push(lines[i]!.replace(/^(\t| {4})/, ""));
        i++;
      }
      out.push({ t: "code", lang: null, v: body.join("\n") });
      continue;
    }

    // pipe table: header row, separator row, body rows
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      flushPara(para);
      const head = splitRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
        rows.push(splitRow(lines[i]!).map(parseInline));
        i++;
      }
      out.push({ t: "table", head, rows });
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara(para);
  return out;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // split on unescaped pipes outside inline code
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k]!;
    if (ch === "`") inCode = !inCode;
    if (ch === "\\" && s[k + 1] === "|") {
      cur += "|";
      k++;
      continue;
    }
    if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** Parse a list starting at lines[i]; returns the list and the next index. */
function parseList(lines: string[], i: number): [Block, number] {
  const first = (BULLET.exec(lines[i]!) ?? NUMBER.exec(lines[i]!))!;
  const ordered = /\d/.test(first[2]!);
  const indent = first[1]!.length;
  const start = ordered ? Number(first[2]) : 1;
  const items: Block[][] = [];
  let cur: string[] | null = null;
  const contentIndent = () => indent + first[2]!.length + 1;

  const flush = () => {
    if (cur) items.push(parseBlocks(cur));
    cur = null;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const m = BULLET.exec(line) ?? NUMBER.exec(line);
    if (m && m[1]!.length === indent && /\d/.test(m[2]!) === ordered) {
      flush();
      cur = [m[3]!];
      i++;
      continue;
    }
    if (!line.trim()) {
      // blank line: the list continues only if the next non-blank line is indented under it
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trim()) j++;
      if (j < lines.length && (/^\s+/.test(lines[j]!) && leadingSpaces(lines[j]!) >= contentIndent() - 1) && cur) {
        cur.push("");
        i++;
        continue;
      }
      break;
    }
    if (m && m[1]!.length > indent && cur) {
      // nested list: hand the indented run to the item's own parse
      cur.push(line.slice(Math.min(contentIndent(), leadingSpaces(line))));
      i++;
      continue;
    }
    if (leadingSpaces(line) >= contentIndent() - 1 && cur) {
      cur.push(line.slice(Math.min(contentIndent(), leadingSpaces(line))));
      i++;
      continue;
    }
    if (cur && !m && leadingSpaces(line) < contentIndent() && line.trim() && !HEADING.test(line) && !FENCE.test(line) && !QUOTE.test(line)) {
      // lazy continuation of the item's paragraph
      cur.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  flush();
  return [{ t: "list", ordered, start, items }, i];
}

function leadingSpaces(s: string): number {
  return /^\s*/.exec(s)![0]!.length;
}

// ── inline ─────────────────────────────────────────────────────────────────

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;

    // hard break: two spaces or backslash before newline
    if (ch === "\n") {
      if (text.endsWith("  ") || text.endsWith("\\")) {
        text = text.replace(/(  |\\)$/, "");
        flush();
        out.push({ t: "br" });
      } else {
        text += "\n";
      }
      i++;
      continue;
    }

    if (ch === "\\" && i + 1 < src.length && /[\\`*_{}\[\]()#+\-.!|~>]/.test(src[i + 1]!)) {
      text += src[i + 1]!;
      i += 2;
      continue;
    }

    if (ch === "`") {
      const run = /^`+/.exec(src.slice(i))![0]!;
      const close = src.indexOf(run, i + run.length);
      if (close !== -1) {
        flush();
        let v = src.slice(i + run.length, close);
        if (v.startsWith(" ") && v.endsWith(" ") && v.trim()) v = v.slice(1, -1);
        out.push({ t: "code", v });
        i = close + run.length;
        continue;
      }
    }

    if (ch === "[") {
      const link = matchLink(src, i);
      if (link) {
        flush();
        const inner = parseInline(link.label);
        if (SAFE_HREF.test(link.href)) out.push({ t: "link", href: link.href, c: inner });
        else out.push(...inner);
        i = link.end;
        continue;
      }
    }

    // autolink: bare URL
    if ((ch === "h" || ch === "H") && /^https?:\/\/[^\s<>()]+/i.test(src.slice(i))) {
      const m = /^https?:\/\/[^\s<>()]+/i.exec(src.slice(i))![0]!.replace(/[.,;:!?'"]+$/, "");
      flush();
      out.push({ t: "link", href: m, c: [{ t: "text", v: m }] });
      i += m.length;
      continue;
    }

    if (ch === "*" || ch === "_" || ch === "~") {
      const em = matchEmphasis(src, i);
      if (em) {
        flush();
        out.push({ t: em.kind, c: parseInline(em.inner) });
        i = em.end;
        continue;
      }
    }

    text += ch;
    i++;
  }
  flush();
  return out;
}

function matchLink(src: string, i: number): { label: string; href: string; end: number } | null {
  // [label](href "title") with one level of nested brackets in the label
  let depth = 0;
  let j = i;
  for (; j < src.length; j++) {
    if (src[j] === "[") depth++;
    else if (src[j] === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (j >= src.length || src[j + 1] !== "(") return null;
  const label = src.slice(i + 1, j);
  let k = j + 2;
  let paren = 1;
  for (; k < src.length; k++) {
    if (src[k] === "(") paren++;
    else if (src[k] === ")") {
      paren--;
      if (paren === 0) break;
    }
  }
  if (k >= src.length) return null;
  const dest = src.slice(j + 2, k).trim();
  const href = dest.replace(/\s+("[^"]*"|'[^']*')$/, "").replace(/^<(.*)>$/, "$1");
  return { label, href, end: k + 1 };
}

function matchEmphasis(src: string, i: number): { kind: "strong" | "em" | "del"; inner: string; end: number } | null {
  const ch = src[i]!;
  const run = ch === "~" ? (src[i + 1] === "~" ? "~~" : null) : src[i + 1] === ch ? ch + ch : ch;
  if (!run) return null;
  const after = src[i + run.length];
  if (after === undefined || /\s/.test(after)) return null; // opening delimiter must be followed by non-space
  // underscore emphasis must not be inside a word
  if (ch === "_" && i > 0 && /\w/.test(src[i - 1]!)) return null;
  let j = i + run.length;
  while (j < src.length) {
    const close = src.indexOf(run, j);
    if (close === -1) return null;
    const before = src[close - 1]!;
    const afterClose = src[close + run.length];
    const wordAfter = afterClose !== undefined && /\w/.test(afterClose);
    if (!/\s/.test(before) && !(ch === "_" && wordAfter) && close > i + run.length) {
      // for single-char runs, make sure we're not closing on the first char of a double run
      if (run.length === 1 && src[close + 1] === ch && ch !== "~") {
        j = close + 2;
        continue;
      }
      return { kind: run === "~~" ? "del" : run.length === 2 ? "strong" : "em", inner: src.slice(i + run.length, close), end: close + run.length };
    }
    j = close + run.length;
  }
  return null;
}

/** Plain text of an inline run (for previews and tests). */
export function inlineText(nodes: Inline[]): string {
  return nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "br" ? "\n" : inlineText(n.c))).join("");
}

/** One-line plain text of a markdown snippet, for previews and notifications. */
export function markdownToText(src: string): string {
  const parts: string[] = [];
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.t === "p" || b.t === "h") parts.push(inlineText(b.c));
      else if (b.t === "code") parts.push(b.v);
      else if (b.t === "quote") walk(b.c);
      else if (b.t === "list") for (const item of b.items) walk(item);
      else if (b.t === "table") parts.push(b.head.map(inlineText).join(" "));
    }
  };
  walk(parseMarkdown(src));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

