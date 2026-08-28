import { describe, expect, test } from "bun:test";
import { cronError, describeCron, relativeTime } from "./cron";
import { CRON_PRESETS, DEFAULT_CRON } from "./spec";

describe("cronError", () => {
  test("accepts the shapes we offer and the ones people type", () => {
    for (const expr of ["0 9 * * 1", "0 9 * * *", "0 9 1 * *", "0 */6 * * *", "*/15 * * * *", "30 2 * * 1-5", "0 0 1 1 *"]) {
      expect(cronError(expr)).toBeNull();
    }
  });

  test("every preset we ship is valid", () => {
    for (const p of CRON_PRESETS) expect(cronError(p.cron)).toBeNull();
    expect(cronError(DEFAULT_CRON)).toBeNull();
  });

  test("rejects the wrong number of fields", () => {
    expect(cronError("0 9 * *")).toContain("five fields");
    expect(cronError("0 9 * * 1 2")).toContain("five fields");
    expect(cronError("")).toContain("five fields");
  });

  test("rejects out-of-range values, naming the field", () => {
    expect(cronError("60 9 * * 1")).toContain("minute must be 0–59");
    expect(cronError("0 24 * * 1")).toContain("hour must be 0–23");
    expect(cronError("0 9 32 * *")).toContain("day of month must be 1–31");
    expect(cronError("0 9 * 13 *")).toContain("month must be 1–12");
  });

  test("rejects junk, backwards ranges and a zero step", () => {
    expect(cronError("x 9 * * 1")).toContain("not a number");
    expect(cronError("0 17-9 * * *")).toContain("backwards");
    expect(cronError("*/0 * * * *")).toContain("not a usable step");
  });
});

