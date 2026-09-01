/**
 * What a chat is started with. Not an agent and an environment — a few
 * choices the composer offers, from which the server materialises whatever
 * Fountain needs (server/agents.ts).
 */
import { isRuntime, modelProblem, type Runtime } from "./models";

export interface ChatSettings {
  runtime: Runtime;
  model: string;
  /** An agent of the host's to start from: its prompt, skills, servers. */
  presetId: string | null;
  /** The computer: an environment of the host's. Null takes the preset's, or Fountain's default. */
  environmentId: string | null;
  /** Secrets: a vault of the host's. */
  vaultId: string | null;
}

export const DEFAULT_SETTINGS: ChatSettings = {
  runtime: "claude",
  model: "anthropic/claude-opus-5",
  presetId: null,
  environmentId: null,
  vaultId: null,
};

/** The settings a request carried, or the sentence that says why not. */
export function parseSettings(v: unknown): ChatSettings | string {
  if (!v || typeof v !== "object") return "Settings are required.";
  const r = v as Record<string, unknown>;
  if (!isRuntime(r.runtime)) return "Pick a runtime: claude, codex, gemini or opencode.";
  const model = typeof r.model === "string" ? r.model.trim() : "";
  if (!model) return "Pick a model.";
  const problem = modelProblem(r.runtime, model);
  if (problem) return problem;
  return {
    runtime: r.runtime,
    model,
    presetId: optId(r.presetId),
    environmentId: optId(r.environmentId),
    vaultId: optId(r.vaultId),
  };
}

function optId(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The key a derived agent is found again by (`metadata.salon.key`). */
export function derivedKey(s: ChatSettings): string {
  return `salon:${s.presetId ?? "base"}:${s.runtime}:${s.model}`;
}
