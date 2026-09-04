/**
 * A skill, as Fountain actually defines one.
 *
 * This file exists because paddock spent its whole life sending the wrong
 * shape. `agent.skills` is `{:array, :map}` — every entry is an *object*, one
 * of exactly two kinds:
 *
 *   inline   {name, content}          Fountain writes `<skills_root>/<name>/SKILL.md`
 *   github   {source, ref?, name?}    the skills.sh CLI installs it on the box
 *
 * The Skills editor used to append a bare string, which Fountain refuses at
 * cast time (`entry 0: must be an object`). It went unnoticed for as long as it
 * did because `mock/server.ts` validated nothing and simply stored whatever it
 * was handed — so the whole loop worked offline and only ever failed against a
 * real Fountain. The mock validates skills now, for that reason.
 *
 * The *read* side was always fine: `skillNames` in `lib/machine.ts` has handled
 * both objects and strings from the beginning.
 *
 * ## What `name` means on a github entry
 *
 * It selects, it does not rename. `Managoat.Runtimes.Skills.github_install_cmd`
 * builds:
 *
 *     npx -y skills@latest add <source>[@<ref>] --global --agent <id> --yes [--skill <name>]
 *
 * so `{source: "anthropics/skills", name: "pdf"}` installs the one `pdf` skill
 * out of a repository that holds dozens. Fountain's own docs call it "rename on
 * install"; the code says `--skill`, and the code is what runs.
 *
 * ## Why everything here is checked against one regexp
 *
 * `source`, `ref` and `name` are interpolated into a `bash -lc` command on the
 * box. Fountain guards that with `safe_token!`, an allow-list of
 * `[A-Za-z0-9._/-]` that *raises* on anything else rather than quoting it. So a
 * value outside the allow-list is not a validation nicety: it is a skill that
 * saves cleanly and then blows up the install on a machine somebody is using.
 * Paddock refuses it here, where there is a person to tell.
 *
 * This matters most for search results, which are third-party strings: skills.sh
 * happily lists a skill whose id is `pdf-merge-&-split`, and `&` is not in the
 * allow-list.
 */

/**
 * Fountain's `safe_token!` allow-list, mirrored. Also exactly the `ref` pattern
 * `Agent.valid_ref?/1` enforces at write time — one expression, three fields,
 * because they all end up in the same shell command.
 */
export const SAFE_TOKEN = /^[A-Za-z0-9._/-]+$/;

/**
 * A single path or CLI segment: the allow-list, minus the slash.
 *
 * `SAFE_TOKEN` permits `/` and `.` because a `source` is `owner/repo` and a
 * `ref` can be `refs/heads/main`. A *name* is neither. An inline skill's name
 * is joined straight into `<skills_root>/<name>/SKILL.md` with no further
 * check on Fountain's side — `safe_token!` never sees it, because only github
 * entries are shelled out — so `../escape` would write outside the skills root.
 * Paddock will not send one.
 */
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** A skill Fountain writes to the box itself, body and all. */
export interface InlineSkill {
  name: string;
  content: string;
}

/** A skill the skills.sh CLI installs from GitHub. */
export interface GithubSkill {
  source: string;
  /** A tag, branch or sha. Omitted, never null — see `githubSkill`. */
  ref?: string;
  /** Which skill of the repository to install (`--skill`), not a new name for it. */
  name?: string;
}

export type SkillEntry = InlineSkill | GithubSkill;

export function isGithubSkill(entry: SkillEntry): entry is GithubSkill {
  return typeof (entry as GithubSkill).source === "string";
}

export function safeToken(value: string): boolean {
  return SAFE_TOKEN.test(value);
}

/**
 * A github entry, or a sentence saying why not.
 *
 * `ref` is *omitted* rather than set to null when it is blank. Fountain accepts
 * a null ref, but `github_install_cmd` reads `entry["ref"]` and an explicit null
 * is one more shape for every reader of this data to think about, for no gain.
 */
export function githubSkill(input: { source: string; ref?: string; name?: string }): { entry: GithubSkill } | { error: string } {
  const source = input.source.trim();
  const ref = input.ref?.trim() ?? "";
  const name = input.name?.trim() ?? "";

  if (!source) return { error: "A GitHub skill needs an owner/repo." };
  if (!safeToken(source)) return { error: `${source} is not an owner/repo — letters, digits, and . _ - / only.` };
  if (!source.includes("/")) return { error: `${source} needs to be owner/repo.` };
  if (ref && !safeToken(ref)) return { error: `${ref} is not a tag, branch or sha — letters, digits, and . _ - / only.` };
  // One segment: it becomes `--skill <name>` and never a path.
  if (name && !SAFE_NAME.test(name)) return { error: `${name} is not a skill name — letters, digits, and . _ - only.` };

  return { entry: { source, ...(ref ? { ref } : {}), ...(name ? { name } : {}) } };
}

