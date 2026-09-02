/**
 * Apps a teammate can use — the connector catalog behind the Apps tab (after
 * OpenMausBot's connected-apps marketplace and Grok Bot's connectors) and the
 * pure helpers around an agent's `mcp_servers`.
 *
 * A connector is an MCP server the teammate's runtime talks to. The hosted
 * ones are one URL plus, usually, a token in a header; the local ones are a
 * command the computer runs. Tokens never go into the agent: they are saved
 * as a secret on the teammate's environment and the server definition
 * references them as `${VAR}`, which Fountain resolves when it sets up the
 * computer — so a change here applies on the teammate's next fresh computer.
 */
import type { McpServer } from "../api/types";

export interface ConnectorSecret {
  /** UPPER_SNAKE env/secret name the definition references as ${KEY} */
  key: string;
  /** what to ask for: "Personal access token" */
  label: string;
  /** where to get one */
  help: string;
  helpUrl: string;
  placeholder?: string;
}

export interface Connector {
  /** the mcp_servers key; stable, a slug */
  id: string;
  label: string;
  blurb: string;
  /** for the tile */
  domain: string;
  /** hosted or local */
  kind: "http" | "stdio";
  /** the token the definition needs, if any */
  secret?: ConnectorSecret;
  /** the server definition, with ${KEY} where the secret goes */
  server: McpServer;
  category: "Code & issues" | "Data & infra" | "Knowledge & search" | "Docs & content" | "Business";
}

const bearer = (key: string) => ({ Authorization: `Bearer \${${key}}` });

