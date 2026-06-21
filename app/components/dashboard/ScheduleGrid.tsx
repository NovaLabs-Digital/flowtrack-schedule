"use client";

import { Client, Appointment, Service, ViewMode } from "@/app/components/dashboard/types";

function formatDay(d: Date) {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function formatWeekRange(days: Date[]) {
  if (days.length === 0) return "";
  const first = days[0];
  const last = days[days.length - 1];
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (first.getFullYear() !== new Date().getFullYear()) {
    (opts as any).year = "numeric";
  }
  return `${first.toLocaleDateString(undefined, opts)} — ${last.toLocaleDateString(undefined, opts)}`;
}

function startOfWeek(d: Date) {
  const x = new Date(d);
  const day = x.getDay();
  const diff = (day + 6) % 7;
  x.setDate(x.getDate() - diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function viewDays(viewMode: ViewMode, weekOffset: number) {
  const base = addDays(startOfWeek(new Date()), weekOffset * 7);
  if (viewMode === "day") return [addDays(new Date(), weekOffset * 7)];
  if (viewMode === "weekdays") return [0, 1, 2, 3, 4].map((i) => addDays(base, i));
  return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(base, i));
}

function statusPill(status: Appointment["status"]) {
  switch (status) {
    case "cancelled":
      return "border-rose-200 bg-rose-50 text-rose-900";
    default:
      return "border-blue-200 bg-blue-50 text-slate-900";
  }
}

function statusLabel(status: Appointment["status"]) {
  switch (status) {
    case "scheduled":
      return "Scheduled";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

function formatTime(d: Date) {
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function timeRange(iso: string, mins: number) {
  const start = new Date(iso);
  const end = new Date(start.getTime() + mins * 60_000);
  return `${formatTime(start)} – ${formatTime(end)}`;
}

function durationLabel(mins: number) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

const CELL_PX = 56;

export default function ScheduleGrid({
  viewMode,
  clients,
  appointments,
  services,
  selectedClientId,
  selectedAppointmentId,
  onSelectAppointment,
  onCellClick,
  weekOffset,
}: {
  viewMode: ViewMode;
  clients: Client[];
  appointments: Appointment[];
  services: Service[];
  selectedClientId: string | null;
  selectedAppointmentId: string | null;
  onSelectAppointment: (id: string) => void;
  onCellClick: (date: Date, hour: number) => void;
  weekOffset: number;
}) {
  const serviceDurations: Record<string, number> = {};
  for (const s of services) serviceDurations[s.name] = s.duration_minutes;
  function durationFor(serviceType: string) {
    return serviceDurations[serviceType] ?? 60;
  }
  const days = viewDays(viewMode, weekOffset);

  const startHour = 7;
  const endHour = 18;
  const totalHours = endHour - startHour + 1;
  const hours = Array.from({ length: totalHours }, (_, i) => startHour + i);

  const apptsInView = appointments.filter((a) => {
    const apptDate = new Date(a.scheduled_for);
    return days.some((d) => d.toDateString() === apptDate.toDateString());
  });

  function clientName(id: string) {
    return clients.find((c) => c.id === id)?.name ?? "Client";
  }

  function apptsForDay(d: Date) {
    return apptsInView.filter(
      (a) => new Date(a.scheduled_for).toDateString() === d.toDateString()
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
        <div>
          <div className="text-sm font-semibold text-slate-900">Schedule</div>
          <div className="text-xs text-slate-500">{formatWeekRange(days)}</div>
        </div>
        <div className="text-xs text-slate-500">
          {selectedClientId ? (
            <span className="font-medium text-slate-700">{clientName(selectedClientId)}</span>
          ) : (
            "No client selected"
          )}
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto min-h-0">
        <div className="min-w-[700px]">
          {/* Day header row */}
          <div
            className="grid sticky top-0 z-10 bg-slate-50"
            style={{ gridTemplateColumns: `80px repeat(${days.length}, minmax(120px, 1fr))` }}
          >
            <div className="border-b border-r px-3 py-2 text-xs font-medium text-slate-500">Time</div>
            {days.map((d) => {
              const isToday = d.toDateString() === new Date().toDateString();
              return (
                <div
                  key={d.toISOString()}
                  className={[
                    "border-b px-3 py-2 text-xs font-medium text-center",
                    isToday ? "bg-slate-900 text-white" : "text-slate-600",
                  ].join(" ")}
                >
                  {formatDay(d)}
                </div>
              );
            })}
          </div>

          {/* Time body: fixed-height rows + absolutely positioned cards */}
          <div
            className="grid"
            style={{ gridTemplateColumns: `80px repeat(${days.length}, minmax(120px, 1fr))` }}
          >
            {/* Time labels column */}
            <div>
              {hours.map((h) => (
                <div
                  key={h}
                  className="border-b border-r px-3 text-xs text-slate-500 flex items-start pt-2"
                  style={{ height: CELL_PX }}
                >
                  {h}:00
                </div>
              ))}
            </div>

            {/* Day columns — each is a relative container for positioned cards */}
            {days.map((d, dayIdx) => (
              <div key={d.toISOString()} className="relative" style={{ height: totalHours * CELL_PX }}>
                {/* Empty cell click targets */}
                {hours.map((h, rowIdx) => (
                  <div
                    key={h}
                    className="absolute border-b border-l cursor-pointer hover:bg-blue-50/40 transition-colors"
                    style={{
                      top: rowIdx * CELL_PX,
                      left: 0,
                      right: 0,
                      height: CELL_PX,
                    }}
                    onClick={() => {
                      console.log("[CELL_CLICK]", formatDay(d), `${h}:00`);
                      onCellClick(d, h);
                    }}
                  />
                ))}

                {/* Appointment cards positioned by time and spanning by duration */}
                {apptsForDay(d).map((a) => {
                  const apptDate = new Date(a.scheduled_for);
                  const apptHour = apptDate.getHours();
                  const apptMin = apptDate.getMinutes();
                  const mins = a.duration_minutes ?? durationFor(a.service_type);

                  const topOffset = (apptHour - startHour) * CELL_PX + (apptMin / 60) * CELL_PX;
                  const height = (mins / 60) * CELL_PX;

                  if (apptHour < startHour || apptHour > endHour) return null;

                  const selected = a.id === selectedAppointmentId;
                  const sameClient = selectedClientId && a.client_id === selectedClientId;
                  const isShort = mins <= 60;

                  return (
                    <button
                      key={a.id}
                      onClick={(e) => { e.stopPropagation(); onSelectAppointment(a.id); }}
                      className={[
                        "absolute left-1 right-1 rounded-lg border text-left shadow-sm overflow-hidden px-2 z-[5]",
                        statusPill(a.status),
                        selected ? "ring-2 ring-blue-600 z-[6]" : "",
                        sameClient ? "outline outline-2 outline-blue-600/30" : "",
                      ].join(" ")}
                      style={{
                        top: topOffset + 2,
                        height: Math.max(height - 4, 24),
                      }}
                    >
                      {isShort ? (
                        /* Compact: single row for short appointments */
                        <div className="flex items-center justify-between gap-1 h-full">
                          <div className="truncate font-medium text-xs">{a.service_type}</div>
                          <div className="text-[10px] text-slate-500 shrink-0">{timeRange(a.scheduled_for, mins)}</div>
                        </div>
                      ) : (
                        /* Full: multi-line for longer appointments */
                        <div className="py-1 flex flex-col h-full">
                          <div className="flex items-center justify-between gap-1">
                            <div className="truncate font-medium text-xs">{a.service_type}</div>
                            <div className="text-[10px] shrink-0">{statusLabel(a.status)}</div>
                          </div>
                          <div className="text-[11px] text-slate-600 mt-0.5">{clientName(a.client_id)}</div>
                          <div className="mt-auto text-[10px] text-slate-500">
                            {timeRange(a.scheduled_for, mins)} ({durationLabel(mins)})
                          </div>
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="border-t px-4 py-2 text-xs text-slate-500 shrink-0">
        {apptsInView.length} appointment{apptsInView.length !== 1 ? "s" : ""} in view
      </div>
    </div>
  );
}
