import type { Appointment, Employee, EmployeeHours, AppointmentEmployeeAssignment } from "@/app/components/dashboard/types";
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

// A generic {actual_started_at, actual_completed_at} shape -- deliberately
// not tied to Appointment. Phase 5.7D-R18 moved Job Tracking timestamps
// from the appointment itself down to each individual employee assignment
// (see AppointmentEmployeeAssignment in app/components/dashboard/types.ts
// and migrations/021) -- this predicate is the same either way, so it's
// typed to accept both an assignment row and (for pre-R18 historical data
// still sitting on the appointment) an Appointment.
export type TimestampPair = { actual_started_at: string | null; actual_completed_at: string | null };

// True when a {actual_started_at, actual_completed_at} pair represents a
// real, complete Job Tracking duration: both timestamps present,
// parseable, completed strictly after started, and the gap is at least
// MIN_VALID_TRACKING_MS. Shared by hasWorkedHours below, the employee-hours
// API route's override guard, and every UI surface that needs to say
// "tracked automatically" vs. "manually entered" (schedule grid warning
// triangle, AppointmentModal's Job Tracking card, DispatchPanel's Employee
// Worked Hours card) — they must never diverge on what counts as
// automatic. As of Phase 5.7D-R18 this is called with an
// AppointmentEmployeeAssignment (the authoritative per-employee source)
// almost everywhere; the appointment-level fields it also still accepts
// are frozen historical data only (see migrations/021's column comments).
export function isJobTrackingComplete(record: TimestampPair): boolean {
  if (!record.actual_started_at || !record.actual_completed_at) return false;
  const startedMs = new Date(record.actual_started_at).getTime();
  const completedMs = new Date(record.actual_completed_at).getTime();
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs)) return false;
  return completedMs - startedMs >= MIN_VALID_TRACKING_MS;
}

// True specifically when both timestamps are present but the tracked
// duration doesn't qualify (zero, negative, sub-minute, or malformed) —
// distinct from "never clocked in/out at all". UI surfaces use this to
// show "Clock-in and clock-out produced no valid worked time." instead of
// the generic "Employee did not complete Job Tracking." warning, and to
// preserve both real timestamps rather than treating the assignment as if
// nothing was ever recorded.
export function hasInvalidJobTrackingDuration(record: TimestampPair): boolean {
  return !!record.actual_started_at && !!record.actual_completed_at && !isJobTrackingComplete(record);
}

// Finds the applicable-employee manual-hours entry for one appointment +
// employee, if any. A manual entry is only valid for the exact employee it
// was actually saved against (see
// app/api/appointments/employee-hours/route.ts's appointment_id+employee_id
// upsert key). Returns the full row (not just a boolean) since callers like
// the appointment modal's Job Tracking card need its hours_worked/note too.
export function findManualHoursEntry(appointmentId: string, employeeId: string, employeeHours: EmployeeHours[]): EmployeeHours | null {
  return employeeHours.find((h) => h.appointment_id === appointmentId && h.employee_id === employeeId) ?? null;
}

// True when one employee's assignment on one appointment has a usable
// worked-hours source: a completed Job Tracking duration on that
// assignment (preferred) or a manually-saved appointment_employee_hours
// entry for that same appointment+employee (fallback only). Single source
// of truth for "has worked hours been entered for this employee on this
// job?" — used by both the schedule grid's warning triangle and the
// Employee Worked Hours card, so they never disagree.
export function assignmentHasWorkedHours(
  appointmentId: string,
  employeeId: string,
  assignment: TimestampPair | undefined,
  employeeHours: EmployeeHours[]
): boolean {
  if (assignment && isJobTrackingComplete(assignment)) return true;
  return !!findManualHoursEntry(appointmentId, employeeId, employeeHours);
}

// The instant an appointment is actually over: its own scheduled_end when
// present, otherwise scheduled_for + duration_minutes, otherwise just
// scheduled_for (no duration information at all). Mirrors scheduledHours()
// below's identical fallback order. Absolute-instant arithmetic throughout
// (new Date(iso).getTime() + milliseconds) -- never toBusinessLocal(), whose
// synthesized Date is explicitly documented as unsafe for instant
// comparisons (see lib/timezone.ts). This makes the result correct
// regardless of DST or which timezone the server/browser happens to be in.
function effectiveEndMs(appt: Pick<Appointment, "scheduled_for" | "scheduled_end" | "duration_minutes">): number {
  if (appt.scheduled_end) {
    const endMs = new Date(appt.scheduled_end).getTime();
    if (Number.isFinite(endMs)) return endMs;
  }
  const startMs = new Date(appt.scheduled_for).getTime();
  return startMs + (appt.duration_minutes ?? 0) * 60_000;
}

