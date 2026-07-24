"use client";

import { useState } from "react";
import { Appointment, Client, Employee, Service } from "@/app/components/dashboard/types";
import { notifyDemoAction } from "@/app/components/demo-experience/demoExperienceBus";
import CapabilityGatedButton from "@/app/components/dashboard/CapabilityGatedButton";

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
  employee: Employee | null;
  services: Service[];
  onEdit: () => void;
  onCancelled: () => void;
  canMutateOperationalData: boolean;
};

// Desktop "Appointment Details" control center — the appointment-focused
// counterpart to ClientPanel, shown whenever a specific appointment (not
// just a client) is selected. Mirrors MobileAppointmentDetail.tsx's
// Call/Text/Cancel pattern for parity with mobile, reusing the exact same
// /api/appointments/delete endpoint — no new backend logic.
export default function AppointmentDetailPanel({ appointment, client, employee, services, onEdit, onCancelled, canMutateOperationalData }: Props) {
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");

  const start = new Date(appointment.scheduled_for);
  const durationMinutes = scheduledMinutes(appointment, services);
  const end = new Date(start.getTime() + durationMinutes * 60_000);

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
        <button
          type="button"
          onClick={handleEdit}
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
        >
          &#9998; Edit
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <div className="text-base font-semibold text-slate-900">{appointment.service_type}</div>
          <div className="text-sm text-slate-600">
            {start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · {formatTime(start)} – {formatTime(end)}
          </div>
          {employee && <div className="text-sm text-slate-600">Employee: {employee.name}</div>}
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

      {error && (
        <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>
      )}

      {!canMutateOperationalData && (
        <div id={RESTRICTED_NOTICE_ID} className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {RESTRICTED_WORDING}
        </div>
      )}

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
    </div>
  );
}
