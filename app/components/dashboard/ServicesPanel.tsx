"use client";

import { useEffect, useState } from "react";
import { Service } from "@/app/components/dashboard/types";
import { notifyDemoAction } from "@/app/components/demo-experience/demoExperienceBus";
import CapabilityGatedButton from "@/app/components/dashboard/CapabilityGatedButton";
import { centsToInputValue, formatCents, parsePriceToCents } from "@/lib/money";

// Phase 5.5E-E1F: one shared notice for this whole panel -- Add, per-row
// Edit/Enable-Disable/Delete, and the Add/Edit form's Save submit are all
// facets of the single "manage services" task, matching the ClientPanel
// precedent (one notice per component, not per control).
const RESTRICTED_NOTICE_ID = "services-panel-restricted-notice";
const RESTRICTED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

// Curated, non-neon palette so service colors stay consistent and read well as
// a soft transparent card background across every ScheduleFlowTrack install.
const PRESET_COLORS = [
  { hex: "#2563EB", label: "Blue" },
  { hex: "#0284C7", label: "Sky Blue" },
  { hex: "#1E3A8A", label: "Navy" },
  { hex: "#0891B2", label: "Cyan" },
  { hex: "#0D9488", label: "Teal" },
  { hex: "#059669", label: "Emerald" },
  { hex: "#16A34A", label: "Green" },
  { hex: "#65A30D", label: "Lime" },
  { hex: "#6E7B3A", label: "Olive" },
  { hex: "#D97706", label: "Amber" },
  { hex: "#B8860B", label: "Gold" },
  { hex: "#EA580C", label: "Orange" },
  { hex: "#C2410C", label: "Burnt Orange" },
  { hex: "#E2604A", label: "Coral" },
  { hex: "#DC2626", label: "Red" },
  { hex: "#7A2331", label: "Burgundy" },
  { hex: "#DB2777", label: "Pink" },
  { hex: "#9333EA", label: "Purple" },
  { hex: "#4F46E5", label: "Indigo" },
  { hex: "#7C4A2D", label: "Brown" },
  { hex: "#475569", label: "Slate Gray" },
];

type EditForm = { name: string; description: string; color: string; price: string };
const EMPTY_FORM: EditForm = { name: "", description: "", color: PRESET_COLORS[0].hex, price: "" };

