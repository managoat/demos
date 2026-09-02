import { describe, expect, test } from "bun:test";
import { brainsFrom, defaultBrain, labelFor, personaPrompt, runtimeFor } from "./brain";
import { pickName } from "./names";

const catalog = {
  runtimes: ["claude", "codex", "gemini", "opencode"],
  models: {
    claude: ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "anthropic/claude-haiku-4-5"],
    codex: ["openai/gpt-5-codex", "openai/gpt-5"],
    gemini: ["google/gemini-2.5-pro"],
    opencode: ["anthropic/claude-opus-5", "openai/gpt-5", "google/gemini-2.5-pro"],
  },
};

describe("brains", () => {
  test("runtime follows the model's provider; gemini never picks its own (non-ACP) runtime", () => {
    expect(runtimeFor("anthropic/claude-sonnet-5", catalog.runtimes)).toBe("claude");
    expect(runtimeFor("openai/gpt-5", catalog.runtimes)).toBe("codex");
    expect(runtimeFor("google/gemini-2.5-pro", catalog.runtimes)).toBe("opencode");
    expect(runtimeFor("anthropic/claude-sonnet-5", ["opencode"])).toBe("opencode");
  });

  test("dedupes across runtimes, orders anthropic → openai → google, marks credentials", () => {
    const brains = brainsFrom(catalog, { anthropic_api_key: true });
    expect(brains.map((b) => b.model)).toEqual([
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-haiku-4-5",
      "openai/gpt-5-codex",
      "openai/gpt-5",
      "google/gemini-2.5-pro",
    ]);
    expect(brains.find((b) => b.model === "openai/gpt-5")?.available).toBe(false);
    expect(brains.find((b) => b.provider === "anthropic")?.available).toBe(true);
  });

  test("default is a sonnet with a credential, else any available, else the first", () => {
    expect(defaultBrain(brainsFrom(catalog, { anthropic_api_key: true }))?.model).toBe("anthropic/claude-sonnet-5");
    expect(defaultBrain(brainsFrom(catalog, { openai_api_key: true }))?.model).toBe("openai/gpt-5-codex");
    expect(defaultBrain(brainsFrom(catalog, {}))?.model).toBe("anthropic/claude-sonnet-5");
    expect(defaultBrain([])).toBeNull();
  });

  test("labels read like a picker", () => {
    expect(labelFor("anthropic/claude-sonnet-5")).toBe("Claude Sonnet 5 · Anthropic");
    expect(labelFor("openai/gpt-5-codex")).toBe("GPT-5 Codex · OpenAI");
    expect(labelFor("google/gemini-2.5-flash")).toBe("Gemini 2.5 Flash · Google");
  });

  test("persona prompt names them and keeps it short", () => {
    expect(personaPrompt("Scout", "reviews PRs for the api repo")).toContain("You are Scout");
    expect(personaPrompt("Scout", "reviews PRs for the api repo")).toContain("Your role: reviews PRs");
    expect(personaPrompt("Scout", "")).not.toContain("Your role");
  });
});

describe("names", () => {
  test("avoids taken names and numbers when exhausted", () => {
    expect(pickName(["scout"], () => 0)).not.toBe("Scout");
    const all = Array.from({ length: 60 }, (_, i) => `n${i}`);
    const n1 = pickName([], () => 0);
    expect(pickName([n1], () => 0)).not.toBe(n1);
    // exhaust: every name taken → "Base 2"
    const taken = new Set<string>();
    for (let i = 0; i < 49; i++) taken.add(pickName(taken, () => 0));
    expect(pickName(taken, () => 0)).toMatch(/ 2$/);
    expect(all.length).toBe(60);
  });
});
