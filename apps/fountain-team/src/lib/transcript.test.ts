import { describe, expect, test, beforeEach } from "bun:test";
import { loadTranscriptBase, resetTranscriptBase, transcriptUrl } from "./transcript";
import type { FountainClient } from "../api/client";

const client = (catalog: unknown): FountainClient =>
  ({ getCatalog: async () => catalog } as unknown as FountainClient);

describe("transcriptUrl", () => {
  beforeEach(() => resetTranscriptBase());

  test("falls back to Fountain's redirect until the catalog lands", () => {
    expect(transcriptUrl("https://f.test", "c1")).toBe("https://f.test/conversations/c1");
  });

  test("links straight at the app once it knows where it is", async () => {
    await loadTranscriptBase(client({ apps: { conversations: "https://apps.test/convs", team: null } }));
    expect(transcriptUrl("https://f.test", "c1")).toBe("https://apps.test/convs/#/c/c1");
  });

  test("a deployment with no app, and an older server with no `apps` at all, keep the fallback", async () => {
    await loadTranscriptBase(client({ apps: { conversations: null, team: null } }));
    expect(transcriptUrl("https://f.test", "c1")).toBe("https://f.test/conversations/c1");

    resetTranscriptBase();
    await loadTranscriptBase(client({ runtimes: [] }));
    expect(transcriptUrl("https://f.test", "c1")).toBe("https://f.test/conversations/c1");
  });

  test("a failing catalog does not throw, and is only asked once", async () => {
    let calls = 0;
    const flaky = {
      getCatalog: async () => {
        calls += 1;
        throw new Error("nope");
      },
    } as unknown as FountainClient;

    await loadTranscriptBase(flaky);
    await loadTranscriptBase(flaky);
    expect(calls).toBe(1);
    expect(transcriptUrl("https://f.test", "c1")).toBe("https://f.test/conversations/c1");
  });
});
