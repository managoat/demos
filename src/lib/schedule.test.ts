import { describe, expect, test } from "bun:test";
import { cadenceLabel, cadenceOf, cronFor, DEFAULT_CRON, timeAgo, timeUntil } from "./schedule";

describe("cadence presets", () => {
  test("cron round-trips through the presets", () => {
    expect(cadenceOf(cronFor("5m"))).toBe("5m");
    expect(cadenceOf(cronFor("30m"))).toBe("30m");
    expect(cadenceOf(cronFor("hourly"))).toBe("hourly");
    expect(cadenceOf(cronFor("daily"))).toBe("daily");
    expect(cadenceOf(DEFAULT_CRON)).toBe("30m");
  });

  test("an unknown cron is custom and labelled as itself", () => {
    expect(cadenceOf("17 3 * * 1")).toBeNull();
    expect(cadenceLabel("17 3 * * 1")).toBe("17 3 * * 1");
    expect(cadenceLabel("*/5 * * * *")).toBe("every 5 min");
  });
});

describe("relative time", () => {
  const now = Date.parse("2026-08-19T12:00:00Z");
  test("timeAgo buckets", () => {
    expect(timeAgo("2026-08-19T11:59:50Z", now)).toBe("just now");
    expect(timeAgo("2026-08-19T11:56:00Z", now)).toBe("4 min ago");
    expect(timeAgo("2026-08-19T09:00:00Z", now)).toBe("3 h ago");
    expect(timeAgo("2026-08-17T12:00:00Z", now)).toBe("2 d ago");
    expect(timeAgo("garbage", now)).toBe("");
  });
  test("timeUntil buckets", () => {
    expect(timeUntil("2026-08-19T11:00:00Z", now)).toBe("now");
    expect(timeUntil("2026-08-19T12:01:00Z", now)).toBe("in under a minute");
    expect(timeUntil("2026-08-19T12:12:00Z", now)).toBe("in 12 min");
    expect(timeUntil("2026-08-19T15:00:00Z", now)).toBe("in 3 h");
  });
});
