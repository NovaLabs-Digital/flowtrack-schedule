import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildInvoiceEmailPrefill, validateInvoiceEmail, invoiceSendState, toSendAttempt, SEND_STATE_LABEL, SENDING_STALE_MS } from "./invoiceEmail.ts";

const INV = {
  invoice_number: "13485", business_name: "ACS Cleaning", bill_to_name: "Pat Example", bill_to_email: "billing@example.test",
  total_cents: 13845, terms: "due_on_receipt", due_date: "2026-11-13", payment_instructions: null as string | null,
};

describe("Review & Send prefill", () => {
  test("the client's email, 'Invoice <number> from <business>', and a short message with total and due date", () => {
    const p = buildInvoiceEmailPrefill(INV, "pat@example.test");
    assert.equal(p.to, "pat@example.test");
    assert.equal(p.subject, "Invoice 13485 from ACS Cleaning");
    assert.equal(p.message, "Hi Pat,\n\nAttached is invoice 13485 for $138.45, due on receipt.\n\nThank you for your business.\nACS Cleaning");
  });

  test("no client email: the email printed on the invoice; neither: blank for the owner to fill in", () => {
    assert.equal(buildInvoiceEmailPrefill(INV, null).to, "billing@example.test");
    assert.equal(buildInvoiceEmailPrefill(INV, "  ").to, "billing@example.test");
    assert.equal(buildInvoiceEmailPrefill({ ...INV, bill_to_email: null }, null).to, "");
  });

  test("net terms show the due date; the invoice's payment instructions are included", () => {
    const p = buildInvoiceEmailPrefill({ ...INV, terms: "net_15", due_date: "2026-11-28", payment_instructions: "Zelle to pay@acs.example", total_cents: 123456 }, null);
    assert.equal(p.message, "Hi Pat,\n\nAttached is invoice 13485 for $1,234.56, due 11/28/2026.\n\nZelle to pay@acs.example\n\nThank you for your business.\nACS Cleaning");
  });
});

describe("Review & Send checks (same rules as the database)", () => {
  test("one plain address, a one-line subject, and a message", () => {
    assert.deepEqual(validateInvoiceEmail({ to: " pat@example.test ", subject: " Invoice ", message: "Hi\r\nthere " }), { ok: true, value: { to: "pat@example.test", subject: "Invoice", message: "Hi\nthere" } });
    for (const to of ["", "pat", "pat@example", "a@b.co, c@d.co", "Pat <pat@example.test>", "pat @example.test", `${"a".repeat(250)}@b.co`]) {
      const v = validateInvoiceEmail({ to, subject: "s", message: "m" });
      assert.equal(v.ok ? "" : v.field, "to", to);
    }
    for (const subject of ["", "  ", "a\nBcc: x@y.z", "x".repeat(201)]) {
      const v = validateInvoiceEmail({ to: "pat@example.test", subject, message: "m" });
      assert.equal(v.ok ? "" : v.field, "subject", JSON.stringify(subject));
    }
    for (const message of ["", "   ", "x".repeat(10001)]) {
      const v = validateInvoiceEmail({ to: "pat@example.test", subject: "s", message });
      assert.equal(v.ok ? "" : v.field, "message");
    }
    assert.equal(validateInvoiceEmail(null).ok, false);
  });
});

describe("How a send attempt reads", () => {
  const now = Date.parse("2026-11-13T15:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  test("in flight, sent, failed, switched off, and unknown outcomes", () => {
    assert.equal(invoiceSendState("sending", ago(1000), now), "sending");
    assert.equal(invoiceSendState("sending", ago(SENDING_STALE_MS), now), "uncertain", "stuck in flight = unknown outcome");
    assert.equal(invoiceSendState("unconfirmed", ago(0), now), "uncertain");
    assert.equal(invoiceSendState("failed", ago(0), now), "failed");
    assert.equal(invoiceSendState("disabled", ago(0), now), "disabled");
    assert.equal(invoiceSendState("4ef9a417-02e9-4d39-ad75-9611e0fcc33c", ago(0), now), "sent");
    assert.equal(invoiceSendState("resend", ago(0), now), "uncertain", "never a false Sent");
    assert.equal(invoiceSendState(null, ago(0), now), "uncertain");
  });
  test("labels", () => {
    assert.equal(SEND_STATE_LABEL.sent, "Sent — delivery unconfirmed");
    assert.equal(SEND_STATE_LABEL.failed, "Failed");
    assert.equal(SEND_STATE_LABEL.uncertain, "Outcome unknown — not confirmed");
    assert.deepEqual(
      toSendAttempt({ id: "m1", provider_id: "failed", to_value: "pat@example.test", subject: "Invoice", created_at: ago(0) }, now),
      { id: "m1", state: "failed", label: "Failed", to: "pat@example.test", subject: "Invoice", created_at: ago(0) });
  });
});
