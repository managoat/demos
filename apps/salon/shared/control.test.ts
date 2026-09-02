import { describe, expect, test } from "bun:test";
import { canControl, notesPrompt, parseNoteInput, parsePermissionAnswer, parsePresenceHeartbeat, promptWithQueuedNotes } from "./control";

describe("room notes", () => {
  test("parses a human-only note and a next-turn queue choice", () => {
    expect(parseNoteInput({ body: "  keep this small  " })).toEqual({ body: "keep this small", delivery: "manual" });
    expect(parseNoteInput({ body: "later", queueForNextTurn: true })).toEqual({ body: "later", delivery: "next_turn" });
    expect(typeof parseNoteInput({ body: "  " })).toBe("string");
  });

  test("attributes notes in an explicit send and in a participant's next prompt", () => {
    const notes = [
      { author: "a@example.com", body: "Preserve the API." },
      { author: "b@example.com", body: "Add a test." },
    ];
    expect(notesPrompt(notes)).toContain("a@example.com: Preserve the API.");
    expect(promptWithQueuedNotes("Implement it.", notes)).toBe("Implement it.\n\nRoom notes saved for this turn:\n- a@example.com: Preserve the API.\n- b@example.com: Add a test.");
  });
});

describe("ephemeral collaboration and control", () => {
  test("checks heartbeat shape without trusting client expiry times", () => {
    expect(parsePresenceHeartbeat({ clientId: "tab-1", typing: true, viewing: { nodeId: "node-1", field: "outcome", mode: "editing" } })).toEqual({
      clientId: "tab-1",
      typing: true,
      viewing: { nodeId: "node-1", field: "outcome", mode: "editing" },
    });
    expect(typeof parsePresenceHeartbeat({ clientId: "bad/id" })).toBe("string");
    expect(typeof parsePresenceHeartbeat({ clientId: "tab", typing: "yes" })).toBe("string");
  });

  test("validates permission ids and isolates the initial authority policy", () => {
    expect(parsePermissionAnswer({ optionId: "allow-once" }, "request-1")).toEqual({ requestId: "request-1", optionId: "allow-once" });
    expect(typeof parsePermissionAnswer({ optionId: "bad/id" }, "request-1")).toBe("string");
    expect(canControl("host@example.com", "owner", "other@example.com")).toBe(true);
    expect(canControl("author@example.com", "member", "author@example.com")).toBe(true);
    expect(canControl("other@example.com", "member", "author@example.com")).toBe(false);
  });
});
