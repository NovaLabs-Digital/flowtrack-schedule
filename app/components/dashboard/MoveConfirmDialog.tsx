"use client";

import { useState } from "react";
import { Appointment, Client } from "@/app/components/dashboard/types";
import { NotifyChoice, NotifyChannel } from "@/app/components/dashboard/AppointmentModal";

function formatDateTime(iso: string) {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} at ${time}`;
}

type Props = {
  appointment: Appointment;
  client: Client;
  scheduledFor: string;
  scheduledEnd: string | null;
  onClose: () => void;
  onMoved: () => void;
};

export default function MoveConfirmDialog({ appointment, client, scheduledFor, scheduledEnd, onClose, onMoved }: Props) {
  const [notifyChannel, setNotifyChannel] = useState<NotifyChannel>("none");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const isRecurring = !!appointment.series_id && !!appointment.frequency_type && appointment.frequency_type !== "one_time";

  async function execute(mode: "single" | "future") {
    setSubmitting(true);
    setError("");
    try {
      const payload: Record<string, any> = {
        appointment_id: appointment.id,
        scheduled_for: scheduledFor,
        mode,
        notify_channel: notifyChannel,
      };
      if (scheduledEnd) payload.scheduled_end = scheduledEnd;

      const res = await fetch("/api/appointments/update", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data?.error || `Move failed (${res.status})`); return; }
      onMoved();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-sm rounded-2xl border bg-white p-5 shadow-lg">
        <div className="text-sm font-semibold text-slate-900">Move Appointment</div>
        <div className="text-sm text-slate-700 mt-2">
          Move {appointment.service_type} for {client.name}?
        </div>

        <div className="mt-3 rounded-xl border bg-slate-50 px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">From</div>
              <div className="text-sm text-slate-500 truncate">{formatDateTime(appointment.scheduled_for)}</div>
            </div>
            <span className="text-slate-300 shrink-0">&#8594;</span>
            <div className="min-w-0 text-right">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">To</div>
              <div className="text-sm font-medium text-slate-900 truncate">{formatDateTime(scheduledFor)}</div>
            </div>
          </div>
        </div>

        <div className="mt-4">
          <NotifyChoice
            value={notifyChannel}
            onChange={setNotifyChannel}
            hasEmail={!!client.email}
            hasPhone={!!client.phone}
            label="Notify client about this change?"
          />
        </div>

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 mt-3">{error}</div>
        )}

        {isRecurring ? (
          <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50/50 p-2 space-y-1">
            <div className="text-[11px] font-medium text-slate-500 px-2 pb-1">Apply move to:</div>
            <button type="button" onClick={() => execute("single")} disabled={submitting}
              className="w-full rounded-lg px-3 py-2 text-left text-xs bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50">
              <div className="font-medium text-slate-900">Only this appointment</div>
              <div className="text-slate-500 mt-0.5">Move this one only</div>
            </button>
            <button type="button" onClick={() => execute("future")} disabled={submitting}
              className="w-full rounded-lg px-3 py-2 text-left text-xs bg-white border border-blue-200 hover:bg-blue-50 disabled:opacity-50">
              <div className="font-medium text-blue-700">This and all future appointments</div>
              <div className="text-slate-500 mt-0.5">Apply time change to all remaining in this series</div>
            </button>
            <button type="button" onClick={onClose} disabled={submitting}
              className="w-full rounded-lg px-2 py-1.5 text-xs text-slate-500 hover:text-slate-700 disabled:opacity-50">
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex gap-2 mt-4">
            <button type="button" onClick={() => execute("single")} disabled={submitting}
              className="flex-1 rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-50">
              {submitting ? "Moving..." : "Move Appointment"}
            </button>
            <button type="button" onClick={onClose} disabled={submitting}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
