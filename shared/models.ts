/**
 * The vocabulary of the model pill: the three providers Fountain holds
 * credentials for, friendly names for the model ids its catalog suggests,
 * and the runtime each provider's models run on.
 *
 * Fountain stores a model as `provider/model_id` and gates only the provider
 * half (the model id is passed through verbatim, so a model released
 * tomorrow works today). The runtime — the coding-agent CLI behind the
 * chat — is an implementation detail here: anthropic models run on claude,
 * openai on codex, google on gemini. Nobody using Salon needs to know that,
 * so nothing in this file is shown as a "runtime".
 */

export type Runtime = "claude" | "codex" | "gemini";

export const PROVIDERS = ["anthropic", "openai", "google"] as const;
export type Provider = (typeof PROVIDERS)[number];

const RUNTIME_FOR_PROVIDER: Record<Provider, Runtime> = {
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
};

export const MODEL_PATTERN = /^[a-z0-9_-]+\/[a-z0-9._-]+$/;

export function isProvider(v: unknown): v is Provider {
  return typeof v === "string" && (PROVIDERS as readonly string[]).includes(v);
}

/** The provider half of a model id. */
export function providerOf(model: string): string {
  const i = model.indexOf("/");
  return i === -1 ? "" : model.slice(0, i);
}

/** Why this model cannot be run, or null when it can. */
export function modelProblem(model: string): string | null {
  if (!MODEL_PATTERN.test(model)) return "A model is written provider/model, like anthropic/claude-sonnet-5.";
  const provider = providerOf(model);
  if (!isProvider(provider)) return `Fountain holds credentials for ${PROVIDERS.join(", ")} — not ${provider}.`;
  return null;
}

/** The runtime a model runs on. Only for a model `modelProblem` accepts. */
export function runtimeFor(model: string): Runtime {
  const provider = providerOf(model);
  if (!isProvider(provider)) throw new Error(`no runtime for ${model}`);
  return RUNTIME_FOR_PROVIDER[provider];
}

/** "Anthropic", "OpenAI", "Google" — the brand a model list is grouped under. */
export function providerLabel(provider: string): string {
  switch (provider) {
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "google":
      return "Google";
    default:
      return provider ? provider[0]!.toUpperCase() + provider.slice(1) : "";
  }
}

const KNOWN: Record<string, { label: string; blurb: string }> = {
  "anthropic/claude-opus-5": { label: "Opus 5", blurb: "For complex tasks" },
  "anthropic/claude-sonnet-5": { label: "Sonnet 5", blurb: "Most efficient for everyday tasks" },
  "anthropic/claude-haiku-4-5": { label: "Haiku 4.5", blurb: "Fastest for quick answers" },
  "anthropic/claude-opus-4-8": { label: "Opus 4.8", blurb: "The previous Opus" },
  "anthropic/claude-opus-4-7": { label: "Opus 4.7", blurb: "Older, still strong" },
  "anthropic/claude-sonnet-4-6": { label: "Sonnet 4.6", blurb: "The previous Sonnet" },
  "openai/gpt-5.5": { label: "GPT-5.5", blurb: "OpenAI's most capable" },
  "openai/gpt-5.3-codex": { label: "GPT-5.3 Codex", blurb: "OpenAI, tuned for careful work" },
  "google/gemini-3.1-pro-preview": { label: "Gemini 3.1 Pro", blurb: "Google's most capable" },
  "google/gemini-3.7-flash": { label: "Gemini 3.7 Flash", blurb: "Quick and inexpensive" },
  "google/gemini-3.6-flash": { label: "Gemini 3.6 Flash", blurb: "The previous Flash" },
  "google/gemini-3.5-flash": { label: "Gemini 3.5 Flash", blurb: "Older Flash" },
};

/** "Opus 5" for a known id; "GPT-6 Mini" for one this file has not met. */
export function modelLabel(id: string): string {
  const known = KNOWN[id];
  if (known) return known.label;
  const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  return bare
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (w === "gpt" ? "GPT" : /^\d/.test(w) ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/^GPT (\d)/, "GPT-$1");
}

export function modelBlurb(id: string): string | null {
  return KNOWN[id]?.blurb ?? null;
}

/** The catalog's suggestions in brand order, each brand's models in the catalog's order, no duplicates. */
export function groupByProvider(models: string[]): { provider: Provider; models: string[] }[] {
  const seen = new Set<string>();
  return PROVIDERS.map((provider) => ({
    provider,
    models: models.filter((m) => providerOf(m) === provider && !seen.has(m) && seen.add(m)),
  })).filter((g) => g.models.length > 0);
}
