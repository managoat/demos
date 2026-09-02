import { describe, expect, test } from "bun:test";
import { inlineText, markdownToText, parseInline, parseMarkdown } from "./markdown";

describe("markdown blocks", () => {
  test("paragraphs, headings, rules", () => {
    const b = parseMarkdown("# Title\n\nfirst line\nsecond line\n\n---\n\n## Sub");
    expect(b.map((x) => x.t)).toEqual(["h", "p", "hr", "h"]);
    expect(b[0]).toMatchObject({ t: "h", level: 1 });
    expect(inlineText((b[1] as any).c)).toBe("first line\nsecond line");
  });

  test("fenced code keeps its body verbatim and its language", () => {
    const b = parseMarkdown("before\n\n```elixir\ndef a, do: **not bold**\n\n  indented\n```\nafter");
    expect(b[1]).toEqual({ t: "code", lang: "elixir", v: "def a, do: **not bold**\n\n  indented" });
    expect(b[2]).toMatchObject({ t: "p" });
    // unterminated fence swallows to the end rather than leaking as prose
    expect(parseMarkdown("```\nx\ny")[0]).toEqual({ t: "code", lang: null, v: "x\ny" });
  });

  test("bullet and numbered lists, nested by indent, with tight paragraphs", () => {
    const b = parseMarkdown("- one\n- two\n  - two.a\n  - two.b\n- three\n\n1. first\n2. second");
    expect(b).toHaveLength(2);
    const ul = b[0] as any;
    expect(ul).toMatchObject({ t: "list", ordered: false });
    expect(ul.items).toHaveLength(3);
    expect(inlineText(ul.items[1][0].c)).toBe("two");
    expect(ul.items[1][1]).toMatchObject({ t: "list", ordered: false });
    expect(ul.items[1][1].items.map((it: any) => inlineText(it[0].c))).toEqual(["two.a", "two.b"]);
    const ol = b[1] as any;
    expect(ol).toMatchObject({ t: "list", ordered: true, start: 1 });
    expect(ol.items.map((it: any) => inlineText(it[0].c))).toEqual(["first", "second"]);
  });

  test("a bold label followed by a list, the way agents write summaries", () => {
    const b = parseMarkdown("**Bottom line:** ~5 engineers for 4-5 months.\n\n- cost\n- risk");
    expect(b[0]).toMatchObject({ t: "p" });
    expect((b[0] as any).c[0]).toMatchObject({ t: "strong" });
    expect(b[1]).toMatchObject({ t: "list" });
  });

  test("blockquotes and pipe tables", () => {
    const b = parseMarkdown("> quoted\n> more\n\n| a | b |\n|---|:-:|\n| 1 | `x|y` |\n| 2 | 3 |");
    expect(b[0]).toMatchObject({ t: "quote" });
    expect(inlineText((b[0] as any).c[0].c)).toBe("quoted\nmore");
    const t = b[1] as any;
    expect(t.t).toBe("table");
    expect(t.head.map(inlineText)).toEqual(["a", "b"]);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0][1][0]).toEqual({ t: "code", v: "x|y" });
  });

  test("a bare '- - -' is a rule, '- item' is a list", () => {
    expect(parseMarkdown("- - -")[0]).toEqual({ t: "hr" });
    expect(parseMarkdown("- item")[0]).toMatchObject({ t: "list" });
  });
});

describe("markdown inline", () => {
  test("strong, em, del, code, escapes", () => {
    expect(parseInline("**b** *i* _i2_ ~~d~~ `c` \\*lit\\*")).toEqual([
      { t: "strong", c: [{ t: "text", v: "b" }] },
      { t: "text", v: " " },
      { t: "em", c: [{ t: "text", v: "i" }] },
      { t: "text", v: " " },
      { t: "em", c: [{ t: "text", v: "i2" }] },
      { t: "text", v: " " },
      { t: "del", c: [{ t: "text", v: "d" }] },
      { t: "text", v: " " },
      { t: "code", v: "c" },
      { t: "text", v: " *lit*" },
    ]);
  });

  test("underscores inside identifiers are not emphasis", () => {
    expect(parseInline("snake_case_name and __init__")).toEqual([{ t: "text", v: "snake_case_name and " }, { t: "strong", c: [{ t: "text", v: "init" }] }]);
    expect(inlineText(parseInline("a_b_c"))).toBe("a_b_c");
  });

  test("links: only http(s)/mailto keep their href; javascript: is dropped to text", () => {
    expect(parseInline("see [docs](https://example.com/x \"t\") now")).toEqual([
      { t: "text", v: "see " },
      { t: "link", href: "https://example.com/x", c: [{ t: "text", v: "docs" }] },
      { t: "text", v: " now" },
    ]);
    expect(parseInline("[x](javascript:alert(1))")).toEqual([{ t: "text", v: "x" }]);
    expect(parseInline("go to https://a.b/c, ok")).toEqual([
      { t: "text", v: "go to " },
      { t: "link", href: "https://a.b/c", c: [{ t: "text", v: "https://a.b/c" }] },
      { t: "text", v: ", ok" },
    ]);
  });

  test("hard breaks and unmatched delimiters stay literal", () => {
    expect(parseInline("a  \nb")).toEqual([{ t: "text", v: "a" }, { t: "br" }, { t: "text", v: "b" }]);
    expect(inlineText(parseInline("2 * 3 * 4"))).toBe("2 * 3 * 4");
    expect(inlineText(parseInline("price *unclosed"))).toBe("price *unclosed");
    expect(inlineText(parseInline("`unclosed"))).toBe("`unclosed");
  });
});

describe("markdownToText", () => {
  test("flattens for a preview line", () => {
    expect(markdownToText("**Bottom line:** ~5 engineers\n\n- cost\n- risk\n\n`x`")).toBe("Bottom line: ~5 engineers cost risk x");
  });
});

