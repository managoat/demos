/**
 * The diff parser, against literal `git diff` output.
 *
 * Every fixture here is output git actually produces, pasted rather than
 * written — a diff invented to suit a parser proves the parser parses
 * inventions. The five cases below are the ones that broke a naive version:
 * a rename with no hunks, a binary file with none either, `/dev/null` standing
 * in for the missing side, the `\ No newline` marker sitting inside a hunk,
 * and the `+++`/`@@` header lines that a `+` counter counts if you let it.
 */
import { describe, expect, test } from "bun:test";
import { changeLetter, diffFor, parseDiff } from "./diff";

const MODIFIED = `diff --git a/src/index.ts b/src/index.ts
index 1111111..2222222 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a };
`;

const ADDED = `diff --git a/NOTES.md b/NOTES.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/NOTES.md
@@ -0,0 +1,2 @@
+# Notes
+Two lines.
`;

const DELETED = `diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-also gone
`;

const RENAMED = `diff --git a/a/one.ts b/b/two.ts
similarity index 100%
rename from a/one.ts
rename to b/two.ts
`;

const BINARY = `diff --git a/logo.png b/logo.png
index 5555555..6666666 100644
Binary files a/logo.png and b/logo.png differ
`;

const NO_NEWLINE = `diff --git a/tail.txt b/tail.txt
index 7777777..8888888 100644
--- a/tail.txt
+++ b/tail.txt
@@ -1 +1 @@
-before
\\ No newline at end of file
+after
\\ No newline at end of file
`;

const SPACED = `diff --git a/my docs/read me.md b/my docs/read me.md
index 9999999..aaaaaaa 100644
--- a/my docs/read me.md
+++ b/my docs/read me.md
@@ -1 +1,2 @@
 one
+two
`;

describe("parseDiff", () => {
  test("counts only the lines inside hunks", () => {
    const [file] = parseDiff(MODIFIED);
    expect(file).toEqual({ path: "src/index.ts", added: 2, removed: 1, status: "modified" });
  });

  test("an added file is added, not modified — /dev/null on the left says so", () => {
    expect(parseDiff(ADDED)[0]).toEqual({ path: "NOTES.md", added: 2, removed: 0, status: "added" });
  });

  test("a deleted file keeps its old path rather than becoming /dev/null", () => {
    expect(parseDiff(DELETED)[0]).toEqual({ path: "old.txt", added: 0, removed: 2, status: "deleted" });
  });

  test("a rename has no hunks at all and must still appear", () => {
    expect(parseDiff(RENAMED)).toEqual([{ path: "b/two.ts", added: 0, removed: 0, status: "renamed" }]);
  });

  test("a binary file is its own status, not an empty modification", () => {
    expect(parseDiff(BINARY)[0]?.status).toBe("binary");
  });

  test("the no-newline marker is not a removed line", () => {
    // A naive counter sees two `\` lines and two real changes and reports 2/2.
    expect(parseDiff(NO_NEWLINE)[0]).toEqual({ path: "tail.txt", added: 1, removed: 1, status: "modified" });
  });

  test("a path with a space survives the header", () => {
    expect(parseDiff(SPACED)[0]?.path).toBe("my docs/read me.md");
  });

  test("several files in one string", () => {
    const files = parseDiff([MODIFIED, ADDED, DELETED].join(""));
    expect(files.map((f) => f.path)).toEqual(["src/index.ts", "NOTES.md", "old.txt"]);
    expect(files.map((f) => f.status)).toEqual(["modified", "added", "deleted"]);
  });

  test("an empty diff is no files, not one empty file", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("\n \n")).toEqual([]);
  });
});

describe("diffFor", () => {
  test("returns one file's own hunks, byte for byte", () => {
    const whole = [MODIFIED, ADDED].join("");
    expect(diffFor(whole, "NOTES.md")).toBe(ADDED.trimEnd());
    expect(diffFor(whole, "src/index.ts")).toBe(MODIFIED.trimEnd());
  });

  test("finds a rename by its destination, which is not in the header", () => {
    expect(diffFor(RENAMED, "b/two.ts")).toBe(RENAMED.trimEnd());
  });

  test("a path that is not in the diff is empty, not the whole diff", () => {
    expect(diffFor(MODIFIED, "nope.ts")).toBe("");
  });
});

test("changeLetter matches what git status --short would print", () => {
  expect(changeLetter("added")).toBe("A");
  expect(changeLetter("deleted")).toBe("D");
  expect(changeLetter("renamed")).toBe("R");
  expect(changeLetter("modified")).toBe("M");
  expect(changeLetter("binary")).toBe("M");
});
