"use client";

// Owner-only "Adjust Worked Time" correction control -- payroll fix for the
// case where automatic Job Tracking is wrong (e.g. an employee forgot to
// clock out). A plain .ts file using React.createElement, not JSX, for the
// same structural reason CapabilityGatedButton.ts/EmployeeJobActionButton.ts
// are: Node's built-in test runner cannot load a .tsx file at all, and this
// is exactly the kind of control that needs real rendered click/keyboard
// interaction proof (Clock-in/Clock-out/Reason entry, Save, Cancel, error
// states) rather than source inspection.
//
// This is deliberately separate from DispatchPanel's own EmployeeHoursSection
// (the pre-existing "no worked-hours source yet" entry form): that form's
// job is unchanged by this feature. This control is only ever shown once a
// worked-hours value already exists (tracked or previously manually
// entered) -- it is the CORRECTION/REVIEW path, not the first-entry path.
//
// Two distinct owner actions, both writing the SAME appointment_employee_hours
// row shape (hours_worked + note -- no new column, no API change):
//
//   - "Correct Time" (mode "correct"): the tracked duration is WRONG. The
//     owner corrects the WORKING INTERVAL (Clock-in / Clock-out), not a
//     duration directly -- SFT computes the payable duration from the two
//     times. Both fields default to the ORIGINAL tracked actual_started_at/
//     actual_completed_at (converted to the workspace's local wall-clock
//     time), when there is one, so the owner is nudging a real interval
//     rather than reconstructing it from scratch. The two corrected clock
//     times themselves are NOT persisted anywhere -- see
//     computeCorrectedHours' own doc comment below for why -- only the
//     computed duration and the reason are sent.
//   - "Keep Time As Is" (mode "keep"): the tracked duration is CORRECT (e.g.
//     the job legitimately ran long) -- the owner is confirming it, not
//     changing it. Only a reason is asked for; the duration sent is exactly
//     the current tracked duration (see computeKeepAsIsHours below), so
//     Weekly Worked Hours is unaffected. This is what turns "Needs Review"
//     into "Reviewed by owner" without pretending a correction happened.
//
// "Correct Time" / "Keep Time As Is" are only offered as a pair when this
// employee's current worked time is flagged (needsReview) -- otherwise this
// renders the original single "Adjust Worked Time" button (opens the
// Correct Time form directly), unchanged from before Keep Time As Is
// existed. Either action clears "Needs Review" the moment it saves, because
// needsWorkedTimeReview (lib/payroll.ts) treats the mere EXISTENCE of an
// appointment_employee_hours row as "already reviewed by the owner",
// regardless of which action produced it or what value it holds.
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
import { zonedTimeValue, zonedDateTimeToUTC } from "@/lib/timezone";
import { trackedMinutes } from "@/lib/payroll";

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
  // The workspace's own resolved timezone -- Clock-in/Clock-out are entered
  // and interpreted in this zone, never the browser/device's ambient one
  // (same convention as every other date/time field in this codebase; see
  // lib/timezone.ts).
  timezone: string;
  // The business-local calendar date ("YYYY-MM-DD") Clock-in and Clock-out
  // are both ON -- normally the appointment's own scheduled date. A
  // same-day interval only; this control does not support a shift that
  // crosses midnight (Clock-out must be later the SAME day).
  anchorDate: string;
  // The assignment's own original actual_started_at/actual_completed_at
  // (ISO, or null/undefined when never tracked) -- used to pre-fill
  // Clock-in/Clock-out with a sensible starting point for "Correct Time",
  // and as the source duration for "Keep Time As Is" (computeKeepAsIsHours
  // below). Never read again after save, and never written back to --
  // preserved exactly as-is by this control, which writes only to
  // appointment_employee_hours.
  initialStartedAt?: string | null;
  initialCompletedAt?: string | null;
  // True when this employee's current worked time is flagged by
  // needsWorkedTimeReview (lib/payroll.ts) -- purely presentational. False
  // (the default) renders the original single "Adjust Worked Time" button.
  // True additionally offers "Keep Time As Is" alongside "Correct Time", so
  // the owner can confirm a legitimately long/short job instead of having
  // to pretend it's a correction.
  needsReview?: boolean;
};

function field(label: string, input: ReactNode) {
  return createElement(
    "div",
    { className: "flex items-center gap-2" },
    createElement("label", { className: "text-[11px] text-slate-500 shrink-0 w-16" }, label),
    input
  );
}

