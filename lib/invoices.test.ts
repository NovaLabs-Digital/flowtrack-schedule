import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import {
  addCalendarDays,
  buildInvoicePrefill,
  dueDateFor,
  formatBusinessAddress,
  invoicePdfFileName,
  isCalendarDate,
  lineAmountCents,
  normalizeDraftFields,
  reissueFields,
  DEFAULT_NOTE_TO_CLIENT,
  type InvoiceDraftFields,
} from "./invoices.ts";
import { issueInvoiceWithRetry, type IssueDeps } from "./invoiceIssue.ts";
import { renderInvoicePdf, formatUsd, formatInvoiceDate, type InvoiceRenderSnapshot } from "./invoicePdf.ts";

const FIELDS: InvoiceDraftFields = {
  business_name: "ACS Cleaning", business_address: "1 Main St", business_phone: null, business_email: null,
  bill_to_name: "Client A", bill_to_address: null, bill_to_email: null,
  terms: "due_on_receipt", invoice_date: "2026-11-12", due_date: "2026-11-12", service_date: "2026-11-10",
  product_service: "Recurring Cleaning", description: null, quantity: 1, rate_cents: 15000,
  payment_instructions: null, note_to_client: "Thank you for your business.",
};

describe("dates and terms", () => {
  test("calendar dates are validated for real days", () => {
    assert.equal(isCalendarDate("2026-02-28"), true);
    assert.equal(isCalendarDate("2026-02-30"), false);
    assert.equal(isCalendarDate("2026-2-3"), false);
    assert.equal(isCalendarDate(null), false);
  });
  test("due dates follow the terms, across month and year ends", () => {
    assert.equal(dueDateFor("2026-11-12", "due_on_receipt"), "2026-11-12");
    assert.equal(dueDateFor("2026-11-20", "net_15"), "2026-12-05");
    assert.equal(dueDateFor("2026-12-15", "net_30"), "2027-01-14");
    assert.equal(addCalendarDays("2028-02-28", 1), "2028-02-29");
  });
});

describe("line amount", () => {
  test("Qty x Rate, rounded to the cent exactly like the database", () => {
    assert.equal(lineAmountCents(1, 15000), 15000);
    assert.equal(lineAmountCents(2.5, 6400), 16000);
    assert.equal(lineAmountCents(1.33, 3333), 4433); // 4432.89 -> 4433
    assert.equal(lineAmountCents(0.1, 5), 1); // 0.5 -> 1 (half up, as PostgreSQL rounds numeric)
  });
});

describe("normalizeDraftFields", () => {
  test("trims text, turns blank optional text into null, keeps 2-decimal quantities", () => {
    const r = normalizeDraftFields({ ...FIELDS, bill_to_name: "  Client A ", description: "   ", quantity: 1.5 });
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.fields.bill_to_name, "Client A");
      assert.equal(r.fields.description, null);
      assert.equal(r.fields.quantity, 1.5);
    }
  });
  test("refuses missing names, bad terms, bad dates, a due date before the invoice date, and bad amounts", () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ business_name: " " }, /Business name is required/],
      [{ bill_to_name: "" }, /Bill to is required/],
      [{ product_service: "" }, /Product\/service is required/],
      [{ terms: "net_60" }, /terms/],
      [{ invoice_date: "2026-13-01" }, /Invoice date/],
      [{ due_date: "2026-11-01" }, /before the invoice date/],
      [{ quantity: 0 }, /Qty/],
      [{ quantity: 1.234 }, /Qty/],
      [{ rate_cents: 10.5 }, /Rate/],
      [{ rate_cents: -1 }, /Rate/],
      [{ description: 5 }, /Invalid description/],
    ];
    for (const [patch, re] of bad) {
      const r = normalizeDraftFields({ ...FIELDS, ...patch });
      assert.equal(r.ok, false, JSON.stringify(patch));
      if (!r.ok) assert.match(r.error, re);
    }
    assert.equal(normalizeDraftFields(null).ok, false);
  });
});

