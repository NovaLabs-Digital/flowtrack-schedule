"use client";

import { useEffect, useState } from "react";
import { Appointment, AppointmentEmployeeAssignment } from "@/app/components/dashboard/types";
import { computeIncomeProjection, formatProjectedIncome } from "@/lib/incomeProjection";

// SFT-specific key, matching the sft_... prefix convention already used by
// app/components/demo-experience/useDemoExperience.ts. UI privacy only --
// never read or written by any server route, never a company_settings
// column; purely a per-browser preference for whoever is looking at this
// device's dashboard.
const VISIBILITY_STORAGE_KEY = "sft_income_projection_hidden";
const MASK = "••••••";

export default function IncomeProjection({
  appointments,
  assignments,
  rangeStart,
  rangeEnd,
}: {
  appointments: Appointment[];
  assignments: AppointmentEmployeeAssignment[];
  rangeStart: string;
  rangeEnd: string;
}) {
  const [hidden, setHidden] = useState(false);
  // Never read localStorage during the initial render (SSR has no
  // window, and a lazy useState initializer would run during hydration
  // too, before the client and server markup are guaranteed to match) --
  // read once in an effect after mount, matching useDemoExperience.ts's
  // established hydration-safe pattern exactly. Writes are gated behind
  // this same flag so the initial read is never immediately overwritten by
  // its own effect running before the read completes.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem(VISIBILITY_STORAGE_KEY);
    if (saved === "true") setHidden(true);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (hidden) window.localStorage.setItem(VISIBILITY_STORAGE_KEY, "true");
    else window.localStorage.removeItem(VISIBILITY_STORAGE_KEY);
  }, [hidden, hydrated]);

  const { estimatedIncomeCents, estimatedWorkHours } = computeIncomeProjection({
    appointments,
    assignments,
    rangeStart,
    rangeEnd,
  });

  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 shadow-sm p-4 shrink-0">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-emerald-900">Projected Revenue</div>
        <button
          type="button"
          onClick={() => setHidden((h) => !h)}
          aria-label={hidden ? "Show projected revenue" : "Hide projected revenue"}
          aria-pressed={hidden}
          title={hidden ? "Show projected revenue" : "Hide projected revenue"}
          className="text-sm leading-none text-emerald-700 hover:text-emerald-900 transition-colors"
        >
          {hidden ? "\u{1F648}" : "\u{1F441}️"}
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <div className="text-[11px] text-emerald-700">Estimated Revenue</div>
          {/* Conditionally rendered, not CSS-hidden -- when hidden, the real
              formatted value is never present in the DOM at all, so it
              can't be read via view-source or dev tools. */}
          <div className="text-base font-semibold text-emerald-900 mt-0.5">
            {hidden ? MASK : formatProjectedIncome(estimatedIncomeCents)}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-emerald-700">Estimated Work Hours</div>
          <div className="text-base font-semibold text-emerald-900 mt-0.5">
            {hidden ? MASK : `${estimatedWorkHours.toFixed(2)} hrs`}
          </div>
        </div>
      </div>
    </div>
  );
}
