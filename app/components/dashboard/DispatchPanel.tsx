"use client";

import { useState } from "react";
import { Appointment, Client, Employee, EmployeeHours, AppointmentEmployeeAssignment } from "@/app/components/dashboard/types";
import PayrollSummary from "@/app/components/dashboard/PayrollSummary";
import IncomeProjection from "@/app/components/dashboard/IncomeProjection";
import { nowInBusinessTz, startOfBusinessDay, toBusinessLocal } from "@/lib/timezone";
import {
  hasInvalidJobTrackingDuration,
  assignmentHasWorkedHours,
  isJobTrackingComplete,
  getMissingHoursEmployeeIds,
  deriveAppointmentTrackingStatus,
  resolveWorkedMinutes,
  formatMinutesAsDuration,
  toDateInputValue,
} from "@/lib/payroll";
import CapabilityGatedButton from "@/app/components/dashboard/CapabilityGatedButton";
import { sortAssignmentsStable } from "@/lib/sortAssignmentsStable";

// Moved here from PayrollSummary.tsx unchanged -- the Mon-Fri default week,
// now computed once at this level so both Income Projection and Weekly
// Worked Hours read the exact same selected period (Income Projection is
// read-only against it; PayrollSummary's existing date inputs remain the
// one place it's edited).
//
// Phase 5E: `tz` is required, no default -- "Monday" must be resolved from
// "now" in the WORKSPACE's own timezone, never the browser/device's. Two
// workspaces reading this at the identical real instant can land on
// different calendar weeks (e.g. already Monday in New York, still Sunday
// in Honolulu) -- each must see its own correct local week.
function mondayOfCurrentWeek(tz: string): Date {
  const d = nowInBusinessTz(tz);
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

// Phase 5.5E-E1G: this control's own restricted notice, distinct from every
// other component's. Gated on canUseJobTracking, not canMutateOperationalData
// -- this manual-hours correction is the owner-invoked counterpart to
// employee Job Tracking (the server route it reaches already enforces the
// same capability), not a general operational-data edit. Employee Start/
// Complete Job actions (EmployeeJobActionButton.ts) are a completely
// separate component/session/policy and are untouched by this file.
const RESTRICTED_NOTICE_ID = "employee-hours-restricted-notice";
const RESTRICTED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

// `tz` is the workspace's own resolved timezone -- required, no default.
function formatDateTime(iso: string, tz: string) {
  const d = toBusinessLocal(iso, tz);
  const date = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  const time = m === 0 ? `${h12}:00 ${ampm}` : `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  return `${date} at ${time}`;
}

function mapsUrl(address: string) {
  return `https://maps.apple.com/?q=${encodeURIComponent(address)}`;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-slate-50 last:border-0">
      <span className="text-xs text-slate-400 w-20 shrink-0">{label}</span>
      <span className="text-xs text-slate-800">{value}</span>
    </div>
  );
}

function scheduledMinutes(appt: Appointment): number {
  if (appt.scheduled_end) {
    const mins = Math.round((new Date(appt.scheduled_end).getTime() - new Date(appt.scheduled_for).getTime()) / 60_000);
    if (mins > 0) return mins;
  }
  return appt.duration_minutes ?? 0;
}

