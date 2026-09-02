import { memo, useMemo, useState, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "../lib/markdown";

/** A reply as Markdown, rendered to React elements from the parser's tree — never HTML. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="md">{blocks.map((b, i) => renderBlock(b, i))}</div>;
});

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.t) {
    case "p":
      return <p key={key}>{renderInline(b.c)}</p>;
    case "h": {
      const Tag = `h${Math.min(6, Math.max(1, b.level))}` as "h1";
      return <Tag key={key}>{renderInline(b.c)}</Tag>;
    }
    case "code":
      return <CodeBlock key={key} lang={b.lang} value={b.v} />;
    case "quote":
      return <blockquote key={key}>{b.c.map((x, i) => renderBlock(x, i))}</blockquote>;
    case "list": {
      const items = b.items.map((item, i) => <li key={i}>{item.map((x, j) => renderBlock(x, j))}</li>);
      return b.ordered ? (
        <ol key={key} start={b.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "hr":
      return <hr key={key} />;
    case "table":
      return (
        <div key={key} className="md-table">
          <table>
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i}>{renderInline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>{renderInline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return n.v;
      case "code":
        return <code key={i}>{n.v}</code>;
      case "strong":
        return <strong key={i}>{renderInline(n.c)}</strong>;
      case "em":
        return <em key={i}>{renderInline(n.c)}</em>;
      case "del":
        return <del key={i}>{renderInline(n.c)}</del>;
      case "link":
        return (
          <a key={i} href={n.href} target="_blank" rel="noreferrer noopener">
            {renderInline(n.c)}
          </a>
        );
      case "br":
        return <br key={i} />;
    }
  });
}

function CodeBlock({ lang, value }: { lang: string | null; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span className="mono muted small">{lang ?? ""}</span>
        <button
          type="button"
          className="secondary small"
          onClick={() => {
            navigator.clipboard
              .writeText(value)
              .then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => undefined);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{value}</code>
      </pre>
    </div>
  );
}
