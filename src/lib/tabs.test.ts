import { describe, expect, test } from "bun:test";
import { closeTab, openTab, pruneTabs, type Tab } from "./tabs";

const a: Tab = { kind: "item", id: "a" };
const b: Tab = { kind: "conversation", id: "b" };
const c: Tab = { kind: "conversation", id: "c" };

describe("tabs", () => {
  test("open is idempotent and appends", () => {
    expect(openTab([], a)).toEqual([a]);
    expect(openTab([a], a)).toEqual([a]);
    expect(openTab([a], b)).toEqual([a, b]);
  });
  test("closing the active tab moves left, else right, else nothing", () => {
    expect(closeTab([a, b, c], b, b)).toEqual({ tabs: [a, c], next: a });
    expect(closeTab([a, b, c], a, a)).toEqual({ tabs: [b, c], next: b });
    expect(closeTab([a], a, a)).toEqual({ tabs: [], next: null });
  });
  test("closing an inactive tab keeps the active one", () => {
    expect(closeTab([a, b, c], c, a)).toEqual({ tabs: [a, b], next: a });
    expect(closeTab([a, b], { kind: "item", id: "zzz" }, a)).toEqual({ tabs: [a, b], next: a });
  });
  test("prune drops tabs whose subject is gone, once the lists have loaded", () => {
    const tabs = [a, b, c];
    expect(pruneTabs(tabs, new Set(["a"]), new Set(["c"]), false)).toEqual(tabs);
    expect(pruneTabs(tabs, new Set(["a"]), new Set(["c"]), true)).toEqual([a, c]);
  });
});
