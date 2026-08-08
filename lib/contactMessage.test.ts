// Contact Us: validation (pure) and sendContactEmail (Resend, mocked --
// "resend" is mocked at the module level so no real network call is
// reachable). Run with --experimental-test-module-mocks (see package.json).
process.env.RESEND_API_KEY = "test-resend-key";
process.env.RESEND_FROM_EMAIL = "notifications@scheduleflowtrack.com";
process.env.RESEND_FROM_NAME = "FlowTrack Schedule";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

let sendCalls: Array<Record<string, unknown>> = [];
let sendResult: { data: unknown; error: unknown } = { data: { id: "email-1" }, error: null };

mock.module("resend", {
  namedExports: {
    Resend: class {
      emails = {
        send: async (params: Record<string, unknown>) => {
          sendCalls.push(params);
          return sendResult;
        },
      };
    },
  },
});

const { validateContactSubmission, sendContactEmail, CONTACT_FIELD_LIMITS } = await import("./contactMessage.ts");

function resetState() {
  sendCalls = [];
  sendResult = { data: { id: "email-1" }, error: null };
}

const VALID = {
  name: "Jamie Rivera",
  email: "jamie@example.com",
  company: "Rivera Cleaning Co",
  subject: "Question about billing",
  message: "Hi, I had a question about my monthly invoice.",
};

describe("validateContactSubmission -- required fields", () => {
  test("accepts a fully valid submission, normalizing email to lowercase and trimming every field", () => {
    const result = validateContactSubmission({ ...VALID, name: "  Jamie Rivera  ", email: "  Jamie@Example.com  " });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.name, "Jamie Rivera");
      assert.equal(result.data.email, "jamie@example.com");
      assert.equal(result.data.company, "Rivera Cleaning Co");
    }
  });

  test("company is optional -- omitted entirely still validates, normalized to null", () => {
    const { company, ...withoutCompany } = VALID;
    const result = validateContactSubmission(withoutCompany);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.company, null);
  });

  test("a blank company (whitespace only) also normalizes to null", () => {
    const result = validateContactSubmission({ ...VALID, company: "   " });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.company, null);
  });

  test("rejects a missing/blank name", () => {
    const result = validateContactSubmission({ ...VALID, name: "   " });
    assert.equal(result.ok, false);
  });

  test("rejects a missing/blank subject", () => {
    const result = validateContactSubmission({ ...VALID, subject: "" });
    assert.equal(result.ok, false);
  });

  test("rejects a missing/blank message", () => {
    const result = validateContactSubmission({ ...VALID, message: "  " });
    assert.equal(result.ok, false);
  });

  test("rejects a missing/invalid email", () => {
    for (const bad of ["", "not-an-email", "missing-domain@", "@missing-local.com"]) {
      const result = validateContactSubmission({ ...VALID, email: bad });
      assert.equal(result.ok, false, `expected "${bad}" to be rejected`);
    }
  });

  test("tolerates a completely malformed body (null, undefined, non-object) without throwing", () => {
    for (const bad of [null, undefined, "a string", 42, []]) {
      const result = validateContactSubmission(bad);
      assert.equal(result.ok, false);
    }
  });
});

describe("validateContactSubmission -- field length limits", () => {
  test("rejects a name longer than the limit", () => {
    const result = validateContactSubmission({ ...VALID, name: "a".repeat(CONTACT_FIELD_LIMITS.name + 1) });
    assert.equal(result.ok, false);
  });

  test("accepts a name exactly at the limit", () => {
    const result = validateContactSubmission({ ...VALID, name: "a".repeat(CONTACT_FIELD_LIMITS.name) });
    assert.equal(result.ok, true);
  });

  test("rejects a company longer than the limit", () => {
    const result = validateContactSubmission({ ...VALID, company: "a".repeat(CONTACT_FIELD_LIMITS.company + 1) });
    assert.equal(result.ok, false);
  });

  test("rejects a subject longer than the limit", () => {
    const result = validateContactSubmission({ ...VALID, subject: "a".repeat(CONTACT_FIELD_LIMITS.subject + 1) });
    assert.equal(result.ok, false);
  });

  test("rejects a message longer than the limit", () => {
    const result = validateContactSubmission({ ...VALID, message: "a".repeat(CONTACT_FIELD_LIMITS.message + 1) });
    assert.equal(result.ok, false);
  });

  test("rejects an oversized email even if it happens to match the email regex", () => {
    const longLocal = "a".repeat(CONTACT_FIELD_LIMITS.email);
    const result = validateContactSubmission({ ...VALID, email: `${longLocal}@example.com` });
    assert.equal(result.ok, false);
  });
});

describe("sendContactEmail -- fixed recipient/sender, visitor email only ever used as replyTo", () => {
  test("sends to the fixed SUPPORT_EMAIL address, never anything from the submission", async () => {
    resetState();
    await sendContactEmail({ ...VALID, company: null });
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].to, "support@scheduleflowtrack.com");
  });

  test("from is built from RESEND_FROM_NAME/RESEND_FROM_EMAIL env vars, never visitor input", async () => {
    resetState();
    await sendContactEmail({ ...VALID, company: null });
    assert.equal(sendCalls[0].from, "FlowTrack Schedule <notifications@scheduleflowtrack.com>");
  });

  test("replyTo is set to the visitor's validated email", async () => {
    resetState();
    await sendContactEmail({ ...VALID, company: null });
    assert.equal(sendCalls[0].replyTo, "jamie@example.com");
  });

  test("the visitor's name, email, company, subject, and message all appear in the email body", async () => {
    resetState();
    await sendContactEmail(VALID);
    const text = sendCalls[0].text as string;
    assert.ok(text.includes(VALID.name));
    assert.ok(text.includes(VALID.email));
    assert.ok(text.includes(VALID.company));
    assert.ok(text.includes(VALID.subject));
    assert.ok(text.includes(VALID.message));
  });

  test("company is omitted from the email body entirely when not provided, not rendered as 'Company: null'", async () => {
    resetState();
    await sendContactEmail({ ...VALID, company: null });
    const text = sendCalls[0].text as string;
    assert.ok(!text.includes("Company:"));
    assert.ok(!text.includes("null"));
  });

  test("the subject line is prefixed so it's identifiable in the support inbox", async () => {
    resetState();
    await sendContactEmail(VALID);
    assert.equal(sendCalls[0].subject, `[Contact Us] ${VALID.subject}`);
  });

  test("a Resend API-level error (returned, not thrown) is converted into a thrown error -- never silently swallowed", async () => {
    resetState();
    sendResult = { data: null, error: { message: "invalid API key" } };
    await assert.rejects(() => sendContactEmail(VALID));
  });
});
