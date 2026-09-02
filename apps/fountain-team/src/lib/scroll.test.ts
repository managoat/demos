import { describe, expect, test } from "bun:test";
import { isNearBottom, windowTail } from "./scroll";

describe("scroll helpers", () => {
  test("near-bottom uses the slack", () => {
    expect(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
    expect(isNearBottom({ scrollTop: 850, scrollHeight: 1000, clientHeight: 100 })).toBe(true);
    expect(isNearBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 100 })).toBe(false);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 50, clientHeight: 100 })).toBe(true);
  });

  test("window keeps the tail and counts the hidden head", () => {
    expect(windowTail([1, 2, 3, 4, 5], 2)).toEqual({ shown: [4, 5], hidden: 3 });
    expect(windowTail([1, 2], 5)).toEqual({ shown: [1, 2], hidden: 0 });
    expect(windowTail([], 5)).toEqual({ shown: [], hidden: 0 });
  });
});
