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
  product_service: "Recurring Cleaning", description: null, quantity: 1, rate_cents: 15000, amount_cents: 15000, total_cents: 15000,
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
      on("PATCH", "/api/billing/completed-jobs/update", () => ({ status: 409, body: { error: "Invoice numbers starting with SFT are reserved for invoices created in Schedule.", code: "INVOICE_NUMBER_RESERVED" } })),
    ];
    const u = userEvent.setup();
    renderCard();
    await u.click(await screen.findByRole("button", { name: "Link Existing Invoice" }));
    await u.type(screen.getByLabelText("QuickBooks invoice number"), "SFT-1");
    await u.click(screen.getByRole("button", { name: "Link" }));
    await screen.findByText(/reserved for invoices created in Schedule/);
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
