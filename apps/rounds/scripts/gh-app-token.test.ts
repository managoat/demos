import { afterAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { appJwt, installationToken, normalizeKey } from "./gh-app-token.mjs";

// A real keypair, generated here — the JWT is verified against it rather than
// eyeballed, and a fake GitHub answers the two calls a mint actually makes.
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString());
}

describe("appJwt", () => {
  const now = 1_760_000_000;
  const jwt = appJwt("123456", privateKey, now);
  const [header, payload, signature] = jwt.split(".") as [string, string, string];

  test("is a real RS256 JWT that verifies against the app's public key", () => {
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const ok = crypto
      .createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);
  });

  test("backdates iat for clock skew and stays inside GitHub's ten-minute ceiling", () => {
    const claims = decode(payload) as { iat: number; exp: number; iss: string };
    expect(claims.iat).toBe(now - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(claims.iss).toBe("123456");
  });

  test("the app id is always a string, even when given a number", () => {
    expect((decode(appJwt(99, privateKey, now).split(".")[1]!) as { iss: unknown }).iss).toBe("99");
  });
});

describe("normalizeKey", () => {
  test("accepts a real PEM unchanged", () => {
    expect(normalizeKey(privateKey)?.trim()).toBe(privateKey.trim());
  });

  test("repairs a key pasted with literal backslash-n", () => {
    const mangled = privateKey.trim().replace(/\n/g, "\\n");
    const fixed = normalizeKey(mangled);
    expect(fixed).toContain("-----BEGIN PRIVATE KEY-----\n");
    // and the repaired key must actually sign
    expect(() => appJwt("1", fixed!)).not.toThrow();
  });

  test("rejects anything that is not a private key, rather than failing later in OpenSSL", () => {
    expect(normalizeKey("ghp_thisisatokennotakey")).toBeNull();
    expect(normalizeKey("")).toBeNull();
    expect(normalizeKey(undefined)).toBeNull();
  });
});

describe("installationToken", () => {
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      calls.push(`${req.method} ${url.pathname}`);
      const auth = req.headers.get("authorization") ?? "";
      // Every call must carry the signed app JWT.
      if (!auth.startsWith("Bearer ") || auth.split(".").length !== 3) {
        return Response.json({ message: "bad jwt" }, { status: 401 });
      }
      if (url.pathname === "/repos/o/r/installation") return Response.json({ id: 4242 });
      if (url.pathname === "/repos/o/missing/installation") return Response.json({ message: "Not Found" }, { status: 404 });
      if (url.pathname === "/app/installations/4242/access_tokens") {
        return Response.json({ token: "ghs_installationtoken", expires_at: "2026-08-20T10:00:00Z" }, { status: 201 });
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  });
  const api = `http://localhost:${server.port}`;
  afterAll(() => server.stop(true));

  test("resolves the installation for the repo, then mints its token", async () => {
    const token = await installationToken("o/r", { appId: "1", privateKey, api });
    expect(token).toBe("ghs_installationtoken");
    expect(calls).toEqual(["GET /repos/o/r/installation", "POST /app/installations/4242/access_tokens"]);
  });

  test("a repo the App is not installed on says exactly that", async () => {
    await expect(installationToken("o/missing", { appId: "1", privateKey, api })).rejects.toThrow(
      /not installed on o\/missing/,
    );
  });

  test("a bad key surfaces as a signing error, not a silent empty token", () => {
    expect(() => appJwt("1", "not a key")).toThrow();
  });
});
