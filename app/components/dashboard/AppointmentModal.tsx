"use client";

import { useState } from "react";
import { Appointment, Client, Service } from "@/app/components/dashboard/types";

const FALLBACK_SERVICES = [
  "Regular Cleaning",
  "Deep Cleaning",
  "Move-Out Cleaning",
  "Office Cleaning",
  "Estimate",
];

const DURATION_OPTIONS = [
  { value: 30,  label: "30 min" },
  { value: 60,  label: "1 hr" },
  { value: 90,  label: "1.5 hrs" },
  { value: 120, label: "2 hrs" },
  { value: 150, label: "2.5 hrs" },
  { value: 180, label: "3 hrs" },
  { value: 240, label: "4 hrs" },
];

type Props = {
  onClose: () => void;
  onSaved: () => void;
  services: Service[];
  editing?: { appointment: Appointment; client: Client };
  prefill?: { date: string; time: string };
};

function toDateValue(iso: string) {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toTimeValue(iso: string) {
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${min}`;
}

function computeEndTime(date: string, time: string, durationMins: number): string {
  if (!date || !time) return "";
  const start = new Date(`${date}T${time}`);
  if (isNaN(start.getTime())) return "";
  const end = new Date(start.getTime() + durationMins * 60_000);
  const h = end.getHours();
  const m = end.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12}:00 ${ampm}` : `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

export default function AppointmentModal({ onClose, onSaved, services, editing, prefill }: Props) {
  const isEdit = !!editing;

  const serviceNames = services.length > 0
    ? services.map((s) => s.name)
    : FALLBACK_SERVICES;

  const serviceDurations: Record<string, number> = {};
  for (const s of services) serviceDurations[s.name] = s.duration_minutes;

  const initialService = editing?.appointment.service_type ?? serviceNames[0] ?? "";

  function defaultDuration(name: string) {
    return serviceDurations[name] ?? 60;
  }

  const [form, setForm] = useState({
    name: editing?.client.name ?? "",
    email: editing?.client.email ?? "",
    phone: editing?.client.phone ?? "",
    service_type: initialService,
    date: editing ? toDateValue(editing.appointment.scheduled_for) : (prefill?.date ?? ""),
    time: editing ? toTimeValue(editing.appointment.scheduled_for) : (prefill?.time ?? ""),
    duration: editing?.appointment.duration_minutes ?? defaultDuration(initialService),
    notes: editing?.appointment.notes ?? "",
    status: editing?.appointment.status ?? "scheduled",
  });
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");

  function set(field: string, value: string | number) {
    setForm((prev) => {
      const next = { ...prev, [field]: value };
      if (field === "service_type" && typeof value === "string") {
        next.duration = defaultDuration(value);
      }
      return next;
    });
  }

  const endTimeLabel = computeEndTime(form.date, form.time, form.duration);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!form.name.trim()) return setError("Client name is required.");
    if (!form.email.trim() && !form.phone.trim())
      return setError("Provide at least an email or phone.");
    if (!form.date || !form.time)
      return setError("Date and time are required.");

    const scheduled_for = new Date(`${form.date}T${form.time}`).toISOString();

    setSubmitting(true);
    try {
      let res: Response;

      if (isEdit) {
        res = await fetch("/api/appointments/update", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            appointment_id: editing.appointment.id,
            name: form.name.trim(),
            email: form.email.trim(),
            phone: form.phone.trim(),
            service_type: form.service_type,
            scheduled_for,
            notes: form.notes.trim(),
            status: form.status,
            duration_minutes: form.duration,
          }),
        });
      } else {
        res = await fetch("/api/appointments/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.name.trim(),
            email: form.email.trim(),
            phone: form.phone.trim(),
            service_type: form.service_type,
            scheduled_for,
            notes: form.notes.trim(),
            duration_minutes: form.duration,
          }),
        });
      }

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data?.error || `Request failed (${res.status})`);
        return;
      }

      onSaved();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancelAppointment() {
    if (!editing) return;
    if (!window.confirm("Cancel this appointment? The record will be kept but marked as cancelled.")) return;

    setCancelling(true);
    setError("");
    try {
      const res = await fetch("/api/appointments/update", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appointment_id: editing.appointment.id, status: "cancelled" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || `Request failed (${res.status})`);
        return;
      }
      onSaved();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setCancelling(false);
    }
  }

  const inputCls =
    "w-full rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-lg rounded-2xl border bg-white p-6 shadow-lg">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">
            {isEdit ? "Edit Appointment" : "New Appointment"}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border px-2 py-1 text-xs hover:bg-slate-50"
          >
            Close
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Client Name *
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              className={inputCls}
              placeholder="e.g. Maria Santos"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Email
              </label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                className={inputCls}
                placeholder="client@email.com"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Phone
              </label>
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => set("phone", e.target.value)}
                className={inputCls}
                placeholder="+13861234567"
              />
            </div>
          </div>

          <div className={isEdit ? "grid grid-cols-2 gap-3" : ""}>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Service Type
              </label>
              <select
                value={form.service_type}
                onChange={(e) => set("service_type", e.target.value)}
                className={inputCls}
              >
                {serviceNames.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            {isEdit && (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Status
                </label>
                <select
                  value={form.status}
                  onChange={(e) => set("status", e.target.value)}
                  className={inputCls}
                >
                  <option value="scheduled">Scheduled</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Date *
              </label>
              <input
                type="date"
                value={form.date}
                onChange={(e) => set("date", e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Start Time *
              </label>
              <input
                type="time"
                value={form.time}
                onChange={(e) => set("time", e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Duration
              </label>
              <select
                value={form.duration}
                onChange={(e) => set("duration", Number(e.target.value))}
                className={inputCls}
              >
                {DURATION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {endTimeLabel && (
            <div className="text-xs text-slate-500 -mt-1">
              Ends at <span className="font-medium text-slate-700">{endTimeLabel}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Notes
            </label>
            <textarea
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              rows={2}
              className={inputCls + " resize-none"}
              placeholder="Optional notes..."
            />
          </div>

          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={submitting || cancelling}
              className="flex-1 rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {submitting
                ? isEdit
                  ? "Saving..."
                  : "Creating..."
                : isEdit
                  ? "Save Changes"
                  : "Create Appointment"}
            </button>
            {isEdit && editing.appointment.status !== "cancelled" && (
              <button
                type="button"
                onClick={handleCancelAppointment}
                disabled={submitting || cancelling}
                className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700 hover:bg-rose-100 disabled:opacity-50"
              >
                {cancelling ? "Cancelling..." : "Cancel Appointment"}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border px-4 py-2 text-sm hover:bg-slate-50"
            >
              Close
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
