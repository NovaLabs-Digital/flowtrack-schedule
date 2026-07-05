"use client";

import { Appointment, Client, Employee } from "@/app/components/dashboard/types";
import { toBusinessLocal, nowInBusinessTz } from "@/lib/timezone";
import MobileAppointmentCard from "@/app/components/mobile/MobileAppointmentCard";

// Bounds how far ahead the agenda looks — keeps the list short and scrolling
// light rather than rendering every future recurring appointment.
const WINDOW_DAYS = 21;

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayLabel(d: Date, today: Date) {
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, addDays(today, 1))) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

type Props = {
  appointments: Appointment[];
  clientById: Record<string, Client>;
  employeeById: Record<string, Employee>;
  serviceColorByName: Record<string, string>;
  getDurationMinutes: (appt: Appointment) => number;
  onSelectAppointment: (id: string) => void;
};

// Schedule tab (Screen 4) — Agenda List View, per the approved mockup's
// "Alternate Mobile Views" option A. Deliberately not the desktop time-grid
// layout: a continuous, multi-day scrollable list grouped under day headers.
// Reuses MobileAppointmentCard and the client/employee/service lookups +
// duration logic already built for the Today screen (passed down from
// MobileDashboard) — no duplicated logic, no new data fetching.
export default function MobileSchedule({
  appointments,
  clientById,
  employeeById,
  serviceColorByName,
  getDurationMinutes,
  onSelectAppointment,
}: Props) {
  const today = nowInBusinessTz();
  today.setHours(0, 0, 0, 0);
  const windowEnd = addDays(today, WINDOW_DAYS);

  const upcoming = appointments
    .filter((a) => {
      if (a.status === "cancelled") return false;
      const local = toBusinessLocal(a.scheduled_for);
      return local >= today && local < windowEnd;
    })
    .sort((a, b) => new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime());

  // Group consecutive appointments by business-tz day (the list is already
  // sorted, so each new day starts a new group).
  const groups: { date: Date; appts: Appointment[] }[] = [];
  for (const a of upcoming) {
    const day = toBusinessLocal(a.scheduled_for);
    day.setHours(0, 0, 0, 0);
    const last = groups[groups.length - 1];
    if (last && sameDay(last.date, day)) {
      last.appts.push(a);
    } else {
      groups.push({ date: day, appts: [a] });
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <div className="shrink-0 bg-white border-b border-slate-200 px-4 py-3">
        <div className="text-base font-semibold text-slate-900">Schedule</div>
        <div className="text-xs text-slate-500">Next {WINDOW_DAYS} days</div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-4">
        {groups.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-3xl text-slate-300 mb-3">🗓️</div>
            <div className="text-sm text-slate-500">No upcoming appointments</div>
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.date.toISOString()}>
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
                {dayLabel(g.date, today)}
              </div>
              <div className="space-y-2">
                {g.appts.map((a) => (
                  <MobileAppointmentCard
                    key={a.id}
                    appointment={a}
                    client={clientById[a.client_id] ?? null}
                    employee={a.employee_id ? employeeById[a.employee_id] ?? null : null}
                    serviceColor={serviceColorByName[a.service_type] ?? null}
                    durationMinutes={getDurationMinutes(a)}
                    onTap={() => onSelectAppointment(a.id)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
