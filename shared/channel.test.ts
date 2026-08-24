import { describe, expect, test } from "bun:test";
import { channelFor, channelPrefix, conversationTitle, newId, parseChannel, recoveredTitle } from "./channel";

describe("channel ids", () => {
  test("round-trip", () => {
    expect(parseChannel(channelFor("abc123", "def456"))).toEqual({ projectId: "abc123", itemId: "def456" });
    expect(channelFor("abc123", "def456").startsWith(channelPrefix("abc123"))).toBe(true);
  });
  test("rejects other channels and malformed ones", () => {
    expect(parseChannel("fountain:team")).toBeNull();
    expect(parseChannel("workbench:")).toBeNull();
    expect(parseChannel("workbench:abc")).toBeNull();
    expect(parseChannel("workbench:abc/")).toBeNull();
    expect(parseChannel("workbench:/abc")).toBeNull();
    expect(parseChannel("workbench:a b/c")).toBeNull();
    expect(parseChannel(null)).toBeNull();
  });
  test("ids are short and channel-safe", () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(parseChannel(channelFor(id, newId()))).not.toBeNull();
  });
});

describe("titles", () => {
  test("agent: item, and back", () => {
    expect(conversationTitle("Coder", "Fix foo")).toBe("Coder: Fix foo");
    expect(recoveredTitle("Coder: Fix foo")).toBe("Fix foo");
    expect(recoveredTitle("no colon")).toBe("no colon");
    expect(recoveredTitle(null)).toBeNull();
  });
  test("long titles are cut", () => {
    expect(conversationTitle("A", "x".repeat(200)).length).toBe(120);
  });
});
