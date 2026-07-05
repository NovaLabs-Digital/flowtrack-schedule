"use client";

import { Client, Appointment } from "@/app/components/dashboard/types";

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

type Props = {
  client: Client;
  appointments: Appointment[];
  onClose: () => void;
};

// Screen 3 of the approved mockup — a slide-in drawer overlay, not a
// separate page/route. VIP badge is conditional on an is_vip field that
// doesn't exist on clients yet (backend TODO, flagged in the milestone
// report) — it simply won't render until that column is added.
export default function MobileClientDrawer({ client, appointments, onClose }: Props) {
  // Plain new Date() is a pure instant comparison (Date < Date), which is
  // timezone-agnostic and doesn't need business-tz anchoring — matches the
  // same past/future split already used on desktop in ClientPanel.tsx.
  const now = new Date();
  const clientAppts = appointments.filter((a) => a.client_id === client.id);
  const pastCompletedCount = clientAppts.filter(
    (a) => a.status !== "cancelled" && new Date(a.scheduled_for) < now
  ).length;
  const nextAppt = clientAppts
    .filter((a) => a.status !== "cancelled" && new Date(a.scheduled_for) >= now)
    .sort((a, b) => new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime())[0];

  const isVip = !!(client as unknown as { is_vip?: boolean }).is_vip;
  const isInactive = client.status === "inactive";
  const initials = client.name.split(" ").map((p) => p.charAt(0)).slice(0, 2).join("").toUpperCase();
  const mapsUrl = client.address ? `https://maps.apple.com/?q=${encodeURIComponent(client.address)}` : null;

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 w-full max-w-sm bg-white shadow-xl flex flex-col overflow-hidden safe-area-top">
        {/* Header */}
        <div className="shrink-0 border-b border-slate-200 px-4 py-3 flex items-center justify-between">
          <button type="button" onClick={onClose} className="text-slate-500 text-xl leading-none w-8 h-8 flex items-center justify-center" aria-label="Back">
            ←
          </button>
          <div className="text-sm font-semibold text-slate-900">Client</div>
          <button type="button" onClick={onClose} className="text-sm font-medium text-blue-600">
            Close
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 space-y-4">
          {/* Identity */}
          <div className="flex flex-col items-center text-center gap-2 pt-2">
            <div className="w-16 h-16 rounded-full bg-purple-600 text-white flex items-center justify-center text-xl font-semibold">
              {initials}
            </div>
            <div className="text-base font-semibold text-slate-900">{client.name}</div>
            <div className="flex items-center gap-1.5">
              <span
                className={[
                  "text-xs font-medium px-2 py-0.5 rounded-full",
                  isInactive ? "bg-slate-100 text-slate-500" : "bg-emerald-50 text-emerald-700",
                ].join(" ")}
              >
                {isInactive ? "Inactive" : "Active"}
              </span>
              {isVip && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">VIP</span>
              )}
            </div>
          </div>

          {/* Quick actions */}
          <div className="grid grid-cols-4 gap-2">
            {client.phone && (
              <a href={`tel:${client.phone}`} className="flex flex-col items-center gap-1 py-2 rounded-xl bg-slate-50">
                <span className="w-9 h-9 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center text-base">📞</span>
                <span className="text-[11px] text-slate-600">Call</span>
              </a>
            )}
            {client.phone && (
              <a href={`sms:${client.phone}`} className="flex flex-col items-center gap-1 py-2 rounded-xl bg-slate-50">
                <span className="w-9 h-9 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center text-base">💬</span>
                <span className="text-[11px] text-slate-600">Text</span>
              </a>
            )}
            {mapsUrl && (
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="flex flex-col items-center gap-1 py-2 rounded-xl bg-slate-50">
                <span className="w-9 h-9 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center text-base">📍</span>
                <span className="text-[11px] text-slate-600">Navigate</span>
              </a>
            )}
            {client.email && (
              <a href={`mailto:${client.email}`} className="flex flex-col items-center gap-1 py-2 rounded-xl bg-slate-50">
                <span className="w-9 h-9 rounded-full bg-purple-50 text-purple-600 flex items-center justify-center text-base">✉️</span>
                <span className="text-[11px] text-slate-600">Email</span>
              </a>
            )}
          </div>

          {/* Details */}
          <div className="space-y-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Phone</div>
              {client.phone ? (
                <a href={`tel:${client.phone}`} className="text-sm text-blue-600">{client.phone}</a>
              ) : (
                <div className="text-sm text-slate-400">—</div>
              )}
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Email</div>
              {client.email ? (
                <a href={`mailto:${client.email}`} className="text-sm text-blue-600">{client.email}</a>
              ) : (
                <div className="text-sm text-slate-400">—</div>
              )}
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Address</div>
              <div className="text-sm text-slate-700">{client.address ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Client Since</div>
              <div className="text-sm text-slate-700">{client.client_since ? fmtDate(client.client_since) : "—"}</div>
            </div>
            {client.notes && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Notes</div>
                <div className="text-sm text-slate-700 whitespace-pre-wrap">{client.notes}</div>
              </div>
            )}
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Past Services</div>
              <div className="text-sm text-slate-700">{pastCompletedCount} completed</div>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Future Services</div>
              <div className="text-sm text-slate-700">
                {nextAppt ? `Next: ${fmtDate(nextAppt.scheduled_for)}` : "None scheduled"}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
