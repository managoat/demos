import { describe, expect, test } from "bun:test";
import { absolutePath, diffLines, splitDiff, statusLetter } from "./diff";

/**
 * Not a diff somebody typed out to suit the parser: this is the literal output
 * of `git diff --cached` on a repository with one of each kind of change in
 * it. Every awkward shape git actually emits is in here — a binary file with
 * no hunks at all, a pure rename with no hunks either, a delete whose new side
 * is `/dev/null`, and a new file ending without a newline, which is the case
 * that makes a naive `+` counter over-count by one.
 */
const REAL = `diff --git a/README.md b/README.md
index 9a6f86a..0f943ed 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,4 @@
 # Title

-old line
+new line
+and another
diff --git a/blob.bin b/blob.bin
index 9591b17..6459c29 100644
Binary files a/blob.bin and b/blob.bin differ
diff --git a/doomed.txt b/doomed.txt
deleted file mode 100644
index 286c5f5..0000000
--- a/doomed.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/oldname.ts b/newname.ts
similarity index 100%
rename from oldname.ts
rename to newname.ts
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..747f7ec
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1 @@
+export function hi() {}
\\ No newline at end of file
diff --git a/src/util.ts b/src/util.ts
index 64a32fd..c8b50d4 100644
--- a/src/util.ts
+++ b/src/util.ts
@@ -1 +1,2 @@
 export const answer = 42;
+export const more = 1;
`;

describe("splitDiff", () => {
  const files = splitDiff(REAL);

  test("one entry per file, in the order git printed them", () => {
    expect(files.map((f) => f.path)).toEqual(["README.md", "blob.bin", "doomed.txt", "newname.ts", "src/new.ts", "src/util.ts"]);
  });

  test("the status is the one git stated, not one inferred from the counts", () => {
    expect(files.map((f) => f.status)).toEqual(["modified", "modified", "deleted", "renamed", "added", "modified"]);
  });

  test("a rename remembers where it came from", () => {
    const renamed = files.find((f) => f.status === "renamed")!;
    expect(renamed.path).toBe("newname.ts");
    expect(renamed.from).toBe("oldname.ts");
    // No hunks: git said `similarity index 100%` and stopped.
    expect(renamed.additions).toBe(0);
    expect(renamed.deletions).toBe(0);
  });

  test("counts only hunk content", () => {
    const readme = files.find((f) => f.path === "README.md")!;
    expect(readme.additions).toBe(2);
    expect(readme.deletions).toBe(1);
    // `--- a/README.md` and `+++ b/README.md` are the header. Counting them is
    // the classic bug and would make this 3 and 2.
    const util = files.find((f) => f.path === "src/util.ts")!;
    expect([util.additions, util.deletions]).toEqual([1, 0]);
  });

  test("`\\ No newline at end of file` is git talking, not a changed line", () => {
    const added = files.find((f) => f.path === "src/new.ts")!;
    expect(added.additions).toBe(1);
    expect(added.deletions).toBe(0);
  });

  test("a binary file is flagged rather than shown as an empty change", () => {
    const blob = files.find((f) => f.path === "blob.bin")!;
    expect(blob.binary).toBe(true);
    expect(blob.additions).toBe(0);
    // The paths come off the `diff --git` line, because a binary section has
    // no `---`/`+++` to read them from.
    expect(blob.path).toBe("blob.bin");
  });

  test("a delete keeps the path that went away", () => {
    const gone = files.find((f) => f.status === "deleted")!;
    // `+++ /dev/null` is not a path, and taking it as one used to leave the
    // row labelled `dev/null`.
    expect(gone.path).toBe("doomed.txt");
    expect(gone.deletions).toBe(1);
  });

  test("each body is that file's section and nothing else", () => {
    const readme = files[0]!;
    expect(readme.body.startsWith("diff --git a/README.md")).toBe(true);
    expect(readme.body).not.toContain("blob.bin");
    expect(readme.body.trimEnd().endsWith("+and another")).toBe(true);
  });

  test("nothing to parse means nothing, and the caller shows the raw text", () => {
    expect(splitDiff("")).toEqual([]);
    expect(splitDiff("   \n")).toEqual([]);
    // Not git's output at all — better to hand it back whole than to invent files.
    expect(splitDiff("fatal: not a git repository")).toEqual([]);
  });
});

