"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Appointment = {
  id: string;
  client_id: string;
  service_type: string;
  scheduled_for: string;
  scheduled_end?: string | null;
  status: string;
  notes: string | null;
  duration_minutes?: number | null;
};

type ClientInfo = { name: string; address: string | null; phone: string | null };

type Props = {
  employee: { id: string; name: string; color: string };
  appointments: Appointment[];
  clients: Record<string, ClientInfo>;
  serviceColors: Record<string, string>;
};

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatDayHeader(d: Date) {
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function formatTime(d: Date) {
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12}:00 ${ampm}` : `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function durationLabel(mins: number) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function mapsUrl(address: string) {
  return `https://maps.apple.com/?q=${encodeURIComponent(address)}`;
}

export default function EmployeeSchedule({ employee, appointments, clients, serviceColors }: Props) {
  const router = useRouter();
  const [dayOffset, setDayOffset] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const currentDay = addDays(today, dayOffset);

  const dayAppts = appointments.filter((a) => {
    const d = new Date(a.scheduled_for);
    return sameDay(d, currentDay);
  });

  async function handleLogout() {
    setLoggingOut(true);
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
    router.push("/login");
  }

  return (
    <div className="min-h-[100dvh] bg-slate-50 flex flex-col">
      {/* Top bar */}
      <div className="shrink-0 bg-white border-b border-slate-200 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-white text-xs font-bold" style={{ backgroundColor: employee.color }}>
              {employee.name.charAt(0).toUpperCase()}
            </div>
            <div className="text-sm font-semibold text-slate-900 truncate">{employee.name}</div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => setDayOffset((d) => d - 1)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm font-medium text-slate-700 active:bg-slate-100"
            >
              ←
            </button>
            <button
              onClick={() => setDayOffset(0)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 active:bg-slate-100"
            >
              Today
            </button>
            <button
              onClick={() => setDayOffset((d) => d + 1)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm font-medium text-slate-700 active:bg-slate-100"
            >
              →
            </button>
          </div>
          <button
            onClick={handleLogout}
            disabled={loggingOut}
            className="text-xs text-slate-500 hover:text-rose-600 transition-colors shrink-0"
          >
            {loggingOut ? "..." : "Sign Out"}
          </button>
        </div>
      </div>

      {/* Day header */}
      <div className="px-4 py-3 bg-slate-100 border-b border-slate-200">
        <div className="text-sm font-semibold text-slate-900">{formatDayHeader(currentDay)}</div>
        {sameDay(currentDay, today) && (
          <div className="text-xs text-blue-600 font-medium">Today</div>
        )}
      </div>

      {/* Appointment list */}
      <div className="flex-1 overflow-auto px-4 py-4 space-y-3">
        {dayAppts.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-3xl text-slate-200 mb-3">📅</div>
            <div className="text-sm text-slate-500">No appointments {sameDay(currentDay, today) ? "today" : "on this day"}</div>
            <div className="text-xs text-slate-400 mt-1">Use the arrows to check other days</div>
          </div>
        ) : (
          dayAppts.map((a) => {
            const start = new Date(a.scheduled_for);
            let mins: number;
            if (a.scheduled_end) {
              mins = Math.round((new Date(a.scheduled_end).getTime() - start.getTime()) / 60_000);
              if (mins <= 0) mins = a.duration_minutes ?? 60;
            } else {
              mins = a.duration_minutes ?? 60;
            }
            const end = new Date(start.getTime() + mins * 60_000);
            const client = clients[a.client_id];
            const svcColor = serviceColors[a.service_type] ?? null;

            return (
              <div
                key={a.id}
                className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden"
              >
                {/* Color strip at top */}
                <div className="h-1" style={{ backgroundColor: svcColor ?? employee.color }} />

                <div className="p-4 space-y-2">
                  {/* Service + time */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {svcColor && <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: svcColor }} />}
                      <span className="font-semibold text-sm text-slate-900">{a.service_type}</span>
                    </div>
                    <div className="text-xs text-slate-500 shrink-0">{durationLabel(mins)}</div>
                  </div>

                  {/* Time range */}
                  <div className="text-sm text-slate-700">
                    {formatTime(start)} – {formatTime(end)}
                  </div>

                  {/* Client info */}
                  {client && (
                    <div className="space-y-1 pt-1 border-t border-slate-100">
                      <div className="text-sm font-medium text-slate-800">{client.name}</div>
                      {client.address && (
                        <div className="text-xs text-slate-500">{client.address}</div>
                      )}
                      {client.phone && (
                        <a href={`tel:${client.phone}`} className="text-xs text-blue-600 hover:text-blue-700">
                          {client.phone}
                        </a>
                      )}
                    </div>
                  )}

                  {/* Notes */}
                  {a.notes && (
                    <div className="text-xs text-slate-500 italic pt-1 border-t border-slate-100">
                      {a.notes}
                    </div>
                  )}

                  {/* Action buttons */}
                  {(client?.address || client?.phone) && (
                    <div className="flex gap-2 pt-2">
                      {client.address && (
                        <a
                          href={mapsUrl(client.address)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white active:bg-slate-700 transition-colors"
                        >
                          <span className="text-base leading-none">📍</span>
                          Navigate
                        </a>
                      )}
                      {client.phone && (
                        <a
                          href={`tel:${client.phone}`}
                          className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 active:bg-slate-100 transition-colors"
                        >
                          <span className="text-base leading-none">📞</span>
                          Call
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 text-xs text-slate-500 safe-area-bottom">
        {dayAppts.length} appointment{dayAppts.length !== 1 ? "s" : ""} {sameDay(currentDay, today) ? "today" : ""}
      </div>
    </div>
  );
}