function formatDuration(mins: number) {
  if (mins <= 0) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// Only ever rendered by DispatchPanel when needsWorkedHoursAttention() is
// true for this appointment (past, not cancelled, no Job Tracking, no saved
// manual entry yet) — so this form is always the missing-hours exception,
// never a way to edit an appointment's tracked duration.
function EmployeeHoursSection({
  appointment, employee, assignment, onSaved, canUseJobTracking,
}: {
  appointment: Appointment;
  employee: Employee;
  // Phase 5.7D-R18: this employee's own assignment row -- the source of
  // the invalid-duration check below, never the appointment-level (legacy,
  // frozen as of this phase) timestamps.
  assignment: Pick<AppointmentEmployeeAssignment, "actual_started_at" | "actual_completed_at">;
  onSaved: (entry: EmployeeHours) => void;
  canUseJobTracking: boolean;
}) {
  const [hours, setHours] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function save() {
    // Defense-in-depth: the server route this reaches already enforces this
    // same capability before mutating anything -- this guard only prevents
    // a restricted owner's client from ever issuing the request at all.
    if (!canUseJobTracking) return;
    const hoursNum = Number(hours);
    if (!hours.trim() || !Number.isFinite(hoursNum) || hoursNum <= 0) {
      setMessage({ type: "error", text: "Enter hours worked (e.g. 2.5)." });
      return;
    }
    if (!reason.trim()) {
      setMessage({ type: "error", text: "Enter a reason (e.g. forgot to clock in/out)." });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/appointments/employee-hours", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appointment_id: appointment.id,
          employee_id: employee.id,
          hours_worked: hoursNum,
          note: reason.trim(),
        }),
      });
      const data: { entry?: EmployeeHours; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !data.entry) { setMessage({ type: "error", text: data?.error || "Save failed." }); return; }
      setMessage({ type: "success", text: "Hours saved." });
      onSaved(data.entry);
    } catch {
      setMessage({ type: "error", text: "Network error." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-slate-800">{employee.name}</span>
        <span className="text-slate-500">Scheduled Time: {formatDuration(scheduledMinutes(appointment))}</span>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700">
        &#9888; {hasInvalidJobTrackingDuration(assignment)
          ? "Clock-in and clock-out produced no valid worked time."
          : "Employee did not complete Job Tracking."}
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs text-slate-500 shrink-0">Hours Worked</label>
        <input
          type="number"
          step="0.25"
          min="0"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          placeholder="2.5"
          disabled={!canUseJobTracking}
          className="w-20 rounded-lg border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        />
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs text-slate-500 shrink-0">Reason</label>
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. forgot to clock in/out"
          disabled={!canUseJobTracking}
          className="flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        />
      </div>
      {message && (
        <div className={[
          "text-[11px] px-2 py-1 rounded",
          message.type === "success" ? "text-emerald-700 bg-emerald-50" : "text-rose-700 bg-rose-50",
        ].join(" ")}>
          {message.text}
        </div>
      )}
      {!canUseJobTracking && (
        <div id={RESTRICTED_NOTICE_ID} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] text-slate-600">
          {RESTRICTED_WORDING}
        </div>
      )}
      <CapabilityGatedButton
        type="button"
        allowed={canUseJobTracking}
        onClick={save}
        disabled={saving}
        ariaDescribedBy={RESTRICTED_NOTICE_ID}
        className="w-full rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50 transition-colors"
      >
        {saving ? "Saving..." : "Save Worked Hours"}
      </CapabilityGatedButton>
    </div>
  );
}

