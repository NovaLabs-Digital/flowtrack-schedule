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
  isHistoricalAppointment,
  toDateInputValue,
  resolveWorkedMinutes,
  needsWorkedTimeReview,
  scheduledMinutes,
  trackedMinutes,
} from "./payroll.ts";
import type { Appointment, EmployeeHours, Employee, AppointmentEmployeeAssignment } from "@/app/components/dashboard/types";
import { toBusinessLocal } from "./timezone.ts";

const HOUR_MS = 60 * 60 * 1000;

// The fixed workspace timezone every computePayrollRows fixture below is
// scoped to -- Phase 5E made `timezone` a required, explicit parameter (no
// default), so every call site in this file must pass one.
const TZ = "America/New_York";

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
    job_notes: null,
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

describe("isHistoricalAppointment -- the canonical historical-record predicate (completed, cancelled, or scheduled_end elapsed)", () => {
  const NOW = new Date("2026-08-03T14:00:00.000Z"); // 10:00 AM America/New_York

  test("completed early: scheduled_end is still an hour in the future, but every assigned employee already finished -> historical immediately (the reported gap)", () => {
    const a = appt({
      status: "scheduled",
      scheduled_for: "2026-08-03T13:30:00.000Z", // 9:30 AM
      scheduled_end: "2026-08-03T15:00:00.000Z", // 11:00 AM -- an hour after NOW
    });
    const assignments = [
      assignment({
        employee_id: "teresa",
        actual_started_at: "2026-08-03T13:35:00.000Z",
        actual_completed_at: "2026-08-03T13:55:00.000Z", // finished at 9:55 AM, well before scheduled_end
      }),
    ];
    assert.equal(isHistoricalAppointment(a, assignments, NOW), true);
  });

  test("one employee finished but a second assigned employee has not -> NOT historical (never assume one employee finishing completes the whole appointment)", () => {
    const a = appt({
      status: "scheduled",
      scheduled_for: "2026-08-03T13:30:00.000Z",
      scheduled_end: "2026-08-03T15:00:00.000Z",
    });
    const assignments = [
      assignment({
        employee_id: "teresa",
        actual_started_at: "2026-08-03T13:35:00.000Z",
        actual_completed_at: "2026-08-03T13:55:00.000Z",
      }),
      assignment({ employee_id: "roxana", actual_started_at: null, actual_completed_at: null }),
    ];
    assert.equal(isHistoricalAppointment(a, assignments, NOW), false);
  });

  test("in-progress with a future scheduled_end remains operational: started, not completed, end not yet elapsed -> NOT historical", () => {
    const a = appt({
      status: "scheduled",
      scheduled_for: "2026-08-03T13:30:00.000Z",
      scheduled_end: "2026-08-03T15:00:00.000Z", // still an hour away
    });
    const assignments = [
      assignment({ employee_id: "teresa", actual_started_at: "2026-08-03T13:35:00.000Z", actual_completed_at: null }),
    ];
    assert.equal(isHistoricalAppointment(a, assignments, NOW), false);
  });

  test("cancelled is historical regardless of assignments or scheduled_end", () => {
    const a = appt({ status: "cancelled", scheduled_for: "2026-12-01T13:30:00.000Z", scheduled_end: "2026-12-01T15:00:00.000Z" });
    assert.equal(isHistoricalAppointment(a, []), true);
  });

  test("scheduled_end already elapsed, no job-tracking data at all -> historical via the time-based fallback (isPastAppointment)", () => {
    const a = appt({ status: "scheduled", scheduled_for: "2026-08-03T11:00:00.000Z", scheduled_end: "2026-08-03T12:00:00.000Z" });
    assert.equal(isHistoricalAppointment(a, [], NOW), true);
  });

  test("a genuinely future, not-yet-started appointment is NOT historical", () => {
    const a = appt({ status: "scheduled", scheduled_for: "2026-08-10T13:00:00.000Z", scheduled_end: "2026-08-10T14:00:00.000Z" });
    assert.equal(isHistoricalAppointment(a, [], NOW), false);
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
    const now = toBusinessLocal(new Date().toISOString(), TZ);
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
      appointments: [a], employees, employeeHours: [], assignments: [assignment({ appointment_id: "future-1" })], rangeStart, rangeEnd, timezone: TZ,
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
      appointments: [a], employees, employeeHours: [], assignments: [assignment({ appointment_id: "in-progress-1" })], rangeStart, rangeEnd, timezone: TZ,
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
      appointments: [a], employees, employeeHours: [], assignments: [assignment({ appointment_id: "past-unresolved-1" })], rangeStart, rangeEnd, timezone: TZ,
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
      appointments: [a], employees, employeeHours: [], assignments: [asg], rangeStart, rangeEnd, timezone: TZ,
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
      appointments: [a], employees, employeeHours: [], assignments: [assignment({ appointment_id: "cancelled-1" })], rangeStart, rangeEnd, timezone: TZ,
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
      appointments: [a], employees: [], employeeHours: [], assignments: [], rangeStart, rangeEnd, timezone: TZ,
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
      appointments, employees, employeeHours: [], assignments, rangeStart, rangeEnd: toDateInputValue(new Date(Date.now() + 30 * HOUR_MS)), timezone: TZ,
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
      appointments: [a], employees, employeeHours: [], assignments: [teresaAssignment, roxanaAssignment], rangeStart, rangeEnd, timezone: TZ,
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
      appointments: [a], employees, employeeHours: [], assignments: [teresaAssignment, roxanaAssignment], rangeStart, rangeEnd, timezone: TZ,
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

describe("Phase 5E: computePayrollRows -- range inclusion uses the WORKSPACE-LOCAL calendar date, not a fixed zone", () => {
  // Same near-midnight instant as lib/incomeProjection.test.ts's own Phase
  // 5E block -- already Aug 10 in New York, still Aug 9 in Honolulu.
  const NEAR_MIDNIGHT_UTC = "2026-08-10T04:30:00.000Z";

  function completedAppt(): { appt: Appointment; assignment: AppointmentEmployeeAssignment } {
    return {
      appt: appt({
        id: "a1",
        scheduled_for: NEAR_MIDNIGHT_UTC,
        scheduled_end: new Date(new Date(NEAR_MIDNIGHT_UTC).getTime() + 2 * HOUR_MS).toISOString(),
      }),
      assignment: assignment({
        appointment_id: "a1",
        actual_started_at: NEAR_MIDNIGHT_UTC,
        actual_completed_at: new Date(new Date(NEAR_MIDNIGHT_UTC).getTime() + 2 * HOUR_MS).toISOString(),
      }),
    };
  }

  test("America/New_York: the appointment is Aug 10 local -- included in an Aug 10-only range, excluded from an Aug 9-only range", () => {
    const employees: Employee[] = [{ id: "emp-1", name: "Teresa", phone: null, color: "#000", active: true }];
    const { appt: a, assignment: asg } = completedAppt();

    const included = computePayrollRows({
      appointments: [a], employees, employeeHours: [], assignments: [asg],
      rangeStart: "2026-08-10", rangeEnd: "2026-08-10", timezone: "America/New_York",
    });
    assert.equal(included.rows.length, 1);

    const excluded = computePayrollRows({
      appointments: [a], employees, employeeHours: [], assignments: [asg],
      rangeStart: "2026-08-09", rangeEnd: "2026-08-09", timezone: "America/New_York",
    });
    assert.equal(excluded.rows.length, 0);
  });

  test("Pacific/Honolulu: the SAME instant is Aug 9 local -- included in an Aug 9-only range, excluded from an Aug 10-only range (the opposite of New York)", () => {
    const employees: Employee[] = [{ id: "emp-1", name: "Teresa", phone: null, color: "#000", active: true }];
    const { appt: a, assignment: asg } = completedAppt();

    const included = computePayrollRows({
      appointments: [a], employees, employeeHours: [], assignments: [asg],
      rangeStart: "2026-08-09", rangeEnd: "2026-08-09", timezone: "Pacific/Honolulu",
    });
    assert.equal(included.rows.length, 1);

    const excluded = computePayrollRows({
      appointments: [a], employees, employeeHours: [], assignments: [asg],
      rangeStart: "2026-08-10", rangeEnd: "2026-08-10", timezone: "Pacific/Honolulu",
    });
    assert.equal(excluded.rows.length, 0);
  });

  test("the ACTUAL worked-duration hours are identical regardless of which timezone decided range inclusion -- only bucketing changes, never the tracked duration itself", () => {
    const employees: Employee[] = [{ id: "emp-1", name: "Teresa", phone: null, color: "#000", active: true }];
    const { appt: a, assignment: asg } = completedAppt();
    for (const timezone of ["America/New_York", "America/Los_Angeles", "Pacific/Honolulu"]) {
      const result = computePayrollRows({
        appointments: [a], employees, employeeHours: [], assignments: [asg],
        rangeStart: "2000-01-01", rangeEnd: "2100-01-01", timezone,
      });
      assert.equal(result.rows.length, 1, timezone);
      assert.equal(result.rows[0].hoursWorked, 2, timezone);
    }
  });
});

// ============================================================================
// Owner Worked-Time Correction + Needs Review Alert
//
// Real example this fixes: Roxana forgot to clock out. Scheduled 1h30m,
// tracked 48h58m -- before this feature, that 48h58m was unconditionally
// used for payroll with no way for the owner to correct it (see
// resolveJobTrackingHours's PRE-fix precedence, tracked-always-wins). These
// tests cover the new precedence (owner override -> tracked -> existing
// fallback) and the Needs Review alert (scheduled vs. effective worked
// duration).
// ============================================================================

const ROXANA_SCHEDULED_MINUTES = 90; // 1h30m
const ROXANA_TRACKED_MINUTES = 48 * 60 + 58; // 48h58m

function roxanaScenario(overrides: { employeeHours?: EmployeeHours[] } = {}) {
  const startedAgo = ROXANA_TRACKED_MINUTES * 60 * 1000;
  const a = appt({
    id: "franklin-appt",
    scheduled_for: new Date(Date.now() - startedAgo).toISOString(),
    scheduled_end: new Date(Date.now() - startedAgo + ROXANA_SCHEDULED_MINUTES * 60 * 1000).toISOString(),
  });
  const asg = assignment({
    id: "ae-roxana", appointment_id: "franklin-appt", employee_id: "roxana",
    actual_started_at: new Date(Date.now() - startedAgo).toISOString(),
    actual_completed_at: new Date().toISOString(),
  });
  return { appt: a, assignment: asg, employeeHours: overrides.employeeHours ?? [] };
}

function manualEntry(overrides: Partial<EmployeeHours> = {}): EmployeeHours {
  return {
    id: "eh-override", appointment_id: "franklin-appt", employee_id: "roxana",
    hours_worked: 1, note: "Forgot to clock out. Job completed at 10:32 AM.",
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const WIDE_RANGE = { rangeStart: "2000-01-01", rangeEnd: "2100-01-01" };

describe("owner override precedence: resolveWorkedMinutes (display) and computePayrollRows (Weekly Worked Hours)", () => {
  test("with no owner override, a complete Job Tracking duration is used (unchanged behavior)", () => {
    const { appt: a, assignment: asg } = roxanaScenario();
    const mins = resolveWorkedMinutes(a.id, asg.employee_id, asg, []);
    assert.equal(mins, ROXANA_TRACKED_MINUTES);
  });

  test("owner override wins over an already-complete Job Tracking duration (the fix)", () => {
    const { appt: a, assignment: asg } = roxanaScenario();
    const override = manualEntry({ hours_worked: 86 / 60 }); // 1h26m, matches the spec's example
    const mins = resolveWorkedMinutes(a.id, asg.employee_id, asg, [override]);
    assert.equal(mins, 86, "1h26m, not the raw 2938-minute tracked duration");
  });

  test("with neither an override nor complete tracking, resolves to 0", () => {
    const a = appt({ id: "untracked" });
    const asg = assignment({ appointment_id: "untracked", employee_id: "emp-1" });
    assert.equal(resolveWorkedMinutes(a.id, asg.employee_id, asg, []), 0);
  });

  test("Weekly Worked Hours (computePayrollRows, default job_tracking mode) uses the corrected value, not the raw tracked duration -- Roxana's bug, fixed", () => {
    const employees: Employee[] = [{ id: "roxana", name: "Roxana", phone: null, color: "#000", active: true }];
    const { appt: a, assignment: asg } = roxanaScenario();

    const before = computePayrollRows({ appointments: [a], employees, employeeHours: [], assignments: [asg], ...WIDE_RANGE, timezone: TZ });
    assert.ok(Math.abs(before.rows[0].hoursWorked - ROXANA_TRACKED_MINUTES / 60) < 0.01, "before correction: the raw ~48.97h is what was totaled (the reported defect)");

    const corrected = computePayrollRows({
      appointments: [a], employees, employeeHours: [manualEntry({ hours_worked: 86 / 60 })], assignments: [asg], ...WIDE_RANGE, timezone: TZ,
    });
    assert.ok(Math.abs(corrected.rows[0].hoursWorked - 86 / 60) < 0.01, `after correction: ~1.43h, got ${corrected.rows[0].hoursWorked}`);
  });

  test("original actual_started_at/actual_completed_at are never read or mutated by the override -- they remain the source of the Original tracked time comparison", () => {
    const { appt: a, assignment: asg } = roxanaScenario();
    const before = { started: asg.actual_started_at, completed: asg.actual_completed_at };
    resolveWorkedMinutes(a.id, asg.employee_id, asg, [manualEntry()]);
    assert.equal(asg.actual_started_at, before.started);
    assert.equal(asg.actual_completed_at, before.completed);
    assert.equal(trackedMinutes(asg), ROXANA_TRACKED_MINUTES, "trackedMinutes still reports the original tracked duration after a correction exists");
  });
});

describe("needsWorkedTimeReview", () => {
  test("flags a large OVERAGE (Roxana's example: 1h30m scheduled, 48h58m tracked)", () => {
    const { appt: a, assignment: asg } = roxanaScenario();
    assert.equal(scheduledMinutes(a), ROXANA_SCHEDULED_MINUTES);
    assert.equal(needsWorkedTimeReview(a, a.id, asg.employee_id, asg, []), true);
  });

  test("flags a large UNDERRUN just as readily as an overage", () => {
    const a = appt({
      id: "underrun", scheduled_for: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS + 90 * 60 * 1000).toISOString(), // 90 min scheduled
    });
    const asg = assignment({
      appointment_id: "underrun", employee_id: "emp-1",
      actual_started_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - 2 * HOUR_MS + 5 * 60 * 1000).toISOString(), // 5 min tracked
    });
    assert.equal(needsWorkedTimeReview(a, a.id, asg.employee_id, asg, []), true);
  });

  test("no alert when the difference is inside threshold (small, ordinary variance)", () => {
    const a = appt({
      id: "ordinary", scheduled_for: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 2 * HOUR_MS + 90 * 60 * 1000).toISOString(), // 90 min scheduled
    });
    const asg = assignment({
      appointment_id: "ordinary", employee_id: "emp-1",
      actual_started_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - 2 * HOUR_MS + 95 * 60 * 1000).toISOString(), // 95 min tracked -- 5 min over
    });
    assert.equal(needsWorkedTimeReview(a, a.id, asg.employee_id, asg, []), false);
  });

  test("boundary: a difference of EXACTLY 30 minutes does not trigger (must be MORE than 30)", () => {
    const a = appt({
      id: "boundary-30", scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 3 * HOUR_MS + 100 * 60 * 1000).toISOString(), // 100 min scheduled
    });
    const asg = assignment({
      appointment_id: "boundary-30", employee_id: "emp-1",
      actual_started_at: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - 3 * HOUR_MS + 130 * 60 * 1000).toISOString(), // 130 min: diff=30 (>25% of 100, but not >30)
    });
    assert.equal(needsWorkedTimeReview(a, a.id, asg.employee_id, asg, []), false);
  });

  test("boundary: a difference of EXACTLY 25% of scheduled does not trigger (must be MORE than 25%)", () => {
    const a = appt({
      id: "boundary-25pct", scheduled_for: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 5 * HOUR_MS + 200 * 60 * 1000).toISOString(), // 200 min scheduled
    });
    const asg = assignment({
      appointment_id: "boundary-25pct", employee_id: "emp-1",
      actual_started_at: new Date(Date.now() - 5 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - 5 * HOUR_MS + 250 * 60 * 1000).toISOString(), // 250 min: diff=50 (>30, but exactly 25% of 200)
    });
    assert.equal(needsWorkedTimeReview(a, a.id, asg.employee_id, asg, []), false);
  });

  test("an owner correction that brings the effective duration back within threshold clears the alert automatically", () => {
    const { appt: a, assignment: asg } = roxanaScenario();
    assert.equal(needsWorkedTimeReview(a, a.id, asg.employee_id, asg, []), true, "flagged before correction");
    const correctedHours = [manualEntry({ hours_worked: 86 / 60 })]; // 1h26m, close to the 1h30m scheduled
    assert.equal(needsWorkedTimeReview(a, a.id, asg.employee_id, asg, correctedHours), false, "cleared after correction -- no stored resolved state, just recomputed");
  });

  test("a correction that is itself still far off keeps the alert showing (the alert reflects the current effective value, not merely that a correction exists)", () => {
    const { appt: a, assignment: asg } = roxanaScenario();
    const stillWrong = [manualEntry({ hours_worked: 40 })]; // an implausible 40h "correction"
    assert.equal(needsWorkedTimeReview(a, a.id, asg.employee_id, asg, stillWrong), true);
  });

  test("never flags an appointment with no worked-hours source at all -- that is the separate, pre-existing missing-hours concern", () => {
    const a = appt({
      id: "untouched", scheduled_for: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - HOUR_MS).toISOString(),
    });
    const asg = assignment({ appointment_id: "untouched", employee_id: "emp-1" });
    assert.equal(needsWorkedTimeReview(a, a.id, asg.employee_id, asg, []), false);
  });

  test("never flags when the appointment has no scheduled duration to compare against", () => {
    const { assignment: asg } = roxanaScenario();
    const a = appt({ id: "no-schedule", scheduled_end: null, duration_minutes: null });
    assert.equal(scheduledMinutes(a), 0);
    assert.equal(needsWorkedTimeReview(a, a.id, asg.employee_id, asg, []), false);
  });
});

