import { describe, expect, test } from "bun:test";
import { shouldNotify } from "./notify";

const base = { enabled: true, permission: "granted" as const, muted: false, isOpen: false, hidden: false };

describe("shouldNotify", () => {
  test("a reply in another thread notifies", () => {
    expect(shouldNotify(base)).toBe(true);
  });
  test("the open thread in a focused window stays quiet, but not when the tab is hidden", () => {
    expect(shouldNotify({ ...base, isOpen: true })).toBe(false);
    expect(shouldNotify({ ...base, isOpen: true, hidden: true })).toBe(true);
  });
  test("off, denied, or muted never notify", () => {
    expect(shouldNotify({ ...base, enabled: false })).toBe(false);
    expect(shouldNotify({ ...base, permission: "denied" })).toBe(false);
    expect(shouldNotify({ ...base, permission: "default" })).toBe(false);
    expect(shouldNotify({ ...base, muted: true })).toBe(false);
  });
});
