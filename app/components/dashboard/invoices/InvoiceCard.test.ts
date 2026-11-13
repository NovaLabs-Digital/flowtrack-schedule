// RENDERED verification of the Invoice card (Appointment Details) and the
// shared InvoiceDialog -- the REAL components in jsdom with real user-event
// interaction. Only the network is faked: each request is answered by a
// scripted handler, and every request is recorded.
import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import "../../../../lib/testDom.ts";
import React from "react";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

register("../../../../scripts/test-tsx-load-hook.mjs", import.meta.url);
const { default: InvoiceCard } = await import("./InvoiceCard.tsx");
const { default: InvoiceDialog } = await import("./InvoiceDialog.tsx");
const { default: InvoiceNumbersCard } = await import("./InvoiceNumbersCard.tsx");

type Call = { url: string; method: string; body: Record<string, unknown> | null };
type Handler = (call: Call) => { status: number; body: unknown } | undefined;
let calls: Call[] = [];
let handlers: Handler[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  handlers = [];
  if (!globalThis.crypto?.randomUUID) throw new Error("crypto.randomUUID missing in test env");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    for (const h of handlers) {
      const r = h(call);
      if (r) return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`unscripted ${call.method} ${call.url}`);
  }) as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const on = (method: string, url: string | RegExp, respond: (c: Call) => { status: number; body: unknown }): Handler =>
  (c) => (c.method === method && (typeof url === "string" ? c.url === url : url.test(c.url)) ? respond(c) : undefined);

const APPT = "11111111-1111-4111-8111-111111111111";
const DRAFT = {
  id: "22222222-2222-4222-8222-222222222222", workspace_id: "ws", appointment_id: APPT, client_id: "c1", reissued_from_invoice_id: null,
  status: "draft", revision: 1, invoice_number: null,
  business_name: "ACS Cleaning", business_address: "1 Main St", business_phone: null, business_email: null,
  bill_to_name: "Client A", bill_to_address: "2 Oak Ave", bill_to_email: null,
  terms: "due_on_receipt", invoice_date: "2026-11-12", due_date: "2026-11-12", service_date: "2026-11-10",
  product_service: "Recurring Cleaning", description: null, quantity: 1, rate_cents: 15000, amount_cents: 15000, tax_rate: null, tax_cents: 0, total_cents: 15000,
  payment_instructions: null, note_to_client: "Thank you for your business.", job_price_cents: 15000,
  issued_at: null, voided_at: null, void_reason: null, created_at: "x", updated_at: "x",
};
const ISSUED = { ...DRAFT, status: "issued", invoice_number: "SFT-1001", issued_at: "2026-11-12T15:00:00Z", revision: 2, rate_cents: 16000, amount_cents: 16000, total_cents: 16000 };
const jobState = (o: Record<string, unknown> = {}) => ({ completed: true, billing: null, invoice: null, voided: [], ...o });
const STATE_URL = `/api/invoices?appointment_id=${APPT}`;

function renderCard(onChanged?: () => void, canMutate = true) {
  return render(React.createElement(InvoiceCard, { appointmentId: APPT, canMutate, onChanged }));
}

