import { describe, expect, test } from "bun:test";
import {
  displayUrl,
  fetchedUrls,
  foldConversation,
  latestOrphan,
  parseBriefs,
  parseRequest,
  stripBriefs,
} from "./protocol";
import { commissionPrompt, followupPrompt } from "./spec";

const BRIEF = (id: string, title = "Heat pumps, plainly") =>
  "```brief\n" +
  JSON.stringify({
    id,
    title,
    asked: "How do heat pumps work and are they worth it?",
    tldr: ["They move heat instead of making it.", "That is why they beat furnaces on running cost.", "Cold-climate models now work well below freezing."],
    sections: [{ heading: "How they work", body_md: "A refrigerant loop moves heat **against** the gradient." }],
    sources: [{ title: "DOE explainer", url: "https://energy.gov/heat-pumps", note: "the basics" }],
    caveats: ["Could not verify 2026 rebate amounts."],
    depth: "standard",
    written_at: "2026-08-19T12:00:00Z",
  }) +
  "\n```";

describe("parseBriefs", () => {
  test("parses a well-formed brief with all its parts", () => {
    const briefs = parseBriefs(`Here you go.\n${BRIEF("brf-a1")}`);
    expect(briefs).toHaveLength(1);
    const b = briefs[0]!;
    expect(b.id).toBe("brf-a1");
    expect(b.title).toBe("Heat pumps, plainly");
    expect(b.tldr).toHaveLength(3);
    expect(b.sections[0]!.heading).toBe("How they work");
    expect(b.sources[0]!.url).toBe("https://energy.gov/heat-pumps");
    expect(b.caveats).toEqual(["Could not verify 2026 rebate amounts."]);
    expect(b.depth).toBe("standard");
  });

  test("skips malformed JSON and briefs without a title", () => {
    expect(parseBriefs("```brief\n{nope}\n```")).toHaveLength(0);
    expect(parseBriefs('```brief\n{"id":"brf-x","tldr":["a"]}\n```')).toHaveLength(0);
  });

  test("ignores ordinary code fences", () => {
    expect(parseBriefs("```bash\necho hi\n```")).toHaveLength(0);
  });

  test("drops sources that were not fetched over http(s) and tolerates missing fields", () => {
    const briefs = parseBriefs(
      '```brief\n{"title":"Thin","sources":[{"title":"made up"},{"url":"ftp://x"},{"url":"https://real.example"}]}\n```',
    );
    expect(briefs[0]!.id).toBeNull();
    expect(briefs[0]!.sources).toEqual([{ title: "https://real.example", url: "https://real.example" }]);
    expect(briefs[0]!.tldr).toEqual([]);
  });
});

describe("stripBriefs", () => {
  test("removes the block, keeps prose", () => {
    const s = stripBriefs(`Before.\n${BRIEF("brf-a1")}\nAfter.`);
    expect(s).toContain("Before.");
    expect(s).toContain("After.");
    expect(s).not.toContain("brief");
  });
});

describe("parseRequest", () => {
  test("round-trips a commission", () => {
    const req = parseRequest(commissionPrompt("EU AI Act", "board asks Thursday", "deep"));
    expect(req).toEqual({ kind: "commission", topic: "EU AI Act", why: "board asks Thursday", depth: "deep" });
  });
  test("round-trips a commission without a why", () => {
    const req = parseRequest(commissionPrompt("EU AI Act", "  ", "quick"));
    expect(req).toEqual({ kind: "commission", topic: "EU AI Act", why: null, depth: "quick" });
  });
  test("round-trips a follow-up", () => {
    expect(parseRequest(followupPrompt("brf-a1", "what about rentals?"))).toEqual({
      kind: "followup",
      briefId: "brf-a1",
      text: "what about rentals?",
    });
  });
  test("free text is not a request", () => {
    expect(parseRequest("please commission a brief on cats")).toBeNull();
  });
});

