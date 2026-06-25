"use client";

import { Appointment, Client, Employee } from "@/app/components/dashboard/types";

function formatDateTime(iso: string) {
  const d = new Date(iso);
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

export default function DispatchPanel({
  appointments,
  clients,
  employees,
  selectedAppointmentId,
}: {
  appointments: Appointment[];
  clients: Client[];
  employees: Employee[];
  selectedAppointmentId: string | null;
}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const todayAppts = appointments.filter((a) => {
    const d = new Date(a.scheduled_for);
    return d >= today && d < tomorrow && a.status === "scheduled";
  });

  const scheduled = todayAppts.filter((a) => !a.actual_started_at).length;
  const inProgress = todayAppts.filter((a) => a.actual_started_at && !a.actual_completed_at).length;
  const completed = todayAppts.filter((a) => a.actual_completed_at).length;

  const selectedAppt = selectedAppointmentId
    ? appointments.find((a) => a.id === selectedAppointmentId) ?? null
    : null;

  const client = selectedAppt
    ? clients.find((c) => c.id === selectedAppt.client_id) ?? null
    : null;

  const employee = selectedAppt?.employee_id
    ? employees.find((e) => e.id === selectedAppt.employee_id) ?? null
    : null;

  return (
    <div className="flex flex-col h-full gap-2">
      {/* Top: Dispatch summary */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4">
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

      {/* Bottom: Selected appointment details */}
      <div className="flex-1 rounded-2xl border border-slate-200 bg-white shadow-sm flex flex-col min-h-0">
        {selectedAppt && client ? (
          <>
            <div className="border-b px-4 py-3 shrink-0">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Appointment Details</div>
            </div>
            <div className="flex-1 overflow-auto px-4 py-3">
              <InfoRow label="Client" value={client.name} />
              <InfoRow label="Address" value={client.address || "—"} />
              <InfoRow label="Phone" value={client.phone || "—"} />
              <InfoRow label="Employee" value={employee ? employee.name : "Unassigned"} />
              <InfoRow label="Service" value={selectedAppt.service_type} />
              <InfoRow label="Date & Time" value={formatDateTime(selectedAppt.scheduled_for)} />
              <InfoRow label="Status" value={
                selectedAppt.actual_completed_at ? "Completed"
                : selectedAppt.actual_started_at ? "In Progress"
                : selectedAppt.status === "cancelled" ? "Cancelled"
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
          <div className="flex-1 flex items-center justify-center px-6">
            <div className="text-center">
              <div className="text-xs text-slate-400">Select an appointment to view dispatch details.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
