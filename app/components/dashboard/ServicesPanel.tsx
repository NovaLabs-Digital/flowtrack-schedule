"use client";

import { useEffect, useState } from "react";
import { Service } from "@/app/components/dashboard/types";

type EditForm = { name: string; description: string };
const EMPTY_FORM: EditForm = { name: "", description: "" };

export default function ServicesPanel() {
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<EditForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  function loadServices() {
    fetch("/api/services")
      .then((r) => r.json())
      .then((data) => {
        if (data.services) setServices(data.services);
        else if (data.error) setMessage({ type: "error", text: data.error });
      })
      .catch(() => setMessage({ type: "error", text: "Failed to load services." }))
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadServices(); }, []);

  function startEdit(s: Service) {
    setEditingId(s.id);
    setShowAdd(false);
    setForm({ name: s.name, description: s.description ?? "" });
    setMessage(null);
  }

  function startAdd() {
    setEditingId(null);
    setShowAdd(true);
    setForm(EMPTY_FORM);
    setMessage(null);
  }

  function cancelForm() {
    setEditingId(null);
    setShowAdd(false);
    setForm(EMPTY_FORM);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { setMessage({ type: "error", text: "Service name is required." }); return; }

    setSaving(true);
    setMessage(null);

    try {
      const isEdit = !!editingId;
      const res = await fetch("/api/services", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isEdit ? { id: editingId, ...form } : form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage({ type: "error", text: data?.error || "Save failed." }); return; }

      setMessage({ type: "success", text: isEdit ? "Service updated." : "Service added." });
      cancelForm();
      loadServices();
    } catch {
      setMessage({ type: "error", text: "Network error." });
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(s: Service) {
    setMessage(null);
    try {
      const res = await fetch("/api/services", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: s.id, active: !s.active }),
      });
      if (!res.ok) { setMessage({ type: "error", text: "Toggle failed." }); return; }
      setMessage({ type: "success", text: s.active ? "Service disabled." : "Service enabled." });
      loadServices();
    } catch {
      setMessage({ type: "error", text: "Network error." });
    }
  }

  const inputCls =
    "w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500";

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-sm text-slate-500">Loading services...</div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">Services</div>
          <div className="mt-1 text-xs text-slate-500">Manage the services your business offers.</div>
        </div>
        {!showAdd && !editingId && (
          <button
            onClick={startAdd}
            className="rounded-xl bg-[#0f172a] px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 transition-colors"
          >
            + Add Service
          </button>
        )}
      </div>

      {message && (
        <div className={[
          "mt-4 rounded-xl border px-3 py-2 text-xs",
          message.type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700"
            : "border-rose-200 bg-rose-50 text-rose-700",
        ].join(" ")}>
          {message.text}
        </div>
      )}

      {/* Add / Edit form */}
      {(showAdd || editingId) && (
        <form onSubmit={handleSave} className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3 max-w-xl">
          <div className="text-xs font-semibold text-slate-700">
            {editingId ? "Edit Service" : "New Service"}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Service Name *</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              className={inputCls}
              placeholder="e.g. Window Cleaning"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Description</label>
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              className={inputCls}
              placeholder="Optional description"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-[#0f172a] px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving..." : editingId ? "Save Changes" : "Add Service"}
            </button>
            <button
              type="button"
              onClick={cancelForm}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-white transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Table header */}
      <div className="mt-5 grid grid-cols-[1fr_1fr_80px_auto] gap-4 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-200">
        <div>Service Name</div>
        <div>Description</div>
        <div>Status</div>
        <div>Actions</div>
      </div>

      {/* Service rows */}
      <div>
        {services.length === 0 ? (
          <div className="text-sm text-slate-400 py-6 text-center">No services yet. Add your first service above.</div>
        ) : (
          services.map((s) => (
            <div
              key={s.id}
              className={[
                "grid grid-cols-[1fr_1fr_80px_auto] gap-4 items-center px-4 py-3 border-b border-slate-100 transition-colors",
                s.active ? "" : "opacity-50",
              ].join(" ")}
            >
              <div className={["text-sm font-medium", s.active ? "text-slate-900" : "text-slate-500 line-through"].join(" ")}>
                {s.name}
              </div>
              <div className="text-xs text-slate-500 truncate">
                {s.description || "—"}
              </div>
              <div>
                <span className={[
                  "text-[11px] font-medium px-2 py-0.5 rounded",
                  s.active ? "text-emerald-600 bg-emerald-50" : "text-rose-600 bg-rose-50",
                ].join(" ")}>
                  {s.active ? "Active" : "Inactive"}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => startEdit(s)}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 transition-colors flex items-center gap-1"
                >
                  <span className="text-[10px]">&#9998;</span> Edit
                </button>
                <button
                  onClick={() => toggleActive(s)}
                  className={[
                    "rounded-lg border px-2.5 py-1 text-xs transition-colors flex items-center gap-1",
                    s.active
                      ? "border-rose-200 text-rose-600 hover:bg-rose-50"
                      : "border-emerald-200 text-emerald-600 hover:bg-emerald-50",
                  ].join(" ")}
                >
                  <span className="text-[10px]">{s.active ? "✘" : "✔"}</span>
                  {s.active ? "Disable" : "Enable"}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      <div className="mt-3 px-4 text-xs text-slate-500">
        {services.length} service{services.length !== 1 ? "s" : ""}
      </div>
    </div>
  );
}
