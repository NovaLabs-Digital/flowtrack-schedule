"use client";

import { useState } from "react";
import { Appointment, Client, Service, Employee } from "@/app/components/dashboard/types";

const FALLBACK_SERVICES = [
  "Regular Cleaning",
  "Deep Cleaning",
  "Move-Out Cleaning",
  "Office Cleaning",
  "Estimate",
];

function buildTimeSlots() {
  const slots: { value: string; label: string }[] = [];
  for (let h = 6; h <= 20; h++) {
    for (let m = 0; m < 60; m += 15) {
      const val = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const ampm = h >= 12 ? "PM" : "AM";
      const h12 = h % 12 || 12;
      const mStr = m === 0 ? "00" : String(m);
      slots.push({ value: val, label: `${h12}:${mStr} ${ampm}` });
    }
  }
  return slots;
}
const TIME_SLOTS = buildTimeSlots();

function toDateValue(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toHHMM(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function snapTo15(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const snapped = Math.round(m / 15) * 15;
  if (snapped >= 60) return `${String(h + 1).padStart(2, "0")}:00`;
  return `${String(h).padStart(2, "0")}:${String(snapped).padStart(2, "0")}`;
}

function addMinsToHHMM(hhmm: string, mins: number) {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function diffMins(a: string, b: string) {
  const [sh, sm] = a.split(":").map(Number);
  const [eh, em] = b.split(":").map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}

function durationLabel(mins: number) {
  if (mins <= 0) return "";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function frequencyLabel(ft?: string | null, rw?: number | null): string {
  if (!ft || ft === "one_time") return "One Time";
  if (ft === "daily") return "Daily";
  if (ft === "weekly") {
    if (!rw || rw === 1) return "Weekly";
    if (rw === 2) return "Every 2 Weeks";
    return `Every ${rw} Weeks`;
  }
  return ft;
}

const WEEK_OPTIONS = [1, 2, 3, 4, 6, 8];

type Props = {
  onClose: () => void;
  onSaved: () => void;
  clients: Client[];
  services: Service[];
  employees: Employee[];
  editing?: { appointment: Appointment; client: Client };
  prefill?: { date: string; time: string };
};

export default function AppointmentModal({ onClose, onSaved, clients, services, employees, editing, prefill }: Props) {
  const isEdit = !!editing;

  const serviceNames = services.length > 0 ? services.map((s) => s.name) : FALLBACK_SERVICES;
  const serviceDurations: Record<string, number> = {};
  for (const s of services) serviceDurations[s.name] = s.duration_minutes;
  const initialService = editing?.appointment.service_type ?? serviceNames[0] ?? "";
  function defaultDuration(name: string) { return serviceDurations[name] ?? 60; }

  function initTimeIn(): string {
    if (editing) return snapTo15(toHHMM(editing.appointment.scheduled_for));
    if (prefill?.time) return snapTo15(prefill.time);
    return "09:00";
  }
  function initTimeOut(): string {
    if (editing?.appointment.scheduled_end) return snapTo15(toHHMM(editing.appointment.scheduled_end));
    return addMinsToHHMM(initTimeIn(), editing?.appointment.duration_minutes ?? defaultDuration(initialService));
  }

  // Client state
  const [clientMode, setClientMode] = useState<"existing" | "new">("existing");
  const [selectedClientId, setSelectedClientId] = useState(editing?.appointment.client_id ?? "");
  const [newClient, setNewClient] = useState({ name: "", email: "", phone: "" });

  // Employee state
  const [selectedEmployeeId, setSelectedEmployeeId] = useState(editing?.appointment.employee_id ?? "");

  // Form state
  const [form, setForm] = useState({
    service_type: initialService,
    date: editing ? toDateValue(editing.appointment.scheduled_for) : (prefill?.date ?? ""),
    time_in: initTimeIn(),
    time_out: initTimeOut(),
    notes: editing?.appointment.notes ?? "",
    status: editing?.appointment.status ?? "scheduled",
    frequency_type: "one_time" as string,
    repeat_weeks: 1,
  });
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [showDeleteMenu, setShowDeleteMenu] = useState(false);
  const [error, setError] = useState("");

  function set(field: string, value: string | number) {
    setForm((prev) => {
      const next = { ...prev, [field]: value };
      if (field === "service_type" && typeof value === "string") {
        next.time_out = addMinsToHHMM(next.time_in, defaultDuration(value));
      }
      if (field === "time_in" && typeof value === "string") {
        const dur = diffMins(prev.time_in, prev.time_out);
        next.time_out = addMinsToHHMM(value, dur > 0 ? dur : defaultDuration(prev.service_type));
      }
      return next;
    });
  }

  const computedDuration = diffMins(form.time_in, form.time_out);
  const durationDisplay = computedDuration > 0 ? durationLabel(computedDuration) : "";
  const timeOutError = computedDuration <= 0 && form.time_in && form.time_out;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (clientMode === "existing" && !selectedClientId) return setError("Select a client.");
    if (clientMode === "new") {
      if (!newClient.name.trim()) return setError("Client name is required.");
      if (!newClient.email.trim() && !newClient.phone.trim()) return setError("Provide at least an email or phone.");
    }
    if (!form.date || !form.time_in || !form.time_out) return setError("Date, Time In, and Time Out are required.");
    if (computedDuration <= 0) return setError("Time Out must be after Time In.");

    const scheduled_for = new Date(`${form.date}T${form.time_in}`).toISOString();
    const scheduled_end = new Date(`${form.date}T${form.time_out}`).toISOString();

    setSubmitting(true);
    try {
      let res: Response;

      if (isEdit) {
        res = await fetch("/api/appointments/update", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            appointment_id: editing.appointment.id,
            service_type: form.service_type,
            scheduled_for, scheduled_end,
            notes: form.notes.trim(),
            status: form.status,
            duration_minutes: computedDuration,
            employee_id: selectedEmployeeId || null,
          }),
        });
      } else {
        const payload: Record<string, any> = {
          service_type: form.service_type,
          scheduled_for, scheduled_end,
          notes: form.notes.trim(),
          duration_minutes: computedDuration,
          frequency_type: form.frequency_type,
          repeat_weeks: form.repeat_weeks,
          employee_id: selectedEmployeeId || null,
        };
        if (clientMode === "existing") payload.client_id = selectedClientId;
        else {
          payload.name = newClient.name.trim();
          payload.email = newClient.email.trim();
          payload.phone = newClient.phone.trim();
        }
        res = await fetch("/api/appointments/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data?.error || `Request failed (${res.status})`); return; }
      onSaved();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const [confirmDelete, setConfirmDelete] = useState<"single" | "future" | null>(null);

  async function executeDelete(mode: "single" | "future") {
    if (!editing) return;

    setCancelling(true);
    setError("");
    try {
      const res = await fetch("/api/appointments/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appointment_id: editing.appointment.id, mode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data?.error || `Delete failed (${res.status})`); return; }
      onSaved();
    } catch {
      setError("Network error. Please try again.");
    } finally { setCancelling(false); setShowDeleteMenu(false); setConfirmDelete(null); }
  }

  const inputCls = "w-full rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 sm:px-0">
      <div className="w-full max-w-lg rounded-2xl border bg-white p-5 sm:p-6 shadow-lg max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">{isEdit ? "Edit Appointment" : "New Appointment"}</div>
          <button onClick={onClose} className="rounded-lg border px-2 py-1 text-xs hover:bg-slate-50">Close</button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          {/* Client */}
          {isEdit ? (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Client</label>
              <div className="rounded-xl border px-3 py-2 text-sm bg-slate-50 text-slate-700">
                {editing.client.name}
                {editing.client.email && <span className="text-slate-400 ml-2">{editing.client.email}</span>}
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-medium text-slate-600">Client *</label>
                <button type="button" onClick={() => { setClientMode((m) => m === "existing" ? "new" : "existing"); setError(""); }}
                  className="text-[11px] text-blue-600 hover:text-blue-700">
                  {clientMode === "existing" ? "+ New Client" : "Select Existing"}
                </button>
              </div>
              {clientMode === "existing" ? (
                <select value={selectedClientId} onChange={(e) => setSelectedClientId(e.target.value)} className={inputCls}>
                  <option value="">— Select a client —</option>
                  {clients.filter((c) => !c.archived_at).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}{c.email ? ` (${c.email})` : c.phone ? ` (${c.phone})` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="space-y-2 rounded-xl border border-blue-200 bg-blue-50/30 p-3">
                  <input type="text" value={newClient.name} onChange={(e) => setNewClient((p) => ({ ...p, name: e.target.value }))} className={inputCls} placeholder="Client name *" />
                  <div className="grid grid-cols-2 gap-2">
                    <input type="email" value={newClient.email} onChange={(e) => setNewClient((p) => ({ ...p, email: e.target.value }))} className={inputCls} placeholder="Email" />
                    <input type="tel" value={newClient.phone} onChange={(e) => setNewClient((p) => ({ ...p, phone: e.target.value }))} className={inputCls} placeholder="Phone" />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Service + Status */}
          <div className={isEdit ? "grid grid-cols-2 gap-3" : ""}>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Service Type</label>
              <select value={form.service_type} onChange={(e) => set("service_type", e.target.value)} className={inputCls}>
                {serviceNames.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {isEdit && (
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Status</label>
                <select value={form.status} onChange={(e) => set("status", e.target.value)} className={inputCls}>
                  <option value="scheduled">Scheduled</option>
                  <option value="cancelled">Cancelled</option>
                </select>
              </div>
            )}
          </div>

          {/* Assigned Employee */}
          {employees.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Assigned To</label>
              <select
                value={selectedEmployeeId}
                onChange={(e) => setSelectedEmployeeId(e.target.value)}
                className={inputCls}
              >
                <option value="">— Unassigned —</option>
                {employees.filter((emp) => emp.active).map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
                {selectedEmployeeId && !employees.find((emp) => emp.id === selectedEmployeeId)?.active && (
                  <option value={selectedEmployeeId} disabled>
                    {employees.find((emp) => emp.id === selectedEmployeeId)?.name ?? "Unknown"} (Inactive)
                  </option>
                )}
              </select>
            </div>
          )}

          {/* Date / Time In / Time Out */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Date *</label>
              <input type="date" value={form.date} onChange={(e) => set("date", e.target.value)} className={inputCls} />
            </div>
            <div className="grid grid-cols-2 sm:contents gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Time In *</label>
                <select value={form.time_in} onChange={(e) => set("time_in", e.target.value)} className={inputCls}>
                  {TIME_SLOTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Time Out *</label>
                <select value={form.time_out} onChange={(e) => set("time_out", e.target.value)} className={inputCls}>
                  {TIME_SLOTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>
          </div>

          {durationDisplay && !timeOutError && (
            <div className="text-xs text-slate-500 -mt-1">
              Duration: <span className="font-medium text-slate-700">{durationDisplay}</span>
            </div>
          )}
          {timeOutError && <div className="text-xs text-rose-600 -mt-1">Time Out must be after Time In.</div>}

          {/* Frequency — create mode only */}
          {!isEdit && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-2">Frequency</label>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {(["one_time", "daily", "weekly"] as const).map((ft) => (
                  <label key={ft} className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="frequency"
                      checked={form.frequency_type === ft}
                      onChange={() => set("frequency_type", ft)}
                      className="accent-slate-900"
                    />
                    {ft === "one_time" ? "One Time" : ft === "daily" ? "Daily" : "Weekly"}
                  </label>
                ))}
              </div>

              {form.frequency_type === "weekly" && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-slate-600">Repeat Every</span>
                  <select
                    value={form.repeat_weeks}
                    onChange={(e) => set("repeat_weeks", Number(e.target.value) as any)}
                    className="rounded-xl border px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 w-20"
                  >
                    {WEEK_OPTIONS.map((w) => <option key={w} value={w}>{w}</option>)}
                  </select>
                  <span className="text-xs text-slate-600">Week{form.repeat_weeks > 1 ? "s" : ""}</span>
                </div>
              )}

              {form.frequency_type !== "one_time" && (
                <div className="mt-1 text-[11px] text-slate-500">
                  Appointments will be created for the next 26 weeks from the start date.
                </div>
              )}
            </div>
          )}

          {/* Frequency info — edit mode */}
          {isEdit && editing.appointment.frequency_type && editing.appointment.frequency_type !== "one_time" && (
            <div className="rounded-xl border bg-slate-50 px-3 py-2 text-xs text-slate-600">
              Frequency: <span className="font-medium text-slate-900">
                {frequencyLabel(editing.appointment.frequency_type, editing.appointment.repeat_weeks)}
              </span>
              {editing.appointment.series_id && (
                <span className="text-slate-400 ml-2">Series</span>
              )}
            </div>
          )}

          {/* Job tracking info — edit mode only */}
          {isEdit && (editing.appointment.actual_started_at || editing.appointment.actual_completed_at) && (
            <div className="rounded-xl border bg-slate-50 px-3 py-2 text-xs text-slate-600 space-y-1">
              <div className="font-medium text-slate-700">Job Tracking</div>
              {editing.appointment.actual_started_at && (
                <div>Started: <span className="font-medium text-slate-900">{new Date(editing.appointment.actual_started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></div>
              )}
              {editing.appointment.actual_completed_at && (
                <div>Completed: <span className="font-medium text-slate-900">{new Date(editing.appointment.actual_completed_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></div>
              )}
              {editing.appointment.actual_started_at && editing.appointment.actual_completed_at && (() => {
                const mins = Math.round((new Date(editing.appointment.actual_completed_at).getTime() - new Date(editing.appointment.actual_started_at).getTime()) / 60_000);
                const h = Math.floor(mins / 60);
                const m = mins % 60;
                const label = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
                return <div>Actual duration: <span className="font-medium text-slate-900">{label}</span></div>;
              })()}
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Notes</label>
            <textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} className={inputCls + " resize-none"} placeholder="Optional notes..." />
          </div>

          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={submitting || cancelling}
              className="flex-1 rounded-xl bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-50">
              {submitting ? (isEdit ? "Saving..." : "Creating...") : (isEdit ? "Save Changes" : "Create Appointment")}
            </button>
            {isEdit && editing.appointment.status !== "cancelled" && (
              <div className="relative">
                <button type="button" onClick={() => setShowDeleteMenu((v) => !v)} disabled={submitting || cancelling}
                  className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700 hover:bg-rose-100 disabled:opacity-50">
                  {cancelling ? "Deleting..." : "Delete ▾"}
                </button>
              </div>
            )}
          </div>

          {/* Delete options — inline below action buttons */}
          {showDeleteMenu && isEdit && !confirmDelete && (
            <div className="mt-2 rounded-xl border border-rose-100 bg-rose-50/50 p-2 space-y-1">
              <div className="text-[11px] font-medium text-slate-500 px-2 pb-1">Delete Appointment</div>
              <button type="button" onClick={() => setConfirmDelete("single")}
                className="w-full rounded-lg px-3 py-2 text-left text-xs bg-white border border-slate-200 hover:bg-slate-50">
                <div className="font-medium text-slate-900">Only this appointment</div>
                <div className="text-slate-500 mt-0.5">Cancel this one only</div>
              </button>
              <button type="button" onClick={() => setConfirmDelete("future")}
                className="w-full rounded-lg px-3 py-2 text-left text-xs bg-white border border-rose-200 hover:bg-rose-50">
                <div className="font-medium text-rose-700">This and future appointments</div>
                <div className="text-slate-500 mt-0.5">{editing!.appointment.series_id ? "All remaining in this series" : "Same client & service"}</div>
              </button>
            </div>
          )}

          {/* Confirm delete step */}
          {confirmDelete && isEdit && (
            <div className="mt-2 rounded-xl border border-rose-300 bg-rose-50 p-3">
              <div className="text-xs font-medium text-rose-800">
                {confirmDelete === "single"
                  ? "Cancel this appointment? It will be marked as cancelled."
                  : "Cancel this and all future appointments? They will be marked as cancelled."}
              </div>
              <div className="flex gap-2 mt-2">
                <button type="button" onClick={() => executeDelete(confirmDelete)} disabled={cancelling}
                  className="rounded-lg bg-rose-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-50">
                  {cancelling ? "Deleting..." : "Yes, Delete"}
                </button>
                <button type="button" onClick={() => setConfirmDelete(null)}
                  className="rounded-lg border border-slate-300 px-4 py-1.5 text-xs text-slate-700 hover:bg-white">
                  No, Go Back
                </button>
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
