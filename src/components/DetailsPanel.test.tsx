/**
 * The panel's copy. The derivation is tested in src/lib/details.test.ts; this
 * is here for the two things that file cannot say: that the panel does not
 * throw on the ordinary case (a panel that throws is a conversation that will
 * not open), and that the sentences a reader depends on are actually on the
 * page — that a bundled skill is marked as one, that the caveats are printed
 * rather than merely computed, and that no credential the proxy failed to
 * withhold could be rendered here.
 */
import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent, Conversation, SandboxRecord } from "../types";

// The avatar reaches into the project store for the bearer key an <img> cannot
// send; nothing about it is what this file is checking.
mock.module("./AgentAvatar", () => ({ AgentAvatar: ({ agent }: { agent: Agent }) => <span className="avatar">{agent.name.slice(0, 2)}</span> }));

const agent: Agent = {
  id: "a1",
  name: "Coder",
  model: "anthropic/claude-sonnet-4-6",
  runtime: "claude",
  skills: [{ name: "house-style", content: "# House style" }, { source: "anthropics/skills", ref: "v2" }],
  mcp_servers: {
    workbench: { type: "http", url: "https://workbench.inevitable.fyi/mcp", headers: { Authorization: "[withheld by the workbench]" } },
    gh: { command: "gh-mcp", args: ["--repo", "acme/thing"], env: { GITHUB_TOKEN: "[withheld by the workbench]" } },
  },
  permission_policy: { execute: "ask", default: "auto_allow" },
} as Agent;

const conversation: Conversation = {
  id: "11111111-2222-3333-4444-555555555555",
  runtime: "claude",
  acp: true,
  status: "idle",
  agent_id: "a1",
  sandbox_id: "sb1",
  channel_id: "workbench:p1/w1/t1",
  turn_count: 7,
  usage_total: { input: 12_000, output: 3_400 },
  inserted_at: "2026-08-24T09:00:00Z",
  last_active_at: "2026-08-24T09:40:00Z",
  environment_id: "e1",
  vault_id: "v1",
} as Conversation;

const sandbox: SandboxRecord = { id: "sb1", sprite_name: "fountain-abcd1234-quiet-hill", status: "ready", provider: "sprites", mode: "ephemeral" } as SandboxRecord;

function store(over: { conversations?: Conversation[]; sandboxes?: [string, SandboxRecord][] } = {}) {
  return {
    project: { id: "p1", name: "Workbench", environmentId: "e1", vaultId: "v1" },
    items: [{ id: "w1", title: "Fix the importer" }],
    conversations: over.conversations ?? [conversation],
    agents: new Map([["a1", agent]]),
    environments: new Map([["e1", { id: "e1", name: "workbench-env" }]]),
    vaults: new Map([["v1", { id: "v1", name: "workbench-vault" }]]),
    sandboxes: new Map(over.sandboxes ?? [["sb1", sandbox]]),
    fountain: { sandbox: () => new Promise(() => {}) },
  };
}

let current = store();
// Only `useProject` is stubbed, and the rest of the module is kept as it is.
// `mock.module` replaces the module for the whole test *process*, not for this
// file — so a factory returning `{ useProject }` alone unexports everything
// else, and any test file loaded after this one that reaches `useWorkbench`
// (Cost, ItemStatus, Board, Feed — all of them through a component) dies at
// link time with "Export named 'useWorkbench' not found". Which of those
// files break depends on the order bun happens to walk them in, so adding a
// test file anywhere in the repo can turn this red. Spread the real module.
const realStore = await import("../store");
mock.module("../store", () => ({ ...realStore, useProject: () => current }));
const { DetailsPanel } = await import("./DetailsPanel");

const render = () => renderToStaticMarkup(<DetailsPanel conversationId={conversation.id} onClose={() => {}} />);

describe("the details panel", () => {
  test("says what the conversation is running with", () => {
    current = store();
    const html = render();
    expect(html).toContain("Coder");
    expect(html).toContain("anthropic/claude-sonnet-4-6");
    expect(html).toContain("Fix the importer");
    expect(html).toContain("quiet-hill"); // the sprite, with Fountain's id prefix trimmed
    expect(html).toContain("workbench-env");
    expect(html).toContain("workbench-vault");
    expect(html).toContain("ephemeral");
  });

  test("lists the skills on the machine, not just the ones on the teammate", () => {
    current = store();
    const html = render();
    // Fountain writes these onto every sprite; a list without them is short.
    expect(html).toContain("fountain");
    expect(html).toContain("create-team");
    expect(html).toContain("bundled");
    expect(html).toContain("house-style");
    expect(html).toContain("anthropics/skills@v2");
    // A machine that is up was given its skills when it came up.
    expect(html).toContain("already up");
  });

  test("lists the MCP servers by name and wire, with the key names and no values", () => {
    current = store();
    const html = render();
    expect(html).toContain("workbench");
    expect(html).toContain("https://workbench.inevitable.fyi/mcp");
    expect(html).toContain("gh-mcp --repo acme/thing");
    expect(html).toContain("GITHUB_TOKEN");
    expect(html).toContain("Authorization");
    // The panel renders key names; it must never render a value, whatever the
    // proxy handed it. Its own placeholder is the only thing a value can be.
    expect(html).not.toContain("withheld by the workbench");
    // And it says what it cannot show at all.
    expect(html).toContain("Buzz identity");
  });

  test("shows the policy in force, merged, and explains that it is merged", () => {
    current = store();
    const html = render();
    expect(html).toContain("execute");
    expect(html).toContain(">ask<");
    expect(html).toContain("withholds more");
  });

  test("a conversation the project no longer lists does not throw", () => {
    current = store({ conversations: [{ ...conversation, id: "someone-else" }] });
    expect(render()).toContain("may have been retired");
  });

  test("an empty list is a project still loading, not a thread that went away", () => {
    current = store({ conversations: [] });
    const html = render();
    expect(html).toContain("Loading…");
    expect(html).not.toContain("retired");
  });

  test("no sandbox record yet is a gap, not a crash", () => {
    current = store({ sandboxes: [] });
    const html = render();
    expect(html).toContain("unknown");
    // Nothing is claimed about skills when there is no machine to disagree.
    expect(html).not.toContain("already up");
  });
});
