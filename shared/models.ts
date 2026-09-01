/**
 * The vocabulary of the settings pill: runtimes, the provider each one
 * speaks to, and friendly names for the model ids Fountain suggests.
 *
 * Fountain stores a model as `provider/model_id` and gates only the provider
 * half (the model id is passed to the CLI verbatim, so a model released
 * tomorrow works today). The same rule is applied here so a bad pick is a
 * sentence in the menu rather than a 422 after the computer has started.
 */

export type Runtime = "claude" | "codex" | "gemini" | "opencode";

export const RUNTIMES: readonly Runtime[] = ["claude", "codex", "gemini", "opencode"];

/** Which provider each runtime's CLI talks to; opencode takes any of the three. */
export const PROVIDER_FOR_RUNTIME: Record<Runtime, string | null> = {
  claude: "anthropic",
  codex: "openai",
  gemini: "google",
  opencode: null,
};

export const PROVIDERS = ["anthropic", "openai", "google"] as const;

export const MODEL_PATTERN = /^[a-z0-9_-]+\/[a-z0-9._-]+$/;

export function isRuntime(v: unknown): v is Runtime {
  return typeof v === "string" && (RUNTIMES as readonly string[]).includes(v);
}

/** Why this runtime cannot run this model, or null when it can. */
export function modelProblem(runtime: Runtime, model: string): string | null {
  if (!MODEL_PATTERN.test(model)) return "A model is written provider/model, like anthropic/claude-sonnet-5.";
  const provider = model.slice(0, model.indexOf("/"));
  const wanted = PROVIDER_FOR_RUNTIME[runtime];
  if (wanted && provider !== wanted) return `${runtimeLabel(runtime)} runs ${wanted}/… models only.`;
  if (!wanted && !(PROVIDERS as readonly string[]).includes(provider)) return `Fountain holds credentials for ${PROVIDERS.join(", ")} — not ${provider}.`;
  return null;
}

export function runtimeLabel(rt: Runtime): string {
  switch (rt) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini CLI";
    case "opencode":
      return "OpenCode";
  }
}

/** What the runtime is like, for the runtime submenu. */
export function runtimeBlurb(rt: Runtime): string {
  switch (rt) {
    case "claude":
      return "Anthropic's agent, on Anthropic models";
    case "codex":
      return "OpenAI's agent, on OpenAI models";
    case "gemini":
      return "Google's agent, on Gemini models";
    case "opencode":
      return "Open-source agent, any of the three providers";
  }
}

const KNOWN: Record<string, { label: string; blurb: string }> = {
  "anthropic/claude-opus-5": { label: "Opus 5", blurb: "For complex tasks" },
  "anthropic/claude-sonnet-5": { label: "Sonnet 5", blurb: "Most efficient for everyday tasks" },
  "anthropic/claude-haiku-4-5": { label: "Haiku 4.5", blurb: "Fastest for quick answers" },
  "anthropic/claude-opus-4-8": { label: "Opus 4.8", blurb: "The previous Opus" },
  "anthropic/claude-opus-4-7": { label: "Opus 4.7", blurb: "Older, still strong" },
  "anthropic/claude-sonnet-4-6": { label: "Sonnet 4.6", blurb: "The previous Sonnet" },
};

/** "Opus 5" for a known id; "Gpt 5.3 Codex" for one this file has not met. */
export function modelLabel(id: string): string {
  const known = KNOWN[id];
  if (known) return known.label;
  const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  return bare
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (/^\d/.test(w) ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

export function modelBlurb(id: string): string | null {
  return KNOWN[id]?.blurb ?? null;
}

/** The provider half of a model id. */
export function providerOf(model: string): string {
  const i = model.indexOf("/");
  return i === -1 ? "" : model.slice(0, i);
}
