import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { appJwt, normalizeKey } from "./github";
import { buildRoutes } from "./routes";
import { loadConfig } from "./config";

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// ── a fake GitHub, so the whole flow is exercised without the network ───────
function fakeGitHub() {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname;
    calls.push(`${method} ${path}`);

    if (path === "/login/oauth/access_token") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { code?: string };
      if (body.code !== "good-code") return Response.json({ error: "bad_verification_code", error_description: "The code is incorrect." }, { status: 200 });
      return Response.json({ access_token: "gho_usertoken", expires_in: 28800 });
    }
    if (path === "/user") return Response.json({ login: "octocat" });
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ENV = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: privateKey,
  GITHUB_OAUTH_CLIENT_ID: "Iv1.abc",
  GITHUB_OAUTH_CLIENT_SECRET: "supersecret",
  GITHUB_APP_SLUG: "mend-bot",
};

function routesWith(fake: ReturnType<typeof fakeGitHub>, env = ENV) {
  return buildRoutes(loadConfig(env), { fetchImpl: fake.impl, api: "https://api.github.com", oauthHost: "https://github.com" });
}

const call = (routes: ReturnType<typeof buildRoutes>, path: string, init?: RequestInit) => {
  const url = new URL(`https://mend.test${path}`);
  return routes(new Request(url, init), url);
};

describe("appJwt", () => {
  test("verifies against the app's public key and stays inside GitHub's window", () => {
    const now = 1_760_000_000;
    const [h, p, s] = appJwt("123", privateKey, now).split(".") as [string, string, string];
    expect(crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as { iat: number; exp: number };
    expect(claims.iat).toBe(now - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });
});

describe("normalizeKey", () => {
  test("repairs a key flattened into literal backslash-n", () => {
    const fixed = normalizeKey(privateKey.trim().replace(/\n/g, "\\n"));
    expect(fixed).toContain("-----BEGIN PRIVATE KEY-----\n");
    expect(() => appJwt("1", fixed!)).not.toThrow();
  });

  test("refuses anything that is not a PEM key", () => {
    expect(normalizeKey("ghp_atokennotakey")).toBeNull();
    expect(normalizeKey(undefined)).toBeNull();
  });
});

describe("loadConfig", () => {
  test("trims whitespace off every secret — a trailing newline is the classic", () => {
    const cfg = loadConfig({
      ...ENV,
      GITHUB_APP_ID: "123\n",
      GITHUB_OAUTH_CLIENT_ID: "Iv1.abc\n",
      GITHUB_OAUTH_CLIENT_SECRET: "supersecret\n",
      GITHUB_APP_SLUG: "mend-bot\n",
    });
    expect(cfg.app).toMatchObject({ appId: "123", clientId: "Iv1.abc", clientSecret: "supersecret" });
    expect(cfg.slug).toBe("mend-bot");
  });

  test("a value that is only whitespace counts as absent", () => {
    expect(loadConfig({ ...ENV, GITHUB_OAUTH_CLIENT_SECRET: "   " }).app).toBeNull();
  });
});

describe("GET /gh/app", () => {
  test("advertises the app without leaking a secret", async () => {
    const res = await call(routesWith(fakeGitHub()), "/gh/app");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      configured: true,
      slug: "mend-bot",
      clientId: "Iv1.abc",
      installUrl: "https://github.com/apps/mend-bot/installations/new",
    });
    expect(JSON.stringify(body)).not.toContain("supersecret");
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
  });

  test("an unconfigured deployment says so, and every other route 503s", async () => {
    const routes = routesWith(fakeGitHub(), { ...ENV, GITHUB_APP_ID: undefined } as unknown as typeof ENV);
    expect(((await (await call(routes, "/gh/app")).json()) as { configured: boolean }).configured).toBe(false);
    expect((await call(routes, "/gh/callback?code=good-code")).status).toBe(503);
  });
});

describe("GET /gh/callback", () => {
  test("exchanges the code and returns the user's own token", async () => {
    const fake = fakeGitHub();
    const res = await call(routesWith(fake), "/gh/callback?code=good-code&redirect_uri=https%3A%2F%2Fmend.test%2F");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "gho_usertoken", login: "octocat", expiresIn: 28800 });
    expect(fake.calls).toContain("POST /login/oauth/access_token");
  });

  test("a bad code is reported as the caller's problem, without exposing the client secret", async () => {
    const res = await call(routesWith(fakeGitHub()), "/gh/callback?code=nope");
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("The code is incorrect.");
    expect(text).not.toContain("supersecret");
  });

  test("a missing code is a 400", async () => {
    expect((await call(routesWith(fakeGitHub()), "/gh/callback")).status).toBe(400);
  });
});
