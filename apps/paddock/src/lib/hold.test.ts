import { expect, test } from "bun:test";
import { ApiError } from "../api/client";
import { DEFAULT_RETRY_MS, Hold } from "./hold";

test("only a 429 holds anything", () => {
  let now = 0;
  const hold = new Hold(() => now, () => 0);
  hold.note(new ApiError(500, null, "boom"));
  hold.note(new Error("network"));
  expect(hold.active()).toBe(false);
  hold.note(new ApiError(429, "rate_limited", "slow down", 35));
  expect(hold.active()).toBe(true);
  expect(hold.remainingMs()).toBe(35_000);
  now = 35_000;
  expect(hold.active()).toBe(false);
  expect(hold.remainingMs()).toBe(0);
});

test("a 429 with no Retry-After still holds, for a default", () => {
  const hold = new Hold(() => 0, () => 0);
  hold.note(new ApiError(429, null, "slow down"));
  expect(hold.remainingMs()).toBe(DEFAULT_RETRY_MS);
});

test("a shorter ask never cuts a longer hold short, and jitter only adds", () => {
  const hold = new Hold(() => 0, () => 1);
  hold.note(new ApiError(429, null, "x", 30));
  hold.note(new ApiError(429, null, "x", 5));
  expect(hold.remainingMs()).toBe(32_000);
});
