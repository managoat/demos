import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { foldConversation } from "../lib/protocol";
import { BriefDoc } from "./BriefDoc";

// Render smoke: a folded brief reads as a document — TL;DR box, sections,
// numbered sources as safe external links, caveats — and a revision shows
// version chips.

const BRIEF = (id: string, title: string) =>
  "```brief\n" +
  JSON.stringify({
    id,
    title,
    asked: "How do heat pumps work?",
    tldr: ["They move heat instead of making it."],
    sections: [{ heading: "How they work", body_md: "A loop moves heat **against** the gradient.\n\n- sized right\n- ducts tight" }],
    sources: [{ title: "DOE explainer", url: "https://energy.gov/heat-pumps", note: "the basics" }],
    caveats: ["Rebates unverified."],
    depth: "standard",
    written_at: "2026-08-19T12:00:00Z",
  }) +
  "\n```";

describe("BriefDoc", () => {
  test("renders the document: TL;DR, section markdown, sources, caveats", () => {
    const view = foldConversation([{ prompt: "x", reply: BRIEF("brf-a1", "Heat pumps, plainly"), done: true }]);
    const html = renderToString(
      <BriefDoc thread={view.threads[0]!} busy={false} working={false} onFollowup={() => undefined} />,
    );
    expect(html).toContain("Heat pumps, plainly");
    expect(html).toContain("The short version");
    expect(html).toContain("They move heat instead of making it.");
    expect(html).toContain("<strong>against</strong>");
    expect(html).toContain("<li>sized right</li>");
    expect(html).toMatch(/<a[^>]+href="https:\/\/energy\.gov\/heat-pumps"[^>]*target="_blank"[^>]*rel="noopener"/);
    expect(html).toContain("Rebates unverified.");
    expect(html).toContain("Ask a follow-up or request a revision");
    expect(html).not.toContain("chip");
  });

  test("a revision shows version chips and an analyst's note shows under the doc", () => {
    const view = foldConversation([
      { prompt: "x", reply: BRIEF("brf-a1", "Heat pumps"), done: true },
      { prompt: "Follow-up on brief brf-a1: what about rentals?", reply: "Rentals rarely qualify.", done: true },
      { prompt: "Follow-up on brief brf-a1: revise for renters", reply: BRIEF("brf-a1", "Heat pumps, for renters"), done: true },
    ]);
    const html = renderToString(
      <BriefDoc thread={view.threads[0]!} busy={false} working={false} onFollowup={() => undefined} />,
    );
    expect(html).toContain(">v1</button>");
    expect(html).toContain(">v2</button>");
    expect(html).toContain("Heat pumps, for renters"); // latest version by default
    expect(html).toContain("Analyst");
    expect(html).toContain("Rentals rarely qualify.");
    expect(html).toContain("You asked: what about rentals?");
  });
});