describe("Invoice card", () => {
  test("a job that isn't a completed job yet: no invoice actions", async () => {
    handlers = [on("GET", STATE_URL, () => ({ status: 200, body: jobState({ completed: false }) }))];
    renderCard();
    await screen.findByText(/Resolve worked time before invoicing/);
    assert.equal(screen.queryByRole("button", { name: "Create Invoice" }), null);
  });

  test("Create Invoice creates the draft (with a request id) and opens it in the editor", async () => {
    let created = 0;
    handlers = [
      on("GET", STATE_URL, () => ({ status: 200, body: jobState(created ? { invoice: DRAFT } : {}) })),
      on("POST", "/api/invoices", () => (created++, { status: 201, body: { ok: true, invoice: DRAFT } })),
      on("GET", `/api/invoices/${DRAFT.id}`, () => ({ status: 200, body: { invoice: DRAFT, billing: { paid: false, payment_method: null } } })),
    ];
    let changed = 0;
    renderCard(() => changed++);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Create Invoice" }));
    const dialog = await screen.findByRole("dialog", { name: "Draft invoice" });
    assert.equal((within(dialog).getByLabelText("Bill to") as HTMLInputElement).value, "Client A");
    const post = calls.find((c) => c.method === "POST")!;
    assert.equal(post.body!.appointment_id, APPT);
    assert.match(String(post.body!.request_id), /^[0-9a-f-]{36}$/);
    assert.equal(changed, 1);
  });

  test("Link Existing Invoice saves the QuickBooks number through Billing and then shows it", async () => {
    let linked = false;
    handlers = [
      on("GET", STATE_URL, () => ({ status: 200, body: jobState(linked ? { billing: { invoice_number: "13484", paid: false, payment_method: null, no_invoice_required: false } } : {}) })),
      on("PATCH", "/api/billing/completed-jobs/update", () => ((linked = true), { status: 200, body: { ok: true } })),
    ];
    const u = userEvent.setup();
    renderCard();
    await u.click(await screen.findByRole("button", { name: "Link Existing Invoice" }));
    await u.type(screen.getByLabelText("QuickBooks invoice number"), "13484");
    await u.click(screen.getByRole("button", { name: "Link" }));
    await screen.findByText("#13484");
    assert.deepEqual(calls.find((c) => c.method === "PATCH")!.body, { appointment_id: APPT, invoice_number: "13484" });
    assert.equal(screen.queryByRole("button", { name: "Create Invoice" }), null, "a linked job can't also get an SFT invoice");
  });

  test("a refused link shows the reason", async () => {
    handlers = [
      on("GET", STATE_URL, () => ({ status: 200, body: jobState() })),
      on("PATCH", "/api/billing/completed-jobs/update", () => ({ status: 409, body: { error: "That number belongs to an invoice created in Schedule (or is reserved for one). Enter your QuickBooks invoice number.", code: "INVOICE_NUMBER_RESERVED" } })),
    ];
    const u = userEvent.setup();
    renderCard();
    await u.click(await screen.findByRole("button", { name: "Link Existing Invoice" }));
    await u.type(screen.getByLabelText("QuickBooks invoice number"), "SFT-1");
    await u.click(screen.getByRole("button", { name: "Link" }));
    await screen.findByText(/belongs to an invoice created in Schedule/);
  });

  test("Paid directly, no invoice: choose the method, confirm; Undo brings the choices back", async () => {
    let direct = false;
    handlers = [
      on("GET", STATE_URL, () => ({ status: 200, body: jobState(direct ? { billing: { invoice_number: null, paid: true, payment_method: "venmo", no_invoice_required: true } } : {}) })),
      on("POST", "/api/billing/completed-jobs/direct-payment", (c) => ((direct = !!c.body!.no_invoice_required), { status: 200, body: { ok: true } })),
    ];
    const u = userEvent.setup();
    let changed = 0;
    renderCard(() => changed++);
    await u.click(await screen.findByRole("button", { name: "Paid directly, no invoice" }));
    assert.ok((screen.getByRole("button", { name: "Mark paid, no invoice" }) as HTMLButtonElement).disabled, "a method is required");
    await u.selectOptions(screen.getByLabelText("How did the client pay?"), "venmo");
    await u.click(screen.getByRole("button", { name: "Mark paid, no invoice" }));
    await screen.findByText(/Paid directly by Venmo/);
    assert.deepEqual(calls.filter((c) => c.method === "POST")[0].body, { appointment_id: APPT, no_invoice_required: true, payment_method: "venmo" });
    await u.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByRole("button", { name: "Create Invoice" });
    assert.equal(changed, 2, "Needs Attention refreshed after each change");
  });

  test("an issued invoice shows its number, total and paid status, with Open and Download PDF; voided ones stay listed", async () => {
    const voided = { ...ISSUED, id: "33333333-3333-4333-8333-333333333333", status: "void", invoice_number: "SFT-1000", void_reason: "wrong rate", total_cents: 15000 };
    handlers = [on("GET", STATE_URL, () => ({ status: 200, body: jobState({ invoice: ISSUED, billing: { invoice_number: "SFT-1001", paid: false, payment_method: null, no_invoice_required: false }, voided: [voided] }) }))];
    renderCard();
    await screen.findByText("SFT-1001");
    const card = screen.getByTestId("invoice-card");
    assert.ok(card.textContent!.includes("$160.00") && card.textContent!.includes("Unpaid"));
    assert.equal(within(card).getByRole("link", { name: "Download PDF" }).getAttribute("href"), `/api/invoices/${ISSUED.id}/pdf`);
    assert.ok(card.textContent!.includes("Void: SFT-1000"));
    assert.ok(card.textContent!.includes("wrong rate"));
  });

  test("a read-only workspace sees the state but can't act", async () => {
    handlers = [on("GET", STATE_URL, () => ({ status: 200, body: jobState() }))];
    renderCard(undefined, false);
    assert.ok(((await screen.findByRole("button", { name: "Create Invoice" })) as HTMLButtonElement).disabled);
  });
});