/** Hosted MCP servers that take a token in a header or URL (no browser sign-in needed from a computer), plus a few that need nothing. */
export const CONNECTOR_CATALOG: Connector[] = [
  {
    id: "github",
    label: "GitHub",
    blurb: "Repos, issues, pull requests, code search",
    domain: "github.com",
    kind: "http",
    category: "Code & issues",
    secret: { key: "GITHUB_TOKEN", label: "Personal access token", help: "GitHub → Settings → Developer settings → Personal access tokens", helpUrl: "https://github.com/settings/tokens", placeholder: "ghp_… or github_pat_…" },
    server: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: bearer("GITHUB_TOKEN") },
  },
  {
    id: "supabase",
    label: "Supabase",
    blurb: "Projects, tables, SQL, edge functions, logs",
    domain: "supabase.com",
    kind: "http",
    category: "Data & infra",
    secret: { key: "SUPABASE_ACCESS_TOKEN", label: "Personal access token", help: "Supabase dashboard → Account → Access tokens", helpUrl: "https://supabase.com/dashboard/account/tokens", placeholder: "sbp_…" },
    server: { type: "http", url: "https://mcp.supabase.com/mcp", headers: bearer("SUPABASE_ACCESS_TOKEN") },
  },
  {
    id: "neon",
    label: "Neon",
    blurb: "Serverless Postgres: projects, branches, SQL",
    domain: "neon.tech",
    kind: "http",
    category: "Data & infra",
    secret: { key: "NEON_API_KEY", label: "API key", help: "Neon console → Account settings → API keys", helpUrl: "https://console.neon.tech/app/settings/api-keys" },
    server: { type: "http", url: "https://mcp.neon.tech/mcp", headers: bearer("NEON_API_KEY") },
  },
  {
    id: "render",
    label: "Render",
    blurb: "Services, deploys, logs and metrics on Render",
    domain: "render.com",
    kind: "http",
    category: "Data & infra",
    secret: { key: "RENDER_API_KEY", label: "API key", help: "Render dashboard → Account settings → API keys", helpUrl: "https://dashboard.render.com/settings#api-keys", placeholder: "rnd_…" },
    server: { type: "http", url: "https://mcp.render.com/mcp", headers: bearer("RENDER_API_KEY") },
  },
  {
    id: "stripe",
    label: "Stripe",
    blurb: "Customers, payments, subscriptions, invoices",
    domain: "stripe.com",
    kind: "http",
    category: "Business",
    secret: { key: "STRIPE_SECRET_KEY", label: "Secret key (a restricted key is safest)", help: "Stripe dashboard → Developers → API keys", helpUrl: "https://dashboard.stripe.com/apikeys", placeholder: "sk_… or rk_…" },
    server: { type: "http", url: "https://mcp.stripe.com", headers: bearer("STRIPE_SECRET_KEY") },
  },
  {
    id: "posthog",
    label: "PostHog",
    blurb: "Product analytics: insights, flags, errors",
    domain: "posthog.com",
    kind: "http",
    category: "Business",
    secret: { key: "POSTHOG_API_KEY", label: "Personal API key", help: "PostHog → Settings → Personal API keys", helpUrl: "https://app.posthog.com/settings/user-api-keys", placeholder: "phx_…" },
    server: { type: "http", url: "https://mcp.posthog.com/mcp", headers: bearer("POSTHOG_API_KEY") },
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    blurb: "Models, datasets, Spaces and papers on the Hub",
    domain: "huggingface.co",
    kind: "http",
    category: "Knowledge & search",
    secret: { key: "HF_TOKEN", label: "Access token", help: "Hugging Face → Settings → Access tokens", helpUrl: "https://huggingface.co/settings/tokens", placeholder: "hf_…" },
    server: { type: "http", url: "https://huggingface.co/mcp", headers: bearer("HF_TOKEN") },
  },
  {
    id: "context7",
    label: "Context7",
    blurb: "Current docs for any library, straight into the answer",
    domain: "context7.com",
    kind: "http",
    category: "Docs & content",
    secret: { key: "CONTEXT7_API_KEY", label: "API key", help: "context7.com → Dashboard → API keys (free)", helpUrl: "https://context7.com/dashboard" },
    server: { type: "http", url: "https://mcp.context7.com/mcp", headers: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" } },
  },
  {
    id: "exa",
    label: "Exa",
    blurb: "Web search built for agents",
    domain: "exa.ai",
    kind: "http",
    category: "Knowledge & search",
    secret: { key: "EXA_API_KEY", label: "API key", help: "dashboard.exa.ai → API keys", helpUrl: "https://dashboard.exa.ai/api-keys" },
    server: { type: "http", url: "https://mcp.exa.ai/mcp?exaApiKey=${EXA_API_KEY}" },
  },
  {
    id: "tavily",
    label: "Tavily",
    blurb: "Search and extract from the web",
    domain: "tavily.com",
    kind: "http",
    category: "Knowledge & search",
    secret: { key: "TAVILY_API_KEY", label: "API key", help: "app.tavily.com → API keys", helpUrl: "https://app.tavily.com/home", placeholder: "tvly-…" },
    server: { type: "http", url: "https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_API_KEY}" },
  },
  {
    id: "firecrawl",
    label: "Firecrawl",
    blurb: "Scrape and crawl websites into clean markdown",
    domain: "firecrawl.dev",
    kind: "http",
    category: "Knowledge & search",
    secret: { key: "FIRECRAWL_API_KEY", label: "API key", help: "firecrawl.dev → API keys", helpUrl: "https://www.firecrawl.dev/app/api-keys", placeholder: "fc-…" },
    server: { type: "http", url: "https://mcp.firecrawl.dev/${FIRECRAWL_API_KEY}/v2/mcp" },
  },
  {
    id: "deepwiki",
    label: "DeepWiki",
    blurb: "Ask questions about any public GitHub repo",
    domain: "deepwiki.com",
    kind: "http",
    category: "Docs & content",
    server: { type: "http", url: "https://mcp.deepwiki.com/mcp" },
  },
  {
    id: "cloudflare-docs",
    label: "Cloudflare Docs",
    blurb: "Search Cloudflare's documentation",
    domain: "cloudflare.com",
    kind: "http",
    category: "Docs & content",
    server: { type: "http", url: "https://docs.mcp.cloudflare.com/mcp" },
  },
  {
    id: "microsoft-learn",
    label: "Microsoft Learn",
    blurb: "Microsoft and Azure documentation",
    domain: "microsoft.com",
    kind: "http",
    category: "Docs & content",
    server: { type: "http", url: "https://learn.microsoft.com/api/mcp" },
  },
  {
    id: "aws-knowledge",
    label: "AWS Knowledge",
    blurb: "AWS docs, API references and best practices",
    domain: "aws.amazon.com",
    kind: "http",
    category: "Docs & content",
    server: { type: "http", url: "https://knowledge-mcp.global.api.aws" },
  },
  {
    id: "notion",
    label: "Notion",
    blurb: "Pages and databases in a workspace",
    domain: "notion.so",
    kind: "stdio",
    category: "Docs & content",
    secret: { key: "NOTION_TOKEN", label: "Internal integration secret", help: "notion.so/profile/integrations → New integration, then share pages with it", helpUrl: "https://www.notion.so/profile/integrations", placeholder: "ntn_…" },
    server: { command: "npx", args: ["-y", "@notionhq/notion-mcp-server"], env: { NOTION_TOKEN: "${NOTION_TOKEN}" } },
  },
  {
    id: "brave-search",
    label: "Brave Search",
    blurb: "Web, news and image search",
    domain: "brave.com",
    kind: "stdio",
    category: "Knowledge & search",
    secret: { key: "BRAVE_API_KEY", label: "API key", help: "api-dashboard.search.brave.com → API keys", helpUrl: "https://api-dashboard.search.brave.com/app/keys" },
    server: { command: "npx", args: ["-y", "@brave/brave-search-mcp-server"], env: { BRAVE_API_KEY: "${BRAVE_API_KEY}" } },
  },
];

