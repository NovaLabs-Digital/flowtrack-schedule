import { Appointment, Employee, EmployeeHours } from "@/app/components/dashboard/types";

export function toDateInputValue(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Only "scheduled_duration" is implemented today. Future modes (e.g. "job_tracking",
// "manual_hours", "fixed_weekly") extend this union and get their own resolver
// below — computePayrollRows's loop and PayrollSummary's rendering never change.
export type PayrollMode = "scheduled_duration";

// One employee's payroll totals for a date range. Kept as its own shape so future
// columns (hourly rate, overtime, PTO, vacation, gross pay...) can be added here
// without changing how rows are computed or rendered.
export type PayrollRow = {
  employeeId: string;
  employeeName: string;
  hoursWorked: number;
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
// falls back to the appointment's scheduled duration.
function resolveScheduledDurationHours(
  appt: Appointment,
  employeeId: string,
  savedHoursByKey: Map<string, number>
): number {
  const key = `${appt.id}|${employeeId}`;
  return savedHoursByKey.has(key) ? savedHoursByKey.get(key)! : scheduledHours(appt);
}

export function computePayrollRows({
  appointments,
  employees,
  employeeHours,
  rangeStart,
  rangeEnd,
  mode = "scheduled_duration",
}: {
  appointments: Appointment[];
  employees: Employee[];
  employeeHours: EmployeeHours[];
  rangeStart: string;
  rangeEnd: string;
  mode?: PayrollMode;
}): PayrollRow[] {
  const employeeById: Record<string, Employee> = {};
  for (const e of employees) employeeById[e.id] = e;

  // Manually-saved hours are overrides, keyed by appointment+employee — not the
  // source of totals. An appointment with no saved entry still counts.
  const savedHoursByKey = new Map<string, number>();
  for (const entry of employeeHours) {
    if (!entry.employee_id) continue;
    savedHoursByKey.set(`${entry.appointment_id}|${entry.employee_id}`, entry.hours_worked);
  }

  const totals = new Map<string, number>();
  for (const appt of appointments) {
    if (appt.status === "cancelled") continue;
    if (!appt.employee_id) continue;

    const apptDate = toDateInputValue(new Date(appt.scheduled_for));
    if (apptDate < rangeStart || apptDate > rangeEnd) continue;

    let hours: number;
    switch (mode) {
      case "scheduled_duration":
      default:
        hours = resolveScheduledDurationHours(appt, appt.employee_id, savedHoursByKey);
        break;
    }

    totals.set(appt.employee_id, (totals.get(appt.employee_id) ?? 0) + hours);
  }

  return Array.from(totals.entries())
    .map(([employeeId, hoursWorked]) => ({
      employeeId,
      employeeName: employeeById[employeeId]?.name ?? "Unknown",
      hoursWorked,
    }))
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}