// True only once an appointment's scheduled end has actually passed --
// never for a future appointment, and never for one still in progress
// (started but not yet ended). This is the single eligibility gate for
// "can this appointment even be flagged as missing worked hours yet,"
// shared by needsWorkedHoursAttention (per-appointment icon,
// DispatchPanel's "needs attention" state) and computePayrollRows
// (missingHoursCount / the weekly warning banner) below, so the two
// surfaces can never disagree about a not-yet-due appointment. Purely
// time-based -- has no employee dimension, so it is unaffected by how many
// employees (zero, one, or many) are assigned.
export function isEligibleForWorkedHoursWarning(appt: Pick<Appointment, "scheduled_for" | "scheduled_end" | "duration_minutes">): boolean {
  return effectiveEndMs(appt) < Date.now();
}

// Phase 5.7D-R18: an appointment-level tracking summary derived entirely
// from its assignment rows, never from the legacy appointment-level
// actual_started_at/actual_completed_at (which stop being written to once
// any assignment exists -- see migrations/021).
//
//   - "scheduled": no assigned employee has started yet. A zero-assignment
//     appointment is always "scheduled" -- it can never be vacuously
//     "completed" just because there's nothing to check.
//   - "in_progress": at least one assigned employee has started, but not
//     every assigned employee has a valid completed timestamp. This
//     includes the mixed case where one employee finished and another
//     hasn't started at all.
//   - "completed": at least one employee is assigned, and every assigned
//     employee has a valid (isJobTrackingComplete) completed timestamp.
export type AssignmentTrackingStatus = "scheduled" | "in_progress" | "completed";

export function deriveAppointmentTrackingStatus(assignments: TimestampPair[]): AssignmentTrackingStatus {
  if (assignments.length === 0) return "scheduled";
  const anyStarted = assignments.some((a) => !!a.actual_started_at);
  if (!anyStarted) return "scheduled";
  const allComplete = assignments.every((a) => isJobTrackingComplete(a));
  return allComplete ? "completed" : "in_progress";
}

// The employee_ids of assigned employees who are missing worked hours for
// this appointment -- empty for a cancelled or not-yet-eligible
// appointment, or one with zero assignments (nothing to check). Lets a UI
// surface identify WHICH employee(s) still need attention, per Phase
// 5.7D-R18 (e.g. "Teresa: tracked, Roxana: needs attention").
export function getMissingHoursEmployeeIds(
  appt: Pick<Appointment, "id" | "status" | "scheduled_for" | "scheduled_end" | "duration_minutes">,
  assignments: Pick<AppointmentEmployeeAssignment, "employee_id" | "actual_started_at" | "actual_completed_at">[],
  employeeHours: EmployeeHours[]
): string[] {
  if (appt.status === "cancelled") return [];
  if (!isEligibleForWorkedHoursWarning(appt)) return [];
  return assignments
    .filter((a) => !assignmentHasWorkedHours(appt.id, a.employee_id, a, employeeHours))
    .map((a) => a.employee_id);
}

// True when at least one assigned employee needs attention (see
// getMissingHoursEmployeeIds above). Zero-assignment appointments are never
// flagged -- there is no one to be missing hours from.
export function needsWorkedHoursAttention(
  appt: Pick<Appointment, "id" | "status" | "scheduled_for" | "scheduled_end" | "duration_minutes">,
  assignments: Pick<AppointmentEmployeeAssignment, "employee_id" | "actual_started_at" | "actual_completed_at">[],
  employeeHours: EmployeeHours[]
): boolean {
  return getMissingHoursEmployeeIds(appt, assignments, employeeHours).length > 0;
}

// Resolves one employee's actual worked minutes on one appointment, with
// the same Job-Tracking-preferred, manual-entry-fallback precedence as
// assignmentHasWorkedHours above. Display-only (e.g. the Employee Worked
// Hours card's read-only "Worked Time" value) — does not affect
// computePayrollRows.
export function resolveWorkedMinutes(
  appointmentId: string,
  employeeId: string,
  assignment: TimestampPair | undefined,
  employeeHours: EmployeeHours[]
): number {
  if (assignment && isJobTrackingComplete(assignment)) {
    return Math.round((new Date(assignment.actual_completed_at!).getTime() - new Date(assignment.actual_started_at!).getTime()) / 60_000);
  }
  const manual = findManualHoursEntry(appointmentId, employeeId, employeeHours);
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
  // Count of in-range, non-cancelled, assigned (appointment, employee)
  // pairs with no usable hours source for the active mode. Phase
  // 5.7D-R18: an appointment with two assigned employees can contribute up
  // to two independent "missing" counts, one per employee who hasn't been
  // tracked yet -- see Section E.7's Teresa/Roxana example. Always 0 for
  // "scheduled_duration" (it always has a fallback value); meaningful for
  // "manual_hours" and "job_tracking".
  missingHoursCount: number;
};

