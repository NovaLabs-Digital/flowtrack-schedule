// Phase 5.7D-R17 (future-appointment missing-hours fix) + Phase 5.7D-R18
// (multiple employees per appointment -- per-assignment Job Tracking,
// missing-hours, and derived appointment status). All fixtures use
// Date.now()-relative offsets rather than fixed dates, so these tests never
// go stale.
import { test, describe, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  computePayrollRows,
  isEligibleForWorkedHoursWarning,
  needsWorkedHoursAttention,
  getMissingHoursEmployeeIds,
  deriveAppointmentTrackingStatus,
  toDateInputValue,
} from "./payroll.ts";
import type { Appointment, EmployeeHours, Employee, AppointmentEmployeeAssignment } from "@/app/components/dashboard/types";
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

describe("needsWorkedHoursAttention -- eligibility gate applied consistently (single assignment)", () => {
  test("a future appointment is never flagged", () => {
    const a = appt({
      scheduled_for: new Date(Date.now() + HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
    });
    assert.equal(needsWorkedHoursAttention(a, [assignment()], []), false);
  });

  test("an appointment currently underway is not flagged before its scheduled end", () => {
    const a = appt({
      scheduled_for: new Date(Date.now() - HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() + HOUR_MS).toISOString(),
    });
    assert.equal(needsWorkedHoursAttention(a, [assignment()], []), false);
  });

  test("a past, eligible appointment with no worked-hours source is flagged", () => {
    const a = appt({
      scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    assert.equal(needsWorkedHoursAttention(a, [assignment()], []), true);
  });

  test("a past, completed (job-tracking) assignment is excluded", () => {
    const a = appt({
      scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    const asg = assignment({
      actual_started_at: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    assert.equal(needsWorkedHoursAttention(a, [asg], []), false);
  });

  test("a past appointment with a valid manual hours entry is excluded", () => {
    const a = appt({
      id: "appt-manual",
      scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    const asg = assignment({ appointment_id: "appt-manual", employee_id: "emp-1" });
    const hours: EmployeeHours[] = [
      { id: "eh-1", appointment_id: "appt-manual", employee_id: "emp-1", hours_worked: 1, note: null, created_at: "", updated_at: "" },
    ];
    assert.equal(needsWorkedHoursAttention(a, [asg], hours), false);
  });

  test("a cancelled appointment is excluded even if past and eligible", () => {
    const a = appt({
      status: "cancelled",
      scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    assert.equal(needsWorkedHoursAttention(a, [assignment()], []), false);
  });

  test("a zero-assignment appointment is never flagged -- nothing to be missing", () => {
    const a = appt({
      scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    assert.equal(needsWorkedHoursAttention(a, [], []), false);
  });
});

describe("Phase 5.7D-R18: per-assignment missing-hours identification (Teresa/Roxana example)", () => {
  test("Teresa tracked, Roxana not -- only Roxana is identified as missing", () => {
    const a = appt({
      id: "shared-job",
      scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    const teresa = assignment({
      id: "ae-teresa", appointment_id: "shared-job", employee_id: "teresa",
      actual_started_at: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    const roxana = assignment({ id: "ae-roxana", appointment_id: "shared-job", employee_id: "roxana" });
    const missing = getMissingHoursEmployeeIds(a, [teresa, roxana], []);
    assert.deepEqual(missing, ["roxana"]);
    assert.equal(needsWorkedHoursAttention(a, [teresa, roxana], []), true);
  });

  test("both assigned employees tracked -- nobody is missing", () => {
    const a = appt({
      id: "shared-job-2",
      scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    const teresa = assignment({
      id: "ae-teresa2", appointment_id: "shared-job-2", employee_id: "teresa",
      actual_started_at: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    const roxana = assignment({
      id: "ae-roxana2", appointment_id: "shared-job-2", employee_id: "roxana",
      actual_started_at: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - 2 * HOUR_MS + 15 * 60 * 1000).toISOString(),
    });
    assert.deepEqual(getMissingHoursEmployeeIds(a, [teresa, roxana], []), []);
    assert.equal(needsWorkedHoursAttention(a, [teresa, roxana], []), false);
  });
});

describe("Phase 5.7D-R18: deriveAppointmentTrackingStatus", () => {
  test("zero assignments -> scheduled, never vacuously completed", () => {
    assert.equal(deriveAppointmentTrackingStatus([]), "scheduled");
  });

  test("no assignment has started -> scheduled", () => {
    assert.equal(deriveAppointmentTrackingStatus([assignment(), assignment({ employee_id: "emp-2" })]), "scheduled");
  });

  test("one started, none completed -> in_progress", () => {
    const started = assignment({ actual_started_at: new Date().toISOString() });
    assert.equal(deriveAppointmentTrackingStatus([started]), "in_progress");
  });

  test("mixed: one completed, one not started at all -> in_progress (not vacuously completed)", () => {
    const completed = assignment({
      employee_id: "teresa",
      actual_started_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - HOUR_MS).toISOString(),
    });
    const notStarted = assignment({ employee_id: "roxana", actual_started_at: null, actual_completed_at: null });
    assert.equal(deriveAppointmentTrackingStatus([completed, notStarted]), "in_progress");
  });

  test("every assigned employee has a valid completed timestamp -> completed", () => {
    const a1 = assignment({
      employee_id: "teresa",
      actual_started_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - HOUR_MS).toISOString(),
    });
    const a2 = assignment({
      employee_id: "roxana",
      actual_started_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - HOUR_MS + 5 * 60 * 1000).toISOString(),
    });
    assert.equal(deriveAppointmentTrackingStatus([a1, a2]), "completed");
  });

  test("a sub-minute (invalid) completed gap does not count as a valid completion -> in_progress, not completed", () => {
    const start = new Date(Date.now() - HOUR_MS);
    const invalidComplete = assignment({
      actual_started_at: start.toISOString(),
      actual_completed_at: new Date(start.getTime() + 10_000).toISOString(), // 10s gap
    });
    assert.equal(deriveAppointmentTrackingStatus([invalidComplete]), "in_progress");
  });
});

describe("computePayrollRows -- missingHoursCount never counts a not-yet-due appointment (the reported defect)", () => {
  // Freezes both the test's own Date.now()/new Date() calls AND the
  // production code's (isEligibleForWorkedHoursWarning, computePayrollRows'
  // internal eligibility check) to one fixed, deterministic instant --
  // Wednesday, safely mid-week (never a weekend, never a Mon/Fri edge), and
  // in January so it's outside any DST transition. This is the actual fix
  // for the incident that broke these tests: the old weekRangeContainingNow()
  // used the REAL current time to build a Monday-Friday range, so on any
  // real Saturday/Sunday "now" itself fell outside its own range, and every
  // appointment built from real Date.now() offsets did too.
  //
  // A fixed timestamp on the TEST side alone doesn't work here: production's
  // isEligibleForWorkedHoursWarning always compares against the real
  // Date.now(), so an appointment built from a fixed past instant would
  // read as "long past" to production code regardless of what the test
  // intended -- confirmed by hitting exactly that failure mode while
  // developing this fix. node:test's built-in mock.timers instead freezes
  // Date globally for the process, so the test fixtures AND
  // lib/payroll.ts's own internal Date.now() calls agree on the same fixed
  // "now" -- lib/payroll.ts itself is not modified in any way.
  before(() => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-14T18:00:00.000Z").getTime() });
  });
  after(() => {
    mock.timers.reset();
  });

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
    const a = appt({
      id: "future-1",
      scheduled_for: new Date(Date.now() + HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() + 2 * HOUR_MS).toISOString(),
    });
    const { missingHoursCount, rows } = computePayrollRows({
      appointments: [a], employees, employeeHours: [], assignments: [assignment({ appointment_id: "future-1" })], rangeStart, rangeEnd,
    });
    assert.equal(missingHoursCount, 0);
    assert.equal(rows.length, 0);
  });

  test("an appointment currently in progress within the range is not counted as missing", () => {
    const { rangeStart, rangeEnd } = weekRangeContainingNow();
    const employees: Employee[] = [{ id: "emp-1", name: "Teresa", phone: null, color: "#000", active: true }];
    const a = appt({
      id: "in-progress-1",
      scheduled_for: new Date(Date.now() - HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() + HOUR_MS).toISOString(),
    });
    const { missingHoursCount } = computePayrollRows({
      appointments: [a], employees, employeeHours: [], assignments: [assignment({ appointment_id: "in-progress-1" })], rangeStart, rangeEnd,
    });
    assert.equal(missingHoursCount, 0);
  });

  test("a genuinely past, unresolved appointment within the range IS still counted as missing", () => {
    const { rangeStart, rangeEnd } = weekRangeContainingNow();
    const employees: Employee[] = [{ id: "emp-1", name: "Teresa", phone: null, color: "#000", active: true }];
    const a = appt({
      id: "past-unresolved-1",
      scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    const { missingHoursCount } = computePayrollRows({
      appointments: [a], employees, employeeHours: [], assignments: [assignment({ appointment_id: "past-unresolved-1" })], rangeStart, rangeEnd,
    });
    assert.equal(missingHoursCount, 1);
  });

  test("a completed assignment contributes real hours and is never counted as missing", () => {
    const { rangeStart, rangeEnd } = weekRangeContainingNow();
    const employees: Employee[] = [{ id: "emp-1", name: "Teresa", phone: null, color: "#000", active: true }];
    const a = appt({
      id: "completed-1",
      scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    const asg = assignment({
      appointment_id: "completed-1",
      actual_started_at: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    const { missingHoursCount, rows } = computePayrollRows({
      appointments: [a], employees, employeeHours: [], assignments: [asg], rangeStart, rangeEnd,
    });
    assert.equal(missingHoursCount, 0);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].hoursWorked > 0);
  });

  test("a cancelled appointment within the range is never counted as missing", () => {
    const { rangeStart, rangeEnd } = weekRangeContainingNow();
    const employees: Employee[] = [{ id: "emp-1", name: "Teresa", phone: null, color: "#000", active: true }];
    const a = appt({
      id: "cancelled-1",
      status: "cancelled",
      scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    const { missingHoursCount } = computePayrollRows({
      appointments: [a], employees, employeeHours: [], assignments: [assignment({ appointment_id: "cancelled-1" })], rangeStart, rangeEnd,
    });
    assert.equal(missingHoursCount, 0);
  });

  test("a zero-assignment appointment within the range is never counted as missing", () => {
    const { rangeStart, rangeEnd } = weekRangeContainingNow();
    const a = appt({
      id: "unassigned-1",
      scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    const { missingHoursCount, rows } = computePayrollRows({
      appointments: [a], employees: [], employeeHours: [], assignments: [], rangeStart, rangeEnd,
    });
    assert.equal(missingHoursCount, 0);
    assert.equal(rows.length, 0);
  });

  test("Friday's future appointments in a Mon-Fri range are excluded exactly like the reported screenshot scenario (two future appointments, zero missing)", () => {
    const { rangeStart } = weekRangeContainingNow();
    const employees: Employee[] = [{ id: "emp-1", name: "Teresa", phone: null, color: "#000", active: true }];
    const appointments: Appointment[] = [
      appt({ id: "future-a", scheduled_for: new Date(Date.now() + 20 * HOUR_MS).toISOString(), scheduled_end: new Date(Date.now() + 21 * HOUR_MS).toISOString() }),
      appt({ id: "future-b", scheduled_for: new Date(Date.now() + 22 * HOUR_MS).toISOString(), scheduled_end: new Date(Date.now() + 23 * HOUR_MS).toISOString() }),
    ];
    const assignments = [assignment({ id: "ae-a", appointment_id: "future-a" }), assignment({ id: "ae-b", appointment_id: "future-b" })];
    // Only meaningful when both land inside the same Mon-Fri window as "now" --
    // skip the assertion window check itself (date-range bucketing is proven
    // separately elsewhere); the point here is purely that missingHoursCount
    // never increments for either, regardless of range membership.
    const { missingHoursCount } = computePayrollRows({
      appointments, employees, employeeHours: [], assignments, rangeStart, rangeEnd: toDateInputValue(new Date(Date.now() + 30 * HOUR_MS)),
    });
    assert.equal(missingHoursCount, 0);
  });

  test("Phase 5.7D-R18: two employees on one past appointment -- one tracked, one missing -> exactly one missingHoursCount and one payroll row", () => {
    const { rangeStart, rangeEnd } = weekRangeContainingNow();
    const employees: Employee[] = [
      { id: "teresa", name: "Teresa", phone: null, color: "#000", active: true },
      { id: "roxana", name: "Roxana", phone: null, color: "#111", active: true },
    ];
    const a = appt({
      id: "shared-1",
      scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    const teresaAssignment = assignment({
      id: "ae-t", appointment_id: "shared-1", employee_id: "teresa",
      actual_started_at: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
    });
    const roxanaAssignment = assignment({ id: "ae-r", appointment_id: "shared-1", employee_id: "roxana" });
    const { missingHoursCount, rows } = computePayrollRows({
      appointments: [a], employees, employeeHours: [], assignments: [teresaAssignment, roxanaAssignment], rangeStart, rangeEnd,
    });
    assert.equal(missingHoursCount, 1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].employeeId, "teresa");
  });

  test("Phase 5.7D-R18: different durations for two employees on the same job total separately (Teresa 3.5h, Roxana 3.0h)", () => {
    const { rangeStart, rangeEnd } = weekRangeContainingNow();
    const employees: Employee[] = [
      { id: "teresa", name: "Teresa", phone: null, color: "#000", active: true },
      { id: "roxana", name: "Roxana", phone: null, color: "#111", active: true },
    ];
    const a = appt({
      id: "shared-2",
      scheduled_for: new Date(Date.now() - 4 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    const teresaAssignment = assignment({
      id: "ae-t2", appointment_id: "shared-2", employee_id: "teresa",
      actual_started_at: new Date(Date.now() - 4 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - 4 * HOUR_MS + 3.5 * HOUR_MS).toISOString(),
    });
    const roxanaAssignment = assignment({
      id: "ae-r2", appointment_id: "shared-2", employee_id: "roxana",
      actual_started_at: new Date(Date.now() - 4 * HOUR_MS + 15 * 60 * 1000).toISOString(),
      actual_completed_at: new Date(Date.now() - 4 * HOUR_MS + 15 * 60 * 1000 + 3 * HOUR_MS).toISOString(),
    });
    const { rows, missingHoursCount } = computePayrollRows({
      appointments: [a], employees, employeeHours: [], assignments: [teresaAssignment, roxanaAssignment], rangeStart, rangeEnd,
    });
    assert.equal(missingHoursCount, 0);
    const teresaRow = rows.find((r) => r.employeeId === "teresa")!;
    const roxanaRow = rows.find((r) => r.employeeId === "roxana")!;
    assert.ok(Math.abs(teresaRow.hoursWorked - 3.5) < 0.01, `expected ~3.5, got ${teresaRow.hoursWorked}`);
    assert.ok(Math.abs(roxanaRow.hoursWorked - 3.0) < 0.01, `expected ~3.0, got ${roxanaRow.hoursWorked}`);
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
    assert.equal(needsWorkedHoursAttention(a, [assignment()], []), true);
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
