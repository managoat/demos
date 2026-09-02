import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { FountainClient } from "../api/client";
import type { Teammate } from "../api/types";
import { ContactDialog } from "./ContactDialog";
import { ContactLine } from "./ContactLine";
import { CONSENT_TEXT } from "../lib/contact";

// Render smoke: the dialog says what it buys and what it costs before
// Confirm; the line shows both numbers, formatted, and whose texts arrive.

const client = { baseUrl: "https://fountain.test" } as unknown as FountainClient;
const teammate = {
  agent_id: "a1",
  name: "Koda",
  contact: null,
} as unknown as Teammate;

describe("ContactDialog", () => {
  test("names the teammate, asks for your number, and says it is billed", () => {
    const html = renderToString(<ContactDialog client={client} teammate={teammate} onClose={() => undefined} onProvisioned={() => undefined} toast={() => undefined} />);
    expect(html).toContain('aria-label="Give Koda an email and phone"');
    expect(html).toContain("Your phone number");
    expect(html).toContain('type="tel"');
    expect(html).toContain("required");
    expect(html).toContain("both are billed");
    expect(html).toContain("Texts from any other number are ignored");
    expect(html).toMatch(/Texts from it to (<!-- -->)?Koda/);
    expect(html).toContain("sms_send");
    // nothing typed yet: the submit is disabled
    expect(html).toMatch(/<button type="submit" disabled="">Agree &amp; give email &amp; phone/);
  });

  test("carries the A2P 10DLC consent statement, verbatim, with privacy and terms links on the configured server", () => {
    const html = renderToString(<ContactDialog client={client} teammate={teammate} onClose={() => undefined} onProvisioned={() => undefined} toast={() => undefined} />);
    const consent =
      "By entering your number you agree to receive text messages from Fountain — your teammate&#x27;s replies and occasional notifications — at this number. Message frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out at any time, HELP for help.";
    expect(html).toContain(consent);
    expect(CONSENT_TEXT).toContain("Reply STOP to opt out at any time, HELP for help.");
    expect(html).toContain('<a href="https://fountain.test/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>');
    expect(html).toContain('<a href="https://fountain.test/terms" target="_blank" rel="noreferrer">Terms</a>');
    // normal-size text: the consent paragraph is not in the "small" class
    expect(html).toMatch(/<p class="consent" id="contact-consent">/);
    // the field points at it
    expect(html).toContain('aria-describedby="contact-number-hint contact-consent"');
  });

  test("change mode: same consent, no cost note, 'Agree & change number'", () => {
    const withContact = { ...teammate, contact: { email: "k@agentmail.to", phone: "+15551234567", prompt_from_number: "+15557654321", prompt_opted_out_at: "2026-08-19T12:00:00Z", inserted_at: "" } } as unknown as Teammate;
    const html = renderToString(<ContactDialog client={client} teammate={withContact} mode="change" onClose={() => undefined} onProvisioned={() => undefined} toast={() => undefined} />);
    expect(html).toContain("Reply STOP to opt out at any time, HELP for help.");
    expect(html).toContain("/privacy");
    expect(html).not.toContain("both are billed");
    expect(html).toContain("paused since STOP was received");
    expect(html).toMatch(/<button type="submit" disabled="">Agree &amp; change number/);
  });
});

describe("ContactLine", () => {
  test("shows the email and the formatted numbers with Copy", () => {
    const html = renderToString(<ContactLine contact={{ email: "koda@agentmail.to", phone: "+15551234567", prompt_from_number: "+15557654321", inserted_at: "2026-08-19T00:00:00Z" }} />);
    expect(html).toContain("koda@agentmail.to");
    expect(html).toContain("+1 (555) 123-4567");
    expect(html).toContain("Texts from <span class=\"mono\">+1 (555) 765-4321</span> arrive here as prompts");
    expect(html.match(/>Copy</g)?.length).toBe(2);
  });
  test("says texts are paused after STOP, and offers Change number", () => {
    const html = renderToString(
      <ContactLine contact={{ email: null, phone: "+15551234567", prompt_from_number: "+15557654321", prompt_opted_out_at: "2026-08-19T12:00:00Z", inserted_at: "" }} onChangeNumber={() => undefined} />,
    );
    expect(html).toContain("Texts paused — STOP was received from +1 (555) 765-4321; text START to resume, or change the number.");
    expect(html).not.toContain("arrive here as prompts");
    expect(html).toContain(">Change number…</button>");
  });
  test("leaves out a channel that is null", () => {
    const html = renderToString(<ContactLine contact={{ email: "koda@agentmail.to", phone: null, prompt_from_number: null, inserted_at: "" }} />);
    expect(html).toContain("koda@agentmail.to");
    expect(html).not.toContain("arrive here as prompts");
    expect(html.match(/>Copy</g)?.length).toBe(1);
  });
});
