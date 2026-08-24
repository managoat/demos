/**
 * The find bar's copy. The ordering and the keyboard rule are tested in
 * src/lib/search.test.ts; this is here because the bar is the only place the
 * two things a reader cannot guess get said — that the turn still running has
 * no reply to match yet, and that matching is whole words, not prose.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FindBar } from "./ThreadFind";

const bar = (over: Partial<Parameters<typeof FindBar>[0]> = {}) =>
  renderToStaticMarkup(
    <FindBar
      q="gate"
      onQ={() => {}}
      onKeyDown={() => {}}
      count={3}
      index={1}
      onStep={() => {}}
      onClose={() => {}}
      searching={false}
      error={null}
      hasMore={false}
      pending={false}
      {...over}
    />,
  );

describe("FindBar", () => {
  test("where you are in the hits, counted from one", () => {
    expect(bar()).toContain("2 of 3");
  });

  test("the window was full, so there may be more below it", () => {
    expect(bar({ hasMore: true })).toContain("2 of 3+");
  });

  test("nothing typed yet: what the matching is actually like", () => {
    const html = bar({ q: "  ", count: 0 });
    expect(html).toContain("whole words");
    expect(html).toContain("-excluded");
    expect(html).not.toContain("no match");
  });

  test("a turn in flight has no reply to match yet, and says so rather than looking broken", () => {
    expect(bar({ pending: true })).toContain("the turn still running will match once it ends");
    expect(bar({ pending: false })).not.toContain("still running");
  });

  test("searching, then nothing — two different answers", () => {
    expect(bar({ count: 0, searching: true })).toContain("searching…");
    expect(bar({ count: 0, searching: false })).toContain("no match");
  });

  test("a failed search says why, and the steps go dead rather than lying", () => {
    const html = bar({ count: 0, error: "Fountain said no." });
    expect(html).toContain("Fountain said no.");
    expect(html).toContain("disabled");
  });
});
