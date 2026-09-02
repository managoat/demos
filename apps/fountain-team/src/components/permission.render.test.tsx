import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { PermissionBlock } from "../lib/feed";
import { PermissionCard } from "./PermissionCard";

// Render smoke for the ask card (fountain#940). The rule the tests are here
// to hold: the buttons are the agent's option list and nothing else, and a
// card that is not open cannot be answered.

const request: PermissionBlock = {
  kind: "permission",
  requestId: "41",
  name: "Bash",
  summary: "command=rm -rf build",
  options: [
    { optionId: "allow", name: "Allow once", kind: "allow_once", effects: [] },
    { optionId: "no", name: "Reject", kind: "reject_once", effects: [] },
  ],
  startedAt: "2026-08-22T00:00:00Z",
};

const card = (props: Partial<Parameters<typeof PermissionCard>[0]> = {}) =>
  renderToString(
    <PermissionCard
      request={request}
      resolution={null}
      live
      name="Koda"
      timeoutMs={300000}
      onAnswer={() => Promise.resolve()}
      {...props}
    />,
  );

describe("PermissionCard", () => {
  test("says who is asking, for what, and offers exactly the agent's options", () => {
    const html = card();
    expect(html).toContain("Koda");
    expect(html).toContain("Bash");
    expect(html).toContain("command=rm -rf build");
    expect(html).toContain("Allow once");
    expect(html).toContain("Reject");
    // two buttons, no more: nothing is synthesised (the trailing space keeps
    // this off the "ask-options" container)
    expect(html.match(/class="ask-option /g)).toHaveLength(2);
    expect(html).toContain("Denied automatically after 5 minutes if nobody answers.");
  });

  test("offering no options is said plainly rather than papered over with an Allow", () => {
    const html = card({ request: { ...request, options: [] } });
    expect(html).not.toContain("ask-option");
    expect(html).toContain("offered no options");
  });


  // What "Always Allow" really grants is far narrower than the label, and the
  // agent says so in the option's own metadata. Showing it is the difference
  // between answering once and being surprised by the next prompt.
  test("an option that reaches past this call says how far, in the agent's words", () => {
    const html = card({
      request: {
        ...request,
        options: [
          ...request.options,
          {
            optionId: "allow_always",
            name: "Always Allow",
            kind: "allow_always",
            effects: [
              { description: "Allow Bash calls matching rm -rf build", scope: "persistent" },
            ],
          },
        ],
      },
    });
    expect(html).toContain("Allow Bash calls matching rm -rf build");
    expect(html).toContain("saved in the sandbox");
    // and it is a note, not a fourth button
    expect(html.match(/class="ask-option /g)).toHaveLength(3);
  });

  test("options the agent described nothing about add no note", () => {
    expect(card()).not.toContain("ask-effects");
  });

  test("a resolved request shows how it ended and has nothing to click", () => {
    const html = card({ resolution: { requestId: "41", outcome: "answered", optionId: "allow", ts: "" } });
    expect(html).toContain("Allowed — Allow once");
    expect(html).not.toContain("ask-option");
  });

  test("a timeout reads as the deny it is", () => {
    const html = card({ resolution: { requestId: "41", outcome: "timeout", optionId: null, ts: "" } });
    expect(html).toContain("Denied — nobody answered in time");
    expect(html).toContain("ask resolved reject");
  });

  test("an unresolved card on a finished turn is not answerable", () => {
    const html = card({ live: false });
    expect(html).not.toContain("ask-option");
    expect(html).toContain("No longer waiting");
  });
});
