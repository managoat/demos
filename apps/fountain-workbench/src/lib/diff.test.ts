import { describe, expect, test } from "bun:test";
import { basename, parseStatus, parseUnifiedDiff } from "./diff";

const DIFF = `diff --git a/README.md b/README.md
index 3b18e51..a0423b6 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,4 @@
 # Title
-old line
+new line
+another
 tail
\\ No newline at end of file
diff --git a/SMOKE.md b/SMOKE.md
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/SMOKE.md
@@ -0,0 +1 @@
+snapshot smoke
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index e69de29..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/a.png b/a.png
Binary files a/a.png and b/a.png differ
`;

describe("parseUnifiedDiff", () => {
  const files = parseUnifiedDiff(DIFF);

  test("one file per header, with its status", () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["README.md", "modified"],
      ["SMOKE.md", "added"],
      ["gone.txt", "deleted"],
      ["a.png", "binary"],
    ]);
  });

  test("lines are numbered on the side they are on, and counted", () => {
    const readme = files[0]!;
    expect(readme.additions).toBe(2);
    expect(readme.deletions).toBe(1);
    expect(readme.hunks).toHaveLength(1);
    expect(readme.hunks[0]!.header).toBe("@@ -1,3 +1,4 @@");
    expect(readme.hunks[0]!.lines.map((l) => [l.kind, l.old, l.new])).toEqual([
      ["context", 1, 1],
      ["del", 2, null],
      ["add", null, 2],
      ["add", null, 3],
      ["context", 3, 4],
      ["meta", null, null],
    ]);
    expect(readme.hunks[0]!.lines[2]!.text).toBe("new line");
  });

  test("an added file has no old path; a deleted one no new path; a binary one no hunks", () => {
    expect(files[1]!.oldPath).toBeNull();
    expect(files[2]!.newPath).toBeNull();
    expect(files[2]!.path).toBe("gone.txt");
    expect(files[3]!.hunks).toHaveLength(0);
  });

  test("an empty diff is no files", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("\n")).toEqual([]);
  });
});

describe("parseStatus", () => {
  const STATUS = [
    "# branch.oid 53b9d1a325b6145d29224ab5ef81c4a112a7203e",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +1 -2",
    "1 .M N... 100644 100644 100644 3b18e51 3b18e51 README.md",
    "1 A. N... 000000 100644 100644 0000000 e69de29 src/new thing.ts",
    "1 .D N... 100644 100644 000000 e69de29 e69de29 gone.txt",
    "2 R. N... 100644 100644 100644 e69de29 e69de29 R100 new.txt\told.txt",
    "u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 conflict.txt",
    "? SMOKE.md",
    "! node_modules/",
  ].join("\n");

  test("reads the branch header", () => {
    const s = parseStatus(STATUS);
    expect(s.oid).toBe("53b9d1a325b6145d29224ab5ef81c4a112a7203e");
    expect(s.head).toBe("main");
    expect(s.upstream).toBe("origin/main");
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(2);
  });

  test("names each entry's kind and where the change is", () => {
    const s = parseStatus(STATUS);
    expect(s.entries.map((e) => [e.path, e.kind, e.staged, e.unstaged, e.origPath])).toEqual([
      ["README.md", "modified", false, true, null],
      ["src/new thing.ts", "added", true, false, null],
      ["gone.txt", "deleted", false, true, null],
      ["new.txt", "renamed", true, false, "old.txt"],
      ["conflict.txt", "unmerged", true, true, null],
      ["SMOKE.md", "untracked", false, true, null],
      ["node_modules/", "ignored", false, false, null],
    ]);
  });

  test("an unborn branch has no oid; an empty status has no entries", () => {
    expect(parseStatus("# branch.oid (initial)\n# branch.head main\n").oid).toBeNull();
    expect(parseStatus("").entries).toEqual([]);
  });
});

test("basename", () => {
  expect(basename("/home/sprite/work/fountain-workbench")).toBe("fountain-workbench");
  expect(basename("/home/sprite/work/x/")).toBe("x");
  expect(basename("plain")).toBe("plain");
});
