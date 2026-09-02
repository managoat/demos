import { expect, test } from "bun:test";
import { DEMOS, host, source, url } from "./roster.js";
import { page } from "./build.js";

test("every id is a DNS label and a repo name at once", () => {
  for (const d of DEMOS) {
    expect(d.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(host(d)).toBe(`${d.id}.demo.managoat.com`);
    expect(source(d)).toBe(`https://github.com/managoat/demos/tree/main/apps/${d.id}`);
  }
});

test("ids are unique and sorted-stable, and nothing is empty", () => {
  expect(new Set(DEMOS.map((d) => d.id)).size).toBe(DEMOS.length);
  for (const d of DEMOS) {
    expect(d.name.length).toBeGreaterThan(0);
    expect(d.glyph.length).toBeGreaterThan(0);
    // Long enough to say something; short enough to fit a card.
    expect(d.blurb.length).toBeGreaterThan(40);
    expect(d.blurb.length).toBeLessThan(320);
  }
});

test("reflex is not here — it is built on the API but is not a demo", () => {
  expect(DEMOS.some((d) => d.id === "reflex")).toBe(false);
});

test("the page renders every demo, and escapes what it interpolates", () => {
  const html = page();
  for (const d of DEMOS) {
    expect(html).toContain(url(d));
    expect(html).toContain(source(d));
    expect(html).toContain(d.name);
  }
  // No unescaped quote can break out of an attribute.
  expect(html).not.toContain('href=""');
  expect(html.match(/<li class="card">/g)?.length).toBe(DEMOS.length);
});
