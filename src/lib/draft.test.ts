import { describe, expect, test } from "bun:test";
import { debounce } from "./draft";

describe("debounce", () => {
  test("a burst of edits is one save, of the last value", async () => {
    const saved: string[] = [];
    const d = debounce<string>((v) => saved.push(v), 10);
    for (const v of ["a", "ab", "abc"]) d.push(v);
    expect(saved).toEqual([]);
    await Bun.sleep(40);
    expect(saved).toEqual(["abc"]);
  });

  test("flush saves what is held, now, and only once", async () => {
    const saved: string[] = [];
    const d = debounce<string>((v) => saved.push(v), 1000);
    d.push("x");
    d.flush();
    expect(saved).toEqual(["x"]);
    d.flush();
    await Bun.sleep(20);
    expect(saved).toEqual(["x"]);
  });

  test("flush with nothing held saves nothing", () => {
    const saved: string[] = [];
    debounce<string>((v) => saved.push(v), 10).flush();
    expect(saved).toEqual([]);
  });

  test("cancel drops the pending value", async () => {
    const saved: string[] = [];
    const d = debounce<string>((v) => saved.push(v), 10);
    d.push("x");
    expect(d.pending()).toBe(true);
    d.cancel();
    expect(d.pending()).toBe(false);
    await Bun.sleep(40);
    expect(saved).toEqual([]);
  });

  test("pending is true from the first edit until it is saved", async () => {
    const d = debounce<string>(() => {}, 10);
    expect(d.pending()).toBe(false);
    d.push("x");
    expect(d.pending()).toBe(true);
    await Bun.sleep(40);
    expect(d.pending()).toBe(false);
  });

  test("a later burst saves again", async () => {
    const saved: string[] = [];
    const d = debounce<string>((v) => saved.push(v), 10);
    d.push("one");
    await Bun.sleep(40);
    d.push("two");
    await Bun.sleep(40);
    expect(saved).toEqual(["one", "two"]);
  });
});
