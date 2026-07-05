"use client";

import { useState } from "react";
import { Client, Appointment, Service, Employee, EmployeeHours, ViewMode } from "@/app/components/dashboard/types";
import { nowInBusinessTz, toBusinessLocal } from "@/lib/timezone";
import { needsWorkedHoursAttention } from "@/lib/payroll";

function formatDay(d: Date) {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function formatWeekRange(days: Date[]) {
  if (days.length === 0) return "";
  const first = days[0];
  const last = days[days.length - 1];
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (first.getFullYear() !== nowInBusinessTz().getFullYear()) {
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
  const base = addDays(startOfWeek(nowInBusinessTz()), weekOffset * 7);
  if (viewMode === "day") return [addDays(nowInBusinessTz(), weekOffset * 7)];
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

// Splits a service's hex color into RGB channels, set as CSS custom properties
// on the card (see ".service-tint" in globals.css). Doing the light/dark tint
// math in CSS — rather than computing a fixed rgba() string here — lets the
// same channels resolve to a lighter or darker tint via @media
// (prefers-color-scheme: dark), without any JS-side theme detection.
// Accepts 3- or 6-digit hex, with or without "#".
function parseHex(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  return {
    r: parseInt(full.slice(0, 2), 16) || 0,
    g: parseInt(full.slice(2, 4), 16) || 0,
    b: parseInt(full.slice(4, 6), 16) || 0,
  };
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
  const start = toBusinessLocal(iso);
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
const QUARTER_PX = CELL_PX / 4;
const QUARTER_MINUTES = [0, 15, 30, 45];

type LayoutInfo = { column: number; totalColumns: number };

function computeOverlapLayout(appts: Appointment[], startHour: number, durationFor: (s: string) => number): Map<string, LayoutInfo> {
  const layout = new Map<string, LayoutInfo>();
  if (appts.length === 0) return layout;

  const items = appts.map((a) => {
    // Business-tz-anchored for the field extraction (startMin); the real instant
    // (rawStart) is used separately for the duration delta, since mixing the two
    // would shift the computed duration by the runtime's ambient UTC offset.
    const rawStart = new Date(a.scheduled_for);
    const localStart = toBusinessLocal(a.scheduled_for);
    const startMin = localStart.getHours() * 60 + localStart.getMinutes();
    let dur: number;
    if (a.scheduled_end) {
      dur = Math.round((new Date(a.scheduled_end).getTime() - rawStart.getTime()) / 60_000);
      if (dur <= 0) dur = durationFor(a.service_type);
    } else {
      dur = a.duration_minutes ?? durationFor(a.service_type);
    }
    return { id: a.id, start: startMin, end: startMin + dur };
  });

  items.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

  // Partition the sorted items into independent overlap clusters — a maximal
  // run of appointments transitively connected by time overlap. Column count
  // (and therefore card width) is then computed per cluster instead of per
  // day, so a busy stretch elsewhere doesn't reserve empty columns for a
  // stretch that only has one or two overlapping appointments.
  type Item = { id: string; start: number; end: number };
  const clusters: Item[][] = [];
  let currentCluster: Item[] = [];
  let clusterEnd = -Infinity;

  for (const item of items) {
    if (currentCluster.length > 0 && item.start >= clusterEnd) {
      clusters.push(currentCluster);
      currentCluster = [];
      clusterEnd = -Infinity;
    }
    currentCluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  if (currentCluster.length > 0) clusters.push(currentCluster);

  for (const cluster of clusters) {
    const columns: Item[][] = [];

    for (const item of cluster) {
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
  }

  return layout;
}

export default function ScheduleGrid({
  viewMode,
  clients,
  appointments,
  services,
  employees,
  employeeHours,
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
  employeeHours: EmployeeHours[];
  selectedClientId: string | null;
  selectedAppointmentId: string | null;
  onSelectAppointment: (id: string) => void;
  onEditAppointment?: (id: string) => void;
  onCellClick: (date: Date, hour: number, minute: number) => void;
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
    const apptDate = toBusinessLocal(a.scheduled_for);
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
      (a) => toBusinessLocal(a.scheduled_for).toDateString() === d.toDateString()
    );
  }

  function handleDrop(day: Date, hour: number, minute: number) {
    setDragOverCell(null);
    const id = draggingId;
    setDraggingId(null);
    if (!id || !onDropAppointment) return;

    const appt = appointments.find((a) => a.id === id);
    if (!appt) return;

    const oldStart = new Date(appt.scheduled_for);
    const newStart = new Date(day);
    newStart.setHours(hour, minute, 0, 0);

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
              const isToday = d.toDateString() === nowInBusinessTz().toDateString();
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
                {/* Continuous day-column divider — kept separate from the quarter-hour cells so it renders as one unbroken line */}
                <div className="absolute top-0 bottom-0 left-0 border-l" style={{ width: 0 }} />

                {/* Empty cell click/drop targets — 4 quarter-hour zones per hour */}
                {hours.flatMap((h, rowIdx) =>
                  QUARTER_MINUTES.map((min, qIdx) => {
                    const isHourBoundary = qIdx === QUARTER_MINUTES.length - 1;
                    // This cell's bottom edge sits at (min + 15) — qIdx 1 (min=15) is the one whose
                    // bottom border renders the :30 guide line.
                    const isHalfHourLine = qIdx === 1;
                    const cellKey = `${d.toDateString()}|${h}|${min}`;
                    return (
                      <div
                        key={cellKey}
                        className={[
                          "absolute cursor-pointer transition-colors",
                          isHourBoundary ? "border-b" : isHalfHourLine ? "border-b border-slate-300" : "border-b border-slate-200",
                          dragOverCell === cellKey ? "bg-blue-100/60" : "hover:bg-blue-50/40",
                        ].join(" ")}
                        style={{
                          top: rowIdx * CELL_PX + qIdx * QUARTER_PX,
                          left: 0,
                          right: 0,
                          height: QUARTER_PX,
                        }}
                        onClick={() => {
                          console.log("[CELL_CLICK]", formatDay(d), `${h}:${String(min).padStart(2, "0")}`);
                          onCellClick(d, h, min);
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
                          handleDrop(d, h, min);
                        } : undefined}
                      />
                    );
                  })
                )}

                {/* Appointment cards positioned by time with overlap columns */}
                {(() => {
                  const dayAppts = apptsForDay(d);
                  const overlapLayout = computeOverlapLayout(dayAppts, startHour, durationFor);

                  return dayAppts.map((a) => {
                    // rawStart is the real instant, used only for the duration delta;
                    // apptDate is business-tz-anchored, used only for hour/minute
                    // field extraction (card vertical position) — mixing the two
                    // would shift either the computed duration or the position.
                    const rawStart = new Date(a.scheduled_for);
                    const apptDate = toBusinessLocal(a.scheduled_for);
                    const apptHour = apptDate.getHours();
                    const apptMin = apptDate.getMinutes();
                    let mins: number;
                    if (a.scheduled_end) {
                      mins = Math.round((new Date(a.scheduled_end).getTime() - rawStart.getTime()) / 60_000);
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

                    const needsHoursWarning = needsWorkedHoursAttention(a, employeeHours);
                    const hoursWarningIcon = needsHoursWarning ? (
                      <span
                        title="Employee work hours require attention because Job Tracking was not completed."
                        onClick={(e) => e.stopPropagation()}
                        className="text-amber-500 cursor-help"
                      >
                        ⚠️
                      </span>
                    ) : null;

                    // Selected appointments always keep the plain status look underneath
                    // the blue ring, so selection is never diluted by a service tint.
                    const useServiceColor = !!svcColor && a.status !== "cancelled" && !selected;
                    const svcRgb = useServiceColor ? parseHex(svcColor!) : null;
                    // Applied only to the elements whose color is hardcoded for a light
                    // background — harmless (and unused) on cards that don't get the tint.
                    const darkTextCls = useServiceColor ? " dark:text-slate-100" : "";
                    const darkTimeCls = useServiceColor ? " dark:text-slate-400" : "";
                    const darkClientCls = useServiceColor ? " dark:text-slate-300" : "";
                    const darkNotesCls = useServiceColor ? " dark:text-slate-500" : "";

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
                          useServiceColor ? `service-tint text-slate-900${darkTextCls}` : statusPill(a.status),
                          selected ? "ring-2 ring-blue-600 bg-blue-100/60 z-[6]" : "",
                          sameClient && !selected ? "outline outline-2 outline-blue-600/30" : "",
                          dragEnabled ? "cursor-grab active:cursor-grabbing" : "",
                          draggingId === a.id ? "opacity-40" : "",
                          // While dragging, OTHER cards must not intercept drag/drop events —
                          // otherwise dropping onto an occupied time slot hits that appointment's
                          // card (which has no onDrop handler) instead of the quarter-hour
                          // dropzone underneath it, silently blocking the drop. The dragged card
                          // itself must keep pointer-events on: disabling it mid-drag (it's still
                          // under the cursor right after dragstart) causes the browser to lose
                          // track of the active native drag operation and cancel it outright.
                          draggingId && draggingId !== a.id ? "pointer-events-none" : "",
                        ].join(" ")}
                        style={{
                          top: topOffset + 2,
                          height: Math.max(height - 4, 24),
                          left: `calc(${leftPct}% + 2px)`,
                          width: `calc(${widthPct}% - 4px)`,
                          ...(svcRgb ? ({ "--svc-r": svcRgb.r, "--svc-g": svcRgb.g, "--svc-b": svcRgb.b } as React.CSSProperties) : {}),
                          borderLeftWidth: empColor ? 4 : undefined,
                          borderLeftColor: empColor ?? undefined,
                        }}
                      >
                        {isShort ? (
                          <div className="flex items-center justify-between gap-1 h-full min-w-0">
                            <div className="flex items-center gap-1 truncate min-w-0">
                              <span className="truncate font-medium text-xs">{a.service_type}</span>
                            </div>
                            <div className={`text-[10px] text-slate-500 shrink-0 flex items-center gap-1${darkTimeCls}`}>
                              {hoursWarningIcon}
                              {a.frequency_type && a.frequency_type !== "one_time" && <span>&#8635;</span>}
                              {timeRange(a.scheduled_for, mins)}
                            </div>
                          </div>
                        ) : (
                          <div className="py-1 flex flex-col h-full overflow-hidden">
                            <div className="flex items-center justify-between gap-1">
                              <div className="flex items-center gap-1 truncate min-w-0">
                                <span className="truncate font-medium text-xs">{a.service_type}</span>
                              </div>
                              <div className="text-[10px] shrink-0 flex items-center gap-1">
                                {hoursWarningIcon}
                                {a.frequency_type && a.frequency_type !== "one_time" && (
                                  <span className="text-blue-500" title={freqLabel(a)}>&#8635;</span>
                                )}
                                {statusLabel(a.status)}
                              </div>
                            </div>
                            <div className={`text-[11px] text-slate-600 mt-0.5${darkClientCls}`}>{clientName(a.client_id)}</div>
                            {empName && (
                              <div className="text-[10px] mt-0.5 truncate" style={{ color: empColor ?? "#64748b" }}>
                                {empName}
                              </div>
                            )}
                            <div className={`text-[10px] text-slate-500 mt-0.5${darkTimeCls}`}>
                              {timeRange(a.scheduled_for, mins)} ({durationLabel(mins)})
                            </div>
                            {a.notes && (
                              <div className={`text-[10px] text-slate-400 italic mt-auto truncate${darkNotesCls}`}>
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
