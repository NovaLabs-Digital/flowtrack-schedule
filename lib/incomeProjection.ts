import type { Appointment, AppointmentEmployeeAssignment } from "@/app/components/dashboard/types";
import { toBusinessLocal } from "@/lib/timezone";
import { toDateInputValue, scheduledHours } from "@/lib/payroll";

export type IncomeProjectionResult = {
  estimatedIncomeCents: number;
  estimatedWorkHours: number;
};

// Estimated Income / Estimated Work Hours for the Income Projection card.
// Deliberately separate from lib/payroll.ts's computePayrollRows: that
// function answers "what did employees actually work" (Job Tracking /
// manual-entry actuals, only past-due appointments can be "missing"), while
// this answers "what does the schedule say we're expected to produce" --
// scheduled plan only, actual_started_at/actual_completed_at are never
// read here. The two intentionally use different eligibility rules, so
// they are not allowed to share one function.
//
// Price source: appointment.price_cents -- the per-appointment price
// snapshot (set at booking time, prefilled from the service's default but
// independently editable per job), NOT service.default_price_cents. There
// is no service_id foreign key on Appointment at all (services are matched
// by name via service_type only) -- appointment.price_cents avoids that
// fragile name-matching entirely and reflects what was actually
// quoted/committed for that specific job, which can differ from the
// service's current default. A missing/null price_cents contributes $0 for
// that appointment, never a guessed fallback.
//
// Callers must pass appointments/assignments already scoped to the
// authenticated workspace (exactly as computePayrollRows already assumes)
// -- this function performs no workspace filtering of its own.
export function computeIncomeProjection({
  appointments,
  assignments,
  rangeStart,
  rangeEnd,
}: {
  appointments: Appointment[];
  assignments: AppointmentEmployeeAssignment[];
  rangeStart: string;
  rangeEnd: string;
}): IncomeProjectionResult {
  const assignmentCountByAppointmentId = new Map<string, number>();
  for (const a of assignments) {
    assignmentCountByAppointmentId.set(a.appointment_id, (assignmentCountByAppointmentId.get(a.appointment_id) ?? 0) + 1);
  }

  let estimatedIncomeCents = 0;
  let estimatedWorkHours = 0;

  for (const appt of appointments) {
    if (appt.status === "cancelled") continue;

    const apptDate = toDateInputValue(toBusinessLocal(appt.scheduled_for));
    if (apptDate < rangeStart || apptDate > rangeEnd) continue;

    estimatedIncomeCents += appt.price_cents ?? 0;

    // Labor hours = scheduled duration x number of assigned employees --
    // an unassigned appointment contributes 0 hours here (but still
    // contributes its price to Estimated Income above; the two totals are
    // computed independently, per spec).
    const employeeCount = assignmentCountByAppointmentId.get(appt.id) ?? 0;
    estimatedWorkHours += scheduledHours(appt) * employeeCount;
  }

  return { estimatedIncomeCents, estimatedWorkHours };
}

// "$1,815.00" -- thousands-separated currency display. Distinct from
// lib/money.ts's formatCents (which intentionally has no separator and
// returns "—" for null/undefined, matching its own "no price set" use
// case) -- this display always has a value (0 for "no qualifying
// appointments"), never a "not set" state to represent.
export function formatProjectedIncome(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
