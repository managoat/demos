import { describe, expect, test } from "bun:test";
import { initials, shortName, splitAuthor, withAuthor } from "./author";
import { modelLabel, modelProblem } from "./models";
import { derivedKey, parseSettings } from "./settings";

describe("author tags", () => {
  test("round-trips", () => {
    const tagged = withAuthor("alice@example.com", "hello there");
    expect(tagged).toBe("[from alice@example.com] hello there");
    expect(splitAuthor(tagged)).toEqual({ email: "alice@example.com", text: "hello there" });
  });
  test("leaves an untagged prompt alone", () => {
    expect(splitAuthor("[not a tag] hi")).toEqual({ email: null, text: "[not a tag] hi" });
    expect(splitAuthor("plain")).toEqual({ email: null, text: "plain" });
  });
  test("names", () => {
    expect(shortName("jake.gaylor@example.com")).toBe("Jake Gaylor");
    expect(initials("jake.gaylor@example.com")).toBe("JG");
    expect(initials("bob@example.com")).toBe("B");
  });
});

describe("models", () => {
  test("provider must match the runtime", () => {
    expect(modelProblem("claude", "anthropic/claude-opus-5")).toBeNull();
    expect(modelProblem("claude", "openai/gpt-5")).toMatch(/anthropic/);
    expect(modelProblem("opencode", "google/gemini-3-pro")).toBeNull();
    expect(modelProblem("opencode", "mistral/large")).toMatch(/credentials/);
    expect(modelProblem("codex", "nonsense")).toMatch(/provider\/model/);
  });
  test("labels", () => {
    expect(modelLabel("anthropic/claude-opus-5")).toBe("Opus 5");
    expect(modelLabel("openai/gpt-5.3-codex")).toBe("Gpt 5.3 Codex");
  });
});

describe("settings", () => {
  test("parses and keys", () => {
    const s = parseSettings({ runtime: "claude", model: "anthropic/claude-sonnet-5", presetId: "p1", environmentId: "", vaultId: null });
    expect(typeof s).not.toBe("string");
    if (typeof s === "string") throw new Error(s);
    expect(s.environmentId).toBeNull();
    expect(derivedKey(s)).toBe("salon:p1:claude:anthropic/claude-sonnet-5");
  });
  test("refuses a bad runtime or model", () => {
    expect(typeof parseSettings({ runtime: "foo", model: "x/y" })).toBe("string");
    expect(typeof parseSettings({ runtime: "claude", model: "openai/gpt" })).toBe("string");
    expect(typeof parseSettings(null)).toBe("string");
  });
});
