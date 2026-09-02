/**
 * The owner's brokering panel has to say three things plainly: whether the
 * broker is on at all, which of the project's secrets go to the broker and
 * where, and which go into the sandbox in the clear. And it must carry a
 * name only, never a value — there is none in the DTO to leak, and the test
 * keeps it that way by construction.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BrokeringPanel, shapeOf } from "./BrokeringSettings";
import type { BrokeringDto } from "../lib/api";

const url = "https://fountain.test/account/bindings";
const on: BrokeringDto = {
  enabled: true,
  environment: true,
  vault: true,
  bindings: [
    { id: "b1", key: "STRIPE_SECRET_KEY", host: "api.stripe.com", auth_type: "bearer", headers: {}, enabled: true },
    { id: "b2", key: "OPENAI_API_KEY", host: "api.openai.com", auth_type: "substitute", headers: {}, enabled: false },
  ],
  secrets: [
    { key: "BUZZ_PRIVATE_KEY", source: "environment", hosts: [] },
    { key: "STRIPE_SECRET_KEY", source: "both", hosts: ["api.stripe.com"] },
  ],
};

describe("the brokering settings", () => {
  test("off: said, with whose decision it is", () => {
    const html = renderToStaticMarkup(<BrokeringPanel dto={{ enabled: false, bindings: [], secrets: [], environment: false, vault: false }} error={null} bindingsUrl={url} />);
    expect(html).toContain("Not on for your account");
    expect(html).not.toContain("Edit bindings");
  });

  test("on: brokered secrets with their hosts, clear ones labelled, the account's bindings behind a fold, and the way to edit them", () => {
    const html = renderToStaticMarkup(<BrokeringPanel dto={on} error={null} bindingsUrl={url} />);
    expect(html).toContain("STRIPE_SECRET_KEY");
    expect(html).toContain("→ api.stripe.com");
    expect(html).toContain("vault (over the environment");
    expect(html).toContain("BUZZ_PRIVATE_KEY");
    expect(html).toContain("in the sandbox in the clear");
    expect(html).toContain("cannot be brokered");
    expect(html).toContain(">off<");
    expect(html).toContain(url);
  });

  test("a project with nothing set holds nothing", () => {
    const html = renderToStaticMarkup(<BrokeringPanel dto={{ ...on, environment: false, vault: false, secrets: [] }} error={null} bindingsUrl={url} />);
    expect(html).toContain("holds no secrets at all");
  });

  test("each auth shape in a phrase", () => {
    const b = { id: "x", key: "K", host: "h", headers: {}, enabled: true };
    expect(shapeOf({ ...b, auth_type: "bearer" })).toBe("Authorization: Bearer …");
    expect(shapeOf({ ...b, auth_type: "basic", username: "x-access-token" })).toBe("basic auth as x-access-token");
    expect(shapeOf({ ...b, auth_type: "api_key", header: "X-Api-Key", prefix: "Token " })).toBe("X-Api-Key: Token …");
    expect(shapeOf({ ...b, auth_type: "custom", headers: { "X-A": "{{ K }}" } })).toBe("X-A");
    expect(shapeOf({ ...b, auth_type: "substitute" })).toMatch(/placeholder/);
  });
});
