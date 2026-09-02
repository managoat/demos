import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICY, parsePolicy } from "./policy";

describe("parsePolicy", () => {
  test("no file means the default policy", () => {
    expect(parsePolicy(null)).toEqual(DEFAULT_POLICY);
  });

  test("the documented file, read whole", () => {
    expect(
      parsePolicy(`enabled: true
tiers: [quick-win, needs-review]
ignore: [GHA021]
paths_ignore: ["examples/**"]
max_open_prs: 3
`),
    ).toEqual({ enabled: true, tiers: ["quick-win", "needs-review"], ignore: ["GHA021"], pathsIgnore: ["examples/**"], maxOpenPrs: 3 });
  });

  test("block lists, the other way people write YAML", () => {
    const p = parsePolicy(`ignore:
  - GHA021
  - DKRD012
paths_ignore:
  - "examples/**"
max_open_prs: 1
`);
    expect(p.ignore).toEqual(["GHA021", "DKRD012"]);
    expect(p.pathsIgnore).toEqual(["examples/**"]);
    expect(p.maxOpenPrs).toBe(1);
  });

  test("comments are not values", () => {
    expect(parsePolicy("# turn it off one day\nmax_open_prs: 2 # for now\n").maxOpenPrs).toBe(2);
    expect(parsePolicy('paths_ignore: ["a#b"]\n').pathsIgnore).toEqual(["a#b"]);
  });

  test("enabled is only false when it says false", () => {
    expect(parsePolicy("enabled: false\n").enabled).toBe(false);
    expect(parsePolicy("enabled: FALSE\n").enabled).toBe(false);
    expect(parsePolicy("enabled: true\n").enabled).toBe(true);
    expect(parsePolicy("").enabled).toBe(true);
  });

  test("zero is a policy; a typo is not", () => {
    expect(parsePolicy("max_open_prs: 0\n").maxOpenPrs).toBe(0);
    expect(parsePolicy("max_open_prs: -1\n").maxOpenPrs).toBe(DEFAULT_POLICY.maxOpenPrs);
    expect(parsePolicy("max_open_prs: lots\n").maxOpenPrs).toBe(DEFAULT_POLICY.maxOpenPrs);
    expect(parsePolicy("max_open_prs: 9999\n").maxOpenPrs).toBe(DEFAULT_POLICY.maxOpenPrs);
  });

  test("keys it does not know are ignored, as documented", () => {
    const p = parsePolicy("enabled: true\nsomething_new: 5\nmax_open_prs: 4\n");
    expect(p.maxOpenPrs).toBe(4);
    expect(p.enabled).toBe(true);
  });

  test("an empty list is an empty list, not the default", () => {
    expect(parsePolicy("tiers: []\n").tiers).toEqual([]);
  });

  // Null means "this repository has not said", which is not the same as a
  // default: the tiers chosen at enrollment stand until the file overrides
  // them. Answering ["quick-win"] here would quietly refuse the judgment calls
  // for every repository that has never written a .rounds.yml.
  test("no file, and a file that never mentions tiers, both leave tiers unsaid", () => {
    expect(parsePolicy(null).tiers).toBeNull();
    expect(parsePolicy("max_open_prs: 5\n").tiers).toBeNull();
  });

  test("the hygiene tier is a thing a repository may ask for", () => {
    expect(parsePolicy("tiers: [quick-win, needs-review, report-only]\n").tiers).toEqual([
      "quick-win",
      "needs-review",
      "report-only",
    ]);
  });

  test("garbage is not an error — it just means no policy", () => {
    expect(parsePolicy("{{{ not yaml at all")).toEqual(DEFAULT_POLICY);
  });
});
