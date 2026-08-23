import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { FountainClient } from "../api/client";
import type { Agent, Teammate } from "../api/types";
import { Profile } from "./Profile";
import { SkillsTab } from "./SkillsTab";
import { AppsTab } from "./AppsTab";

// A render smoke test: the customize panel and both tabs render for a
// teammate with and without skills/apps, and say the things the UI promises.
// (No browser here — effects do not run, so data comes through props.)

const client = {
  baseUrl: "https://fountain.test",
  getAgent: () => new Promise(() => {}),
  listEnvironments: () => Promise.resolve([]),
  getCatalog: () => Promise.resolve(null),
  inferenceCredentials: () => Promise.resolve({}),
  listEnvironmentSecrets: () => Promise.resolve([]),
  avatarUrl: () => null,
} as unknown as FountainClient;

const agent: Agent = {
  id: "a1",
  name: "Koda",
  model: "anthropic/claude-sonnet-5",
  runtime: "claude",
  environment_id: null,
  allowed_vault_ids: null,
  allowed_environment_ids: null,
  skills: [
    { source: "anthropics/skills", name: "pdf" },
    { name: "house-style", content: "# style" },
  ],
  mcp_servers: {
    github: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } },
    mine: { command: "npx", args: ["-y", "x"] },
  },
};

const teammate: Teammate = {
  agent_id: "a1",
  name: "Koda",
  agent,
  conversation: {
    id: "c1",
    title: null,
    sandbox_id: null,
    sandbox: null,
    agent_id: "a1",
    vault_id: null,
    environment_id: null,
    runtime: "claude",
    acp: true,
    status: "pending",
    channel_id: "fountain:team",
    turn_count: 0,
    last_active_at: null,
    last_read_at: null,
    unread: false,
    inserted_at: "",
    updated_at: "",
  },
  presence: { state: "online", label: "ready" },
  unread: false,
  last_turn: null,
  preview: null,
};

describe("customize panel", () => {
  test("renders the shell with three tabs and no Fountain links", () => {
    const html = renderToString(<Profile client={client} teammate={teammate} onClose={() => {}} />);
    expect(html).toContain("Customize Koda");
    expect(html).toContain("Skills");
    expect(html).toContain("Apps");
    expect(html).not.toContain("Edit agent in Fountain");
    expect(html).not.toContain("fountain.test/agents");
  });

  test("skills tab lists what they have, the catalog, and the add paths", () => {
    const html = renderToString(<SkillsTab client={client} agent={agent} name="Koda" onAgent={() => {}} />);
    expect(html).toContain("house-style");
    expect(html).toContain("written here");
    expect(html).toContain("anthropics/skills");
    expect(html).toContain("✓ Added"); // pdf is in the catalog and installed
    expect(html).toContain("From GitHub…");
    expect(html).toContain("Write your own…");
    expect(html).toContain("Superpowers");
  });

  test("apps tab lists connected servers (catalog and custom) and the marketplace", () => {
    const html = renderToString(<AppsTab client={client} agent={agent} teammate={teammate} envs={[]} onEnvs={() => {}} onAgent={() => {}} />);
    expect(html).toContain("✓ Connected"); // github
    expect(html).toContain("custom"); // mine
    expect(html).toContain("npx -y x");
    expect(html).toContain("Custom server…");
    expect(html).toContain("Stripe");
    expect(html).toContain("no sign-in");
  });

  test("the computer field offers your own machine for a teammate on a runner and says how to start one", () => {
    // effects do not run in SSR, so no catalog arrives; a teammate already on a runner shows the field regardless
    const onRunner = { ...teammate, agent: { ...agent, sandbox_provider: "runner" } };
    const html = renderToString(<Profile client={client} teammate={onRunner} onClose={() => {}} onRunners={() => {}} />);
    expect(html).toContain("Your own machine (fountain runner)");
    expect(html).toContain("Checking your machines…");
    expect(html).toContain("How to set one up");
  });

  // The selector that set this is withdrawn (fountain#996): "always" means
  // three different things across the runtimes and, for one shape of command,
  // nothing at all. These two tests are the contract that replaced it — no way
  // to set one here, and no silence about one set elsewhere.
  test("nothing here can set a permission policy, and a teammate without one says nothing about it", () => {
    const html = renderToString(<Profile client={client} teammate={teammate} onClose={() => {}} />);
    expect(html).not.toContain("Before they run a tool");
    expect(html).not.toContain("Ask me first");
    expect(html).not.toContain("Let them run it");
    // the whole control is gone, not merely disabled
    expect(html).not.toContain('value="auto_deny"');
  });

  test("a policy set outside this app is shown, read-only, and says where to change it", () => {
    const asking = { ...teammate, agent: { ...agent, permission_policy: { default: "ask" as const } } };
    const html = renderToString(<Profile client={client} teammate={asking} onClose={() => {}} />);
    expect(html).toContain("Before they run a tool");
    expect(html).toContain("Ask me first");
    expect(html).toContain("fountain acp --permission");
    // read-only: no control to change it with
    expect(html).not.toContain('<option value="ask"');
  });

  test("an empty teammate renders both tabs with nothing yet", () => {
    const bare = { ...agent, skills: [], mcp_servers: {} };
    expect(renderToString(<SkillsTab client={client} agent={bare} name="Koda" onAgent={() => {}} />)).toContain("nothing yet");
    expect(renderToString(<AppsTab client={client} agent={bare} teammate={teammate} envs={[]} onEnvs={() => {}} onAgent={() => {}} />)).toContain("nothing yet");
  });
});
