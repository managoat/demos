/**
 * The three tiers, and the gap between what you have declared and what your
 * machine actually has.
 *
 * Fountain's own model decides the tiers, and paddock does not invent them:
 *
 *   - the **environment** builds the disk — repositories, apt packages, the
 *     setup script. Changing it changes what a *future* machine would be built
 *     from, and does nothing whatever to the one you are running. Tier `box`.
 *   - the **agent** is injected when a session starts — MCP servers, skills,
 *     the system prompt — and so are secret values. Changing it reaches the
 *     next tab you open and no tab already running. Tier `session`.
 *   - the **runtime** is baked into the disk. Changing it is the one thing
 *     that genuinely cannot be done to this machine (Fountain answers
 *     `sandbox_runtime_mismatch`). Tier `machine`.
 *
 * The reason any of this works is that sandbox identity is
 * `(user, agent, environment, vault)` by *id* — so paddock keeps exactly one
 * of each, forever, and only ever mutates their contents. The ids never move,
 * so the identity always matches, so the box is never taken away from you.
 * Everything below exists to make the resulting gap legible.
 *
 * Tier `box` is checked against the receipt the machine itself wrote
 * (`spec.ts`, `protocol.ts`). Tier `session` is checked against a revision
 * number stamped on each tab when it opened (`tabs.ts`). Neither is stored in
 * this browser, because neither is this browser's business.
 */
import type { Agent, Environment } from "../api/types";
import type { Receipt } from "./protocol";
import type { ApplyItem } from "../../shared/spec";

/** Which of the three ways a change reaches the machine. */
export type Tier = "box" | "session" | "machine";

export type ItemKind = "repo" | "package" | "setup" | "skill" | "mcp" | "secret" | "runtime";

/** One thing you have asked for, in canonical form. */
export interface DesiredItem {
  /**
   * The canonical id. It encodes the *content*, so changing a package version
   * or a repo's branch produces a different id and therefore reads as a new
   * item rather than a silently-changed one.
   */
  id: string;
  tier: Tier;
  kind: ItemKind;
  label: string;
  detail?: string;
  /** What the apply turn is told to do. Only meaningful for tier `box`. */
  instruction: string;
}

/** Everything Fountain says you have declared, gathered in one place. */
export interface Declared {
  agent: Pick<Agent, "runtime" | "skills" | "mcp_servers" | "metadata">;
  environment: Pick<Environment, "repositories" | "packages" | "setup_script">;
  /** Key names only — paddock never sees a secret value, and neither does this. */
  envSecretKeys: readonly string[];
  vaultSecretKeys: readonly string[];
}

// ── canonical ids ──────────────────────────────────────────────────────────
// Stable, content-addressed, and safe to put in a prompt: no newlines, no
// characters that need quoting, short enough to read in a diff.

export function repoId(r: { url: string; mount_path: string; ref?: string | null }): string {
  return `repo:${r.url}@${r.ref?.trim() || "default"}->${r.mount_path}`;
}

export function packageId(name: string): string {
  return `pkg:${name}`;
}

export function setupId(script: string): string {
  return `setup:${fingerprint(script)}`;
}

export function skillId(name: string): string {
  return `skill:${name}`;
}

export function mcpId(name: string): string {
  return `mcp:${name}`;
}

export function secretId(where: "env" | "vault", key: string): string {
  return `secret:${where}:${key}`;
}

export function runtimeId(runtime: string): string {
  return `runtime:${runtime}`;
}

/**
 * A short, stable digest of a string. FNV-1a, 32-bit, hex.
 *
 * Not a cryptographic hash and not trying to be: it names a version of the
 * setup script so that editing the script changes its id. Sync, dependency
 * free and identical in the browser and in `bun test`, which is what matters
 * for a value that has to be computed the same way twice.
 */
export function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ── what you have asked for ────────────────────────────────────────────────

/**
 * Every declared item, tier by tier, in the order the panel shows them.
 *
 * A blank setup script is not an item: "no setup script" is the absence of a
 * thing, and giving it an id would make an empty box permanently one item
 * short of applied.
 */
export function desiredItems(d: Declared): DesiredItem[] {
  const out: DesiredItem[] = [];

  for (const r of d.environment.repositories ?? []) {
    const ref = r.ref?.trim() || null;
    out.push({
      id: repoId(r),
      tier: "box",
      kind: "repo",
      label: shortRepo(r.url),
      detail: `${r.mount_path}${ref ? ` · ${ref}` : ""}`,
      instruction:
        `clone ${r.url}${ref ? ` at ref ${ref}` : ""} into ${r.mount_path} if it is not already there ` +
        `(if the directory exists and is that repository, fetch instead of re-cloning)`,
    });
  }

  for (const p of d.environment.packages ?? []) {
    out.push({
      id: packageId(p),
      tier: "box",
      kind: "package",
      label: p,
      detail: "apt",
      instruction: `install the apt package \`${p}\` if \`command -v ${p}\` does not already find it`,
    });
  }

  const setup = d.environment.setup_script?.trim();
  if (setup) {
    out.push({
      id: setupId(setup),
      tier: "box",
      kind: "setup",
      label: "Setup script",
      detail: `${setup.split("\n").length} lines`,
      instruction: `run this setup script from ${"$HOME"}, and report a non-zero exit as a failure:\n\n${indent(setup)}`,
    });
  }

  for (const name of skillNames(d.agent.skills)) {
    out.push({
      id: skillId(name),
      tier: "session",
      kind: "skill",
      label: name,
      detail: "skill",
      instruction: `ensure the skill \`${name}\` is installed`,
    });
  }

  for (const name of Object.keys(d.agent.mcp_servers ?? {}).sort()) {
    out.push({
      id: mcpId(name),
      tier: "session",
      kind: "mcp",
      label: name,
      detail: "MCP server",
      instruction: `(injected by Fountain when a session starts; nothing to do on the box)`,
    });
  }

  for (const key of [...d.envSecretKeys].sort()) {
    out.push({
      id: secretId("env", key),
      tier: "session",
      kind: "secret",
      label: key,
      detail: "environment · in the box",
      instruction: "(injected by Fountain when a session starts; nothing to do on the box)",
    });
  }

  for (const key of [...d.vaultSecretKeys].sort()) {
    out.push({
      id: secretId("vault", key),
      tier: "session",
      kind: "secret",
      label: key,
      detail: "vault · never on the box",
      instruction: "(held by the egress broker and substituted in flight; nothing to do on the box)",
    });
  }

  out.push({
    id: runtimeId(d.agent.runtime),
    tier: "machine",
    kind: "runtime",
    label: d.agent.runtime,
    detail: "baked into the disk",
    instruction: "(cannot be changed on a running machine)",
  });

  return out;
}

