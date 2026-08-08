// Route-level tests for app/api/contact/route.ts. @/lib/durableRateLimit
// and @/lib/contactMessage are mocked in-process. No real Supabase/Resend/
// network call is reachable. Run with --experimental-test-module-mocks
// (see package.json).

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

let rateLimitCalls: Array<{ bucket: string; key: string }> = [];
let rateLimitResult: { limited: boolean; retryAfterSeconds?: number } = { limited: false };
let validateImpl: (body: unknown) => { ok: true; data: Record<string, unknown> } | { ok: false; error: string };
let sendCalls: Array<Record<string, unknown>> = [];
let sendShouldThrow: Error | null = null;

mock.module("@/lib/durableRateLimit", {
  namedExports: {
    checkAndRecordRateLimit: (bucket: string, key: string) => {
      rateLimitCalls.push({ bucket, key });
      return Promise.resolve(rateLimitResult);
    },
  },
});
mock.module("@/lib/contactMessage", {
  namedExports: {
    validateContactSubmission: (body: unknown) => validateImpl(body),
    sendContactEmail: async (data: Record<string, unknown>) => {
      sendCalls.push(data);
      if (sendShouldThrow) throw sendShouldThrow;
    },
    CONTACT_FIELD_LIMITS: { name: 100, email: 254, company: 150, subject: 150, message: 5000 },
  },
});

const { POST } = await import("./route.ts");

const VALID_DATA = {
  name: "Jamie Rivera",
  email: "jamie@example.com",
  company: "Rivera Cleaning Co",
  subject: "Question about billing",
  message: "Hi, I had a question about my monthly invoice.",
};

function resetState() {
  rateLimitCalls = [];
  rateLimitResult = { limited: false };
  sendCalls = [];
  sendShouldThrow = null;
  // Mirrors the real validateContactSubmission's whitelist behavior: only
  // the 5 known fields are ever extracted onto `data` -- any other key on
  // the raw body (to/recipient/cc/bcc/etc.) is never carried through.
  validateImpl = (body) => {
    const b = (body ?? {}) as Record<string, unknown>;
    if (!b.name || !b.email || !b.subject || !b.message) {
      return { ok: false, error: "Missing required field." };
    }
    return {
      ok: true,
      data: {
        name: b.name,
        email: b.email,
        company: (b.company as string) || null,
        subject: b.subject,
        message: b.message,
      },
    };
  };
}

function req(body: unknown, ip = "203.0.113.30", headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  return new Request("http://localhost/api/contact", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, "content-length": String(Buffer.byteLength(payload)), ...headers },
    body: payload,
  });
}

describe("POST /api/contact -- valid submission", () => {
  test("a valid submission sends the email and returns ok:true", async () => {
    resetState();
    const res = await POST(req(VALID_DATA));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(sendCalls.length, 1);
  });

  test("uses the durable 'contact' rate-limit bucket, keyed by IP, checked before validation/send", async () => {
    resetState();
    await POST(req(VALID_DATA, "203.0.113.31"));
    assert.equal(rateLimitCalls.length, 1);
    assert.equal(rateLimitCalls[0].bucket, "contact");
    assert.equal(rateLimitCalls[0].key, "203.0.113.31");
  });
});

describe("POST /api/contact -- rate limiting", () => {
  test("a limited result returns 429 before validation or send are ever reached", async () => {
    resetState();
    rateLimitResult = { limited: true, retryAfterSeconds: 900 };
    const res = await POST(req(VALID_DATA));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Retry-After"), "900");
    assert.equal(sendCalls.length, 0);
  });
});

