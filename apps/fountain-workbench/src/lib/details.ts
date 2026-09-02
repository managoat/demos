/**
 * What a conversation is actually running with — the model behind the details
 * panel (`src/components/DetailsPanel.tsx`).
 *
 * Three questions the app could not answer before: which skills are on the
 * machine, which MCP servers the agent can reach, and what the permission
 * policy in force actually says. All three are derivable from records the
 * project already holds — the conversation, its sandbox, and the agent — but
 * none of them is stored in the shape a reader wants, and two of them are not
 * the whole truth. This module does the deriving and is explicit about the
 * gaps; `DetailsPanel` renders what it returns and says the gaps out loud.
 *
 * **Skills and MCP servers are the *agent's*, not the conversation's.** There
 * is no endpoint for "what is on this sprite": `GET /api/agents/:id` is the
 * only source, and it describes the agent as it is *now*. Two consequences,
 * both real:
 *
 *   - Skills are written to the sprite once, at provision time
 *     (`Fountain.SandboxSkills.mount/3`, called from the provision branch of
 *     `ConversationServer`). Editing the agent afterwards does not touch a
 *     machine that is already up, so on a long-lived computer this list is
 *     the definition and not the disk.
 *   - MCP servers are re-read at every turn kick and delivered on
 *     `session/new`, so those *do* follow an edit — but only from the next
 *     turn.
 *
 * **Fountain adds to both sets, and the API reports neither addition.**
 * `SandboxSkills.mount/3` always prepends its own bundled skills, which is
 * how a sprite discovers the callback API and the team set-up Q&A; they are
 * on every machine and in no agent's definition, so `BUNDLED_SKILLS` names
 * them here rather than letting the panel imply a shorter list.
 * `ConversationServer` likewise appends up to three MCP servers of its own at
 * `session/new` — `fountain-buzz`, `fountain-team` and `fountain-team-comms`.
 * The team pair is reachable only by a conversation on Fountain's own team
 * channel (`fountain:team`), which a workbench conversation never is: its
 * channel is `workbench:<project>/…`. `fountain-buzz` has no such guard — it
 * is injected whenever the conversation's *vault* carries a Buzz identity,
 * which a project's vault may — so it is the one addition the workbench can
 * neither see nor rule out. `mcpCaveat` is that sentence.
 *
 * The MCP entries are stored as Claude's own config map and normalised into
 * the shape ACP delivers (`Fountain.Runtimes.ACP.mcp_servers/1`) — sorted by
 * name, `type`-less meaning stdio. Values of `env` and `headers` are not read
 * here and do not reach this browser at all: the proxy replaces them (see
 * `redactMcpServers` in `server/proxy.ts`), because a member must not be
 * handed the owner's credentials by a panel that only meant to list what is
 * plugged in. Keys are kept, and keys are what a reader is asking about.
 */
import type { Agent, Conversation } from "../types";

// ── the permission policy in force ───────────────────────────────────────

export type Verdict = "auto_allow" | "ask" | "auto_deny";

/** Restrictiveness, low to high — `Fountain.Permissions`'s own `@rank`. */
const RANK: Record<Verdict, number> = { auto_allow: 0, ask: 1, auto_deny: 2 };
const DEFAULT_KEY = "default";

function isVerdict(v: unknown): v is Verdict {
  return v === "auto_allow" || v === "ask" || v === "auto_deny";
}

function asPolicy(policy: unknown): Record<string, unknown> {
  return policy && typeof policy === "object" && !Array.isArray(policy) ? (policy as Record<string, unknown>) : {};
}

/**
 * The verdict a policy gives one tool: its own entry, else its `default`,
 * else `auto_allow`. A value that is present but is not a verdict is read as
 * `auto_deny` and not as an allow — the changesets reject those, so a row
 * carrying one was written around them (`Permissions.verdict_for/2`).
 */
export function verdictFor(policy: unknown, tool: string | null): Verdict {
  const p = asPolicy(policy);
  const own = tool === null ? undefined : p[tool];
  const raw = own ?? p[DEFAULT_KEY];
  if (raw === undefined || raw === null) return "auto_allow";
  return isVerdict(raw) ? raw : "auto_deny";
}

