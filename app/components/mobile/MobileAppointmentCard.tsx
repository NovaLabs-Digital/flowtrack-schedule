"use client";

import { Appointment, Client, Employee } from "@/app/components/dashboard/types";
import { toBusinessLocal } from "@/lib/timezone";

function formatTime(d: Date) {
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12}:00 ${ampm}` : `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function mapsUrl(address: string) {
  return `https://maps.apple.com/?q=${encodeURIComponent(address)}`;
}

type Props = {
  appointment: Appointment;
  client: Client | null;
  employee: Employee | null;
  serviceColor: string | null;
  durationMinutes: number;
  onTap: () => void;
};

// Presentational card used by both the Today screen and the Schedule
// (Agenda List) tab. Quick action defaults to Call when the client has a
// phone number, falling back to Navigate when only an address is on file —
// matches the one card in the approved mockup that shows Navigate instead of
// Call, and mirrors the existing Call/Navigate fallback convention already
// used in DispatchPanel.tsx and EmployeeSchedule.tsx.
export default function MobileAppointmentCard({ appointment, client, employee, serviceColor, durationMinutes, onTap }: Props) {
  const start = toBusinessLocal(appointment.scheduled_for);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const timeLabel = `${formatTime(start)} – ${formatTime(end)}`;

  const hasPhone = !!client?.phone;
  const hasAddress = !!client?.address;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onTap}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onTap();
        }
      }}
      className="w-full flex items-stretch gap-3 rounded-xl border border-slate-200 bg-white p-3 text-left shadow-sm active:bg-slate-50 transition-colors cursor-pointer"
    >
      <div className="w-1 rounded-full shrink-0" style={{ backgroundColor: serviceColor ?? "#94a3b8" }} />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-slate-500">{timeLabel}</div>
        <div className="text-sm font-semibold text-slate-900 truncate mt-0.5">{appointment.service_type}</div>
        <div className="text-sm text-slate-700 truncate">{client?.name ?? "Client"}</div>
        {employee && (
          <div className="text-xs text-slate-400 truncate mt-0.5">{employee.name}</div>
        )}
      </div>
      <div className="flex items-center shrink-0">
        {hasPhone ? (
          <a
            href={`tel:${client!.phone}`}
            onClick={(e) => e.stopPropagation()}
            className="w-10 h-10 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center text-lg"
            aria-label="Call client"
          >
            📞
          </a>
        ) : hasAddress ? (
          <a
            href={mapsUrl(client!.address!)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="w-10 h-10 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center text-lg"
            aria-label="Navigate to address"
          >
            📍
          </a>
        ) : null}
      </div>
    </div>
  );
}
