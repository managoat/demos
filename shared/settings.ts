/**
 * What a chat is started with: a model, some skills, some connectors. Not an
 * agent and an environment — the server materialises whatever Fountain
 * needs from these (server/agents.ts), once per distinct combination.
 */
import { modelProblem, runtimeFor } from "./models";
import { isSkillId } from "./skills";

export interface ChatSettings {
  /** `provider/model`. The runtime follows from the provider (`runtimeFor`). */
  model: string;
  /** Ids from `shared/skills.ts`. */
  skills: string[];
  /** Ids of the host's Fountain connections (`GET /api/connections`). */
  connectorIds: string[];
  /**
   * Room for later — an agent to start from, a computer, secrets. Parsed and
   * keyed, but nothing in the browser sets them and the menu does not offer them.
   */
  presetId: string | null;
  environmentId: string | null;
  vaultId: string | null;
}

export const DEFAULT_SETTINGS: ChatSettings = {
  model: "anthropic/claude-opus-5",
  skills: [],
  connectorIds: [],
  presetId: null,
  environmentId: null,
  vaultId: null,
};

/** The settings a request carried, or the sentence that says why not. */
export function parseSettings(v: unknown): ChatSettings | string {
  if (!v || typeof v !== "object") return "Settings are required.";
  const r = v as Record<string, unknown>;
  const model = typeof r.model === "string" ? r.model.trim() : "";
  if (!model) return "Pick a model.";
  const problem = modelProblem(model);
  if (problem) return problem;
  const skills = idList(r.skills);
  if (skills === null) return "Skills must be a list.";
  const unknown = skills.find((s) => !isSkillId(s));
  if (unknown !== undefined) return `"${unknown}" is not a skill Salon offers.`;
  const connectorIds = idList(r.connectorIds);
  if (connectorIds === null) return "Connectors must be a list.";
  return {
    model,
    skills,
    connectorIds,
    presetId: optId(r.presetId),
    environmentId: optId(r.environmentId),
    vaultId: optId(r.vaultId),
  };
}

/** Trimmed, non-empty, de-duplicated, sorted — or null when it is not a list of strings at all. */
function idList(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return null;
  return [...new Set((v as string[]).map((s) => s.trim()).filter(Boolean))].sort();
}

function optId(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * The key a derived agent is found again by (`metadata.salon.key`): a hash
 * of the whole tuple, lists sorted, so the same choices in any order name
 * the same agent. Change the shape and every derived agent is orphaned.
 */
export function derivedKey(s: ChatSettings): string {
  return `salon:v2:${fnv1a64(canonical(s))}`;
}

/** The tuple the key hashes, in one fixed order, for `metadata.salon` and for tests. */
export function canonical(s: ChatSettings): string {
  return JSON.stringify({
    runtime: runtimeFor(s.model),
    model: s.model,
    skills: [...new Set(s.skills)].sort(),
    connectors: [...new Set(s.connectorIds)].sort(),
    preset: s.presetId ?? null,
    environment: s.environmentId ?? null,
    vault: s.vaultId ?? null,
  });
}

/** FNV-1a, 64-bit, as 16 hex digits. Runs the same in Bun and a browser, and needs no await. */
export function fnv1a64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hash = 0xcbf29ce484222325n;
  for (const b of bytes) {
    hash ^= BigInt(b);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}
