import { expect, test } from "bun:test";
import { formatCompact, formatHours, formatUsd } from "./format";

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

test("plan prices are whole dollars when they divide", () => {
  expect(formatUsd(9900)).toBe("$99");
  expect(formatUsd(2950)).toBe("$29.50");
  expect(formatUsd(undefined)).toBe("—");
});
