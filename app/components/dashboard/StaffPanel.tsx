"use client";

import { useEffect, useState } from "react";
import { Employee } from "@/app/components/dashboard/types";
import { notifyDemoAction } from "@/app/components/demo-experience/demoExperienceBus";
import CapabilityGatedButton from "@/app/components/dashboard/CapabilityGatedButton";
import PasswordInput from "@/app/components/PasswordInput";
import { useRestrictedWording } from "@/app/components/dashboard/restrictedWording";
import { useEditBase } from "@/app/components/dashboard/editBase";
import { useSharedDraft, useSharedFlag } from "@/app/components/dashboard/sharedScreen";
import SharedEditNotice from "@/app/components/demo-session/SharedEditNotice";

// Phase 5.5E-E1F: one shared notice for this whole panel -- Add, per-row
// Edit/Deactivate-Reactivate (active and inactive lists alike), and the
// Add/Edit form's Save submit (including password changes, which flow
// through this same submit and the same server-enforced route) are all
// facets of the single "manage staff" task.
const RESTRICTED_NOTICE_ID = "staff-panel-restricted-notice";
const SEATS_NOTICE_ID = "staff-seats-notice";
const RESTRICTED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

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

export default function StaffPanel({
  isTester = false,
  canMutateOperationalData,
}: {
  isTester?: boolean;
  canMutateOperationalData: boolean;
}) {
  const restrictedWording = useRestrictedWording(RESTRICTED_WORDING);
  // Save requests carry when this edit began (Guided Demo Sessions only).
  // Which form is open: a record id, "new", or none -- shared on both
  // screens in a Guided Demo Session (sharedScreen.ts), local otherwise.
  const [localFormFor, setLocalFormFor] = useState<string | null>(null);
  const [formFor, setFormFor] = useSharedFlag("staffForm", localFormFor, setLocalFormFor);
  const sharedKey = formFor ? `ui:staffForm:${formFor}` : null;
  const editBase = useEditBase(sharedKey);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  // Employee seats (migrations/048): active employees count against the
  // workspace's allowance; the owner never does. null = not shown (tester
  // demo, or the allowance could not be read) -- the server still enforces it.
  const [seats, setSeats] = useState<{ used: number; allowance: number; available: number; ownerLinked?: boolean } | null>(null);
  // "This is me" (migrations/048): the record the owner is about to confirm
  // as their own. Nothing is linked until they confirm.
  const [confirmLinkFor, setConfirmLinkFor] = useState<Employee | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const editingId = formFor && formFor !== "new" ? formFor : null;
  const showAdd = formFor === "new";
  const [form, setForm] = useState<EditForm>(EMPTY_FORM);
  const sharedDraft = useSharedDraft({ key: sharedKey, label: editingId ? "the staff member form" : "the new staff member form", anchor: {}, fields: form, apply: setForm });
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

  function loadSeats() {
    if (isTester) return;
    fetch("/api/employees/seats")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        setSeats(data && typeof data.allowance === "number" && typeof data.used === "number" ? data : null);
      })
      .catch(() => setSeats(null));
  }

  // Once on mount: isTester (read by loadSeats) never changes for a mounted panel.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadEmployees(); loadSeats(); }, []);

  function startEdit(e: Employee) {
    // Defense-in-depth: the server route this eventually reaches (via
    // handleSave) already enforces this same capability before mutating
    // anything -- this guard additionally prevents the edit form itself
    // from ever opening for a restricted owner.
    if (!canMutateOperationalData) return;
    setFormFor(e.id);
    editBase.begin();
    const position = e.position ?? "";
    setForm({ name: e.name, phone: e.phone ?? "", email: (e as any).email ?? "", password: "", color: e.color, position });
    setOriginalColor(e.color);
    setShowCustomPosition(position !== "" && !POSITION_OPTIONS.includes(position));
    setMessage(null);
  }

  function startAdd() {
    if (!canMutateOperationalData) return;
    setFormFor("new");
    setForm(EMPTY_FORM);
    setShowCustomPosition(false);
    setMessage(null);
  }

  function cancelForm() {
    setFormFor(null);
    setForm(EMPTY_FORM);
    setOriginalColor(null);
    setShowCustomPosition(false);
  }

  async function handleSave(ev: React.FormEvent) {
    ev.preventDefault();
    if (!canMutateOperationalData) return;
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
      loadSeats();
    } catch {
      setMessage({ type: "error", text: "Network error." });
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(e: Employee) {
    if (!canMutateOperationalData) return;
    setMessage(null);
    try {
      const res = await fetch("/api/employees", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...editBase.headers() },
        body: JSON.stringify({ id: e.id, active: !e.active }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMessage({ type: "error", text: data?.error || "Toggle failed." });
        loadSeats();
        return;
      }
      setMessage({ type: "success", text: e.active ? "Employee deactivated." : "Employee reactivated." });
      loadEmployees();
      loadSeats();
    } catch {
      setMessage({ type: "error", text: "Network error." });
    }
  }

  // Links / unlinks the signed-in owner's own employee record. The server
  // links it to the signed-in owner's account only; this sends just the id.
  async function setOwnerLink(e: Employee, link: boolean) {
    if (!canMutateOperationalData) return;
    setMessage(null);
    try {
      const res = await fetch("/api/employees/owner-link", {
        method: link ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json", ...editBase.headers() },
        body: JSON.stringify({ employee_id: e.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ type: "error", text: data?.error || "Could not update your owner link." });
      } else {
        setMessage({ type: "success", text: link ? `${e.name} is marked as you. Your record doesn't use an employee seat.` : `${e.name} is no longer marked as you.` });
      }
    } catch {
      setMessage({ type: "error", text: "Network error." });
    } finally {
      setConfirmLinkFor(null);
      loadEmployees();
      loadSeats();
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
  const seatsFull = seats !== null && seats.available <= 0;
  const ownerLinked = employees.some((e) => e.is_you);
  // "This is me" is offered only to the owner (never the tester demo) while
  // no record is linked yet.
  const canOfferLink = !isTester && !ownerLinked;

  return (
    <div data-tour="employees-area" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">Staff / Team</div>
          <div className="mt-1 text-xs text-slate-500">Manage employees and assign them to appointments.</div>
          {seats && (
            <div id={SEATS_NOTICE_ID} data-testid="staff-seats" className="mt-2 text-xs text-slate-600" aria-live="polite">
              <span className="font-medium text-slate-900">Seats: {seats.used} of {seats.allowance} used</span>
              {" · "}
              {seatsFull ? (
                <span className="text-amber-700">All seats in use. Deactivate an employee to add or reactivate someone.</span>
              ) : (
                <span>{seats.available} available</span>
              )}
              {ownerLinked && <span className="text-slate-500">{" · "}You (owner) don&apos;t use a seat</span>}
            </div>
          )}
        </div>
        {!isTester && !showAdd && !editingId && (
          <CapabilityGatedButton
            allowed={canMutateOperationalData}
            onClick={startAdd}
            disabled={seatsFull}
            disabledReasonId={SEATS_NOTICE_ID}
            title={seatsFull ? "All employee seats are in use. Deactivate an employee to add someone." : undefined}
            ariaDescribedBy={RESTRICTED_NOTICE_ID}
            className="shrink-0 whitespace-nowrap rounded-xl bg-[#0f172a] px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-50 transition-colors"
          >
            + Add Employee
          </CapabilityGatedButton>
        )}
      </div>

      {!canMutateOperationalData && (
        <div id={RESTRICTED_NOTICE_ID} className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {restrictedWording}
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
              onClick={() => { setLoading(true); setMessage(null); loadEmployees(); }}
              className="shrink-0 font-medium underline hover:no-underline"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {confirmLinkFor && (
        <div data-testid="owner-link-confirm" className="mt-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-slate-700 max-w-xl">
          <div className="font-medium text-slate-900">Is {confirmLinkFor.name} you, the owner?</div>
          <div className="mt-1">
            Your own record can be assigned to jobs like anyone else, but it doesn&apos;t use one of your employee seats. Only you can be linked, and only one record.
          </div>
          <div className="mt-3 flex gap-2">
            <CapabilityGatedButton
              allowed={canMutateOperationalData}
              onClick={() => setOwnerLink(confirmLinkFor, true)}
              ariaDescribedBy={RESTRICTED_NOTICE_ID}
              className="rounded-lg bg-[#0f172a] px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              Yes, this is me
            </CapabilityGatedButton>
            <button type="button" onClick={() => setConfirmLinkFor(null)} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Add / Edit form */}
      {(showAdd || editingId) && (
        <>
        <SharedEditNotice draft={sharedDraft} />
        <form data-tour="employee-edit-form" onSubmit={handleSave} className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3 max-w-xl">
        <fieldset disabled={sharedDraft.readOnly} className="m-0 min-w-0 space-y-3 border-0 p-0">
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
              <PasswordInput
                value={form.password}
                onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))}
                autoComplete="new-password"
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
            <CapabilityGatedButton
              type="submit"
              allowed={canMutateOperationalData}
              disabled={saving}
              ariaDescribedBy={RESTRICTED_NOTICE_ID}
              className="rounded-xl bg-[#0f172a] px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving..." : editingId ? "Save Changes" : "Add Employee"}
            </CapabilityGatedButton>
            <button
              type="button"
              onClick={cancelForm}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-white transition-colors"
            >
              Cancel
            </button>
          </div>
        </fieldset>
        </form>
        </>
      )}

      {/* Table header */}
      <div className="mt-5 grid grid-cols-[auto_1fr_1fr_1fr_1fr_80px_12.5rem] gap-4 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-200">
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
              className="grid grid-cols-[auto_1fr_1fr_1fr_1fr_80px_12.5rem] gap-4 items-center px-4 py-3 border-b border-slate-100 transition-colors"
            >
              <div>
                <div className="w-5 h-5 rounded-full" style={{ backgroundColor: e.color }} />
              </div>
              <div className="text-sm font-medium text-slate-900">
                {e.name}
                {e.is_you && <OwnerBadge />}
              </div>
              <div className="text-xs text-slate-500">{e.position || "—"}</div>
              <div className="text-xs text-slate-500 truncate">{(e as any).email || "—"}</div>
              <div className="text-xs text-slate-500">{e.phone || "—"}</div>
              <div>
                <span className="text-[11px] font-medium px-2 py-0.5 rounded text-emerald-600 bg-emerald-50">
                  Active
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <CapabilityGatedButton
                  allowed={canMutateOperationalData}
                  onClick={() => startEdit(e)}
                  ariaDescribedBy={RESTRICTED_NOTICE_ID}
                  className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
                >
                  Edit
                </CapabilityGatedButton>
                <CapabilityGatedButton
                  allowed={canMutateOperationalData}
                  onClick={() => toggleActive(e)}
                  ariaDescribedBy={RESTRICTED_NOTICE_ID}
                  className="rounded-lg border border-rose-200 px-2.5 py-1 text-xs text-rose-600 hover:bg-rose-50 disabled:opacity-50 transition-colors"
                >
                  Deactivate
                </CapabilityGatedButton>
                {(e.is_you || canOfferLink) && (
                  <CapabilityGatedButton
                    allowed={canMutateOperationalData}
                    onClick={() => (e.is_you ? setOwnerLink(e, false) : setConfirmLinkFor(e))}
                    ariaDescribedBy={RESTRICTED_NOTICE_ID}
                    className="whitespace-nowrap rounded-lg px-1.5 py-1 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-50 transition-colors"
                  >
                    {e.is_you ? "Not me" : "This is me"}
                  </CapabilityGatedButton>
                )}
              </div>
            </div>
          ))}

          {/* Inactive employees */}
          {inactiveEmployees.length > 0 && (
            <>
              <div className="px-4 pt-4 pb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Inactive
                {seatsFull && (
                  <span className="ml-2 normal-case tracking-normal font-normal text-amber-700">
                    Reactivating needs a free seat.
                  </span>
                )}
              </div>
              {inactiveEmployees.map((e) => (
                <div
                  key={e.id}
                  className="grid grid-cols-[auto_1fr_1fr_1fr_1fr_80px_12.5rem] gap-4 items-center px-4 py-3 border-b border-slate-100 opacity-50 transition-colors"
                >
                  <div>
                    <div className="w-5 h-5 rounded-full" style={{ backgroundColor: e.color }} />
                  </div>
                  <div className="text-sm font-medium text-slate-500">
                    <span className="line-through">{e.name}</span>
                    {e.is_you && <OwnerBadge />}
                  </div>
                  <div className="text-xs text-slate-400">{e.position || "—"}</div>
                  <div className="text-xs text-slate-400 truncate">{(e as any).email || "—"}</div>
                  <div className="text-xs text-slate-400">{e.phone || "—"}</div>
                  <div>
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded text-rose-600 bg-rose-50">
                      Inactive
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <CapabilityGatedButton
                      allowed={canMutateOperationalData}
                      onClick={() => startEdit(e)}
                      ariaDescribedBy={RESTRICTED_NOTICE_ID}
                      className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors"
                    >
                      Edit
                    </CapabilityGatedButton>
                    <CapabilityGatedButton
                      allowed={canMutateOperationalData}
                      disabled={seatsFull && !e.is_you}
                      disabledReasonId={SEATS_NOTICE_ID}
                      title={seatsFull && !e.is_you ? "All employee seats are in use. Deactivate an employee to reactivate this one." : undefined}
                      onClick={() => toggleActive(e)}
                      ariaDescribedBy={RESTRICTED_NOTICE_ID}
                      className="rounded-lg border border-emerald-200 px-2.5 py-1 text-xs text-emerald-600 hover:bg-emerald-50 disabled:opacity-50 transition-colors"
                    >
                      Reactivate
                    </CapabilityGatedButton>
                    {(e.is_you || canOfferLink) && (
                      <CapabilityGatedButton
                        allowed={canMutateOperationalData}
                        onClick={() => (e.is_you ? setOwnerLink(e, false) : setConfirmLinkFor(e))}
                        ariaDescribedBy={RESTRICTED_NOTICE_ID}
                        className="whitespace-nowrap rounded-lg px-1.5 py-1 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-50 transition-colors"
                      >
                        {e.is_you ? "Not me" : "This is me"}
                      </CapabilityGatedButton>
                    )}
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

// The owner's own employee record (migrations/048): assignable to jobs, no seat.
function OwnerBadge() {
  return (
    <span data-testid="owner-badge" className="mt-0.5 block w-fit whitespace-nowrap text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 no-underline">
      You · owner · no seat
    </span>
  );
}
