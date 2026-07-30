// Phase 5.7D-R17: tests for the future-appointment missing-hours defect fix
// in lib/payroll.ts. Root cause: computePayrollRows's missingHoursCount had
// no eligibility check at all (any unresolved appointment within the
// displayed date range was counted, including ones that hadn't happened
// yet), and needsWorkedHoursAttention only checked scheduled_for < now (so
// an appointment still in progress, started but not yet ended, was already
// flagged). Both now share isEligibleForWorkedHoursWarning, which requires
// the appointment's scheduled END to have passed. All fixtures use
// Date.now()-relative offsets rather than fixed dates, so these tests never
// go stale.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computePayrollRows, isEligibleForWorkedHoursWarning, needsWorkedHoursAttention, toDateInputValue } from "./payroll.ts";
import type { Appointment, EmployeeHours, Employee } from "@/app/components/dashboard/types";
import { toBusinessLocal } from "./timezone.ts";

const HOUR_MS = 60 * 60 * 1000;

function appt(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: "appt-1",
    client_id: "client-1",
    service_type: "Regular Cleaning",
    scheduled_for: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    status: "scheduled",
    notes: null,
    employee_id: "emp-1",
    ...overrides,
  };
}

describe("isEligibleForWorkedHoursWarning", () => {
  test("a future appointment (scheduled_end in the future) is not eligible", () => {
    const a = appt({
      scheduled_for: new Date(Date.now() + HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
    });
    assert.equal(isEligibleForWorkedHoursWarning(a), false);
  });

  test("an appointment currently underway (started in the past, ends in the future) is not eligible", () => {
    const a = appt({
      scheduled_for: new Date(Date.now() - HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() + HOUR_MS).toISOString(),
    });
    assert.equal(isEligibleForWorkedHoursWarning(a), false);
  });

  test("an appointment whose scheduled end has passed is eligible", () => {
    const a = appt({
      scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    assert.equal(isEligibleForWorkedHoursWarning(a), true);
  });

  test("falls back to scheduled_for + duration_minutes when scheduled_end is absent", () => {
    const stillRunning = appt({
      scheduled_for: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      scheduled_end: null,
      duration_minutes: 120, // ends 90 minutes from now
    });
    assert.equal(isEligibleForWorkedHoursWarning(stillRunning), false);

    const alreadyOver = appt({
      scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: null,
      duration_minutes: 60, // ended 2 hours ago
    });
    assert.equal(isEligibleForWorkedHoursWarning(alreadyOver), true);
  });
});

describe("needsWorkedHoursAttention -- eligibility gate applied consistently", () => {
  test("a future appointment is never flagged", () => {
    const a = appt({
      scheduled_for: new Date(Date.now() + HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
    });
    assert.equal(needsWorkedHoursAttention(a, []), false);
  });

  test("an appointment currently underway is not flagged before its scheduled end", () => {
    const a = appt({
      scheduled_for: new Date(Date.now() - HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() + HOUR_MS).toISOString(),
    });
    assert.equal(needsWorkedHoursAttention(a, []), false);
  });

  test("a past, eligible appointment with no worked-hours source is flagged", () => {
    const a = appt({
      scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    assert.equal(needsWorkedHoursAttention(a, []), true);
  });

  test("a past, completed (job-tracking) appointment is excluded", () => {
    const a = appt({
      scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      actual_started_at: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    assert.equal(needsWorkedHoursAttention(a, []), false);
  });

  test("a past appointment with a valid manual hours entry is excluded", () => {
    const a = appt({
      id: "appt-manual",
      scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      employee_id: "emp-1",
    });
    const hours: EmployeeHours[] = [
      { id: "eh-1", appointment_id: "appt-manual", employee_id: "emp-1", hours_worked: 1, note: null, created_at: "", updated_at: "" },
    ];
    assert.equal(needsWorkedHoursAttention(a, hours), false);
  });

  test("a cancelled appointment is excluded even if past and eligible", () => {
    const a = appt({
      status: "cancelled",
      scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    assert.equal(needsWorkedHoursAttention(a, []), false);
  });
});

describe("computePayrollRows -- missingHoursCount never counts a not-yet-due appointment (the reported defect)", () => {
  function weekRangeContainingNow() {
    const now = toBusinessLocal(new Date().toISOString());
    const monday = new Date(now);
    const dow = monday.getDay();
    monday.setDate(monday.getDate() - ((dow + 6) % 7));
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);
    return { rangeStart: toDateInputValue(monday), rangeEnd: toDateInputValue(friday) };
  }

  test("a future appointment within the displayed week range is not counted as missing", () => {
    const { rangeStart, rangeEnd } = weekRangeContainingNow();
    const employees: Employee[] = [{ id: "emp-1", name: "Teresa", phone: null, color: "#000", active: true }];
    const appointments: Appointment[] = [
      appt({
        id: "future-1",
        scheduled_for: new Date(Date.now() + HOUR_MS).toISOString(),
        scheduled_end: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
      }),
    ];
    const { missingHoursCount, rows } = computePayrollRows({ appointments, employees, employeeHours: [], rangeStart, rangeEnd });
    assert.equal(missingHoursCount, 0);
    assert.equal(rows.length, 0);
  });

  test("an appointment currently in progress within the range is not counted as missing", () => {
    const { rangeStart, rangeEnd } = weekRangeContainingNow();
    const employees: Employee[] = [{ id: "emp-1", name: "Teresa", phone: null, color: "#000", active: true }];
    const appointments: Appointment[] = [
      appt({
        id: "in-progress-1",
        scheduled_for: new Date(Date.now() - HOUR_MS).toISOString(),
        scheduled_end: new Date(Date.now() + HOUR_MS).toISOString(),
      }),
    ];
    const { missingHoursCount } = computePayrollRows({ appointments, employees, employeeHours: [], rangeStart, rangeEnd });
    assert.equal(missingHoursCount, 0);
  });

  test("a genuinely past, unresolved appointment within the range IS still counted as missing", () => {
    const { rangeStart, rangeEnd } = weekRangeContainingNow();
    const employees: Employee[] = [{ id: "emp-1", name: "Teresa", phone: null, color: "#000", active: true }];
    const appointments: Appointment[] = [
      appt({
        id: "past-unresolved-1",
        scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
        scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      }),
    ];
    const { missingHoursCount } = computePayrollRows({ appointments, employees, employeeHours: [], rangeStart, rangeEnd });
    assert.equal(missingHoursCount, 1);
  });

  test("a completed appointment contributes real hours and is never counted as missing", () => {
    const { rangeStart, rangeEnd } = weekRangeContainingNow();
    const employees: Employee[] = [{ id: "emp-1", name: "Teresa", phone: null, color: "#000", active: true }];
    const appointments: Appointment[] = [
      appt({
        id: "completed-1",
        scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
        scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
        actual_started_at: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
        actual_completed_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      }),
    ];
    const { missingHoursCount, rows } = computePayrollRows({ appointments, employees, employeeHours: [], rangeStart, rangeEnd });
    assert.equal(missingHoursCount, 0);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].hoursWorked > 0);
  });

  test("a cancelled appointment within the range is never counted as missing", () => {
    const { rangeStart, rangeEnd } = weekRangeContainingNow();
    const employees: Employee[] = [{ id: "emp-1", name: "Teresa", phone: null, color: "#000", active: true }];
    const appointments: Appointment[] = [
      appt({
        id: "cancelled-1",
        status: "cancelled",
        scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
        scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      }),
    ];
    const { missingHoursCount } = computePayrollRows({ appointments, employees, employeeHours: [], rangeStart, rangeEnd });
    assert.equal(missingHoursCount, 0);
  });

  test("Friday's future appointments in a Mon-Fri range are excluded exactly like the reported screenshot scenario (two future appointments, zero missing)", () => {
    const { rangeStart } = weekRangeContainingNow();
    const employees: Employee[] = [{ id: "emp-1", name: "Teresa", phone: null, color: "#000", active: true }];
    const appointments: Appointment[] = [
      appt({ id: "future-a", scheduled_for: new Date(Date.now() + 20 * HOUR_MS).toISOString(), scheduled_end: new Date(Date.now() + 21 * HOUR_MS).toISOString() }),
      appt({ id: "future-b", scheduled_for: new Date(Date.now() + 22 * HOUR_MS).toISOString(), scheduled_end: new Date(Date.now() + 23 * HOUR_MS).toISOString() }),
    ];
    // Only meaningful when both land inside the same Mon-Fri window as "now" --
    // skip the assertion window check itself (date-range bucketing is proven
    // separately elsewhere); the point here is purely that missingHoursCount
    // never increments for either, regardless of range membership.
    const { missingHoursCount } = computePayrollRows({ appointments, employees, employeeHours: [], rangeStart, rangeEnd: toDateInputValue(new Date(Date.now() + 30 * HOUR_MS)) });
    assert.equal(missingHoursCount, 0);
  });
});

describe("timezone-boundary safety -- instant comparison, not UTC/local calendar-day comparison", () => {
  test("a past appointment whose UTC calendar date differs from its America/New_York calendar date is still correctly recognized as past", () => {
    // 2020-01-15T02:00:00Z is Jan 15 in UTC but 9pm Jan 14 in America/New_York
    // -- a naive UTC-string date comparison could disagree with a naive
    // local-string comparison about "which day" this is. Both ended well
    // before now (a fixed date safely in the past), so eligibility must be
    // true regardless of which calendar day either timezone assigns it.
    const a = appt({
      scheduled_for: "2020-01-15T02:00:00.000Z",
      scheduled_end: "2020-01-15T03:00:00.000Z",
    });
    assert.equal(isEligibleForWorkedHoursWarning(a), true);
    assert.equal(needsWorkedHoursAttention(a, []), true);
  });

  test("a far-future appointment is never eligible regardless of which timezone's calendar day it falls on", () => {
    const farFuture = new Date(Date.now() + 365 * 24 * HOUR_MS);
    const a = appt({
      scheduled_for: farFuture.toISOString(),
      scheduled_end: new Date(farFuture.getTime() + HOUR_MS).toISOString(),
    });
    assert.equal(isEligibleForWorkedHoursWarning(a), false);
  });
});
