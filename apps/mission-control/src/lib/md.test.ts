import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./md";

describe("renderMarkdown", () => {
  test("headings, paragraphs, emphasis, code spans", () => {
    const html = renderMarkdown("## Findings\n\nAstro is **fast** and `simple`, *really*.");
    expect(html).toContain("<h2>Findings</h2>");
    expect(html).toContain("<strong>fast</strong>");
    expect(html).toContain("<code>simple</code>");
    expect(html).toContain("<em>really</em>");
  });

  test("lists, ordered and not", () => {
    expect(renderMarkdown("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdown("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  test("fenced code is verbatim and escaped; blockquotes render", () => {
    const html = renderMarkdown("```\n<b>&\n```\n\n> said so");
    expect(html).toContain("<pre><code>&lt;b&gt;&amp;</code></pre>");
    expect(html).toContain("<blockquote><p>said so</p></blockquote>");
  });

  test("http links become anchors; javascript: does not", () => {
    expect(renderMarkdown("[docs](https://example.com)")).toContain('<a href="https://example.com"');
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("<a ");
  });

  test("HTML in agent output is escaped, never injected", () => {
    const html = renderMarkdown('<script>alert("x")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