describe("Invoice dialog", () => {
  function renderDialog(id = DRAFT.id, onClose = () => {}, onChanged = () => {}) {
    return render(React.createElement(InvoiceDialog, { invoiceId: id, canMutate: true, onClose, onChanged }));
  }

  test("editing the draft updates the total live; Issue saves the edit, then issues the saved revision and shows the stored PDF", async () => {
    handlers = [
      on("GET", `/api/invoices/${DRAFT.id}`, () => ({ status: 200, body: { invoice: DRAFT, billing: { paid: false } } })),
      on("PATCH", `/api/invoices/${DRAFT.id}`, (c) => ({ status: 200, body: { ok: true, invoice: { ...DRAFT, revision: 2, rate_cents: (c.body!.fields as { rate_cents: number }).rate_cents, total_cents: 16000, amount_cents: 16000 } } })),
      on("POST", `/api/invoices/${DRAFT.id}/issue`, () => ({ status: 201, body: { ok: true, invoice: ISSUED } })),
    ];
    const u = userEvent.setup();
    renderDialog();
    const rate = await screen.findByLabelText("Rate");
    await u.clear(rate);
    await u.type(rate, "160");
    assert.equal(screen.getByTestId("invoice-total").textContent, "$160.00");
    assert.ok(screen.getByText("Job price $150.00"));
    await u.click(screen.getByRole("button", { name: "Issue invoice" }));
    await screen.findByRole("dialog", { name: "Invoice SFT-1001" });
    const patch = calls.find((c) => c.method === "PATCH")!;
    assert.equal(patch.body!.revision, 1);
    assert.equal((patch.body!.fields as { rate_cents: number }).rate_cents, 16000);
    assert.deepEqual(calls.find((c) => c.url.endsWith("/issue"))!.body, { revision: 2 }, "issues the revision the owner just saved");
    assert.equal(screen.getByTestId("invoice-total").textContent, "$160.00");
    assert.equal(screen.getByTitle("Invoice SFT-1001 preview").getAttribute("src"), `/api/invoices/${DRAFT.id}/pdf?inline=1`);
    assert.equal(screen.getByRole("link", { name: "Download PDF" }).getAttribute("href"), `/api/invoices/${DRAFT.id}/pdf`);
  });

  test("if the draft changed before issuing, the updated draft is shown for review and nothing is issued", async () => {
    const changed = { ...DRAFT, revision: 3, description: "Changed in another tab", rate_cents: 17500, total_cents: 17500, amount_cents: 17500 };
    handlers = [
      on("GET", `/api/invoices/${DRAFT.id}`, () => ({ status: 200, body: { invoice: DRAFT, billing: { paid: false } } })),
      on("POST", `/api/invoices/${DRAFT.id}/issue`, () => ({ status: 409, body: { code: "DRAFT_CHANGED", error: "This draft was changed.", invoice: changed } })),
    ];
    const u = userEvent.setup();
    renderDialog();
    await u.click(await screen.findByRole("button", { name: "Issue invoice" }));
    await screen.findByText(/Review the updated draft below, then issue it/);
    assert.equal((screen.getByLabelText("Description") as HTMLTextAreaElement).value, "Changed in another tab");
    assert.equal(screen.getByTestId("invoice-total").textContent, "$175.00");
    assert.ok(screen.getByRole("dialog", { name: "Draft invoice" }), "still a draft");
  });

  test("changing Terms moves the due date like QuickBooks", async () => {
    handlers = [on("GET", `/api/invoices/${DRAFT.id}`, () => ({ status: 200, body: { invoice: DRAFT, billing: { paid: false } } }))];
    const u = userEvent.setup();
    renderDialog();
    await u.selectOptions(await screen.findByLabelText("Terms"), "net_30");
    assert.equal((screen.getByLabelText("Due date") as HTMLInputElement).value, "2026-12-12");
  });

  test("Void & Reissue: voids with a reason (kept on record), then opens a new draft copied from it", async () => {
    const reissued = { ...DRAFT, id: "44444444-4444-4444-8444-444444444444", reissued_from_invoice_id: ISSUED.id, rate_cents: 16000, total_cents: 16000, amount_cents: 16000 };
    handlers = [
      on("GET", `/api/invoices/${ISSUED.id}`, () => ({ status: 200, body: { invoice: ISSUED, billing: { paid: false } } })),
      on("POST", `/api/invoices/${ISSUED.id}/void`, () => ({ status: 200, body: { ok: true, invoice: { ...ISSUED, status: "void", void_reason: "wrong rate" } } })),
      on("POST", "/api/invoices", () => ({ status: 201, body: { ok: true, invoice: reissued } })),
      on("GET", `/api/invoices/${reissued.id}`, () => ({ status: 200, body: { invoice: reissued, billing: { paid: false } } })),
    ];
    const u = userEvent.setup();
    let changed = 0;
    renderDialog(ISSUED.id, () => {}, () => changed++);
    await u.click(await screen.findByRole("button", { name: "Void & Reissue" }));
    await u.click(screen.getByRole("button", { name: "Void and create new draft" }));
    await screen.findByText("Enter a reason for voiding this invoice.");
    await u.type(screen.getByLabelText(/Why are you voiding SFT-1001/), "wrong rate");
    await u.click(screen.getByRole("button", { name: "Void and create new draft" }));
    await screen.findByRole("dialog", { name: "Draft invoice" });
    await screen.findByText(/SFT-1001 was voided and kept on record/);
    assert.deepEqual(calls.find((c) => c.url.endsWith("/void"))!.body, { reason: "wrong rate" });
    const re = calls.find((c) => c.method === "POST" && c.url === "/api/invoices")!.body!;
    assert.equal(re.reissue_from_invoice_id, ISSUED.id);
    assert.equal(re.appointment_id, APPT);
    assert.ok(changed >= 1);
  });

  test("a paid invoice can't be voided: the reason from the server is shown and nothing else happens", async () => {
    handlers = [
      on("GET", `/api/invoices/${ISSUED.id}`, () => ({ status: 200, body: { invoice: ISSUED, billing: { paid: true } } })),
      on("POST", `/api/invoices/${ISSUED.id}/void`, () => ({ status: 409, body: { code: "INVOICE_PAID", error: "This invoice is marked paid. Mark it unpaid in Billing before voiding it." } })),
    ];
    const u = userEvent.setup();
    renderDialog(ISSUED.id);
    assert.ok(await screen.findByText("Paid"));
    await u.click(screen.getByRole("button", { name: "Void & Reissue" }));
    await u.type(screen.getByLabelText(/Why are you voiding/), "duplicate");
    await u.click(screen.getByRole("button", { name: "Void and create new draft" }));
    await screen.findByText(/Mark it unpaid in Billing before voiding it/);
    assert.equal(calls.filter((c) => c.method === "POST" && c.url === "/api/invoices").length, 0);
  });

  test("Discard asks first, then deletes the draft and closes", async () => {
    let closed = false;
    handlers = [
      on("GET", `/api/invoices/${DRAFT.id}`, () => ({ status: 200, body: { invoice: DRAFT, billing: { paid: false } } })),
      on("DELETE", `/api/invoices/${DRAFT.id}`, () => ({ status: 200, body: { ok: true } })),
    ];
    const u = userEvent.setup();
    renderDialog(DRAFT.id, () => (closed = true));
    await u.click(await screen.findByRole("button", { name: "Discard draft" }));
    assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
    await u.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => assert.ok(closed));
  });
});


