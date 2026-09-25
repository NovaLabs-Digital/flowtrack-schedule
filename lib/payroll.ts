import type { Appointment, Employee, EmployeeHours, AppointmentEmployeeAssignment } from "@/app/components/dashboard/types";
import { toBusinessLocal, isPastAppointment, type AppointmentPastInput } from "@/lib/timezone";

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
// assignment, OR an owner-saved appointment_employee_hours entry for that
// same appointment+employee (an owner correction/override -- see
// resolveWorkedMinutes below for which one WINS when both exist; this
// predicate only asks "is there anything to show at all," so it is
// order-independent). Single source of truth for "has worked hours been
// entered for this employee on this job?" — used by both the schedule
// grid's warning triangle and the Employee Worked Hours card, so they
// never disagree.
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

// The appointment's own scheduled duration in whole minutes: scheduled_end
// minus scheduled_for when both are set and positive, otherwise
// duration_minutes, otherwise 0. Single source of truth for "how long was
// this job supposed to take" -- shared by needsWorkedTimeReview below and
// every UI surface that shows a "Scheduled Time" line next to worked time,
// so they can never disagree about the scheduled duration one is being
// compared against. (scheduledHours further down is the identical
// calculation in decimal hours, for payroll's "scheduled_duration" mode --
// it now delegates to this function rather than re-deriving it.)
export function scheduledMinutes(appt: Pick<Appointment, "scheduled_for" | "scheduled_end" | "duration_minutes">): number {
  if (appt.scheduled_end) {
    const mins = Math.round((new Date(appt.scheduled_end).getTime() - new Date(appt.scheduled_for).getTime()) / 60_000);
    if (mins > 0) return mins;
  }
  return appt.duration_minutes ?? 0;
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

// ============================================================================
// Historical-record protection, completed-status correction: isPastAppointment
// (lib/timezone.ts) only ever considered cancelled status and elapsed
// scheduled_end -- it had no way to know an appointment was already marked
// completed via Job Tracking, since that lives on appointment_employees, not
// on the appointment row itself. An appointment with a 1-hour scheduled
// duration that every assigned employee finished in 20 minutes is a
// historical record the moment the last employee completes it, not an hour
// later when scheduled_end finally elapses -- reusing deriveAppointmentTrackingStatus
// above (lib/payroll.ts, not lib/timezone.ts, to avoid a circular import: this
// file already depends on lib/timezone.ts, never the other way around) is
// what "Do not assume one employee finishing means the whole appointment is
// completed" means in practice -- "completed" requires EVERY assigned
// employee's own isJobTrackingComplete to be true (deriveAppointmentTrackingStatus's
// own `.every()`), the exact same rule DispatchPanel's status pill and every
// other consumer of that function already uses. A single completed employee
// on a still-in-progress multi-employee job must NOT make the whole
// appointment historical.
//
// isJobTrackingComplete (used internally by deriveAppointmentTrackingStatus)
// parses actual_started_at/actual_completed_at via `new Date(iso)` -- safe
// here specifically because those columns are Postgres timestamptz values,
// always returned by Supabase as ISO 8601 strings carrying an explicit UTC
// offset (e.g. "2026-08-27T15:30:00.000Z"), never a naive "YYYY-MM-DD HH:mm"
// wall-clock string without one -- so this is a real, environment-independent
// instant comparison, not a host-timezone-dependent parse of a naive
// timestamp.
//
// This is the single canonical "is this appointment a historical record"
// predicate -- cancelled, OR completed (every assigned employee's Job
// Tracking done), OR its scheduled end has elapsed. Every UI surface and
// every server mutation route must call this (not isPastAppointment alone)
// to decide whether normal appointment-management actions are allowed.
export function isHistoricalAppointment(
  appt: AppointmentPastInput,
  assignments: TimestampPair[],
  now: Date = new Date()
): boolean {
  if (deriveAppointmentTrackingStatus(assignments) === "completed") return true;
  return isPastAppointment(appt, now);
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

// Resolves one employee's EFFECTIVE worked minutes on one appointment:
//
//   1. an owner-saved appointment_employee_hours entry, if one exists --
//      the owner-approved override/correction, and it wins even when a
//      complete Job Tracking duration also exists (that is the whole point
//      of the correction workflow: Job Tracking's own actual_started_at/
//      actual_completed_at are never modified -- see migrations/030 -- so
//      once an owner has corrected a mistake, this is the one place that
//      correction is allowed to outrank the raw tracked duration);
//   2. otherwise a complete Job Tracking duration on the assignment;
//   3. otherwise 0 (nothing recorded yet).
//
// This is the single precedence used everywhere worked time is displayed
// or totaled -- this function, resolveJobTrackingHours (computePayrollRows'
// own resolver) and needsWorkedTimeReview below must never diverge on it.
// Display-only in the sense that computePayrollRows has its own resolver
// (identical precedence, decimal hours instead of minutes) rather than
// calling this one directly, but the two are kept in lockstep deliberately.
export function resolveWorkedMinutes(
  appointmentId: string,
  employeeId: string,
  assignment: TimestampPair | undefined,
  employeeHours: EmployeeHours[]
): number {
  const manual = findManualHoursEntry(appointmentId, employeeId, employeeHours);
  if (manual) return Math.round(manual.hours_worked * 60);
  if (assignment && isJobTrackingComplete(assignment)) {
    return Math.round((new Date(assignment.actual_completed_at!).getTime() - new Date(assignment.actual_started_at!).getTime()) / 60_000);
  }
  return 0;
}

// The raw tracked duration in minutes when Job Tracking is complete, or null
// otherwise. Used only for the "Original tracked time" comparison line shown
// once an owner override exists (resolveWorkedMinutes above is what actually
// wins for display/payroll) -- never itself used for a payroll total.
export function trackedMinutes(assignment: TimestampPair | undefined): number | null {
  if (!assignment || !isJobTrackingComplete(assignment)) return null;
  return Math.round((new Date(assignment.actual_completed_at!).getTime() - new Date(assignment.actual_started_at!).getTime()) / 60_000);
}

// Minimum minutes of difference between scheduled and effective worked
// duration before Needs Review can trigger, and the minimum fraction of the
// scheduled duration that difference must also represent -- BOTH must hold
// (see needsWorkedTimeReview below). Exported so the UI can explain the
// threshold in copy without hardcoding it a second time.
export const REVIEW_MIN_DIFF_MINUTES = 30;
export const REVIEW_MIN_DIFF_FRACTION = 0.25;

// Sorted-array median: the middle value for an odd count, the average of
// the two middle values for an even count. Not exported -- an internal
// building block of needsWorkedTimeReview's peer comparison below.
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// True when this employee's assignment on this appointment needs office
// review before payroll. It always requires a usable effective worked
// duration first (an owner override or a complete Job Tracking duration --
// see assignmentHasWorkedHours/resolveWorkedMinutes above; an appointment
// with no worked-hours source at all is a "missing hours" case, a
// different, pre-existing concern handled by getMissingHoursEmployeeIds,
// not this one). What it is compared AGAINST then depends on how many of
// this appointment's assigned employees also have a usable duration:
//
//   A. Fewer than two (this is the only one, or every other assigned
//      employee is still untracked) -- compare against the appointment's
//      own scheduled duration, exactly as before.
//   B. Exactly one other employee has a usable duration -- compare
//      directly against THAT employee's duration (comparing against a
//      blend of the two, e.g. their average, would halve a real gap and
//      miss it -- see the "Teresa clocked in late" example below). With
//      only two employees, a large enough MUTUAL gap flags BOTH of them
//      (there is no third reference point to say algorithmically which one
//      is "the mistake" -- the office manager sees both entries and
//      decides); a smaller, one-sided gap can flag only one, because the
//      percentage test's own denominator (the OTHER employee's duration)
//      differs depending on which of the two is being evaluated.
//   C. Two or more other employees have a usable duration (three or more
//      total) -- compare against the MEDIAN of every employee's duration,
//      including this one's own. A single outlier does not drag every
//      other employee's baseline down with it the way comparing against
//      "everyone else's average" would (median is robust to one outlier;
//      an average, or a per-employee "leave this one out" mean, is not).
//
// Either way: difference > REVIEW_MIN_DIFF_MINUTES minutes AND >
// REVIEW_MIN_DIFF_FRACTION of the baseline, checked in both directions (a
// suspiciously short job is just as reviewable as a suspiciously long
// one -- e.g. Roxana's 48h58m against a 1h30m scheduled job in mode A, or
// an employee who clocked in ~30 minutes late while a coworker's tracking
// shows the normal duration in mode B). A zero-or-less baseline (no
// scheduled duration in mode A; a genuinely zero-minute peer duration in
// B/C, which isJobTrackingComplete already forbids in practice) has
// nothing meaningful to compare against, so it is never flagged.
//
// Two real appointments this distinction exists for:
//   - Teresa 2h01m / Roxana 1h59m on a 1h30m-scheduled job: nearly
//     identical to each other, so mode B/C must NOT flag either of them
//     just because both differ from the scheduled estimate -- the job
//     simply ran long. (Compare this to the OLD per-employee-only
//     comparison, mode A applied unconditionally, which flagged Teresa.)
//   - Teresa clocked in ~30 minutes late while a coworker's duration shows
//     the normal length: mode B (or C, with more coworkers) must flag
//     Teresa specifically, not the appointment as a whole and not her
//     coworker(s).
//
// Because this reads resolveWorkedMinutes (owner override first) for every
// employee involved, a correction that brings the effective duration back
// within threshold of its baseline clears the flag automatically on the
// very next read -- there is no separate "resolved" state to store or
// clear, for this employee OR for any peer whose own baseline shifts as a
// result.
export function needsWorkedTimeReview(
  appt: Pick<Appointment, "scheduled_for" | "scheduled_end" | "duration_minutes">,
  appointmentId: string,
  employeeId: string,
  apptAssignments: Pick<AppointmentEmployeeAssignment, "employee_id" | "actual_started_at" | "actual_completed_at">[],
  employeeHours: EmployeeHours[]
): boolean {
  const mine = apptAssignments.find((a) => a.employee_id === employeeId);
  if (!assignmentHasWorkedHours(appointmentId, employeeId, mine, employeeHours)) return false;
  const myMinutes = resolveWorkedMinutes(appointmentId, employeeId, mine, employeeHours);

  const peerMinutes = apptAssignments
    .filter((a) => a.employee_id !== employeeId)
    .filter((a) => assignmentHasWorkedHours(appointmentId, a.employee_id, a, employeeHours))
    .map((a) => resolveWorkedMinutes(appointmentId, a.employee_id, a, employeeHours));

  let baseline: number;
  if (peerMinutes.length === 0) {
    baseline = scheduledMinutes(appt); // mode A
  } else if (peerMinutes.length === 1) {
    baseline = peerMinutes[0]; // mode B
  } else {
    baseline = median([myMinutes, ...peerMinutes]); // mode C
  }
  if (baseline <= 0) return false;

  const diff = Math.abs(myMinutes - baseline);
  return diff > REVIEW_MIN_DIFF_MINUTES && diff > baseline * REVIEW_MIN_DIFF_FRACTION;
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
  // Count of this employee's in-range assignments where needsWorkedTimeReview
  // is true -- independent of `mode` (it always compares the OWNER-OVERRIDE-
  // FIRST effective worked duration against the scheduled duration, not
  // whichever value `mode` happened to total), so it stays meaningful even
  // when hoursWorked itself came from "scheduled_duration" or "manual_hours"
  // mode. 0 for an employee with nothing to review.
  reviewCount: number;
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
  return scheduledMinutes(appt) / 60;
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

// Resolves hours for one employee's assignment under "job_tracking" mode,
// with the same owner-override-first precedence as resolveWorkedMinutes
// above: a manually-saved appointment_employee_hours entry (the owner's
// correction/override) wins first, even over a complete tracked duration;
// otherwise that assignment's own actual Start/Complete timestamps,
// converted to decimal hours (e.g. 3h32m -> 3.5333... -> displayed as 3.53
// hrs). Returns null — counted as missing — only when neither source is
// available. Phase 5.7D-R18: reads the ASSIGNMENT's own timestamps, never
// the appointment's (legacy) actual_started_at/actual_completed_at, so two
// employees on the same appointment are never conflated.
function resolveJobTrackingHours(
  assignment: TimestampPair,
  appointmentId: string,
  employeeId: string,
  savedHoursByKey: Map<string, number>
): number | null {
  const key = `${appointmentId}|${employeeId}`;
  if (savedHoursByKey.has(key)) return savedHoursByKey.get(key)!;
  if (isJobTrackingComplete(assignment)) {
    const mins = (new Date(assignment.actual_completed_at!).getTime() - new Date(assignment.actual_started_at!).getTime()) / 60_000;
    return mins / 60;
  }
  return null;
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
  const reviewCounts = new Map<string, number>();
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

      // Needs Review is computed independently of `mode` above (it always
      // uses the owner-override-first effective duration -- see
      // needsWorkedTimeReview's own doc comment) and independently of
      // whether `hours` ended up null for the selected mode, so a
      // "manual_hours"-mode caller still gets an accurate review count even
      // though this employee's Job Tracking duration isn't what's being
      // totaled.
      if (needsWorkedTimeReview(appt, appt.id, employeeId, apptAssignments, employeeHours)) {
        reviewCounts.set(employeeId, (reviewCounts.get(employeeId) ?? 0) + 1);
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

  // Rows are still driven by `totals` alone (unchanged from before this
  // feature) -- reviewCount is looked up per row, never adds a row on its
  // own. In "job_tracking" mode (the only mode any caller actually uses
  // today) this never diverges: needsWorkedTimeReview already requires
  // assignmentHasWorkedHours, which is exactly resolveJobTrackingHours'
  // own non-null condition, so a reviewable assignment always already has a
  // totaled value and therefore always already has a row.
  const rows = Array.from(totals.entries())
    .map(([employeeId, hoursWorked]) => ({
      employeeId,
      employeeName: employeeById[employeeId]?.name ?? "Unknown",
      hoursWorked,
      reviewCount: reviewCounts.get(employeeId) ?? 0,
    }))
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));

  return { rows, missingHoursCount };
}
