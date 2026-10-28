import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import {
  buildNeedsAttentionEntries,
  NEEDS_ATTENTION_LOOKBACK_DAYS,
} from "./needsAttention.ts";
import type { BillableAppointment, CompletedJobBilling } from "./completedJobBilling.ts";
import type { Client, AppointmentEmployeeAssignment, EmployeeHours } from "@/app/components/dashboard/types";

// Frozen clock (same technique as app/components/dashboard/
// statusDisplayConsistency.render.test.ts and lib/payroll.test.ts's own
// fixed NOW constants) -- every "past"/"in range" relationship below is
// computed against this fixed instant, never the real wall clock, so this
// suite can never flip from pass to fail just because the calendar moved
// on. Safely after every "past" fixture date and before the one deliberate
// "future appointment" fixture (2026-08-25).
mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-20T18:00:00.000Z").getTime() });

const TZ = "America/New_York";
const RANGE_END = "2026-08-20"; // business-local "today" for this frozen clock

function appt(overrides: Partial<BillableAppointment> = {}): BillableAppointment {
  return {
    id: "appt-1",
    client_id: "client-1",
    service_type: "Regular Cleaning",
    scheduled_for: "2026-08-12T13:00:00.000Z",
    scheduled_end: "2026-08-12T14:00:00.000Z",
    duration_minutes: 60,
    status: "scheduled",
    price_cents: 15000,
    ...overrides,
  };
}

function assignment(overrides: Partial<AppointmentEmployeeAssignment> = {}): AppointmentEmployeeAssignment {
  return {
    id: "ae-1",
    appointment_id: "appt-1",
    employee_id: "emp-1",
    actual_started_at: null,
    actual_completed_at: null,
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
    client_id: "client-1",
    invoice_number: null,
    paid: false,
    payment_method: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function assignmentsMap(list: AppointmentEmployeeAssignment[]): Map<string, AppointmentEmployeeAssignment[]> {
  const m = new Map<string, AppointmentEmployeeAssignment[]>();
  for (const a of list) {
    const existing = m.get(a.appointment_id);
    if (existing) existing.push(a);
    else m.set(a.appointment_id, [a]);
  }
  return m;
}

function billingMap(list: CompletedJobBilling[]): Map<string, CompletedJobBilling> {
  return new Map(list.map((b) => [b.appointment_id, b]));
}

function baseArgs(overrides: Partial<Parameters<typeof buildNeedsAttentionEntries>[0]> = {}) {
  return {
    appointments: [],
    clients: [],
    assignmentsByAppointmentId: new Map(),
    billingByAppointmentId: new Map(),
    employeeHours: [] as EmployeeHours[],
    failedMessageCountsByAppointmentId: new Map<string, number>(),
    rangeEnd: RANGE_END,
    timezone: TZ,
    ...overrides,
  };
}

describe("NEEDS_ATTENTION_LOOKBACK_DAYS", () => {
  test("is a sensible bounded window, not unbounded history", () => {
    assert.equal(typeof NEEDS_ATTENTION_LOOKBACK_DAYS, "number");
    assert.ok(NEEDS_ATTENTION_LOOKBACK_DAYS > 0 && NEEDS_ATTENTION_LOOKBACK_DAYS <= 365);
  });
});

describe("buildNeedsAttentionEntries -- item 1: worked-time review (reuses buildReviewNeededRows/needsCompletionReview verbatim)", () => {
  test("a past, non-cancelled appointment with an unresolved (never tracked, never corrected) assignment is flagged", () => {
    const a = appt({ id: "appt-untracked", status: "scheduled" });
    const asg = assignment({ appointment_id: "appt-untracked" });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]),
    }));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].appointmentId, "appt-untracked");
    assert.deepEqual(entries[0].issues, [{ kind: "worked_time_review", label: "Worked time needs review" }]);
  });

  test("an appointment whose owner correction ALREADY resolves every assigned employee's work is never flagged for worked-time review (it becomes billing-eligible instead, a separate concern -- see the invoicing describe block below)", () => {
    const a = appt({ id: "appt-corrected", status: "scheduled" });
    const asg = assignment({ appointment_id: "appt-corrected" });
    const hours: EmployeeHours = {
      id: "h1", appointment_id: "appt-corrected", employee_id: "emp-1", hours_worked: 2, note: "forgot to clock in",
      created_at: "2026-08-12T00:00:00.000Z", updated_at: "2026-08-12T00:00:00.000Z",
    };
    // Also closed for item 2 (paid + invoiced) so this test isolates
    // purely to item 1's own behavior -- an owner correction resolving
    // worked time makes the job billing-eligible, which (correctly, and
    // covered separately below) surfaces its OWN "Needs invoice number"
    // issue if nothing has been invoiced yet; that is not what this test
    // is about.
    const b = billing({ appointment_id: "appt-corrected", invoice_number: "INV-1", paid: true, payment_method: "zelle" });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]), employeeHours: [hours],
      billingByAppointmentId: billingMap([b]),
    }));
    assert.equal(entries.length, 0, "an owner-corrected, already-invoiced-and-paid appointment must not appear at all");
  });

  test("an owner correction that resolves worked time, with NO billing row yet, is flagged for invoicing, NOT worked-time review -- the two issues are mutually exclusive by definition", () => {
    const a = appt({ id: "appt-corrected-unbilled", status: "scheduled" });
    const asg = assignment({ appointment_id: "appt-corrected-unbilled" });
    const hours: EmployeeHours = {
      id: "h2", appointment_id: "appt-corrected-unbilled", employee_id: "emp-1", hours_worked: 2, note: "forgot to clock in",
      created_at: "2026-08-12T00:00:00.000Z", updated_at: "2026-08-12T00:00:00.000Z",
    };
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]), employeeHours: [hours],
    }));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].issues.map((i) => i.kind), ["needs_invoicing"]);
  });

  test("a cancelled appointment is never flagged for worked-time review", () => {
    const a = appt({ id: "appt-cancelled", status: "cancelled" });
    const asg = assignment({ appointment_id: "appt-cancelled" });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]),
    }));
    assert.equal(entries.length, 0);
  });

  test("a future (not yet elapsed) appointment is never flagged", () => {
    const a = appt({ id: "appt-future", status: "scheduled", scheduled_for: "2026-08-25T13:00:00.000Z", scheduled_end: "2026-08-25T14:00:00.000Z" });
    const asg = assignment({ appointment_id: "appt-future" });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]), rangeEnd: "2026-08-26",
    }));
    assert.equal(entries.length, 0);
  });
});