describe("diffLines", () => {
  const body = splitDiff(REAL)[0]!.body;
  const lines = diffLines(body);

  test("numbers advance down each side independently", () => {
    const content = lines.filter((l) => l.kind !== "meta" && l.kind !== "hunk");
    expect(content.map((l) => [l.kind, l.old, l.new])).toEqual([
      ["context", 1, 1],
      ["context", 2, 2],
      ["del", 3, null],
      ["add", null, 3],
      ["add", null, 4],
    ]);
  });

  test("the hunk header sets the starting numbers and carries none of its own", () => {
    const hunk = lines.find((l) => l.kind === "hunk")!;
    expect(hunk.text).toBe("@@ -1,3 +1,4 @@");
    expect([hunk.old, hunk.new]).toEqual([null, null]);
  });

  test("everything before the first hunk is header, whatever it starts with", () => {
    // `--- a/README.md` and `+++ b/README.md` open with the same characters as
    // a changed line and are not one.
    expect(lines.slice(0, 4).every((l) => l.kind === "meta")).toBe(true);
    expect(lines[3]!.text).toBe("+++ b/README.md");
  });

  test("a hunk that starts at line 1 of a new file numbers from 1", () => {
    const added = splitDiff(REAL).find((f) => f.path === "src/new.ts")!;
    const only = diffLines(added.body).find((l) => l.kind === "add")!;
    expect([only.old, only.new]).toEqual([null, 1]);
  });

  test("`\\ No newline` is a marker, not a line of the file", () => {
    const added = splitDiff(REAL).find((f) => f.path === "src/new.ts")!;
    const last = diffLines(added.body).at(-1)!;
    expect(last.kind).toBe("meta");
    expect(last.new).toBeNull();
  });

  test("a blank context line survives whatever trimmed its leading space", () => {
    const trimmed = diffLines("@@ -1,2 +1,2 @@\n line\n\n-a\n+b");
    expect(trimmed.filter((l) => l.kind === "context").map((l) => l.new)).toEqual([1, 2]);
  });

  test("a `diff --git` line ends the hunk before it", () => {
    // The whole-diff view feeds every file through here at once. Without the
    // reset, the next file's `--- a/x` counts as a deleted line and every
    // number after it is wrong.
    const all = diffLines(REAL);
    const headers = all.filter((l) => l.text.startsWith("--- ") || l.text.startsWith("+++ "));
    expect(headers.length).toBeGreaterThan(0);
    expect(headers.every((l) => l.kind === "meta")).toBe(true);
    // The last file starts numbering from its own hunk header, not from a
    // count that has been drifting since the first one.
    const last = all.filter((l) => l.kind === "add").at(-1)!;
    expect(last.new).toBe(2);
  });

  test("a single-line hunk header has no comma and still parses", () => {
    // `@@ -1 +1,2 @@` — git drops the count when it is 1.
    const util = splitDiff(REAL).find((f) => f.path === "src/util.ts")!;
    const added = diffLines(util.body).find((l) => l.kind === "add")!;
    expect(added.new).toBe(2);
  });
});

describe("absolutePath", () => {
  test("joins the repo root git reported to the path git printed", () => {
    // The diff route answers with `repo_root`; the file route wants an
    // absolute path. Nothing else knows how to get from one to the other.
    expect(absolutePath("/home/sprite/work/t1", "src/index.ts")).toBe("/home/sprite/work/t1/src/index.ts");
    expect(absolutePath("/home/sprite/work/t1/", "src/index.ts")).toBe("/home/sprite/work/t1/src/index.ts");
  });
});

describe("statusLetter", () => {
  test("the letters `git status --short` already taught everyone", () => {
    expect(["added", "modified", "deleted", "renamed"].map((s) => statusLetter(s as never))).toEqual(["A", "M", "D", "R"]);
  });
});
