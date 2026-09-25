"use client";

// Owner-only "Adjust Worked Time" correction control -- payroll fix for the
// case where automatic Job Tracking is wrong (e.g. an employee forgot to
// clock out). A plain .ts file using React.createElement, not JSX, for the
// same structural reason CapabilityGatedButton.ts/EmployeeJobActionButton.ts
// are: Node's built-in test runner cannot load a .tsx file at all, and this
// is exactly the kind of control that needs real rendered click/keyboard
// interaction proof (Hours/Minutes/Reason entry, Save, Cancel, error
// states) rather than source inspection.
//
// This is deliberately separate from DispatchPanel's own EmployeeHoursSection
// (the pre-existing "no worked-hours source yet" entry form): that form's
// job is unchanged by this feature. This control is only ever shown once a
// worked-hours value already exists (tracked or previously manually
// entered) -- it is the CORRECTION path, not the first-entry path.
//
// Posts to the existing /api/appointments/employee-hours route
// (save_employee_hours, migrations/030 + 031) -- the same endpoint the
// missing-hours form already used. The only behavioral difference from a
// first-time manual entry is that this may now succeed even when Job
// Tracking is already complete, which the database function allows
// specifically because that route is already owner-only
// (requireOwner) -- see migrations/031's header. Nothing here ever touches
// appointment_employees.actual_started_at/actual_completed_at; only the
// server route below can write appointment_employee_hours at all.
import { createElement, Fragment, useState, type ReactNode } from "react";
import type { EmployeeHours } from "@/app/components/dashboard/types";
import CapabilityGatedButton from "@/app/components/dashboard/CapabilityGatedButton";

// Rendered next to the button/form whenever restricted, in both the
// collapsed and expanded states -- so CapabilityGatedButton's
// aria-describedby always resolves to a real element, not only while the
// form happens to be open. Same neutral wording every other capability
// notice in this codebase uses.
const RESTRICTED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

export type AdjustWorkedTimeControlProps = {
  appointmentId: string;
  employeeId: string;
  // The owner capability gate (canUseJobTracking) -- identical to the one
  // DispatchPanel's own EmployeeHoursSection already uses for the same
  // server route. The server-side gate remains the sole security boundary;
  // this only decides whether the client even attempts the request.
  canCorrect: boolean;
  onSaved: (entry: EmployeeHours) => void;
};

function field(label: string, input: ReactNode) {
  return createElement(
    "div",
    { className: "flex items-center gap-2" },
    createElement("label", { className: "text-[11px] text-slate-500 shrink-0 w-14" }, label),
    input
  );
}

export default function AdjustWorkedTimeControl({
  appointmentId,
  employeeId,
  canCorrect,
  onSaved,
}: AdjustWorkedTimeControlProps) {
  // Self-contained (per DispatchPanel's own EmployeeHoursSection precedent
  // right above in this same file's history) rather than a shared/global
  // notice -- this control can appear more than once at a time (one per
  // assigned employee), so each instance renders and points at its own
  // notice element instead of depending on some other component instance
  // happening to be mounted.
  const noticeId = `adjust-worked-time-restricted-${appointmentId}-${employeeId}`;
  const [open, setOpen] = useState(false);
  const [hoursPart, setHoursPart] = useState("");
  const [minutesPart, setMinutesPart] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function reset() {
    setHoursPart("");
    setMinutesPart("");
    setReason("");
    setError("");
  }

  async function save() {
    // Defense-in-depth: the server route this reaches already enforces this
    // same capability (and requireOwner) before mutating anything -- this
    // guard only prevents a restricted owner's client from ever issuing the
    // request at all.
    if (!canCorrect) return;
    const h = hoursPart.trim() === "" ? 0 : Number(hoursPart);
    const m = minutesPart.trim() === "" ? 0 : Number(minutesPart);
    if (!Number.isFinite(h) || h < 0 || !Number.isFinite(m) || m < 0 || m > 59 || (h === 0 && m === 0)) {
      setError("Enter a corrected time greater than 0 (hours and/or minutes, minutes 0-59).");
      return;
    }
    if (!reason.trim()) {
      setError("A reason is required (e.g. forgot to clock out).");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/appointments/employee-hours", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appointment_id: appointmentId,
          employee_id: employeeId,
          // Hours + Minutes -> the decimal-hours value the existing route/
          // column (NUMERIC(5,2)) already expects -- no API or schema change.
          hours_worked: h + m / 60,
          note: reason.trim(),
        }),
      });
      const data: { entry?: EmployeeHours; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !data.entry) {
        setError(data?.error || "Save failed.");
        return;
      }
      onSaved(data.entry);
      setOpen(false);
      reset();
    } catch {
      setError("Network error.");
    } finally {
      setSaving(false);
    }
  }

  const restrictedNotice = canCorrect
    ? null
    : createElement("div", { id: noticeId, className: "text-[11px] text-slate-500 mt-0.5" }, RESTRICTED_WORDING);

  if (!open) {
    return createElement(
      Fragment,
      null,
      createElement(
        CapabilityGatedButton,
        {
          type: "button",
          allowed: canCorrect,
          ariaDescribedBy: noticeId,
          onClick: () => setOpen(true),
          className: "text-[11px] font-medium text-blue-600 hover:text-blue-700",
        },
        "Adjust Worked Time"
      ),
      restrictedNotice
    );
  }

  return createElement(
    "div",
    { className: "rounded-lg border border-slate-200 bg-white px-2 py-2 space-y-1.5 mt-1" },
    restrictedNotice,
    field(
      "Hours",
      createElement("input", {
        type: "number",
        min: "0",
        step: "1",
        value: hoursPart,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setHoursPart(e.target.value),
        placeholder: "0",
        disabled: !canCorrect,
        "aria-label": "Corrected hours",
        className: "w-16 rounded-lg border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50",
      })
    ),
    field(
      "Minutes",
      createElement("input", {
        type: "number",
        min: "0",
        max: "59",
        step: "1",
        value: minutesPart,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setMinutesPart(e.target.value),
        placeholder: "0",
        disabled: !canCorrect,
        "aria-label": "Corrected minutes",
        className: "w-16 rounded-lg border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50",
      })
    ),
    field(
      "Reason",
      createElement("input", {
        type: "text",
        value: reason,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setReason(e.target.value),
        placeholder: "e.g. forgot to clock out",
        disabled: !canCorrect,
        "aria-label": "Correction reason",
        className: "flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50",
      })
    ),
    error ? createElement("div", { className: "text-[11px] text-rose-700 bg-rose-50 rounded px-2 py-1" }, error) : null,
    createElement(
      "div",
      { className: "flex gap-2" },
      createElement(
        CapabilityGatedButton,
        {
          type: "button",
          allowed: canCorrect,
          disabled: saving,
          ariaDescribedBy: noticeId,
          onClick: save,
          className: "rounded-lg bg-slate-900 px-3 py-1 text-[11px] font-medium text-white hover:bg-slate-800 disabled:opacity-50 transition-colors",
        },
        saving ? "Saving..." : "Save Correction"
      ),
      createElement(
        "button",
        {
          type: "button",
          onClick: () => {
            setOpen(false);
            reset();
          },
          disabled: saving,
          className: "rounded-lg border border-slate-300 px-3 py-1 text-[11px] text-slate-700 hover:bg-slate-50 disabled:opacity-50",
        },
        "Cancel"
      )
    )
  );
}
