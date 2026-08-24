import { describe, expect, test } from "bun:test";
import { emptyCounts, isClosed, isItemStatus, ITEM_STATUSES, markedAs, parseItemStatus, statusLabel } from "./status";

describe("item statuses", () => {
  test("three of them, and only those", () => {
    expect(ITEM_STATUSES).toEqual(["open", "done", "wont"]);
    for (const s of ITEM_STATUSES) expect(isItemStatus(s)).toBe(true);
    for (const s of ["", "closed", "abandoned", "DONE", null, 3, undefined]) expect(isItemStatus(s)).toBe(false);
  });

  test("anything we do not know is open: an item nobody can account for is still work", () => {
    expect(parseItemStatus("wont")).toBe("wont");
    expect(parseItemStatus("won't do")).toBe("open");
    expect(parseItemStatus(undefined)).toBe("open");
  });

  test("done and won't do are both closed", () => {
    expect(isClosed("open")).toBe(false);
    expect(isClosed("done")).toBe(true);
    expect(isClosed("wont")).toBe(true);
    // A row from an older build, or a garbled one, is not silently closed.
    expect(isClosed("nonsense")).toBe(false);
  });

  test("`wont` is the wire value; nobody reads it", () => {
    expect(statusLabel("wont")).toBe("won't do");
    expect(statusLabel("done")).toBe("done");
    expect(markedAs("wont")).toBe("Marked won't do");
    expect(markedAs("done")).toBe("Marked done");
  });

  test("counts start at zero in every state", () => {
    expect(emptyCounts()).toEqual({ open: 0, done: 0, wont: 0 });
  });
});