describe("buildNeedsAttentionEntries -- item 2: billing (needs invoicing / payment outstanding, mutually exclusive, reuses buildCompletedJobRows + applyBillingStatusFilter verbatim)", () => {
  function completedAppt(id: string): { a: BillableAppointment; asg: AppointmentEmployeeAssignment } {
    const a = appt({ id, status: "scheduled" });
    const asg = assignment({
      appointment_id: id,
      actual_started_at: "2026-08-12T13:00:00.000Z",
      actual_completed_at: "2026-08-12T14:00:00.000Z",
    });
    return { a, asg };
  }

  test("a completed job with no invoice number is flagged \"Needs invoice number\"", () => {
    const { a, asg } = completedAppt("appt-no-invoice");
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]),
    }));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].issues, [{ kind: "needs_invoicing", label: "Needs invoice number" }]);
  });

  test("a completed job that's invoiced but not yet paid is flagged \"Payment outstanding\" -- a DISTINCT issue from \"Needs invoice number\", never both at once", () => {
    const { a, asg } = completedAppt("appt-invoiced-unpaid");
    const b = billing({ appointment_id: "appt-invoiced-unpaid", invoice_number: "INV-1", paid: false });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]), billingByAppointmentId: billingMap([b]),
    }));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].issues, [{ kind: "payment_outstanding", label: "Payment outstanding" }]);
  });

  test("a fully paid, invoiced job is NOT flagged with either billing issue", () => {
    const { a, asg } = completedAppt("appt-paid");
    const b = billing({ appointment_id: "appt-paid", invoice_number: "INV-2", paid: true, payment_method: "zelle" });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]), billingByAppointmentId: billingMap([b]),
    }));
    assert.equal(entries.length, 0);
  });

  // Regression: the full lifecycle of a single job, one state at a time --
  // the EXACT same appointment/assignment fixture, only the billing row
  // changes between calls, matching how a real job progresses: no billing
  // row yet -> invoiced -> paid.
  test("the full missing-invoice -> invoiced/unpaid -> paid lifecycle: exactly one issue (or none) at each stage, never two at once", () => {
    const { a, asg } = completedAppt("appt-lifecycle");
    const clients_ = [client()];
    const assignments = assignmentsMap([asg]);

    const stage1 = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: clients_, assignmentsByAppointmentId: assignments, billingByAppointmentId: new Map(),
    }));
    assert.deepEqual(stage1[0].issues.map((i) => i.kind), ["needs_invoicing"]);

    const invoicedUnpaid = billing({ appointment_id: "appt-lifecycle", invoice_number: "INV-9", paid: false });
    const stage2 = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: clients_, assignmentsByAppointmentId: assignments, billingByAppointmentId: billingMap([invoicedUnpaid]),
    }));
    assert.deepEqual(stage2[0].issues.map((i) => i.kind), ["payment_outstanding"]);

    const paid = billing({ appointment_id: "appt-lifecycle", invoice_number: "INV-9", paid: true, payment_method: "zelle" });
    const stage3 = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: clients_, assignmentsByAppointmentId: assignments, billingByAppointmentId: billingMap([paid]),
    }));
    assert.equal(stage3.length, 0, "a paid job has no entry at all once no other issue applies");
  });

  test("a paid-Cash job with no invoice (a legitimate closed state) is NOT flagged -- same carve-out as the Billing panel's own filter", () => {
    const { a, asg } = completedAppt("appt-cash-closed");
    const b = billing({ appointment_id: "appt-cash-closed", invoice_number: null, paid: true, payment_method: "cash" });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]), billingByAppointmentId: billingMap([b]),
    }));
    assert.equal(entries.length, 0);
  });

  test("a job not yet billing-eligible (worked time unresolved) is NOT flagged for invoicing -- it's a worked-time-review issue instead, not both", () => {
    const a = appt({ id: "appt-unresolved", status: "scheduled" });
    const asg = assignment({ appointment_id: "appt-unresolved" }); // never tracked
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]),
    }));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].issues.map((i) => i.kind), ["worked_time_review"]);
  });
});

