"use client";

import { useState } from "react";
import { Client, Appointment, Service, Employee } from "@/app/components/dashboard/types";
import { nowInBusinessTz, toBusinessLocal } from "@/lib/timezone";
import MobileAppointmentCard from "@/app/components/mobile/MobileAppointmentCard";
import MobileAppointmentDetail from "@/app/components/mobile/MobileAppointmentDetail";
import MobileBottomNav, { MobileTabKey } from "@/app/components/mobile/MobileBottomNav";
import MobileSchedule from "@/app/components/mobile/MobileSchedule";

type Props = {
  clients: Client[];
  appointments: Appointment[];
  services: Service[];
  employees: Employee[];
  onAdd: () => void;
  onEditAppointment: (apptId: string) => void;
  onClientUpdated: () => void;
};

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function scheduledMinutes(appt: Appointment, services: Service[]): number {
  if (appt.scheduled_end) {
    const mins = Math.round((new Date(appt.scheduled_end).getTime() - new Date(appt.scheduled_for).getTime()) / 60_000);
    if (mins > 0) return mins;
  }
  if (appt.duration_minutes) return appt.duration_minutes;
  const svc = services.find((s) => s.name === appt.service_type);
  return svc?.duration_minutes ?? 60;
}

// Mobile Admin v1 — Today screen (Screen 1), Appointment Detail (Screen 2),
// and persistent bottom navigation (Screen 4) from the approved mockup.
// Client Quick Look drawer and the Schedule/Clients/Settings tab content land
// in following milestones.
export default function MobileDashboard({
  clients,
  appointments,
  services,
  employees,
  onAdd,
  onEditAppointment,
  onClientUpdated,
}: Props) {
  const [activeTab, setActiveTab] = useState<MobileTabKey>("today");
  const [dayOffset, setDayOffset] = useState(0);
  const [selectedApptId, setSelectedApptId] = useState<string | null>(null);

  const today = nowInBusinessTz();
  const selectedDate = addDays(today, dayOffset);
  const isToday = sameDay(selectedDate, today);

  const clientById: Record<string, Client> = {};
  for (const c of clients) clientById[c.id] = c;
  const employeeById: Record<string, Employee> = {};
  for (const e of employees) employeeById[e.id] = e;
  const serviceColorByName: Record<string, string> = {};
  for (const s of services) if (s.color) serviceColorByName[s.name] = s.color;

  const dayAppts = appointments
    .filter((a) => a.status !== "cancelled" && sameDay(toBusinessLocal(a.scheduled_for), selectedDate))
    .sort((a, b) => new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime());

  const strip = [-2, -1, 0, 1, 2].map((i) => addDays(selectedDate, i));

  const selectedAppt = selectedApptId ? appointments.find((a) => a.id === selectedApptId) ?? null : null;

  return (
    <div className="h-[100dvh] flex flex-col bg-slate-100 text-slate-900 overflow-hidden safe-area-top">
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {selectedAppt ? (
          <MobileAppointmentDetail
            appointment={selectedAppt}
            client={clientById[selectedAppt.client_id] ?? null}
            employee={selectedAppt.employee_id ? employeeById[selectedAppt.employee_id] ?? null : null}
            durationMinutes={scheduledMinutes(selectedAppt, services)}
            onBack={() => setSelectedApptId(null)}
            onEdit={() => onEditAppointment(selectedAppt.id)}
            onCancelled={() => {
              setSelectedApptId(null);
              onClientUpdated();
            }}
          />
        ) : (
          <>
            {activeTab === "today" && (
              <>
                {/* Top bar */}
                <div className="shrink-0 bg-white border-b border-slate-200 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center bg-blue-600 text-white text-xs font-bold">
                        FTS
                      </div>
                      <div className="min-w-0">
                        <div className="text-base font-semibold text-slate-900 truncate">
                          {isToday ? "Today" : selectedDate.toLocaleDateString(undefined, { weekday: "long" })}
                        </div>
                        <div className="text-xs text-slate-500 truncate">
                          {selectedDate.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 text-slate-400">
                      <button type="button" className="w-8 h-8 flex items-center justify-center" title="Search (coming soon)">
                        🔍
                      </button>
                      <button type="button" className="w-8 h-8 flex items-center justify-center" title="Notifications (coming soon)">
                        🔔
                      </button>
                    </div>
                  </div>
                </div>

                {/* Day strip */}
                <div className="shrink-0 bg-white border-b border-slate-200 px-2 py-2 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setDayOffset((o) => o - 1)}
                    className="w-8 h-8 shrink-0 flex items-center justify-center text-slate-400 active:bg-slate-100 rounded-lg"
                    aria-label="Previous day"
                  >
                    ‹
                  </button>
                  <div className="flex-1 grid grid-cols-5 gap-1">
                    {strip.map((d, i) => {
                      const selected = sameDay(d, selectedDate);
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setDayOffset(dayOffset + (i - 2))}
                          className="flex flex-col items-center gap-0.5 py-1 rounded-lg"
                        >
                          <span className="text-[10px] font-medium text-slate-400 uppercase">
                            {d.toLocaleDateString(undefined, { weekday: "short" })}
                          </span>
                          <span
                            className={[
                              "w-7 h-7 flex items-center justify-center rounded-full text-sm font-medium",
                              selected ? "bg-slate-900 text-white" : "text-slate-700",
                            ].join(" ")}
                          >
                            {d.getDate()}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={() => setDayOffset((o) => o + 1)}
                    className="w-8 h-8 shrink-0 flex items-center justify-center text-slate-400 active:bg-slate-100 rounded-lg"
                    aria-label="Next day"
                  >
                    ›
                  </button>
                </div>

                {/* Count header */}
                <div className="shrink-0 px-4 py-2.5 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {selectedDate.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
                  </span>
                  <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-white border border-slate-200 text-slate-600">
                    {dayAppts.length} appointment{dayAppts.length !== 1 ? "s" : ""}
                  </span>
                </div>

                {/* Appointment list */}
                <div className="flex-1 min-h-0 overflow-auto px-4 pb-4 space-y-2">
                  {dayAppts.length === 0 ? (
                    <div className="text-center py-16">
                      <div className="text-3xl text-slate-300 mb-3">📅</div>
                      <div className="text-sm text-slate-500">No appointments {isToday ? "today" : "on this day"}</div>
                    </div>
                  ) : (
                    dayAppts.map((a) => (
                      <MobileAppointmentCard
                        key={a.id}
                        appointment={a}
                        client={clientById[a.client_id] ?? null}
                        employee={a.employee_id ? employeeById[a.employee_id] ?? null : null}
                        serviceColor={serviceColorByName[a.service_type] ?? null}
                        durationMinutes={scheduledMinutes(a, services)}
                        onTap={() => setSelectedApptId(a.id)}
                      />
                    ))
                  )}
                </div>

                {/* Add Appointment */}
                <div className="shrink-0 px-4 pb-3 pt-1">
                  <button
                    type="button"
                    onClick={onAdd}
                    className="w-full rounded-xl bg-slate-900 px-4 py-3.5 text-sm font-semibold text-white active:bg-slate-800 transition-colors"
                  >
                    + Add Appointment
                  </button>
                </div>
              </>
            )}

            {activeTab === "schedule" && <MobileSchedule />}

            {activeTab === "clients" && (
              <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-slate-400 px-6 text-center">
                Clients — coming in a later milestone.
              </div>
            )}

            {activeTab === "settings" && (
              <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-slate-400 px-6 text-center">
                Settings — coming in a later milestone.
              </div>
            )}
          </>
        )}
      </div>

      <MobileBottomNav active={activeTab} onChange={setActiveTab} />
    </div>
  );
}
