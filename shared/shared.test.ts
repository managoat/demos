import { describe, expect, test } from "bun:test";
import { initials, shortName, splitAuthor, withAuthor } from "./author";
import { changesLine, checks, parseDiff, parseSnapshot, parseStatus, summarise } from "./changes";
import { lineText, parseComment, pending, reviewPrompt, type CommentDto } from "./comments";
import { newTicTacToe, play, toMove, winnerEmail, type TicTacToe } from "./games";
import { groupByProvider, modelLabel, modelProblem, runtimeFor } from "./models";
import { canonical, DEFAULT_SETTINGS, derivedKey, fnv1a64, parseSettings } from "./settings";
import { SKILLS, skillEntry, skillNames } from "./skills";

describe("author tags", () => {
  test("round-trips", () => {
    const tagged = withAuthor("alice@example.com", "hello there");
    expect(tagged).toBe("[from alice@example.com] hello there");
    expect(splitAuthor(tagged)).toEqual({ email: "alice@example.com", text: "hello there" });
  });
  test("leaves an untagged prompt alone", () => {
    expect(splitAuthor("[not a tag] hi")).toEqual({ email: null, text: "[not a tag] hi" });
    expect(splitAuthor("plain")).toEqual({ email: null, text: "plain" });
  });
  test("names", () => {
    expect(shortName("jake.gaylor@example.com")).toBe("Jake Gaylor");
    expect(initials("jake.gaylor@example.com")).toBe("JG");
    expect(initials("bob@example.com")).toBe("B");
  });
});

describe("models", () => {
  test("the provider must be one Fountain holds credentials for", () => {
    expect(modelProblem("anthropic/claude-opus-5")).toBeNull();
    expect(modelProblem("google/gemini-3.7-flash")).toBeNull();
    expect(modelProblem("mistral/large")).toMatch(/credentials/);
    expect(modelProblem("nonsense")).toMatch(/provider\/model/);
  });
  test("the runtime follows from the provider", () => {
    expect(runtimeFor("anthropic/claude-opus-5")).toBe("claude");
    expect(runtimeFor("openai/gpt-5.5")).toBe("codex");
    expect(runtimeFor("google/gemini-3.7-flash")).toBe("gemini");
    expect(() => runtimeFor("mistral/large")).toThrow();
  });
  test("labels", () => {
    expect(modelLabel("anthropic/claude-opus-5")).toBe("Opus 5");
    expect(modelLabel("openai/gpt-5.3-codex")).toBe("GPT-5.3 Codex");
    expect(modelLabel("openai/gpt-6-mini")).toBe("GPT-6 Mini");
    expect(modelLabel("google/gemini-4-ultra")).toBe("Gemini 4 Ultra");
  });
  test("groups by brand in brand order, without duplicates", () => {
    const groups = groupByProvider(["google/gemini-3.7-flash", "anthropic/claude-opus-5", "openai/gpt-5.5", "anthropic/claude-opus-5", "other/x"]);
    expect(groups.map((g) => g.provider)).toEqual(["anthropic", "openai", "google"]);
    expect(groups[0]!.models).toEqual(["anthropic/claude-opus-5"]);
  });
});

describe("skills", () => {
  test("every skill is a github source with a skill name", () => {
    for (const s of SKILLS) {
      expect(s.source).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(skillEntry(s)).toMatchObject({ source: s.source, name: s.skill });
    }
    expect(new Set(SKILLS.map((s) => s.id)).size).toBe(SKILLS.length);
  });
  test("names in menu order", () => {
    expect(skillNames(["pptx", "pdf"])).toEqual(["PDFs", "Slides"]);
    expect(skillNames(["nope"])).toEqual([]);
  });
});

describe("settings", () => {
  test("parses, trims and sorts", () => {
    const s = parseSettings({ model: " anthropic/claude-sonnet-5 ", skills: ["pptx", "pdf", "pdf"], connectorIds: ["b", " a "], environmentId: "" });
    if (typeof s === "string") throw new Error(s);
    expect(s.model).toBe("anthropic/claude-sonnet-5");
    expect(s.skills).toEqual(["pdf", "pptx"]);
    expect(s.connectorIds).toEqual(["a", "b"]);
    expect(s.environmentId).toBeNull();
    expect(s.presetId).toBeNull();
  });
  test("refuses a bad model, an unknown skill or a non-list", () => {
    expect(typeof parseSettings({ model: "gpt" })).toBe("string");
    expect(typeof parseSettings({ model: "mistral/large" })).toBe("string");
    expect(parseSettings({ model: "anthropic/claude-opus-5", skills: ["cooking"] })).toMatch(/cooking/);
    expect(typeof parseSettings({ model: "anthropic/claude-opus-5", connectorIds: "c1" })).toBe("string");
    expect(typeof parseSettings(null)).toBe("string");
    // The runtime is not a setting any more; an old browser sending one is fine.
    expect(typeof parseSettings({ runtime: "claude", model: "anthropic/claude-opus-5" })).not.toBe("string");
  });
});

