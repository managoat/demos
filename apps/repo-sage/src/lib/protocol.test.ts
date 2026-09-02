import { describe, expect, test } from "bun:test";
import { citationsOf, foldThread, parseBlocks, stripBlocks } from "./protocol";

const MAP =
  '```repo-map\n{"repo":"o/r","default_branch":"main","description":"a demo","languages":[{"name":"Elixir","share":0.8},{"name":"TS","share":0.2}],"loc":12345,"components":[{"name":"router","path":"lib/web/router.ex","role":"routes"}],"entry_points":["lib/app.ex"],"how_it_works":"one paragraph"}\n```';
const CITES =
  '```citations\n[{"path":"lib/web/router.ex","start":14,"end":29,"why":"the route in question"},{"path":"README.md"}]\n```';

describe("parseBlocks", () => {
  test("parses a map and citations in order", () => {
    const blocks = parseBlocks(`Here.\n${MAP}\nAnd:\n${CITES}`);
    expect(blocks.map((b) => b.kind)).toEqual(["map", "citations"]);
  });

  test("map carries the dossier fields through the guards", () => {
    const [block] = parseBlocks(MAP);
    if (block?.kind !== "map") throw new Error("expected a map");
    expect(block.map.repo).toBe("o/r");
    expect(block.map.default_branch).toBe("main");
    expect(block.map.languages).toHaveLength(2);
    expect(block.map.components[0]).toEqual({ name: "router", path: "lib/web/router.ex", role: "routes" });
    expect(block.map.entry_points).toEqual(["lib/app.ex"]);
    expect(block.map.loc).toBe(12345);
  });

  test("skips malformed JSON without dropping the rest", () => {
    const blocks = parseBlocks("```repo-map\n{nope}\n```\n" + CITES);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("citations");
  });

  test("a map without repo or branch is rejected; junk citation entries are dropped", () => {
    expect(parseBlocks('```repo-map\n{"repo":"o/r"}\n```')).toHaveLength(0);
    const blocks = parseBlocks('```citations\n[{"why":"no path"},{"path":"a.ex","start":3}]\n```');
    expect(blocks).toHaveLength(1);
    if (blocks[0]!.kind !== "citations") throw new Error("expected citations");
    expect(blocks[0]!.citations).toEqual([{ path: "a.ex", start: 3 }]);
  });

  test("citation lines degrade: start only, file-level, end<start dropped", () => {
    const cites = citationsOf('```citations\n[{"path":"a.ex","start":9,"end":4},{"path":"/b.ex"}]\n```');
    expect(cites).toEqual([{ path: "a.ex", start: 9 }, { path: "b.ex" }]);
  });

  test("ignores ordinary code fences", () => {
    expect(parseBlocks("```bash\necho hi\n```")).toHaveLength(0);
  });

  test("tolerates trailing spaces after the info string", () => {
    expect(parseBlocks('```citations  \n[{"path":"x.ts"}]\n```')).toHaveLength(1);
  });
});

describe("stripBlocks", () => {
  test("removes blocks, keeps prose", () => {
    const s = stripBlocks(`Before.\n${MAP}\nAfter.`);
    expect(s).toContain("Before.");
    expect(s).toContain("After.");
    expect(s).not.toContain("repo-map");
  });
});

describe("foldThread", () => {
  test("no map yet", () => {
    expect(foldThread([{ reply: "cloning failed, repo not found" }])).toEqual({ map: null, mapTurnIndex: null });
  });

  test("the newest map wins and remembers its turn", () => {
    const map2 = MAP.replace('"loc":12345', '"loc":99');
    const view = foldThread([{ reply: MAP }, { reply: "an answer" }, { reply: map2 }]);
    expect(view.map!.loc).toBe(99);
    expect(view.mapTurnIndex).toBe(2);
  });
});