describe("describeCron", () => {
  test("reads the presets back in English", () => {
    expect(describeCron("0 9 * * 1")).toBe("Every Monday at 09:00 UTC");
    expect(describeCron("0 9 * * *")).toBe("Every day at 09:00 UTC");
    expect(describeCron("0 9 1 * *")).toBe("Monthly, on the 1st at 09:00 UTC");
    expect(describeCron("0 */6 * * *")).toBe("Every 6 hours, at 00 past");
  });

  test("handles day ranges and lists", () => {
    expect(describeCron("30 2 * * 1-5")).toBe("Every weekday at 02:30 UTC");
    expect(describeCron("0 9 * * 1,4")).toBe("Every Monday and Thursday at 09:00 UTC");
    expect(describeCron("0 9 * * 0-6")).toBe("Every day at 09:00 UTC");
  });

  test("ordinals read correctly", () => {
    expect(describeCron("0 9 2 * *")).toContain("2nd");
    expect(describeCron("0 9 3 * *")).toContain("3rd");
    expect(describeCron("0 9 11 * *")).toContain("11th");
    expect(describeCron("0 9 21 * *")).toContain("21st");
  });

  test("falls back to the raw expression rather than lying", () => {
    expect(describeCron("0 9 1-7 * 1")).toBe("0 9 1-7 * 1");
    expect(describeCron("nonsense")).toBe("nonsense");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-08-20T12:00:00Z");

  test("past and future read differently", () => {
    expect(relativeTime("2026-08-20T09:00:00Z", now)).toBe("3 hours ago");
    expect(relativeTime("2026-08-20T15:00:00Z", now)).toBe("in 3 hours");
    expect(relativeTime("2026-08-13T12:00:00Z", now)).toBe("1 week ago");
  });

  test("a schedule that has never run says so", () => {
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime("not a date", now)).toBe("unknown");
  });
});

describe("the credential never leaks into the prompt", () => {
  test("the rendered system prompt names the variables, never a value", async () => {
    const { systemPrompt, vaultName, GRANT_KEY } = await import("./spec");
    const p = systemPrompt({ host: "github.com", owner: "o", name: "r" });
    expect(p).toContain("$GITHUB_TOKEN@github.com/o/r.git");
    expect(p).toContain("never print it");
    expect(p).toContain("never echo a command with it expanded");
    // The prompt is generated from a ref alone, so there is nowhere for a real
    // credential to enter it — assert the only occurrences are shell variables.
    expect(p.split(GRANT_KEY).length - 1).toBeGreaterThan(0);
    expect(p).not.toMatch(/gh[ps]_[A-Za-z0-9]{16,}/);
    expect(p).not.toMatch(/roundsg1\.[A-Za-z0-9_-]+\./);
    expect(vaultName({ host: "github.com", owner: "o", name: "r" })).toBe("Rounds: github.com/o/r");
  });

  test("the prompt no longer tells the agent to write anywhere", async () => {
    const { systemPrompt } = await import("./spec");
    const p = systemPrompt({ host: "github.com", owner: "o", name: "r" });
    // The whole point of the rework: no push, no pull-request POST to GitHub.
    expect(p).not.toContain("git push");
    expect(p).not.toContain("api.github.com/repos/o/r/pulls");
    expect(p).toContain("/gh/propose");
    expect(p).toContain("You cannot push.");
  });
});

// Which findings a round may propose, and which it may only report.
describe("the tiers a round runs under", () => {
  const REF = { host: "github.com", owner: "o", name: "r" } as const;

  test("both merge-worthy tiers by default — the judgment calls are the valuable half", async () => {
    const { DEFAULT_POLICY, systemPrompt } = await import("./spec");
    expect(DEFAULT_POLICY.includeNeedsReview).toBe(true);
    expect(systemPrompt(REF)).toContain("needs-review findings (merge-worthy + guidance)");
  });

  test("unticking it still yields a mechanical-only round", async () => {
    const { systemPrompt } = await import("./spec");
    expect(systemPrompt(REF, { includeNeedsReview: false })).toContain("quick wins only (merge-worthy + deterministic)");
  });

  // The hygiene tier is the one nobody wants unprompted, so no checkbox
  // reaches it: the audited repository asks for it in its own file or it stays
  // in the report.
  test("hygiene is never proposed unless the repository's own file names it", async () => {
    const { systemPrompt } = await import("./spec");
    for (const includeNeedsReview of [true, false]) {
      const p = systemPrompt(REF, { includeNeedsReview });
      expect(p).toContain("Never propose a report-only finding unless");
      expect(p).toContain("`report-only`");
    }
  });

  test("a repository that says nothing about tiers leaves the enrollment's choice standing", async () => {
    const { systemPrompt } = await import("./spec");
    expect(systemPrompt(REF)).toContain("`null` means it did not");
  });
});

// Bringing an already-enrolled agent up to date means rewriting the prompt it
// carries — and the prompt is the only record of two things it must not lose.
describe("reading an enrolled agent's choices back out of its prompt", () => {
  // The shape agents enrolled before the rework are actually carrying.
  const OLD_PROMPT = (tiers: string, endpoint: string) => `You are Rounds for o/r (https://github.com/o/r).

  GITHUB_TOKEN=$(curl -sS -X POST ${endpoint}/gh/token -H 'content-type: application/json' \\
    -d "$(jq -n --arg g "$ROUNDS_GRANT" '{grant:$g}')" | jq -er .token)

Without that file your policy is: **${tiers}**, at most 3 open pull requests.

git push "https://x-access-token:$GITHUB_TOKEN@github.com/o/r.git" HEAD:refs/heads/rounds/<key>`;

  const OPTED_IN = "quick wins (merge-worthy + deterministic) **and** needs-review findings (merge-worthy + guidance)";
  const MECHANICAL = "quick wins only (merge-worthy + deterministic)";

  test("the judgment-calls opt-in survives a rewrite", async () => {
    const { policyOfPrompt } = await import("./spec");
    expect(policyOfPrompt(OLD_PROMPT(OPTED_IN, "https://rounds.demo.managoat.com")).includeNeedsReview).toBe(true);
    expect(policyOfPrompt(OLD_PROMPT(MECHANICAL, "https://rounds.demo.managoat.com")).includeNeedsReview).toBe(false);
  });

  test("it reads back out of the new prompt too, so this keeps working", async () => {
    const { policyOfPrompt, systemPrompt } = await import("./spec");
    for (const includeNeedsReview of [true, false]) {
      const p = systemPrompt({ host: "github.com", owner: "o", name: "r" }, { includeNeedsReview });
      expect(policyOfPrompt(p).includeNeedsReview).toBe(includeNeedsReview);
    }
  });

  test("an agent keeps reporting to the deployment it was enrolled against", async () => {
    const { apiBaseOfPrompt } = await import("./spec");
    // The hazard this exists to stop: refreshing prompts from a dev session
    // would otherwise repoint every production agent at localhost.
    expect(apiBaseOfPrompt(OLD_PROMPT(MECHANICAL, "https://rounds.demo.managoat.com"))).toBe("https://rounds.demo.managoat.com");
    expect(apiBaseOfPrompt(OLD_PROMPT(MECHANICAL, "http://localhost:5181"))).toBe("http://localhost:5181");
  });

  test("the base round-trips through the current prompt", async () => {
    const { apiBaseOfPrompt, systemPrompt } = await import("./spec");
    const p = systemPrompt({ host: "github.com", owner: "o", name: "r" }, undefined, "https://rounds.example.com");
    expect(apiBaseOfPrompt(p)).toBe("https://rounds.example.com");
  });

  test("an unreadable prompt yields null rather than a wrong answer", async () => {
    const { apiBaseOfPrompt, policyOfPrompt } = await import("./spec");
    expect(apiBaseOfPrompt("nothing like a prompt")).toBeNull();
    expect(apiBaseOfPrompt(null)).toBeNull();
    expect(policyOfPrompt(null).includeNeedsReview).toBe(false);
  });

  test("an old prompt genuinely differs from the new one, so the refresh fires", async () => {
    const { systemPrompt } = await import("./spec");
    const old = OLD_PROMPT(MECHANICAL, "https://rounds.demo.managoat.com");
    const want = systemPrompt({ host: "github.com", owner: "o", name: "r" }, { includeNeedsReview: false }, "https://rounds.demo.managoat.com");
    expect(old).not.toBe(want);
    expect(old).toContain("git push");
    expect(want).not.toContain("git push");
  });
});
