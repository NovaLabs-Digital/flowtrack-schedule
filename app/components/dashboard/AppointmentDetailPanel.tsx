"use client";

import { useState } from "react";
import { Appointment, AppointmentEmployeeAssignment, Client, Employee, EmployeeHours, Service } from "@/app/components/dashboard/types";
import { notifyDemoAction } from "@/app/components/demo-experience/demoExperienceBus";
import CapabilityGatedButton from "@/app/components/dashboard/CapabilityGatedButton";
import { toBusinessLocal } from "@/lib/timezone";
import { findManualHoursEntry, formatMinutesAsDuration, isJobTrackingComplete, resolveWorkedMinutes, isHistoricalAppointment, needsWorkedTimeReview, trackedMinutes, isOwnerReviewConfirmation } from "@/lib/payroll";
import { sortAssignmentsStable } from "@/lib/sortAssignmentsStable";

// Phase 5.5E-E1B: this panel's own restricted notice, distinct from
// AppointmentModal's (appointment-modal-restricted-notice) -- both
// components can be mounted at the same time (selecting an appointment
// keeps this panel mounted underneath the edit modal), so the ids must not
// collide. Same approved wording, same shared-once-per-panel pattern.
const RESTRICTED_NOTICE_ID = "appointment-detail-restricted-notice";
const RESTRICTED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

function scheduledMinutes(appt: Appointment, services: Service[]): number {
  if (appt.scheduled_end) {
    const mins = Math.round((new Date(appt.scheduled_end).getTime() - new Date(appt.scheduled_for).getTime()) / 60_000);
    if (mins > 0) return mins;
  }
  if (appt.duration_minutes) return appt.duration_minutes;
  const svc = services.find((s) => s.name === appt.service_type);
  return svc?.duration_minutes ?? 60;
}

function formatTime(d: Date) {
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12}:00 ${ampm}` : `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

type Props = {
  appointment: Appointment;
  client: Client | null;
  // Phase 5.7D-R18: zero, one, or many assigned employees, resolved by the
  // parent from appointment_employees (never appointments.employee_id,
  // which is only ever a compatibility mirror -- see
  // lib/appointmentEmployees.ts).
  employees: Employee[];
  services: Service[];
  // Historical-record protection: this exact appointment's own assignment
  // rows (actual_started_at/actual_completed_at/job_notes) and every hours
  // entry, so this panel can show real Worked Hours / Employee Job Notes
  // for a Past Service review -- the same underlying data AppointmentModal's
  // Worked Hours card already reads, reused here rather than duplicated.
  assignments: AppointmentEmployeeAssignment[];
  employeeHours: EmployeeHours[];
  onEdit: () => void;
  onCancelled: () => void;
  canMutateOperationalData: boolean;
  // Phase 5C: the business's own resolved timezone -- this panel previously
  // read `new Date(appointment.scheduled_for)` directly and called native
  // local getters/toLocaleDateString on it, which reflected the browser/
  // device's own ambient timezone rather than the business's. A 9:00 AM New
  // York appointment must display as 9:00 AM here regardless of where the
  // owner's device currently is.
  timezone: string;
};

