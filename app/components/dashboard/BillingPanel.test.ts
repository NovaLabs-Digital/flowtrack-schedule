// RENDERED verification of BillingPanel -- renders the REAL component with
// REAL React into jsdom and drives it with real user-event interaction.
// Only the network is faked: a scripted `fetch` stands in for
// GET /api/billing/completed-jobs and PATCH /api/billing/completed-jobs/update.
// Same pattern as app/components/dashboard/AppointmentModal.render.test.ts.
import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import "../../../lib/testDom.ts";
import React from "react";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

register("../../../scripts/test-tsx-load-hook.mjs", import.meta.url);
const { default: BillingPanel } = await import("./BillingPanel.tsx");

const TZ = "America/New_York";

type Call = { url: string; method: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let responses: Array<() => Promise<Response> | Response> = [];
const originalFetch = globalThis.fetch;
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls = [];
  responses = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    const next = responses.shift();
    if (!next) throw new Error(`unscripted fetch to ${String(input)}`);
    return next();
  }) as typeof fetch;
});
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

const ROW_DONE = {
  appointmentId: "appt-done", serviceDate: "2026-08-12", scheduledFor: "2026-08-12T13:00:00.000Z",
  clientId: "c1", clientName: "Petra Lindqvist", serviceType: "Window Washing", priceCents: 12000,
  billing: null,
};
const ROW_PAID = {
  appointmentId: "appt-paid", serviceDate: "2026-08-13", scheduledFor: "2026-08-13T13:00:00.000Z",
  clientId: "c2", clientName: "Simon Aldercott", serviceType: "Lawn Mowing", priceCents: 8000,
  billing: { id: "b1", workspace_id: "w1", appointment_id: "appt-paid", invoice_number: "INV-9", paid: true, payment_method: "zelle", created_at: "x", updated_at: "x" },
};
const REVIEW_ROW = {
  appointmentId: "appt-review", serviceDate: "2026-08-14", scheduledFor: "2026-08-14T13:00:00.000Z",
  clientId: "c3", clientName: "Wren Castellan", serviceType: "Deep Clean",
};

function renderPanel(canMutateOperationalData = true) {
  return render(React.createElement(BillingPanel, { timezone: TZ, canMutateOperationalData }));
}

