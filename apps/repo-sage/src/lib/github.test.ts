import { describe, expect, test } from "bun:test";
import { blobUrl, parseRepoInput, splitPathMentions } from "./github";

describe("parseRepoInput", () => {
  test("owner/name passes through", () => {
    expect(parseRepoInput("BinaryBourbon/fountain")).toBe("BinaryBourbon/fountain");
    expect(parseRepoInput("  rails/rails  ")).toBe("rails/rails");
  });

  test("full URLs, .git suffixes and trailing paths normalise", () => {
    expect(parseRepoInput("https://github.com/rails/rails")).toBe("rails/rails");
    expect(parseRepoInput("https://github.com/rails/rails.git")).toBe("rails/rails");
    expect(parseRepoInput("github.com/rails/rails/tree/main/actionpack")).toBe("rails/rails");
    expect(parseRepoInput("https://www.github.com/rails/rails")).toBe("rails/rails");
  });

  test("dots and dashes in names survive", () => {
    expect(parseRepoInput("jhgaylor/repo.sage-2")).toBe("jhgaylor/repo.sage-2");
  });

  test("garbage is rejected", () => {
    expect(parseRepoInput("")).toBeNull();
    expect(parseRepoInput("justoneword")).toBeNull();
    expect(parseRepoInput("https://gitlab.com/foo/bar")).toBeNull();
    expect(parseRepoInput("owner/")).toBeNull();
    expect(parseRepoInput("-bad/name")).toBeNull();
  });
});

describe("blobUrl", () => {
  test("full range, single line, file-level", () => {
    expect(blobUrl("o/r", "main", "lib/web/router.ex", 14, 29)).toBe(
      "https://github.com/o/r/blob/main/lib/web/router.ex#L14-L29",
    );
    expect(blobUrl("o/r", "main", "lib/app.ex", 7)).toBe("https://github.com/o/r/blob/main/lib/app.ex#L7");
    expect(blobUrl("o/r", "main", "README.md")).toBe("https://github.com/o/r/blob/main/README.md");
  });

  test("end at or before start degrades to a single line", () => {
    expect(blobUrl("o/r", "main", "a.ex", 5, 5)).toBe("https://github.com/o/r/blob/main/a.ex#L5");
  });

  test("special characters in path and branch are encoded per segment", () => {
    expect(blobUrl("o/r", "release/1.0", "docs/why not.md", 2)).toBe(
      "https://github.com/o/r/blob/release/1.0/docs/why%20not.md#L2",
    );
    expect(blobUrl("o/r", "main", "src/#tricky/[x].ts")).toBe(
      "https://github.com/o/r/blob/main/src/%23tricky/%5Bx%5D.ts",
    );
  });
});

describe("splitPathMentions", () => {
  test("links path:line mentions, leaves surrounding prose", () => {
    const segs = splitPathMentions("The route is in lib/web/router.ex:14-29 today.", "o/r", "main");
    expect(segs).toEqual([
      { kind: "text", text: "The route is in " },
      { kind: "link", text: "lib/web/router.ex:14-29", href: "https://github.com/o/r/blob/main/lib/web/router.ex#L14-L29" },
      { kind: "text", text: " today." },
    ]);
  });

  test("a bare path with an extension links; either/or prose does not", () => {
    const segs = splitPathMentions("See src/App.tsx or config/dev, either/or.", "o/r", "main");
    const links = segs.filter((s) => s.kind === "link");
    expect(links).toEqual([{ kind: "link", text: "src/App.tsx", href: "https://github.com/o/r/blob/main/src/App.tsx" }]);
  });

  test("extensionless paths link when the repo-map knows them", () => {
    const segs = splitPathMentions("Look under lib/fountain for contexts.", "o/r", "main", ["lib/fountain"]);
    expect(segs.filter((s) => s.kind === "link")).toEqual([
      { kind: "link", text: "lib/fountain", href: "https://github.com/o/r/blob/main/lib/fountain" },
    ]);
  });

  test("does not chew on URLs", () => {
    const segs = splitPathMentions("see https://github.com/o/r/blob/main/a.ts for it", "o/r", "main");
    expect(segs.filter((s) => s.kind === "link")).toEqual([]);
  });

  test("no mentions → one text segment", () => {
    expect(splitPathMentions("plain words only", "o/r", "main")).toEqual([{ kind: "text", text: "plain words only" }]);
  });
});
