"use client";

import { useState } from "react";
import { Appointment, Employee, EmployeeHours } from "@/app/components/dashboard/types";
import { computePayrollRows, toDateInputValue } from "@/lib/payroll";
import { nowInBusinessTz } from "@/lib/timezone";

function mondayOfCurrentWeek(): Date {
  const d = nowInBusinessTz();
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

  const { rows, missingHoursCount } = computePayrollRows({ appointments, employees, employeeHours, rangeStart, rangeEnd });
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
          <span className="text-xs font-semibold text-slate-900">Total Hours</span>
          <span className="text-xs font-semibold text-slate-900 text-right">{totalHours.toFixed(2)}</span>
        </div>
      )}
    </div>
  );
}
