import type { Appointment, Employee, EmployeeHours } from "@/app/components/dashboard/types";
import { toBusinessLocal } from "@/lib/timezone";

export function toDateInputValue(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// True when an appointment has a usable worked-hours source: a completed
// Job Tracking duration (preferred) or a manually-saved
// appointment_employee_hours entry (fallback only). Single source of truth
// for "has worked hours been entered?" — used by both the schedule grid's
// warning triangle and the Employee Worked Hours card, so they never disagree
// about the same appointment.
export function hasWorkedHours(appt: Appointment, employeeHours: EmployeeHours[]): boolean {
  const hasJobTracking =
    !!appt.actual_started_at &&
    !!appt.actual_completed_at &&
    new Date(appt.actual_completed_at).getTime() > new Date(appt.actual_started_at).getTime();
  if (hasJobTracking) return true;
  // Must match the applicable employee too, not just the appointment — a
  // manual entry is only valid for the employee it was actually saved
  // against (see app/api/appointments/employee-hours/route.ts's
  // appointment_id+employee_id upsert key). `?? null` normalizes
  // appointment_id's optional-with-undefined typing against
  // EmployeeHours.employee_id's `string | null`.
  return employeeHours.some((h) => h.appointment_id === appt.id && h.employee_id === (appt.employee_id ?? null));
}

// True when an appointment needs attention: in the past, not cancelled, and
// has no worked-hours source yet (see hasWorkedHours above).
export function needsWorkedHoursAttention(appt: Appointment, employeeHours: EmployeeHours[]): boolean {
  return (
    appt.status !== "cancelled" &&
    new Date(appt.scheduled_for).getTime() < Date.now() &&
    !hasWorkedHours(appt, employeeHours)
  );
}

// Resolves the actual worked minutes for one appointment/employee, with the
// same Job-Tracking-preferred, manual-entry-fallback precedence as
// hasWorkedHours above. Display-only (e.g. the Employee Worked Hours card's
// read-only "Worked Time" value) — does not affect computePayrollRows.
export function resolveWorkedMinutes(appt: Appointment, employeeHours: EmployeeHours[], employeeId: string): number {
  if (appt.actual_started_at && appt.actual_completed_at) {
    const mins = Math.round((new Date(appt.actual_completed_at).getTime() - new Date(appt.actual_started_at).getTime()) / 60_000);
    if (mins > 0) return mins;
  }
  const manual = employeeHours.find((h) => h.appointment_id === appt.id && h.employee_id === employeeId);
  return manual ? Math.round(manual.hours_worked * 60) : 0;
}

// Formats a decimal hours value (e.g. a PayrollRow's hoursWorked) as "45m",
// "1h 00m", "2h 30m" — same style as the dispatch panel's worked-time
// display. Used by the employee PWA's own "My Worked Hours" summary so its
// formatting matches the manager dashboard without importing dashboard UI.
export function formatHoursAsDuration(hours: number): string {
  const totalMins = Math.round(hours * 60);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

// "job_tracking" is the active mode for now — payroll totals come only from
// actual Start/Complete timestamps, never from scheduled duration.
// "scheduled_duration" and "manual_hours" are kept for future use (e.g. once a
// payroll_mode company setting exists) but are not used by default today.
// Future modes (e.g. "fixed_weekly") extend this union and get their own
// resolver below — computePayrollRows's loop and PayrollSummary's rendering
// never change.
export type PayrollMode = "job_tracking" | "manual_hours" | "scheduled_duration";

// One employee's payroll totals for a date range. Kept as its own shape so future
// columns (hourly rate, overtime, PTO, vacation, gross pay...) can be added here
// without changing how rows are computed or rendered.
export type PayrollRow = {
  employeeId: string;
  employeeName: string;
  hoursWorked: number;
};

export type PayrollComputation = {
  rows: PayrollRow[];
  // Count of in-range, non-cancelled, assigned appointments with no usable
  // hours source for the active mode. Always 0 for "scheduled_duration" (it
  // always has a fallback value); meaningful for "manual_hours" and
  // "job_tracking".
  missingHoursCount: number;
};

function scheduledHours(appt: Appointment): number {
  if (appt.scheduled_end) {
    const mins = Math.round((new Date(appt.scheduled_end).getTime() - new Date(appt.scheduled_for).getTime()) / 60_000);
    if (mins > 0) return mins / 60;
  }
  return (appt.duration_minutes ?? 0) / 60;
}

// Resolves hours for one appointment/employee under "scheduled_duration" mode: a
// manually-saved entry (appointment_employee_hours) is an override; otherwise
// falls back to the appointment's scheduled duration. Scheduled duration is
// only an estimate, so this mode never reports a "missing" appointment.
function resolveScheduledDurationHours(
  appt: Appointment,
  employeeId: string,
  savedHoursByKey: Map<string, number>
): number {
  const key = `${appt.id}|${employeeId}`;
  return savedHoursByKey.has(key) ? savedHoursByKey.get(key)! : scheduledHours(appt);
}

// Resolves hours for one appointment/employee under "manual_hours" mode: only a
// saved appointment_employee_hours entry counts. Returns null when nothing has
// been entered yet, so the caller can flag it rather than guessing from the
// schedule.
function resolveManualHoursOnly(
  appt: Appointment,
  employeeId: string,
  savedHoursByKey: Map<string, number>
): number | null {
  const key = `${appt.id}|${employeeId}`;
  return savedHoursByKey.has(key) ? savedHoursByKey.get(key)! : null;
}

// Resolves hours for one appointment under "job_tracking" mode: actual
// Start/Complete timestamps first, converted to decimal hours (e.g. 3h32m ->
// 3.5333... -> displayed as 3.53 hrs); falls back to a manually-saved
// appointment_employee_hours entry when job tracking wasn't used for this
// appointment. Returns null — counted as missing — only when neither source
// is available. This mirrors the schedule grid's hours-warning definition
// (see ScheduleGrid.tsx) so the two features never disagree about whether an
// appointment's worked hours have been entered.
function resolveJobTrackingHours(
  appt: Appointment,
  employeeId: string,
  savedHoursByKey: Map<string, number>
): number | null {
  if (appt.actual_started_at && appt.actual_completed_at) {
    const mins = (new Date(appt.actual_completed_at).getTime() - new Date(appt.actual_started_at).getTime()) / 60_000;
    if (mins > 0) return mins / 60;
  }
  const key = `${appt.id}|${employeeId}`;
  return savedHoursByKey.has(key) ? savedHoursByKey.get(key)! : null;
}

export function computePayrollRows({
  appointments,
  employees,
  employeeHours,
  rangeStart,
  rangeEnd,
  mode = "job_tracking",
}: {
  appointments: Appointment[];
  employees: Employee[];
  employeeHours: EmployeeHours[];
  rangeStart: string;
  rangeEnd: string;
  mode?: PayrollMode;
}): PayrollComputation {
  const employeeById: Record<string, Employee> = {};
  for (const e of employees) employeeById[e.id] = e;

  const savedHoursByKey = new Map<string, number>();
  for (const entry of employeeHours) {
    if (!entry.employee_id) continue;
    savedHoursByKey.set(`${entry.appointment_id}|${entry.employee_id}`, entry.hours_worked);
  }

  const totals = new Map<string, number>();
  let missingHoursCount = 0;

  for (const appt of appointments) {
    if (appt.status === "cancelled") continue;
    if (!appt.employee_id) continue;

    const apptDate = toDateInputValue(toBusinessLocal(appt.scheduled_for));
    if (apptDate < rangeStart || apptDate > rangeEnd) continue;

    let hours: number | null;
    switch (mode) {
      case "scheduled_duration":
        hours = resolveScheduledDurationHours(appt, appt.employee_id, savedHoursByKey);
        break;
      case "manual_hours":
        hours = resolveManualHoursOnly(appt, appt.employee_id, savedHoursByKey);
        break;
      case "job_tracking":
      default:
        hours = resolveJobTrackingHours(appt, appt.employee_id, savedHoursByKey);
        break;
    }

    if (hours === null) {
      missingHoursCount++;
      continue;
    }

    totals.set(appt.employee_id, (totals.get(appt.employee_id) ?? 0) + hours);
  }

  const rows = Array.from(totals.entries())
    .map(([employeeId, hoursWorked]) => ({
      employeeId,
      employeeName: employeeById[employeeId]?.name ?? "Unknown",
      hoursWorked,
    }))
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));

  return { rows, missingHoursCount };
}
