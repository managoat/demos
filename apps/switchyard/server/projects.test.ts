import { expect, test } from "bun:test";
import { machineFrom, pickRuntime } from "./projects";

/**
 * The model id is the one field on `POST /api/agents` that Fountain validates
 * with a regex — `^[a-z0-9_-]+/[a-z0-9._-]+$` — and it is set once, at project
 * creation, by code nobody reads again. A wrong default here does not fail a
 * typecheck, a test that never asserts on it, or a catalog call that happens
 * to succeed. It fails on somebody's first project, as a 422.
 */

test("the default is provider-prefixed, the way Fountain writes them", () => {
  const { model } = pickRuntime(null);
  expect(model).toMatch(/^[a-z0-9_-]+\/[a-z0-9._-]+$/);
});

test("the catalog wins over the default when it offers the same model", () => {
  const catalog = { runtimes: ["claude", "codex"], models: { claude: ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"] } };
  expect(pickRuntime(catalog)).toEqual({ runtime: "claude", model: "anthropic/claude-opus-5" });
});

test("a Fountain without our preferred model still yields a usable one", () => {
  // The point of the fallback: a deployment should get a machine rather than
  // an error about a model nobody asked for.
  const noOpus = { runtimes: ["claude"], models: { claude: ["anthropic/claude-sonnet-5"] } };
  expect(pickRuntime(noOpus).model).toBe("anthropic/claude-sonnet-5");

  const otherOpus = { runtimes: ["claude"], models: { claude: ["vendor/opus-9"] } };
  expect(pickRuntime(otherOpus).model).toBe("vendor/opus-9");
});

test("a Fountain without our preferred runtime falls to its first", () => {
  const noClaude = { runtimes: ["codex"], models: { codex: ["openai/gpt-5"] } };
  expect(pickRuntime(noClaude)).toEqual({ runtime: "codex", model: "openai/gpt-5" });
});

test("an empty catalog is not a crash", () => {
  expect(pickRuntime({ runtimes: [], models: {} }).runtime).toBe("claude");
});

/**
 * The machine's heat, which is the sidebar's whole claim about a project.
 *
 * A project is several conversations on one box, so every one of these is
 * about the set disagreeing with its newest member — which is the ordinary
 * case the moment somebody has two tracks open.
 */
const conv = (status: string, insertedAt: string, sandboxId: string | null = "sb_1") => ({
  status,
  sandbox_id: sandboxId,
  inserted_at: insertedAt,
});

test("a project with no machine is cold, and says it has none", () => {
  expect(machineFrom([])).toEqual({ sandboxId: null, status: "none", heat: "cold", spriteName: null });
  // A conversation Fountain never gave a box is not a machine either.
  expect(machineFrom([conv("idle", "2026-09-01T10:00:00Z", null)]).status).toBe("none");
});

test("a turn running on any track makes the machine active, not just the newest", () => {
  // The case that matters: you opened a track a minute ago and it is sitting
  // idle, while the one from this morning is mid-turn. Your next prompt queues.
  const state = machineFrom([conv("idle", "2026-09-04T11:00:00Z"), conv("running", "2026-09-04T09:00:00Z")]);
  expect(state.heat).toBe("active");
  expect(state.status).toBe("ready");
});

test("live and idle is warm", () => {
  expect(machineFrom([conv("idle", "2026-09-04T11:00:00Z"), conv("pending", "2026-09-04T09:00:00Z")]).heat).toBe("warm");
});

test("a box everything has finished with is cold but still a box", () => {
  const state = machineFrom([conv("terminated", "2026-09-04T11:00:00Z"), conv("terminated", "2026-09-03T09:00:00Z")]);
  expect(state.heat).toBe("cold");
  // Not `none`: the disk is there and the next turn wakes it. The two are
  // different sentences under the same dot.
  expect(state.status).toBe("suspended");
  expect(state.sandboxId).toBe("sb_1");
});

test("the sandbox it names is one a new track could actually attach to", () => {
  // The newest conversation is dead and the live one is older. Reporting the
  // newest would hand the UI an id `machineOf` would never attach to.
  const state = machineFrom([
    conv("terminated", "2026-09-04T11:00:00Z", "sb_gone"),
    conv("idle", "2026-09-04T09:00:00Z", "sb_live"),
  ]);
  expect(state.sandboxId).toBe("sb_live");
  expect(state.heat).toBe("warm");
});
