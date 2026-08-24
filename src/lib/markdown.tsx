/**
 * The little markdown a transcript needs, rendered to React nodes — no
 * innerHTML, so nothing an agent writes can become markup. Paragraphs,
 * headings, fenced code, bullet and numbered lists, blockquotes, and inline
 * code / bold / italic / links. Anything else is text.
 */
import type { ReactNode } from "react";

export function renderMarkdown(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const k = () => `m${key++}`;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i++;
      continue;
    }

    // fenced code
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const close = fence[1]!;
      const lang = fence[2] || undefined;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${close}\\s*$`).test(lines[i]!)) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // closing fence (or EOF)
      out.push(
        <pre key={k()} className="md-code" data-lang={lang}>
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const Tag = (`h${Math.min(level + 2, 6)}`) as "h3" | "h4" | "h5" | "h6";
      out.push(<Tag key={k()} className="md-h">{inline(h[2]!)}</Tag>);
      i++;
      continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        buf.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i++;
      }
      out.push(<blockquote key={k()}>{renderMarkdown(buf.join("\n"))}</blockquote>);
      continue;
    }

    // lists
    const bullet = /^\s*[-*+]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const re = ordered ? numbered : bullet;
      const items: ReactNode[] = [];
      while (i < lines.length && re.test(lines[i]!)) {
        let text = lines[i]!.replace(re, "");
        i++;
        // continuation lines (indented) belong to the item
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !re.test(lines[i]!)) {
          text += "\n" + lines[i]!.trim();
          i++;
        }
        // a checklist: "- [ ] thing" / "- [x] thing" — a box, not brackets
        const task = /^\[([ xX])\]\s+/.exec(text);
        if (task) {
          items.push(
            <li key={k()} className="md-task">
              <input type="checkbox" checked={task[1] !== " "} disabled readOnly />
              <span>{inline(text.slice(task[0].length))}</span>
            </li>,
          );
          continue;
        }
        items.push(<li key={k()}>{inline(text)}</li>);
      }
      out.push(ordered ? <ol key={k()}>{items}</ol> : <ul key={k()}>{items}</ul>);
      continue;
    }

    // paragraph: consecutive non-blank, non-special lines
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^\s*(```|~~~)/.test(lines[i]!) &&
      !/^(#{1,6})\s+/.test(lines[i]!) &&
      !bullet.test(lines[i]!) &&
      !numbered.test(lines[i]!) &&
      !/^\s*>\s?/.test(lines[i]!)
    ) {
      buf.push(lines[i]!);
      i++;
    }
    if (buf.length) out.push(<p key={k()}>{inline(buf.join("\n"))}</p>);
  }
  return out;
}

/** Inline: `code`, **bold**, *italic* / _italic_, [text](url), bare URLs. */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re =
    /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (m[1]) out.push(<code key={key++}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key++}>{inline(tok.slice(2, -2))}</strong>);
    else if (m[3]) out.push(<em key={key++}>{inline(tok.slice(1, -1))}</em>);
    else if (m[4]) {
      const label = tok.slice(1, tok.indexOf("]("));
      out.push(
        <a key={key++} href={m[5]} target="_blank" rel="noreferrer noopener">
          {label}
        </a>,
      );
    } else if (m[6]) {
      const url = tok.replace(/[.,;:!?)]+$/, "");
      const trail = tok.slice(url.length);
      out.push(
        <a key={key++} href={url} target="_blank" rel="noreferrer noopener">
          {url}
        </a>,
      );
      if (trail) out.push(trail);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
