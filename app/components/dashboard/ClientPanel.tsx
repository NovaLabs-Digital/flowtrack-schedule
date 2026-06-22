"use client";

import { useState } from "react";
import { Client, Appointment } from "@/app/components/dashboard/types";

function SectionHeader({ children, action }: { children: React.ReactNode; action?: string }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{children}</div>
      {action && <span className="text-[11px] text-blue-600 cursor-pointer hover:text-blue-700">{action}</span>}
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
        status === "Cancelled" ? "text-rose-600 bg-rose-50" : status === "Completed" ? "text-emerald-600 bg-emerald-50" : "text-blue-600 bg-blue-50",
      ].join(" ")}>{status}</span>
    </div>
  );
}

function CommRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5 py-1.5 border-b border-slate-50 last:border-0">
      <span className="text-slate-400 text-sm w-5 text-center shrink-0">{icon}</span>
      <span className="text-xs text-slate-700 flex-1">{label}</span>
      <span className="text-[11px] text-slate-600">{value}</span>
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
  const h = d.getHours(); const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM"; const h12 = h % 12 || 12;
  return m === 0 ? `${h12}:00 ${ampm}` : `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

type EditForm = {
  name: string; phone: string; email: string; address: string;
  client_since: string; referred_by: string; status: string;
  notes: string; preferred_contact_method: string;
  auto_email: boolean; auto_sms: boolean;
};

function initForm(c: Client): EditForm {
  return {
    name: c.name ?? "", phone: c.phone ?? "", email: c.email ?? "",
    address: c.address ?? "", client_since: c.client_since ?? "",
    referred_by: c.referred_by ?? "", status: c.status ?? "active",
    notes: c.notes ?? "", preferred_contact_method: c.preferred_contact_method ?? "",
    auto_email: !!c.auto_email, auto_sms: !!c.auto_sms,
  };
}

export default function ClientPanel({
  client, appointments, onClientUpdated,
}: {
  client: Client | null; appointments: Appointment[]; onClientUpdated: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditForm>(initForm(client ?? {} as Client));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  function startEdit() {
    if (!client) return;
    setForm(initForm(client));
    setEditing(true);
    setMessage(null);
  }

  async function saveEdit() {
    if (!client) return;
    if (!form.name.trim()) { setMessage({ type: "error", text: "Name is required." }); return; }
    setSaving(true); setMessage(null);
    try {
      const res = await fetch("/api/clients", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: client.id, ...form }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage({ type: "error", text: data?.error || "Save failed." }); return; }
      setMessage({ type: "success", text: "Client updated." });
      setEditing(false);
      onClientUpdated();
    } catch { setMessage({ type: "error", text: "Network error." }); }
    finally { setSaving(false); }
  }

  async function doAction(action: "archive" | "restore") {
    if (!client) return;
    setSaving(true); setMessage(null);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: client.id, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage({ type: "error", text: data?.error || "Failed." }); return; }
      setMessage({ type: "success", text: action === "archive" ? "Client archived." : "Client restored." });
      onClientUpdated();
    } catch { setMessage({ type: "error", text: "Network error." }); }
    finally { setSaving(false); }
  }

  const now = new Date();
  const clientAppts = client ? appointments.filter((a) => a.client_id === client.id) : [];
  const pastAppts = clientAppts.filter((a) => new Date(a.scheduled_for) < now)
    .sort((a, b) => new Date(b.scheduled_for).getTime() - new Date(a.scheduled_for).getTime());
  const futureAppts = clientAppts.filter((a) => a.status !== "cancelled" && new Date(a.scheduled_for) >= now)
    .sort((a, b) => new Date(a.scheduled_for).getTime() - new Date(b.scheduled_for).getTime());

  const isArchived = !!client?.archived_at;
  const inputCls = "w-full rounded-lg border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500";

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm h-full flex flex-col">
      {/* Header */}
      <div className="border-b px-5 py-3 shrink-0">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="text-base font-semibold text-slate-900">{client ? client.name : "No client selected"}</div>
              {isArchived && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">Archived</span>}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {client ? `${client.email || ""} ${client.phone ? "• " + client.phone : ""}`.trim() || "No contact info" : "Select a client or click an appointment to view details."}
            </div>
            {message && <div className={["mt-1 text-[11px] px-2 py-1 rounded", message.type === "success" ? "text-emerald-700 bg-emerald-50" : "text-rose-700 bg-rose-50"].join(" ")}>{message.text}</div>}
          </div>
          {client && !editing && (
            <div className="flex items-center gap-1.5 shrink-0">
              <button onClick={startEdit} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors">&#9998; Edit</button>
              {isArchived
                ? <button onClick={() => doAction("restore")} disabled={saving} className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 shadow-sm hover:bg-emerald-100 disabled:opacity-50">Restore</button>
                : <button onClick={() => doAction("archive")} disabled={saving} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700 shadow-sm hover:bg-amber-100 disabled:opacity-50">Archive</button>}
            </div>
          )}
        </div>
      </div>

      {/* Edit form - replaces the 5-column workspace when active */}
      {editing && client ? (
        <div className="flex-1 overflow-auto p-5">
          <div className="max-w-2xl space-y-3">
            <div className="text-xs font-semibold text-slate-700">Edit Client</div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">Name *</label>
                <input type="text" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">Phone</label>
                <input type="tel" value={form.phone} onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">Email</label>
                <input type="email" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} className={inputCls} />
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Address</label>
              <input type="text" value={form.address} onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))} className={inputCls} placeholder="123 Main St, City, FL 32801" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">Client Since</label>
                <input type="date" value={form.client_since} onChange={(e) => setForm((p) => ({ ...p, client_since: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">Referred By</label>
                <input type="text" value={form.referred_by} onChange={(e) => setForm((p) => ({ ...p, referred_by: e.target.value }))} className={inputCls} placeholder="Google, friend, etc." />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">Status</label>
                <select value={form.status} onChange={(e) => setForm((p) => ({ ...p, status: e.target.value }))} className={inputCls}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Notes</label>
              <textarea value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} rows={2} className={inputCls + " resize-none"} placeholder="Gate code, pet info, preferences..." />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">Preferred Contact</label>
                <select value={form.preferred_contact_method} onChange={(e) => setForm((p) => ({ ...p, preferred_contact_method: e.target.value }))} className={inputCls}>
                  <option value="">— None —</option>
                  <option value="phone">Phone</option>
                  <option value="email">Email</option>
                  <option value="sms">SMS</option>
                </select>
              </div>
              <label className="flex items-center gap-2 pt-4 text-xs text-slate-700 cursor-pointer">
                <input type="checkbox" checked={form.auto_email} onChange={(e) => setForm((p) => ({ ...p, auto_email: e.target.checked }))} className="accent-slate-900" />
                Auto Email
              </label>
              <label className="flex items-center gap-2 pt-4 text-xs text-slate-700 cursor-pointer">
                <input type="checkbox" checked={form.auto_sms} onChange={(e) => setForm((p) => ({ ...p, auto_sms: e.target.checked }))} className="accent-slate-900" />
                Auto SMS
              </label>
            </div>
            <div className="flex gap-1.5 pt-1">
              <button onClick={saveEdit} disabled={saving} className="rounded-lg bg-slate-900 px-4 py-1.5 text-xs text-white hover:bg-slate-800 disabled:opacity-50">{saving ? "Saving..." : "Save Client"}</button>
              <button onClick={() => { setEditing(false); setMessage(null); }} className="rounded-lg border border-slate-300 px-4 py-1.5 text-xs text-slate-700 hover:bg-slate-50">Cancel</button>
            </div>
          </div>
        </div>
      ) : (
        /* 5-column workspace */
        <div className="flex-1 grid grid-cols-5 divide-x divide-slate-100 min-h-0 overflow-auto">
          <div className="p-4 flex flex-col">
            <SectionHeader>Client Information</SectionHeader>
            <div>
              <InfoRow icon="&#9900;" label="Name" value={client?.name ?? "—"} />
              <InfoRow icon="&#9742;" label="Phone" value={client?.phone ?? "—"} />
              <InfoRow icon="&#9993;" label="Email" value={client?.email ?? "—"} />
              <InfoRow icon="&#9906;" label="Address" value={client?.address ?? "—"} />
              <InfoRow icon="&#128197;" label="Client since" value={client?.client_since ? fmtDate(client.client_since) : "—"} />
              <InfoRow icon="&#128196;" label="Referred by" value={client?.referred_by ?? "—"} />
            </div>
          </div>

          <div className="p-4 flex flex-col">
            <SectionHeader action={pastAppts.length > 4 ? "View all" : undefined}>Past Services</SectionHeader>
            {pastAppts.length > 0 ? (
              <div className="overflow-auto flex-1 min-h-0">
                {pastAppts.slice(0, 6).map((a) => (
                  <ServiceRow key={a.id} date={fmtDate(a.scheduled_for)} service={a.service_type} status={a.status === "cancelled" ? "Cancelled" : "Completed"} />
                ))}
              </div>
            ) : <EmptyCol icon="&#128340;" line1="No past services" line2="Service history will appear here." />}
          </div>

          <div className="p-4 flex flex-col">
            <SectionHeader action={futureAppts.length > 4 ? "View all" : undefined}>Future Services</SectionHeader>
            {futureAppts.length > 0 ? (
              <div className="overflow-auto flex-1 min-h-0">
                {futureAppts.slice(0, 6).map((a) => (
                  <ServiceRow key={a.id} date={fmtDate(a.scheduled_for)} time={fmtTime(a.scheduled_for)} service={a.service_type} status="Scheduled" />
                ))}
              </div>
            ) : <EmptyCol icon="&#128197;" line1="No upcoming services" line2="Scheduled services will appear here." />}
          </div>

          <div className="p-4 flex flex-col">
            <SectionHeader>Notes</SectionHeader>
            {client?.notes ? (
              <div className="text-xs text-slate-700 whitespace-pre-wrap">{client.notes}</div>
            ) : (
              <EmptyCol icon="&#128221;" line1="No notes" line2="Notes about this client will appear here." />
            )}
          </div>

          <div className="p-4 flex flex-col">
            <SectionHeader>Communication</SectionHeader>
            <div>
              <CommRow icon="&#128172;" label="SMS" value={client?.auto_sms ? "&#10003; Auto" : client?.phone ? "Available" : "—"} />
              <CommRow icon="&#9993;" label="Email" value={client?.auto_email ? "&#10003; Auto" : client?.email ? "Available" : "—"} />
              <CommRow icon="&#9742;" label="Phone" value={client?.phone ?? "—"} />
              <CommRow icon="&#9733;" label="Preferred" value={client?.preferred_contact_method ? client.preferred_contact_method.charAt(0).toUpperCase() + client.preferred_contact_method.slice(1) : "—"} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
