import { Appointment, Employee, EmployeeHours } from "@/app/components/dashboard/types";

export function toDateInputValue(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "manual_hours" is the active mode for now — payroll totals come only from
// saved appointment_employee_hours entries, never from scheduled duration.
// "scheduled_duration" is kept for reference/future use (e.g. once a
// payroll_mode company setting exists) but is not used by default today.
// Future modes (e.g. "job_tracking", "fixed_weekly") extend this union and get
// their own resolver below — computePayrollRows's loop and PayrollSummary's
// rendering never change.
export type PayrollMode = "manual_hours" | "scheduled_duration";

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
  // Count of in-range, non-cancelled, assigned appointments with no saved hours
  // entry for their mode. Always 0 for "scheduled_duration" (it always has a
  // fallback value); meaningful for "manual_hours".
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

export function computePayrollRows({
  appointments,
  employees,
  employeeHours,
  rangeStart,
  rangeEnd,
  mode = "manual_hours",
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

    const apptDate = toDateInputValue(new Date(appt.scheduled_for));
    if (apptDate < rangeStart || apptDate > rangeEnd) continue;

    let hours: number | null;
    switch (mode) {
      case "scheduled_duration":
        hours = resolveScheduledDurationHours(appt, appt.employee_id, savedHoursByKey);
        break;
      case "manual_hours":
      default:
        hours = resolveManualHoursOnly(appt, appt.employee_id, savedHoursByKey);
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
