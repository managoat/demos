import { describe, expect, test } from "bun:test";
import { drain, enqueue, removeQueued, withoutConversation, type QueuedMessage } from "./queue";

const msg = (id: string, text: string, images: QueuedMessage["images"] = []): QueuedMessage => ({
  id,
  text,
  images,
  at: "2026-08-19T00:00:00Z",
});

describe("steer queue", () => {
  test("drains everything for a conversation into one prompt, in order", () => {
    let q = enqueue(new Map(), "c1", msg("a", "also check the tests"));
    q = enqueue(q, "c1", msg("b", "  and bump the version  "));
    q = enqueue(q, "c2", msg("z", "unrelated"));
    const d = drain(q, "c1");
    expect(d?.prompt).toBe("also check the tests\n\nand bump the version");
    expect(d?.items.map((m) => m.id)).toEqual(["a", "b"]);
    // draining is a read; the caller decides when to clear
    expect(drain(q, "c1")?.items.length).toBe(2);
    expect(withoutConversation(q, "c1").has("c1")).toBe(false);
    expect(drain(q, "c2")?.prompt).toBe("unrelated");
  });

  test("concatenates images across queued messages", () => {
    const img = (name: string) => ({ data: "AAAA", media_type: "image/png", name, previewUrl: `blob:${name}` });
    let q = enqueue(new Map(), "c1", msg("a", "look", [img("one")]));
    q = enqueue(q, "c1", msg("b", "", [img("two")]));
    const d = drain(q, "c1")!;
    expect(d.images.map((i) => i.name)).toEqual(["one", "two"]);
    expect(d.prompt).toBe("look");
  });

  test("nothing queued drains to null", () => {
    expect(drain(new Map(), "c1")).toBeNull();
  });

  test("removing the last item drops the conversation's queue", () => {
    let q = enqueue(new Map(), "c1", msg("a", "x"));
    q = enqueue(q, "c1", msg("b", "y"));
    q = removeQueued(q, "c1", "a");
    expect(q.get("c1")?.map((m) => m.id)).toEqual(["b"]);
    q = removeQueued(q, "c1", "b");
    expect(q.has("c1")).toBe(false);
  });

  test("does not mutate the previous map", () => {
    const q0 = new Map();
    const q1 = enqueue(q0, "c1", msg("a", "x"));
    expect(q0.size).toBe(0);
    expect(q1.size).toBe(1);
  });
});