describe("prefill", () => {
  const appointment = { service_type: " Recurring Cleaning ", scheduled_for: "2026-11-11T02:30:00.000Z", price_cents: 15000 };
  const client = { name: "Client A", address: "2 Oak Ave", email: " " };
  const company = { company_name: "ACS Cleaning", address: "1 Main St", city: "Springfield", state: "IL", zip: "62701", phone: "555-0100", email: null };

  test("starts from the job, the client and Settings -> Company; the job price becomes the rate", () => {
    const f = buildInvoicePrefill({ appointment, client, company, previous: null, today: "2026-11-12", timezone: "America/New_York" });
    assert.equal(f.business_name, "ACS Cleaning");
    assert.equal(f.business_address, "1 Main St\nSpringfield, IL 62701");
    assert.equal(f.bill_to_email, null);
    assert.equal(f.service_date, "2026-11-10", "the business-local service date, not the UTC one");
    assert.equal(f.product_service, "Recurring Cleaning");
    assert.deepEqual([f.quantity, f.rate_cents, f.terms, f.invoice_date, f.due_date], [1, 15000, "due_on_receipt", "2026-11-12", "2026-11-12"]);
    assert.equal(f.note_to_client, DEFAULT_NOTE_TO_CLIENT);
  });
  test("reuses the last issued invoice's payment instructions and note; no price means a $0 rate to fill in", () => {
    const f = buildInvoicePrefill({
      appointment: { ...appointment, price_cents: null }, client, company,
      previous: { payment_instructions: "Zelle to 555-0100", note_to_client: "Thanks!" }, today: "2026-11-12", timezone: "America/New_York",
    });
    assert.deepEqual([f.payment_instructions, f.note_to_client, f.rate_cents], ["Zelle to 555-0100", "Thanks!", 0]);
  });
  test("no company settings leaves the business name blank (the route asks the owner to add it)", () => {
    assert.equal(buildInvoicePrefill({ appointment, client, company: null, previous: null, today: "2026-11-12", timezone: "America/New_York" }).business_name, "");
    assert.equal(formatBusinessAddress({ city: "Springfield", zip: "62701" }), "Springfield, 62701");
    assert.equal(formatBusinessAddress({}), null);
  });
  test("a reissue keeps the voided invoice's details, dated today with the due date recomputed", () => {
    const r = reissueFields({ ...FIELDS, terms: "net_15", invoice_date: "2026-10-01", due_date: "2026-10-16", rate_cents: 16000 }, "2026-11-12");
    assert.deepEqual([r.invoice_date, r.due_date, r.rate_cents], ["2026-11-12", "2026-11-27", 16000]);
  });
  test("PDF file name is the invoice number", () => {
    assert.equal(invoicePdfFileName("SFT-1003"), "SFT-1003.pdf");
  });
});

// ---------------------------------------------------------------------------
// Issue with retry (fake database)
// ---------------------------------------------------------------------------

function fakeDb(script: { inputs: Record<string, unknown>[]; issues: Record<string, unknown>[] }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rendered: string[] = [];
  const deps: IssueDeps = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      const next = fn === "invoice_render_input" ? script.inputs.shift() : script.issues.shift();
      if (!next) throw new Error(`unexpected ${fn}`);
      return { data: next, error: null };
    },
    render: async (s) => {
      rendered.push(s.invoice_number);
      return new TextEncoder().encode(`%PDF-${s.invoice_number}`);
    },
  };
  return { deps, calls, rendered };
}
const input = (number: string, revision = 1) => ({ outcome: "ok", revision, invoice_number: number, render_snapshot: { invoice_number: number, revision } });