describe("Invoice dialog -- sales tax", () => {
  const open = (invoice: unknown) => {
    handlers = [on("GET", `/api/invoices/${DRAFT.id}`, () => ({ status: 200, body: { invoice, billing: { paid: false } } }))];
    return render(React.createElement(InvoiceDialog, { invoiceId: DRAFT.id, canMutate: true, onClose: () => {}, onChanged: () => {} }));
  };

  test("tax is off by default: no rate field and no Tax line", async () => {
    open(DRAFT);
    const box = (await screen.findByLabelText("Charge sales tax")) as HTMLInputElement;
    assert.equal(box.checked, false);
    assert.equal(screen.queryByLabelText("Tax rate"), null);
    assert.equal(screen.queryByTestId("invoice-tax"), null);
    assert.equal(screen.getByTestId("invoice-total").textContent, "$150.00");
  });

  test("turning tax on: enter a rate, review Subtotal / Tax / Total live (same rounding as the database), saved as the rate", async () => {
    handlers = [
      on("GET", `/api/invoices/${DRAFT.id}`, () => ({ status: 200, body: { invoice: DRAFT, billing: { paid: false } } })),
      on("PATCH", `/api/invoices/${DRAFT.id}`, () => ({ status: 200, body: { ok: true, invoice: { ...DRAFT, revision: 2, tax_rate: "6.875", tax_cents: 1031, total_cents: 16031 } } })),
    ];
    render(React.createElement(InvoiceDialog, { invoiceId: DRAFT.id, canMutate: true, onClose: () => {}, onChanged: () => {} }));
    const u = userEvent.setup();
    await u.click(await screen.findByLabelText("Charge sales tax"));
    await u.type(screen.getByLabelText("Tax rate"), "6.875");
    assert.equal(screen.getByTestId("invoice-subtotal").textContent, "$150.00");
    assert.equal(screen.getByTestId("invoice-tax").textContent, "$10.31", "$10.3125 rounds to $10.31");
    assert.equal(screen.getByTestId("invoice-total").textContent, "$160.31");
    await u.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => assert.ok(calls.some((c) => c.method === "PATCH")));
    assert.equal((calls.find((c) => c.method === "PATCH")!.body!.fields as { tax_rate: string }).tax_rate, "6.875");
  });

  test("half a cent rounds up, and a tax that rounds to $0.00 still shows its Tax line", async () => {
    open({ ...DRAFT, rate_cents: 150, amount_cents: 150, total_cents: 150 });
    const u = userEvent.setup();
    await u.click(await screen.findByLabelText("Charge sales tax"));
    await u.type(screen.getByLabelText("Tax rate"), "7");
    assert.equal(screen.getByTestId("invoice-tax").textContent, "$0.11", "$0.105 -> $0.11");
    const rate = screen.getByLabelText("Rate");
    await u.clear(rate);
    await u.type(rate, "0.05");
    assert.equal(screen.getByTestId("invoice-tax").textContent, "$0.00");
  });

  test("tax on with no rate can't be saved; an invalid rate shows why", async () => {
    open(DRAFT);
    const u = userEvent.setup();
    await u.click(await screen.findByLabelText("Charge sales tax"));
    await u.click(screen.getByRole("button", { name: "Issue invoice" }));
    await screen.findByText(/Enter the sales tax rate/);
    await u.type(screen.getByLabelText("Tax rate"), "6.8755");
    await u.click(screen.getByRole("button", { name: "Issue invoice" }));
    await screen.findByText(/at most 3 decimals/);
    assert.equal(calls.filter((c) => c.method !== "GET").length, 0);
  });

  test("a reissued draft arrives with the original rate on, and changing the amount recalculates the tax", async () => {
    open({ ...DRAFT, tax_rate: "6.5", tax_cents: 975, total_cents: 15975, reissued_from_invoice_id: "x" });
    const box = (await screen.findByLabelText("Charge sales tax")) as HTMLInputElement;
    assert.equal(box.checked, true);
    assert.equal((screen.getByLabelText("Tax rate") as HTMLInputElement).value, "6.5");
    assert.equal(screen.getByTestId("invoice-tax").textContent, "$9.75");
    const u = userEvent.setup();
    const rate = screen.getByLabelText("Rate");
    await u.clear(rate);
    await u.type(rate, "160");
    assert.equal(screen.getByTestId("invoice-tax").textContent, "$10.40");
    assert.equal(screen.getByTestId("invoice-total").textContent, "$170.40");
  });

  test("an issued taxed invoice shows the tax-inclusive total and the tax", async () => {
    open({ ...ISSUED, tax_rate: "6.5", tax_cents: 1040, total_cents: 17040 });
    await screen.findByRole("dialog", { name: "Invoice SFT-1001" });
    assert.equal(screen.getByTestId("invoice-total").textContent, "$170.40");
    assert.match(screen.getByTestId("invoice-tax").textContent!, /6\.5% tax \$10\.40/);
  });
});

