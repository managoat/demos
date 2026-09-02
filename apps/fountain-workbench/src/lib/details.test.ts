import { describe, expect, test } from "bun:test";
import type { Agent, Conversation } from "../types";
import {
  BUNDLED_SKILLS,
  cotenants,
  describeMode,
  effectivePolicy,
  mcpServersOf,
  policyBites,
  policyRows,
  skillsCaveat,
  skillsOf,
  stricter,
  verdictFor,
} from "./details";

const agent = (over: Partial<Agent>): Agent => ({ id: "a1", name: "Coder", model: "anthropic/claude-sonnet-4-6", runtime: "claude", ...over }) as Agent;

describe("the permission policy in force", () => {
  test("a tool's own entry wins, then the default, then auto_allow", () => {
    expect(verdictFor({ execute: "ask", default: "auto_deny" }, "execute")).toBe("ask");
    expect(verdictFor({ default: "auto_deny" }, "execute")).toBe("auto_deny");
    expect(verdictFor({ execute: "ask" }, "read")).toBe("auto_allow");
    expect(verdictFor(null, "read")).toBe("auto_allow");
    expect(verdictFor({ default: "ask" }, null)).toBe("ask");
  });

  test("a value that is not a verdict is read as a denial, never as an allow", () => {
    // The changesets reject these, so a row carrying one was written around
    // them; trusting it into an allow is the one direction that is unsafe.
    expect(verdictFor({ execute: "yes please" }, "execute")).toBe("auto_deny");
    expect(verdictFor({ default: 7 }, "read")).toBe("auto_deny");
  });

  test("stricter takes the one that withholds more", () => {
    expect(stricter("auto_allow", "ask")).toBe("ask");
    expect(stricter("auto_deny", "ask")).toBe("auto_deny");
    expect(stricter("ask", "ask")).toBe("ask");
  });

  test("the launch clamps the agent and can never loosen it", () => {
    const merged = effectivePolicy({ execute: "ask", read: "auto_allow", default: "auto_allow" }, { execute: "auto_allow", read: "auto_deny" });
    expect(merged.execute).toBe("ask"); // the launch asked for looser; it does not get it
    expect(merged.read).toBe("auto_deny"); // the launch asked for stricter; it does
    expect(merged.default).toBe("auto_allow");
  });

  test("a key either side names is in the answer, and the default is merged apart", () => {
    const merged = effectivePolicy({ edit: "ask" }, { fetch: "auto_deny", default: "ask" });
    expect(merged).toEqual({ edit: "ask", fetch: "auto_deny", default: "ask" });
  });

  test("a launch with only a default still tightens every tool the agent left to its own", () => {
    const merged = effectivePolicy({ default: "auto_allow" }, { default: "ask" });
    expect(merged.default).toBe("ask");
  });

  test("no policy at all is auto_allow everywhere, and does not bite", () => {
    const merged = effectivePolicy(null, null);
    expect(merged).toEqual({ default: "auto_allow" });
    expect(policyBites(merged)).toBe(false);
    expect(policyBites(effectivePolicy({ execute: "ask" }, null))).toBe(true);
  });

  test("rows are the tools sorted, then the default", () => {
    expect(policyRows({ execute: "ask", default: "auto_allow", edit: "auto_deny" })).toEqual([
      { tool: "edit", verdict: "auto_deny" },
      { tool: "execute", verdict: "ask" },
      { tool: "default", verdict: "auto_allow" },
    ]);
  });
});

describe("MCP servers", () => {
  test("no type means stdio, and the command and argument list come through", () => {
    const [s] = mcpServersOf(agent({ mcp_servers: { files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/work"] } } }));
    expect(s).toEqual({ name: "files", transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/work"], url: null, envKeys: [], headerKeys: [] });
  });

  test("http and sse are reached at a url", () => {
    const [s] = mcpServersOf(agent({ mcp_servers: { workbench: { type: "http", url: "https://fountain-workbench.demo.managoat.com/mcp" } } }));
    expect(s!.transport).toBe("http");
    expect(s!.url).toBe("https://fountain-workbench.demo.managoat.com/mcp");
    expect(s!.command).toBeNull();
  });

  test("env and header names are kept; values are not read at all", () => {
    const servers = mcpServersOf(
      agent({
        mcp_servers: {
          gh: { command: "gh-mcp", env: { GITHUB_TOKEN: "ghp_real_secret", GH_HOST: "github.com" } },
          hosted: { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer ftn_real_secret" } },
        },
      }),
    );
    expect(servers.map((s) => s.name)).toEqual(["gh", "hosted"]);
    expect(servers[0]!.envKeys).toEqual(["GH_HOST", "GITHUB_TOKEN"]);
    expect(servers[1]!.headerKeys).toEqual(["Authorization"]);
    // Nothing in what this returns carries a value.
    expect(JSON.stringify(servers)).not.toContain("secret");
  });

  test("servers come out sorted by name, as ACP delivers them", () => {
    expect(mcpServersOf(agent({ mcp_servers: { zed: {}, alpha: {}, mid: {} } })).map((s) => s.name)).toEqual(["alpha", "mid", "zed"]);
  });

  test("an agent with none, or a malformed entry, does not throw", () => {
    expect(mcpServersOf(agent({}))).toEqual([]);
    expect(mcpServersOf(null)).toEqual([]);
    const [s] = mcpServersOf(agent({ mcp_servers: { broken: "not a map" } as never }));
    expect(s!.transport).toBe("stdio");
    expect(s!.command).toBeNull();
  });
});

describe("skills", () => {
  test("the machine's bundled skills come first, whatever the agent says", () => {
    expect(skillsOf(agent({})).map((s) => s.name)).toEqual(BUNDLED_SKILLS);
    expect(skillsOf(agent({})).every((s) => s.bundled)).toBe(true);
  });

  test("an inline skill is named by its name; a github one by its name, else its repo's tail", () => {
    const skills = skillsOf(
      agent({
        skills: [
          { name: "house-style", content: "# House style\n" },
          { source: "anthropics/skills", ref: "v2" },
          { source: "acme/tools", name: "acme" },
        ],
      }),
    );
    expect(skills.slice(BUNDLED_SKILLS.length)).toEqual([
      { name: "house-style", source: "inline", repo: null, ref: null, bundled: false },
      { name: "skills", source: "github", repo: "anthropics/skills", ref: "v2", bundled: false },
      { name: "acme", source: "github", repo: "acme/tools", ref: null, bundled: false },
    ]);
  });

  test("the caveat is about a machine that is up, because that is the one the list can disagree with", () => {
    expect(skillsCaveat("ready")).toContain("already up");
    expect(skillsCaveat("suspended")).toContain("already up");
    expect(skillsCaveat("terminated")).toBeNull();
    expect(skillsCaveat("pending")).toBeNull();
    expect(skillsCaveat(null)).toBeNull();
  });
});

describe("the computer", () => {
  test("persistent is called out, because the tree assumes it is not", () => {
    expect(describeMode("persistent").note).toContain("other work items");
    expect(describeMode("ephemeral").note).toContain("reclaimed");
    expect(describeMode(null)).toEqual({ label: "—", note: null });
  });

  test("cotenants are the others on the same computer", () => {
    const convs = [
      { id: "c1", sandbox_id: "sb1" },
      { id: "c2", sandbox_id: "sb1" },
      { id: "c3", sandbox_id: "sb2" },
    ] as Conversation[];
    expect(cotenants("c1", convs, "sb1").map((c) => c.id)).toEqual(["c2"]);
    expect(cotenants("c1", convs, null)).toEqual([]);
  });
});