/** Which of two verdicts withholds more. */
export function stricter(a: Verdict, b: Verdict): Verdict {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * The policy actually in force: the agent's merged with the conversation's
 * launch override, taking the stricter of the two per tool. Mirrors
 * `Fountain.Permissions.effective/2` — clamping rather than replacing, so no
 * merge is looser than the agent's own, whatever the launch asked for.
 */
export function effectivePolicy(agentPolicy: unknown, launchPolicy: unknown): Record<string, Verdict> {
  const a = asPolicy(agentPolicy);
  const l = asPolicy(launchPolicy);
  const out: Record<string, Verdict> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(l)])) {
    if (key === DEFAULT_KEY) continue;
    out[key] = stricter(verdictFor(a, key), verdictFor(l, key));
  }
  out[DEFAULT_KEY] = stricter(verdictFor(a, null), verdictFor(l, null));
  return out;
}

/**
 * Whether a policy asks anything of the runtime at all. `auto_allow`
 * everywhere is what a runtime does with no policy, so a panel that
 * announced it would be announcing nothing (`Permissions.needs_enforcement?/1`).
 */
export function policyBites(policy: Record<string, Verdict>): boolean {
  return Object.values(policy).some((v) => v !== "auto_allow");
}

/** A policy as rows to render: the tools it names first, its default last. */
export function policyRows(policy: Record<string, Verdict>): { tool: string; verdict: Verdict }[] {
  const tools = Object.keys(policy)
    .filter((k) => k !== DEFAULT_KEY)
    .sort();
  const rows = tools.map((tool) => ({ tool, verdict: policy[tool]! }));
  rows.push({ tool: DEFAULT_KEY, verdict: policy[DEFAULT_KEY] ?? "auto_allow" });
  return rows;
}

// ── MCP servers ──────────────────────────────────────────────────────────

export type Transport = "stdio" | "http" | "sse";

export interface McpServer {
  name: string;
  transport: Transport;
  /** stdio: the program it runs, and its arguments. */
  command: string | null;
  args: string[];
  /** http and sse: where it is reached. */
  url: string | null;
  /** The names of the variables and headers it is given — never the values. */
  envKeys: string[];
  headerKeys: string[];
}

function keysOf(v: unknown): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  return Object.keys(v as Record<string, unknown>).sort();
}

function stringsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : [];
}

/**
 * An agent's MCP servers, sorted by name, in the shape ACP delivers them:
 * an entry carrying `type: "http"` or `"sse"` is reached at a URL, and an
 * entry with no `type` at all is stdio — the adapter reads a missing `type`
 * as stdio, and a literal `"stdio"` would send it down the URL branch, so
 * anything else is read as stdio here too.
 */
export function mcpServersOf(agent: Agent | null | undefined): McpServer[] {
  const raw = agent?.mcp_servers;
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => {
      const e = asPolicy(entry);
      const type = e.type === "http" || e.type === "sse" ? (e.type as Transport) : "stdio";
      const env = type === "stdio" ? e.env : undefined;
      const headers = type === "stdio" ? undefined : e.headers;
      return {
        name,
        transport: type,
        command: typeof e.command === "string" ? e.command : null,
        args: stringsOf(e.args),
        url: typeof e.url === "string" ? e.url : null,
        envKeys: keysOf(env),
        headerKeys: keysOf(headers),
      };
    });
}

/**
 * What this list cannot show, in one sentence — see the module doc. Rendered
 * under the servers rather than left for someone to discover by wondering
 * why a tool they can see the agent using is not here.
 */
export const mcpCaveat =
  "Fountain adds a server of its own to a conversation whose vault carries a Buzz identity. It is not in the agent's definition and no endpoint reports it, so it cannot appear here.";

// ── skills ───────────────────────────────────────────────────────────────

export interface Skill {
  name: string;
  /** inline: a SKILL.md written straight onto the sprite. github: installed there by the skills.sh CLI. */
  source: "inline" | "github";
  /** github: the `owner/repo` it comes from. */
  repo: string | null;
  /** github: the tag, branch or sha it is pinned to; null means the default branch, read at spawn time. */
  ref: string | null;
  /** Mounted on every sprite by Fountain, in no agent's definition. */
  bundled: boolean;
}