// ── what the box actually has ──────────────────────────────────────────────

export type ItemState = "applied" | "pending" | "failed";

export interface ItemStatus {
  item: DesiredItem;
  state: ItemState;
  /** Why the last apply could not do it, when the box said. */
  why?: string;
}

export interface BoxDrift {
  /**
   * False when the machine has not told us what is on it — a missing or
   * unreadable receipt. Distinct from "nothing is applied", and the panel must
   * say so rather than offering to install the world.
   */
  known: boolean;
  statuses: ItemStatus[];
  /** Ids the box reports that nothing declares any more. Harmless, but worth showing. */
  extra: string[];
}

/**
 * Tier-`box` items against the receipt. Items of other tiers are not the
 * receipt's business and are left out entirely.
 */
export function boxDrift(desired: readonly DesiredItem[], receipt: Receipt | null): BoxDrift {
  const box = desired.filter((i) => i.tier === "box");
  if (!receipt) {
    return { known: false, statuses: box.map((item) => ({ item, state: "pending" as const })), extra: [] };
  }
  const on = new Set(receipt.items);
  const failed = new Map(receipt.failed.map((f) => [f.id, f.why]));

  const statuses = box.map((item): ItemStatus => {
    if (on.has(item.id)) return { item, state: "applied" };
    const why = failed.get(item.id);
    return why ? { item, state: "failed", why } : { item, state: "pending" };
  });

  const wanted = new Set(box.map((i) => i.id));
  const extra = receipt.items.filter((id) => !wanted.has(id)).sort();
  return { known: true, statuses, extra };
}

/** Is there anything for an apply turn to do? */
export function needsApply(drift: BoxDrift): boolean {
  return drift.statuses.some((s) => s.state !== "applied");
}

/** What to hand `spec.applyPrompt` as `todo`: everything not already on the box. */
export function applyTodo(drift: BoxDrift): ApplyItem[] {
  return drift.statuses
    .filter((s) => s.state !== "applied")
    .map((s) => ({ id: s.item.id, instruction: s.item.instruction }));
}

/** What to hand `spec.applyPrompt` as `keep`: what is on the box and still wanted. */
export function applyKeep(drift: BoxDrift): string[] {
  return drift.statuses.filter((s) => s.state === "applied").map((s) => s.item.id);
}

// ── the config revision, which is how tier `session` is checked ─────────────

/**
 * Where the revision lives: `agent.metadata.paddock.rev`, on Fountain, next to
 * the thing it describes. Not in this browser — two browsers looking at one
 * box have to agree about which tabs are behind, and a number in localStorage
 * cannot do that.
 */
export const METADATA_KEY = "paddock";

export function configRev(agent: Pick<Agent, "metadata">): number {
  const mine = (agent.metadata ?? {})[METADATA_KEY];
  if (!mine || typeof mine !== "object" || Array.isArray(mine)) return 0;
  const rev = (mine as { rev?: unknown }).rev;
  return typeof rev === "number" && Number.isFinite(rev) && rev >= 0 ? Math.floor(rev) : 0;
}

/** The metadata to PUT back when a tier-`session` change bumps the revision. */
export function withRev(metadata: Record<string, unknown> | null | undefined, rev: number): Record<string, unknown> {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
  const mine = base[METADATA_KEY];
  const kept = mine && typeof mine === "object" && !Array.isArray(mine) ? (mine as Record<string, unknown>) : {};
  return { ...base, [METADATA_KEY]: { ...kept, rev } };
}

// ── odds and ends ──────────────────────────────────────────────────────────

/** The first repository on the box, which is what a tab's worktree comes from. */
export function primaryRepoPath(env: Pick<Environment, "repositories">): string | null {
  return env.repositories?.[0]?.mount_path ?? null;
}

/** `https://github.com/you/thing.git` → `you/thing`. */
export function shortRepo(url: string): string {
  const trimmed = url.replace(/\.git$/, "").replace(/\/+$/, "");
  const parts = trimmed.split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : (parts[parts.length - 1] ?? url);
}

/**
 * Skill names out of the agent's `skills`, which Fountain serves as either
 * bare strings or objects with a name. Unknown shapes are dropped.
 */
export function skillNames(skills: unknown): string[] {
  if (!Array.isArray(skills)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of skills) {
    const name = typeof s === "string" ? s : typeof s === "object" && s !== null ? nameOf(s as Record<string, unknown>) : null;
    const trimmed = name?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.sort();
}

function nameOf(o: Record<string, unknown>): string | null {
  for (const k of ["name", "slug", "id"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}