describe("buildNeedsAttentionEntries -- destination-permission gate (includeInvoicing)", () => {
  test("includeInvoicing: false (tester/demo sessions, or the mobile surface) never generates a needs_invoicing issue, even for an otherwise-eligible job", () => {
    const { a, asg } = completedAppt("appt-no-invoice-excluded");
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]), includeInvoicing: false,
    }));
    assert.equal(entries.length, 0, "no destination exists for this session/surface, so the issue is never generated at all");
  });

  test("includeInvoicing: false also never generates a payment_outstanding issue -- the same gate covers BOTH billing-destination issue kinds", () => {
    const { a, asg } = completedAppt("appt-payment-outstanding-excluded");
    const b = billing({ appointment_id: "appt-payment-outstanding-excluded", invoice_number: "INV-1", paid: false });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]), billingByAppointmentId: billingMap([b]),
      includeInvoicing: false,
    }));
    assert.equal(entries.length, 0, "no Billing destination exists for this session/surface, so payment_outstanding is never generated either");
  });

  test("includeInvoicing: false still allows worked-time-review and failed-message issues for the same appointment", () => {
    const a = appt({ id: "appt-mixed-no-invoicing", status: "scheduled" });
    const asg = assignment({ appointment_id: "appt-mixed-no-invoicing" }); // unresolved -> worked-time review
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]),
      failedMessageCountsByAppointmentId: new Map([["appt-mixed-no-invoicing", 1]]),
      includeInvoicing: false,
    }));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].issues.map((i) => i.kind).sort(), ["failed_message", "worked_time_review"]);
  });

  function completedAppt(id: string): { a: BillableAppointment; asg: AppointmentEmployeeAssignment } {
    const a = appt({ id, status: "scheduled" });
    const asg = assignment({
      appointment_id: id,
      actual_started_at: "2026-08-12T13:00:00.000Z",
      actual_completed_at: "2026-08-12T14:00:00.000Z",
    });
    return { a, asg };
  }
});

