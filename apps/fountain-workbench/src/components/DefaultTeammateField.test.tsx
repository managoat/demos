/**
 * The field is shared by the create-project form and Settings & sharing, and
 * the two cases worth pinning are the ones that are not a select: one agent,
 * where the form answers instead of asking, and a value the project cannot
 * run, where the field has to admit that nothing will start.
 *
 * `agentFits` itself is tested in src/lib/workbench.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DefaultTeammateField } from "./DefaultTeammateField";
import { mount, step } from "../../test/render";
import type { Agent } from "../types";

const agent = (id: string, name: string, allow: Partial<Agent> = {}): Agent => ({ id, name, runtime: "claude", ...allow }) as Agent;

const coder = agent("a1", "Coder");
const scribe = agent("a2", "Scribe");
const fussy = agent("a3", "Fussy", { allowed_environment_ids: ["e9"] });

const anywhere = { environmentId: null, vaultId: null };

const html = (props: Partial<Parameters<typeof DefaultTeammateField>[0]> = {}) =>
  renderToStaticMarkup(<DefaultTeammateField agents={[coder, scribe]} loaded project={anywhere} value="" onChange={() => {}} {...props} />);

describe("the default teammate field", () => {
  test("more than one agent is a list, sorted, with the reasons a pick would not run", () => {
    const out = html({ agents: [scribe, coder, fussy], project: { environmentId: "e1", vaultId: null } });
    expect(out).toContain("Ask every time");
    expect(out.indexOf("Coder")).toBeLessThan(out.indexOf("Scribe"));
    expect(out).toContain("does not allow this project&#x27;s environment");
    // The one that cannot run is not pickable, and the two that can are.
    expect(out).toContain('value="a3" disabled');
    expect(out).not.toContain('value="a1" disabled');
  });

  test("one agent is the answer, not a list of one", () => {
    const out = html({ agents: [coder], value: "a1" });
    expect(out).not.toContain("<select");
    expect(out).toContain("Coder");
    expect(out).toContain("the only agent on your Fountain");
    expect(out).toContain("Ask every time instead");
  });

  test("the only agent can still be declined, and taken back", async () => {
    const picks: string[] = [];
    const view = (value: string) => <DefaultTeammateField agents={[coder]} loaded project={anywhere} value={value} onChange={(id) => picks.push(id)} />;
    const m = await mount(view("a1"));
    await step(() => m.container.querySelector("button")!.click());
    expect(picks).toEqual([""]);
    await m.render(view(""));
    expect(m.container.textContent).toContain("New work here asks every time.");
    await step(() => m.container.querySelector("button")!.click());
    expect(picks).toEqual(["", "a1"]);
    await m.unmount();
  });

  test("the only agent, when the project's computer shuts it out, is nobody", () => {
    const out = html({ agents: [fussy], value: "a3", project: { environmentId: "e1", vaultId: null } });
    expect(out).not.toContain("<select");
    expect(out).toContain("new work here asks every time");
  });

  test("no agents at all says so, once the list has actually arrived", () => {
    expect(html({ agents: [] })).toContain("No agents on your Fountain");
    // Before it has, an empty list is not news — and the select stays disabled.
    const loading = html({ agents: [], loaded: false });
    expect(loading).not.toContain("No agents on your Fountain");
    expect(loading).toContain("disabled");
  });

  test("a default that cannot run says so rather than looking set", () => {
    // Gone from the owner's Fountain…
    expect(html({ value: "a9" })).toContain("no longer on your Fountain");
    // …and still there, but outside this project's computer.
    expect(html({ agents: [coder, scribe, fussy], value: "a3", project: { environmentId: "e1", vaultId: null } })).toContain("asks every time until you pick another");
  });
});
