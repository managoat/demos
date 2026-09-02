import { describe, expect, test } from "bun:test";
import {
  CLOSED_STATUSES,
  CLOSE_LABEL,
  emptyCounts,
  isClosed,
  isItemStatus,
  isProposedStatus,
  ITEM_STATUSES,
  markedAs,
  parseItemStatus,
  PROPOSABLE_STATUSES,
  statusLabel,
} from "./status";

describe("item statuses", () => {
  test("four of them, and only those", () => {
    expect(ITEM_STATUSES).toEqual(["open", "done", "wont", "icebox"]);
    for (const s of ITEM_STATUSES) expect(isItemStatus(s)).toBe(true);
    for (const s of ["", "closed", "abandoned", "on ice", "DONE", null, 3, undefined]) expect(isItemStatus(s)).toBe(false);
  });

  test("anything we do not know is open: an item nobody can account for is still work", () => {
    expect(parseItemStatus("wont")).toBe("wont");
    expect(parseItemStatus("icebox")).toBe("icebox");
    expect(parseItemStatus("won't do")).toBe("open");
    expect(parseItemStatus("on ice")).toBe("open");
    expect(parseItemStatus(undefined)).toBe("open");
  });

  test("open is the only state that is not closed: all three endings take the computers down", () => {
    expect(isClosed("open")).toBe(false);
    for (const s of CLOSED_STATUSES) expect(isClosed(s)).toBe(true);
    expect(CLOSED_STATUSES).toEqual(["done", "wont", "icebox"]);
    // A row from an older build, or a garbled one, is not silently closed.
    expect(isClosed("nonsense")).toBe(false);
  });

  test("`wont` and `icebox` are wire values; nobody reads them", () => {
    expect(statusLabel("wont")).toBe("won't do");
    expect(statusLabel("icebox")).toBe("on ice");
    expect(statusLabel("done")).toBe("done");
    expect(markedAs("wont")).toBe("Marked won't do");
    expect(markedAs("icebox")).toBe("Marked on ice");
    expect(markedAs("done")).toBe("Marked done");
  });

  test("the button names the place, the row names the state", () => {
    expect(CLOSE_LABEL.icebox).toBe("Icebox");
    expect(statusLabel("icebox")).toBe("on ice");
    expect(Object.keys(CLOSE_LABEL)).toEqual([...CLOSED_STATUSES]);
  });

  test("every way the work stops can be proposed, `icebox` included; `open` cannot", () => {
    expect(PROPOSABLE_STATUSES).toEqual(CLOSED_STATUSES);
    for (const s of CLOSED_STATUSES) expect(isProposedStatus(s)).toBe(true);
    // Reopening is not a verdict — there is nothing for a person to confirm.
    expect(isProposedStatus("open")).toBe(false);
    expect(isProposedStatus("none")).toBe(false);
  });

  test("counts start at zero in every state", () => {
    expect(emptyCounts()).toEqual({ open: 0, done: 0, wont: 0, icebox: 0 });
  });
});