describe("Invoice numbers (top of Billing)", () => {
  const NUMBERING = "/api/invoices/numbering";
  const state = (o: Record<string, unknown> = {}) => ({
    series: "sft", starting_number: null, next_available: "SFT-1001", locked: false,
    highest_recorded: { number: "13484", value: "13484", client_name: "Robin Example" }, ...o,
  });
  const renderNumbers = (canMutate = true) => render(React.createElement(InvoiceNumbersCard, { canMutate }));

  test("shows the next available number and that the final number is assigned on issue", async () => {
    handlers = [on("GET", NUMBERING, () => ({ status: 200, body: { numbering: state() } }))];
    renderNumbers();
    const card = await screen.findByRole("region", { name: "Invoice numbers" });
    assert.match(card.textContent ?? "", /Next available invoice number\s*SFT-1001/);
    assert.ok(within(card).getByText("The final number is assigned when an invoice is issued."));
  });

  test("set a starting number: the QuickBooks reminder and the highest recorded number guide it; saved as a number", async () => {
    handlers = [
      on("GET", NUMBERING, () => ({ status: 200, body: { numbering: state() } })),
      on("PUT", NUMBERING, () => ({ status: 200, body: { ok: true, numbering: state({ series: "custom", starting_number: 13485, next_available: "13485" }) } })),
    ];
    renderNumbers();
    await userEvent.click(await screen.findByRole("button", { name: "Set starting number" }));
    assert.ok(screen.getByText(/check QuickBooks for the last invoice number you actually issued/));
    assert.match(screen.getByTestId("highest-recorded").textContent ?? "", /13484 \(Robin Example\)\. Your starting number must be higher\./);
    await userEvent.type(screen.getByLabelText("Starting invoice number"), "13485");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => assert.equal(screen.getByTestId("next-available-number").textContent, "13485"));
    const put = calls.find((c) => c.method === "PUT")!;
    assert.deepEqual(put.body, { starting_number: 13485 });
    assert.ok(screen.getByRole("button", { name: "Change starting number" }));
  });

  test("a start at or below the highest recorded number shows the server's reason and keeps the editor open", async () => {
    handlers = [
      on("GET", NUMBERING, () => ({ status: 200, body: { numbering: state() } })),
      on("PUT", NUMBERING, () => ({ status: 409, body: { error: "Choose a number above 13484 (Robin Example), the highest invoice number recorded in Billing.", code: "STARTING_NUMBER_TOO_LOW", numbering: state() } })),
    ];
    renderNumbers();
    await userEvent.click(await screen.findByRole("button", { name: "Set starting number" }));
    await userEvent.type(screen.getByLabelText("Starting invoice number"), "13484");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    assert.match((await screen.findByRole("alert")).textContent ?? "", /Choose a number above 13484/);
    assert.ok(screen.getByLabelText("Starting invoice number"));
  });

  test("not a whole number: refused before anything is sent", async () => {
    handlers = [on("GET", NUMBERING, () => ({ status: 200, body: { numbering: state() } }))];
    renderNumbers();
    await userEvent.click(await screen.findByRole("button", { name: "Set starting number" }));
    await userEvent.type(screen.getByLabelText("Starting invoice number"), "SFT-9");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    assert.match((await screen.findByRole("alert")).textContent ?? "", /whole number/);
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
  });

  test("a custom start can go back to SFT-1001 before the first invoice", async () => {
    handlers = [
      on("GET", NUMBERING, () => ({ status: 200, body: { numbering: state({ series: "custom", starting_number: 13485, next_available: "13485" }) } })),
      on("PUT", NUMBERING, () => ({ status: 200, body: { ok: true, numbering: state() } })),
    ];
    renderNumbers();
    await userEvent.click(await screen.findByRole("button", { name: "Change starting number" }));
    assert.equal((screen.getByLabelText("Starting invoice number") as HTMLInputElement).value, "13485");
    await userEvent.click(screen.getByRole("button", { name: "Use SFT-1001 instead" }));
    await waitFor(() => assert.equal(screen.getByTestId("next-available-number").textContent, "SFT-1001"));
    assert.deepEqual(calls.find((c) => c.method === "PUT")!.body, { starting_number: null });
  });

  test("locked after the first issued invoice, and read-only workspaces: no way to change it", async () => {
    handlers = [on("GET", NUMBERING, () => ({ status: 200, body: { numbering: state({ series: "custom", next_available: "13487", locked: true }) } }))];
    renderNumbers();
    await screen.findByText(/Continuing your own invoice numbers\. Set when the first invoice was issued\./);
    assert.equal(screen.queryByRole("button", { name: /starting number/ }), null);
    cleanup();
    handlers = [on("GET", NUMBERING, () => ({ status: 200, body: { numbering: state() } }))];
    renderNumbers(false);
    await screen.findByTestId("next-available-number");
    assert.equal(screen.queryByRole("button", { name: /starting number/ }), null);
  });

  test("the draft editor shows the next available number and that the final one is assigned on issue", async () => {
    handlers = [on("GET", `/api/invoices/${DRAFT.id}`, () => ({ status: 200, body: { invoice: DRAFT, billing: { paid: false }, next_available: "13485" } }))];
    render(React.createElement(InvoiceDialog, { invoiceId: DRAFT.id, canMutate: true, onClose: () => {}, onChanged: () => {} }));
    assert.equal((await screen.findByTestId("invoice-next-number")).textContent, "13485");
    assert.ok(screen.getByText("Next available invoice number"));
    assert.ok(screen.getByText("The final number is assigned when you issue the invoice."));
  });
});