describe("issueInvoiceWithRetry", () => {
  test("the number moved while rendering: re-renders with the new number and issues it", async () => {
    const db = fakeDb({
      inputs: [input("SFT-1001"), input("SFT-1002")],
      issues: [{ outcome: "number_changed", invoice_number: "SFT-1002" }, { outcome: "issued", invoice_number: "SFT-1002" }],
    });
    const r = await issueInvoiceWithRetry(db.deps, "ws", "inv", 1);
    assert.deepEqual(r, { kind: "issued", invoiceNumber: "SFT-1002" });
    assert.deepEqual(db.rendered, ["SFT-1001", "SFT-1002"]);
    const lastIssue = db.calls.filter((c) => c.fn === "issue_invoice").at(-1)!.args;
    assert.equal(lastIssue.p_invoice_number, "SFT-1002");
    assert.equal(Buffer.from(String(lastIssue.p_pdf_base64), "base64").toString(), "%PDF-SFT-1002", "the PDF sent is the one rendered with the number sent");
  });

  test("the draft changed after the owner reviewed it: stops before rendering, nothing is issued", async () => {
    const db = fakeDb({ inputs: [input("SFT-1001", 2)], issues: [] });
    assert.deepEqual(await issueInvoiceWithRetry(db.deps, "ws", "inv", 1), { kind: "draft_changed", revision: 2 });
    assert.deepEqual(db.rendered, []);
    assert.equal(db.calls.filter((c) => c.fn === "issue_invoice").length, 0);
  });

  test("the draft changed while rendering (stale_revision): returns draft_changed without retrying", async () => {
    const db = fakeDb({ inputs: [input("SFT-1001", 1)], issues: [{ outcome: "stale_revision", revision: 2 }] });
    assert.deepEqual(await issueInvoiceWithRetry(db.deps, "ws", "inv", 1), { kind: "draft_changed", revision: 2 });
    assert.equal(db.calls.length, 2);
  });

  test("already issued by an earlier click: returns that invoice", async () => {
    const db = fakeDb({ inputs: [{ outcome: "not_draft", status: "issued", invoice_number: "SFT-1001" }], issues: [] });
    assert.deepEqual(await issueInvoiceWithRetry(db.deps, "ws", "inv", 1), { kind: "already_issued", invoiceNumber: "SFT-1001" });
  });

  test("refusals pass through; a refused PDF is an error; endless number changes give up as busy", async () => {
    let db = fakeDb({ inputs: [input("SFT-1001")], issues: [{ outcome: "job_has_invoice_number", invoice_number: "13484" }] });
    assert.deepEqual(await issueInvoiceWithRetry(db.deps, "ws", "inv", 1), { kind: "refused", outcome: "job_has_invoice_number", invoiceNumber: "13484" });
    db = fakeDb({ inputs: [input("SFT-1001")], issues: [{ outcome: "pdf_invalid" }] });
    await assert.rejects(issueInvoiceWithRetry(db.deps, "ws", "inv", 1), /pdf_invalid/);
    db = fakeDb({
      inputs: [input("SFT-1"), input("SFT-2"), input("SFT-3")],
      issues: [{ outcome: "number_changed" }, { outcome: "number_changed" }, { outcome: "number_changed" }],
    });
    assert.deepEqual(await issueInvoiceWithRetry(db.deps, "ws", "inv", 1, 3), { kind: "busy" });
  });
});

// ---------------------------------------------------------------------------
// Interim PDF renderer (Step 3 replaces the layout, not this contract)
// ---------------------------------------------------------------------------

const SNAPSHOT: InvoiceRenderSnapshot = {
  invoice_id: "00000000-0000-4000-8000-000000000001", revision: 2, invoice_number: "SFT-1001",
  business_name: "ACS Cleaning", business_address: "1 Main St\nSpringfield, IL 62701", business_phone: "555-0100", business_email: null,
  bill_to_name: "Client A", bill_to_address: "2 Oak Ave", bill_to_email: "a@example.test",
  terms: "net_15", invoice_date: "2026-11-12", due_date: "2026-11-27", service_date: "2026-11-10",
  product_service: "Recurring Cleaning", description: "Biweekly — kitchen + baths", quantity: "1.00", rate_cents: 16000,
  amount_cents: 16000, subtotal_cents: 16000, total_cents: 16000, balance_due_cents: 16000,
  payment_instructions: "Zelle", note_to_client: "Thank you for your business.",
};

describe("renderInvoicePdf (interim layout)", () => {
  test("produces a one-page PDF titled with the invoice number", async () => {
    const bytes = await renderInvoicePdf(SNAPSHOT);
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), "%PDF-");
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    assert.equal(doc.getPageCount(), 1);
    assert.equal(doc.getTitle(), "Invoice SFT-1001");
  });
  test("is deterministic: the same snapshot gives the same bytes; a different number gives different bytes", async () => {
    const a = Buffer.from(await renderInvoicePdf(SNAPSHOT));
    const b = Buffer.from(await renderInvoicePdf({ ...SNAPSHOT }));
    assert.ok(a.equals(b));
    const c = Buffer.from(await renderInvoicePdf({ ...SNAPSHOT, invoice_number: "SFT-1002" }));
    assert.ok(!a.equals(c));
  });
  test("money and dates print in QuickBooks style", () => {
    assert.equal(formatUsd(160000), "$1,600.00");
    assert.equal(formatUsd(5), "$0.05");
    assert.equal(formatInvoiceDate("2026-11-12"), "11/12/2026");
  });
});
