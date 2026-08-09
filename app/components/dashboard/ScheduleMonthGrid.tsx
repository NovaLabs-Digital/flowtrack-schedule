"use client";

import { Appointment, Client, Employee, AppointmentEmployeeAssignment } from "@/app/components/dashboard/types";
import { nowInBusinessTz, toBusinessLocal } from "@/lib/timezone";
import { resolveTeamAccentColor } from "@/lib/teamColor";
import {
  buildMonthGrid,
  shiftMonth,
  dateKey,
  formatMonthYear,
  formatChipTime,
  groupAppointmentsByDate,
  MAX_VISIBLE_CHIPS_PER_DAY,
} from "@/lib/monthGrid";

const WEEKDAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function ScheduleMonthGrid({
  appointments,
  clients,
  employees,
  assignments,
  selectedClientId,
  selectedAppointmentId,
  onSelectAppointment,
  onEditAppointment,
  monthOffset,
}: {
  appointments: Appointment[];
  clients: Client[];
  employees: Employee[];
  // Phase 3: same authoritative per-appointment assignment rows every other
  // schedule view already reads, used only to resolve each chip's subtle
  // team/employee accent color via the existing shared rule
  // (lib/teamColor.ts) -- no new assignment logic.
  assignments: AppointmentEmployeeAssignment[];
  selectedClientId: string | null;
  selectedAppointmentId: string | null;
  onSelectAppointment: (id: string) => void;
  onEditAppointment?: (id: string) => void;
  // Months relative to the current business-local calendar month (0 =
  // current month) -- deliberately separate from ScheduleGrid's weekOffset;
  // see DashboardShell for how Today/Prev/Next branch by viewMode.
  monthOffset: number;
}) {
  const now = nowInBusinessTz();
  const anchor = shiftMonth(now.getFullYear(), now.getMonth(), monthOffset);
  const weeks = buildMonthGrid(anchor.year, anchor.month);
  const todayKey = dateKey(now);

  const apptsByDate = groupAppointmentsByDate(appointments, toBusinessLocal);

  const employeeMap: Record<string, Employee> = {};
  for (const e of employees) employeeMap[e.id] = e;

  const assignmentsByApptId = new Map<string, AppointmentEmployeeAssignment[]>();
  for (const a of assignments) {
    const list = assignmentsByApptId.get(a.appointment_id);
    if (list) list.push(a);
    else assignmentsByApptId.set(a.appointment_id, [a]);
  }
  function accentColorFor(appt: Appointment): string | null {
    return resolveTeamAccentColor(assignmentsByApptId.get(appt.id) ?? [], employeeMap, appt.team_color);
  }

  function clientName(id: string) {
    return clients.find((c) => c.id === id)?.name ?? "Client";
  }

  // Count of every appointment actually rendered in the visible grid
  // (including adjacent-month days), matching ScheduleGrid's own "X
  // appointments in view" footer semantics exactly.
  const totalInView = weeks.flat().reduce((sum, day) => sum + (apptsByDate.get(dateKey(day.date))?.length ?? 0), 0);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm h-full flex flex-col">
      {/* Header -- same typography as ScheduleGrid's header, month/year in place of a week range */}
      <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
        <div>
          <div className="text-sm font-semibold text-slate-900">Schedule</div>
          <div className="text-xs text-slate-500">{formatMonthYear(anchor.year, anchor.month)}</div>
        </div>
        <div className="text-xs text-slate-500">
          {selectedClientId ? (
            <span className="font-medium text-slate-700">{clientName(selectedClientId)}</span>
          ) : (
            "No client selected"
          )}
        </div>
      </div>

      {/* Month grid */}
      <div className="flex-1 overflow-auto min-h-0">
        <div className="min-w-[700px] h-full flex flex-col">
          {/* Weekday header row */}
          <div className="grid sticky top-0 z-10 bg-slate-50" style={{ gridTemplateColumns: "repeat(7, minmax(0, 1fr))" }}>
            {WEEKDAY_HEADERS.map((label) => (
              <div key={label} className="border-b px-2 py-2 text-xs font-medium text-center text-slate-600">
                {label}
              </div>
            ))}
          </div>

          {/* Week rows */}
          <div className="flex-1 grid" style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
            {weeks.map((week, weekIdx) => (
              <div
                key={weekIdx}
                className="grid border-b last:border-b-0"
                style={{ gridTemplateColumns: "repeat(7, minmax(0, 1fr))" }}
              >
                {week.map((day) => {
                  const key = dateKey(day.date);
                  const dayAppts = apptsByDate.get(key) ?? [];
                  const visible = dayAppts.slice(0, MAX_VISIBLE_CHIPS_PER_DAY);
                  const hiddenCount = dayAppts.length - visible.length;
                  const isToday = key === todayKey;

                  return (
                    <div
                      key={key}
                      className={[
                        "border-r last:border-r-0 px-1.5 py-1.5 min-h-[92px] flex flex-col gap-1",
                        day.inCurrentMonth ? "bg-white" : "bg-slate-50",
                      ].join(" ")}
                    >
                      <div className="flex items-center justify-start">
                        <span
                          className={[
                            "inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-medium",
                            isToday
                              ? "bg-slate-900 text-white"
                              : day.inCurrentMonth
                                ? "text-slate-700"
                                : "text-slate-400",
                          ].join(" ")}
                        >
                          {day.date.getDate()}
                        </span>
                      </div>

                      <div className="flex flex-col gap-0.5 min-w-0">
                        {visible.map((appt) => {
                          const selected = appt.id === selectedAppointmentId;
                          const accent = accentColorFor(appt);
                          return (
                            <button
                              key={appt.id}
                              onClick={(e) => { e.stopPropagation(); onSelectAppointment(appt.id); }}
                              onDoubleClick={(e) => { e.stopPropagation(); onEditAppointment?.(appt.id); }}
                              title={`${formatChipTime(toBusinessLocal(appt.scheduled_for))} ${clientName(appt.client_id)} – ${appt.service_type}`}
                              className={[
                                "w-full text-left rounded px-1 py-0.5 text-[10px] leading-tight truncate border",
                                selected
                                  ? "ring-1 ring-blue-600 bg-blue-100/60 border-blue-200"
                                  : "bg-slate-50 border-slate-200 hover:bg-slate-100",
                              ].join(" ")}
                              style={accent ? { borderLeftWidth: 3, borderLeftColor: accent } : undefined}
                            >
                              <span className="font-medium text-slate-700">{formatChipTime(toBusinessLocal(appt.scheduled_for))}</span>
                              {" "}
                              <span className="text-slate-600">{clientName(appt.client_id)}</span>
                              <span className="text-slate-400"> – </span>
                              <span className="text-slate-500">{appt.service_type}</span>
                            </button>
                          );
                        })}
                        {hiddenCount > 0 && (
                          <div className="text-[10px] text-slate-400 px-1">+{hiddenCount} more</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="border-t px-4 py-2 text-xs text-slate-500 shrink-0">
        {totalInView} appointment{totalInView !== 1 ? "s" : ""} in view
      </div>
    </div>
  );
}