// Resolves Clock-in + Clock-out (workspace-local "HH:mm", both on
// `anchorDate`) to a payable duration in decimal hours, or an error.
//
// Why the corrected clock-in/clock-out pair itself is NOT persisted:
// appointment_employee_hours (the owner-override table) has exactly two
// relevant columns, hours_worked and note (migrations/010) -- there is no
// column to hold a second timestamp pair, and the owner's actual payroll
// value is the DURATION, not the specific clock times. Adding two new
// columns for this would be new schema for a value that is fully
// recoverable from -- and only ever used to produce -- the duration
// already being stored; the existing `note` (the required reason) already
// gives the owner room to record the specific correction in their own
// words, exactly as the very first review of this feature's Roxana example
// did ("Forgot to clock out. Job completed at 10:32 AM."). If a future
// phase needs the exact corrected instants preserved (e.g. for a payroll
// audit export), that is a deliberate, separate schema decision -- not
// something to add quietly here.
export function computeCorrectedHours(
  clockIn: string,
  clockOut: string,
  anchorDate: string,
  timezone: string
): { ok: true; hours: number } | { ok: false; error: string } {
  if (!clockIn || !clockOut) {
    return { ok: false, error: "Enter both a clock-in and a clock-out time." };
  }
  const inResult = zonedDateTimeToUTC(anchorDate, clockIn, timezone);
  if (!inResult.ok) return { ok: false, error: inResult.error };
  const outResult = zonedDateTimeToUTC(anchorDate, clockOut, timezone);
  if (!outResult.ok) return { ok: false, error: outResult.error };

  const startMs = new Date(inResult.iso).getTime();
  const endMs = new Date(outResult.iso).getTime();
  if (endMs <= startMs) {
    return { ok: false, error: "Clock-out must be after clock-in." };
  }
  return { ok: true, hours: (endMs - startMs) / 3_600_000 };
}

// Resolves the SAME duration currently in effect via Job Tracking, for
// "Keep Time As Is" -- the owner is confirming the tracked interval is
// correct, not changing it, so this reads the exact original
// actual_started_at/actual_completed_at pair (the same one Correct Time
// pre-fills Clock-in/Clock-out from) via trackedMinutes (lib/payroll.ts),
// rather than asking the owner to re-enter anything. In practice this is
// only reachable once needsReview is true, which itself (per
// needsWorkedTimeReview's own short-circuit on an existing
// appointment_employee_hours row) means there is no prior owner entry yet
// and Job Tracking is therefore complete -- but this still returns a real
// error instead of silently sending "0h" in the defensive case where that
// somehow isn't true.
export function computeKeepAsIsHours(
  initialStartedAt: string | null | undefined,
  initialCompletedAt: string | null | undefined
): { ok: true; hours: number } | { ok: false; error: string } {
  const tracked = trackedMinutes({
    actual_started_at: initialStartedAt ?? null,
    actual_completed_at: initialCompletedAt ?? null,
  });
  if (tracked === null) {
    return { ok: false, error: "No tracked time to confirm." };
  }
  return { ok: true, hours: tracked / 60 };
}

