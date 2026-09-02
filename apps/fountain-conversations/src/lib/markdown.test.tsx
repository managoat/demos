import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "./markdown";

const html = (s: string) => renderToStaticMarkup(<>{renderMarkdown(s)}</>);

describe("renderMarkdown", () => {
  test("paragraphs, bold, italic, code, links", () => {
    expect(html("Hi **there** _you_ `x` [doc](https://a.b/c)")).toBe(
      '<p>Hi <strong>there</strong> <em>you</em> <code>x</code> <a href="https://a.b/c" target="_blank" rel="noreferrer noopener">doc</a></p>',
    );
  });

  test("fenced code keeps its content verbatim and escapes markup", () => {
    expect(html("```elixir\n<b>x</b> **y**\n```")).toBe(
      '<pre class="md-code" data-lang="elixir"><code>&lt;b&gt;x&lt;/b&gt; **y**</code></pre>',
    );
  });

  test("lists and headings", () => {
    expect(html("## Title\n- one\n- two\n\n1. a\n2. b")).toBe(
      '<h4 class="md-h">Title</h4><ul><li>one</li><li>two</li></ul><ol><li>a</li><li>b</li></ol>',
    );
  });

  test("bare urls become links and trailing punctuation stays out", () => {
    expect(html("see https://x.y/z.")).toBe(
      '<p>see <a href="https://x.y/z" target="_blank" rel="noreferrer noopener">https://x.y/z</a>.</p>',
    );
  });

  test("raw html is text, never markup", () => {
    expect(html("<script>alert(1)</script>")).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  });
});