describe("derivedKey", () => {
  const base = { ...DEFAULT_SETTINGS, skills: ["pdf", "xlsx"], connectorIds: ["c1", "c2"] };
  test("is stable and order-insensitive", () => {
    expect(derivedKey(base)).toBe(derivedKey({ ...base, skills: ["xlsx", "pdf"], connectorIds: ["c2", "c1", "c1"] }));
    expect(derivedKey(base)).toMatch(/^salon:v2:[0-9a-f]{16}$/);
    // Pinned: a change here orphans every derived agent in the wild.
    expect(derivedKey(DEFAULT_SETTINGS)).toBe(`salon:v2:${fnv1a64(canonical(DEFAULT_SETTINGS))}`);
    expect(canonical(DEFAULT_SETTINGS)).toBe('{"runtime":"claude","model":"anthropic/claude-opus-5","skills":[],"connectors":[],"preset":null,"environment":null,"vault":null}');
    expect(derivedKey(DEFAULT_SETTINGS)).toBe("salon:v2:" + fnv1a64('{"runtime":"claude","model":"anthropic/claude-opus-5","skills":[],"connectors":[],"preset":null,"environment":null,"vault":null}'));
  });
  test("changes with any part of the tuple", () => {
    const keys = [base, { ...base, model: "anthropic/claude-sonnet-5" }, { ...base, skills: ["pdf"] }, { ...base, connectorIds: ["c1"] }, { ...base, presetId: "p" }, { ...base, environmentId: "e" }, { ...base, vaultId: "v" }].map(derivedKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
  test("fnv1a64 matches the reference vectors", () => {
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
  });
});

describe("tic-tac-toe", () => {
  const game = { players: ["x@example.com", "o@example.com"], state: newTicTacToe() };
  test("X moves first, marks alternate, and the rules refuse the rest", () => {
    expect(toMove(game)).toBe("x@example.com");
    expect(play(game, "o@example.com", 0)).toBe("It is not your move.");
    expect(play(game, "who@example.com", 0)).toBe("You are not playing this game.");
    expect(play(game, "x@example.com", 9)).toBe("Pick a square on the board.");
    expect(play(game, "x@example.com", 1.5)).toBe("Pick a square on the board.");
    const after = play(game, "x@example.com", 4);
    expect(after).toMatchObject({ next: "O", winner: null });
    expect(play({ ...game, state: after as TicTacToe }, "o@example.com", 4)).toBe("That square is taken.");
  });
  test("a line wins, a full board draws, and a finished game takes no move", () => {
    let s = newTicTacToe();
    const step = (email: string, cell: number) => {
      const r = play({ players: game.players, state: s }, email, cell);
      if (typeof r === "string") throw new Error(r);
      s = r;
    };
    step("x@example.com", 0);
    step("o@example.com", 3);
    step("x@example.com", 1);
    step("o@example.com", 4);
    step("x@example.com", 2);
    expect(s).toMatchObject({ winner: "X", line: [0, 1, 2] });
    expect(winnerEmail({ players: game.players, state: s })).toBe("x@example.com");
    expect(toMove({ players: game.players, state: s })).toBeNull();
    expect(play({ players: game.players, state: s }, "o@example.com", 5)).toBe("That game is over.");

    s = newTicTacToe();
    for (const [who, cell] of [
      ["x", 0], ["o", 1], ["x", 2], ["o", 4], ["x", 3], ["o", 5], ["x", 7], ["o", 6], ["x", 8],
    ] as const) step(`${who}@example.com`, cell);
    expect(s.winner).toBe("draw");
    expect(winnerEmail({ players: game.players, state: s })).toBeNull();
  });
});

describe("changes", () => {
  const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,4 +10,5 @@ function a() {",
    "   keep",
    "-  gone",
    "+  here",
    "+  and here",
    "   keep too",
    "diff --git a/old.txt b/new.txt",
    "similarity index 90%",
    "rename from old.txt",
    "rename to new.txt",
    "--- a/old.txt",
    "+++ b/new.txt",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-a",
    "-b",
    "diff --git a/pic.png b/pic.png",
    "new file mode 100644",
    "Binary files /dev/null and b/pic.png differ",
    "",
  ].join("\n");

  test("a unified diff parses into files, hunks and numbered lines", () => {
    const files = parseDiff(DIFF);
    expect(files.map((f) => [f.path, f.oldPath, f.status, f.binary, f.additions, f.deletions])).toEqual([
      ["src/a.ts", null, "modified", false, 2, 1],
      ["new.txt", "old.txt", "renamed", false, 1, 1],
      ["gone.txt", null, "deleted", false, 0, 2],
      ["pic.png", null, "added", true, 0, 0],
    ]);
    const h = files[0]!.hunks[0]!;
    expect(h).toMatchObject({ oldStart: 10, oldLines: 4, newStart: 10, newLines: 5, heading: "function a() {" });
    expect(h.lines.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      ["context", 10, 10],
      ["del", 11, null],
      ["add", null, 11],
      ["add", null, 12],
      ["context", 12, 13],
    ]);
    expect(summarise(DIFF)).toHaveLength(4);
    expect(changesLine(summarise(DIFF))).toBe("+3 −4 in 4 files");
    expect(changesLine([])).toBe("No changes");
    // A diff cut mid-hunk keeps what it had.
    expect(parseDiff(DIFF.slice(0, 150))[0]!.hunks[0]!.lines.length).toBeGreaterThan(0);
    expect(parseDiff("")).toEqual([]);
  });

  test("git status --porcelain parses, renames included", () => {
    expect(parseStatus(" M a.ts\n?? new/\nR  old.txt -> new.txt\nA  b.ts\n")).toEqual([
      { code: " M", path: "a.ts", oldPath: null },
      { code: "??", path: "new/", oldPath: null },
      { code: "R ", path: "new.txt", oldPath: "old.txt" },
      { code: "A ", path: "b.ts", oldPath: null },
    ]);
  });

  test("a snapshot is checked before it is kept", () => {
    expect(typeof parseSnapshot(null)).toBe("string");
    expect(typeof parseSnapshot({ diff: "x" })).toBe("string");
    expect(parseSnapshot({ branch: "b", head: "h", base: "main", status: "", diff: "", reason: "nope", pr: { url: "http://insecure" } })).toMatchObject({ reason: "manual", pr: null });
    expect(parseSnapshot({ head: "h", base: "main", reason: "session", pr: { url: "https://github.com/x/y/pull/2", state: "OPEN" } })).toMatchObject({ branch: "", status: "", diff: "", reason: "session", pr: { url: "https://github.com/x/y/pull/2", state: "OPEN", mergeable: null } });
  });
});

describe("review comments", () => {
  const DIFF = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -5,2 +5,3 @@", " keep", "-gone", "+here", "+and", ""].join("\n");
  const at = (over: Partial<CommentDto>): CommentDto => ({ id: "c", chatId: "x", changesSeq: 1, path: "a.ts", side: "new", line: 6, quote: "", body: "b", author: "a@x", createdAt: "2026-01-01T00:00:00Z", resolvedAt: null, resolvedBy: null, sentAt: null, sentBy: null, ...over });

  test("a line is found by side and number", () => {
    expect(lineText(DIFF, "a.ts", "new", 6)).toBe("here");
    expect(lineText(DIFF, "a.ts", "old", 6)).toBe("gone");
    expect(lineText(DIFF, "a.ts", "new", 99)).toBe("");
    expect(lineText(DIFF, "nope", "new", 6)).toBe("");
  });

  test("the prompt groups by file and names each author; resolved and sent ones are left out", () => {
    const list = [at({ id: "1", path: "b.ts", line: 2, body: "second file", quote: "x" }), at({ id: "2", line: 7, body: "later line", author: "z@x" }), at({ id: "3", line: 6, body: "first\nsecond line", quote: "here" }), at({ id: "4", resolvedAt: "t" }), at({ id: "5", sentAt: "t" })];
    expect(pending(list).map((c) => c.id)).toEqual(["1", "2", "3"]);
    const text = reviewPrompt(pending(list), { branch: "salon/ab", head: "0123456789" });
    expect(text.split("\n")).toEqual([
      "Review comments on salon/ab at 0123456. Please address each one, then say in a sentence or two what you changed.",
      "",
      "a.ts:",
      "- line 6 — `here`",
      "  a@x: first",
      "  second line",
      "- line 7",
      "  z@x: later line",
      "",
      "b.ts:",
      "- line 2 — `x`",
      "  a@x: second file",
    ]);
    expect(reviewPrompt([at({})], null)).toStartWith("Review comments. Please");
    expect(typeof parseComment({ path: "a", line: 0, body: "x" })).toBe("string");
    expect(parseComment({ path: " a ", line: 3, body: " ok ", side: "old" })).toEqual({ path: "a", line: 3, body: "ok", side: "old" });
  });
});

describe("checks", () => {
  test("say what stands between the branch and a merge", () => {
    const base = { status: "", ahead: 0, pr: null, files: [] };
    expect(checks(base).map((c) => [c.key, c.ok, c.label])).toEqual([
      ["tree", true, "Working tree clean"],
      ["branch", true, "Branch pushed"],
      ["pr", false, "No pull request yet"],
    ]);
    expect(checks({ ...base, status: " M a\n?? b\n", ahead: null }).map((c) => c.label)).toEqual(["2 files not committed", "Branch not pushed yet", "No pull request yet"]);
    expect(checks({ ...base, ahead: 3, pr: { url: "u", state: "OPEN", mergeable: "CONFLICTING" } }).map((c) => [c.ok, c.label])).toEqual([
      [true, "Working tree clean"],
      [false, "3 commits not pushed"],
      [false, "Pull request has conflicts"],
    ]);
    expect(checks({ ...base, pr: { url: "u", state: "MERGED" } })[2]).toEqual({ key: "pr", ok: true, label: "Pull request merged" });
  });
});
