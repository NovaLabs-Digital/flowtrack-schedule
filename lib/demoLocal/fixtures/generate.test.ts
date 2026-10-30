import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
// The REAL modules -- this suite proves the fixture against the app's own
// Needs Attention / message-classification logic, never a reimplementation.
import { buildNeedsAttentionEntries, NEEDS_ATTENTION_LOOKBACK_DAYS } from "@/lib/needsAttention";
import { classifyMessageStatus, countUnresolvedFailedMessageGroupsByAppointment } from "@/lib/messageStatus";
import { isValidPaymentMethod, type BillableAppointment } from "@/lib/completedJobBilling";
import { zonedDateTimeToUTC, zonedDateValue } from "@/lib/timezone";
import { addDays } from "@/lib/recurrence";
import type { AppointmentEmployeeAssignment } from "@/app/components/dashboard/types";
import { generateDemoFixture, DEMO_TIMEZONE, type DemoFixtureBundle } from "@/lib/demoLocal/fixtures/generate";

const TZ = DEMO_TIMEZONE;

// Assembles buildNeedsAttentionEntries' inputs exactly the way
// app/api/dashboard/needs-attention/route.ts does (past-only appointment
// set, 60-day-bounded failed-message set), then calls the real function
// with includeInvoicing: true.
function runRealNeedsAttention(bundle: DemoFixtureBundle, now: Date) {
  const rangeEnd = zonedDateValue(now.toISOString(), TZ);
  const tomorrow = zonedDateValue(addDays(now, 1, TZ).toISOString(), TZ);
  const lookbackStart = zonedDateValue(addDays(now, -NEEDS_ATTENTION_LOOKBACK_DAYS, TZ).toISOString(), TZ);
  const upper = zonedDateTimeToUTC(tomorrow, "00:00", TZ);
  const lower = zonedDateTimeToUTC(lookbackStart, "00:00", TZ);
  assert.ok(upper.ok && lower.ok);

  const appointments: BillableAppointment[] = bundle.appointments
    .filter((a) => a.scheduled_for < upper.iso)
    .map((a) => ({
      id: a.id, client_id: a.client_id, service_type: a.service_type, scheduled_for: a.scheduled_for,
      scheduled_end: a.scheduled_end ?? null, duration_minutes: a.duration_minutes ?? null, status: a.status, price_cents: a.price_cents ?? null,
    }));
  const recentIds = new Set(appointments.filter((a) => a.scheduled_for >= lower.iso).map((a) => a.id));

  const assignmentsByAppointmentId = new Map<string, AppointmentEmployeeAssignment[]>();
  for (const a of bundle.assignments) {
    const list = assignmentsByAppointmentId.get(a.appointment_id) ?? [];
    list.push(a);
    assignmentsByAppointmentId.set(a.appointment_id, list);
  }
  const failed = countUnresolvedFailedMessageGroupsByAppointment(
    bundle.messagesSent.filter((m) => m.appointment_id && recentIds.has(m.appointment_id)) as any
  );

  return buildNeedsAttentionEntries({
    appointments,
    clients: bundle.clients,
    assignmentsByAppointmentId,
    billingByAppointmentId: new Map(bundle.completedJobBilling.map((b) => [b.appointment_id, b])),
    employeeHours: bundle.employeeHours,
    failedMessageCountsByAppointmentId: failed,
    rangeEnd,
    timezone: TZ,
    includeInvoicing: true,
  });
}

function checkBundle(now: Date) {
  // isEligibleForWorkedHoursWarning (lib/payroll.ts) reads the real clock,
  // so freeze it at the same `now` the fixture was generated against.
  mock.timers.enable({ apis: ["Date"], now: now.getTime() });
  try {
    const bundle = generateDemoFixture(now);
    const entries = runRealNeedsAttention(bundle, now);

    assert.equal(entries.length, 4, `expected 4 Needs Attention entries, got ${JSON.stringify(entries, null, 2)}`);
    const kinds = entries.flatMap((e) => e.issues.map((i) => i.kind)).sort();
    assert.deepEqual(kinds, ["failed_message", "needs_invoicing", "payment_outstanding", "worked_time_review"]);
    for (const e of entries) assert.equal(e.issues.length, 1, "each trigger must be on its own appointment");
    assert.equal(new Set(entries.map((e) => e.appointmentId)).size, 4);
    return bundle;
  } finally {
    mock.timers.reset();
  }
}