export default function AdjustWorkedTimeControl({
  appointmentId,
  employeeId,
  canCorrect,
  onSaved,
  timezone,
  anchorDate,
  initialStartedAt,
  initialCompletedAt,
  needsReview = false,
}: AdjustWorkedTimeControlProps) {
  // Self-contained (per DispatchPanel's own EmployeeHoursSection precedent
  // right above in this same file's history) rather than a shared/global
  // notice -- this control can appear more than once at a time (one per
  // assigned employee), so each instance renders and points at its own
  // notice element instead of depending on some other component instance
  // happening to be mounted.
  const noticeId = `adjust-worked-time-restricted-${appointmentId}-${employeeId}`;
  const initialClockIn = initialStartedAt ? zonedTimeValue(initialStartedAt, timezone) : "";
  const initialClockOut = initialCompletedAt ? zonedTimeValue(initialCompletedAt, timezone) : "";
  // "closed" -- collapsed, showing only the button(s). "correct" -- the
  // Clock-in/Clock-out/Reason form (the tracked time is wrong). "keep" --
  // the Reason-only form (the tracked time is right, confirm it as-is).
  const [mode, setMode] = useState<"closed" | "correct" | "keep">("closed");
  const [clockIn, setClockIn] = useState(initialClockIn);
  const [clockOut, setClockOut] = useState(initialClockOut);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function reset() {
    setClockIn(initialClockIn);
    setClockOut(initialClockOut);
    setReason("");
    setError("");
  }

  async function save() {
    // Defense-in-depth: the server route this reaches already enforces this
    // same capability (and requireOwner) before mutating anything -- this
    // guard only prevents a restricted owner's client from ever issuing the
    // request at all.
    if (!canCorrect) return;

    let hours: number;
    if (mode === "keep") {
      const computed = computeKeepAsIsHours(initialStartedAt, initialCompletedAt);
      if (!computed.ok) {
        setError(computed.error);
        return;
      }
      hours = computed.hours;
    } else {
      const computed = computeCorrectedHours(clockIn, clockOut, anchorDate, timezone);
      if (!computed.ok) {
        setError(computed.error);
        return;
      }
      hours = computed.hours;
    }
    if (!reason.trim()) {
      setError(
        mode === "keep"
          ? "A reason is required to confirm this time (e.g. used new equipment, job legitimately took longer)."
          : "A reason is required (e.g. forgot to clock out)."
      );
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
          // "correct" mode: the corrected CLOCK TIMES are only ever used
          // locally to compute this decimal-hours value -- see
          // computeCorrectedHours above for why the interval itself is not
          // sent or stored. "keep" mode: this is exactly the existing
          // tracked duration (computeKeepAsIsHours) -- Weekly Worked Hours
          // is unaffected by saving it.
          hours_worked: hours,
          note: reason.trim(),
        }),
      });
      const data: { entry?: EmployeeHours; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || !data.entry) {
        setError(data?.error || "Save failed.");
        return;
      }
      onSaved(data.entry);
      setMode("closed");
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

  if (mode === "closed") {
    if (needsReview) {
      // Flagged: offer both owner actions side by side, per spec. Neither
      // pre-judges which one the owner will pick -- "Correct Time" opens
      // the same interval-correction form as the plain button below;
      // "Keep Time As Is" opens a reason-only confirmation.
      return createElement(
        Fragment,
        null,
        createElement(
          "div",
          { className: "flex items-center gap-3" },
          createElement(
            CapabilityGatedButton,
            {
              type: "button",
              allowed: canCorrect,
              ariaDescribedBy: noticeId,
              onClick: () => setMode("correct"),
              className: "text-[11px] font-medium text-blue-600 hover:text-blue-700",
            },
            "Correct Time"
          ),
          createElement(
            CapabilityGatedButton,
            {
              type: "button",
              allowed: canCorrect,
              ariaDescribedBy: noticeId,
              onClick: () => setMode("keep"),
              className: "text-[11px] font-medium text-emerald-700 hover:text-emerald-800",
            },
            "✓ Keep Time As Is"
          )
        ),
        restrictedNotice
      );
    }
    return createElement(
      Fragment,
      null,
      createElement(
        CapabilityGatedButton,
        {
          type: "button",
          allowed: canCorrect,
          ariaDescribedBy: noticeId,
          onClick: () => setMode("correct"),
          className: "text-[11px] font-medium text-blue-600 hover:text-blue-700",
        },
        "Adjust Worked Time"
      ),
      restrictedNotice
    );
  }

  function cancel() {
    setMode("closed");
    reset();
  }

  if (mode === "keep") {
    return createElement(
      "div",
      { className: "rounded-lg border border-slate-200 bg-white px-2 py-2 space-y-1.5 mt-1" },
      restrictedNotice,
      field(
        "Reason",
        createElement("input", {
          type: "text",
          value: reason,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setReason(e.target.value),
          placeholder: "e.g. used new equipment, job legitimately took longer",
          disabled: !canCorrect,
          "aria-label": "Review reason",
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
          saving ? "Saving..." : "Confirm Time"
        ),
        createElement(
          "button",
          {
            type: "button",
            onClick: cancel,
            disabled: saving,
            className: "rounded-lg border border-slate-300 px-3 py-1 text-[11px] text-slate-700 hover:bg-slate-50 disabled:opacity-50",
          },
          "Cancel"
        )
      )
    );
  }

  return createElement(
    "div",
    { className: "rounded-lg border border-slate-200 bg-white px-2 py-2 space-y-1.5 mt-1" },
    restrictedNotice,
    field(
      "Clock-in",
      createElement("input", {
        type: "time",
        value: clockIn,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setClockIn(e.target.value),
        disabled: !canCorrect,
        "aria-label": "Corrected clock-in time",
        className: "rounded-lg border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50",
      })
    ),
    field(
      "Clock-out",
      createElement("input", {
        type: "time",
        value: clockOut,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setClockOut(e.target.value),
        disabled: !canCorrect,
        "aria-label": "Corrected clock-out time",
        className: "rounded-lg border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50",
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
          onClick: cancel,
          disabled: saving,
          className: "rounded-lg border border-slate-300 px-3 py-1 text-[11px] text-slate-700 hover:bg-slate-50 disabled:opacity-50",
        },
        "Cancel"
      )
    )
  );
}