// Desktop "Appointment Details" control center — the appointment-focused
// counterpart to ClientPanel, shown whenever a specific appointment (not
// just a client) is selected. Mirrors MobileAppointmentDetail.tsx's
// Call/Text/Cancel pattern for parity with mobile, reusing the exact same
// /api/appointments/delete endpoint — no new backend logic.
export default function AppointmentDetailPanel({ appointment, client, employees, services, assignments, employeeHours, onEdit, onCancelled, canMutateOperationalData, timezone }: Props) {
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");

  // rawStart/rawEnd are real instants (used only for duration math); start/end
  // (below) are the business-local display values derived from them -- see
  // lib/timezone.ts's toBusinessLocal doc comment for why the two must never
  // be mixed.
  const rawStart = new Date(appointment.scheduled_for);
  const durationMinutes = scheduledMinutes(appointment, services);
  const rawEnd = new Date(rawStart.getTime() + durationMinutes * 60_000);
  const start = toBusinessLocal(appointment.scheduled_for, timezone);
  const end = toBusinessLocal(rawEnd.toISOString(), timezone);

  // Historical-record protection (founder decision): a past, completed, or
  // already-cancelled appointment is a historical record -- reviewable
  // here, but never cancelled/edited through the normal appointment-
  // management flow. isHistoricalAppointment is the single canonical
  // predicate the server routes also enforce (lib/payroll.ts) -- this is
  // the UI's own reflection of the same rule, not a second, independently
  // invented one. It treats the appointment as historical the moment EVERY
  // assigned employee's Job Tracking is complete, even if scheduled_end
  // hasn't elapsed yet -- not just once scheduled_end has passed.
  const isHistorical = isHistoricalAppointment(appointment, assignments);
  const statusLabel = appointment.status === "cancelled" ? "Cancelled" : isHistorical ? "Completed" : "Scheduled";

  async function handleCancel() {
    // Defense-in-depth: the server route this reaches already enforces this
    // same capability before mutating anything -- this guard only prevents a
    // restricted owner's client from ever issuing the request at all. See
    // CapabilityGatedButton.ts for the corresponding disabled-state guard on
    // the "Cancel Appointment" control below.
    if (!canMutateOperationalData) return;
    if (!confirm("Cancel this appointment?")) return;
    setCancelling(true);
    setError("");
    try {
      const res = await fetch("/api/appointments/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appointment_id: appointment.id, mode: "single", notify_channel: "none" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data?.error || "Cancel failed."); return; }
      onCancelled();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setCancelling(false);
    }
  }

  function handleEdit() {
    notifyDemoAction("click-edit-appointment");
    onEdit();
  }

  return (
    <div data-tour="appointment-detail" className="h-full rounded-2xl border border-slate-200 bg-white p-4 overflow-auto">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Appointment</div>
        {/* Historical-record protection: a past/completed appointment opens
            for review only -- Edit is hidden entirely rather than opening
            AppointmentModal's fully mutable form for a record that can no
            longer be changed (server-enforced too, see lib/payroll.ts's
            isHistoricalAppointment and the appointments/update route). */}
        {!isHistorical && (
          <button
            type="button"
            onClick={handleEdit}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
          >
            &#9998; Edit
          </button>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <div className="text-base font-semibold text-slate-900">{appointment.service_type}</div>
          <div className="text-sm text-slate-600">
            {start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · {formatTime(start)} – {formatTime(end)}
          </div>
          <div className="text-xs font-medium text-slate-500">{statusLabel}</div>
          {employees.length > 0 ? (
            <div className="text-sm text-slate-600">
              {employees.length === 1 ? "Employee" : "Employees"}: {employees.map((e) => e.name).join(", ")}
            </div>
          ) : (
            <div className="text-sm text-slate-400">Unassigned</div>
          )}
          {appointment.notes && (
            <div className="text-sm text-slate-600 whitespace-pre-wrap">Notes: {appointment.notes}</div>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="text-sm font-semibold text-slate-900">{client?.name ?? "Client"}</div>
          {client?.address && <div className="text-xs text-slate-500">{client.address}</div>}
          <div className="flex items-center gap-2 pt-0.5">
            {client?.phone ? (
              <>
                <a
                  href={`tel:${client.phone}`}
                  className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100 transition-colors"
                >
                  Call
                </a>
                <a
                  href={`sms:${client.phone}`}
                  className="rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 transition-colors"
                >
                  Text
                </a>
              </>
            ) : (
              <span className="text-xs text-slate-400">No phone on file</span>
            )}
          </div>
        </div>
      </div>

      {/* Worked Hours / Employee Job Notes -- reuses the exact same
          underlying data (appointment_employees + appointment_employee_hours)
          and computation (lib/payroll.ts) as AppointmentModal's own Worked
          Hours card, so a Past Service reviewed here and the same
          appointment reviewed there never disagree. Hidden entirely for a
          cancelled appointment, mirroring that same convention. Read-only by
          construction -- this panel has no field this card could ever write
          to. */}
      {appointment.status !== "cancelled" && assignments.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="text-xs font-medium text-slate-600">Worked Hours</div>
          {sortAssignmentsStable(assignments).map((assignment) => {
            const emp = employees.find((e) => e.id === assignment.employee_id);
            const manualEntry = findManualHoursEntry(appointment.id, assignment.employee_id, employeeHours);
            const complete = isJobTrackingComplete(assignment);
            const hasAnyRecordedActivity = !!assignment.actual_started_at || !!assignment.actual_completed_at || !!manualEntry;

            if (!hasAnyRecordedActivity) {
              return (
                <div key={assignment.id} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs space-y-1">
                  <div className="font-medium text-slate-700">{emp?.name ?? "Unknown employee"}</div>
                  <div className="text-slate-500">Not tracked yet.</div>
                </div>
              );
            }

            const startedLabel = assignment.actual_started_at
              ? toBusinessLocal(assignment.actual_started_at, timezone).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
              : "Not recorded";
            const completedLabel = assignment.actual_completed_at
              ? toBusinessLocal(assignment.actual_completed_at, timezone).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
              : "Not recorded";
            const workedMins = resolveWorkedMinutes(appointment.id, assignment.employee_id, assignment, employeeHours);
            // Owner override wins for display -- see resolveWorkedMinutes
            // (lib/payroll.ts) -- matching AppointmentModal's own card
            // exactly (branches on manualEntry FIRST). Display-only here:
            // no correction control, this panel has no field it could write
            // to.
            const needsReview = needsWorkedTimeReview(appointment, appointment.id, assignment.employee_id, assignments, employeeHours);
            const isReviewConfirmation = manualEntry && complete ? isOwnerReviewConfirmation(manualEntry, assignment) : false;

            return (
              <div key={assignment.id} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs space-y-1 text-slate-600">
                <div className="flex items-center justify-between">
                  <div className="font-medium text-slate-700">{emp?.name ?? "Unknown employee"}</div>
                  {needsReview && (
                    <span className="text-[10px] font-medium text-amber-700 bg-amber-100 rounded px-1.5 py-0.5">
                      &#9888; Needs Review
                    </span>
                  )}
                </div>
                <div>Started: <span className="font-medium text-slate-900">{startedLabel}</span></div>
                <div>Completed: <span className="font-medium text-slate-900">{completedLabel}</span></div>
                {manualEntry ? (
                  <>
                    <div>Worked Time: <span className="font-medium text-slate-900">{formatMinutesAsDuration(workedMins)}</span></div>
                    <div className="text-emerald-700">{isReviewConfirmation ? "Reviewed by owner ✓" : "Adjusted by owner."}</div>
                    {complete && (
                      <div>Original tracked time: <span className="font-medium text-slate-900">{formatMinutesAsDuration(trackedMinutes(assignment) ?? 0)}</span></div>
                    )}
                    {manualEntry.note && (
                      <div>Reason: <span className="italic">{manualEntry.note}</span></div>
                    )}
                  </>
                ) : complete ? (
                  <div>Actual duration: <span className="font-medium text-slate-900">{formatMinutesAsDuration(workedMins)}</span></div>
                ) : (
                  <div>Worked duration: not yet available.</div>
                )}
                {assignment.job_notes && (
                  <div className="pt-1 border-t border-slate-200 mt-1">
                    <div className="font-medium text-slate-700">Job Notes:</div>
                    <div className="whitespace-pre-wrap">{assignment.job_notes}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>
      )}

      {!canMutateOperationalData && !isHistorical && (
        <div id={RESTRICTED_NOTICE_ID} className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {RESTRICTED_WORDING}
        </div>
      )}

      {/* Historical-record protection: a past/completed appointment is
          reviewable here but can never be cancelled through the normal
          appointment-management flow -- the control (and its own restricted
          notice, above) simply doesn't render, rather than rendering
          disabled. The server route enforces the same rule independently
          (see app/api/appointments/delete/route.ts's isHistoricalAppointment
          guard), so this is UI clarity, not the only protection. */}
      {!isHistorical && (
        <div className="mt-3">
          <CapabilityGatedButton
            type="button"
            allowed={canMutateOperationalData}
            onClick={handleCancel}
            disabled={cancelling}
            ariaDescribedBy={RESTRICTED_NOTICE_ID}
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50 transition-colors"
          >
            {cancelling ? "Cancelling..." : "Cancel Appointment"}
          </CapabilityGatedButton>
        </div>
      )}
    </div>
  );
}
