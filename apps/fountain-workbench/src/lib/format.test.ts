import { expect, test } from "bun:test";
import { formatCompact, formatHours } from "./format";

test("compact counts", () => {
  expect(formatCompact(0)).toBe("0");
  expect(formatCompact(812)).toBe("812");
  expect(formatCompact(1250)).toBe("1.3k");
  // Past ten thousand the tenth is noise.
  expect(formatCompact(47_400)).toBe("47k");
  expect(formatCompact(2_430_000)).toBe("2.4M");
  expect(formatCompact(1_200_000_000)).toBe("1.2B");
});

test("turn hours read as minutes under the hour", () => {
  expect(formatHours(0)).toBe("0 min");
  expect(formatHours(0.25)).toBe("15 min");
  expect(formatHours(7.53)).toBe("7.5 h");
  expect(formatHours(undefined)).toBe("—");
});