describe("POST /api/contact -- validation", () => {
  test("missing required fields -> 400 with the validator's own message, no send attempted", async () => {
    resetState();
    const res = await POST(req({ name: "", email: "", subject: "", message: "" }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "Missing required field.");
    assert.equal(sendCalls.length, 0);
  });

  test("an invalid email is rejected by the real validator wiring (400), never sent", async () => {
    resetState();
    validateImpl = () => ({ ok: false, error: "Please enter a valid email address." });
    const res = await POST(req({ ...VALID_DATA, email: "not-an-email" }));
    assert.equal(res.status, 400);
    assert.equal(sendCalls.length, 0);
  });

  test("an oversized field is rejected by the validator (400), never sent", async () => {
    resetState();
    validateImpl = () => ({ ok: false, error: "Message must be 5000 characters or fewer." });
    const res = await POST(req({ ...VALID_DATA, message: "a".repeat(6000) }));
    assert.equal(res.status, 400);
    assert.equal(sendCalls.length, 0);
  });
});

describe("POST /api/contact -- recipient cannot be controlled by visitor input", () => {
  test("a body claiming to override the recipient (to/recipient/cc/bcc fields) has no effect -- the route never reads them, sendContactEmail only ever receives validator-derived data", async () => {
    resetState();
    const res = await POST(
      req({
        ...VALID_DATA,
        to: "attacker@evil.com",
        recipient: "attacker@evil.com",
        cc: "attacker@evil.com",
        bcc: "attacker@evil.com",
      })
    );
    assert.equal(res.status, 200);
    assert.equal(sendCalls.length, 1);
    const sentData = sendCalls[0];
    assert.ok(!("to" in sentData) || sentData.to === undefined);
    // The validator-derived data object is exactly what's passed through --
    // no additional attacker-supplied keys are merged in by the route itself.
    assert.deepEqual(Object.keys(sentData).sort(), Object.keys(VALID_DATA).sort());
  });
});

describe("POST /api/contact -- honeypot (bot/spam protection)", () => {
  test("a filled honeypot 'website' field returns the identical ok:true success response, but never sends", async () => {
    resetState();
    const res = await POST(req({ ...VALID_DATA, website: "http://spam.example.com" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(sendCalls.length, 0);
  });

  test("an empty/whitespace-only honeypot is treated as a real, empty submission -- normal validation still applies", async () => {
    resetState();
    const res = await POST(req({ ...VALID_DATA, website: "   " }));
    assert.equal(res.status, 200);
    assert.equal(sendCalls.length, 1);
  });

  test("no honeypot field at all is the normal case -- unaffected", async () => {
    resetState();
    const res = await POST(req(VALID_DATA));
    assert.equal(res.status, 200);
    assert.equal(sendCalls.length, 1);
  });
});

describe("POST /api/contact -- provider/send failure handled safely", () => {
  test("a thrown send error returns a generic 500 message, never the underlying error text", async () => {
    resetState();
    sendShouldThrow = new Error("Resend API key abc123secret is invalid");
    const res = await POST(req(VALID_DATA));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(!body.error.includes("abc123secret"), "must never leak the underlying provider error text");
    assert.ok(!body.error.toLowerCase().includes("resend"), "must never name the provider");
  });

  test("a send failure with a config-missing error is also handled generically", async () => {
    resetState();
    sendShouldThrow = new Error("CONTACT_EMAIL_CONFIG_MISSING");
    const res = await POST(req(VALID_DATA));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(!body.error.includes("CONTACT_EMAIL_CONFIG_MISSING"));
  });
});

describe("POST /api/contact -- request-size guard", () => {
  test("a request whose declared Content-Length exceeds the cap is rejected with 413 before parsing/sending", async () => {
    resetState();
    const res = await POST(req(VALID_DATA, "203.0.113.32", { "content-length": "9999999" }));
    assert.equal(res.status, 413);
    assert.equal(sendCalls.length, 0);
  });
});

describe("POST /api/contact -- malformed request body", () => {
  test("a non-JSON body is treated as an empty object, not a crash -- fails validation cleanly", async () => {
    resetState();
    const res = await POST(
      new Request("http://localhost/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.33" },
        body: "not valid json{{{",
      })
    );
    assert.equal(res.status, 400);
    assert.equal(sendCalls.length, 0);
  });
});
