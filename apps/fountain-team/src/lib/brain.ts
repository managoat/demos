/**
 * "Pick a brain" — the one choice the easy add asks for. Fountain's catalog
 * lists models per runtime; a teammate needs a model AND a runtime, and the
 * runtime is a consequence of the model for anyone who isn't tuning: Claude
 * models run on the claude runtime, OpenAI on codex. Nothing else is offered:
 * Team reads the ACP stream, and Google models' only runtime, gemini, does not
 * speak ACP. Providers without an inference credential are shown but marked,
 * and never picked as the default.
 */

export interface Catalog {
  runtimes: string[];
  models: Record<string, string[]>;
  avatar?: { bases: string[]; moods: string[] };
  /** which sandbox providers this Fountain can place a computer on, and the one it uses by default */
  sandbox_providers?: { enabled: string[]; default: string };
  /** where this Fountain sends a human to read a transcript or the roster; null for an app it does not have */
  apps?: { conversations: string | null; team: string | null };
}

export interface Brain {
  /** provider/model, what the agent stores */
  model: string;
  provider: string;
  runtime: string;
  label: string;
  /** the user has an inference credential for this provider */
  available: boolean;
}

export const CREDENTIAL_PROVIDERS: Record<string, string[]> = {
  anthropic: ["anthropic_api_key", "claude_code_oauth_token"],
  openai: ["openai_api_key"],
  google: ["gemini_api_key"],
};

export function runtimeFor(model: string, runtimes: string[]): string | null {
  const want = model.startsWith("anthropic/") ? "claude" : model.startsWith("openai/") ? "codex" : null;
  return want && runtimes.includes(want) ? want : null;
}

/** Distinct models across the catalog that have an ACP runtime, Anthropic first, then OpenAI, labelled. */
export function brainsFrom(catalog: Catalog, credentials: Record<string, boolean> = {}): Brain[] {
  const seen = new Set<string>();
  const out: Brain[] = [];
  const order = ["claude", "codex"];
  const runtimes = [...order.filter((r) => catalog.models[r]), ...Object.keys(catalog.models).filter((r) => !order.includes(r))];
  for (const r of runtimes) {
    for (const model of catalog.models[r] ?? []) {
      if (seen.has(model)) continue;
      seen.add(model);
      const runtime = runtimeFor(model, catalog.runtimes);
      if (!runtime) continue;
      const provider = model.split("/")[0] ?? "";
      const keys = CREDENTIAL_PROVIDERS[provider] ?? [];
      const available = keys.length ? keys.some((k) => credentials[k]) : true;
      out.push({ model, provider, runtime, label: labelFor(model), available });
    }
  }
  const rank = (p: string) => (p === "anthropic" ? 0 : p === "openai" ? 1 : p === "google" ? 2 : 3);
  return out.sort((a, b) => rank(a.provider) - rank(b.provider));
}

/** The brain a fresh teammate gets: the first available one, preferring a mid-size Claude. */
export function defaultBrain(brains: Brain[]): Brain | null {
  const usable = brains.filter((b) => b.available);
  const pool = usable.length ? usable : brains;
  return pool.find((b) => /sonnet/.test(b.model)) ?? pool.find((b) => b.provider === "anthropic") ?? pool[0] ?? null;
}

export function labelFor(model: string): string {
  const [provider, name = ""] = model.split("/");
  const words = name
    .split("-")
    .filter(Boolean)
    .map((w) => {
      if (w === "claude") return "Claude";
      if (w === "gpt") return "GPT";
      if (w === "gemini") return "Gemini";
      return /^(opus|sonnet|haiku|codex|pro|flash|mini|nano)$/.test(w) ? w[0]!.toUpperCase() + w.slice(1) : w;
    });
  // "GPT 5" reads as "GPT-5"; everything else separates with spaces
  const pretty = words.join(" ").replace(/\bGPT (\S+)/, "GPT-$1");
  const who = provider === "anthropic" ? "Anthropic" : provider === "openai" ? "OpenAI" : provider === "google" ? "Google" : provider;
  return `${pretty || name} · ${who}`;
}

/** The system prompt a persona line becomes. Short on purpose: the agent is a teammate in a chat, not a product. */
export function personaPrompt(name: string, persona: string): string {
  const who = persona.trim();
  return [
    `You are ${name}, a teammate on the user's team.`,
    who ? `Your role: ${who}` : null,
    "You have your own computer; do the work there and report back in chat — concise, concrete, no filler.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Where a key for a provider comes from, for the prompt that collects it. */
export function keySource(credential: string): string {
  switch (credential) {
    case "anthropic_api_key":
      return "console.anthropic.com";
    case "claude_code_oauth_token":
      return "`claude setup-token`";
    case "openai_api_key":
      return "platform.openai.com/api-keys";
    case "gemini_api_key":
      return "aistudio.google.com/apikey";
    default:
      return "";
  }
}

