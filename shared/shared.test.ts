import { describe, expect, test } from "bun:test";
import { initials, shortName, splitAuthor, withAuthor } from "./author";
import { groupByProvider, modelLabel, modelProblem, runtimeFor } from "./models";
import { canonical, DEFAULT_SETTINGS, derivedKey, fnv1a64, parseSettings } from "./settings";
import { SKILLS, skillEntry, skillNames } from "./skills";

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
  test("the provider must be one Fountain holds credentials for", () => {
    expect(modelProblem("anthropic/claude-opus-5")).toBeNull();
    expect(modelProblem("google/gemini-3.7-flash")).toBeNull();
    expect(modelProblem("mistral/large")).toMatch(/credentials/);
    expect(modelProblem("nonsense")).toMatch(/provider\/model/);
  });
  test("the runtime follows from the provider", () => {
    expect(runtimeFor("anthropic/claude-opus-5")).toBe("claude");
    expect(runtimeFor("openai/gpt-5.5")).toBe("codex");
    expect(runtimeFor("google/gemini-3.7-flash")).toBe("gemini");
    expect(() => runtimeFor("mistral/large")).toThrow();
  });
  test("labels", () => {
    expect(modelLabel("anthropic/claude-opus-5")).toBe("Opus 5");
    expect(modelLabel("openai/gpt-5.3-codex")).toBe("GPT-5.3 Codex");
    expect(modelLabel("openai/gpt-6-mini")).toBe("GPT-6 Mini");
    expect(modelLabel("google/gemini-4-ultra")).toBe("Gemini 4 Ultra");
  });
  test("groups by brand in brand order, without duplicates", () => {
    const groups = groupByProvider(["google/gemini-3.7-flash", "anthropic/claude-opus-5", "openai/gpt-5.5", "anthropic/claude-opus-5", "other/x"]);
    expect(groups.map((g) => g.provider)).toEqual(["anthropic", "openai", "google"]);
    expect(groups[0]!.models).toEqual(["anthropic/claude-opus-5"]);
  });
});

describe("skills", () => {
  test("every skill is a github source with a skill name", () => {
    for (const s of SKILLS) {
      expect(s.source).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(skillEntry(s)).toMatchObject({ source: s.source, name: s.skill });
    }
    expect(new Set(SKILLS.map((s) => s.id)).size).toBe(SKILLS.length);
  });
  test("names in menu order", () => {
    expect(skillNames(["pptx", "pdf"])).toEqual(["PDFs", "Slides"]);
    expect(skillNames(["nope"])).toEqual([]);
  });
});

describe("settings", () => {
  test("parses, trims and sorts", () => {
    const s = parseSettings({ model: " anthropic/claude-sonnet-5 ", skills: ["pptx", "pdf", "pdf"], connectorIds: ["b", " a "], environmentId: "" });
    if (typeof s === "string") throw new Error(s);
    expect(s.model).toBe("anthropic/claude-sonnet-5");
    expect(s.skills).toEqual(["pdf", "pptx"]);
    expect(s.connectorIds).toEqual(["a", "b"]);
    expect(s.environmentId).toBeNull();
    expect(s.presetId).toBeNull();
  });
  test("refuses a bad model, an unknown skill or a non-list", () => {
    expect(typeof parseSettings({ model: "gpt" })).toBe("string");
    expect(typeof parseSettings({ model: "mistral/large" })).toBe("string");
    expect(parseSettings({ model: "anthropic/claude-opus-5", skills: ["cooking"] })).toMatch(/cooking/);
    expect(typeof parseSettings({ model: "anthropic/claude-opus-5", connectorIds: "c1" })).toBe("string");
    expect(typeof parseSettings(null)).toBe("string");
    // The runtime is not a setting any more; an old browser sending one is fine.
    expect(typeof parseSettings({ runtime: "claude", model: "anthropic/claude-opus-5" })).not.toBe("string");
  });
});

describe("derivedKey", () => {
  const base = { ...DEFAULT_SETTINGS, skills: ["pdf", "xlsx"], connectorIds: ["c1", "c2"] };
  test("is stable and order-insensitive", () => {
    expect(derivedKey(base)).toBe(derivedKey({ ...base, skills: ["xlsx", "pdf"], connectorIds: ["c2", "c1", "c1"] }));
    expect(derivedKey(base)).toMatch(/^salon:v2:[0-9a-f]{16}$/);
    // Pinned: a change here orphans every derived agent in the wild.
    expect(derivedKey(DEFAULT_SETTINGS)).toBe(`salon:v2:${fnv1a64(canonical(DEFAULT_SETTINGS))}`);
    expect(canonical(DEFAULT_SETTINGS)).toBe('{"runtime":"claude","model":"anthropic/claude-opus-5","skills":[],"connectors":[],"preset":null,"environment":null,"vault":null}');
    expect(derivedKey(DEFAULT_SETTINGS)).toBe("salon:v2:" + fnv1a64('{"runtime":"claude","model":"anthropic/claude-opus-5","skills":[],"connectors":[],"preset":null,"environment":null,"vault":null}'));
  });
  test("changes with any part of the tuple", () => {
    const keys = [base, { ...base, model: "anthropic/claude-sonnet-5" }, { ...base, skills: ["pdf"] }, { ...base, connectorIds: ["c1"] }, { ...base, presetId: "p" }, { ...base, environmentId: "e" }, { ...base, vaultId: "v" }].map(derivedKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
  test("fnv1a64 matches the reference vectors", () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
  });
});