export default function DispatchPanel({
  appointments,
  clients,
  employees,
  employeeHours,
  assignments,
  selectedAppointmentId,
  onHoursSaved,
  canUseJobTracking,
  timezone,
}: {
  appointments: Appointment[];
  clients: Client[];
  employees: Employee[];
  employeeHours: EmployeeHours[];
  // Phase 5.7D-R18: every appointment_employees row for the workspace --
  // the authoritative "who's assigned" and per-employee Job Tracking
  // source, grouped internally below by appointment_id.
  assignments: AppointmentEmployeeAssignment[];
  selectedAppointmentId: string | null;
  onHoursSaved: (entry: EmployeeHours) => void;
  canUseJobTracking: boolean;
  // The workspace's own resolved timezone -- used for the selected
  // appointment's own detail display (formatDateTime above), the default
  // Mon-Fri week (mondayOfCurrentWeek), the "today" Dispatch summary
  // counts below, and passed through to Income Projection/Weekly Worked
  // Hours for their own date-range bucketing.
  timezone: string;
}) {
  const defaultMonday = mondayOfCurrentWeek(timezone);
  const [rangeStart, setRangeStart] = useState(toDateInputValue(defaultMonday));
  const [rangeEnd, setRangeEnd] = useState(toDateInputValue(addDays(defaultMonday, 4)));

  const employeeById: Record<string, Employee> = {};
  for (const e of employees) employeeById[e.id] = e;

  const assignmentsByApptId = new Map<string, AppointmentEmployeeAssignment[]>();
  for (const a of assignments) {
    const list = assignmentsByApptId.get(a.appointment_id);
    if (list) list.push(a);
    else assignmentsByApptId.set(a.appointment_id, [a]);
  }

  const today = startOfBusinessDay(0, timezone);
  const tomorrow = startOfBusinessDay(1, timezone);

  const todayAppts = appointments.filter((a) => {
    const d = new Date(a.scheduled_for);
    return d >= today && d < tomorrow && a.status === "scheduled";
  });

  // Phase 5.7D-R18: derived from each appointment's own assignment rows
  // (deriveAppointmentTrackingStatus), never the legacy appointment-level
  // actual_started_at/actual_completed_at columns, which stop being
  // written to once any assignment exists.
  const todayStatuses = todayAppts.map((a) => deriveAppointmentTrackingStatus(assignmentsByApptId.get(a.id) ?? []));
  const scheduled = todayStatuses.filter((s) => s === "scheduled").length;
  const inProgress = todayStatuses.filter((s) => s === "in_progress").length;
  const completed = todayStatuses.filter((s) => s === "completed").length;

  const selectedAppt = selectedAppointmentId
    ? appointments.find((a) => a.id === selectedAppointmentId) ?? null
    : null;

  const client = selectedAppt
    ? clients.find((c) => c.id === selectedAppt.client_id) ?? null
    : null;

  // Phase 5.7D-R19: stable order (sortAssignmentsStable) so this panel's
  // Employee Worked Hours list always agrees with the appointment modal's
  // own Worked Hours order and Team Color's deterministic fallback.
  const selectedApptAssignments = selectedAppt ? sortAssignmentsStable(assignmentsByApptId.get(selectedAppt.id) ?? []) : [];
  const selectedApptEmployees = selectedApptAssignments
    .map((a) => employeeById[a.employee_id])
    .filter((e): e is Employee => !!e);
  const selectedApptStatus = selectedAppt ? deriveAppointmentTrackingStatus(selectedApptAssignments) : "scheduled";
  const missingHoursEmployeeIds = selectedAppt ? getMissingHoursEmployeeIds(selectedAppt, selectedApptAssignments, employeeHours) : [];

  return (
    <div className="flex flex-col h-full gap-2 overflow-y-auto">
      {/* 1. Dispatch summary */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4 shrink-0">
        <div className="text-sm font-semibold text-slate-900">Dispatch</div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="rounded-xl bg-slate-50 px-3 py-2 text-center">
            <div className="text-lg font-semibold text-slate-900">{scheduled}</div>
            <div className="text-[10px] text-slate-500 mt-0.5">Scheduled</div>
          </div>
          <div className="rounded-xl bg-blue-50 px-3 py-2 text-center">
            <div className="text-lg font-semibold text-blue-700">{inProgress}</div>
            <div className="text-[10px] text-blue-500 mt-0.5">In Progress</div>
          </div>
          <div className="rounded-xl bg-emerald-50 px-3 py-2 text-center">
            <div className="text-lg font-semibold text-emerald-700">{completed}</div>
            <div className="text-[10px] text-emerald-500 mt-0.5">Completed</div>
          </div>
        </div>
      </div>

      {/* 2. Appointment Details */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm flex flex-col shrink-0">
        {selectedAppt && client ? (
          <>
            <div className="border-b px-4 py-3 shrink-0">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Appointment Details</div>
            </div>
            <div className="px-4 py-3">
              <InfoRow label="Client" value={client.name} />
              <InfoRow label="Address" value={client.address || "—"} />
              <InfoRow label="Phone" value={client.phone || "—"} />
              <InfoRow
                label={selectedApptEmployees.length === 1 ? "Employee" : "Employees"}
                value={selectedApptEmployees.length > 0 ? selectedApptEmployees.map((e) => e.name).join(", ") : "Unassigned"}
              />
              <InfoRow label="Service" value={selectedAppt.service_type} />
              <InfoRow label="Date & Time" value={formatDateTime(selectedAppt.scheduled_for, timezone)} />
              <InfoRow label="Status" value={
                selectedAppt.status === "cancelled" ? "Cancelled"
                : selectedApptStatus === "completed" ? "Completed"
                : selectedApptStatus === "in_progress" ? "In Progress"
                : "Scheduled"
              } />
              {selectedAppt.notes && (
                <div className="mt-2 pt-2 border-t border-slate-100">
                  <div className="text-xs text-slate-400 mb-1">Notes</div>
                  <div className="text-xs text-slate-700">{selectedAppt.notes}</div>
                </div>
              )}
            </div>

            {/* Action buttons */}
            {(client.address || client.phone) && (
              <div className="border-t px-4 py-3 shrink-0 flex gap-2">
                {client.address && (
                  <a
                    href={mapsUrl(client.address)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 transition-colors"
                  >
                    <span className="text-sm leading-none">📍</span>
                    Navigate
                  </a>
                )}
                {client.phone && (
                  <a
                    href={`tel:${client.phone}`}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                  >
                    <span className="text-sm leading-none">📞</span>
                    Call
                  </a>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center px-6 py-8">
            <div className="text-center">
              <div className="text-xs text-slate-400">Select an appointment to view dispatch details.</div>
            </div>
          </div>
        )}
      </div>

      {/* 3. Income Projection — always visible, independent of selection.
          Reads the same rangeStart/rangeEnd Weekly Worked Hours below is
          currently showing/editing. */}
      <IncomeProjection appointments={appointments} assignments={assignments} rangeStart={rangeStart} rangeEnd={rangeEnd} timezone={timezone} />

      {/* 4. Weekly Worked Hours — always visible, independent of selection */}
      <PayrollSummary
        appointments={appointments}
        employees={employees}
        employeeHours={employeeHours}
        assignments={assignments}
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        onRangeStartChange={setRangeStart}
        onRangeEndChange={setRangeEnd}
        timezone={timezone}
      />

      {/* 5. Employee Worked Hours — administrative task, lives at the
          bottom. Phase 5.7D-R18: one card per assigned employee (Section
          E.7 -- Teresa may have valid tracked hours and no warning while
          Roxana, on the same job, still needs attention) instead of a
          single appointment-level card. */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4 shrink-0">
        <div className="text-sm font-semibold text-slate-900 mb-3">Employee Worked Hours</div>
        {selectedAppt && selectedAppt.status === "cancelled" ? (
          // Phase 5.7D-R19: hidden entirely for a cancelled appointment --
          // matches computePayrollRows' unconditional cancelled-skip
          // (lib/payroll.ts) and AppointmentModal's own cancelled guard.
          <div className="text-xs text-slate-400">
            This appointment is cancelled — no worked hours to show.
          </div>
        ) : selectedAppt && selectedApptAssignments.length > 0 ? (
          <div className="space-y-2">
            {selectedApptAssignments.map((assignment) => {
              const emp = employeeById[assignment.employee_id];
              if (!emp) return null;
              if (assignmentHasWorkedHours(selectedAppt.id, emp.id, assignment, employeeHours)) {
                return (
                  <div key={assignment.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-800">{emp.name}</span>
                      <span className="text-slate-500">Scheduled Time: {formatDuration(scheduledMinutes(selectedAppt))}</span>
                    </div>
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
                      <div className="text-[10px] font-medium uppercase tracking-wide text-emerald-700">
                        Worked Time <span className="text-emerald-600">&#10003;</span>
                      </div>
                      <div className="text-sm font-semibold text-emerald-900 mt-0.5">
                        {formatMinutesAsDuration(resolveWorkedMinutes(selectedAppt.id, emp.id, assignment, employeeHours))}
                      </div>
                      <div className="text-[10px] text-emerald-700 mt-1">
                        {isJobTrackingComplete(assignment) ? "Hours tracked automatically." : "Manually entered."}
                      </div>
                    </div>
                  </div>
                );
              }
              if (missingHoursEmployeeIds.includes(emp.id)) {
                return (
                  <EmployeeHoursSection
                    key={assignment.id}
                    appointment={selectedAppt}
                    employee={emp}
                    assignment={assignment}
                    onSaved={onHoursSaved}
                    canUseJobTracking={canUseJobTracking}
                  />
                );
              }
              // Phase 5.7D-R19: neither tracked/manually-entered nor
              // past-due-and-missing -- a future or same-day-not-yet-ended
              // appointment. Used to be silently omitted; every assigned
              // employee must always appear here. Purely informational --
              // creates no appointment_employee_hours row, sets no
              // timestamp, and (matching missingHoursEmployeeIds exactly)
              // never affects missingHoursCount or payroll.
              return (
                <div key={assignment.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                  <div className="font-medium text-slate-800">{emp.name}</div>
                  <div className="text-slate-500 mt-0.5">Not tracked yet.</div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-xs text-slate-400">
            Select an appointment to view/review worked hours.
          </div>
        )}
      </div>
    </div>
  );
}
