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
  matchesClientSearch,
  type CompletedJobBilling,
} from "./completedJobBilling.ts";
import type { Appointment, Client, AppointmentEmployeeAssignment, EmployeeHours } from "@/app/components/dashboard/types";

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

function hoursEntry(overrides: Partial<EmployeeHours> = {}): EmployeeHours {
  return {
    id: "hrs-1",
    appointment_id: "appt-1",
    employee_id: "emp-1",
    hours_worked: 3,
    note: "forgot cell at home",
    created_at: "2026-09-23T00:00:00.000Z",
    updated_at: "2026-09-23T00:00:00.000Z",
    ...overrides,
  };
}

function billing(overrides: Partial<CompletedJobBilling> = {}): CompletedJobBilling {
  return {
    id: "bill-1",
    workspace_id: "ws-1",
    appointment_id: "appt-1",
    client_id: "client-1",
    invoice_number: null,
    paid: false,
    payment_method: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("isCompletedForBilling", () => {
  test("1. tracked start+complete -> billing completed", () => {
    assert.equal(isCompletedForBilling("appt-1", [assignment()], []), true);
  });
  test("false with zero assignments (never vacuously completed)", () => {
    assert.equal(isCompletedForBilling("appt-1", [], []), false);
  });
  test("false when started but not completed, and no owner override exists", () => {
    assert.equal(isCompletedForBilling("appt-1", [assignment({ actual_completed_at: null })], []), false);
  });
  test("false when one of two assigned employees hasn't finished and has no override", () => {
    assert.equal(
      isCompletedForBilling(
        "appt-1",
        [assignment(), assignment({ id: "ae-2", employee_id: "emp-2", actual_completed_at: null })],
        []
      ),
      false
    );
  });

  // Real production gap: an employee who forgot to use Start Job/Complete
  // Job (no tracking timestamps at all), whose worked time the owner later
  // corrected manually via appointment_employee_hours -- see this module's
  // own header comment and lib/payroll.ts's isAppointmentBillingEligible
  // for the full reasoning.
  test("2. no tracking + owner-approved worked time -> billing completed (Holly/Roxana scenario)", () => {
    const untracked = assignment({ actual_started_at: null, actual_completed_at: null });
    assert.equal(isCompletedForBilling("appt-1", [untracked], [hoursEntry()]), true);
  });

  test("3. no tracking + no owner override -> NOT billing completed", () => {
    const untracked = assignment({ actual_started_at: null, actual_completed_at: null });
    assert.equal(isCompletedForBilling("appt-1", [untracked], []), false);
  });

  test("4. multi-employee: all tracked -> billing completed", () => {
    const a1 = assignment({ id: "ae-1", employee_id: "emp-1" });
    const a2 = assignment({ id: "ae-2", employee_id: "emp-2" });
    assert.equal(isCompletedForBilling("appt-1", [a1, a2], []), true);
  });

  test("5. multi-employee: mix of tracked + owner override -> billing completed", () => {
    const tracked = assignment({ id: "ae-1", employee_id: "emp-1" });
    const untracked = assignment({ id: "ae-2", employee_id: "emp-2", actual_started_at: null, actual_completed_at: null });
    const override = hoursEntry({ employee_id: "emp-2" });
    assert.equal(isCompletedForBilling("appt-1", [tracked, untracked], [override]), true);
  });

  test("6. multi-employee: one unresolved employee (no tracking, no override) -> NOT billing completed", () => {
    const tracked = assignment({ id: "ae-1", employee_id: "emp-1" });
    const unresolved = assignment({ id: "ae-2", employee_id: "emp-2", actual_started_at: null, actual_completed_at: null });
    assert.equal(isCompletedForBilling("appt-1", [tracked, unresolved], []), false);
  });

  test("7. the owner override never mutates/fabricates actual_started_at or actual_completed_at", () => {
    const untracked = assignment({ actual_started_at: null, actual_completed_at: null });
    isCompletedForBilling("appt-1", [untracked], [hoursEntry()]);
    assert.equal(untracked.actual_started_at, null);
    assert.equal(untracked.actual_completed_at, null);
  });
});

describe("needsCompletionReview", () => {
  test("false for a cancelled appointment, even if past and untracked", () => {
    assert.equal(needsCompletionReview(appt({ status: "cancelled" }), [], []), false);
  });
  test("false for a future (not-yet-eligible) appointment", () => {
    const future = appt({
      scheduled_for: new Date(Date.now() + HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
    });
    assert.equal(needsCompletionReview(future, [], []), false);
  });
  test("true for a past, non-cancelled appointment with no assignments at all", () => {
    assert.equal(needsCompletionReview(appt(), [], []), true);
  });
  test("3. true for a past appointment where Job Tracking was started but never completed, and no owner override exists", () => {
    assert.equal(needsCompletionReview(appt(), [assignment({ actual_completed_at: null })], []), true);
  });
  test("false once the appointment is actually completed (Job Tracking)", () => {
    assert.equal(needsCompletionReview(appt(), [assignment()], []), false);
  });
  test("2. false once the appointment is resolved via an owner-approved worked-time override, even with no tracking at all (Holly/Roxana scenario)", () => {
    const untracked = assignment({ actual_started_at: null, actual_completed_at: null });
    assert.equal(needsCompletionReview(appt(), [untracked], [hoursEntry()]), false);
  });
  test("6. multi-employee: one unresolved employee keeps the appointment in completion review, even though another is tracked", () => {
    const tracked = assignment({ id: "ae-1", employee_id: "emp-1" });
    const unresolved = assignment({ id: "ae-2", employee_id: "emp-2", actual_started_at: null, actual_completed_at: null });
    assert.equal(needsCompletionReview(appt(), [tracked, unresolved], []), true);
  });
});

// 8. Holly-style scenario, end to end: a real completed job whose one
// assigned employee (Roxana) never used Job Tracking at all, and whose
// worked time the owner corrected afterward (3h00m, "forgot cell at
// home") -- exactly the real production gap this fix addresses. Must
// appear in Billing / Completed Jobs, using the appointment's existing
// price, and must NOT appear in "Past jobs needing completion review".
describe("Holly Williams Sep 23 -- real-world regression (owner-approved override resolves missing tracking for Billing)", () => {
  function hollyAppt(): Appointment {
    return appt({
      id: "holly-appt",
      client_id: "client-holly",
      service_type: "Regular Cleaning",
      scheduled_for: "2026-09-23T17:00:00.000Z",
      scheduled_end: "2026-09-23T20:00:00.000Z",
      price_cents: 18000,
    });
  }
  function hollyAssignment(): AppointmentEmployeeAssignment {
    return assignment({
      id: "ae-roxana",
      appointment_id: "holly-appt",
      employee_id: "roxana",
      actual_started_at: null,
      actual_completed_at: null,
    });
  }
  function hollyOverride(): EmployeeHours {
    return hoursEntry({ appointment_id: "holly-appt", employee_id: "roxana", hours_worked: 3, note: "forgot cell at home" });
  }

  test("appears in Billing / Completed Jobs, using the appointment's existing price", () => {
    const rangeDate = "2026-09-23";
    const rows = buildCompletedJobRows({
      appointments: [hollyAppt()],
      clients: [client({ id: "client-holly", name: "Holly Williams" })],
      assignmentsByAppointmentId: new Map([["holly-appt", [hollyAssignment()]]]),
      billingByAppointmentId: new Map(),
      employeeHours: [hollyOverride()],
      rangeStart: rangeDate,
      rangeEnd: rangeDate,
      timezone: TZ,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].appointmentId, "holly-appt");
    assert.equal(rows[0].clientName, "Holly Williams");
    assert.equal(rows[0].priceCents, 18000);
  });

  test("does NOT appear in Past jobs needing completion review", () => {
    const rangeDate = "2026-09-23";
    const rows = buildReviewNeededRows({
      appointments: [hollyAppt()],
      clients: [client({ id: "client-holly", name: "Holly Williams" })],
      assignmentsByAppointmentId: new Map([["holly-appt", [hollyAssignment()]]]),
      employeeHours: [hollyOverride()],
      rangeStart: rangeDate,
      rangeEnd: rangeDate,
      timezone: TZ,
    });
    assert.deepEqual(rows, []);
  });

  test("before the owner's override existed, the same appointment WOULD have been stuck in completion review (proves the fix actually changes the outcome)", () => {
    const rangeDate = "2026-09-23";
    const rows = buildReviewNeededRows({
      appointments: [hollyAppt()],
      clients: [client({ id: "client-holly", name: "Holly Williams" })],
      assignmentsByAppointmentId: new Map([["holly-appt", [hollyAssignment()]]]),
      employeeHours: [], // no override yet
      rangeStart: rangeDate,
      rangeEnd: rangeDate,
      timezone: TZ,
    });
    assert.deepEqual(rows.map((r) => r.appointmentId), ["holly-appt"]);
  });

  test("can receive invoice #, paid, and payment method normally once in the Completed Jobs list (validateBillingState is unaffected by this fix)", () => {
    assert.deepEqual(validateBillingState({ paid: true, payment_method: "zelle" }), { ok: true });
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

  // Real production rule (Holly Williams, paid Cash): for a cash job the
  // owner does not always create a QuickBooks invoice -- paid=true with a
  // blank invoice_number is a legitimate final state, never an error. This
  // function doesn't even take invoice_number as an input, so there is
  // nothing here to make it "required" by accident -- documented
  // explicitly so a future change doesn't add that requirement.
  test("paid=true with payment_method='cash' is valid on its own -- this function has no invoice_number input, so it can never require one", () => {
    assert.deepEqual(validateBillingState({ paid: true, payment_method: "cash" }), { ok: true });
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
      employeeHours: [],
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
      employeeHours: [],
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
      employeeHours: [],
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
      employeeHours: [],
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
      employeeHours: [],
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
      employeeHours: [],
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
  // Real production rule (Holly Williams): paid by Cash, no QuickBooks
  // invoice was ever created -- a legitimate final state, not "missing."
  const paidCashNoInvoice = { ...missingInvoice, appointmentId: "a4", billing: billing({ appointment_id: "a4", invoice_number: null, paid: true, payment_method: "cash" }) };
  const rows = [missingInvoice, invoicedUnpaid, paid, paidCashNoInvoice];

  test('"all" returns everything, unfiltered', () => {
    assert.equal(applyBillingStatusFilter(rows, "all").length, 4);
  });
  test('"missing_invoice" -- no billing row, or billing row with no invoice_number -- EXCLUDING a paid-Cash job that was never going to get one', () => {
    assert.deepEqual(applyBillingStatusFilter(rows, "missing_invoice").map((r) => r.appointmentId), ["a1"]);
  });
  test('"invoiced_unpaid" -- has an invoice number but paid is false', () => {
    assert.deepEqual(applyBillingStatusFilter(rows, "invoiced_unpaid").map((r) => r.appointmentId), ["a2"]);
  });
  test('"paid" -- billing.paid is true, including the paid-Cash/no-invoice job', () => {
    assert.deepEqual(applyBillingStatusFilter(rows, "paid").map((r) => r.appointmentId), ["a3", "a4"]);
  });

  test("regression: an ordinary unpaid, no-invoice job (not cash-paid) still appears in Missing Invoice # as before", () => {
    assert.ok(applyBillingStatusFilter(rows, "missing_invoice").some((r) => r.appointmentId === "a1"));
  });

  test("regression: a non-cash paid+invoiced job behaves exactly as before -- not affected by the cash carve-out", () => {
    const zellePaid = { ...missingInvoice, appointmentId: "a5", billing: billing({ appointment_id: "a5", invoice_number: "INV-5", paid: true, payment_method: "zelle" }) };
    const withZelle = [...rows, zellePaid];
    assert.deepEqual(applyBillingStatusFilter(withZelle, "missing_invoice").map((r) => r.appointmentId), ["a1"]);
    assert.deepEqual(applyBillingStatusFilter(withZelle, "paid").map((r) => r.appointmentId), ["a3", "a4", "a5"]);
  });
});

describe("matchesClientSearch", () => {
  test("a blank or whitespace-only query matches every name", () => {
    assert.equal(matchesClientSearch("Holly Williams", ""), true);
    assert.equal(matchesClientSearch("Holly Williams", "   "), true);
  });

  test("partial, case-insensitive substring match -- \"hol\" matches \"Holly Williams\"", () => {
    assert.equal(matchesClientSearch("Holly Williams", "hol"), true);
    assert.equal(matchesClientSearch("Holly Williams", "HOL"), true);
  });

  test('"tam" matches both "Tammy Owens" and "Tami Factor"', () => {
    assert.equal(matchesClientSearch("Tammy Owens", "tam"), true);
    assert.equal(matchesClientSearch("Tami Factor", "tam"), true);
  });

  test("a non-matching query returns false", () => {
    assert.equal(matchesClientSearch("Holly Williams", "zzz"), false);
  });

  test("leading/trailing whitespace in the query is trimmed before matching", () => {
    assert.equal(matchesClientSearch("Holly Williams", "  hol  "), true);
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

  // Real production rule (Holly Williams, $120 paid Cash, no invoice):
  // Completed Work $ still includes her price; Invoiced $ and Unpaid $
  // both correctly ignore her, since no invoice was ever created.
  test("a paid-Cash job with no invoice number: counted in Completed Work $, excluded from both Invoiced $ and Unpaid $", () => {
    const holly = { appointmentId: "holly-appt", serviceDate: "2026-09-23", scheduledFor: "x", clientId: "c", clientName: "Holly Williams", serviceType: "Regular Cleaning", priceCents: 12000, billing: billing({ appointment_id: "holly-appt", invoice_number: null, paid: true, payment_method: "cash" }) };
    const summary = computeBillingSummary([holly]);
    assert.equal(summary.completedJobs, 1);
    assert.equal(summary.completedWorkCents, 12000, "Holly's $120 belongs in Completed Work $");
    assert.equal(summary.invoicedCents, 0, "no invoice was ever created -- must not inflate Invoiced $");
    assert.equal(summary.unpaidCents, 0, "she IS paid -- must not appear in Unpaid $ either");
  });

  test("an empty list produces all-zero totals, not an error", () => {
    assert.deepEqual(computeBillingSummary([]), { completedJobs: 0, completedWorkCents: 0, invoicedCents: 0, unpaidCents: 0 });
  });

  // Migration 033 (Beth Holcomb, three jobs under one invoice, marked Paid
  // as a group via upsert_completed_job_billing -- see
  // app/api/billing/completed-jobs/update/route.ts and
  // test-db/completed_job_billing.test.ts for where the actual sync is
  // proven). This function itself knows nothing about "invoice groups" --
  // it only sums per-row paid/invoice_number exactly as before. This test
  // proves that once the underlying rows are ACTUALLY synced (which is the
  // whole point of migration 033), the existing summary math produces the
  // correct result on its own, with no group-aware logic needed here: none
  // of a paid grouped invoice's rows leak into Unpaid $.
  test("once a shared-invoice group's rows are synced consistently (paid), none of them appear in Unpaid $ -- Invoiced $ reflects the whole group", () => {
    const job1 = { appointmentId: "beth-1", serviceDate: "2026-06-24", scheduledFor: "x", clientId: "beth", clientName: "Beth Holcomb", serviceType: "Regular Cleaning", priceCents: 12000, billing: billing({ appointment_id: "beth-1", client_id: "beth", invoice_number: "13422", paid: true, payment_method: "zelle" }) };
    const job2 = { ...job1, appointmentId: "beth-2", serviceDate: "2026-07-08", priceCents: 12000, billing: billing({ appointment_id: "beth-2", client_id: "beth", invoice_number: "13422", paid: true, payment_method: "zelle" }) };
    const job3 = { ...job1, appointmentId: "beth-3", serviceDate: "2026-07-22", priceCents: 12000, billing: billing({ appointment_id: "beth-3", client_id: "beth", invoice_number: "13422", paid: true, payment_method: "zelle" }) };

    const summary = computeBillingSummary([job1, job2, job3]);
    assert.equal(summary.completedWorkCents, 36000);
    assert.equal(summary.invoicedCents, 36000, "the whole group is invoiced");
    assert.equal(summary.unpaidCents, 0, "every row in the paid group must be excluded from Unpaid $, not just some of them");
  });
});

// Real production rule, end to end: Holly Williams paid Cash with no
// QuickBooks invoice is a valid, financially-closed final state -- never
// an error, never flagged as incomplete, and the completed-row build
// itself needs no special handling (buildCompletedJobRows already just
// joins whatever billing row exists, however it's shaped).
describe("Holly Williams -- paid Cash, no invoice (real production rule)", () => {
  function hollyAppt(): Appointment {
    return appt({ id: "holly-appt", client_id: "client-holly", scheduled_for: "2026-09-23T17:00:00.000Z", scheduled_end: "2026-09-23T20:00:00.000Z", price_cents: 12000 });
  }
  function hollyBillingRow(): CompletedJobBilling {
    return billing({ appointment_id: "holly-appt", invoice_number: null, paid: true, payment_method: "cash" });
  }

  test("valid final state -- appears normally in Billing / Completed Jobs, no error", () => {
    const rangeDate = "2026-09-23";
    const rows = buildCompletedJobRows({
      appointments: [hollyAppt()],
      clients: [client({ id: "client-holly", name: "Holly Williams" })],
      assignmentsByAppointmentId: new Map([["holly-appt", [assignment({ appointment_id: "holly-appt" })]]]),
      billingByAppointmentId: new Map([["holly-appt", hollyBillingRow()]]),
      employeeHours: [],
      rangeStart: rangeDate,
      rangeEnd: rangeDate,
      timezone: TZ,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].billing?.paid, true);
    assert.equal(rows[0].billing?.invoice_number, null);
    assert.equal(rows[0].billing?.payment_method, "cash");
  });
});
