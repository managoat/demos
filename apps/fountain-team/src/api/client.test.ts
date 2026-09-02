import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, FountainClient } from "./client";

// The contact calls against a stubbed fetch: the right method/path/body out,
// the unwrapped `data` in, and the server's refusals as ApiErrors that keep
// what the UI needs (field errors, the provider channel).

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; init: RequestInit | undefined };
function stub(status: number, body: unknown, calls: Call[]) {
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const text = body === undefined ? "" : JSON.stringify(body);
    return Promise.resolve(new Response(text, { status, headers: { "content-type": "application/json" } }));
  }) as unknown as typeof fetch;
}

const client = new FountainClient({ baseUrl: "https://fountain.test", apiKey: "ftn_x", via: "paste" });
const teammate = { agent_id: "a1", name: "Koda", contact: { email: "koda@agentmail.to", phone: "+15551234567", prompt_from_number: "+15557654321", inserted_at: "2026-08-19T00:00:00Z" } };

describe("contact API", () => {
  test("commsStatus reads GET /api/team/comms", async () => {
    const calls: Call[] = [];
    stub(200, { data: { enabled: true, configured: false } }, calls);
    expect(await client.commsStatus()).toEqual({ enabled: true, configured: false });
    expect(calls[0]!.url).toBe("https://fountain.test/api/team/comms");
    expect(calls[0]!.init?.method).toBe("GET");
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer ftn_x");
  });

  test("provisionContact posts the number and returns the teammate", async () => {
    const calls: Call[] = [];
    stub(201, { data: teammate }, calls);
    const t = await client.provisionContact("a1", "+15557654321");
    expect(t.contact?.email).toBe("koda@agentmail.to");
    expect(calls[0]!.url).toBe("https://fountain.test/api/team/a1/contact");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ prompt_from_number: "+15557654321" });
  });

  test("changeContactNumber patches the number and returns the teammate", async () => {
    const calls: Call[] = [];
    const changed = { ...teammate, contact: { ...teammate.contact, prompt_from_number: "+15550001111", prompt_opted_out_at: null } };
    stub(200, { data: changed }, calls);
    const t = await client.changeContactNumber("a1", "+15550001111");
    expect(t.contact?.prompt_from_number).toBe("+15550001111");
    expect(t.contact?.prompt_opted_out_at).toBeNull();
    expect(calls[0]!.url).toBe("https://fountain.test/api/team/a1/contact");
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ prompt_from_number: "+15550001111" });
  });

  test("changeContactNumber: 422 keeps the field error, 404 is not_found", async () => {
    stub(422, { errors: { prompt_from_number: ["must be a phone number with country code, e.g. +15551234567"] } }, []);
    const e1 = (await client.changeContactNumber("a1", "x").catch((e: unknown) => e)) as ApiError;
    expect(e1.status).toBe(422);
    expect(e1.fieldErrors.prompt_from_number).toEqual(["must be a phone number with country code, e.g. +15551234567"]);
    stub(404, { error: "not_found" }, []);
    const e2 = (await client.changeContactNumber("a1", "+15550001111").catch((e: unknown) => e)) as ApiError;
    expect(e2.status).toBe(404);
    expect(e2.code).toBe("not_found");
  });

  test("releaseContact deletes and resolves on 204", async () => {
    const calls: Call[] = [];
    stub(204, undefined, calls);
    await expect(client.releaseContact("a1")).resolves.toBeUndefined();
    expect(calls[0]!.init?.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://fountain.test/api/team/a1/contact");
  });

  test("a 422 keeps the field errors", async () => {
    stub(422, { errors: { prompt_from_number: ["can't be blank"] } }, []);
    const err = await client.provisionContact("a1", "").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).fieldErrors).toEqual({ prompt_from_number: ["can't be blank"] });
  });

  test("a 502 keeps the channel and message", async () => {
    stub(502, { error: "provider_error", channel: "email", message: "HTTP 401: bad key" }, []);
    const err = (await client.provisionContact("a1", "+15557654321").catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("provider_error");
    expect(err.message).toBe("HTTP 401: bad key");
    expect(err.body?.channel).toBe("email");
  });

  test("the gates come through as codes", async () => {
    stub(404, { error: "team_comms_not_enabled" }, []);
    expect(((await client.commsStatus().catch((e: unknown) => e)) as ApiError).code).toBe("team_comms_not_enabled");
    stub(503, { error: "team_comms_not_configured", message: "this instance has no AgentMail/AgentPhone keys configured" }, []);
    expect(((await client.provisionContact("a1", "+15557654321").catch((e: unknown) => e)) as ApiError).code).toBe("team_comms_not_configured");
    stub(409, { error: "contact_already_provisioned" }, []);
    expect(((await client.provisionContact("a1", "+15557654321").catch((e: unknown) => e)) as ApiError).status).toBe(409);
  });

  test("fieldErrors is empty for bodies without one", () => {
    expect(new ApiError(500, null, "x").fieldErrors).toEqual({});
    expect(new ApiError(422, null, "x", null, { errors: "nope" }).fieldErrors).toEqual({});
    expect(new ApiError(422, null, "x", null, { errors: { a: "one", b: ["two", 3] } }).fieldErrors).toEqual({ a: ["one"], b: ["two"] });
  });
});
