/**
 * The row a proposal makes. A teammate's verdict is only worth recording if a
 * person can read it and answer it where the item already is, so this checks
 * the two things the row has to say: who proposed what, and that answering it
 * is the ordinary close — with the same warning about the computers.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CloseControls } from "./ItemStatus";
import { proposerName } from "../lib/workbench";
import type { Proposal } from "../lib/workbench";

const wont: Proposal = { status: "wont", agentId: "a1", email: "alice@example.com", at: "2026-08-24T10:00:00Z" };
const agents = new Map([["a1", { name: "Coder" }]]);

const markup = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("an open item with a proposal on it", () => {
  test("says who proposed what, and offers the answer instead of the plain pair", () => {
    const html = markup(<CloseControls status="open" live={0} proposal={wont} proposedBy={proposerName(wont, agents)} onSet={() => {}} onDismiss={() => {}} />);
    expect(html).toContain("Coder says: won&#x27;t do");
    expect(html).toContain("Confirm won&#x27;t do");
    expect(html).toContain("Dismiss");
    // The question replaces the pair; dismissing brings them back.
    expect(html).not.toContain("Mark done");
  });

  test("confirming asks first when there are computers to lose, exactly as closing does", () => {
    const html = markup(<CloseControls status="open" live={2} proposal={wont} proposedBy="Coder" onSet={() => {}} onDismiss={() => {}} />);
    expect(html).toContain("Retires 2 conversations");
  });

  test("a teammate that has since left the team is still a name on the row: the account that proposed it", () => {
    const orphan: Proposal = { ...wont, agentId: "gone" };
    expect(proposerName(orphan, agents)).toBe("alice@example.com");
    expect(proposerName({ ...wont, agentId: null }, agents)).toBe("alice@example.com");
  });
});

describe("an item nobody has proposed anything on", () => {
  test("has the three ways of stopping the work and nothing else", () => {
    const html = markup(<CloseControls status="open" live={0} onSet={() => {}} />);
    expect(html).toContain("Mark done");
    expect(html).toContain("Won&#x27;t do");
    expect(html).toContain("Icebox");
    expect(html).not.toContain("says:");
    expect(html).not.toContain("Dismiss");
  });

  test("the icebox says what it is for, because nothing else on the row would", () => {
    const html = markup(<CloseControls status="open" live={0} onSet={() => {}} />);
    expect(html).toContain("Looked at, and not now");
  });

  test("parking a live item is the same loss as closing one, and asks the same way", () => {
    // No cheap door out: on ice retires the conversations too, so the button
    // is the two-step one whenever there is something to lose.
    const html = markup(<CloseControls status="open" live={2} onSet={() => {}} />);
    expect(html.match(/Retires 2 conversations/g)).toHaveLength(3);
  });

  test("a closed one is reopened or relabelled, with no proposal in the way", () => {
    const html = markup(<CloseControls status="wont" live={0} onSet={() => {}} />);
    expect(html).toContain("Reopen");
    // The other two answers, one click each — the machines went the first time.
    expect(html).toContain("Done");
    expect(html).toContain("Icebox");
    expect(html).not.toContain("Won&#x27;t do");
  });

  test("an item on ice offers the two verdicts it is not, and the way back", () => {
    const html = markup(<CloseControls status="icebox" live={0} onSet={() => {}} />);
    expect(html).toContain("Reopen");
    expect(html).toContain("Done");
    expect(html).toContain("Won&#x27;t do");
    expect(html).not.toContain("Icebox");
  });
});