// Exported for lib/incomeProjection.ts, which needs the identical scheduled-
// duration calculation for its own labor-hours estimate -- reusing this
// rather than re-deriving it keeps the two features from ever disagreeing
// about what "the scheduled duration of an appointment" means.
export function scheduledHours(appt: Appointment): number {
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
  appointmentId: string,
  employeeId: string,
  savedHoursByKey: Map<string, number>
): number | null {
  const key = `${appointmentId}|${employeeId}`;
  return savedHoursByKey.has(key) ? savedHoursByKey.get(key)! : null;
}

// Resolves hours for one employee's assignment under "job_tracking" mode:
// that assignment's own actual Start/Complete timestamps first, converted
// to decimal hours (e.g. 3h32m -> 3.5333... -> displayed as 3.53 hrs);
// falls back to a manually-saved appointment_employee_hours entry when Job
// Tracking wasn't used for this assignment. Returns null — counted as
// missing — only when neither source is available. Phase 5.7D-R18: reads
// the ASSIGNMENT's own timestamps, never the appointment's (legacy)
// actual_started_at/actual_completed_at, so two employees on the same
// appointment are never conflated.
function resolveJobTrackingHours(
  assignment: TimestampPair,
  appointmentId: string,
  employeeId: string,
  savedHoursByKey: Map<string, number>
): number | null {
  if (isJobTrackingComplete(assignment)) {
    const mins = (new Date(assignment.actual_completed_at!).getTime() - new Date(assignment.actual_started_at!).getTime()) / 60_000;
    return mins / 60;
  }
  const key = `${appointmentId}|${employeeId}`;
  return savedHoursByKey.has(key) ? savedHoursByKey.get(key)! : null;
}

export function computePayrollRows({
  appointments,
  employees,
  employeeHours,
  assignments,
  rangeStart,
  rangeEnd,
  mode = "job_tracking",
  timezone,
}: {
  appointments: Appointment[];
  employees: Employee[];
  employeeHours: EmployeeHours[];
  // Phase 5.7D-R18: every appointment_employees row for the workspace (not
  // pre-filtered to one appointment) -- grouped internally by
  // appointment_id below. An appointment absent here (zero assignments)
  // contributes nothing, matching the pre-R18 "skip unassigned
  // appointments" behavior exactly.
  assignments: AppointmentEmployeeAssignment[];
  rangeStart: string;
  rangeEnd: string;
  mode?: PayrollMode;
  // The workspace's own resolved timezone -- required, no default. Range
  // inclusion (rangeStart/rangeEnd) is decided by the appointment's
  // WORKSPACE-LOCAL calendar date; the actual worked-duration calculations
  // below (job-tracking timestamp deltas, scheduledHours) remain absolute
  // instant math, deliberately untouched by this parameter -- a tracked
  // duration must never be distorted by which zone it's bucketed into.
  timezone: string;
}): PayrollComputation {
  const employeeById: Record<string, Employee> = {};
  for (const e of employees) employeeById[e.id] = e;

  const savedHoursByKey = new Map<string, number>();
  for (const entry of employeeHours) {
    if (!entry.employee_id) continue;
    savedHoursByKey.set(`${entry.appointment_id}|${entry.employee_id}`, entry.hours_worked);
  }

  const assignmentsByAppointmentId = new Map<string, AppointmentEmployeeAssignment[]>();
  for (const a of assignments) {
    const list = assignmentsByAppointmentId.get(a.appointment_id);
    if (list) list.push(a);
    else assignmentsByAppointmentId.set(a.appointment_id, [a]);
  }

  const totals = new Map<string, number>();
  let missingHoursCount = 0;

  for (const appt of appointments) {
    if (appt.status === "cancelled") continue;

    const apptAssignments = assignmentsByAppointmentId.get(appt.id);
    if (!apptAssignments || apptAssignments.length === 0) continue;

    const apptDate = toDateInputValue(toBusinessLocal(appt.scheduled_for, timezone));
    if (apptDate < rangeStart || apptDate > rangeEnd) continue;

    for (const assignment of apptAssignments) {
      const employeeId = assignment.employee_id;

      let hours: number | null;
      switch (mode) {
        case "scheduled_duration":
          hours = resolveScheduledDurationHours(appt, employeeId, savedHoursByKey);
          break;
        case "manual_hours":
          hours = resolveManualHoursOnly(appt.id, employeeId, savedHoursByKey);
          break;
        case "job_tracking":
        default:
          hours = resolveJobTrackingHours(assignment, appt.id, employeeId, savedHoursByKey);
          break;
      }

      if (hours === null) {
        // A future or currently-in-progress appointment simply hasn't
        // happened yet -- it is never "missing" worked hours, only not due
        // yet. Only an appointment whose scheduled end has already passed can
        // be counted here (see isEligibleForWorkedHoursWarning above).
        if (isEligibleForWorkedHoursWarning(appt)) {
          missingHoursCount++;
        }
        continue;
      }

      totals.set(employeeId, (totals.get(employeeId) ?? 0) + hours);
    }
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