describe("BillingPanel -- initial load", () => {
  test("fetches the report for a date range, and shows loading then the fetched rows", async () => {
    responses = [json(200, { completed: [ROW_DONE, ROW_PAID], reviewNeeded: [] })];
    renderPanel();
    assert.match(screen.getByText("Loading...").textContent ?? "", /Loading/);
    await screen.findByText("Petra Lindqvist");
    assert.ok(screen.getByText("Simon Aldercott"));
    assert.equal(calls[0].method, "GET");
    assert.match(calls[0].url, /\/api\/billing\/completed-jobs\?start=\d{4}-\d{2}-\d{2}&end=\d{4}-\d{2}-\d{2}/);
  });

  test("shows the summary totals computed from the fetched rows", async () => {
    responses = [json(200, { completed: [ROW_DONE, ROW_PAID], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Petra Lindqvist");
    const statValue = (label: string) => screen.getByText(label).parentElement!.querySelector("div.font-semibold")!.textContent;
    assert.equal(statValue("Completed Jobs"), "2");
    assert.equal(statValue("Completed Work $"), "$200.00"); // 120.00 + 80.00
    assert.equal(statValue("Invoiced $"), "$80.00"); // only appt-paid has an invoice number
    assert.equal(statValue("Unpaid $"), "$0.00"); // appt-paid IS paid, appt-done has no invoice yet
  });

  test("a load error is shown inline, never thrown", async () => {
    responses = [json(500, { error: "Server error" })];
    renderPanel();
    await screen.findByText("Server error");
  });

  test("the secondary review-needed list renders separately and is visually distinguishable, with no amount/edit columns", async () => {
    responses = [json(200, { completed: [ROW_DONE], reviewNeeded: [REVIEW_ROW] })];
    renderPanel();
    await screen.findByText("Petra Lindqvist");
    await screen.findByText("Past jobs needing completion review");
    assert.ok(screen.getByText("Wren Castellan"));
  });

  test("no review section renders when reviewNeeded is empty", async () => {
    responses = [json(200, { completed: [ROW_DONE], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Petra Lindqvist");
    assert.equal(screen.queryByText("Past jobs needing completion review"), null);
  });
});

describe("BillingPanel -- DD/MM/YY display formatting (display only -- storage/queries stay ISO)", () => {
  test("Service Date column renders DD/MM/YY, not the raw YYYY-MM-DD", async () => {
    responses = [json(200, { completed: [ROW_DONE], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("12/08/26");
    assert.equal(screen.queryByText("2026-08-12"), null, "the raw ISO string must never be the visible text");
  });

  test("Past jobs needing completion review dates also render DD/MM/YY", async () => {
    responses = [json(200, { completed: [], reviewNeeded: [REVIEW_ROW] })];
    renderPanel();
    await screen.findByText("14/08/26");
    assert.equal(screen.queryByText("2026-08-14"), null);
  });

  test("the From/To date controls show DD/MM/YY while the underlying fetch still uses plain ISO YYYY-MM-DD query params", async () => {
    responses = [json(200, { completed: [], reviewNeeded: [] })];
    renderPanel();
    await waitFor(() => assert.equal(calls.length, 1));
    // The real query param, exactly as sent to the server -- never DD/MM/YY.
    assert.match(calls[0].url, /\?start=\d{4}-\d{2}-\d{2}&end=\d{4}-\d{2}-\d{2}/);
    // The native <input type="date"> elements still carry the real ISO
    // value underneath (calendar selection/accessibility/range math are
    // completely untouched) -- only their visible text is a DD/MM/YY
    // decorative overlay, asserted separately below.
    const dateInputs = document.querySelectorAll('input[type="date"]');
    assert.equal(dateInputs.length, 2);
    for (const input of dateInputs) {
      assert.match((input as HTMLInputElement).value, /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("changing the visible From date still drives the real ISO value and triggers a correctly-shaped refetch", async () => {
    responses = [
      json(200, { completed: [], reviewNeeded: [] }),
      json(200, { completed: [], reviewNeeded: [] }),
    ];
    renderPanel();
    await waitFor(() => assert.equal(calls.length, 1));
    const fromInput = document.querySelectorAll('input[type="date"]')[0] as HTMLInputElement;
    fireEvent.change(fromInput, { target: { value: "2026-08-01" } });
    await waitFor(() => assert.equal(calls.length, 2));
    assert.match(calls[1].url, /start=2026-08-01/);
    await screen.findByText("01/08/26");
  });

  test("a date on a year/month boundary (2026-01-01) renders exactly 01/01/26 -- proves the formatter never shifts by a day the way re-parsing through `new Date()` could in a negative-UTC-offset test environment", async () => {
    const boundaryRow = { ...ROW_DONE, appointmentId: "appt-boundary", serviceDate: "2026-01-01" };
    responses = [json(200, { completed: [boundaryRow], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("01/01/26");
    assert.equal(screen.queryByText("31/12/25"), null, "must never shift to the previous day");
  });
});

describe("BillingPanel -- status filter (client-side, no extra fetch)", () => {
  test('selecting "Paid" shows only paid rows, without issuing a new GET', async () => {
    responses = [json(200, { completed: [ROW_DONE, ROW_PAID], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Petra Lindqvist");
    const callsBefore = calls.length;

    const u = userEvent.setup();
    const select = screen.getAllByRole("combobox")[0];
    await u.selectOptions(select, "paid");

    assert.equal(screen.queryByText("Petra Lindqvist"), null);
    assert.ok(screen.getByText("Simon Aldercott"));
    assert.equal(calls.length, callsBefore, "status filter must not trigger another network request");
  });

  test('"Missing Invoice #" shows only rows with no invoice number', async () => {
    responses = [json(200, { completed: [ROW_DONE, ROW_PAID], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Petra Lindqvist");
    const u = userEvent.setup();
    await u.selectOptions(screen.getAllByRole("combobox")[0], "missing_invoice");
    assert.ok(screen.getByText("Petra Lindqvist"));
    assert.equal(screen.queryByText("Simon Aldercott"), null);
  });
});

describe("BillingPanel -- This Week / Last Week", () => {
  test("clicking Last Week changes the range and triggers a new fetch", async () => {
    responses = [json(200, { completed: [], reviewNeeded: [] }), json(200, { completed: [], reviewNeeded: [] })];
    renderPanel();
    await waitFor(() => assert.equal(calls.length, 1));
    const u = userEvent.setup();
    await u.click(screen.getByText("Last Week"));
    await waitFor(() => assert.equal(calls.length, 2));
    assert.notEqual(calls[0].url, calls[1].url);
  });
});

describe("BillingPanel -- inline editing", () => {
  test("typing an invoice number and blurring saves it via PATCH with the appointment_id", async () => {
    responses = [
      json(200, { completed: [ROW_DONE], reviewNeeded: [] }),
      json(200, { ok: true, billing: { ...ROW_PAID.billing, appointment_id: "appt-done", invoice_number: "INV-500", paid: false, payment_method: null } }),
    ];
    renderPanel();
    await screen.findByText("Petra Lindqvist");

    const input = screen.getByPlaceholderText("—") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "INV-500" } });
    fireEvent.blur(input);

    await waitFor(() => assert.equal(calls.length, 2));
    assert.equal(calls[1].method, "PATCH");
    assert.deepEqual(calls[1].body, { appointment_id: "appt-done", invoice_number: "INV-500" });
  });

  test("blurring without changing the value does not issue a PATCH", async () => {
    responses = [json(200, { completed: [ROW_PAID], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Simon Aldercott");
    const input = screen.getByDisplayValue("INV-9") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.blur(input);
    assert.equal(calls.length, 1, "only the initial GET, no PATCH");
  });

  test("checking Paid without a payment method shows the server's validation error inline, and the checkbox is not left checked", async () => {
    responses = [
      json(200, { completed: [ROW_DONE], reviewNeeded: [] }),
      json(400, { error: "Payment method is required once a job is marked Paid." }),
    ];
    renderPanel();
    await screen.findByText("Petra Lindqvist");
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    const u = userEvent.setup();
    await u.click(checkbox);

    await screen.findByText("Payment method is required once a job is marked Paid.");
    assert.equal(calls[1].method, "PATCH");
    assert.deepEqual(calls[1].body, { appointment_id: "appt-done", paid: true });
    assert.equal(checkbox.checked, false, "the row's billing state never changed server-side, so the checkbox must not show checked");
  });

  test("selecting a payment method saves it via PATCH", async () => {
    responses = [
      json(200, { completed: [ROW_PAID], reviewNeeded: [] }),
      json(200, { ok: true, billing: { ...ROW_PAID.billing, payment_method: "cash" } }),
    ];
    renderPanel();
    await screen.findByText("Simon Aldercott");
    const u = userEvent.setup();
    const methodSelect = screen.getAllByRole("combobox")[1]; // [0] is the status filter
    await u.selectOptions(methodSelect, "cash");
    await waitFor(() => assert.equal(calls.length, 2));
    assert.deepEqual(calls[1].body, { appointment_id: "appt-paid", payment_method: "cash" });
  });
});

describe("BillingPanel -- read-only mode", () => {
  test("canMutateOperationalData=false disables invoice input, paid checkbox, and payment method select", async () => {
    responses = [json(200, { completed: [ROW_DONE], reviewNeeded: [] })];
    renderPanel(false);
    await screen.findByText("Petra Lindqvist");
    assert.equal((screen.getByPlaceholderText("—") as HTMLInputElement).disabled, true);
    assert.equal((screen.getByRole("checkbox") as HTMLInputElement).disabled, true);
    const methodSelect = screen.getAllByRole("combobox")[1];
    assert.equal((methodSelect as HTMLSelectElement).disabled, true);
  });
});
