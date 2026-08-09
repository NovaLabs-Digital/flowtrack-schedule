"use client";

import { Appointment, Employee, EmployeeHours, AppointmentEmployeeAssignment } from "@/app/components/dashboard/types";
import { computePayrollRows } from "@/lib/payroll";

// The Mon-Fri default and its two editable date inputs are unchanged from
// before -- only where rangeStart/rangeEnd LIVE has moved. They're now
// owned by DispatchPanel (see its mondayOfCurrentWeek/addDays helpers) so
// the new Income Projection card can read the exact same selected period
// this card shows, rather than each card computing its own answer to
// "which week." This component's own calculation (computePayrollRows) is
// untouched.
export default function PayrollSummary({
  appointments,
  employees,
  employeeHours,
  assignments,
  rangeStart,
  rangeEnd,
  onRangeStartChange,
  onRangeEndChange,
  timezone,
}: {
  appointments: Appointment[];
  employees: Employee[];
  employeeHours: EmployeeHours[];
  assignments: AppointmentEmployeeAssignment[];
  rangeStart: string;
  rangeEnd: string;
  onRangeStartChange: (value: string) => void;
  onRangeEndChange: (value: string) => void;
  // The workspace's own resolved timezone -- passed through unchanged to
  // computePayrollRows, which uses it to decide each appointment's
  // WORKSPACE-LOCAL calendar date for range inclusion. Worked-duration math
  // itself remains absolute instant math, unaffected by this value.
  timezone: string;
}) {
  const { rows, missingHoursCount } = computePayrollRows({ appointments, employees, employeeHours, assignments, rangeStart, rangeEnd, timezone });
  const totalHours = rows.reduce((sum, r) => sum + r.hoursWorked, 0);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4 shrink-0">
      <div className="text-sm font-semibold text-slate-900">Weekly Worked Hours</div>

      <div className="mt-3 flex items-center gap-2 text-xs">
        <span className="text-slate-500 shrink-0">Week</span>
        <input
          type="date"
          value={rangeStart}
          onChange={(e) => onRangeStartChange(e.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <span className="text-slate-400">&#8594;</span>
        <input
          type="date"
          value={rangeEnd}
          onChange={(e) => onRangeEndChange(e.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="mt-3">
        {rows.length === 0 && missingHoursCount === 0 ? (
          <div className="text-xs text-slate-400">No assigned appointments in this range.</div>
        ) : rows.length > 0 ? (
          <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5">
            {rows.map((r) => (
              <div key={r.employeeId} className="contents">
                <span className="text-xs text-slate-700">{r.employeeName}</span>
                <span className="text-xs font-medium text-slate-900 text-right">{r.hoursWorked.toFixed(2)} hrs</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {missingHoursCount > 0 && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700">
          {missingHoursCount} appointment{missingHoursCount !== 1 ? "s" : ""} missing worked hours
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-3 pt-2 border-t border-slate-200 grid grid-cols-[1fr_auto] gap-x-3">
          <span className="text-xs font-semibold text-slate-900">Total Worked Hours</span>
          <span className="text-xs font-semibold text-slate-900 text-right">{totalHours.toFixed(2)}</span>
        </div>
      )}
    </div>
  );
}
