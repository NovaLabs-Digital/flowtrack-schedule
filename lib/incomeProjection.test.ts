// Income Projection card: Estimated Income / Estimated Work Hours.
// Fixtures use Date.now()-relative offsets, matching lib/payroll.test.ts's
// own convention, so these tests never go stale.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeIncomeProjection, formatProjectedIncome } from "./incomeProjection.ts";
import type { Appointment, AppointmentEmployeeAssignment } from "@/app/components/dashboard/types";

const HOUR_MS = 60 * 60 * 1000;

function appt(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "appt-1",
    client_id: "client-1",
    service_type: "Regular Cleaning",
    scheduled_for: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    status: "scheduled",
    notes: null,
    price_cents: 18500, // $185.00
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
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

// A wide range that comfortably contains every Date.now()-relative fixture
// used below, so tests don't need to compute today's exact date string.
const RANGE_START = "2000-01-01";
const RANGE_END = "2100-01-01";

describe("computeIncomeProjection -- price source is appointment.price_cents, never parsed from a name", () => {
  test("sums price_cents across qualifying appointments", () => {
    const result = computeIncomeProjection({
      appointments: [appt({ id: "a1", price_cents: 18500 }), appt({ id: "a2", price_cents: 9500 })],
      assignments: [],
      rangeStart: RANGE_START,
      rangeEnd: RANGE_END,
    });
    assert.equal(result.estimatedIncomeCents, 28000);
  });

  test("a service_type string that LOOKS like it contains a price (e.g. 'Regular Cleaning $185') has zero effect -- only price_cents is read", () => {
    const result = computeIncomeProjection({
      appointments: [appt({ id: "a1", service_type: "Regular Cleaning $185", price_cents: 0 })],
      assignments: [],
      rangeStart: RANGE_START,
      rangeEnd: RANGE_END,
    });
    assert.equal(result.estimatedIncomeCents, 0, "the $185 in the name must never be parsed or summed");
  });

  test("an appointment with no valid price (price_cents null) contributes $0, not a crash, not a guessed value", () => {
    const result = computeIncomeProjection({
      appointments: [appt({ id: "a1", price_cents: null })],
      assignments: [assignment({ appointment_id: "a1" })],
      rangeStart: RANGE_START,
      rangeEnd: RANGE_END,
    });
    assert.equal(result.estimatedIncomeCents, 0);
  });
});

describe("computeIncomeProjection -- cancelled excluded, completed included", () => {
  test("a cancelled appointment is excluded entirely -- zero income, zero hours, even with a valid price and assigned employee", () => {
    const result = computeIncomeProjection({
      appointments: [appt({ id: "a1", status: "cancelled", price_cents: 18500 })],
      assignments: [assignment({ appointment_id: "a1" })],
      rangeStart: RANGE_START,
      rangeEnd: RANGE_END,
    });
    assert.equal(result.estimatedIncomeCents, 0);
    assert.equal(result.estimatedWorkHours, 0);
  });

  test("an appointment whose job tracking is already fully completed (both timestamps set) is still counted -- this projection represents the scheduled plan, not what's left to do", () => {
    const result = computeIncomeProjection({
      appointments: [
        appt({
          id: "a1",
          price_cents: 18500,
          scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
          scheduled_end: new Date(Date.now() - HOUR_MS).toISOString(),
        }),
      ],
      assignments: [
        assignment({
          appointment_id: "a1",
          actual_started_at: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
          actual_completed_at: new Date(Date.now() - HOUR_MS).toISOString(),
        }),
      ],
      rangeStart: RANGE_START,
      rangeEnd: RANGE_END,
    });
    assert.equal(result.estimatedIncomeCents, 18500);
    assert.equal(result.estimatedWorkHours, 2); // 2-hour scheduled duration x 1 employee
  });

  test("never reads actual_started_at/actual_completed_at to decide hours -- a job with actuals wildly different from its schedule still uses the SCHEDULED duration", () => {
    const result = computeIncomeProjection({
      appointments: [
        appt({
          id: "a1",
          scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
          scheduled_end: new Date(Date.now() - HOUR_MS).toISOString(), // 2h scheduled
        }),
      ],
      assignments: [
        assignment({
          appointment_id: "a1",
          actual_started_at: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
          actual_completed_at: new Date(Date.now() - 3 * HOUR_MS + 10 * 60 * 1000).toISOString(), // actually only 10 minutes
        }),
      ],
      rangeStart: RANGE_START,
      rangeEnd: RANGE_END,
    });
    assert.equal(result.estimatedWorkHours, 2, "must use the 2-hour SCHEDULED duration, not the 10-minute actual");
  });
});

describe("computeIncomeProjection -- Estimated Work Hours = scheduled duration x assigned employee count", () => {
  test("a 3-hour appointment with exactly 1 assigned employee = 3 estimated work hours", () => {
    const result = computeIncomeProjection({
      appointments: [
        appt({ id: "a1", scheduled_for: "2026-06-01T09:00:00.000Z", scheduled_end: "2026-06-01T12:00:00.000Z" }),
      ],
      assignments: [assignment({ appointment_id: "a1", employee_id: "emp-1" })],
      rangeStart: "2000-01-01",
      rangeEnd: "2100-01-01",
    });
    assert.equal(result.estimatedWorkHours, 3);
  });

  test("the same 3-hour appointment with 2 assigned employees = 6 estimated work hours", () => {
    const result = computeIncomeProjection({
      appointments: [
        appt({ id: "a1", scheduled_for: "2026-06-01T09:00:00.000Z", scheduled_end: "2026-06-01T12:00:00.000Z" }),
      ],
      assignments: [
        assignment({ id: "ae-1", appointment_id: "a1", employee_id: "emp-1" }),
        assignment({ id: "ae-2", appointment_id: "a1", employee_id: "emp-2" }),
      ],
      rangeStart: "2000-01-01",
      rangeEnd: "2100-01-01",
    });
    assert.equal(result.estimatedWorkHours, 6);
  });

  test("an appointment with zero assigned employees contributes 0 hours, but its price still counts toward income", () => {
    const result = computeIncomeProjection({
      appointments: [
        appt({ id: "a1", scheduled_for: "2026-06-01T09:00:00.000Z", scheduled_end: "2026-06-01T12:00:00.000Z", price_cents: 18500 }),
      ],
      assignments: [],
      rangeStart: "2000-01-01",
      rangeEnd: "2100-01-01",
    });
    assert.equal(result.estimatedWorkHours, 0);
    assert.equal(result.estimatedIncomeCents, 18500);
  });

  test("falls back to duration_minutes when scheduled_end is absent, matching lib/payroll.ts's own scheduledHours precedent", () => {
    const result = computeIncomeProjection({
      appointments: [appt({ id: "a1", scheduled_end: null, duration_minutes: 90 })],
      assignments: [assignment({ appointment_id: "a1" })],
      rangeStart: RANGE_START,
      rangeEnd: RANGE_END,
    });
    assert.equal(result.estimatedWorkHours, 1.5);
  });
});

describe("computeIncomeProjection -- date-range filtering", () => {
  test("an appointment on the range boundary dates (inclusive) is included", () => {
    const result = computeIncomeProjection({
      appointments: [
        appt({ id: "a1", scheduled_for: "2026-06-01T12:00:00.000Z", price_cents: 100 }),
        appt({ id: "a2", scheduled_for: "2026-06-05T12:00:00.000Z", price_cents: 100 }),
      ],
      assignments: [],
      rangeStart: "2026-06-01",
      rangeEnd: "2026-06-05",
    });
    assert.equal(result.estimatedIncomeCents, 200);
  });

  test("an appointment outside the range (before start, after end) is excluded", () => {
    const result = computeIncomeProjection({
      appointments: [
        appt({ id: "a1", scheduled_for: "2026-05-31T12:00:00.000Z", price_cents: 100 }),
        appt({ id: "a2", scheduled_for: "2026-06-06T12:00:00.000Z", price_cents: 100 }),
      ],
      assignments: [],
      rangeStart: "2026-06-01",
      rangeEnd: "2026-06-05",
    });
    assert.equal(result.estimatedIncomeCents, 0);
  });
});

describe("computeIncomeProjection -- zero qualifying appointments", () => {
  test("no appointments at all -> $0.00 / 0.00 hrs", () => {
    const result = computeIncomeProjection({ appointments: [], assignments: [], rangeStart: RANGE_START, rangeEnd: RANGE_END });
    assert.equal(result.estimatedIncomeCents, 0);
    assert.equal(result.estimatedWorkHours, 0);
  });

  test("appointments exist but none qualify (all cancelled or out of range) -> $0.00 / 0.00 hrs", () => {
    const result = computeIncomeProjection({
      appointments: [appt({ id: "a1", status: "cancelled" }), appt({ id: "a2", scheduled_for: "1999-01-01T00:00:00.000Z" })],
      assignments: [assignment({ appointment_id: "a1" }), assignment({ appointment_id: "a2" })],
      rangeStart: RANGE_START,
      rangeEnd: RANGE_END,
    });
    assert.equal(result.estimatedIncomeCents, 0);
    assert.equal(result.estimatedWorkHours, 0);
  });
});

describe("formatProjectedIncome -- thousands-separated currency display", () => {
  test("formats with a thousands separator and two decimal places, matching the approved example", () => {
    assert.equal(formatProjectedIncome(181500), "$1,815.00");
  });

  test("formats zero as $0.00, not a blank or dash", () => {
    assert.equal(formatProjectedIncome(0), "$0.00");
  });

  test("formats a large value with multiple thousands separators", () => {
    assert.equal(formatProjectedIncome(123456789), "$1,234,567.89");
  });
});
