import { describe, expect, test } from "bun:test";
import { ApiError } from "../api/client";
import { CONSENT_TEXT, contactOffer, contactSummary, describeContactError, formatPhone, normalizePhone, NOT_CONFIGURED, optOutNotice } from "./contact";

describe("normalizePhone", () => {
  test("mirrors the server: forgiving in, strict E.164 out", () => {
    expect(normalizePhone("+15551234567")).toBe("+15551234567");
    expect(normalizePhone("(555) 123-4567")).toBe("+15551234567");
    expect(normalizePhone("555.123.4567")).toBe("+15551234567");
    expect(normalizePhone("1 555 123 4567")).toBe("+15551234567");
    expect(normalizePhone("+1 (555) 123-4567")).toBe("+15551234567");
    expect(normalizePhone("0044 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
  });
  test("refuses what the server would refuse", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("555-1234")).toBeNull(); // too short, no country code
    expect(normalizePhone("+0123456789")).toBeNull(); // country code can't start with 0
    expect(normalizePhone("7946 0958")).toBeNull(); // not US-shaped, no +
    expect(normalizePhone("+1555123456789012")).toBeNull(); // > 15 digits
    expect(normalizePhone("call me")).toBeNull();
  });
});

describe("formatPhone", () => {
  test("US/CA numbers read like a phone book", () => {
    expect(formatPhone("+15551234567")).toBe("+1 (555) 123-4567");
  });
  test("other countries get the code and groups of four", () => {
    expect(formatPhone("+442079460958")).toBe("+44 2079 4609 58");
    expect(formatPhone("+4915112345678")).toBe("+49 1511 2345 678");
    expect(formatPhone("+358401234567")).toBe("+358 4012 34567"); // never a trailing group of one
  });
  test("passes through what it does not understand", () => {
    expect(formatPhone("ext. 12")).toBe("ext. 12");
    expect(formatPhone(null)).toBe("");
    expect(formatPhone(undefined)).toBe("");
  });
});

describe("contactOffer", () => {
  const none = { contact: null };
  const has = { contact: { email: "a@b.c", phone: "+15551234567", prompt_from_number: "+15557654321", inserted_at: "2026-08-19T00:00:00Z" } };
  test("absent until the server says enabled, and once they have one", () => {
    expect(contactOffer(null, none)).toEqual({ kind: "absent" });
    expect(contactOffer({ enabled: false, configured: true }, none)).toEqual({ kind: "absent" });
    expect(contactOffer({ enabled: true, configured: true }, has)).toEqual({ kind: "absent" });
  });
  test("disabled with the reason when the instance has no keys; offered otherwise", () => {
    expect(contactOffer({ enabled: true, configured: false }, none)).toEqual({ kind: "disabled", reason: NOT_CONFIGURED });
    expect(contactOffer({ enabled: true, configured: true }, none)).toEqual({ kind: "offered" });
  });
});

describe("contactSummary", () => {
  test("names what came back", () => {
    expect(contactSummary("Koda", { email: "koda@agentmail.to", phone: "+15551234567", prompt_from_number: null, inserted_at: "" })).toBe(
      "Koda now has koda@agentmail.to and +1 (555) 123-4567",
    );
    expect(contactSummary("Koda", { email: "koda@agentmail.to", phone: null, prompt_from_number: null, inserted_at: "" })).toBe("Koda now has koda@agentmail.to");
    expect(contactSummary("Koda", null)).toBe("Koda now has an email and phone");
  });
});

describe("consent + opt-out", () => {
  test("the consent statement says who, what, how often, rates, STOP and HELP", () => {
    expect(CONSENT_TEXT).toBe(
      "By entering your number you agree to receive text messages from Fountain — your teammate's replies and occasional notifications — at this number. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out at any time, HELP for help.",
    );
  });
  test("optOutNotice only when STOP was received", () => {
    expect(optOutNotice({ prompt_from_number: "+15557654321", prompt_opted_out_at: null })).toBeNull();
    expect(optOutNotice({ prompt_from_number: "+15557654321" })).toBeNull();
    expect(optOutNotice(null)).toBeNull();
    expect(optOutNotice({ prompt_from_number: "+15557654321", prompt_opted_out_at: "2026-08-19T12:00:00Z" })).toBe(
      "Texts paused — STOP was received from +1 (555) 765-4321; text START to resume, or change the number.",
    );
    expect(optOutNotice({ prompt_from_number: null, prompt_opted_out_at: "2026-08-19T12:00:00Z" })).toBe("Texts paused — STOP was received from your number; text START to resume, or change the number.");
  });
});

describe("describeContactError", () => {
  test("a 422 on the number is a field error, in words", () => {
    const err = new ApiError(422, null, "422 Unprocessable Entity", null, { errors: { prompt_from_number: ["must be a phone number with country code, e.g. +15551234567"] } });
    expect(describeContactError(err)).toEqual({ field: "prompt_from_number", message: "Your phone number must be a phone number with country code, e.g. +15551234567" });
  });
  test("a 422 on something else is a plain message", () => {
    const err = new ApiError(422, null, "422", null, { errors: { agent_id: ["is invalid"] } });
    expect(describeContactError(err)).toEqual({ field: null, message: "agent_id is invalid" });
  });
  test("a provider refusal names the provider", () => {
    expect(describeContactError(new ApiError(502, "provider_error", "HTTP 402: insufficient funds", null, { error: "provider_error", channel: "phone", message: "HTTP 402: insufficient funds" }))).toEqual({
      field: null,
      message: "AgentPhone refused: HTTP 402: insufficient funds",
    });
    expect(describeContactError(new ApiError(502, "provider_error", "boom", null, { channel: "email" })).message).toBe("AgentMail refused: boom");
  });
  test("the gate errors read as the app's own sentences", () => {
    expect(describeContactError(new ApiError(404, "team_comms_not_enabled", "team_comms_not_enabled")).message).toBe("Giving teammates an email and phone is not enabled for this account.");
    expect(describeContactError(new ApiError(503, "team_comms_not_configured", "this instance has no AgentMail/AgentPhone keys configured")).message).toBe(
      "This instance has no AgentMail/AgentPhone keys configured.",
    );
    expect(describeContactError(new ApiError(409, "contact_already_provisioned", "contact_already_provisioned")).message).toBe("They already have an email and phone.");
  });
});
