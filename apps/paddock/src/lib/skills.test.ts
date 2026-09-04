import { describe, expect, test } from "bun:test";
import { githubSkill, hitToSkill, inlineSkill, isGithubSkill, parseSource, readSkills, skillKey, skillLabel } from "./skills";

/**
 * These assertions are Fountain's `Agent.validate_skills/1` and
 * `Managoat.Runtimes.Skills.safe_token!/1`, written down on this side. If they
 * ever disagree, this file is the one that is wrong.
 */
describe("the shapes Fountain accepts", () => {
  test("a github entry is {source, ref?, name?}", () => {
    expect(githubSkill({ source: "anthropics/skills" })).toEqual({ entry: { source: "anthropics/skills" } });
    expect(githubSkill({ source: "anthropics/skills", ref: "v1.2.0", name: "pdf" })).toEqual({
      entry: { source: "anthropics/skills", ref: "v1.2.0", name: "pdf" },
    });
  });

  test("a blank ref is omitted, never sent as empty or null", () => {
    const made = githubSkill({ source: "you/skills", ref: "  ", name: "" });
    expect(made).toEqual({ entry: { source: "you/skills" } });
    expect("ref" in (made as { entry: object }).entry).toBe(false);
  });

  test("an inline entry needs a name and a body", () => {
    expect(inlineSkill({ name: "house-style", content: "# House style" })).toEqual({
      entry: { name: "house-style", content: "# House style" },
    });
    expect(inlineSkill({ name: "", content: "x" })).toHaveProperty("error");
    expect(inlineSkill({ name: "house-style", content: "   " })).toHaveProperty("error");
  });

  test("owner/repo, not a bare word — a source with no slash is not installable", () => {
    expect(githubSkill({ source: "pdf" })).toHaveProperty("error");
  });
});

/**
 * The allow-list is not a validation nicety. `source`, `ref` and `name` are
 * interpolated into a `bash -lc` on the box behind `safe_token!`, which raises
 * rather than quotes — so anything outside it saves cleanly and then breaks a
 * provision on a machine somebody is using.
 */
describe("the [A-Za-z0-9._/-] allow-list", () => {
  test("refuses a source that would be interpolated into a shell command", () => {
    expect(githubSkill({ source: "you/skills;rm -rf /" })).toHaveProperty("error");
    expect(githubSkill({ source: "you/$(whoami)" })).toHaveProperty("error");
  });

  test("refuses a ref and a skill name outside it", () => {
    expect(githubSkill({ source: "you/skills", ref: "v1;id" })).toHaveProperty("error");
    // skills.sh really does list this one, and `&` is not in the allow-list.
    expect(githubSkill({ source: "claude-office-skills/skills", name: "pdf-merge-&-split" })).toHaveProperty("error");
  });

  test("a name is one segment, because it becomes a directory or a --skill flag", () => {
    // Fountain's own allow-list permits `.` and `/`, and an inline name is
    // joined straight into `<skills_root>/<name>/SKILL.md` without ever
    // reaching `safe_token!`. Paddock refuses the traversal on this side.
    expect(inlineSkill({ name: "../escape", content: "x" })).toHaveProperty("error");
    expect(inlineSkill({ name: "nested/name", content: "x" })).toHaveProperty("error");
    expect(inlineSkill({ name: ".hidden", content: "x" })).toHaveProperty("error");
    expect(githubSkill({ source: "you/skills", name: "../escape" })).toHaveProperty("error");
  });
});

describe("parseSource", () => {
  test("reads what people actually paste", () => {
    expect(parseSource("anthropics/skills")).toEqual({ source: "anthropics/skills" });
    expect(parseSource("https://github.com/anthropics/skills")).toEqual({ source: "anthropics/skills" });
    expect(parseSource("github.com/anthropics/skills.git")).toEqual({ source: "anthropics/skills" });
    expect(parseSource("https://github.com/anthropics/skills/tree/main/pdf")).toEqual({ source: "anthropics/skills" });
  });

  test("keeps a ref rather than dropping it", () => {
    expect(parseSource("anthropics/skills@v1.2.0")).toEqual({ source: "anthropics/skills", ref: "v1.2.0" });
  });

  test("a leading @ is a scope, not a ref", () => {
    expect(parseSource("@acme/skills")).toEqual({ source: "@acme/skills" });
  });
});

describe("readSkills", () => {
  test("passes both object shapes through untouched", () => {
    const skills = [{ source: "you/skills", name: "pdf" }, { name: "inline", content: "# x" }];
    expect(readSkills(skills)).toEqual(skills);
  });

  test("reads the bare string the old editor wrote as the github entry it meant", () => {
    // An agent holding one of these cannot be saved at all until it is
    // repaired, so the panel has to be able to show and remove it.
    expect(readSkills(["anthropics/skills"])).toEqual([{ source: "anthropics/skills" }]);
    expect(readSkills(["anthropics/skills@v1"])).toEqual([{ source: "anthropics/skills", ref: "v1" }]);
  });

  test("keeps a shape it does not understand rather than deleting it on save", () => {
    const unknown = { source: "you/skills", somethingNewer: true };
    expect(readSkills([unknown])).toEqual([unknown]);
  });

  test("survives whatever is not a list", () => {
    expect(readSkills(null)).toEqual([]);
    expect(readSkills("pdf")).toEqual([]);
    expect(readSkills([42, null, ""])).toEqual([]);
  });
});

describe("identity and labels", () => {
  test("the key is content-addressed, so pinning a ref reads as a new row", () => {
    expect(skillKey({ source: "you/skills" })).toBe("skill:you/skills@default");
    expect(skillKey({ source: "you/skills", ref: "v1" })).toBe("skill:you/skills@v1");
    expect(skillKey({ source: "you/skills", name: "pdf" })).toBe("skill:you/skills@default#pdf");
    expect(skillKey({ name: "house-style", content: "x" })).toBe("skill:inline:house-style");
  });

  test("the label says which repository and which skill", () => {
    expect(skillLabel({ source: "you/skills", ref: "v1", name: "pdf" })).toBe("you/skills@v1 · pdf");
    expect(skillLabel({ name: "house-style", content: "x" })).toBe("house-style");
  });

  test("isGithubSkill splits the two", () => {
    expect(isGithubSkill({ source: "you/skills" })).toBe(true);
    expect(isGithubSkill({ name: "x", content: "y" })).toBe(false);
  });
});

describe("a search hit", () => {
  test("becomes the entry that installs exactly that skill", () => {
    // `name` on a github entry is `--skill`: it selects one skill out of a
    // repository holding dozens. It does not rename anything, whatever the
    // Fountain docs say.
    expect(hitToSkill({ source: "anthropics/skills", skill: "pdf", label: "pdf", installs: 190_279 })).toEqual({
      source: "anthropics/skills",
      name: "pdf",
    });
  });
});
