/**
 * The egress section has four honest states — not brokered, brokered and
 * empty, rows, and a broker that would not answer — and the one dishonest
 * state it must never show is an empty list on an unbrokered account, which
 * would read as "the sandbox went nowhere". These pin the four, and that
 * secrets appear by name and a refusal by its reason.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EgressList } from "./EgressSection";
import type { EgressEvent } from "../lib/egress";

const noop = () => undefined;
const render = (p: Partial<Parameters<typeof EgressList>[0]>) =>
  renderToStaticMarkup(<EgressList rows={[]} next={null} brokered={true} error={null} busy={false} stage={null} onMore={noop} onRetry={noop} {...p} />);

const rows: EgressEvent[] = [
  { id: 2, at: "2026-08-25T10:00:00Z", method: "POST", host: "api.stripe.com:443", path: "/v1/charges", service: "stripe", credential_keys: ["STRIPE_SECRET_KEY"], status: 200, latency_ms: 310 },
  { id: 1, at: "2026-08-25T09:59:00Z", method: "GET", host: "evil.example:443", path: "/", service: null, credential_keys: [], status: 403, error: "no_match" },
];

describe("the egress section", () => {
  test("an unbrokered account is told so, not shown an empty log", () => {
    const html = render({ brokered: false });
    expect(html).toContain("Not brokered");
    expect(html).not.toContain("saw no requests");
  });

  test("brokered with nothing seen says that, and that the log is kept for a while", () => {
    expect(render({ rows: [] })).toContain("saw no requests");
  });

  test("rows: per host, then each request, naming the credential and the refusal", () => {
    const html = render({ rows, next: 1, stage: { keys: ["STRIPE_SECRET_KEY"], vault: "c-1", expiresAt: null, failed: null, done: true } });
    expect(html).toContain("withheld from the sandbox");
    expect(html).toContain("STRIPE_SECRET_KEY");
    expect(html).toContain("api.stripe.com:443");
    expect(html).toContain("310 ms");
    expect(html).toContain("not on the environment&#x27;s allowed hosts");
    expect(html).toContain("Earlier requests");
    expect(html).toContain("2+");
  });

  test("a broker that would not answer is an error with a retry, and a failed setup says why", () => {
    expect(render({ error: "The egress broker did not answer." })).toContain("Try again");
    expect(render({ stage: { keys: [], vault: null, expiresAt: null, failed: "broker_unreachable", done: false } })).toContain("did not answer");
  });
});
