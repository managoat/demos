import { afterEach, expect, test } from "bun:test";
import { buildHeaders, myBuild, noteServerBuild, resetBuild } from "./build";

function servedWith(build: string | null) {
  (globalThis as { document?: unknown }).document = {
    querySelector: () => (build === null ? null : { getAttribute: () => build }),
  };
  resetBuild();
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
  resetBuild();
});

test("a tab that knows its build reloads on the first mismatch, once", () => {
  servedWith("abc");
  let reloads = 0;
  const reload = () => (reloads += 1);
  expect(myBuild()).toBe("abc");
  expect(buildHeaders()).toEqual({ "x-paddock-build": "abc" });
  expect(noteServerBuild("abc", reload)).toBe(false);
  expect(noteServerBuild(null, reload)).toBe(false);
  expect(noteServerBuild("def", reload)).toBe(true);
  expect(noteServerBuild("def", reload)).toBe(false);
  expect(reloads).toBe(1);
});

test("a tab with no build stamp never reloads over one", () => {
  servedWith(null);
  let reloads = 0;
  expect(myBuild()).toBeNull();
  expect(buildHeaders()).toEqual({});
  expect(noteServerBuild("def", () => (reloads += 1))).toBe(false);
  expect(reloads).toBe(0);
});
