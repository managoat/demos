import { describe, expect, test } from "bun:test";
import { decodeFile, parseReceipt } from "./protocol";

const good = JSON.stringify({
  rev: 7,
  runtime: "claude",
  applied_at: "2026-09-04T10:00:00Z",
  items: ["pkg:ripgrep", "setup:1a2b3c4d"],
  failed: [{ id: "pkg:jq", why: "apt could not find it" }],
});

describe("parseReceipt", () => {
  test("a well-formed receipt reads back whole", () => {
    const r = parseReceipt(good)!;
    expect(r.rev).toBe(7);
    expect(r.runtime).toBe("claude");
    expect(r.appliedAt).toBe("2026-09-04T10:00:00Z");
    expect(r.items).toEqual(["pkg:ripgrep", "setup:1a2b3c4d"]);
    expect(r.failed).toEqual([{ id: "pkg:jq", why: "apt could not find it" }]);
  });

  test("a model's preamble and code fence do not stop it", () => {
    const wrapped = "Here you go:\n\n```json\n" + good + "\n```\n";
    expect(parseReceipt(wrapped)?.items).toEqual(["pkg:ripgrep", "setup:1a2b3c4d"]);
  });

  test("missing, empty and non-JSON files are null, not an empty box", () => {
    // The distinction the whole apply flow rests on: null means "the machine
    // has not said", which must never be read as "nothing is installed".
    expect(parseReceipt("")).toBeNull();
    expect(parseReceipt("   \n ")).toBeNull();
    expect(parseReceipt("not json at all")).toBeNull();
    expect(parseReceipt("{ oops")).toBeNull();
    expect(parseReceipt("[1,2,3]")).toBeNull();
  });

  test("braces with nothing usable in them are null too", () => {
    expect(parseReceipt('{"hello":"world"}')).toBeNull();
  });

  test("a receipt with items but no rev still counts", () => {
    const r = parseReceipt('{"items":["pkg:ripgrep"]}')!;
    expect(r.rev).toBeNull();
    expect(r.items).toEqual(["pkg:ripgrep"]);
  });

  test("junk entries are dropped, not fatal, and ids are de-duplicated", () => {
    const r = parseReceipt(
      JSON.stringify({ rev: 1, items: ["pkg:a", 42, "", "  pkg:b  ", "pkg:a", null], failed: ["nope", { why: "no id" }, { id: "pkg:c" }] }),
    )!;
    expect(r.items).toEqual(["pkg:a", "pkg:b"]);
    expect(r.failed).toEqual([{ id: "pkg:c", why: "no reason given" }]);
  });

  test("a bad rev or runtime falls back rather than throwing", () => {
    const r = parseReceipt('{"rev":"seven","runtime":"  ","items":["pkg:a"]}')!;
    expect(r.rev).toBeNull();
    expect(r.runtime).toBeNull();
  });
});

describe("decodeFile", () => {
  test("text passes through", () => {
    expect(decodeFile({ path: "/x", size: 2, truncated: false, encoding: "utf8", content: "hi" })).toBe("hi");
  });

  test("base64 is decoded, including multi-byte characters", () => {
    const content = btoa(String.fromCharCode(...new TextEncoder().encode('{"rev":1,"items":["π"]}')));
    expect(decodeFile({ path: "/x", size: 0, truncated: false, encoding: "base64", content })).toBe('{"rev":1,"items":["π"]}');
  });

  test("undecodable base64 is empty rather than an exception", () => {
    expect(decodeFile({ path: "/x", size: 0, truncated: false, encoding: "base64", content: "!!!!" })).toBe("");
  });
});
