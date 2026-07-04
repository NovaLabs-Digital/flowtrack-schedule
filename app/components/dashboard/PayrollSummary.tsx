"use client";

import { useState } from "react";
import { Appointment, Employee, EmployeeHours } from "@/app/components/dashboard/types";

function toDateInputValue(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function mondayOfCurrentWeek(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const diff = (dow + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
  return d;
}

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// One employee's payroll totals for the selected range. Kept as its own shape
// so future columns (hourly rate, overtime, PTO, vacation, gross pay...) can be
// added here without changing how rows are computed or laid out.
type PayrollRow = {
  employeeId: string;
  employeeName: string;
  hoursWorked: number;
};

// Scheduled duration in hours, mirroring DispatchPanel's scheduledMinutes but
// as a decimal-hours value for payroll math.
function scheduledHours(appt: Appointment): number {
  if (appt.scheduled_end) {
    const mins = Math.round((new Date(appt.scheduled_end).getTime() - new Date(appt.scheduled_for).getTime()) / 60_000);
    if (mins > 0) return mins / 60;
  }
  return (appt.duration_minutes ?? 0) / 60;
}

export default function PayrollSummary({
  appointments,
  employees,
  employeeHours,
}: {
  appointments: Appointment[];
  employees: Employee[];
  employeeHours: EmployeeHours[];
}) {
  const defaultMonday = mondayOfCurrentWeek();
  const [rangeStart, setRangeStart] = useState(toDateInputValue(defaultMonday));
  const [rangeEnd, setRangeEnd] = useState(toDateInputValue(addDays(defaultMonday, 4)));

  const employeeById: Record<string, Employee> = {};
  for (const e of employees) employeeById[e.id] = e;

  // Manually-saved hours are overrides, keyed by appointment+employee — not the
  // source of totals. An appointment with no saved entry still counts, using
  // its scheduled duration.
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

    const key = `${appt.id}|${appt.employee_id}`;
    const hours = savedHoursByKey.has(key) ? savedHoursByKey.get(key)! : scheduledHours(appt);

    totals.set(appt.employee_id, (totals.get(appt.employee_id) ?? 0) + hours);
  }

  const rows: PayrollRow[] = Array.from(totals.entries())
    .map(([employeeId, hoursWorked]) => ({
      employeeId,
      employeeName: employeeById[employeeId]?.name ?? "Unknown",
      hoursWorked,
    }))
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));

  const totalHours = rows.reduce((sum, r) => sum + r.hoursWorked, 0);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4 shrink-0">
      <div className="text-sm font-semibold text-slate-900">Payroll Summary</div>

      <div className="mt-3 flex items-center gap-2 text-xs">
        <span className="text-slate-500 shrink-0">Week</span>
        <input
          type="date"
          value={rangeStart}
          onChange={(e) => setRangeStart(e.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <span className="text-slate-400">&#8594;</span>
        <input
          type="date"
          value={rangeEnd}
          onChange={(e) => setRangeEnd(e.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="mt-3">
        {rows.length === 0 ? (
          <div className="text-xs text-slate-400">No assigned appointments in this range.</div>
        ) : (
          <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5">
            {rows.map((r) => (
              <div key={r.employeeId} className="contents">
                <span className="text-xs text-slate-700">{r.employeeName}</span>
                <span className="text-xs font-medium text-slate-900 text-right">{r.hoursWorked.toFixed(2)} hrs</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <div className="mt-3 pt-2 border-t border-slate-200 grid grid-cols-[1fr_auto] gap-x-3">
          <span className="text-xs font-semibold text-slate-900">Total Hours</span>
          <span className="text-xs font-semibold text-slate-900 text-right">{totalHours.toFixed(2)}</span>
        </div>
      )}
    </div>
  );
}
