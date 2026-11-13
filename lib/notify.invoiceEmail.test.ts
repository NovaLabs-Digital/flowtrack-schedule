process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.TWILIO_ACCOUNT_SID = "ACtestaccountsidtestaccountsidtest";
process.env.TWILIO_AUTH_TOKEN = "test-twilio-auth-token";
process.env.TWILIO_FROM_NUMBER = "+15555550100";
process.env.RESEND_API_KEY = "test-resend-api-key";
process.env.RESEND_FROM_EMAIL = "invoices@example.com";

// sendInvoiceEmail (Review & Send): what it sends and how strictly it reads
// the answer. Only the Resend SDK is faked.
import { test, describe, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin } from "./testSupport.ts";

const fake = createFakeSupabaseAdmin({});
let calls: { payload: any; opts: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
let reply: () => Promise<{ data: unknown; error: unknown }> = async () => ({ data: { id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }, error: null });
mock.module("@/lib/supabaseAdmin", { namedExports: { supabaseAdmin: { from: (t: string) => fake.supabaseAdmin.from(t) } } });
class FakeResend {
  emails = { send: (payload: unknown, opts: unknown) => { calls.push({ payload, opts }); return reply(); } };
}
mock.module("resend", { namedExports: { Resend: FakeResend } });
const { sendInvoiceEmail } = await import("./notify.ts");

const PDF = Buffer.from("%PDF-1.7\nexample\n%%EOF\n");
const base = {
  to: "pat@example.test", subject: "Invoice 13485 from ACS Cleaning", text: "Hi Pat", fromDisplayName: "ACS <Cleaning>\r\n",
  replyTo: "office@acs.example", attachment: { filename: "Invoice-13485.pdf", content: PDF }, idempotencyKey: "req-1",
};

beforeEach(() => {
  calls = [];
  reply = async () => ({ data: { id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }, error: null });
  delete process.env.INVOICE_EMAIL_TIMEOUT_MS;
});

describe("sendInvoiceEmail", () => {
  test("sends one email: sanitized From name, Reply-To, the PDF as a base64 attachment, and the idempotency key", async () => {
    const r = await sendInvoiceEmail(base);
    assert.deepEqual(r, { outcome: "accepted", providerId: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].opts, { idempotencyKey: "req-1" });
    assert.equal(calls[0].payload.from, "ACS Cleaning <invoices@example.com>");
    assert.equal(calls[0].payload.replyTo, "office@acs.example");
    assert.deepEqual(calls[0].payload.attachments, [{ filename: "Invoice-13485.pdf", content: PDF.toString("base64"), contentType: "application/pdf" }]);
  });

  test("an invalid Reply-To is left out rather than sent", async () => {
    await sendInvoiceEmail({ ...base, replyTo: "not an email" });
    assert.equal("replyTo" in calls[0].payload, false);
  });

  test("a 4xx rejection is a confirmed failure", async () => {
    for (const statusCode of [400, 401, 403, 422, 429]) {
      reply = async () => ({ data: null, error: { statusCode, name: "validation_error", message: `no (${statusCode})` } });
      assert.deepEqual(await sendInvoiceEmail(base), { outcome: "failed", reason: `no (${statusCode})` });
    }
  });

  test("network errors, 5xx, idempotency conflicts, a missing id, a thrown error or a timeout are an unknown outcome -- never Failed or Sent", async () => {
    const cases: (() => Promise<{ data: unknown; error: unknown }>)[] = [
      async () => ({ data: null, error: { statusCode: null, name: "application_error", message: "Unable to fetch data." } }),
      async () => ({ data: null, error: { statusCode: 500, name: "application_error", message: "Internal server error" } }),
      async () => ({ data: null, error: { statusCode: 409, name: "concurrent_idempotent_requests", message: "in progress" } }),
      async () => ({ data: {}, error: null }),
      async () => ({ data: { id: "resend" }, error: null }),
      async () => { throw new Error("socket hang up"); },
    ];
    for (const c of cases) {
      reply = c;
      assert.equal((await sendInvoiceEmail(base)).outcome, "uncertain");
    }
    process.env.INVOICE_EMAIL_TIMEOUT_MS = "50";
    reply = () => new Promise(() => {});
    assert.deepEqual(await sendInvoiceEmail(base), { outcome: "uncertain", reason: "no answer from the email service in time" });
  });
});