describe("foldConversation", () => {
  const commission = commissionPrompt("heat pumps", "", "standard");

  test("a brief starts a thread; a same-id block is the next version", () => {
    const view = foldConversation([
      { prompt: commission, reply: BRIEF("brf-a1"), done: true },
      { prompt: followupPrompt("brf-a1", "shorter please"), reply: BRIEF("brf-a1", "Heat pumps, shorter"), done: true },
    ]);
    expect(view.threads).toHaveLength(1);
    expect(view.threads[0]!.versions.map((v) => v.brief.title)).toEqual(["Heat pumps, plainly", "Heat pumps, shorter"]);
  });

  test("a prose follow-up answer becomes an analyst's note on its thread", () => {
    const view = foldConversation([
      { prompt: commission, reply: BRIEF("brf-a1"), done: true },
      { prompt: followupPrompt("brf-a1", "what about rentals?"), reply: "Rentals rarely qualify — the owner installs.", done: true },
    ]);
    expect(view.threads[0]!.notes).toEqual([
      { question: "what about rentals?", text: "Rentals rarely qualify — the owner installs.", turnIndex: 1 },
    ]);
  });

  test("a commission answered without a block is an orphan and offers a re-ask", () => {
    const view = foldConversation([{ prompt: commission, reply: "I read three sources; in short, they move heat.", done: true }]);
    expect(view.threads).toHaveLength(0);
    expect(view.orphans).toEqual([{ topic: "heat pumps", text: "I read three sources; in short, they move heat.", turnIndex: 0 }]);
    expect(latestOrphan(view)!.topic).toBe("heat pumps");
  });

  test("a running turn is neither a note nor an orphan yet", () => {
    const view = foldConversation([{ prompt: commission, reply: "Reading…", done: false }]);
    expect(view.orphans).toHaveLength(0);
  });

  test("an orphan settled by a later brief no longer offers a re-ask", () => {
    const view = foldConversation([
      { prompt: commission, reply: "prose only", done: true },
      { prompt: "Your last reply had no brief block. Please send the same answer again as exactly one complete ```brief block, following the protocol.", reply: BRIEF("brf-b2"), done: true },
    ]);
    expect(view.threads).toHaveLength(1);
    expect(latestOrphan(view)).toBeNull();
  });

  test("threads order newest activity first", () => {
    const view = foldConversation([
      { prompt: commission, reply: BRIEF("brf-a1", "First"), done: true },
      { prompt: commissionPrompt("solar", "", "quick"), reply: BRIEF("brf-b2", "Second"), done: true },
      { prompt: followupPrompt("brf-a1", "still true?"), reply: "Yes.", done: true },
    ]);
    expect(view.threads.map((t) => t.id)).toEqual(["brf-a1", "brf-b2"]);
  });

  test("a brief with no id gets a stable per-turn stand-in", () => {
    const view = foldConversation([
      { prompt: commission, reply: '```brief\n{"title":"No id"}\n```', done: true },
    ]);
    expect(view.threads[0]!.id).toBe("brf-turn-0");
  });
});

describe("fetchedUrls / displayUrl", () => {
  test("pulls deduped URLs out of tool text, trims trailing punctuation", () => {
    expect(
      fetchedUrls([
        'command=curl -sSL "https://html.duckduckgo.com/html/?q=heat+pumps"',
        "command=curl -sSL https://energy.gov/heat-pumps.",
        "command=curl -sSL https://energy.gov/heat-pumps",
      ]),
    ).toEqual(["https://html.duckduckgo.com/html/?q=heat+pumps", "https://energy.gov/heat-pumps"]);
  });

  test("displayUrl shows host and path, no scheme or query", () => {
    expect(displayUrl("https://energy.gov/heat-pumps?utm=x")).toBe("energy.gov/heat-pumps");
    expect(displayUrl("https://example.com/")).toBe("example.com");
    expect(displayUrl("not a url")).toBe("not a url");
  });
});
