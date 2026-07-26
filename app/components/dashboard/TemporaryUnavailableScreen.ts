"use client";

// Phase 5.6F-R1 — the owner-only screen shown INSTEAD OF the dashboard when
// the authoritative subscription record could not be read at all (a
// transient Supabase/infrastructure failure -- lib/entitlement.ts's
// "service_unavailable" state, reason "query_error"). app/dashboard/
// page.tsx renders this in place of BOTH <DashboardShell> and
// <LockedReactivationScreen>, and never fetches
// clients/appointments/services/employees/employeeHours when this branch is
// taken -- a transient failure to read the entitlement record must not
// expose tenant data any more than an authoritative lock would.
//
// Deliberately simpler than LockedReactivationScreen: this is NOT a
// lifecycle/billing outcome, so there is no recovery action, no Stripe
// call, no beginBillingRecovery. The only correct action is to retry --
// a plain page reload, which re-runs the server component and re-attempts
// the same entitlement query. No props are needed.
//
// Written as a plain .ts file using React.createElement, matching
// OwnerBillingBanner.ts/LockedReactivationScreen.ts's exact precedent and
// for the same reason: Node's built-in test runner cannot load a .tsx file
// at all.
import { createElement } from "react";

export default function TemporaryUnavailableScreen() {
  return createElement(
    "div",
    { className: "min-h-screen bg-slate-50 flex items-center justify-center px-6" },
    createElement(
      "div",
      { className: "w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm text-center" },
      createElement("div", { className: "text-sm font-semibold text-slate-900" }, "Temporarily unavailable"),
      createElement(
        "div",
        { className: "mt-2 text-xs text-slate-500 leading-relaxed" },
        "We're having trouble loading your account right now. Your data is safe. Please try again in a moment."
      ),
      createElement(
        "button",
        {
          type: "button",
          onClick: () => window.location.reload(),
          className:
            "mt-6 w-full rounded-xl bg-[#0f172a] px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 transition-colors",
        },
        "Retry"
      )
    )
  );
}