// An appointment fully "closed" for items 1 and 2 (resolved worked time,
// paid and invoiced) -- used by the item-3-only tests below so a failed-
// message assertion is never confounded by the SAME appointment also
// qualifying for worked-time review or invoicing (a zero-assignment past
// appointment, for instance, already qualifies for item 1 on its own --
// see needsCompletionReview's own doc comment).
function closedAppt(id: string): { a: BillableAppointment; asg: AppointmentEmployeeAssignment; b: CompletedJobBilling } {
  const a = appt({ id, status: "scheduled" });
  const asg = assignment({
    appointment_id: id,
    actual_started_at: "2026-08-12T13:00:00.000Z",
    actual_completed_at: "2026-08-12T14:00:00.000Z",
  });
  const b = billing({ appointment_id: id, invoice_number: "INV-CLOSED", paid: true, payment_method: "zelle" });
  return { a, asg, b };
}

describe("buildNeedsAttentionEntries -- item 3: failed messages (caller-classified, count-based, never inferred from absence)", () => {
  test("an appointment with a recorded failed-message count is flagged, with a singular label for exactly one", () => {
    const { a, asg, b } = closedAppt("appt-failed-msg");
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]), billingByAppointmentId: billingMap([b]),
      failedMessageCountsByAppointmentId: new Map([["appt-failed-msg", 1]]),
    }));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].issues, [{ kind: "failed_message", label: "1 failed message" }]);
  });

  test("multiple failed messages for the same appointment pluralize the label and still produce ONE issue entry (not one per message)", () => {
    const { a, asg, b } = closedAppt("appt-multi-failed");
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]), billingByAppointmentId: billingMap([b]),
      failedMessageCountsByAppointmentId: new Map([["appt-multi-failed", 3]]),
    }));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].issues, [{ kind: "failed_message", label: "3 failed messages" }]);
  });

  test("an appointment with NO message row at all is never flagged -- failure is never inferred from absence", () => {
    const { a, asg, b } = closedAppt("appt-no-messages");
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]), billingByAppointmentId: billingMap([b]),
      failedMessageCountsByAppointmentId: new Map(),
    }));
    assert.equal(entries.length, 0);
  });

  test("a zero count (defensive) is treated the same as absent -- never shown as a zero-count issue", () => {
    const { a, asg, b } = closedAppt("appt-zero-failed");
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]), billingByAppointmentId: billingMap([b]),
      failedMessageCountsByAppointmentId: new Map([["appt-zero-failed", 0]]),
    }));
    assert.equal(entries.length, 0);
  });

  test("a CANCELLED appointment can still be flagged for a failed message -- item 3 is not gated by cancellation the way items 1/2 are", () => {
    const a = appt({ id: "appt-cancelled-failed-msg", status: "cancelled" });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], failedMessageCountsByAppointmentId: new Map([["appt-cancelled-failed-msg", 1]]),
    }));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].issues, [{ kind: "failed_message", label: "1 failed message" }]);
  });

  test("a failed-message count for an appointment outside the already-scoped appointments list is silently ignored, never crashes", () => {
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [], clients: [], failedMessageCountsByAppointmentId: new Map([["appt-unknown", 2]]),
    }));
    assert.equal(entries.length, 0);
  });
});

