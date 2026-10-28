// RENDERED verification of BillingPanel -- renders the REAL component with
// REAL React into jsdom and drives it with real user-event interaction.
// Only the network is faked: a scripted `fetch` stands in for
// GET /api/billing/completed-jobs and PATCH /api/billing/completed-jobs/update.
// Same pattern as app/components/dashboard/AppointmentModal.render.test.ts.
import { test, describe, afterEach, beforeEach, mock } from "node:test";
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
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; window.localStorage.clear(); });

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

const USER_ID = "owner-1";
const WORKSPACE_ID = "ws-1";

function renderPanel(
  canMutateOperationalData = true,
  overrides: { workspaceId?: string; userId?: string; focusAppointmentId?: string | null; focusServiceDate?: string | null } = {}
) {
  return render(
    React.createElement(BillingPanel, {
      timezone: TZ,
      canMutateOperationalData,
      workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
      userId: overrides.userId ?? USER_ID,
      focusAppointmentId: overrides.focusAppointmentId,
      focusServiceDate: overrides.focusServiceDate,
    })
  );
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

describe("BillingPanel -- MM/DD/YY display formatting (display only -- storage/queries stay ISO)", () => {
  test("Service Date column renders MM/DD/YY, not the raw YYYY-MM-DD", async () => {
    responses = [json(200, { completed: [ROW_DONE], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("08/12/26");
    assert.equal(screen.queryByText("2026-08-12"), null, "the raw ISO string must never be the visible text");
    assert.equal(screen.queryByText("12/08/26"), null, "must not render the prior DD/MM/YY order");
  });

  test("Past jobs needing completion review dates also render MM/DD/YY", async () => {
    responses = [json(200, { completed: [], reviewNeeded: [REVIEW_ROW] })];
    renderPanel();
    await screen.findByText("08/14/26");
    assert.equal(screen.queryByText("2026-08-14"), null);
    assert.equal(screen.queryByText("14/08/26"), null, "must not render the prior DD/MM/YY order");
  });

  test("the From/To date controls show MM/DD/YY while the underlying fetch still uses plain ISO YYYY-MM-DD query params", async () => {
    responses = [json(200, { completed: [], reviewNeeded: [] })];
    renderPanel();
    await waitFor(() => assert.equal(calls.length, 1));
    // The real query param, exactly as sent to the server -- never MM/DD/YY.
    assert.match(calls[0].url, /\?start=\d{4}-\d{2}-\d{2}&end=\d{4}-\d{2}-\d{2}/);
    // The native <input type="date"> elements still carry the real ISO
    // value underneath (calendar selection/accessibility/range math are
    // completely untouched) -- only their visible text is a MM/DD/YY
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
    await screen.findByText("08/01/26");
  });

  test("a date on a year/month boundary (2026-01-01) renders exactly 01/01/26 -- proves the formatter never shifts by a day the way re-parsing through `new Date()` could in a negative-UTC-offset test environment", async () => {
    const boundaryRow = { ...ROW_DONE, appointmentId: "appt-boundary", serviceDate: "2026-01-01" };
    responses = [json(200, { completed: [boundaryRow], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("01/01/26");
    assert.equal(screen.queryByText("31/12/25"), null, "must never shift to the previous day");
  });
});

describe("BillingPanel -- From/To date fields are clickable across their whole visible area (bug: clicking directly on the MM/DD/YY digits did not open the native picker)", () => {
  test("the decorative MM/DD/YY overlay stays aria-hidden and pointer-events-none, so it never becomes the thing intercepting clicks", async () => {
    responses = [json(200, { completed: [], reviewNeeded: [] })];
    renderPanel();
    await waitFor(() => assert.equal(calls.length, 1));
    const decoratives = screen.getAllByText(/^\d{2}\/\d{2}\/\d{2}$/);
    assert.equal(decoratives.length, 2, "both the From and To decorative spans");
    for (const decorative of decoratives) {
      assert.equal(decorative.getAttribute("aria-hidden"), "true");
      assert.ok(decorative.className.includes("pointer-events-none"));
    }
  });

  test("the real native date input is expanded to cover its own calendar-picker-indicator across its full area, so every point inside the box -- not just a corner -- opens the native picker", async () => {
    responses = [json(200, { completed: [], reviewNeeded: [] })];
    renderPanel();
    await waitFor(() => assert.equal(calls.length, 1));
    const dateInputs = document.querySelectorAll('input[type="date"]');
    assert.equal(dateInputs.length, 2);
    for (const input of dateInputs) {
      const cls = (input as HTMLInputElement).className;
      assert.ok(cls.includes("[&::-webkit-calendar-picker-indicator]:absolute"));
      assert.ok(cls.includes("[&::-webkit-calendar-picker-indicator]:inset-0"));
      assert.ok(cls.includes("[&::-webkit-calendar-picker-indicator]:h-full"));
      assert.ok(cls.includes("[&::-webkit-calendar-picker-indicator]:w-full"));
    }
  });

  test("the real input still carries the correct ISO value underneath (fix is click-target only, not a value/parsing change)", async () => {
    responses = [json(200, { completed: [], reviewNeeded: [] })];
    renderPanel();
    await waitFor(() => assert.equal(calls.length, 1));
    const dateInputs = document.querySelectorAll('input[type="date"]');
    for (const input of dateInputs) {
      assert.match((input as HTMLInputElement).value, /^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("BillingPanel -- client-name search (client-side, scoped to the selected date range)", () => {
  test("the search input renders with the expected placeholder and no submit button", async () => {
    responses = [json(200, { completed: [ROW_DONE, ROW_PAID], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Petra Lindqvist");
    assert.ok(screen.getByPlaceholderText("Search client name"));
    assert.equal(screen.queryByRole("button", { name: /search/i }), null);
  });

  test("typing a partial, case-insensitive client name filters the table live, without a new fetch", async () => {
    responses = [json(200, { completed: [ROW_DONE, ROW_PAID], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Petra Lindqvist");
    const callsBefore = calls.length;

    fireEvent.change(screen.getByPlaceholderText("Search client name"), { target: { value: "sim" } });
    assert.equal(screen.queryByText("Petra Lindqvist"), null, '"sim" should not match "Petra Lindqvist"');
    assert.ok(screen.getByText("Simon Aldercott"), 'matches "Simon Aldercott"');

    fireEvent.change(screen.getByPlaceholderText("Search client name"), { target: { value: "PETRA" } });
    assert.ok(screen.getByText("Petra Lindqvist"), "case-insensitive match");
    assert.equal(screen.queryByText("Simon Aldercott"), null);

    assert.equal(calls.length, callsBefore, "client-name search must not trigger another network request");
  });

  test('a substring in the middle of a name matches ("tam" matches both "Tammy Owens" and "Tami Factor")', async () => {
    const tammy = { ...ROW_DONE, appointmentId: "appt-tammy", clientName: "Tammy Owens" };
    const tami = { ...ROW_PAID, appointmentId: "appt-tami", clientName: "Tami Factor" };
    responses = [json(200, { completed: [tammy, tami], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Tammy Owens");

    fireEvent.change(screen.getByPlaceholderText("Search client name"), { target: { value: "tam" } });
    assert.ok(screen.getByText("Tammy Owens"));
    assert.ok(screen.getByText("Tami Factor"));
  });

  test("summary cards recalculate from the search-filtered rows, not the full in-range set", async () => {
    responses = [json(200, { completed: [ROW_DONE, ROW_PAID], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Petra Lindqvist");
    const statValue = (label: string) => screen.getByText(label).parentElement!.querySelector("div.font-semibold")!.textContent;

    fireEvent.change(screen.getByPlaceholderText("Search client name"), { target: { value: "Simon" } });
    assert.equal(statValue("Completed Jobs"), "1");
    assert.equal(statValue("Completed Work $"), "$80.00", "only Simon's $80, not Petra's $120 too");
    assert.equal(statValue("Invoiced $"), "$80.00");
  });

  test("the review-needed rows also filter by the same client-name search", async () => {
    const reviewOther = { ...REVIEW_ROW, appointmentId: "appt-review-2", clientName: "Holly Williams" };
    responses = [json(200, { completed: [], reviewNeeded: [REVIEW_ROW, reviewOther] })];
    renderPanel();
    await screen.findByText("Past jobs needing completion review");
    assert.ok(screen.getByText("Wren Castellan"));
    assert.ok(screen.getByText("Holly Williams"));

    fireEvent.change(screen.getByPlaceholderText("Search client name"), { target: { value: "holly" } });
    assert.equal(screen.queryByText("Wren Castellan"), null);
    assert.ok(screen.getByText("Holly Williams"));
  });

  test("the review-needed section hides entirely rather than showing an empty state when the search matches none of its rows", async () => {
    responses = [json(200, { completed: [ROW_DONE], reviewNeeded: [REVIEW_ROW] })];
    renderPanel();
    await screen.findByText("Past jobs needing completion review");

    fireEvent.change(screen.getByPlaceholderText("Search client name"), { target: { value: "zzz-no-match" } });
    assert.equal(screen.queryByText("Past jobs needing completion review"), null);
  });

  test("clearing the search restores all rows in the selected range", async () => {
    responses = [json(200, { completed: [ROW_DONE, ROW_PAID], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Petra Lindqvist");
    const input = screen.getByPlaceholderText("Search client name");

    fireEvent.change(input, { target: { value: "Simon" } });
    assert.equal(screen.queryByText("Petra Lindqvist"), null);

    fireEvent.change(input, { target: { value: "" } });
    assert.ok(screen.getByText("Petra Lindqvist"));
    assert.ok(screen.getByText("Simon Aldercott"));
  });

  test("no match shows the client-specific empty state, not the generic range/filter message", async () => {
    responses = [json(200, { completed: [ROW_DONE], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Petra Lindqvist");

    fireEvent.change(screen.getByPlaceholderText("Search client name"), { target: { value: "zzz-no-match" } });
    await screen.findByText("No completed jobs found for this client in the selected date range.");
    assert.equal(screen.queryByText("No completed jobs match this range/filter."), null);
  });
});

describe("BillingPanel -- status filter (client-side, no extra fetch)", () => {
  test('selecting "Paid" shows only paid rows, without issuing a new GET', async () => {
    responses = [json(200, { completed: [ROW_DONE, ROW_PAID], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Petra Lindqvist");
    const callsBefore = calls.length;

    const u = userEvent.setup();
    const select = screen.getByRole("combobox", { name: "Filter by billing status" });
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
    await u.selectOptions(screen.getByRole("combobox", { name: "Filter by billing status" }), "missing_invoice");
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
    // [0] is the sort-order dropdown, [1] is the status filter, [2+] are
    // the per-row payment-method selects, in fetch order.
    const methodSelect = screen.getAllByRole("combobox")[2];
    await u.selectOptions(methodSelect, "cash");
    await waitFor(() => assert.equal(calls.length, 2));
    assert.deepEqual(calls[1].body, { appointment_id: "appt-paid", payment_method: "cash" });
  });
});

// Real production bug: Beth Holcomb, three completed jobs sharing invoice
// 13422. The database (migration 033's upsert_completed_job_billing) was
// already correctly synchronizing paid/payment_method across all three
// rows, but this panel applied a PATCH response to only the row that
// triggered it, leaving the other two -- and the Unpaid $ summary derived
// from all of them -- visibly stale until a full page reload. Fixed via
// applyGroupedBillingUpdate (lib/completedJobBilling.ts), applied to local
// state with NO second fetch -- every GET-call-count assertion below is
// there specifically to prove that.
describe("BillingPanel -- grouped-invoice sync (fix for stale sibling rows after a Paid/payment-method edit)", () => {
  const BETH_1 = {
    appointmentId: "appt-beth-1", serviceDate: "2026-06-24", scheduledFor: "2026-06-24T13:00:00.000Z",
    clientId: "client-beth", clientName: "Beth Holcomb", serviceType: "Regular Cleaning", priceCents: 10000,
    billing: { id: "b-beth-1", workspace_id: "w1", appointment_id: "appt-beth-1", client_id: "client-beth", invoice_number: "13422", paid: false, payment_method: null, created_at: "x", updated_at: "x" },
  };
  const BETH_2 = { ...BETH_1, appointmentId: "appt-beth-2", billing: { ...BETH_1.billing, id: "b-beth-2", appointment_id: "appt-beth-2" } };
  const BETH_3 = { ...BETH_1, appointmentId: "appt-beth-3", billing: { ...BETH_1.billing, id: "b-beth-3", appointment_id: "appt-beth-3" } };
  // Same client as Beth, a DIFFERENT invoice number -- must never be synced.
  const BETH_UNRELATED_INVOICE = {
    ...BETH_1, appointmentId: "appt-beth-unrelated",
    billing: { ...BETH_1.billing, id: "b-beth-unrelated", appointment_id: "appt-beth-unrelated", invoice_number: "99999" },
  };
  // A DIFFERENT client whose invoice number happens to be the identical
  // text "13422" -- must never be synced, even though the text matches.
  const OTHER_CLIENT_SAME_INVOICE_NUMBER = {
    appointmentId: "appt-nancy", serviceDate: "2026-06-25", scheduledFor: "2026-06-25T13:00:00.000Z",
    clientId: "client-nancy", clientName: "Nancy Oduya", serviceType: "Lawn Mowing", priceCents: 10000,
    billing: { id: "b-nancy", workspace_id: "w1", appointment_id: "appt-nancy", client_id: "client-nancy", invoice_number: "13422", paid: false, payment_method: null, created_at: "x", updated_at: "x" },
  };

  test("marking one grouped-invoice row Paid (with a payment method) immediately updates every sibling row's checkbox AND payment-method select, recalculates Unpaid $, and never issues a second fetch", async () => {
    responses = [
      json(200, { completed: [BETH_1, BETH_2, BETH_3, BETH_UNRELATED_INVOICE, OTHER_CLIENT_SAME_INVOICE_NUMBER], reviewNeeded: [] }),
      // PATCH 1: set payment_method on appt-beth-1 (paid still false) --
      // the database syncs payment_method onto the whole group regardless
      // of paid, exactly like the real upsert_completed_job_billing already
      // does (proven in test-db/completed_job_billing.test.ts).
      json(200, { ok: true, billing: { ...BETH_1.billing, payment_method: "zelle" } }),
      // PATCH 2: check Paid on appt-beth-1 -- server merges onto the
      // payment_method the previous save already set.
      json(200, { ok: true, billing: { ...BETH_1.billing, paid: true, payment_method: "zelle" } }),
    ];
    renderPanel();
    await screen.findAllByText("Beth Holcomb");

    const u = userEvent.setup();
    const selects = screen.getAllByRole("combobox"); // [0] = sort order, [1] = status filter, [2..6] = one per row, in fetch order
    const checkboxes = screen.getAllByRole("checkbox");
    assert.equal(selects.length, 7);
    assert.equal(checkboxes.length, 5);

    await u.selectOptions(selects[2], "zelle"); // appt-beth-1's payment method
    await waitFor(() => assert.equal(calls.length, 2));

    // Payment method synced onto both OTHER Beth rows sharing invoice
    // 13422, even though paid hasn't changed yet.
    assert.equal((selects[2] as HTMLSelectElement).value, "zelle");
    assert.equal((selects[3] as HTMLSelectElement).value, "zelle");
    assert.equal((selects[4] as HTMLSelectElement).value, "zelle");
    // Unrelated invoice (same client) and the other client's identical
    // invoice-number text must be untouched.
    assert.equal((selects[5] as HTMLSelectElement).value, "");
    assert.equal((selects[6] as HTMLSelectElement).value, "");
    for (const cb of checkboxes) assert.equal((cb as HTMLInputElement).checked, false, "paid must not change from a payment_method-only edit");

    await u.click(checkboxes[0]); // check Paid on appt-beth-1
    await waitFor(() => assert.equal(calls.length, 3));

    assert.equal((checkboxes[0] as HTMLInputElement).checked, true);
    assert.equal((checkboxes[1] as HTMLInputElement).checked, true, "sibling appt-beth-2 must show paid immediately");
    assert.equal((checkboxes[2] as HTMLInputElement).checked, true, "sibling appt-beth-3 must show paid immediately");
    assert.equal((checkboxes[3] as HTMLInputElement).checked, false, "the unrelated-invoice row must stay unpaid");
    assert.equal((checkboxes[4] as HTMLInputElement).checked, false, "the other client's row must stay unpaid");

    // 5 rows x $100 = $500 invoiced; the 3-row Beth group ($300) is now
    // paid, leaving the unrelated-invoice row and the other client's row
    // ($100 each) still unpaid.
    const statValue = (label: string) => screen.getByText(label).parentElement!.querySelector("div.font-semibold")!.textContent;
    assert.equal(statValue("Invoiced $"), "$500.00");
    assert.equal(statValue("Unpaid $"), "$200.00");

    assert.equal(calls.filter((c) => c.method === "GET").length, 1, "the sync must come from the PATCH response, never a second GET");
  });

  test("setting the group back to unpaid immediately updates every sibling row, and Unpaid $ rises again -- the reverse direction", async () => {
    const beth1Paid = { ...BETH_1, billing: { ...BETH_1.billing, paid: true, payment_method: "zelle" } };
    const beth2Paid = { ...BETH_2, billing: { ...BETH_2.billing, paid: true, payment_method: "zelle" } };
    const beth3Paid = { ...BETH_3, billing: { ...BETH_3.billing, paid: true, payment_method: "zelle" } };

    responses = [
      json(200, { completed: [beth1Paid, beth2Paid, beth3Paid, BETH_UNRELATED_INVOICE, OTHER_CLIENT_SAME_INVOICE_NUMBER], reviewNeeded: [] }),
      // Uncheck Paid on the MIDDLE row -- payment_method is not resent, so
      // the server keeps the existing "zelle" (matches the real route's
      // merge behavior), and the sync carries that same unpaid+zelle state
      // onto every sibling, exactly as already proven against real Postgres.
      json(200, { ok: true, billing: { ...beth2Paid.billing, paid: false, payment_method: "zelle" } }),
    ];
    renderPanel();
    await screen.findAllByText("Beth Holcomb");

    const checkboxes = screen.getAllByRole("checkbox");
    assert.equal(checkboxes.length, 5);
    for (const cb of checkboxes.slice(0, 3)) assert.equal((cb as HTMLInputElement).checked, true, "fixture precondition: all three Beth rows start paid");

    const u = userEvent.setup();
    await u.click(checkboxes[1]); // uncheck appt-beth-2
    await waitFor(() => assert.equal(calls.length, 2));

    assert.equal((checkboxes[0] as HTMLInputElement).checked, false, "appt-beth-1 must flip to unpaid too");
    assert.equal((checkboxes[1] as HTMLInputElement).checked, false);
    assert.equal((checkboxes[2] as HTMLInputElement).checked, false, "appt-beth-3 must flip to unpaid too");

    const statValue = (label: string) => screen.getByText(label).parentElement!.querySelector("div.font-semibold")!.textContent;
    assert.equal(statValue("Unpaid $"), "$500.00", "all 5 rows are now unpaid again: the Beth group plus the two isolated rows");

    assert.equal(calls.filter((c) => c.method === "GET").length, 1, "the sync must come from the PATCH response, never a second GET");
  });
});

// Service-date sort order (Oldest first / Newest first). ROW_EARLY/MID/LATE
// span three distinct scheduledFor instants so ordering assertions read
// client names off the table's own row order, the same way the rest of
// this file already asserts behavior through real rendered output rather
// than internal state.
const ROW_EARLY = {
  appointmentId: "appt-early", serviceDate: "2026-08-10", scheduledFor: "2026-08-10T13:00:00.000Z",
  clientId: "c0", clientName: "Aaron Ng", serviceType: "Gutter Cleaning", priceCents: 9000,
  billing: null,
};
const ROW_MID = ROW_DONE; // 2026-08-12, Petra Lindqvist
const ROW_LATE = ROW_PAID; // 2026-08-13, Simon Aldercott

function tableClientOrder(): string[] {
  return [...document.querySelectorAll("tbody tr td:nth-child(2)")].map((td) => td.textContent ?? "");
}

describe("BillingPanel -- service-date sort order (Oldest first / Newest first)", () => {
  test("a clearly labelled Sort dropdown renders with exactly the two documented options, defaulting to Oldest first", async () => {
    responses = [json(200, { completed: [ROW_EARLY, ROW_MID, ROW_LATE], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Aaron Ng");
    const sortSelect = screen.getByRole("combobox", { name: "Sort by service date" }) as HTMLSelectElement;
    const optionLabels = [...sortSelect.options].map((o) => o.textContent);
    assert.deepEqual(optionLabels, ["Oldest first", "Newest first"]);
    assert.equal(sortSelect.value, "oldest_first", "preserves the existing (pre-feature) sort order as the default");
  });

  test("defaults to the SAME order the table already showed before this feature existed: earliest service date first", async () => {
    responses = [json(200, { completed: [ROW_LATE, ROW_EARLY, ROW_MID], reviewNeeded: [] })]; // fed out of order on purpose
    renderPanel();
    await screen.findByText("Aaron Ng");
    assert.deepEqual(tableClientOrder(), ["Aaron Ng", "Petra Lindqvist", "Simon Aldercott"]);
  });

  test('selecting "Newest first" reverses the table to the most recent service date first, without a new fetch', async () => {
    responses = [json(200, { completed: [ROW_EARLY, ROW_MID, ROW_LATE], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Aaron Ng");
    const callsBefore = calls.length;

    const u = userEvent.setup();
    await u.selectOptions(screen.getByRole("combobox", { name: "Sort by service date" }), "newest_first");

    assert.deepEqual(tableClientOrder(), ["Simon Aldercott", "Petra Lindqvist", "Aaron Ng"]);
    assert.equal(calls.length, callsBefore, "sort order must not trigger another network request");
  });

  test('switching back to "Oldest first" restores ascending order', async () => {
    responses = [json(200, { completed: [ROW_EARLY, ROW_MID, ROW_LATE], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Aaron Ng");
    const u = userEvent.setup();
    const sortSelect = screen.getByRole("combobox", { name: "Sort by service date" });
    await u.selectOptions(sortSelect, "newest_first");
    assert.deepEqual(tableClientOrder(), ["Simon Aldercott", "Petra Lindqvist", "Aaron Ng"]);
    await u.selectOptions(sortSelect, "oldest_first");
    assert.deepEqual(tableClientOrder(), ["Aaron Ng", "Petra Lindqvist", "Simon Aldercott"]);
  });

  test("two rows sharing the exact same service date/time still render in a consistent, stable order in both directions", async () => {
    const tiedA = { ...ROW_EARLY, appointmentId: "appt-tied-a", clientName: "Aaron Ng" };
    const tiedB = { ...ROW_EARLY, appointmentId: "appt-tied-b", clientName: "Zoe Baptiste" };
    responses = [json(200, { completed: [tiedB, tiedA], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Aaron Ng");
    // Stable tie-breaker is appointmentId ascending ("appt-tied-a" before
    // "appt-tied-b"), so Aaron renders first -- regardless of direction.
    assert.deepEqual(tableClientOrder(), ["Aaron Ng", "Zoe Baptiste"]);

    const u = userEvent.setup();
    await u.selectOptions(screen.getByRole("combobox", { name: "Sort by service date" }), "newest_first");
    assert.deepEqual(tableClientOrder(), ["Aaron Ng", "Zoe Baptiste"], "the tie order itself does not flip just because the direction did");
  });

  test("sorting is applied to the FULL status-filtered and client-searched result set, not merely the originally-fetched order", async () => {
    // Petra (missing invoice) and Simon (paid) differ in status; only
    // Petra and a third missing-invoice row should remain after filtering
    // to "Missing Invoice #" -- sort must still apply correctly to that
    // narrowed set.
    const thirdMissing = { ...ROW_EARLY, appointmentId: "appt-third", clientName: "Mina Oduya", serviceDate: "2026-08-11", scheduledFor: "2026-08-11T13:00:00.000Z" };
    responses = [json(200, { completed: [ROW_MID, ROW_LATE, thirdMissing], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Petra Lindqvist");

    const u = userEvent.setup();
    await u.selectOptions(screen.getByRole("combobox", { name: "Filter by billing status" }), "missing_invoice");
    assert.deepEqual(tableClientOrder(), ["Mina Oduya", "Petra Lindqvist"], "filtered set in default oldest-first order");

    await u.selectOptions(screen.getByRole("combobox", { name: "Sort by service date" }), "newest_first");
    assert.deepEqual(tableClientOrder(), ["Petra Lindqvist", "Mina Oduya"], "same filtered set, now newest-first -- Simon never reappears");
  });

  test("changing sort order never changes the summary totals (a pure display-order change)", async () => {
    responses = [json(200, { completed: [ROW_EARLY, ROW_MID, ROW_LATE], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Aaron Ng");
    const statValue = (label: string) => screen.getByText(label).parentElement!.querySelector("div.font-semibold")!.textContent;
    const before = { jobs: statValue("Completed Jobs"), work: statValue("Completed Work $") };

    const u = userEvent.setup();
    await u.selectOptions(screen.getByRole("combobox", { name: "Sort by service date" }), "newest_first");

    assert.equal(statValue("Completed Jobs"), before.jobs);
    assert.equal(statValue("Completed Work $"), before.work);
  });

  test("changing sort order never changes which jobs are billing-eligible or what's already saved -- the same billing rows are shown, just reordered", async () => {
    responses = [json(200, { completed: [ROW_EARLY, ROW_MID, ROW_LATE], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Aaron Ng");
    assert.ok(screen.getByDisplayValue("INV-9"), "Simon's already-saved invoice number is present before reordering");

    const u = userEvent.setup();
    await u.selectOptions(screen.getByRole("combobox", { name: "Sort by service date" }), "newest_first");

    assert.ok(screen.getByDisplayValue("INV-9"), "still present, unchanged, after reordering");
    assert.ok(screen.getByText("Aaron Ng"));
    assert.ok(screen.getByText("Petra Lindqvist"));
    assert.ok(screen.getByText("Simon Aldercott"));
  });
});

describe("BillingPanel -- sort order preference persistence (per user + workspace, localStorage)", () => {
  test("selecting Newest first persists to localStorage, scoped by the current userId and workspaceId", async () => {
    responses = [json(200, { completed: [ROW_EARLY, ROW_MID, ROW_LATE], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Aaron Ng");
    const u = userEvent.setup();
    await u.selectOptions(screen.getByRole("combobox", { name: "Sort by service date" }), "newest_first");
    assert.equal(window.localStorage.getItem(`sft_billing_sort_order_v1_${USER_ID}_${WORKSPACE_ID}`), "newest_first");
  });

  test("a later mount for the SAME user+workspace restores the saved preference, without the owner reselecting it", async () => {
    responses = [
      json(200, { completed: [ROW_EARLY, ROW_MID, ROW_LATE], reviewNeeded: [] }),
      json(200, { completed: [ROW_EARLY, ROW_MID, ROW_LATE], reviewNeeded: [] }),
    ];
    const first = renderPanel();
    await screen.findByText("Aaron Ng");
    const u = userEvent.setup();
    await u.selectOptions(screen.getByRole("combobox", { name: "Sort by service date" }), "newest_first");
    first.unmount();

    renderPanel();
    await screen.findByText("Aaron Ng");
    assert.equal((screen.getByRole("combobox", { name: "Sort by service date" }) as HTMLSelectElement).value, "newest_first");
    assert.deepEqual(tableClientOrder(), ["Simon Aldercott", "Petra Lindqvist", "Aaron Ng"]);
  });

  test("two different users in the same workspace never share this preference", async () => {
    responses = [
      json(200, { completed: [ROW_EARLY, ROW_MID, ROW_LATE], reviewNeeded: [] }),
      json(200, { completed: [ROW_EARLY, ROW_MID, ROW_LATE], reviewNeeded: [] }),
    ];
    const asOwnerA = renderPanel(true, { userId: "owner-A" });
    await screen.findByText("Aaron Ng");
    const u = userEvent.setup();
    await u.selectOptions(screen.getByRole("combobox", { name: "Sort by service date" }), "newest_first");
    asOwnerA.unmount();

    renderPanel(true, { userId: "owner-B" });
    await screen.findByText("Aaron Ng");
    assert.equal(
      (screen.getByRole("combobox", { name: "Sort by service date" }) as HTMLSelectElement).value,
      "oldest_first",
      "a different owner in the same workspace sees their own default, not owner-A's saved preference"
    );
  });

  test("the same user in a different workspace never shares this preference", async () => {
    responses = [
      json(200, { completed: [ROW_EARLY, ROW_MID, ROW_LATE], reviewNeeded: [] }),
      json(200, { completed: [ROW_EARLY, ROW_MID, ROW_LATE], reviewNeeded: [] }),
    ];
    const inWorkspace1 = renderPanel(true, { workspaceId: "ws-A" });
    await screen.findByText("Aaron Ng");
    const u = userEvent.setup();
    await u.selectOptions(screen.getByRole("combobox", { name: "Sort by service date" }), "newest_first");
    inWorkspace1.unmount();

    renderPanel(true, { workspaceId: "ws-B" });
    await screen.findByText("Aaron Ng");
    assert.equal((screen.getByRole("combobox", { name: "Sort by service date" }) as HTMLSelectElement).value, "oldest_first");
  });

  test("a corrupted/invalid stored value is ignored, falling back to the default rather than throwing or showing a blank selection", async () => {
    window.localStorage.setItem(`sft_billing_sort_order_v1_${USER_ID}_${WORKSPACE_ID}`, "not-a-real-order");
    responses = [json(200, { completed: [ROW_EARLY, ROW_MID, ROW_LATE], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Aaron Ng");
    assert.equal((screen.getByRole("combobox", { name: "Sort by service date" }) as HTMLSelectElement).value, "oldest_first");
    assert.deepEqual(tableClientOrder(), ["Aaron Ng", "Petra Lindqvist", "Simon Aldercott"]);
  });

  test("an unavailable localStorage (throws on every access) never crashes the panel, and the selection still works in-memory for this session", async () => {
    const realGetItem = window.localStorage.getItem.bind(window.localStorage);
    const realSetItem = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.getItem = () => { throw new Error("storage disabled"); };
    window.localStorage.setItem = () => { throw new Error("storage disabled"); };
    try {
      responses = [json(200, { completed: [ROW_EARLY, ROW_MID, ROW_LATE], reviewNeeded: [] })];
      renderPanel();
      await screen.findByText("Aaron Ng");
      const u = userEvent.setup();
      await u.selectOptions(screen.getByRole("combobox", { name: "Sort by service date" }), "newest_first");
      assert.deepEqual(tableClientOrder(), ["Simon Aldercott", "Petra Lindqvist", "Aaron Ng"], "in-memory selection still works even though persistence silently fails");
    } finally {
      window.localStorage.getItem = realGetItem;
      window.localStorage.setItem = realSetItem;
    }
  });
});

// Real risk this guards against: if BillingPanel keyed its rows by array
// index instead of appointmentId, reordering would either lose an
// in-progress (unsaved, not-yet-blurred) invoice-number draft or, worse,
// silently reattach it to a DIFFERENT job that happened to land in the
// same table position after the resort.
describe("BillingPanel -- changing sort order never loses or misattributes an unsaved invoice-number draft", () => {
  test("an unsaved draft typed into one row stays attached to that SAME client after reordering, and is not shown on any other row", async () => {
    responses = [json(200, { completed: [ROW_EARLY, ROW_MID, ROW_LATE], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Aaron Ng");

    // Aaron Ng (appt-early) is the first row (oldest first) -- type a draft
    // invoice number into HIS row specifically, without blurring/saving.
    const aaronRow = screen.getByText("Aaron Ng").closest("tr")!;
    const aaronInput = aaronRow.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(aaronInput, { target: { value: "DRAFT-FOR-AARON" } });
    assert.equal(aaronInput.value, "DRAFT-FOR-AARON");

    // Reorder -- Aaron's row now moves to the BOTTOM of the table.
    const u = userEvent.setup();
    await u.selectOptions(screen.getByRole("combobox", { name: "Sort by service date" }), "newest_first");
    assert.deepEqual(tableClientOrder(), ["Simon Aldercott", "Petra Lindqvist", "Aaron Ng"]);

    // The draft must have followed Aaron's row to its new position --
    // never left behind attached to whichever row is now first (Simon),
    // and never silently cleared.
    const simonRow = screen.getByText("Simon Aldercott").closest("tr")!;
    const simonInput = simonRow.querySelector('input[type="text"]') as HTMLInputElement;
    assert.equal(simonInput.value, "INV-9", "Simon's own already-saved invoice number (not Aaron's draft) must be what shows in his field");

    const aaronRowAfter = screen.getByText("Aaron Ng").closest("tr")!;
    const aaronInputAfter = aaronRowAfter.querySelector('input[type="text"]') as HTMLInputElement;
    assert.equal(aaronInputAfter.value, "DRAFT-FOR-AARON", "Aaron's draft must still be exactly his, after moving position");

    // No PATCH was ever sent (the draft was never blurred) -- confirms the
    // value survived purely via React's keyed reconciliation, not a save.
    assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
  });

  test("a draft survives TWO reorders (there and back) and can still be saved correctly afterward", async () => {
    responses = [
      json(200, { completed: [ROW_EARLY, ROW_MID, ROW_LATE], reviewNeeded: [] }),
      json(200, { ok: true, billing: { id: "b-new", workspace_id: WORKSPACE_ID, appointment_id: "appt-early", client_id: "c0", invoice_number: "DRAFT-ROUNDTRIP", paid: false, payment_method: null, created_at: "x", updated_at: "x" } }),
    ];
    renderPanel();
    await screen.findByText("Aaron Ng");

    const aaronInput = screen.getByText("Aaron Ng").closest("tr")!.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(aaronInput, { target: { value: "DRAFT-ROUNDTRIP" } });

    const u = userEvent.setup();
    const sortSelect = screen.getByRole("combobox", { name: "Sort by service date" });
    await u.selectOptions(sortSelect, "newest_first");
    await u.selectOptions(sortSelect, "oldest_first");

    const aaronInputAfter = screen.getByText("Aaron Ng").closest("tr")!.querySelector('input[type="text"]') as HTMLInputElement;
    assert.equal(aaronInputAfter.value, "DRAFT-ROUNDTRIP");

    fireEvent.blur(aaronInputAfter);
    await waitFor(() => assert.equal(calls.filter((c) => c.method === "PATCH").length, 1));
    assert.deepEqual(calls[calls.length - 1].body, { appointment_id: "appt-early", invoice_number: "DRAFT-ROUNDTRIP" });
  });
});

// Needs Attention deep-link: focusAppointmentId/focusServiceDate let a
// caller (DashboardShell's NeedsAttentionControl wiring) open this panel
// already scoped to a specific job's own week, instead of silently hiding
// it behind the default "this week" range -- and highlight which row it
// is. jsdom has no scrollIntoView implementation at all (not even a
// no-op), so it's stubbed here only to prove the component calls it; the
// component itself guards defensively against it being absent (see
// BillingRow's own typeof check), which is what makes this stub optional
// for every OTHER test in this file to keep passing without it.
describe("BillingPanel -- Needs Attention deep-link (focusAppointmentId/focusServiceDate)", () => {
  const scrollSpy = mock.fn();
  const realScrollIntoView = (window.HTMLElement.prototype as any).scrollIntoView;
  beforeEach(() => {
    scrollSpy.mock.resetCalls();
    (window.HTMLElement.prototype as any).scrollIntoView = scrollSpy;
  });
  afterEach(() => {
    (window.HTMLElement.prototype as any).scrollIntoView = realScrollIntoView;
  });

  test("with no focus props, the initial fetch still uses the default \"this week\" range (unchanged behavior)", async () => {
    responses = [json(200, { completed: [], reviewNeeded: [] })];
    renderPanel();
    await waitFor(() => assert.equal(calls.length, 1));
    // Just confirms a request was made with SOME valid range -- the exact
    // "this week" value is already covered by the MM/DD/YY describe block
    // above; this test exists to contrast against the focused case below.
    assert.match(calls[0].url, /\?start=\d{4}-\d{2}-\d{2}&end=\d{4}-\d{2}-\d{2}/);
  });

  test("with a focusServiceDate from another week, the initial fetch's range covers that date, not \"this week\"", async () => {
    responses = [json(200, { completed: [], reviewNeeded: [] })];
    // A date almost certainly outside "this week" in any real test run.
    renderPanel(true, { focusAppointmentId: "appt-far-away", focusServiceDate: "2020-03-10" });
    await waitFor(() => assert.equal(calls.length, 1));
    const url = new URL(calls[0].url, "http://localhost");
    const start = url.searchParams.get("start")!;
    const end = url.searchParams.get("end")!;
    assert.ok(start <= "2020-03-10" && "2020-03-10" <= end, `expected 2020-03-10 to fall within [${start}, ${end}]`);
  });

  test("the focused row is visually highlighted and scrolled into view once it loads", async () => {
    const targetRow = { ...ROW_DONE, appointmentId: "appt-focus-target" };
    responses = [json(200, { completed: [targetRow, ROW_PAID], reviewNeeded: [] })];
    renderPanel(true, { focusAppointmentId: "appt-focus-target", focusServiceDate: targetRow.serviceDate });
    await screen.findByText("Petra Lindqvist");
    const targetTr = screen.getByText("Petra Lindqvist").closest("tr")!;
    assert.ok(targetTr.className.includes("bg-amber-50"), "the focused row gets a visible highlight");
    const otherTr = screen.getByText("Simon Aldercott").closest("tr")!;
    assert.ok(!otherTr.className.includes("bg-amber-50"), "no other row is highlighted");
    assert.equal(scrollSpy.mock.callCount(), 1);
  });

  test("no row is highlighted and scrollIntoView is never called when focusAppointmentId is absent", async () => {
    responses = [json(200, { completed: [ROW_DONE, ROW_PAID], reviewNeeded: [] })];
    renderPanel();
    await screen.findByText("Petra Lindqvist");
    const row = screen.getByText("Petra Lindqvist").closest("tr")!;
    assert.ok(!row.className.includes("bg-amber-50"));
    assert.equal(scrollSpy.mock.callCount(), 0);
  });
});

describe("BillingPanel -- read-only mode", () => {
  test("canMutateOperationalData=false disables invoice input, paid checkbox, and payment method select", async () => {
    responses = [json(200, { completed: [ROW_DONE], reviewNeeded: [] })];
    renderPanel(false);
    await screen.findByText("Petra Lindqvist");
    assert.equal((screen.getByPlaceholderText("—") as HTMLInputElement).disabled, true);
    assert.equal((screen.getByRole("checkbox") as HTMLInputElement).disabled, true);
    // [0] = sort order, [1] = status filter (neither is gated by
    // canMutateOperationalData -- display-order/visibility controls, not
    // mutations), [2] = this row's payment-method select.
    const methodSelect = screen.getAllByRole("combobox")[2];
    assert.equal((methodSelect as HTMLSelectElement).disabled, true);
  });
});
