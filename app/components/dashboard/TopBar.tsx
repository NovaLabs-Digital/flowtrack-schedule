"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ViewMode } from "@/app/components/dashboard/types";

// Phase 5.5E-E1C: this control's own restricted notice, distinct from every
// other component's (appointment-modal-restricted-notice,
// appointment-detail-restricted-notice, move-confirm-dialog-restricted-
// notice) -- TopBar is always mounted on desktop alongside
// AppointmentDetailPanel/AppointmentModal, so ids must not collide. Same
// approved wording.
const RESTRICTED_NOTICE_ID = "topbar-restricted-notice";
const RESTRICTED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

export default function TopBar({
  onGoToday,
  onAdd,
  weekOffset,
  onWeekChange,
  // Phase 3: months relative to the current calendar month, consulted only
  // when viewMode === "month" -- kept as its own pair of props rather than
  // overloading weekOffset/onWeekChange, since month navigation is true
  // calendar-month arithmetic, not a week-based shift. Both optional so
  // every other caller (and the mobile branch below, which has no Month
  // view) is unaffected by their absence.
  monthOffset,
  onMonthChange,
  isMobile,
  viewMode,
  onChangeView,
  canMutateOperationalData,
}: {
  onGoToday: () => void;
  onAdd: () => void;
  weekOffset: number;
  onWeekChange: (offset: number) => void;
  monthOffset?: number;
  onMonthChange?: (offset: number) => void;
  isMobile?: boolean;
  viewMode?: ViewMode;
  onChangeView?: (m: ViewMode) => void;
  canMutateOperationalData: boolean;
}) {
  const router = useRouter();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // Defense-in-depth: DashboardShell's handleAdd (this desktop control's
  // onAdd) already guards the same way before opening AppointmentModal in
  // create mode -- this local guard exists so a disabled client control is
  // never itself the only thing standing between a restricted owner and the
  // create workflow, matching the pattern already established for every
  // other governed control in this phase's predecessors.
  function handleAddClick() {
    if (!canMutateOperationalData) return;
    onAdd();
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {}
    router.push("/");
  }

  // Phase 3: Prev/Next mean "previous/next calendar month" in Month view,
  // and "previous/next week" everywhere else -- existing Day/Weekdays/Week
  // behavior (weekOffset-based) is completely unchanged; only Month view
  // gets a new branch here.
  function handlePrev() {
    if (viewMode === "month") onMonthChange?.((monthOffset ?? 0) - 1);
    else onWeekChange(weekOffset - 1);
  }
  function handleNext() {
    if (viewMode === "month") onMonthChange?.((monthOffset ?? 0) + 1);
    else onWeekChange(weekOffset + 1);
  }

  if (isMobile) {
    return (
      <div className="shrink-0 bg-white border-b border-slate-200 px-3 py-2 space-y-2 safe-area-top">
        <div className="flex items-center justify-between gap-2">
          {/* Navigation */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => onWeekChange(weekOffset - 1)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm font-medium text-slate-700 active:bg-slate-100"
            >
              ←
            </button>
            <button
              onClick={onGoToday}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 active:bg-slate-100"
            >
              Today
            </button>
            <button
              onClick={() => onWeekChange(weekOffset + 1)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-sm font-medium text-slate-700 active:bg-slate-100"
            >
              →
            </button>
          </div>

          {/* User */}
          <div className="relative">
            <button
              onClick={() => setShowUserMenu((v) => !v)}
              className="flex items-center justify-center w-8 h-8 rounded-full bg-slate-900 text-white text-xs font-semibold"
            >
              A
            </button>
            {showUserMenu && (
              <div className="absolute top-full mt-1 right-0 w-40 rounded-xl border border-slate-200 bg-white shadow-lg p-1 z-50">
                <div className="px-3 py-2 text-xs text-slate-500 border-b border-slate-100">Signed in</div>
                <button
                  onClick={handleLogout}
                  disabled={loggingOut}
                  className="w-full rounded-lg px-3 py-2 text-left text-xs text-rose-700 hover:bg-rose-50 mt-1"
                >
                  {loggingOut ? "Signing out..." : "Sign Out"}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* View mode toggle — its own row so it has room to breathe next to
            the nav controls and avatar above, instead of all three clusters
            crowding into a single row. */}
        {onChangeView && (
          <div className="flex items-center gap-0.5 bg-slate-100 rounded-lg p-0.5 w-full">
            {(["day", "weekdays", "week"] as ViewMode[]).map((m) => (
              <button
                key={m}
                onClick={() => onChangeView(m)}
                className={[
                  "flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                  viewMode === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-500",
                ].join(" ")}
              >
                {m === "day" ? "Day" : m === "weekdays" ? "M-F" : "Wk"}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // --- DESKTOP TOP BAR (unchanged) ---
  return (
    <div className="shrink-0 bg-gradient-to-b from-slate-50 to-slate-100/80 border-b border-slate-200 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        {/* Left: navigation controls */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={onGoToday}
            className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
          >
            <span className="text-base leading-none">📅</span>
            Today
          </button>
          <button
            onClick={handlePrev}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
          >
            ← Prev
          </button>
          <button
            onClick={handleNext}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
          >
            Next →
          </button>
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-2">
          {/* Not CapabilityGatedButton: this control carries data-tour=
              "add-appointment", a load-bearing selector the Interactive
              Business Experience demo tour targets
              (demoExperienceSteps.ts) -- CapabilityGatedButton has no
              passthrough for arbitrary attributes, so routing this button
              through it would silently drop that attribute and break the
              tour. Disabled/aria-disabled/aria-describedby and the guarded
              click handler below replicate CapabilityGatedButton's own
              behavior directly instead. */}
          <div className="relative">
            <button
              onClick={handleAddClick}
              disabled={!canMutateOperationalData}
              aria-disabled={!canMutateOperationalData}
              aria-describedby={!canMutateOperationalData ? RESTRICTED_NOTICE_ID : undefined}
              data-tour="add-appointment"
              className="flex items-center gap-1.5 rounded-lg bg-[#0f172a] px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-50 transition-colors"
            >
              <span className="text-base leading-none">+</span>
              Add Appointment
            </button>
            {/* Reuses this file's own established absolute-dropdown pattern
                (see the user-menu panel below) rather than inventing new
                tooltip behavior -- keeps the single-row action cluster's
                layout completely undisturbed. */}
            {!canMutateOperationalData && (
              <div
                id={RESTRICTED_NOTICE_ID}
                className="absolute top-full mt-1 left-0 z-50 w-56 rounded-xl border border-slate-200 bg-white shadow-lg px-3 py-2 text-xs text-slate-600"
              >
                {RESTRICTED_WORDING}
              </div>
            )}
          </div>

          {/* User avatar + menu */}
          <div className="relative">
            <button
              onClick={() => setShowUserMenu((v) => !v)}
              className="flex items-center justify-center w-9 h-9 rounded-full bg-[#0f172a] text-white text-xs font-semibold shadow-sm hover:bg-slate-800 transition-colors"
              title="Account"
            >
              AW
            </button>

            {showUserMenu && (
              <div className="absolute top-full mt-1 right-0 w-44 rounded-xl border border-slate-200 bg-white shadow-lg p-1 z-50">
                <div className="px-3 py-2 text-xs text-slate-500 border-b border-slate-100">
                  Signed in
                </div>
                <button
                  onClick={handleLogout}
                  disabled={loggingOut}
                  className="w-full rounded-lg px-3 py-2 text-left text-xs text-rose-700 hover:bg-rose-50 transition-colors mt-1"
                >
                  {loggingOut ? "Signing out..." : "Sign Out"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
