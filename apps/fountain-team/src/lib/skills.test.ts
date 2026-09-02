import { describe, expect, test } from "bun:test";
import { SKILL_CATALOG, catalogByCollection, hasSkill, parseSkillSource, sameSkill, searchCatalog, skillFromCatalog, skillLabel, validSkillName, withSkill, withoutSkill } from "./skills";

describe("skills catalog", () => {
  test("every row is a GitHub source with a skill name, unique per source", () => {
    const seen = new Set<string>();
    for (const s of SKILL_CATALOG) {
      expect(s.source).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(s.name).toMatch(/^[\w.-]+$/);
      expect(seen.has(`${s.source}#${s.name}`)).toBe(false);
      seen.add(`${s.source}#${s.name}`);
    }
  });

  test("groups by collection in catalog order", () => {
    const groups = catalogByCollection();
    expect(groups[0]!.collection).toBe("Anthropic");
    expect(groups.reduce((n, g) => n + g.skills.length, 0)).toBe(SKILL_CATALOG.length);
  });

  test("search matches every word across name, blurb, source and collection", () => {
    expect(searchCatalog("pdf").map((s) => s.name)).toEqual(["pdf"]);
    expect(searchCatalog("vercel react").map((s) => s.name)).toContain("react-best-practices");
    expect(searchCatalog("   ")).toBe(SKILL_CATALOG);
    expect(searchCatalog("zzz-nothing")).toEqual([]);
  });
});

describe("an agent's skills", () => {
  const pdf = skillFromCatalog(SKILL_CATALOG[0]!);
  const inline = { name: "house-style", content: "# house style" };

  test("identity: github by source+name (case-insensitive source), inline by name", () => {
    expect(sameSkill(pdf, { source: "Anthropics/Skills", name: "pdf" })).toBe(true);
    expect(sameSkill(pdf, { source: "anthropics/skills", name: "docx" })).toBe(false);
    expect(sameSkill(pdf, { source: "anthropics/skills" })).toBe(false);
    expect(sameSkill(inline, { name: "house-style", content: "other" })).toBe(true);
    expect(sameSkill(inline, { source: "x/y", name: "house-style" })).toBe(false);
  });

  test("add is idempotent; remove matches by identity", () => {
    const once = withSkill([], pdf);
    expect(withSkill(once, { source: "anthropics/skills", name: "pdf" })).toBe(once);
    expect(hasSkill(once, pdf)).toBe(true);
    expect(withoutSkill([...once, inline], { source: "ANTHROPICS/skills", name: "pdf" })).toEqual([inline]);
  });

  test("labels: the skill name, else the repo", () => {
    expect(skillLabel(pdf)).toBe("pdf");
    expect(skillLabel({ source: "obra/superpowers" })).toBe("superpowers");
    expect(skillLabel(inline)).toBe("house-style");
  });

  test("valid names are slugs", () => {
    expect(validSkillName("my-skill_2.0")).toBe(true);
    expect(validSkillName(".hidden")).toBe(false);
    expect(validSkillName("has space")).toBe(false);
  });
});

describe("parseSkillSource", () => {
  test("owner/repo, with @ref and a separate name", () => {
    expect(parseSkillSource("obra/superpowers")).toEqual({ source: "obra/superpowers" });
    expect(parseSkillSource("obra/superpowers@v1.2", "brainstorming")).toEqual({ source: "obra/superpowers", name: "brainstorming", ref: "v1.2" });
  });

  test("github urls, deep links to a skill directory, skills.sh urls", () => {
    expect(parseSkillSource("https://github.com/anthropics/skills")).toEqual({ source: "anthropics/skills" });
    expect(parseSkillSource("https://github.com/anthropics/skills.git")).toEqual({ source: "anthropics/skills" });
    expect(parseSkillSource("https://github.com/anthropics/skills/tree/main/skills/pdf")).toEqual({ source: "anthropics/skills", name: "pdf", ref: "main" });
    expect(parseSkillSource("https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md")).toEqual({ source: "anthropics/skills", name: "pdf", ref: "main" });
    expect(parseSkillSource("https://skills.sh/vercel-labs/agent-skills/react-best-practices")).toEqual({ source: "vercel-labs/agent-skills", name: "react-best-practices" });
  });

  test("rejects what is not a repo", () => {
    expect(parseSkillSource("")).toBeNull();
    expect(parseSkillSource("just-a-word")).toBeNull();
    expect(parseSkillSource("a/b/c")).toBeNull();
    expect(parseSkillSource("a/b@bad ref")).toBeNull();
    expect(parseSkillSource("a/b", "bad name")).toBeNull();
  });
});
