"use client";

import { useEffect, useState } from "react";
import { Employee } from "@/app/components/dashboard/types";
import { notifyDemoAction } from "@/app/components/demo-experience/demoExperienceBus";

const PRESET_COLORS = [
  { hex: "#3B82F6", label: "Blue" },
  { hex: "#22C55E", label: "Green" },
  { hex: "#F97316", label: "Orange" },
  { hex: "#EF4444", label: "Red" },
  { hex: "#8B5CF6", label: "Purple" },
  { hex: "#EC4899", label: "Pink" },
  { hex: "#14B8A6", label: "Teal" },
  { hex: "#F59E0B", label: "Amber" },
];

const POSITION_OPTIONS = ["Owner", "Manager", "Cleaner", "Technician", "Helper"];
const CUSTOM_POSITION = "__custom__";

type EditForm = { name: string; phone: string; email: string; password: string; color: string; position: string };
const EMPTY_FORM: EditForm = { name: "", phone: "", email: "", password: "", color: PRESET_COLORS[0].hex, position: "" };

export default function StaffPanel({ isTester = false }: { isTester?: boolean }) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<EditForm>(EMPTY_FORM);
  const [originalColor, setOriginalColor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Tracked separately from form.position because a not-yet-typed custom
  // position is an empty string — indistinguishable from "no position" —
  // so the select's own mode can't be inferred from the text alone.
  const [showCustomPosition, setShowCustomPosition] = useState(false);

  function loadEmployees() {
    fetch("/api/employees")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setEmployees(data);
        else if (data.error) setMessage({ type: "error", text: data.error });
      })
      .catch(() => setMessage({ type: "error", text: "Failed to load staff." }))
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadEmployees(); }, []);

  function startEdit(e: Employee) {
    setEditingId(e.id);
    setShowAdd(false);
    const position = e.position ?? "";
    setForm({ name: e.name, phone: e.phone ?? "", email: (e as any).email ?? "", password: "", color: e.color, position });
    setOriginalColor(e.color);
    setShowCustomPosition(position !== "" && !POSITION_OPTIONS.includes(position));
    setMessage(null);
  }

  function startAdd() {
    setEditingId(null);
    setShowAdd(true);
    setForm(EMPTY_FORM);
    setShowCustomPosition(false);
    setMessage(null);
  }

  function cancelForm() {
    setEditingId(null);
    setShowAdd(false);
    setForm(EMPTY_FORM);
    setOriginalColor(null);
    setShowCustomPosition(false);
  }

  async function handleSave(ev: React.FormEvent) {
    ev.preventDefault();
    if (!form.name.trim()) { setMessage({ type: "error", text: "Employee name is required." }); return; }

    setSaving(true);
    setMessage(null);

    try {
      const isEdit = !!editingId;
      const res = await fetch("/api/employees", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isEdit
            ? { id: editingId, name: form.name.trim(), phone: form.phone.trim(), email: form.email.trim(), color: form.color, position: form.position, ...(form.password.trim() ? { password: form.password.trim() } : {}) }
            : { name: form.name.trim(), phone: form.phone.trim(), email: form.email.trim(), color: form.color, position: form.position, ...(form.password.trim() ? { password: form.password.trim() } : {}) }
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMessage({ type: "error", text: data?.error || "Save failed." }); return; }

      if (isEdit && originalColor !== null && form.color !== originalColor) {
        notifyDemoAction("change-employee-color");
      }
      setMessage({ type: "success", text: isEdit ? "Employee updated." : "Employee added." });
      cancelForm();
      loadEmployees();
    } catch {
      setMessage({ type: "error", text: "Network error." });
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(e: Employee) {
    setMessage(null);
    try {
      const res = await fetch("/api/employees", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: e.id, active: !e.active }),
      });
      if (!res.ok) { setMessage({ type: "error", text: "Toggle failed." }); return; }
      setMessage({ type: "success", text: e.active ? "Employee deactivated." : "Employee reactivated." });
      loadEmployees();
    } catch {
      setMessage({ type: "error", text: "Network error." });
    }
  }

  const inputCls =
    "w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500";

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-sm text-slate-500">Loading staff...</div>
      </div>
    );
  }

  const activeEmployees = employees.filter((e) => e.active);
  const inactiveEmployees = employees.filter((e) => !e.active);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">Staff / Team</div>
          <div className="mt-1 text-xs text-slate-500">Manage employees and assign them to appointments.</div>
        </div>
        {!isTester && !showAdd && !editingId && (
          <button
            onClick={startAdd}
            className="rounded-xl bg-[#0f172a] px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 transition-colors"
          >
            + Add Employee
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
        <form data-tour="employee-edit-form" onSubmit={handleSave} className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3 max-w-xl">
          <div className="text-xs font-semibold text-slate-700">
            {editingId ? "Edit Employee" : "New Employee"}
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Name *</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              className={inputCls}
              placeholder="e.g. Maria"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Phone</label>
            <input
              type="tel"
              value={form.phone}
              onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
              className={inputCls}
              placeholder="Optional"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Position</label>
            <select
              value={showCustomPosition ? CUSTOM_POSITION : form.position}
              onChange={(e) => {
                const val = e.target.value;
                if (val === CUSTOM_POSITION) {
                  setShowCustomPosition(true);
                  setForm((p) => ({ ...p, position: POSITION_OPTIONS.includes(p.position) ? "" : p.position }));
                } else {
                  setShowCustomPosition(false);
                  setForm((p) => ({ ...p, position: val }));
                }
              }}
              className={inputCls}
            >
              <option value="">—</option>
              {POSITION_OPTIONS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
              <option value={CUSTOM_POSITION}>+ Custom Position...</option>
            </select>
            {showCustomPosition && (
              <input
                type="text"
                value={form.position}
                onChange={(e) => setForm((p) => ({ ...p, position: e.target.value }))}
                className={inputCls + " mt-2"}
                placeholder="Enter custom position"
              />
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                className={inputCls}
                placeholder="employee@company.com"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Password{editingId ? "" : " *"}</label>
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
                className={inputCls}
                placeholder={editingId ? "Leave blank to keep current" : "Set password"}
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Color</label>
            <div data-tour="employee-color-swatch" className="flex items-center gap-2 flex-wrap">
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
            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-[#0f172a] px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving..." : editingId ? "Save Changes" : "Add Employee"}
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
      <div className="mt-5 grid grid-cols-[auto_1fr_1fr_1fr_1fr_80px_auto] gap-4 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-200">
        <div>Color</div>
        <div>Name</div>
        <div>Position</div>
        <div>Email</div>
        <div>Phone</div>
        <div>Status</div>
        <div>Actions</div>
      </div>

      {/* Active employees */}
      {activeEmployees.length === 0 && inactiveEmployees.length === 0 ? (
        <div className="text-sm text-slate-400 py-6 text-center">No employees yet. Add your first team member above.</div>
      ) : (
        <>
          {activeEmployees.map((e) => (
            <div
              key={e.id}
              className="grid grid-cols-[auto_1fr_1fr_1fr_1fr_80px_auto] gap-4 items-center px-4 py-3 border-b border-slate-100 transition-colors"
            >
              <div>
                <div className="w-5 h-5 rounded-full" style={{ backgroundColor: e.color }} />
              </div>
              <div className="text-sm font-medium text-slate-900">{e.name}</div>
              <div className="text-xs text-slate-500">{e.position || "—"}</div>
              <div className="text-xs text-slate-500 truncate">{(e as any).email || "—"}</div>
              <div className="text-xs text-slate-500">{e.phone || "—"}</div>
              <div>
                <span className="text-[11px] font-medium px-2 py-0.5 rounded text-emerald-600 bg-emerald-50">
                  Active
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => startEdit(e)}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  Edit
                </button>
                <button
                  onClick={() => toggleActive(e)}
                  className="rounded-lg border border-rose-200 px-2.5 py-1 text-xs text-rose-600 hover:bg-rose-50 transition-colors"
                >
                  Deactivate
                </button>
              </div>
            </div>
          ))}

          {/* Inactive employees */}
          {inactiveEmployees.length > 0 && (
            <>
              <div className="px-4 pt-4 pb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Inactive
              </div>
              {inactiveEmployees.map((e) => (
                <div
                  key={e.id}
                  className="grid grid-cols-[auto_1fr_1fr_1fr_1fr_80px_auto] gap-4 items-center px-4 py-3 border-b border-slate-100 opacity-50 transition-colors"
                >
                  <div>
                    <div className="w-5 h-5 rounded-full" style={{ backgroundColor: e.color }} />
                  </div>
                  <div className="text-sm font-medium text-slate-500 line-through">{e.name}</div>
                  <div className="text-xs text-slate-400">{e.position || "—"}</div>
                  <div className="text-xs text-slate-400 truncate">{(e as any).email || "—"}</div>
                  <div className="text-xs text-slate-400">{e.phone || "—"}</div>
                  <div>
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded text-rose-600 bg-rose-50">
                      Inactive
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => startEdit(e)}
                      className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => toggleActive(e)}
                      className="rounded-lg border border-emerald-200 px-2.5 py-1 text-xs text-emerald-600 hover:bg-emerald-50 transition-colors"
                    >
                      Reactivate
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      )}

      {/* Footer */}
      <div className="mt-3 px-4 text-xs text-slate-500">
        {activeEmployees.length} active, {inactiveEmployees.length} inactive
      </div>
    </div>
  );
}