describe("Review & Send (issued invoices)", () => {
  const SEND_URL = `/api/invoices/${ISSUED.id}/send`;
  const PREFILL = { to: "pat@example.test", subject: "Invoice SFT-1001 from ACS Cleaning", message: "Hi Pat,\n\nAttached is invoice SFT-1001 for $160.00, due on receipt." };
  const loaded = (attempts: unknown[] = []) => ({ status: 200, body: { invoice_number: "SFT-1001", sendable: true, status: "issued", prefill: PREFILL, attachment: { file_name: "SFT-1001.pdf", bytes: 20480 }, attempts } });
  const sentAttempt = { id: "a1", state: "sent", label: "Sent — delivery unconfirmed", to: "pat@example.test", subject: "Invoice", created_at: "2026-11-13T15:04:00Z" };
  const openIssued = (canMutate = true, invoice: Record<string, unknown> = ISSUED) =>
    render(React.createElement(InvoiceDialog, { invoiceId: String(invoice.id), canMutate, onClose: () => {}, onChanged: () => {} }));
  const getIssued = (invoice: Record<string, unknown> = ISSUED) => on("GET", `/api/invoices/${invoice.id}`, () => ({ status: 200, body: { invoice, billing: { paid: false } } }));

  test("only issued invoices offer Review & Send (not drafts, voided invoices, or read-only workspaces); opening it never sends", async () => {
    handlers = [getIssued()];
    openIssued();
    await screen.findByRole("button", { name: "Review & Send" });
    cleanup();
    handlers = [getIssued()];
    openIssued(false);
    await screen.findByRole("link", { name: "Download PDF" });
    assert.equal(screen.queryByRole("button", { name: "Review & Send" }), null);
    cleanup();
    const VOID = { ...ISSUED, status: "void", voided_at: "2026-11-13T00:00:00Z", void_reason: "typo" };
    handlers = [getIssued(VOID)];
    openIssued(true, VOID);
    await screen.findByText(/Voided/);
    assert.equal(screen.queryByRole("button", { name: "Review & Send" }), null);
    cleanup();
    handlers = [on("GET", `/api/invoices/${DRAFT.id}`, () => ({ status: 200, body: { invoice: DRAFT, billing: { paid: false }, next_available: "SFT-1001" } }))];
    render(React.createElement(InvoiceDialog, { invoiceId: DRAFT.id, canMutate: true, onClose: () => {}, onChanged: () => {} }));
    await screen.findByRole("button", { name: "Issue invoice" });
    assert.equal(screen.queryByRole("button", { name: "Review & Send" }), null);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  });

  test("prefilled and editable; Review shows the recipient and invoice number; Send posts once and shows Sent — delivery unconfirmed", async () => {
    let changed = 0;
    handlers = [
      getIssued(),
      on("GET", SEND_URL, () => loaded()),
      on("POST", SEND_URL, (c) => ({ status: 201, body: { ok: true, attempt: { ...sentAttempt, id: "a9", to: c.body!.to } } })),
    ];
    render(React.createElement(InvoiceDialog, { invoiceId: ISSUED.id, canMutate: true, onClose: () => {}, onChanged: () => { changed++; } }));
    await userEvent.click(await screen.findByRole("button", { name: "Review & Send" }));
    assert.equal(((await screen.findByLabelText("To")) as HTMLInputElement).value, "pat@example.test");
    assert.equal((screen.getByLabelText("Subject") as HTMLInputElement).value, PREFILL.subject);
    assert.equal((screen.getByLabelText("Message") as HTMLTextAreaElement).value, PREFILL.message);
    assert.match(screen.getByTestId("invoice-send-attachment").textContent ?? "", /SFT-1001\.pdf \(20 KB\), the PDF saved when this invoice was issued/);
    await userEvent.clear(screen.getByLabelText("To"));
    await userEvent.type(screen.getByLabelText("To"), "billing@example.test");
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    assert.match(screen.getByTestId("invoice-send-review").textContent ?? "", /Send invoice SFT-1001 to billing@example\.test\?/);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0, "nothing is sent before the confirm");
    await userEvent.click(screen.getByRole("button", { name: "Send invoice" }));
    assert.match((await screen.findByTestId("invoice-send-result")).textContent ?? "", /Sent — delivery unconfirmed.*invoice SFT-1001 to billing@example\.test/);
    const posts = calls.filter((c) => c.method === "POST");
    assert.equal(posts.length, 1);
    assert.match(String(posts[0].body!.request_id), /^[0-9a-f-]{36}$/);
    assert.deepEqual([posts[0].body!.to, posts[0].body!.subject, posts[0].body!.acknowledged_attempt_id], ["billing@example.test", PREFILL.subject, null]);
    assert.equal(changed, 1);
  });

  test("a double-click on Send sends one request", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    handlers = [getIssued(), on("GET", SEND_URL, () => loaded())];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null };
      calls.push(call);
      if (call.method === "POST") {
        await gate;
        return new Response(JSON.stringify({ ok: true, attempt: sentAttempt }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      for (const h of handlers) {
        const r = h(call);
        if (r) return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`unscripted ${call.method} ${call.url}`);
    }) as typeof fetch;
    openIssued();
    await userEvent.click(await screen.findByRole("button", { name: "Review & Send" }));
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    await userEvent.dblClick(screen.getByRole("button", { name: "Send invoice" }));
    release();
    await screen.findByTestId("invoice-send-result");
    assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  });

  test("lost connection: Check status repeats the SAME request (it can never send twice)", async () => {
    let first = true;
    handlers = [
      getIssued(),
      on("GET", SEND_URL, () => loaded()),
      (c) => {
        if (c.method !== "POST") return undefined;
        if (first) {
          first = false;
          throw new TypeError("Failed to fetch");
        }
        return { status: 200, body: { ok: true, replayed: true, attempt: sentAttempt } };
      },
    ];
    openIssued();
    await userEvent.click(await screen.findByRole("button", { name: "Review & Send" }));
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    await userEvent.click(screen.getByRole("button", { name: "Send invoice" }));
    assert.match((await screen.findByRole("alert")).textContent ?? "", /may or may not have been sent/);
    await userEvent.click(screen.getByRole("button", { name: "Check status" }));
    await screen.findByTestId("invoice-send-result");
    const posts = calls.filter((c) => c.method === "POST");
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body!.request_id, posts[1].body!.request_id);
  });

  test("already sent: the earlier send is shown and Send again acknowledges it", async () => {
    handlers = [getIssued(), on("GET", SEND_URL, () => loaded([sentAttempt])), on("POST", SEND_URL, () => ({ status: 201, body: { ok: true, attempt: { ...sentAttempt, id: "a2" } } }))];
    openIssued();
    await userEvent.click(await screen.findByRole("button", { name: "Review & Send" }));
    assert.match((await screen.findByTestId("invoice-send-history")).textContent ?? "", /Sent — delivery unconfirmed.*to pat@example\.test/);
    await userEvent.click(screen.getByRole("button", { name: "Review" }));
    assert.match(screen.getByTestId("invoice-send-warning").textContent ?? "", /already sent on .* to pat@example\.test\. Sending again emails another copy\./);
    await userEvent.click(screen.getByRole("button", { name: "Send again" }));
    await screen.findByTestId("invoice-send-result");
    assert.equal(calls.find((c) => c.method === "POST")!.body!.acknowledged_attempt_id, "a1");
  });

  test("an unknown outcome is shown before an intentional resend (Send again anyway)", async () => {
    const unknown = { ...sentAttempt, id: "u1", state: "uncertain", label: "Outcome unknown — not confirmed" };
    handlers = [getIssued(), on("GET", SEND_URL, () => loaded([unknown])), on("POST", SEND_URL, () => ({ status: 201, body: { ok: true, attempt: { ...sentAttempt, id: "a3" } } }))];
    openIssued();
    await userEvent.click(await screen.findByRole("button", { name: "Review & Send" }));
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    assert.match(screen.getByTestId("invoice-send-warning").textContent ?? "", /unknown outcome .* the client may already have this invoice/);
    assert.equal(screen.queryByRole("button", { name: "Send invoice" }), null);
    await userEvent.click(screen.getByRole("button", { name: "Send again anyway" }));
    await screen.findByTestId("invoice-send-result");
    assert.equal(calls.find((c) => c.method === "POST")!.body!.acknowledged_attempt_id, "u1");
  });

  test("Failed and unknown results are shown as such; a send made meanwhile in another tab is shown before sending", async () => {
    handlers = [
      getIssued(), on("GET", SEND_URL, () => loaded()),
      on("POST", SEND_URL, () => ({ status: 201, body: { ok: true, attempt: { ...sentAttempt, state: "failed", label: "Failed" }, reason: "Invalid recipient" } })),
    ];
    openIssued();
    await userEvent.click(await screen.findByRole("button", { name: "Review & Send" }));
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    await userEvent.click(screen.getByRole("button", { name: "Send invoice" }));
    assert.match((await screen.findByTestId("invoice-send-result")).textContent ?? "", /Failed.*nothing was sent \(Invalid recipient\)/);
    assert.ok(screen.getByRole("button", { name: "Try again" }));
    cleanup();

    handlers = [
      getIssued(), on("GET", SEND_URL, () => loaded()),
      on("POST", SEND_URL, () => ({ status: 201, body: { ok: true, attempt: { ...sentAttempt, state: "uncertain", label: "Outcome unknown — not confirmed" }, reason: "no answer from the email service in time" } })),
    ];
    openIssued();
    await userEvent.click(await screen.findByRole("button", { name: "Review & Send" }));
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    await userEvent.click(screen.getByRole("button", { name: "Send invoice" }));
    assert.match((await screen.findByTestId("invoice-send-result")).textContent ?? "", /Outcome unknown — not confirmed.*may or may not have received it/);
    cleanup();

    let n = 0;
    handlers = [
      getIssued(), on("GET", SEND_URL, () => loaded()),
      on("POST", SEND_URL, () => (++n === 1
        ? { status: 409, body: { error: "This invoice was already sent. Confirm to send it again.", code: "PREVIOUS_ATTEMPT", attempt: sentAttempt } }
        : { status: 201, body: { ok: true, attempt: { ...sentAttempt, id: "a4" } } })),
    ];
    openIssued();
    await userEvent.click(await screen.findByRole("button", { name: "Review & Send" }));
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    await userEvent.click(screen.getByRole("button", { name: "Send invoice" }));
    await screen.findByTestId("invoice-send-warning");
    await userEvent.click(screen.getByRole("button", { name: "Send again" }));
    await screen.findByTestId("invoice-send-result");
    const posts = calls.filter((c) => c.method === "POST").slice(-2); // this part's two sends
    assert.equal(posts[0].body!.acknowledged_attempt_id, null);
    assert.equal(posts[1].body!.acknowledged_attempt_id, "a1");
    assert.notEqual(posts[0].body!.request_id, posts[1].body!.request_id);
  });
});
