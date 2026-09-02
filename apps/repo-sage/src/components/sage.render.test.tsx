import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { foldThread, citationsOf } from "../lib/protocol";
import { CitationCards } from "./Citations";
import { Dossier } from "./Dossier";

// Render smoke: the dossier reads back what the sage mapped; citations become
// cards that deep-link to GitHub with encoded paths and degraded line ranges.

const MAP =
  '```repo-map\n{"repo":"o/r","default_branch":"main","description":"a demo project","languages":[{"name":"Elixir","share":0.8},{"name":"TypeScript","share":0.2}],"loc":12345,"components":[{"name":"router","path":"lib/web/router.ex","role":"maps routes"}],"entry_points":["lib/app.ex"],"how_it_works":"the router calls the contexts"}\n```';
const CITES =
  '```citations\n[{"path":"lib/web/router.ex","start":14,"end":29,"why":"the route in question"},{"path":"docs/why not.md","start":3},{"path":"README.md"}]\n```';

describe("Dossier", () => {
  test("repo, branch, loc, languages, components, entries, paragraph", () => {
    const view = foldThread([{ reply: MAP }]);
    const html = renderToString(<Dossier map={view.map!} />);
    expect(html).toContain("o/r");
    expect(html).toContain("main");
    expect(html).toContain("~12k lines");
    expect(html).toContain("Elixir 80%");
    expect(html).toContain("TypeScript 20%");
    expect(html).toContain("https://github.com/o/r/blob/main/lib/web/router.ex");
    expect(html).toContain("maps routes");
    expect(html).toContain("https://github.com/o/r/blob/main/lib/app.ex");
    expect(html).toContain("the router calls the contexts");
  });
});

describe("CitationCards", () => {
  test("range, single line and file-level citations all link correctly", () => {
    const cites = citationsOf(CITES);
    const html = renderToString(<CitationCards citations={cites} repo="o/r" branch="main" />);
    expect(html).toContain("https://github.com/o/r/blob/main/lib/web/router.ex#L14-L29");
    expect(html).toContain("lines 14–29");
    expect(html).toContain("the route in question");
    expect(html).toContain("https://github.com/o/r/blob/main/docs/why%20not.md#L3");
    expect(html).toContain("line 3");
    expect(html).toContain("https://github.com/o/r/blob/main/README.md");
    expect(html).toContain("whole file");
  });

  test("no citations renders nothing", () => {
    expect(renderToString(<CitationCards citations={[]} repo="o/r" branch="main" />)).toBe("");
  });
});
