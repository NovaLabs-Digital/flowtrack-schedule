import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isCompletedForBilling,
  needsCompletionReview,
  isInDateRange,
  normalizeInvoiceNumber,
  validateBillingState,
  buildCompletedJobRows,
  buildReviewNeededRows,
  applyBillingStatusFilter,
  computeBillingSummary,
  isValidPaymentMethod,
  type CompletedJobBilling,
} from "./completedJobBilling.ts";
import type { Appointment, Client, AppointmentEmployeeAssignment } from "@/app/components/dashboard/types";

const HOUR_MS = 60 * 60 * 1000;
const TZ = "America/New_York";

function appt(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "appt-1",
    client_id: "client-1",
    service_type: "Regular Cleaning",
    scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
    scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    status: "scheduled",
    notes: null,
    price_cents: 15000,
    ...overrides,
  };
}

function assignment(overrides: Partial<AppointmentEmployeeAssignment> = {}): AppointmentEmployeeAssignment {
  return {
    id: "ae-1",
    appointment_id: "appt-1",
    employee_id: "emp-1",
    actual_started_at: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
    actual_completed_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    job_notes: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function client(overrides: Partial<Client> = {}): Client {
  return { id: "client-1", name: "Jane Doe", email: null, phone: null, ...overrides };
}

function billing(overrides: Partial<CompletedJobBilling> = {}): CompletedJobBilling {
  return {
    id: "bill-1",
    workspace_id: "ws-1",
    appointment_id: "appt-1",
    invoice_number: null,
    paid: false,
    payment_method: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("isCompletedForBilling", () => {
  test("true when the one assigned employee's Job Tracking is complete", () => {
    assert.equal(isCompletedForBilling([assignment()]), true);
  });
  test("false with zero assignments (never vacuously completed)", () => {
    assert.equal(isCompletedForBilling([]), false);
  });
  test("false when started but not completed", () => {
    assert.equal(isCompletedForBilling([assignment({ actual_completed_at: null })]), false);
  });
  test("false when one of two assigned employees hasn't finished", () => {
    assert.equal(
      isCompletedForBilling([assignment(), assignment({ id: "ae-2", employee_id: "emp-2", actual_completed_at: null })]),
      false
    );
  });
});

describe("needsCompletionReview", () => {
  test("false for a cancelled appointment, even if past and untracked", () => {
    assert.equal(needsCompletionReview(appt({ status: "cancelled" }), []), false);
  });
  test("false for a future (not-yet-eligible) appointment", () => {
    const future = appt({
      scheduled_for: new Date(Date.now() + HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
    });
    assert.equal(needsCompletionReview(future, []), false);
  });
  test("true for a past, non-cancelled appointment with no assignments at all", () => {
    assert.equal(needsCompletionReview(appt(), []), true);
  });
  test("true for a past appointment where Job Tracking was started but never completed", () => {
    assert.equal(needsCompletionReview(appt(), [assignment({ actual_completed_at: null })]), true);
  });
  test("false once the appointment is actually completed", () => {
    assert.equal(needsCompletionReview(appt(), [assignment()]), false);
  });
});

describe("isInDateRange", () => {
  test("true when the workspace-local date falls inside [start, end] inclusive", () => {
    const a = appt({ scheduled_for: "2026-08-15T15:00:00.000Z" }); // 11:00 AM America/New_York
    assert.equal(isInDateRange(a, "2026-08-15", "2026-08-15", TZ), true);
    assert.equal(isInDateRange(a, "2026-08-10", "2026-08-20", TZ), true);
  });
  test("false just outside the range", () => {
    const a = appt({ scheduled_for: "2026-08-15T15:00:00.000Z" });
    assert.equal(isInDateRange(a, "2026-08-16", "2026-08-20", TZ), false);
    assert.equal(isInDateRange(a, "2026-08-01", "2026-08-14", TZ), false);
  });
  test("timezone boundary: an instant just after UTC midnight is still the PREVIOUS day in America/New_York", () => {
    // 2026-08-16T02:00:00Z = 2026-08-15 10:00 PM in America/New_York (UTC-4, EDT).
    const a = appt({ scheduled_for: "2026-08-16T02:00:00.000Z" });
    assert.equal(isInDateRange(a, "2026-08-15", "2026-08-15", TZ), true);
    assert.equal(isInDateRange(a, "2026-08-16", "2026-08-16", TZ), false);
  });
});

describe("normalizeInvoiceNumber", () => {
  test("trims whitespace", () => assert.equal(normalizeInvoiceNumber("  INV-102  "), "INV-102"));
  test("blank/whitespace-only -> null", () => {
    assert.equal(normalizeInvoiceNumber(""), null);
    assert.equal(normalizeInvoiceNumber("   "), null);
  });
  test("null/undefined -> null", () => {
    assert.equal(normalizeInvoiceNumber(null), null);
    assert.equal(normalizeInvoiceNumber(undefined), null);
  });
});

describe("isValidPaymentMethod", () => {
  test("accepts exactly the five approved values", () => {
    for (const v of ["zelle", "check", "cash", "quickbooks_card", "other"]) assert.equal(isValidPaymentMethod(v), true);
  });
  test("rejects anything else", () => {
    for (const v of ["Zelle", "venmo", "", null, undefined, 123]) assert.equal(isValidPaymentMethod(v), false);
  });
});

describe("validateBillingState", () => {
  test("paid=false with no payment_method is valid", () => {
    assert.deepEqual(validateBillingState({ paid: false, payment_method: null }), { ok: true });
  });
  test("paid=true with a valid payment_method is valid", () => {
    assert.deepEqual(validateBillingState({ paid: true, payment_method: "zelle" }), { ok: true });
  });
  test("paid=true with no payment_method is rejected with a clear, owner-friendly message", () => {
    const result = validateBillingState({ paid: true, payment_method: null });
    assert.equal(result.ok, false);
    assert.match((result as { ok: false; error: string }).error, /payment method is required/i);
  });
  test("an unrecognized payment_method is rejected regardless of paid", () => {
    assert.equal(validateBillingState({ paid: false, payment_method: "venmo" }).ok, false);
  });
});

describe("buildCompletedJobRows", () => {
  test("includes only appointments that are completed, non-cancelled, and in range", () => {
    const completed = appt({ id: "a1" });
    const cancelled = appt({ id: "a2", status: "cancelled" });
    const notCompleted = appt({ id: "a3" });
    const outOfRange = appt({ id: "a4", scheduled_for: "2026-01-01T12:00:00.000Z", scheduled_end: "2026-01-01T13:00:00.000Z" });

    const assignmentsByAppointmentId = new Map([
      ["a1", [assignment({ appointment_id: "a1" })]],
      ["a2", [assignment({ appointment_id: "a2" })]],
      ["a3", [assignment({ appointment_id: "a3", actual_completed_at: null })]],
      ["a4", [assignment({ appointment_id: "a4" })]],
    ]);

    const today = appt({ id: "a1" }).scheduled_for.slice(0, 10);
    const rows = buildCompletedJobRows({
      appointments: [completed, cancelled, notCompleted, outOfRange],
      clients: [client()],
      assignmentsByAppointmentId,
      billingByAppointmentId: new Map(),
      rangeStart: today,
      rangeEnd: today,
      timezone: TZ,
    });

    assert.deepEqual(rows.map((r) => r.appointmentId), ["a1"]);
  });

  test("amount comes from the appointment's own price_cents snapshot, never recomputed", () => {
    const a = appt({ price_cents: 4999 });
    const rangeDate = a.scheduled_for.slice(0, 10);
    const rows = buildCompletedJobRows({
      appointments: [a],
      clients: [client()],
      assignmentsByAppointmentId: new Map([["appt-1", [assignment()]]]),
      billingByAppointmentId: new Map(),
      rangeStart: rangeDate,
      rangeEnd: rangeDate,
      timezone: TZ,
    });
    assert.equal(rows[0].priceCents, 4999);
  });

  test("a null price_cents is preserved as null (never guessed/defaulted at this layer)", () => {
    const a = appt({ price_cents: null });
    const rangeDate = a.scheduled_for.slice(0, 10);
    const rows = buildCompletedJobRows({
      appointments: [a],
      clients: [client()],
      assignmentsByAppointmentId: new Map([["appt-1", [assignment()]]]),
      billingByAppointmentId: new Map(),
      rangeStart: rangeDate,
      rangeEnd: rangeDate,
      timezone: TZ,
    });
    assert.equal(rows[0].priceCents, null);
  });

  test("joins the matching billing row when one exists, and resolves the client name", () => {
    const a = appt();
    const rangeDate = a.scheduled_for.slice(0, 10);
    const rows = buildCompletedJobRows({
      appointments: [a],
      clients: [client({ id: "client-1", name: "Wren Castellan" })],
      assignmentsByAppointmentId: new Map([["appt-1", [assignment()]]]),
      billingByAppointmentId: new Map([["appt-1", billing({ invoice_number: "INV-1", paid: true, payment_method: "zelle" })]]),
      rangeStart: rangeDate,
      rangeEnd: rangeDate,
      timezone: TZ,
    });
    assert.equal(rows[0].clientName, "Wren Castellan");
    assert.equal(rows[0].billing?.invoice_number, "INV-1");
  });

  test("billing is null when no row has been created yet for that appointment", () => {
    const a = appt();
    const rangeDate = a.scheduled_for.slice(0, 10);
    const rows = buildCompletedJobRows({
      appointments: [a],
      clients: [client()],
      assignmentsByAppointmentId: new Map([["appt-1", [assignment()]]]),
      billingByAppointmentId: new Map(),
      rangeStart: rangeDate,
      rangeEnd: rangeDate,
      timezone: TZ,
    });
    assert.equal(rows[0].billing, null);
  });
});

describe("buildReviewNeededRows", () => {
  test("lists past, non-cancelled, not-yet-completed appointments in range, and excludes completed/cancelled/future ones", () => {
    const needsReview = appt({ id: "a1" }); // past, no assignments
    const completed = appt({ id: "a2" });
    const cancelled = appt({ id: "a3", status: "cancelled" });
    const future = appt({ id: "a4", scheduled_for: new Date(Date.now() + HOUR_MS).toISOString(), scheduled_end: new Date(Date.now() + 2 * HOUR_MS).toISOString() });

    const assignmentsByAppointmentId = new Map([["a2", [assignment({ appointment_id: "a2" })]]]);
    const rangeDate = needsReview.scheduled_for.slice(0, 10);

    const rows = buildReviewNeededRows({
      appointments: [needsReview, completed, cancelled, future],
      clients: [client()],
      assignmentsByAppointmentId,
      rangeStart: rangeDate,
      rangeEnd: rangeDate,
      timezone: TZ,
    });

    assert.deepEqual(rows.map((r) => r.appointmentId), ["a1"]);
  });
});

describe("applyBillingStatusFilter", () => {
  const missingInvoice = { appointmentId: "a1", serviceDate: "2026-01-01", scheduledFor: "x", clientId: "c1", clientName: "A", serviceType: "s", priceCents: 100, billing: null };
  const invoicedUnpaid = { ...missingInvoice, appointmentId: "a2", billing: billing({ appointment_id: "a2", invoice_number: "INV-2", paid: false }) };
  const paid = { ...missingInvoice, appointmentId: "a3", billing: billing({ appointment_id: "a3", invoice_number: "INV-3", paid: true, payment_method: "cash" }) };
  const rows = [missingInvoice, invoicedUnpaid, paid];

  test('"all" returns everything, unfiltered', () => {
    assert.equal(applyBillingStatusFilter(rows, "all").length, 3);
  });
  test('"missing_invoice" -- no billing row, or billing row with no invoice_number', () => {
    assert.deepEqual(applyBillingStatusFilter(rows, "missing_invoice").map((r) => r.appointmentId), ["a1"]);
  });
  test('"invoiced_unpaid" -- has an invoice number but paid is false', () => {
    assert.deepEqual(applyBillingStatusFilter(rows, "invoiced_unpaid").map((r) => r.appointmentId), ["a2"]);
  });
  test('"paid" -- billing.paid is true', () => {
    assert.deepEqual(applyBillingStatusFilter(rows, "paid").map((r) => r.appointmentId), ["a3"]);
  });
});

describe("computeBillingSummary", () => {
  test("Completed Jobs is the row count; Completed Work $ sums every row's price (missing price = $0)", () => {
    const rows = [
      { appointmentId: "a1", serviceDate: "x", scheduledFor: "x", clientId: "c", clientName: "A", serviceType: "s", priceCents: 10000, billing: null },
      { appointmentId: "a2", serviceDate: "x", scheduledFor: "x", clientId: "c", clientName: "A", serviceType: "s", priceCents: null, billing: null },
    ];
    const summary = computeBillingSummary(rows);
    assert.equal(summary.completedJobs, 2);
    assert.equal(summary.completedWorkCents, 10000);
  });

  test("Invoiced $ sums only rows with a non-blank invoice number; Unpaid $ is the invoiced-but-not-paid subset", () => {
    const noInvoice = { appointmentId: "a1", serviceDate: "x", scheduledFor: "x", clientId: "c", clientName: "A", serviceType: "s", priceCents: 5000, billing: null };
    const invoicedUnpaid = { ...noInvoice, appointmentId: "a2", priceCents: 7000, billing: billing({ appointment_id: "a2", invoice_number: "INV-2", paid: false }) };
    const invoicedPaid = { ...noInvoice, appointmentId: "a3", priceCents: 3000, billing: billing({ appointment_id: "a3", invoice_number: "INV-3", paid: true, payment_method: "zelle" }) };

    const summary = computeBillingSummary([noInvoice, invoicedUnpaid, invoicedPaid]);
    assert.equal(summary.completedWorkCents, 15000);
    assert.equal(summary.invoicedCents, 10000); // 7000 + 3000, not the un-invoiced 5000
    assert.equal(summary.unpaidCents, 7000); // only the invoiced-but-unpaid one
  });

  test("an empty list produces all-zero totals, not an error", () => {
    assert.deepEqual(computeBillingSummary([]), { completedJobs: 0, completedWorkCents: 0, invoicedCents: 0, unpaidCents: 0 });
  });
});
