/**
 * "Export the team" as a `fountain apply` manifest: one Agent document per
 * teammate, in the shape docs/primitives.md shows. Import stays the CLI's
 * job (`fountain apply -f team.yml`), which is idempotent create-or-update.
 * Environment / vault are exported by NAME (apply resolves names); ids
 * that do not resolve here are left as a comment rather than guessed.
 */
import type { Agent, Environment } from "../api/types";

export interface ExportedTeammate {
  name: string;
  agent: Agent;
}

export function teamManifest(rows: ExportedTeammate[], environments: Environment[], generatedAt: string): string {
  const envName = new Map(environments.map((e) => [e.id, e.name]));
  const docs = rows.map(({ name, agent }) => {
    const spec: Record<string, unknown> = { model: agent.model, runtime: agent.runtime };
    if (agent.description) spec.description = agent.description;
    if (agent.system) spec.system = agent.system;
    if (agent.environment_id) {
      const n = envName.get(agent.environment_id);
      if (n) spec.environment = n;
    }
    if (agent.skills && agent.skills.length) spec.skills = agent.skills;
    if (agent.mcp_servers && Object.keys(agent.mcp_servers).length) spec.mcp_servers = agent.mcp_servers;
    if (agent.metadata && Object.keys(agent.metadata).length) spec.metadata = agent.metadata;
    const head = [
      `# teammate: ${name}` + (name !== agent.name ? ` (agent ${agent.name})` : ""),
      agent.environment_id && !envName.get(agent.environment_id) ? `# environment ${agent.environment_id} was not resolvable to a name; set spec.environment by hand` : null,
    ]
      .filter(Boolean)
      .join("\n");
    return `${head}\napiVersion: fountain.dev/v1\nkind: Agent\nmetadata:\n  name: ${yamlScalar(agent.name)}\nspec:\n${toYaml(spec, 1)}`;
  });
  return `# Fountain team export — ${generatedAt}\n# Apply with: fountain apply -f team.yml\n---\n${docs.join("\n---\n")}\n`;
}

/** A small YAML emitter for plain JSON data (maps, lists, scalars) — no anchors, no multi-doc; block scalars for multi-line strings. */
export function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]`;
    return value
      .map((v) => {
        if (isScalar(v)) return `${pad}- ${yamlScalar(v)}`;
        const inner = toYaml(v, indent + 1);
        // first line of a nested map/list goes on the dash line
        return `${pad}- ${inner.trimStart()}`;
      })
      .join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return `${pad}{}`;
    return entries
      .map(([k, v]) => {
        const key = /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k) ? k : JSON.stringify(k);
        if (isScalar(v)) return `${pad}${key}: ${yamlScalar(v)}`;
        if (Array.isArray(v) && !v.length) return `${pad}${key}: []`;
        if (typeof v === "object" && v && !Object.keys(v as object).length) return `${pad}${key}: {}`;
        return `${pad}${key}:\n${toYaml(v, indent + 1)}`;
      })
      .join("\n");
  }
  return `${pad}${yamlScalar(value)}`;
}

function isScalar(v: unknown): boolean {
  return v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
}

export function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  if (s.includes("\n")) return `|-\n${s.split("\n").map((l) => `    ${l}`).join("\n")}`;
  if (s === "" || /^[\s\-?:,\[\]{}#&*!|>'"%@`]|[:#]\s|\s$|^(true|false|null|yes|no|on|off|~)$|^[+-]?\d/i.test(s)) return JSON.stringify(s);
  return s;
}
