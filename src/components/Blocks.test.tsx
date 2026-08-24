/**
 * The permission card. The pairing that decides whether it is still held is
 * tested in src/lib/blocks.test.ts; this is here because the card is the only
 * block a person has to act on, and the two rules it enforces are worth a
 * test each: the buttons are the runtime's own options and nothing else, and
 * a request that is over stops offering them.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BlockView } from "./Blocks";
import type { Permission, ShownBlock } from "../lib/blocks";

type PermissionBlock = Extract<ShownBlock, { kind: "permission_request" }>;

const OPTIONS = [
  { optionId: "o-once", name: "Allow once", kind: "allow_once" },
  { optionId: "o-always", name: "Allow always", kind: "allow_always" },
  { optionId: "o-no", name: "Reject", kind: "reject_once" },
];

const ask = (permission: Partial<Permission> = {}, over: Partial<PermissionBlock> = {}): PermissionBlock => ({
  kind: "permission_request",
  request_id: "r1",
  name: "Bash",
  summary: "rm -rf build/",
  options: OPTIONS,
  ...over,
  permission: { outcome: null, optionId: null, expiresAt: new Date(Date.now() + 4 * 60_000 + 1000).toISOString(), ...permission },
});

const render = (block: PermissionBlock, onAnswer?: () => Promise<void>) => renderToStaticMarkup(<BlockView block={block} onAnswer={onAnswer} />);

describe("a held permission request", () => {
  test("offers the runtime's own options, and says how long is left", () => {
    const html = render(ask(), async () => undefined);
    expect(html).toContain("Waiting on you before it runs.");
    expect(html).toContain("Allow once");
    expect(html).toContain("Allow always");
    expect(html).toContain("Reject");
    expect(html).toContain("4m left");
    expect(html).not.toContain("disabled");
  });

  test("no options is a card that says so rather than one that invents a button", () => {
    const html = render(ask({}, { options: [] }), async () => undefined);
    expect(html).toContain("nothing to answer it with");
    expect(html).not.toContain("<button");
  });

  test("an option the runtime sent no id for is not a button", () => {
    const html = render(ask({}, { options: [{ name: "Nameless", kind: "allow_once" }, OPTIONS[2]!] }), async () => undefined);
    expect(html).not.toContain("Nameless");
    expect(html).toContain("Reject");
  });

  test("a view with no way to answer shows the ask and no buttons", () => {
    const html = render(ask());
    expect(html).toContain("nothing to answer it with");
    expect(html).not.toContain("<button");
  });
});

describe("a permission request that is over", () => {
  test("an answer names the option it was answered with", () => {
    const html = render(ask({ outcome: "answered", optionId: "o-once" }), async () => undefined);
    expect(html).toContain("Answered — Allow once.");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("left");
  });

  test("an option id the block never carried is still reported, as itself", () => {
    expect(render(ask({ outcome: "answered", optionId: "proceed_once" }))).toContain("Answered — proceed_once.");
  });

  test("the timeout and the turn ending each say what happened", () => {
    expect(render(ask({ outcome: "timeout" }))).toContain("Fountain refused it");
    expect(render(ask({ outcome: "turn_ended" }))).toContain("The turn ended before anyone answered");
  });

  test("a close we never saw is not a card that waits forever", () => {
    const html = render(ask({ expiresAt: new Date(Date.now() - 1000).toISOString() }), async () => undefined);
    expect(html).toContain("Expired");
    expect(html).not.toContain("<button");
  });
});
