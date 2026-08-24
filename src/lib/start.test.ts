import { describe, expect, test } from "bun:test";
import { buildPrompt, startBody } from "./start";
import type { ItemDto } from "./api";

const item: ItemDto = {
  id: "w1",
  projectId: "p1",
  title: "fix foo",
  notes: "Foo 500s when…",
  status: "open",
  agentIds: [],
  createdAt: "2026-08-24T00:00:00Z",
};

const agent = { id: "a1", name: "Coder" };

describe("buildPrompt", () => {
  test("the notes come first, under the item's title", () => {
    expect(buildPrompt(item, "have a look", true)).toBe("Work item: fix foo\n\nFoo 500s when…\n\n---\n\nhave a look");
  });
  test("without the notes it is just the prompt", () => {
    expect(buildPrompt(item, "  have a look  ", false)).toBe("have a look");
  });
  test("no prompt: the notes alone are context enough", () => {
    expect(buildPrompt(item, "", true)).toBe("Work item: fix foo\n\nFoo 500s when…");
  });
  test("nothing at all is nothing — the computer just comes up", () => {
    expect(buildPrompt(item, "", false)).toBe("");
    expect(buildPrompt({ ...item, notes: "  " }, " ", true)).toBe("");
  });
});

describe("startBody", () => {
  test("the item's channel, the agent, a title — and the prompt when there is one", () => {
    const body = startBody("p1", { item, agent, prompt: "go", includeNotes: false });
    expect(body).toEqual({ agent_id: "a1", channel_id: "workbench:p1/w1", fresh: true, title: "Coder: fix foo", prompt: "go" });
  });
  test("an empty prompt is left out, not sent empty", () => {
    expect(startBody("p1", { item: { ...item, notes: "" }, agent, prompt: "", includeNotes: true })).not.toHaveProperty("prompt");
  });
  test("images ride on the first prompt", () => {
    const images = [{ data: "aGk=", media_type: "image/png" as const }];
    expect(startBody("p1", { item, agent, prompt: "look at this", includeNotes: false, images }).images).toEqual(images);
    // The item's notes are a prompt too, so a screenshot goes with them.
    expect(startBody("p1", { item, agent, prompt: "", includeNotes: true, images }).images).toEqual(images);
  });
  test("with nothing said there is no turn to attach them to, so they are left out", () => {
    const body = startBody("p1", { item: { ...item, notes: "" }, agent, prompt: "", includeNotes: true, images: [{ data: "aGk=", media_type: "image/png" }] });
    expect(body).not.toHaveProperty("images");
    expect(body).not.toHaveProperty("prompt");
  });
  test("joining a computer names it; the server checks it is the same teammate's, on this item", () => {
    const body = startBody("p1", { item, agent, prompt: "go", includeNotes: false, join: { sandboxId: "sb1", label: "sprite-sb1", agentId: "a1" } });
    expect(body.sandbox_id).toBe("sb1");
  });
});