/** An inline entry, or a sentence saying why not. */
export function inlineSkill(input: { name: string; content: string }): { entry: InlineSkill } | { error: string } {
  const name = input.name.trim();
  const content = input.content;

  if (!name) return { error: "An inline skill needs a name." };
  // The name is joined into `<skills_root>/<name>/SKILL.md`, so it is one
  // segment and it does not start with a dot. See `SAFE_NAME`.
  if (!SAFE_NAME.test(name)) return { error: `${name} is not a skill name — letters, digits, and . _ - only, and not a path.` };
  if (!content.trim()) return { error: "An inline skill needs a SKILL.md body." };

  return { entry: { name, content } };
}

/**
 * `owner/repo`, out of whatever somebody pasted.
 *
 * People paste GitHub URLs, `owner/repo@ref`, and trailing slashes, and every
 * one of those is obviously the same intent. A skills.sh `source` is `owner/repo`
 * and nothing else, so this narrows to that and hands back the `ref` it found
 * rather than dropping it.
 */
export function parseSource(input: string): { source: string; ref?: string } {
  let text = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");

  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(text);
  if (url) text = url[1]!;

  let ref: string | undefined;
  const at = text.lastIndexOf("@");
  // A leading `@` is a scope, not a ref: `@acme/skills` has no version in it.
  if (at > 0) {
    ref = text.slice(at + 1);
    text = text.slice(0, at);
  }

  // `owner/repo/anything-else` — GitHub's tree URLs and skills.sh's own ids both
  // do this. The source is the first two segments.
  const parts = text.split("/").filter(Boolean);
  const source = parts.length >= 2 ? parts.slice(0, 2).join("/") : text;

  return { source, ...(ref ? { ref } : {}) };
}

/**
 * Whatever Fountain served, as entries this app can render and write back.
 *
 * Deliberately tolerant, and deliberately lossless about what it does not
 * understand: an agent whose `skills` hold something from a Fountain newer than
 * this app must survive a round trip through the panel unchanged. An entry that
 * is neither shape is kept as-is and rendered by its best available name — the
 * alternative is a Save that silently deletes it.
 */
export function readSkills(skills: unknown): SkillEntry[] {
  if (!Array.isArray(skills)) return [];
  const out: SkillEntry[] = [];
  for (const raw of skills) {
    // A bare string is what the old editor wrote. Any agent still holding one
    // cannot be saved at all until it is repaired, so read it as the github
    // entry it was always trying to be.
    if (typeof raw === "string" && raw.trim()) {
      const { source, ref } = parseSource(raw);
      out.push(source.includes("/") ? { source, ...(ref ? { ref } : {}) } : { source: raw.trim() });
      continue;
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) out.push(raw as SkillEntry);
  }
  return out;
}

/** What the chip says. */
export function skillLabel(entry: SkillEntry): string {
  if (isGithubSkill(entry)) {
    const at = entry.ref ? `@${entry.ref}` : "";
    return entry.name ? `${entry.source}${at} · ${entry.name}` : `${entry.source}${at}`;
  }
  return entry.name;
}

/**
 * The id the Skills editor keys a skill row on.
 *
 * Content-addressed like every other id in `lib/machine.ts`: pinning a ref or
 * picking a different skill out of the same repository reads as a new row
 * rather than a silently-changed one.
 */
export function skillKey(entry: SkillEntry): string {
  if (isGithubSkill(entry)) return `skill:${entry.source}@${entry.ref ?? "default"}${entry.name ? `#${entry.name}` : ""}`;
  return `skill:inline:${entry.name}`;
}

// ── the skills.sh index ────────────────────────────────────────────────────

/** One search hit, as `GET /api/skills/search` serves it. */
export interface SkillHit {
  /** `owner/repo` — exactly what a github entry's `source` wants. */
  source: string;
  /** The skill to select out of that repository (`--skill`). */
  skill: string;
  /** What to show a person. Not safe to send anywhere: it can hold spaces and `&`. */
  label: string;
  installs: number;
}

/** A hit as the entry it becomes. */
export function hitToSkill(hit: SkillHit): GithubSkill {
  return { source: hit.source, name: hit.skill };
}
