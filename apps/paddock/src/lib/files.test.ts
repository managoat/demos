import { describe, expect, test } from "bun:test";
import { childPath, isDir, isOpenable, sortEntries } from "./files";
import type { SandboxEntry } from "../api/types";

const entry = (name: string, type: string, size: number | null = null): SandboxEntry => ({ name, type, size });

describe("what counts as a directory", () => {
  test("Fountain says `directory`, and only that", () => {
    // The bug: this app said "dir", so on a real machine every folder rendered
    // as a file and clicking one asked Fountain to read a directory as bytes.
    expect(isDir(entry("src", "directory"))).toBe(true);
    expect(isDir(entry("src", "dir"))).toBe(false);
    expect(isDir(entry("README.md", "file"))).toBe(false);
    expect(isDir(entry("link", "symlink"))).toBe(false);
    expect(isDir(entry("sock", "other"))).toBe(false);
  });

  test("only files and symlinks are worth trying to read", () => {
    expect(isOpenable(entry("README.md", "file"))).toBe(true);
    // A symlink usually points at a file; when it does not, Fountain says so.
    expect(isOpenable(entry("link", "symlink"))).toBe(true);
    expect(isOpenable(entry("src", "directory"))).toBe(false);
    expect(isOpenable(entry("sock", "other"))).toBe(false);
  });
});

describe("sortEntries", () => {
  test("directories first, then everything else, each alphabetical", () => {
    const sorted = sortEntries([
      entry("README.md", "file", 10),
      entry("src", "directory"),
      entry("package.json", "file", 20),
      entry("test", "directory"),
      entry("link", "symlink"),
    ]);
    // Case-insensitively, the way an editor lists them: README.md sorts with
    // the r's rather than jumping to the top on its capital.
    expect(sorted.map((e) => e.name)).toEqual(["src", "test", "link", "package.json", "README.md"]);
  });

  test("does not mutate what it was given", () => {
    const original = [entry("b", "file"), entry("a", "directory")];
    sortEntries(original);
    expect(original.map((e) => e.name)).toEqual(["b", "a"]);
  });

  test("an unknown type sorts with the files rather than vanishing", () => {
    // Better to show something unopenable than to hide it.
    const sorted = sortEntries([entry("mystery", "fifo"), entry("src", "directory")]);
    expect(sorted.map((e) => e.name)).toEqual(["src", "mystery"]);
  });
});

describe("childPath", () => {
  test("joins without doubling the slash", () => {
    expect(childPath("/home/sprite/work/t1", "src")).toBe("/home/sprite/work/t1/src");
    expect(childPath("/home/sprite/work/t1/", "src")).toBe("/home/sprite/work/t1/src");
    expect(childPath("/", "home")).toBe("/home");
  });
});