describe("buildNeedsAttentionEntries -- grouping/deduplication: multiple issues for the SAME appointment collapse into ONE entry", () => {
  test("an appointment with both a worked-time-review issue AND a failed message appears exactly once, with both issues listed", () => {
    const a = appt({ id: "appt-multi-issue", status: "scheduled" });
    const asg = assignment({ appointment_id: "appt-multi-issue" }); // unresolved -> worked-time review
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]),
      failedMessageCountsByAppointmentId: new Map([["appt-multi-issue", 2]]),
    }));
    assert.equal(entries.length, 1, "exactly one entry, not two");
    assert.equal(entries[0].appointmentId, "appt-multi-issue");
    assert.deepEqual(entries[0].issues.map((i) => i.kind).sort(), ["failed_message", "worked_time_review"]);
  });

  test("an appointment needing invoicing AND with a failed message also collapses into one entry", () => {
    const a = appt({ id: "appt-invoice-and-failed", status: "scheduled" });
    const asg = assignment({
      appointment_id: "appt-invoice-and-failed",
      actual_started_at: "2026-08-12T13:00:00.000Z",
      actual_completed_at: "2026-08-12T14:00:00.000Z",
    });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]),
      failedMessageCountsByAppointmentId: new Map([["appt-invoice-and-failed", 1]]),
    }));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].issues.map((i) => i.kind).sort(), ["failed_message", "needs_invoicing"]);
  });

  test("an appointment with payment outstanding AND a failed message also collapses into one entry, and never also carries needs_invoicing", () => {
    const a = appt({ id: "appt-payment-and-failed", status: "scheduled" });
    const asg = assignment({
      appointment_id: "appt-payment-and-failed",
      actual_started_at: "2026-08-12T13:00:00.000Z",
      actual_completed_at: "2026-08-12T14:00:00.000Z",
    });
    const b = billing({ appointment_id: "appt-payment-and-failed", invoice_number: "INV-1", paid: false });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]), billingByAppointmentId: billingMap([b]),
      failedMessageCountsByAppointmentId: new Map([["appt-payment-and-failed", 1]]),
    }));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].issues.map((i) => i.kind).sort(), ["failed_message", "payment_outstanding"]);
  });

  test("the entry's own client/service fields are populated once, from the appointment and client fixtures, regardless of how many issues it has", () => {
    const a = appt({ id: "appt-fields", status: "scheduled", service_type: "Gutter Cleaning", scheduled_for: "2026-08-10T13:00:00.000Z" });
    const asg = assignment({ appointment_id: "appt-fields" });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client({ id: "client-1", name: "Priya Natarajan" })], assignmentsByAppointmentId: assignmentsMap([asg]),
      failedMessageCountsByAppointmentId: new Map([["appt-fields", 1]]),
    }));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].clientName, "Priya Natarajan");
    assert.equal(entries[0].serviceType, "Gutter Cleaning");
    assert.equal(entries[0].scheduledFor, "2026-08-10T13:00:00.000Z");
  });
});

describe("buildNeedsAttentionEntries -- the button count is the number of distinct appointments, not the number of issues", () => {
  test("three appointments, one with two issues, still produce exactly three entries", () => {
    const a1 = appt({ id: "a1", status: "scheduled" });
    const a2 = appt({ id: "a2", status: "scheduled", scheduled_for: "2026-08-13T13:00:00.000Z" });
    const { a: a3, asg: asg3, b: b3 } = closedAppt("a3"); // otherwise clean, so it has ONLY the failed-message issue
    const asg1 = assignment({ appointment_id: "a1" });
    const asg2 = assignment({ appointment_id: "a2" });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a1, a2, a3],
      clients: [client()],
      assignmentsByAppointmentId: assignmentsMap([asg1, asg2, asg3]),
      billingByAppointmentId: billingMap([b3]),
      failedMessageCountsByAppointmentId: new Map([["a1", 1]]), // a1 ALSO has a failed message; a3 has none yet
    }));
    assert.equal(entries.length, 2, "a1 and a2 only -- a3 has no issue in this first call");

    const entries2 = buildNeedsAttentionEntries(baseArgs({
      appointments: [a1, a2, a3],
      clients: [client()],
      assignmentsByAppointmentId: assignmentsMap([asg1, asg2, asg3]),
      billingByAppointmentId: billingMap([b3]),
      failedMessageCountsByAppointmentId: new Map([["a1", 1], ["a3", 1]]), // a3 now has its own failed-message issue too
    }));
    assert.equal(entries2.length, 3, "a1, a2, a3 -- a1 has two issues but is still ONE entry");
    const a1Entry = entries2.find((e) => e.appointmentId === "a1")!;
    assert.equal(a1Entry.issues.length, 2);
  });
});