describe("generateDemoFixture", () => {
  const now = new Date();
  const later = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  test("real buildNeedsAttentionEntries returns exactly 4 entries (now)", () => {
    checkBundle(now);
  });

  test("real buildNeedsAttentionEntries returns exactly 4 entries (one year later)", () => {
    checkBundle(later);
  });

  test("dates are relative to `now` and the shape is identical across runs", () => {
    const a = checkBundle(now);
    const b = checkBundle(later);
    for (const key of ["clients", "appointments", "employees", "services", "employeeHours", "assignments", "completedJobBilling", "messagesSent"] as const) {
      assert.equal(a[key].length, b[key].length, `${key} count differs`);
    }
    assert.equal(a.sessionInitIso, now.toISOString());
    const firstA = new Date(a.appointments[0].scheduled_for).getTime();
    const firstB = new Date(b.appointments[0].scheduled_for).getTime();
    const shiftDays = (firstB - firstA) / 86_400_000;
    assert.ok(shiftDays > 355 && shiftDays < 375, `expected ~1 year shift, got ${shiftDays} days`);
  });

  test("coverage: reference data, recurrence, corrections, cancellations, billing, messages", () => {
    const bundle = checkBundle(now);
    assert.equal(bundle.clients.length, 20);
    assert.equal(bundle.employees.length, 3);
    assert.equal(bundle.services.length, 6);

    const nowMs = now.getTime();
    const past = bundle.appointments.filter((a) => new Date(a.scheduled_for).getTime() < nowMs);
    const future = bundle.appointments.filter((a) => new Date(a.scheduled_for).getTime() > nowMs);
    assert.ok(past.length > 10 && future.length > 10);
    const seriesFreqs = new Set(bundle.appointments.filter((a) => a.series_id).map((a) => a.frequency_type));
    assert.ok(seriesFreqs.has("weekly") && seriesFreqs.has("monthly"));
    assert.ok(bundle.appointments.some((a) => !a.series_id && a.frequency_type === "one_time"));
    assert.ok(bundle.assignments.some((a) => a.actual_started_at && a.actual_completed_at));

    // exactly 2 owner-corrected appointments, migration-031 shape
    assert.equal(new Set(bundle.employeeHours.map((h) => h.appointment_id)).size, 2);
    for (const h of bundle.employeeHours) {
      assert.ok(h.hours_worked > 0 && h.note && h.workspace_id && h.created_at && h.updated_at);
    }

    // exactly 2 cancellations, one same-day report and one late record
    const cancelled = bundle.appointments.filter((a) => a.status === "cancelled");
    assert.equal(cancelled.length, 2);
    let sameDay = 0;
    let late = 0;
    for (const c of cancelled) {
      assert.ok(c.cancelled_at && c.cancellation_reported_date && c.cancellation_reason);
      const recordedDate = zonedDateValue(c.cancelled_at!, TZ);
      if (recordedDate === c.cancellation_reported_date) sameDay++;
      else if (recordedDate > c.cancellation_reported_date!) late++;
    }
    assert.equal(sameDay, 1);
    assert.equal(late, 1);

    // billing: missing (no row), invoiced-unpaid, and paid with a valid lowercase method
    assert.ok(bundle.completedJobBilling.some((b) => b.invoice_number && !b.paid));
    assert.ok(bundle.completedJobBilling.some((b) => b.paid && isValidPaymentMethod(b.payment_method)));
    for (const b of bundle.completedJobBilling) {
      if (b.paid) assert.ok(isValidPaymentMethod(b.payment_method));
    }

    // exactly 5 simulated messages, never a fabricated provider id
    assert.equal(bundle.messagesSent.length, 5);
    for (const m of bundle.messagesSent) {
      assert.equal(m.simulated, true);
      assert.notEqual(classifyMessageStatus(m.provider_id, m.channel).code, "sent");
    }
    assert.equal(bundle.messagesSent.filter((m) => classifyMessageStatus(m.provider_id, m.channel).code === "failed").length, 1);
  });

  test("companySettings: populated fictional company, off-by-default toggles, business_hours left to the effective fallback", () => {
    const bundle = checkBundle(now);
    assert.equal(bundle.companySettings.company_name, "Sunshine Property Services");
    assert.equal(bundle.companySettings.booking_enabled, false);
    assert.equal(bundle.companySettings.notifications_enabled, false);
    assert.equal(bundle.companySettings.business_hours, null);
    assert.equal(bundle.companySettings.timezone, DEMO_TIMEZONE);
    assert.ok(bundle.companySettings.phone && bundle.companySettings.email && bundle.companySettings.address);
  });

  test("archived clients: exactly 2 named rows have a non-null archived_at; everyone else is still null", () => {
    const bundle = checkBundle(now);
    const archived = bundle.clients.filter((c) => c.archived_at != null);
    assert.equal(archived.length, 2);
    assert.deepEqual(archived.map((c) => c.name).sort(), ["Douglas Fenwick", "Felix Contreras"]);
    for (const c of bundle.clients) {
      if (c.name !== "Douglas Fenwick" && c.name !== "Felix Contreras") assert.equal(c.archived_at, null);
    }
  });

  // Regression (permanent replacement for a throwaway browser harness used
  // to verify this once, then deleted per the "never ship browser harnesses"
  // convention): the cancelled_same_day scenario originally computed
  // cancelled_at as `now - 90 minutes` with no floor clamp to the start of
  // the day. Whenever `now` fell within the first ~90 minutes after local
  // midnight, that candidate landed on YESTERDAY's zoned calendar date,
  // disagreeing with cancellation_reported_date (always dateOf(0), i.e.
  // today) -- breaking the "same-day cancellation" invariant at exactly that
  // time of day. generate.ts now clamps the candidate to never go earlier
  // than the start of today. This sweeps `now` across the full midnight
  // boundary, every 5 minutes from 23:00 the prior day through 02:00 the
  // next day, in the fixture's own timezone, and proves the invariant holds
  // at every point.
  test("cancelled_same_day: cancelled_at's zoned calendar date never disagrees with cancellation_reported_date, even across the local-midnight boundary", () => {
    const todayDate = zonedDateValue(now.toISOString(), TZ);
    const anchor = zonedDateTimeToUTC(todayDate, "23:00", TZ);
    assert.ok(anchor.ok);
    const start = new Date(anchor.iso);
    for (let minutes = 0; minutes <= 3 * 60; minutes += 5) {
      const probe = new Date(start.getTime() + minutes * 60_000);
      const bundle = generateDemoFixture(probe);
      const cancelledSameDay = bundle.appointments.find(
        (a) => a.cancellation_reason === "Client called this morning — tenant move-in was postponed."
      );
      assert.ok(cancelledSameDay, `missing cancelled_same_day appointment at now=${probe.toISOString()}`);
      assert.ok(cancelledSameDay!.cancelled_at, `missing cancelled_at at now=${probe.toISOString()}`);
      assert.equal(
        zonedDateValue(cancelledSameDay!.cancelled_at!, TZ),
        cancelledSameDay!.cancellation_reported_date,
        `cancelled_at's zoned date must equal cancellation_reported_date at now=${probe.toISOString()}`
      );
    }
  });

  test("recurringSeries: exactly one review_required legacy row, attached to an EXISTING generated series", () => {
    for (const at of [now, later]) {
      const bundle = checkBundle(at);
      assert.equal(bundle.recurringSeries.length, 1);
      const r = bundle.recurringSeries[0];
      assert.deepEqual(Object.keys(r).sort(), [
        "anchor_local_date", "anchor_local_time", "anchor_timezone", "client_id", "created_at", "frequency_type", "id", "is_demo",
        "last_replenished_at", "repeat_months", "repeat_weeks", "reviewed_at", "source", "status", "stopped_at", "template_appointment_id",
        "updated_at", "workspace_id",
      ]);
      assert.equal(r.status, "review_required");
      assert.equal(r.source, "legacy_backfill");
      assert.equal(r.template_appointment_id, null);
      // false, not true: the real activate route refuses any is_demo row
      // outright, a safeguard protecting the real shared demo workspace --
      // this local-only store has no such workspace to protect, and the
      // Stage 2 requirement is that activation is genuinely demonstrable.
      assert.equal(r.is_demo, false);
      assert.equal(r.anchor_timezone, TZ);
      // Correlated with real generated appointments: same series_id, same
      // client, same frequency settings -- and it has live future occurrences.
      const members = bundle.appointments.filter((a) => a.series_id === r.id);
      assert.ok(members.length > 1);
      for (const a of members) {
        assert.equal(a.client_id, r.client_id);
        assert.equal(a.frequency_type, r.frequency_type);
        assert.equal(a.repeat_weeks, r.repeat_weeks);
        assert.equal(a.repeat_months, r.repeat_months);
      }
      assert.ok(members.some((a) => a.status === "scheduled" && new Date(a.scheduled_for).getTime() > at.getTime()));
      const client = bundle.clients.find((c) => c.id === r.client_id)!;
      assert.equal(client.archived_at, null);
      assert.equal(client.status, "active");
    }
  });
});