/**
 * The skills Fountain writes onto every sprite whatever the agent says
 * (`Fountain.SandboxSkills.@bundled_skills`, prepended in `mount/3`): the
 * one that documents the callback API to whatever is running in there, and
 * the team set-up Q&A. Listing them is the difference between "these are the
 * agent's skills" and "this is what is on the machine", and the panel is
 * asked for the second.
 */
export const BUNDLED_SKILLS = ["fountain", "create-team"];

/**
 * An agent's skills, the bundled ones first — the order `mount/3` writes
 * them in. A github entry names itself by its `name` when it has one and by
 * the tail of its repo when it does not, which is how the CLI installs it.
 */
export function skillsOf(agent: Agent | null | undefined): Skill[] {
  const bundled: Skill[] = BUNDLED_SKILLS.map((name) => ({ name, source: "inline", repo: null, ref: null, bundled: true }));
  const own = Array.isArray(agent?.skills) ? agent.skills : [];
  const mine = own.map((entry): Skill => {
    const e = asPolicy(entry);
    const repo = typeof e.source === "string" && e.source ? e.source : null;
    const named = typeof e.name === "string" && e.name ? e.name : null;
    if (repo) return { name: named ?? repo.split("/").pop() ?? repo, source: "github", repo, ref: typeof e.ref === "string" && e.ref ? e.ref : null, bundled: false };
    return { name: named ?? "unnamed", source: "inline", repo: null, ref: null, bundled: false };
  });
  return [...bundled, ...mine];
}

/**
 * Why a skill list can be out of date, when it can be. A machine that is
 * still up was given its skills when it came up; one that is gone or not yet
 * built has nothing to disagree with the definition, so there is nothing to
 * warn about.
 */
export function skillsCaveat(sandboxStatus: string | null | undefined): string | null {
  if (!sandboxStatus || sandboxStatus === "terminated" || sandboxStatus === "failed" || sandboxStatus === "pending") return null;
  return "Skills are written to the computer when it is built. This is the teammate's definition as it stands now; editing it does not reach a machine that is already up.";
}

// ── the computer, and the conversation ───────────────────────────────────

/**
 * How a computer is shared, in the workbench's own terms. `ephemeral` is one
 * conversation's machine, reclaimed with it; `persistent` is the agent
 * identity's home, which every conversation of that identity lands on —
 * across work items, and across conversations started outside the workbench
 * entirely. The second is worth saying on the page, because the sidebar's
 * item → computer → conversation tree quietly assumes the first.
 */
export function describeMode(mode: string | null | undefined): { label: string; note: string | null } {
  if (mode === "persistent")
    return {
      label: "persistent",
      note: "The teammate's own machine, shared by every conversation on this environment and vault — including ones on other work items.",
    };
  if (mode === "ephemeral") return { label: "ephemeral", note: "This conversation's own machine, reclaimed when the last conversation on it ends." };
  return { label: mode ?? "—", note: null };
}

/** The other conversations sharing this computer, newest first, this one dropped. */
export function cotenants(conversationId: string, all: Conversation[], sandboxId: string | null | undefined): Conversation[] {
  if (!sandboxId) return [];
  return all.filter((c) => c.sandbox_id === sandboxId && c.id !== conversationId);
}

// ── the panel itself: open or shut, and how wide ─────────────────────────
//
// Both are per browser and both outlive the conversation, so the panel stays
// as you left it while you move between threads — the same bargain the
// explorer's width makes (`src/lib/sidebar.ts`).

export const PANEL_MIN = 240;
export const PANEL_MAX = 640;
export const PANEL_DEFAULT = 320;
const WIDTH_KEY = "fountain-workbench.detailsWidth";
const OPEN_KEY = "fountain-workbench.detailsOpen";

export function clampPanelWidth(px: number): number {
  if (!Number.isFinite(px)) return PANEL_DEFAULT;
  return Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(px)));
}

export function loadPanelWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    return raw ? clampPanelWidth(Number(raw)) : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
}

export function savePanelWidth(px: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(clampPanelWidth(px)));
  } catch {
    // no storage: the width lives for the page
  }
}

/** Shut until asked for: it is a second column on a screen whose first job is the transcript. */
export function loadPanelOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function savePanelOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // no storage: it lives for the page
  }
}