describe("buildNeedsAttentionEntries -- sort order: oldest scheduledFor first", () => {
  test("entries are sorted ascending by scheduledFor, matching buildReviewNeededRows/buildCompletedJobRows' own convention", () => {
    const a1 = appt({ id: "a-late", status: "scheduled", scheduled_for: "2026-08-15T13:00:00.000Z" });
    const a2 = appt({ id: "a-early", status: "scheduled", scheduled_for: "2026-08-05T13:00:00.000Z" });
    const asg1 = assignment({ appointment_id: "a-late" });
    const asg2 = assignment({ appointment_id: "a-early" });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a1, a2], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg1, asg2]),
    }));
    assert.deepEqual(entries.map((e) => e.appointmentId), ["a-early", "a-late"]);
  });

  test("two appointments sharing the exact same scheduledFor break the tie by appointmentId, deterministically regardless of input order", () => {
    const SAME_INSTANT = "2026-08-15T13:00:00.000Z";
    const aZ = appt({ id: "appt-zzz", status: "scheduled", scheduled_for: SAME_INSTANT });
    const aA = appt({ id: "appt-aaa", status: "scheduled", scheduled_for: SAME_INSTANT });
    const asgZ = assignment({ appointment_id: "appt-zzz" });
    const asgA = assignment({ appointment_id: "appt-aaa" });

    // Fed in "z-then-a" order (the opposite of the expected tiebreak) --
    // the DB-batch fetch order (e.g. `.order("id")` across paginated
    // calls) is a real source of this kind of insertion-order variance
    // across two separately-requested JSON pages, so the sort itself must
    // not depend on it.
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [aZ, aA], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asgZ, asgA]),
    }));
    assert.deepEqual(entries.map((e) => e.appointmentId), ["appt-aaa", "appt-zzz"]);

    // Fed in the opposite ("a-then-z") input order -- same output, proving
    // the result doesn't just happen to match the input order by luck.
    const entriesReversed = buildNeedsAttentionEntries(baseArgs({
      appointments: [aA, aZ], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asgA, asgZ]),
    }));
    assert.deepEqual(entriesReversed.map((e) => e.appointmentId), ["appt-aaa", "appt-zzz"]);
  });
});

describe("buildNeedsAttentionEntries -- unbounded history for items 1/2 (regression: an old appointment must not silently age out)", () => {
  // Frozen "now" is 2026-08-20; January is well over 60 days before that
  // (the OLD rolling cutoff this scope change removes for items 1/2).
  const JANUARY = "2026-01-15T13:00:00.000Z";

  test("a January appointment with unresolved worked time IS flagged -- no rolling cutoff for item 1", () => {
    const a = appt({ id: "appt-january-review", status: "scheduled", scheduled_for: JANUARY, scheduled_end: "2026-01-15T14:00:00.000Z" });
    const asg = assignment({ appointment_id: "appt-january-review" });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]),
    }));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].issues, [{ kind: "worked_time_review", label: "Worked time needs review" }]);
  });

  test("a January appointment with no invoice number IS flagged -- no rolling cutoff for needs_invoicing", () => {
    const a = appt({ id: "appt-january-invoice", status: "scheduled", scheduled_for: JANUARY, scheduled_end: "2026-01-15T14:00:00.000Z" });
    const asg = assignment({
      appointment_id: "appt-january-invoice",
      actual_started_at: JANUARY, actual_completed_at: "2026-01-15T14:00:00.000Z",
    });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]),
    }));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].issues, [{ kind: "needs_invoicing", label: "Needs invoice number" }]);
  });

  test("a January appointment that's invoiced but unpaid IS flagged -- no rolling cutoff for payment_outstanding", () => {
    const a = appt({ id: "appt-january-unpaid", status: "scheduled", scheduled_for: JANUARY, scheduled_end: "2026-01-15T14:00:00.000Z" });
    const asg = assignment({
      appointment_id: "appt-january-unpaid",
      actual_started_at: JANUARY, actual_completed_at: "2026-01-15T14:00:00.000Z",
    });
    const b = billing({ appointment_id: "appt-january-unpaid", invoice_number: "INV-OLD", paid: false });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]), billingByAppointmentId: billingMap([b]),
    }));
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].issues, [{ kind: "payment_outstanding", label: "Payment outstanding" }]);
  });

  test("a January appointment that's PAID is still excluded -- unbounded history never means unresolved/ignoring resolution", () => {
    const a = appt({ id: "appt-january-paid", status: "scheduled", scheduled_for: JANUARY, scheduled_end: "2026-01-15T14:00:00.000Z" });
    const asg = assignment({
      appointment_id: "appt-january-paid",
      actual_started_at: JANUARY, actual_completed_at: "2026-01-15T14:00:00.000Z",
    });
    const b = billing({ appointment_id: "appt-january-paid", invoice_number: "INV-OLD2", paid: true, payment_method: "zelle" });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]), billingByAppointmentId: billingMap([b]),
    }));
    assert.equal(entries.length, 0);
  });

  test("a January CANCELLED appointment is still excluded from items 1/2 -- unbounded history never overrides the cancelled-exclusion rule", () => {
    const a = appt({ id: "appt-january-cancelled", status: "cancelled", scheduled_for: JANUARY, scheduled_end: "2026-01-15T14:00:00.000Z" });
    const asg = assignment({ appointment_id: "appt-january-cancelled" });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]),
    }));
    assert.equal(entries.length, 0);
  });
});