export default function ServicesPanel({
  isTester = false,
  canMutateOperationalData,
}: {
  isTester?: boolean;
  canMutateOperationalData: boolean;
}) {
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
    // Defense-in-depth: the server route this eventually reaches (via
    // handleSave) already enforces this same capability before mutating
    // anything -- this guard additionally prevents the edit form itself
    // from ever opening for a restricted owner.
    if (!canMutateOperationalData) return;
    setEditingId(s.id);
    setShowAdd(false);
    setForm({
      name: s.name,
      description: s.description ?? "",
      color: s.color ?? PRESET_COLORS[0].hex,
      price: centsToInputValue(s.default_price_cents),
    });
    setMessage(null);
  }

  function startAdd() {
    if (!canMutateOperationalData) return;
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
    if (!canMutateOperationalData) return;
    if (!form.name.trim()) { setMessage({ type: "error", text: "Service name is required." }); return; }

    // Blank means no default price; anything else must parse to a valid
    // non-negative amount (see lib/money.ts) -- an invalid value (letters,
    // more than 2 decimal places, negative) is rejected here rather than
    // silently dropped or sent to the server as garbage.
    const priceTrimmed = form.price.trim();
    const default_price_cents = priceTrimmed === "" ? null : parsePriceToCents(priceTrimmed);
    if (priceTrimmed !== "" && default_price_cents === null) {
      setMessage({ type: "error", text: "Enter a valid price (e.g. 45 or 45.00), or leave it blank." });
      return;
    }

    setSaving(true);
    setMessage(null);

    try {
      const isEdit = !!editingId;
      const res = await fetch("/api/services", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isEdit
            ? { id: editingId, name: form.name, description: form.description, color: form.color, default_price_cents }
            : { name: form.name, description: form.description, color: form.color, default_price_cents }
        ),
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

  async function handleDelete(s: Service) {
    if (!canMutateOperationalData) return;
    if (!confirm(`Delete "${s.name}"? This cannot be undone.`)) return;
    setMessage(null);
    try {
      const res = await fetch("/api/services", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: s.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage({ type: "error", text: data?.error || "Delete failed." }); return; }
      notifyDemoAction("delete-service");
      setMessage({ type: "success", text: "Service deleted." });
      loadServices();
    } catch {
      setMessage({ type: "error", text: "Network error." });
    }
  }

  async function toggleActive(s: Service) {
    if (!canMutateOperationalData) return;
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
    <div data-tour="services-area" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">Services</div>
          <div className="mt-1 text-xs text-slate-500">Manage the services your business offers.</div>
        </div>
        {!showAdd && !editingId && (
          <CapabilityGatedButton
            allowed={canMutateOperationalData}
            onClick={startAdd}
            ariaDescribedBy={RESTRICTED_NOTICE_ID}
            className="rounded-xl bg-[#0f172a] px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-50 transition-colors"
          >
            + Add Service
          </CapabilityGatedButton>
        )}
      </div>

      {!canMutateOperationalData && (
        <div id={RESTRICTED_NOTICE_ID} className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {RESTRICTED_WORDING}
        </div>
      )}

      {message && (
        <div className={[
          "mt-4 rounded-xl border px-3 py-2 text-xs flex items-center justify-between gap-3",
          message.type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700"
            : "border-rose-200 bg-rose-50 text-rose-700",
        ].join(" ")}>
          <span>{message.text}</span>
          {message.type === "error" && (
            <button
              type="button"
              onClick={() => { setLoading(true); setMessage(null); loadServices(); }}
              className="shrink-0 font-medium underline hover:no-underline"
            >
              Retry
            </button>
          )}
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
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Default Price</label>
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-slate-400">$</span>
              <input
                type="text"
                inputMode="decimal"
                value={form.price}
                onChange={(e) => setForm((p) => ({ ...p, price: e.target.value }))}
                className={inputCls + " pl-6"}
                placeholder="Optional — leave blank for no default price"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Color</label>
            <div className="flex items-center gap-2 flex-wrap">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  title={c.label}
                  onClick={() => setForm((p) => ({ ...p, color: c.hex }))}
                  className={[
                    "w-8 h-8 rounded-full border-2 transition-all",
                    form.color === c.hex ? "border-slate-900 scale-110" : "border-transparent hover:border-slate-300",
                  ].join(" ")}
                  style={{ backgroundColor: c.hex }}
                />
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <CapabilityGatedButton
              type="submit"
              allowed={canMutateOperationalData}
              disabled={saving}
              ariaDescribedBy={RESTRICTED_NOTICE_ID}
              className="rounded-xl bg-[#0f172a] px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving..." : editingId ? "Save Changes" : "Add Service"}
            </CapabilityGatedButton>
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
      <div className="mt-5 grid grid-cols-[auto_1fr_1fr_90px_80px_auto] gap-4 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-200">
        <div>Color</div>
        <div>Service Name</div>
        <div>Description</div>
        <div>Price</div>
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
                "grid grid-cols-[auto_1fr_1fr_90px_80px_auto] gap-4 items-center px-4 py-3 border-b border-slate-100 transition-colors",
                s.active ? "" : "opacity-50",
              ].join(" ")}
            >
              <div>
                <div className="w-5 h-5 rounded-full" style={{ backgroundColor: s.color ?? "#3B82F6" }} />
              </div>
              <div className={["text-sm font-medium", s.active ? "text-slate-900" : "text-slate-500 line-through"].join(" ")}>
                {s.name}
              </div>
              <div className="text-xs text-slate-500 truncate">
                {s.description || "—"}
              </div>
              <div className="text-xs text-slate-700">
                {formatCents(s.default_price_cents)}
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
                <CapabilityGatedButton
                  allowed={canMutateOperationalData}
                  onClick={() => startEdit(s)}
                  ariaDescribedBy={RESTRICTED_NOTICE_ID}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors flex items-center gap-1"
                >
                  <span className="text-[10px]">&#9998;</span> Edit
                </CapabilityGatedButton>
                <CapabilityGatedButton
                  allowed={canMutateOperationalData}
                  onClick={() => toggleActive(s)}
                  ariaDescribedBy={RESTRICTED_NOTICE_ID}
                  className={[
                    "rounded-lg border px-2.5 py-1 text-xs transition-colors flex items-center gap-1 disabled:opacity-50",
                    s.active
                      ? "border-rose-200 text-rose-600 hover:bg-rose-50"
                      : "border-emerald-200 text-emerald-600 hover:bg-emerald-50",
                  ].join(" ")}
                >
                  <span className="text-[10px]">{s.active ? "✘" : "✔"}</span>
                  {s.active ? "Disable" : "Enable"}
                </CapabilityGatedButton>
                {isTester && (
                  <CapabilityGatedButton
                    allowed={canMutateOperationalData}
                    onClick={() => handleDelete(s)}
                    ariaDescribedBy={RESTRICTED_NOTICE_ID}
                    className="rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs text-rose-700 hover:bg-rose-100 disabled:opacity-50 transition-colors flex items-center gap-1"
                  >
                    <span className="text-[10px]">🗑</span> Delete
                  </CapabilityGatedButton>
                )}
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
