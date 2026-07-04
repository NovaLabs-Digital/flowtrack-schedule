"use client";

import { useState } from "react";
import { Client, Appointment, Service, Employee, ViewMode } from "@/app/components/dashboard/types";

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

function freqLabel(a: Appointment): string {
  if (!a.frequency_type || a.frequency_type === "one_time") return "";
  if (a.frequency_type === "daily") return "Daily";
  if (a.frequency_type === "weekly") {
    const w = a.repeat_weeks ?? 1;
    if (w === 1) return "Weekly";
    return `Every ${w} wks`;
  }
  return "";
}

const CELL_PX = 56;

type LayoutInfo = { column: number; totalColumns: number };

function computeOverlapLayout(appts: Appointment[], startHour: number, durationFor: (s: string) => number): Map<string, LayoutInfo> {
  const layout = new Map<string, LayoutInfo>();
  if (appts.length === 0) return layout;

  const items = appts.map((a) => {
    const d = new Date(a.scheduled_for);
    const startMin = d.getHours() * 60 + d.getMinutes();
    let dur: number;
    if (a.scheduled_end) {
      dur = Math.round((new Date(a.scheduled_end).getTime() - d.getTime()) / 60_000);
      if (dur <= 0) dur = durationFor(a.service_type);
    } else {
      dur = a.duration_minutes ?? durationFor(a.service_type);
    }
    return { id: a.id, start: startMin, end: startMin + dur };
  });

  items.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

  const columns: { id: string; end: number }[][] = [];

  for (const item of items) {
    let placed = false;
    for (let c = 0; c < columns.length; c++) {
      const col = columns[c];
      if (col[col.length - 1].end <= item.start) {
        col.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) {
      columns.push([item]);
    }
  }

  const totalColumns = columns.length;
  for (let c = 0; c < columns.length; c++) {
    for (const item of columns[c]) {
      layout.set(item.id, { column: c, totalColumns });
    }
  }

  return layout;
}

export default function ScheduleGrid({
  viewMode,
  clients,
  appointments,
  services,
  employees,
  selectedClientId,
  selectedAppointmentId,
  onSelectAppointment,
  onEditAppointment,
  onCellClick,
  onDropAppointment,
  weekOffset,
}: {
  viewMode: ViewMode;
  clients: Client[];
  appointments: Appointment[];
  services: Service[];
  employees: Employee[];
  selectedClientId: string | null;
  selectedAppointmentId: string | null;
  onSelectAppointment: (id: string) => void;
  onEditAppointment?: (id: string) => void;
  onCellClick: (date: Date, hour: number) => void;
  onDropAppointment?: (appointmentId: string, scheduledFor: string, scheduledEnd: string | null) => void;
  weekOffset: number;
}) {
  const dragEnabled = !!onDropAppointment;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverCell, setDragOverCell] = useState<string | null>(null);
  const serviceDurations: Record<string, number> = {};
  const serviceColors: Record<string, string> = {};
  for (const s of services) {
    serviceDurations[s.name] = s.duration_minutes;
    if (s.color) serviceColors[s.name] = s.color;
  }
  function durationFor(serviceType: string) {
    return serviceDurations[serviceType] ?? 60;
  }
  const days = viewDays(viewMode, weekOffset);

  const startHour = 7;
  const endHour = 18;
  const totalHours = endHour - startHour + 1;
  const hours = Array.from({ length: totalHours }, (_, i) => startHour + i);

  const apptsInView = appointments.filter((a) => {
    if (a.status === "cancelled") return false;
    const apptDate = new Date(a.scheduled_for);
    return days.some((d) => d.toDateString() === apptDate.toDateString());
  });

  const employeeMap: Record<string, Employee> = {};
  for (const e of employees) employeeMap[e.id] = e;

  function clientName(id: string) {
    return clients.find((c) => c.id === id)?.name ?? "Client";
  }

  function employeeName(id?: string | null) {
    if (!id) return null;
    return employeeMap[id]?.name ?? null;
  }

  function employeeColor(id?: string | null) {
    if (!id) return null;
    return employeeMap[id]?.color ?? null;
  }

  function apptsForDay(d: Date) {
    return apptsInView.filter(
      (a) => new Date(a.scheduled_for).toDateString() === d.toDateString()
    );
  }

  function handleDrop(day: Date, hour: number) {
    setDragOverCell(null);
    const id = draggingId;
    setDraggingId(null);
    if (!id || !onDropAppointment) return;

    const appt = appointments.find((a) => a.id === id);
    if (!appt) return;

    const oldStart = new Date(appt.scheduled_for);
    const newStart = new Date(day);
    newStart.setHours(hour, oldStart.getMinutes(), 0, 0);

    if (newStart.getTime() === oldStart.getTime()) return;

    let newEndIso: string | null = null;
    if (appt.scheduled_end) {
      const delta = newStart.getTime() - oldStart.getTime();
      newEndIso = new Date(new Date(appt.scheduled_end).getTime() + delta).toISOString();
    }

    onDropAppointment(id, newStart.toISOString(), newEndIso);
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
                {hours.map((h, rowIdx) => {
                  const cellKey = `${d.toDateString()}|${h}`;
                  return (
                    <div
                      key={h}
                      className={[
                        "absolute border-b border-l cursor-pointer transition-colors",
                        dragOverCell === cellKey ? "bg-blue-100/60" : "hover:bg-blue-50/40",
                      ].join(" ")}
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
                      onDragOver={dragEnabled ? (e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        setDragOverCell(cellKey);
                      } : undefined}
                      onDragLeave={dragEnabled ? () => {
                        setDragOverCell((cur) => (cur === cellKey ? null : cur));
                      } : undefined}
                      onDrop={dragEnabled ? (e) => {
                        e.preventDefault();
                        handleDrop(d, h);
                      } : undefined}
                    />
                  );
                })}

                {/* Appointment cards positioned by time with overlap columns */}
                {(() => {
                  const dayAppts = apptsForDay(d);
                  const overlapLayout = computeOverlapLayout(dayAppts, startHour, durationFor);

                  return dayAppts.map((a) => {
                    const apptDate = new Date(a.scheduled_for);
                    const apptHour = apptDate.getHours();
                    const apptMin = apptDate.getMinutes();
                    let mins: number;
                    if (a.scheduled_end) {
                      mins = Math.round((new Date(a.scheduled_end).getTime() - apptDate.getTime()) / 60_000);
                      if (mins <= 0) mins = durationFor(a.service_type);
                    } else {
                      mins = a.duration_minutes ?? durationFor(a.service_type);
                    }

                    const topOffset = (apptHour - startHour) * CELL_PX + (apptMin / 60) * CELL_PX;
                    const height = (mins / 60) * CELL_PX;

                    if (apptHour < startHour || apptHour > endHour) return null;

                    const selected = a.id === selectedAppointmentId;
                    const sameClient = selectedClientId && a.client_id === selectedClientId;
                    const isShort = mins <= 60;

                    const layout = overlapLayout.get(a.id) ?? { column: 0, totalColumns: 1 };
                    const widthPct = 100 / layout.totalColumns;
                    const leftPct = layout.column * widthPct;

                    const empColor = employeeColor(a.employee_id);
                    const empName = employeeName(a.employee_id);
                    const svcColor = serviceColors[a.service_type] ?? null;

                    return (
                      <button
                        key={a.id}
                        draggable={dragEnabled}
                        onClick={(e) => { e.stopPropagation(); onSelectAppointment(a.id); }}
                        onDoubleClick={(e) => { e.stopPropagation(); onEditAppointment?.(a.id); }}
                        onDragStart={dragEnabled ? (e) => {
                          e.stopPropagation();
                          e.dataTransfer.effectAllowed = "move";
                          e.dataTransfer.setData("text/plain", a.id);
                          setDraggingId(a.id);
                        } : undefined}
                        onDragEnd={dragEnabled ? () => { setDraggingId(null); setDragOverCell(null); } : undefined}
                        className={[
                          "absolute rounded-lg border text-left shadow-sm overflow-hidden px-2 z-[5]",
                          statusPill(a.status),
                          selected ? "ring-2 ring-blue-600 bg-blue-100/60 z-[6]" : "",
                          sameClient && !selected ? "outline outline-2 outline-blue-600/30" : "",
                          dragEnabled ? "cursor-grab active:cursor-grabbing" : "",
                          draggingId === a.id ? "opacity-40" : "",
                        ].join(" ")}
                        style={{
                          top: topOffset + 2,
                          height: Math.max(height - 4, 24),
                          left: `calc(${leftPct}% + 2px)`,
                          width: `calc(${widthPct}% - 4px)`,
                          borderLeftWidth: empColor ? 4 : undefined,
                          borderLeftColor: empColor ?? undefined,
                        }}
                      >
                        {isShort ? (
                          <div className="flex items-center justify-between gap-1 h-full min-w-0">
                            <div className="flex items-center gap-1 truncate min-w-0">
                              {svcColor && <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: svcColor }} />}
                              <span className="truncate font-medium text-xs">{a.service_type}</span>
                            </div>
                            <div className="text-[10px] text-slate-500 shrink-0">
                              {a.frequency_type && a.frequency_type !== "one_time" && <span className="mr-1">&#8635;</span>}
                              {timeRange(a.scheduled_for, mins)}
                            </div>
                          </div>
                        ) : (
                          <div className="py-1 flex flex-col h-full overflow-hidden">
                            <div className="flex items-center justify-between gap-1">
                              <div className="flex items-center gap-1 truncate min-w-0">
                                {svcColor && <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: svcColor }} />}
                                <span className="truncate font-medium text-xs">{a.service_type}</span>
                              </div>
                              <div className="text-[10px] shrink-0 flex items-center gap-1">
                                {a.frequency_type && a.frequency_type !== "one_time" && (
                                  <span className="text-blue-500" title={freqLabel(a)}>&#8635;</span>
                                )}
                                {statusLabel(a.status)}
                              </div>
                            </div>
                            <div className="text-[11px] text-slate-600 mt-0.5">{clientName(a.client_id)}</div>
                            {empName && (
                              <div className="text-[10px] mt-0.5 truncate" style={{ color: empColor ?? "#64748b" }}>
                                {empName}
                              </div>
                            )}
                            <div className="text-[10px] text-slate-500 mt-0.5">
                              {timeRange(a.scheduled_for, mins)} ({durationLabel(mins)})
                            </div>
                            {a.notes && (
                              <div className="text-[10px] text-slate-400 italic mt-auto truncate">
                                {a.notes}
                              </div>
                            )}
                          </div>
                        )}
                      </button>
                    );
                  });
                })()}
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
