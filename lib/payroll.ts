import type { Appointment, Employee, EmployeeHours } from "@/app/components/dashboard/types";
import { toBusinessLocal } from "@/lib/timezone";

export function toDateInputValue(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Minimum tracked duration (milliseconds) for automatic Job Tracking to
// count as complete. A clock-in/clock-out pair separated by only a few
// seconds is almost always a mistake (forgot to start the job earlier, or
// immediately re-tapped by accident), not a real sub-minute job — treating
// it as valid would silently record "0m" (or a rounding artifact like "1m"
// for a 45-second gap) as if it were real tracked time.
const MIN_VALID_TRACKING_MS = 60_000;

// True when an appointment has a real, complete Job Tracking duration:
// both timestamps present, parseable, completed strictly after started,
// and the gap is at least MIN_VALID_TRACKING_MS. Only the two timestamp
// fields are read, so this also accepts the server route's minimal
// `{actual_started_at, actual_completed_at}` select — it doesn't need a
// full Appointment object. Shared by hasWorkedHours below, the
// employee-hours API route's override guard, and every UI surface that
// needs to say "tracked automatically" vs. "manually entered" (schedule
// grid warning triangle, AppointmentModal's Job Tracking card,
// DispatchPanel's Employee Worked Hours card) — they must never diverge on
// what counts as automatic.
export function isJobTrackingComplete(appt: Pick<Appointment, "actual_started_at" | "actual_completed_at">): boolean {
  if (!appt.actual_started_at || !appt.actual_completed_at) return false;
  const startedMs = new Date(appt.actual_started_at).getTime();
  const completedMs = new Date(appt.actual_completed_at).getTime();
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) return false;
  return completedMs - startedMs >= MIN_VALID_TRACKING_MS;
}

// True specifically when both timestamps are present but the tracked
// duration doesn't qualify (zero, negative, sub-minute, or malformed) —
// distinct from "never clocked in/out at all". UI surfaces use this to
// show "Clock-in and clock-out produced no valid worked time." instead of
// the generic "Employee did not complete Job Tracking." warning, and to
// preserve both real timestamps rather than treating the appointment as if
// nothing was ever recorded.
export function hasInvalidJobTrackingDuration(appt: Pick<Appointment, "actual_started_at" | "actual_completed_at">): boolean {
  return !!appt.actual_started_at && !!appt.actual_completed_at && !isJobTrackingComplete(appt);
}

// Finds the applicable-employee manual-hours entry for an appointment, if
// any. Matches both appointment_id and employee_id — a manual entry is only
// valid for the employee it was actually saved against (see
// app/api/appointments/employee-hours/route.ts's appointment_id+employee_id
// upsert key), and `?? null` normalizes appointment_id's optional-with-
// undefined typing against EmployeeHours.employee_id's `string | null`.
// Returns the full row (not just a boolean) since callers like the
// appointment modal's Job Tracking card need its hours_worked/note too.
export function findManualHoursEntry(appt: Appointment, employeeHours: EmployeeHours[]): EmployeeHours | null {
  return employeeHours.find((h) => h.appointment_id === appt.id && h.employee_id === (appt.employee_id ?? null)) ?? null;
}

// True when an appointment has a usable worked-hours source: a completed
// Job Tracking duration (preferred) or a manually-saved
// appointment_employee_hours entry (fallback only). Single source of truth
// for "has worked hours been entered?" — used by both the schedule grid's
// warning triangle and the Employee Worked Hours card, so they never disagree
// about the same appointment.
export function hasWorkedHours(appt: Appointment, employeeHours: EmployeeHours[]): boolean {
  if (isJobTrackingComplete(appt)) return true;
  return !!findManualHoursEntry(appt, employeeHours);
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
  if (isJobTrackingComplete(appt)) {
    return Math.round((new Date(appt.actual_completed_at!).getTime() - new Date(appt.actual_started_at!).getTime()) / 60_000);
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

// Formats a whole-minutes duration as "45m", "1h 00m", "2h 30m" — the
// minutes-based counterpart to formatHoursAsDuration above (which takes
// decimal hours instead). Shared by the Employee Worked Hours card, the
// appointment modal's Job Tracking card, and the dispatch panel so a
// worked duration always reads identically everywhere it appears.
export function formatMinutesAsDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
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
  if (isJobTrackingComplete(appt)) {
    const mins = (new Date(appt.actual_completed_at!).getTime() - new Date(appt.actual_started_at!).getTime()) / 60_000;
    return mins / 60;
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