export const CONNECTOR_CATEGORIES: Connector["category"][] = ["Code & issues", "Knowledge & search", "Docs & content", "Data & infra", "Business"];

/** Catalog rows matching a search, or all of them for a blank query. */
export function searchConnectors(query: string, catalog: Connector[] = CONNECTOR_CATALOG): Connector[] {
  const q = query.trim().toLowerCase();
  if (!q) return catalog;
  const words = q.split(/\s+/);
  return catalog.filter((c) => {
    const hay = `${c.id} ${c.label} ${c.blurb} ${c.domain} ${c.category}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

const VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/** Every `${VAR}` a server definition references, in order, once each. `$${VAR}` is an escape and does not count. */
export function referencedVars(server: McpServer): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      // strip escapes first, then read the references
      for (const m of v.replace(/\$\$\{[A-Z_][A-Z0-9_]*\}/g, "").matchAll(VAR_RE)) if (!out.includes(m[1]!)) out.push(m[1]!);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(server);
  return out;
}

/** Which referenced vars are not among the environment's secret keys. */
export function missingVars(server: McpServer, secretKeys: Iterable<string>): string[] {
  const have = new Set(secretKeys);
  return referencedVars(server).filter((k) => !have.has(k));
}

export function isHosted(s: McpServer): s is Extract<McpServer, { url: string }> {
  return typeof (s as { url?: unknown }).url === "string";
}

/** One line describing a server for a list: the URL (tokens in the query masked) or the command. */
export function describeServer(s: McpServer): string {
  if (isHosted(s)) return s.url.replace(/([?&][^=&]+=)[^&]+/g, "$1…").replace(/\/\$\{[A-Z_][A-Z0-9_]*\}\//, "/…/");
  return [s.command, ...(s.args ?? [])].join(" ");
}

/** The catalog connector an installed server came from, by its key; null for a custom one. */
export function connectorFor(id: string, catalog: Connector[] = CONNECTOR_CATALOG): Connector | null {
  return catalog.find((c) => c.id === id) ?? null;
}

/** mcp_servers with one added (replacing an entry of the same name). */
export function withServer(servers: Record<string, McpServer>, id: string, def: McpServer): Record<string, McpServer> {
  return { ...servers, [id]: def };
}

export function withoutServer(servers: Record<string, McpServer>, id: string): Record<string, McpServer> {
  const { [id]: _gone, ...rest } = servers;
  return rest;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

/** A name an mcp_servers key can have: lower-case slug. */
export function validServerId(id: string): boolean {
  return ID_RE.test(id);
}

/** A name a secret can have (UPPER_SNAKE, the same shape `${VAR}` accepts). */
export function validSecretKey(key: string): boolean {
  return KEY_RE.test(key);
}

/** `label` → a server id: "My Server" → "my-server". */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Parse `KEY=value` lines (one per line; blank lines and # comments
 * skipped) into a map. Values may be `${VAR}` references. A line without
 * `=` or with a bad key is an error naming the line.
 */
export function parseKeyValues(text: string): { ok: true; map: Record<string, string> } | { ok: false; error: string } {
  const map: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return { ok: false, error: `"${line}" is not KEY=value` };
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return { ok: false, error: `"${key}" is not a valid name` };
    map[key] = value;
  }
  return { ok: true, map };
}

/** `npx -y foo --bar` → ["npx", "-y", "foo", "--bar"], honouring simple quotes. */
export function splitCommand(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of text.trim().matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

/**
 * Build a custom server from the form: a hosted URL with optional headers,
 * or a command line with optional env. Returns an error string for a form
 * that does not add up.
 */
export function buildCustomServer(input: { kind: "http" | "stdio"; url: string; command: string; headers: string; env: string }): { ok: true; server: McpServer } | { ok: false; error: string } {
  if (input.kind === "http") {
    const url = input.url.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) return { ok: false, error: "The URL must start with http:// or https://" };
    const h = parseKeyValues(input.headers);
    if (!h.ok) return { ok: false, error: `Headers: ${h.error}` };
    const server: McpServer = { type: "http", url };
    if (Object.keys(h.map).length) server.headers = h.map;
    return { ok: true, server };
  }
  const argv = splitCommand(input.command);
  if (!argv.length) return { ok: false, error: "A command is needed — e.g. npx -y some-mcp-server" };
  const e = parseKeyValues(input.env);
  if (!e.ok) return { ok: false, error: `Environment: ${e.error}` };
  const server: McpServer = { command: argv[0]!, args: argv.slice(1) };
  if (Object.keys(e.map).length) server.env = e.map;
  return { ok: true, server };
}
