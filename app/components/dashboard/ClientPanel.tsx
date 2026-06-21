"use client";

import { Client, Appointment } from "@/app/components/dashboard/types";

function SectionHeader({ children, action }: { children: React.ReactNode; action?: string }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        {children}
      </div>
      {action && (
        <span className="text-[11px] text-blue-600 cursor-pointer hover:text-blue-700">
          {action}
        </span>
      )}
    </div>
  );
}

function InfoRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-slate-50 last:border-0">
      <span className="text-slate-400 text-sm w-5 text-center shrink-0">{icon}</span>
      <span className="text-xs text-slate-500 w-20 shrink-0">{label}</span>
      <span className="text-xs text-slate-800 truncate">{value}</span>
    </div>
  );
}

function ServiceRow({ date, time, service, status }: { date: string; time?: string; service: string; status: string }) {
  return (
    <div className="flex items-center gap-1.5 py-1.5 border-b border-slate-50 last:border-0 text-xs">
      <div className="shrink-0 w-[68px]">
        <div className="text-slate-600">{date}</div>
        {time && <div className="text-[10px] text-slate-400">{time}</div>}
      </div>
      <span className="text-slate-700 flex-1 truncate">{service}</span>
      <span className={[
        "text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0",
        status === "Cancelled" ? "text-rose-600 bg-rose-50"
          : status === "Completed" ? "text-emerald-600 bg-emerald-50"
          : "text-blue-600 bg-blue-50",
      ].join(" ")}>
        {status}
      </span>
    </div>
  );
}

function CommRow({ icon, label, enabled }: { icon: string; label: string; enabled: boolean }) {
  return (
    <div className="flex items-center gap-2.5 py-1.5 border-b border-slate-50 last:border-0">
      <span className="text-slate-400 text-sm w-5 text-center shrink-0">{icon}</span>
      <span className="text-xs text-slate-700 flex-1">{label}</span>
      {enabled ? (
        <span className="text-[11px] text-emerald-600 flex items-center gap-1">
          <span>&#10003;</span> Enabled
        </span>
      ) : (
        <span className="text-[11px] text-slate-400">—</span>
      )}
    </div>
  );
}

function EmptyCol({ icon, line1, line2 }: { icon: string; line1: string; line2: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center py-4">
      <div className="text-3xl text-slate-200 mb-2">{icon}</div>
      <div className="text-xs text-slate-400">{line1}</div>
      <div className="text-[11px] text-slate-400 mt-0.5">{line2}</div>
    </div>
  );
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12}:00 ${ampm}` : `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

export default function ClientPanel({
  client,
  appointments,
}: {
  client: Client | null;
  appointments: Appointment[];
}) {
  const now = new Date();
  const clientAppts = client
    ? appointments.filter((a) => a.client_id === client.id)
    : [];

  const pastAppts = clientAppts
    .filter((a) => new Date(a.scheduled_for) < now)
    .sort((a, b) => new Date(b.scheduled_for).getTime() - new Date(a.scheduled_for).getTime());

  const futureAppts = clientAppts
    .filter((a) => a.status !== "cancelled" && new Date(a.scheduled_for) >= now)
    .sort((a, b) => new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime());

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm h-full flex flex-col">
      {/* Header */}
      <div className="border-b px-5 py-3 shrink-0">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-base font-semibold text-slate-900">
              {client ? client.name : "No client selected"}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {client
                ? `${client.email || ""} ${client.phone ? "• " + client.phone : ""}`.trim() || "No contact info"
                : "Select a client or click an appointment to view details."}
            </div>
          </div>

          {client && (
            <div className="flex items-center gap-1.5 shrink-0">
              <button className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors flex items-center gap-1.5">
                <span>&#9998;</span> Edit Client
              </button>
              <button className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors flex items-center gap-1.5">
                <span>&#128172;</span> Send SMS
              </button>
              <button className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors flex items-center gap-1.5">
                <span>&#9993;</span> Send Email
              </button>
              <button className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-500 shadow-sm hover:bg-slate-50 transition-colors">
                &#8943;
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 5-column workspace */}
      <div className="flex-1 grid grid-cols-5 divide-x divide-slate-100 min-h-0 overflow-auto">
        {/* Client Information */}
        <div className="p-4 flex flex-col">
          <SectionHeader>Client Information</SectionHeader>
          <div>
            <InfoRow icon="&#9900;" label="Name" value={client?.name ?? "—"} />
            <InfoRow icon="&#9742;" label="Phone" value={client?.phone ?? "—"} />
            <InfoRow icon="&#9993;" label="Email" value={client?.email ?? "—"} />
            <InfoRow icon="&#9906;" label="Address" value="—" />
            <InfoRow icon="&#128197;" label="Client since" value="—" />
            <InfoRow icon="&#128196;" label="Referred by" value="—" />
          </div>
        </div>

        {/* Past Services */}
        <div className="p-4 flex flex-col">
          <SectionHeader action={pastAppts.length > 4 ? "View all" : undefined}>
            Past Services
          </SectionHeader>
          {pastAppts.length > 0 ? (
            <div className="overflow-auto flex-1 min-h-0">
              {pastAppts.slice(0, 6).map((a) => (
                <ServiceRow
                  key={a.id}
                  date={fmtDate(a.scheduled_for)}
                  service={a.service_type}
                  status={a.status === "cancelled" ? "Cancelled" : "Completed"}
                />
              ))}
            </div>
          ) : (
            <EmptyCol icon="&#128340;" line1="No past services" line2="Service history will appear here." />
          )}
        </div>

        {/* Future Services */}
        <div className="p-4 flex flex-col">
          <SectionHeader action={futureAppts.length > 4 ? "View all" : undefined}>
            Future Services
          </SectionHeader>
          {futureAppts.length > 0 ? (
            <div className="overflow-auto flex-1 min-h-0">
              {futureAppts.slice(0, 6).map((a) => (
                <ServiceRow
                  key={a.id}
                  date={fmtDate(a.scheduled_for)}
                  time={fmtTime(a.scheduled_for)}
                  service={a.service_type}
                  status="Scheduled"
                />
              ))}
            </div>
          ) : (
            <EmptyCol icon="&#128197;" line1="No upcoming services" line2="Scheduled services will appear here." />
          )}
        </div>

        {/* Notes */}
        <div className="p-4 flex flex-col">
          <SectionHeader>Notes</SectionHeader>
          {client ? (
            <div className="text-xs text-slate-500 italic">Client notes coming soon.</div>
          ) : (
            <EmptyCol icon="&#128221;" line1="No notes" line2="Notes about this client will appear here." />
          )}
        </div>

        {/* Communication Preferences */}
        <div className="p-4 flex flex-col">
          <SectionHeader>Communication</SectionHeader>
          <div>
            <CommRow icon="&#128172;" label="SMS" enabled={!!client?.phone} />
            <CommRow icon="&#9993;" label="Email" enabled={!!client?.email} />
            <CommRow icon="&#9742;" label="Phone" enabled={!!client?.phone} />
          </div>
          <div className="mt-3 flex items-center gap-2 py-1.5">
            <span className="text-slate-400 text-sm w-5 text-center shrink-0">&#9733;</span>
            <span className="text-xs text-slate-700 flex-1">Preferred</span>
            <span className="text-[11px] text-slate-700 font-medium">{client?.phone ? "SMS" : client?.email ? "Email" : "—"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
