/**
 * A teammate's own email + phone (Fountain `team_comms`): the pure bits —
 * phone numbers for display and for the form, and the API's refusals as
 * words. The dialog and the header use these; the tests cover them.
 */
import { ApiError, describeError } from "../api/client";
import type { CommsStatus, Contact, Teammate } from "../api/types";

/** The strict shape the server stores and AgentPhone speaks. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * What the server's `Phone.normalize/1` accepts, mirrored so the form can
 * refuse a number before a request: spaces, dashes, dots and parentheses
 * are dropped; a bare 10-digit number is US/CA, an 11-digit one starting
 * with 1 likewise, `00…` is an international prefix; anything else must
 * carry its own `+` country code. Returns E.164 or null.
 */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[\s().-]/g, "");
  let candidate: string;
  if (digits.startsWith("+")) candidate = digits;
  else if (digits.startsWith("00")) candidate = `+${digits.slice(2)}`;
  else if (/^\d{10}$/.test(digits)) candidate = `+1${digits}`;
  else if (/^1\d{10}$/.test(digits)) candidate = `+${digits}`;
  else candidate = digits;
  return E164.test(candidate) ? candidate : null;
}

/**
 * An E.164 number the way people read it: `+1 (555) 123-4567` for US/CA,
 * `+44 20 7946 0958`-ish grouping for the rest (country code, then groups
 * of up to four, never a group of one). Anything that is not E.164 is
 * returned as it came.
 */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  if (!E164.test(e164)) return e164;
  if (/^\+1\d{10}$/.test(e164)) {
    return `+1 (${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
  }
  // Country codes are 1–3 digits; without a table we take the shortest
  // prefix that leaves a sensible national number and group the rest by 4.
  const cc = countryCodeLength(e164);
  const rest = e164.slice(1 + cc);
  const groups: string[] = [];
  for (let i = 0; i < rest.length; i += 4) groups.push(rest.slice(i, i + 4));
  // no trailing group of one
  if (groups.length > 1 && groups[groups.length - 1]!.length === 1) {
    const last = groups.pop()!;
    groups[groups.length - 1] += last;
  }
  return `+${e164.slice(1, 1 + cc)} ${groups.join(" ")}`;
}

/** 1 for the NANP (+1) and Russia/Kazakhstan (+7); 2 for most of Europe and the big Asian codes; 3 otherwise. */
function countryCodeLength(e164: string): number {
  const d = e164.slice(1);
  if (d.startsWith("1") || d.startsWith("7")) return 1;
  const two = d.slice(0, 2);
  const twoDigit = new Set(["20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49", "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98"]);
  return twoDigit.has(two) ? 2 : 3;
}

/** Why the contact affordance is offered, disabled, or absent. */
export type ContactOffer = { kind: "absent" } | { kind: "disabled"; reason: string } | { kind: "offered" };

export const NOT_CONFIGURED = "This instance has no AgentMail/AgentPhone keys configured";

/**
 * The SMS opt-in statement shown wherever a number is entered or changed —
 * the wording A2P 10DLC review expects (who texts, what, frequency, rates,
 * STOP/HELP). Keep verbatim; the dialog follows it with the Privacy Policy
 * and Terms links on the configured Fountain server.
 */
export const CONSENT_TEXT =
  "By entering your number you agree to receive text messages from Fountain — your teammate's replies and occasional notifications — at this number. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out at any time, HELP for help.";

/** "Texts paused — STOP was received from +1 (555) …; text START to resume, or change the number." or null when texts flow. */
export function optOutNotice(contact: Pick<Contact, "prompt_from_number" | "prompt_opted_out_at"> | null | undefined): string | null {
  if (!contact?.prompt_opted_out_at) return null;
  const from = contact.prompt_from_number ? formatPhone(contact.prompt_from_number) : "your number";
  return `Texts paused — STOP was received from ${from}; text START to resume, or change the number.`;
}

/** Whether "Give email & phone…" shows for a teammate, given the instance's answer (null = not asked yet / unknown). */
export function contactOffer(comms: CommsStatus | null, teammate: Pick<Teammate, "contact">): ContactOffer {
  if (!comms || !comms.enabled) return { kind: "absent" };
  if (teammate.contact) return { kind: "absent" };
  if (!comms.configured) return { kind: "disabled", reason: NOT_CONFIGURED };
  return { kind: "offered" };
}

/** "Koda now has koda@agentmail.to and +1 (555) 123-4567" — whichever of the two came back. */
export function contactSummary(name: string, contact: Contact | null | undefined): string {
  const parts = [contact?.email, contact?.phone ? formatPhone(contact.phone) : null].filter((x): x is string => !!x);
  if (!parts.length) return `${name} now has an email and phone`;
  return `${name} now has ${parts.join(" and ")}`;
}

/**
 * A provisioning/release failure as words: `field` is set when the server
 * refused the number itself (422 — nothing was bought), so the form can
 * show it inline; otherwise `message` is for a banner or a toast.
 */
export function describeContactError(err: unknown): { field: "prompt_from_number" | null; message: string } {
  if (err instanceof ApiError) {
    if (err.status === 422) {
      const msgs = err.fieldErrors.prompt_from_number;
      if (msgs?.length) return { field: "prompt_from_number", message: `Your phone number ${msgs.join(", ")}` };
      const all = Object.entries(err.fieldErrors)
        .map(([k, v]) => `${k} ${v.join(", ")}`)
        .join("; ");
      return { field: null, message: all || "Fountain refused the request — check the number." };
    }
    if (err.code === "provider_error") {
      const ch = err.body?.channel;
      const who = ch === "email" ? "AgentMail" : ch === "phone" ? "AgentPhone" : "AgentMail/AgentPhone";
      return { field: null, message: `${who} refused: ${err.message}` };
    }
  }
  return { field: null, message: describeError(err) };
}