describe("computePayrollRows -- reviewCount (Weekly Worked Hours review indicator)", () => {
  test("reviewCount reflects exactly the reviewable assignments for that employee in range", () => {
    const employees: Employee[] = [{ id: "roxana", name: "Roxana", phone: null, color: "#000", active: true }];
    const { appt: reviewable, assignment: asgReviewable } = roxanaScenario();
    const ordinary = appt({
      id: "ordinary-2", scheduled_for: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - 3 * HOUR_MS + 60 * 60 * 1000).toISOString(),
    });
    const asgOrdinary = assignment({
      appointment_id: "ordinary-2", employee_id: "roxana",
      actual_started_at: new Date(Date.now() - 3 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - 3 * HOUR_MS + 62 * 60 * 1000).toISOString(),
    });
    const { rows } = computePayrollRows({
      appointments: [reviewable, ordinary], employees, employeeHours: [],
      assignments: [asgReviewable, asgOrdinary], ...WIDE_RANGE, timezone: TZ,
    });
    const roxanaRow = rows.find((r) => r.employeeId === "roxana")!;
    assert.equal(roxanaRow.reviewCount, 1, "only the Roxana-scenario appointment is reviewable");
  });

  test("reviewCount is 0 for an employee with nothing needing review", () => {
    const employees: Employee[] = [{ id: "teresa", name: "Teresa", phone: null, color: "#000", active: true }];
    const a = appt({
      id: "clean", scheduled_for: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      scheduled_end: new Date(Date.now() - HOUR_MS).toISOString(),
    });
    const asg = assignment({
      appointment_id: "clean", employee_id: "teresa",
      actual_started_at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      actual_completed_at: new Date(Date.now() - HOUR_MS).toISOString(),
    });
    const { rows } = computePayrollRows({ appointments: [a], employees, employeeHours: [], assignments: [asg], ...WIDE_RANGE, timezone: TZ });
    assert.equal(rows[0].reviewCount, 0);
  });

  test("an owner correction clears reviewCount along with the alert", () => {
    const employees: Employee[] = [{ id: "roxana", name: "Roxana", phone: null, color: "#000", active: true }];
    const { appt: a, assignment: asg } = roxanaScenario();
    const before = computePayrollRows({ appointments: [a], employees, employeeHours: [], assignments: [asg], ...WIDE_RANGE, timezone: TZ });
    assert.equal(before.rows[0].reviewCount, 1);
    const after = computePayrollRows({
      appointments: [a], employees, employeeHours: [manualEntry({ hours_worked: 86 / 60 })], assignments: [asg], ...WIDE_RANGE, timezone: TZ,
    });
    assert.equal(after.rows[0].reviewCount, 0);
  });
});

describe("owner correction never opens a payable-hours path for an employee", () => {
  // Security: computePayrollRows/resolveWorkedMinutes/needsWorkedTimeReview
  // are pure functions over whatever employeeHours rows they're given --
  // they enforce no permission themselves (correct: that boundary is
  // app/api/appointments/employee-hours/route.ts's requireOwner, proven in
  // that route's own tests, and migrations/030's record_job_action, which
  // never writes appointment_employee_hours at all, proven in
  // test-db/recurrence.test.ts against real PostgreSQL). This test only
  // confirms these pure functions treat every appointment_employee_hours row
  // identically regardless of who or what produced it -- there is no
  // employee-id-based special case anywhere in this precedence to
  // accidentally bypass.
  test("resolveWorkedMinutes has no notion of who saved the override -- the security boundary is the API route, not this calculation", () => {
    const { appt: a, assignment: asg } = roxanaScenario();
    const mins = resolveWorkedMinutes(a.id, asg.employee_id, asg, [manualEntry()]);
    assert.equal(mins, 60, "the row's hours_worked is used exactly as stored -- provenance is enforced elsewhere");
  });
});
