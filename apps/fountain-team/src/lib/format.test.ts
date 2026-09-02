import { describe, expect, test } from "bun:test";
import { formatTokens, formatUsage } from "./format";
import { describeCron, isCronLike } from "./cron";
import { teamManifest, toYaml, yamlScalar } from "./manifest";

describe("formatTokens", () => {
  test("rounds like a chat app", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(1_234_567)).toBe("1.2M");
    expect(formatTokens(null)).toBe("—");
    expect(formatUsage({ input: 0, output: 0 })).toBeNull();
    expect(formatUsage({ input: 12_345, output: 500 })).toBe("12.3k in · 500 out");
  });
});

describe("cron", () => {
  test("accepts five fields, ranges, steps and @names; refuses the rest", () => {
    expect(isCronLike("0 9 * * 1-5")).toBe(true);
    expect(isCronLike("*/30 * * * *")).toBe(true);
    expect(isCronLike("0 0 1 * *")).toBe(true);
    expect(isCronLike("@daily")).toBe(true);
    expect(isCronLike("0 9 * *")).toBe(false);
    expect(isCronLike("every morning")).toBe(false);
    expect(isCronLike("0 9 * * mon-fri")).toBe(true);
  });
  test("describes presets, echoes the rest", () => {
    expect(describeCron("0 9 * * 1-5")).toBe("Weekdays at 09:00 UTC");
    expect(describeCron("5 4 * * *")).toBe("5 4 * * * (UTC)");
  });
});

describe("manifest", () => {
  test("emits one Agent document per teammate with names for environments", () => {
    const y = teamManifest(
      [
        {
          name: "coo",
          agent: {
            id: "a1",
            name: "philosoraptor",
            model: "anthropic/claude-sonnet-4-6",
            runtime: "claude",
            environment_id: "e1",
            allowed_vault_ids: null,
            allowed_environment_ids: null,
            description: "thinks: deeply",
            system: "line one\nline two",
            skills: [{ source: "BinaryBourbon/fountain-api-skill" }],
            mcp_servers: { github: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } } },
          },
        },
      ],
      [{ id: "e1", name: "proj-env" }],
      "2026-08-19T00:00:00Z",
    );
    expect(y).toContain("kind: Agent");
    expect(y).toContain("  name: philosoraptor");
    expect(y).toContain("# teammate: coo (agent philosoraptor)");
    expect(y).toContain("  environment: proj-env");
    expect(y).toContain('  description: "thinks: deeply"');
    expect(y).toContain("  system: |-\n    line one\n    line two");
    expect(y).toContain("  skills:\n    - source: BinaryBourbon/fountain-api-skill");
    expect(y).toContain("        Authorization: Bearer ${GITHUB_TOKEN}");
    expect(y).toContain("fountain apply -f team.yml");
  });
  test("yaml scalars quote what would otherwise be misread", () => {
    expect(yamlScalar("plain")).toBe("plain");
    expect(yamlScalar("yes")).toBe('"yes"');
    expect(yamlScalar("1.5")).toBe('"1.5"');
    expect(yamlScalar("a: b")).toBe('"a: b"');
    expect(toYaml({ a: [], b: {}, c: [1, "x"], d: { e: null } })).toBe("a: []\nb: {}\nc:\n  - 1\n  - x\nd:\n  e: null");
  });
});