describe("buildNeedsAttentionEntries -- future appointments are still excluded from items 1/2 (rangeEnd is the only bound left)", () => {
  test("a future appointment with (hypothetically) already-resolved billing data is still excluded via rangeEnd, even though items 1/2 no longer have a lower bound", () => {
    // Billing eligibility itself has no time dimension (see
    // isAppointmentBillingEligible) -- rangeEnd is what excludes a future
    // appointment for item 2, exactly as it already does for item 1 (see
    // the "future (not yet elapsed) appointment" test above).
    const future = appt({
      id: "appt-future-billing", status: "scheduled",
      scheduled_for: "2026-08-25T13:00:00.000Z", scheduled_end: "2026-08-25T14:00:00.000Z",
    });
    const asg = assignment({
      appointment_id: "appt-future-billing",
      actual_started_at: "2026-08-25T13:00:00.000Z", actual_completed_at: "2026-08-25T14:00:00.000Z",
    });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [future], clients: [client()], assignmentsByAppointmentId: assignmentsMap([asg]),
    }));
    assert.equal(entries.length, 0, "rangeEnd (2026-08-20) excludes an 2026-08-25 appointment regardless of its billing data");
  });
});

describe("buildNeedsAttentionEntries -- item 3 keeps its own bounded scope, independent of items 1/2's unbounded history", () => {
  test("an appointment can still be flagged for item 3 if the CALLER already scoped failedMessageCountsByAppointmentId to the 60-day window -- this function trusts its own appointments input, it does not re-check any range for item 3", () => {
    // Deliberately demonstrates that item 3's own range-safety is the
    // caller's responsibility (the API route only ever queries messages
    // for appointments already fetched within the 60-day window) -- this
    // function itself only guards against an appointmentId with no
    // matching appointment row at all (see the "unknown appointment" test
    // above).
    const inRange = appt({ id: "appt-in-range", status: "scheduled" });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [inRange], clients: [client()], failedMessageCountsByAppointmentId: new Map([["appt-in-range", 1]]),
    }));
    assert.equal(entries.length, 1);
  });

  test("a January failed-message count is NOT flagged here -- this function doesn't widen item 3's scope on its own; only the route's own 60-day-bounded failedMessageCountsByAppointmentId input controls that, and a route that (correctly) never includes a January appointment id in that map means this function never sees one to flag", () => {
    // appointments (items 1/2) DOES include the January appointment (no
    // rolling cutoff there), but failedMessageCountsByAppointmentId does
    // NOT reference it -- exactly what the real route produces once an
    // appointment falls outside its own 60-day messages_sent scoping.
    const a = appt({ id: "appt-january-no-failed-msg", status: "cancelled", scheduled_for: "2026-01-15T13:00:00.000Z" });
    const entries = buildNeedsAttentionEntries(baseArgs({
      appointments: [a], clients: [client()], failedMessageCountsByAppointmentId: new Map(),
    }));
    assert.equal(entries.length, 0, "cancelled, and no issue of any kind applies");
  });
});
