import { describe, expect, test } from "bun:test";
import {
  CONNECTOR_CATALOG,
  buildCustomServer,
  connectorFor,
  describeServer,
  missingVars,
  parseKeyValues,
  referencedVars,
  searchConnectors,
  slugify,
  splitCommand,
  validSecretKey,
  validServerId,
  withServer,
  withoutServer,
} from "./connectors";

describe("connector catalog", () => {
  test("ids are unique slugs; every secret is referenced by its server and nothing else is", () => {
    const ids = new Set<string>();
    for (const c of CONNECTOR_CATALOG) {
      expect(validServerId(c.id)).toBe(true);
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
      const vars = referencedVars(c.server);
      if (c.secret) {
        expect(validSecretKey(c.secret.key)).toBe(true);
        expect(vars).toEqual([c.secret.key]);
      } else expect(vars).toEqual([]);
      if (c.kind === "http") expect((c.server as { url: string }).url).toMatch(/^https:\/\//);
      else expect((c.server as { command: string }).command).toBeTruthy();
    }
  });

  test("search and lookup", () => {
    expect(searchConnectors("github").map((c) => c.id)).toContain("github");
    expect(searchConnectors("stripe").map((c) => c.id)).toEqual(["stripe"]);
    expect(searchConnectors("search").length).toBeGreaterThan(2);
    expect(connectorFor("stripe")?.label).toBe("Stripe");
    expect(connectorFor("nope")).toBeNull();
  });
});

describe("${VAR} references", () => {
  test("found in headers, env, args and urls; escapes ignored; each once", () => {
    expect(referencedVars({ type: "http", url: "https://x/${A}/mcp", headers: { Authorization: "Bearer ${B}", X: "${A}" } })).toEqual(["A", "B"]);
    expect(referencedVars({ command: "npx", args: ["${C}"], env: { T: "$${NOT_ONE}" } })).toEqual(["C"]);
    expect(referencedVars({ type: "http", url: "https://x/${lower}" })).toEqual([]);
  });

  test("missingVars against the environment's keys", () => {
    const s = { type: "http" as const, url: "https://x", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } };
    expect(missingVars(s, [])).toEqual(["GITHUB_TOKEN"]);
    expect(missingVars(s, ["GITHUB_TOKEN"])).toEqual([]);
  });
});

describe("describing and editing servers", () => {
  test("describeServer masks query tokens and path secrets; shows commands whole", () => {
    expect(describeServer({ type: "http", url: "https://mcp.exa.ai/mcp?exaApiKey=${EXA_API_KEY}" })).toBe("https://mcp.exa.ai/mcp?exaApiKey=…");
    expect(describeServer({ type: "http", url: "https://mcp.firecrawl.dev/${FIRECRAWL_API_KEY}/v2/mcp" })).toBe("https://mcp.firecrawl.dev/…/v2/mcp");
    expect(describeServer({ command: "npx", args: ["-y", "x"] })).toBe("npx -y x");
  });

  test("with/without keep the rest", () => {
    const a = withServer({}, "a", { type: "http", url: "https://a" });
    const ab = withServer(a, "b", { command: "b" });
    expect(Object.keys(ab)).toEqual(["a", "b"]);
    expect(withoutServer(ab, "a")).toEqual({ b: { command: "b" } });
  });

  test("slugify", () => {
    expect(slugify("My  Server!")).toBe("my-server");
    expect(validServerId(slugify("  --Weird__ "))).toBe(true);
  });
});

describe("the custom server form", () => {
  test("KEY=value lines", () => {
    expect(parseKeyValues("A=1\n# c\n\nAuthorization = Bearer ${T}")).toEqual({ ok: true, map: { A: "1", Authorization: "Bearer ${T}" } });
    expect(parseKeyValues("novalue")).toMatchObject({ ok: false });
    expect(parseKeyValues("=x")).toMatchObject({ ok: false });
  });

  test("splitCommand honours quotes", () => {
    expect(splitCommand(`npx -y "some pkg" 'a b'`)).toEqual(["npx", "-y", "some pkg", "a b"]);
  });

  test("hosted: url + headers; local: argv + env", () => {
    expect(buildCustomServer({ kind: "http", url: "https://x/mcp", command: "", headers: "Authorization=Bearer ${K}", env: "" })).toEqual({
      ok: true,
      server: { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer ${K}" } },
    });
    expect(buildCustomServer({ kind: "http", url: "x/mcp", command: "", headers: "", env: "" })).toMatchObject({ ok: false });
    expect(buildCustomServer({ kind: "stdio", url: "", command: "npx -y pkg", headers: "", env: "TOKEN=${T}" })).toEqual({
      ok: true,
      server: { command: "npx", args: ["-y", "pkg"], env: { TOKEN: "${T}" } },
    });
    expect(buildCustomServer({ kind: "stdio", url: "", command: "  ", headers: "", env: "" })).toMatchObject({ ok: false });
  });
});
