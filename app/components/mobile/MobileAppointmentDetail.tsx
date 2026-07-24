"use client";

import { useState } from "react";
import { Appointment, Client, Employee } from "@/app/components/dashboard/types";
import { toBusinessLocal } from "@/lib/timezone";
import CapabilityGatedButton from "@/app/components/dashboard/CapabilityGatedButton";

// Phase 5.5E-E1D: this control's own restricted notice, distinct from every
// other component's (appointment-modal-restricted-notice,
// appointment-detail-restricted-notice, move-confirm-dialog-restricted-
// notice, topbar-restricted-notice, mobile-dashboard-restricted-notice) --
// AppointmentModal can be mounted at the same time as this screen (Edit
// opens it as an overlay while this screen stays mounted underneath), so
// ids must not collide. Same approved wording.
const RESTRICTED_NOTICE_ID = "mobile-appointment-detail-restricted-notice";
const RESTRICTED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

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

type Props = {
  appointment: Appointment;
  client: Client | null;
  employee: Employee | null;
  durationMinutes: number;
  onBack: () => void;
  onEdit: () => void;
  onCancelled: () => void;
  onViewClient?: () => void;
  canMutateOperationalData: boolean;
};

// Screen 2 of the approved mockup. "Edit" reuses the existing AppointmentModal
// (via onEdit, wired by the caller) — no duplicated create/edit logic here.
// "Cancel Appointment" calls the same /api/appointments/delete endpoint the
// desktop AppointmentModal already uses.
export default function MobileAppointmentDetail({
  appointment,
  client,
  employee,
  durationMinutes,
  onBack,
  onEdit,
  onCancelled,
  onViewClient,
  canMutateOperationalData,
}: Props) {
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");

  const start = toBusinessLocal(appointment.scheduled_for);
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

  // Correction to the original E-E1D implementation: Edit is a
  // mutation-workflow entry control (it opens AppointmentModal, whose own
  // create/edit submit path is already governed under E-E1A) and must be
  // governed here too, not treated as read-only navigation -- mirrors
  // TopBar.tsx's handleAddClick (E-E1C), which wraps a prop-supplied
  // callback with the same kind of local guard for the same reason.
  // Defense-in-depth: CapabilityGatedButton already guards its own onClick
  // internally, but this guard additionally stops any stale or programmatic
  // call to onEdit that doesn't go through a click at all.
  function handleEditClick() {
    if (!canMutateOperationalData) return;
    onEdit();
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-slate-100">
      {/* Header */}
      <div className="shrink-0 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between">
        <button type="button" onClick={onBack} className="text-slate-500 text-xl leading-none w-8 h-8 flex items-center justify-center" aria-label="Back">
          ←
        </button>
        <div className="text-sm font-semibold text-slate-900">Appointment</div>
        <CapabilityGatedButton
          type="button"
          allowed={canMutateOperationalData}
          onClick={handleEditClick}
          ariaDescribedBy={RESTRICTED_NOTICE_ID}
          className="text-sm font-medium text-blue-600 disabled:opacity-50"
        >
          Edit
        </CapabilityGatedButton>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
        {/* Summary */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
          <div className="text-base font-semibold text-slate-900">{appointment.service_type}</div>
          <div className="text-sm text-slate-700">{client?.name ?? "Client"}</div>
          <div className="pt-1 space-y-1.5 text-sm text-slate-600">
            <div className="flex items-center gap-2">
              <span>📅</span>
              <span>{start.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</span>
            </div>
            <div className="flex items-center gap-2">
              <span>🕐</span>
              <span>{formatTime(start)} – {formatTime(end)} ({durationLabel(durationMinutes)})</span>
            </div>
            {employee && (
              <div className="flex items-center gap-2">
                <span>👤</span>
                <span>{employee.name}</span>
              </div>
            )}
            {client?.address && (
              <div className="flex items-center gap-2">
                <span>📍</span>
                <span>{client.address}</span>
              </div>
            )}
          </div>
        </div>

        {/* Client */}
        {client && (
          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Client</div>
            {onViewClient ? (
              <button type="button" onClick={onViewClient} className="text-sm font-semibold text-blue-600 text-left">
                {client.name} ›
              </button>
            ) : (
              <div className="text-sm font-semibold text-slate-900">{client.name}</div>
            )}
            <div className="flex items-center justify-between gap-2">
              {client.phone ? (
                <a href={`tel:${client.phone}`} className="text-sm text-blue-600">{client.phone}</a>
              ) : (
                <span className="text-sm text-slate-400">No phone on file</span>
              )}
              {client.phone && (
                <div className="flex items-center gap-2 shrink-0">
                  <a href={`tel:${client.phone}`} className="w-9 h-9 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center" aria-label="Call client">📞</a>
                  <a href={`sms:${client.phone}`} className="w-9 h-9 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center" aria-label="Text client">💬</a>
                </div>
              )}
            </div>
            {client.address && <div className="text-sm text-slate-500">{client.address}</div>}
          </div>
        )}

        {/* Notes */}
        {appointment.notes && (
          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-1">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Notes</div>
            <div className="text-sm text-slate-700 whitespace-pre-wrap">{appointment.notes}</div>
          </div>
        )}

        {/* Communication */}
        {client && (
          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Communication</div>
            <div className="flex items-center gap-2">
              <span
                className={[
                  "text-xs font-medium px-2.5 py-1 rounded-full",
                  client.auto_email ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500",
                ].join(" ")}
              >
                Auto Email {client.auto_email ? "ON" : "OFF"}
              </span>
              <span
                className={[
                  "text-xs font-medium px-2.5 py-1 rounded-full",
                  client.auto_sms ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500",
                ].join(" ")}
              >
                Auto SMS {client.auto_sms ? "ON" : "OFF"}
              </span>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>
        )}

        {!canMutateOperationalData && (
          <div id={RESTRICTED_NOTICE_ID} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {RESTRICTED_WORDING}
          </div>
        )}

        {/* Cancel */}
        <CapabilityGatedButton
          type="button"
          allowed={canMutateOperationalData}
          onClick={handleCancel}
          disabled={cancelling}
          ariaDescribedBy={RESTRICTED_NOTICE_ID}
          className="w-full rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700 active:bg-rose-100 disabled:opacity-50 transition-colors"
        >
          {cancelling ? "Cancelling..." : "Cancel Appointment"}
        </CapabilityGatedButton>
      </div>
    </div>
  );
}
