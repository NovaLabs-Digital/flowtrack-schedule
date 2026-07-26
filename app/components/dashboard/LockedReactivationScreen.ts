"use client";

// Phase 5.6E — the owner-only screen shown INSTEAD OF the dashboard once a
// workspace reaches canceled_locked (30+ calendar days after canceled_at;
// see lib/entitlement.ts's READ_ONLY_PERIOD_MS). app/dashboard/page.tsx
// renders this in place of <DashboardShell>, never alongside it, and never
// fetches clients/appointments/services/employees/employeeHours at all when
// this branch is taken -- "prevent operational tenant-data pages and APIs
// from exposing workspace data" per the approved policy. This file receives
// only the one browser-safe field it needs (recoveryAction) -- never a raw
// EntitlementResult, workspace id, or any billing/Stripe identifier.
//
// Written as a plain .ts file using React.createElement, matching
// OwnerBillingBanner.ts's exact precedent and for the same reason: Node's
// built-in test runner (this repo's only test runner) cannot load a .tsx
// file at all, and this component's one real interactive behavior (the
// reactivate button calling beginBillingRecovery) deserves real rendered-DOM
// proof, not a re-implemented stand-in.
import { createElement, useRef, useState } from "react";
import { beginBillingRecovery, type BillingRecoveryAction } from "@/lib/billingRecovery";
import { SUPPORT_MAILTO_URL } from "@/lib/support";

export type LockedReactivationScreenProps = {
  recoveryAction: BillingRecoveryAction;
};

const ACTION_LABEL: Record<Exclude<BillingRecoveryAction, null>, string> = {
  portal: "Update billing",
  checkout: "Reactivate subscription",
  support: "Contact support",
};

const UNEXPECTED_ERROR_MESSAGE = "We couldn't open billing right now. Please try again.";

export default function LockedReactivationScreen({ recoveryAction }: LockedReactivationScreenProps) {
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Same synchronous double-activation guard as OwnerBillingBanner.ts --
  // see that file's comment for why a ref is needed in addition to `pending`.
  const inFlightRef = useRef(false);

  const label = recoveryAction ? ACTION_LABEL[recoveryAction] : null;

  async function activate() {
    if (inFlightRef.current) return;
    if (!recoveryAction) return;
    inFlightRef.current = true;
    setPending(true);
    setErrorMessage(null);

    try {
      const result = await beginBillingRecovery(recoveryAction);

      if (result.status === "redirecting") {
        return;
      }

      if (result.status === "support_required") {
        // eslint-disable-next-line react-hooks/immutability
        window.location.href = SUPPORT_MAILTO_URL;
        inFlightRef.current = false;
        setPending(false);
        return;
      }

      if (result.status === "no_action") {
        inFlightRef.current = false;
        setPending(false);
        return;
      }

      inFlightRef.current = false;
      setPending(false);
      setErrorMessage(result.message);
    } catch {
      inFlightRef.current = false;
      setPending(false);
      setErrorMessage(UNEXPECTED_ERROR_MESSAGE);
    }
  }

  return createElement(
    "div",
    { className: "min-h-screen bg-slate-50 flex items-center justify-center px-6" },
    createElement(
      "div",
      { className: "w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm text-center" },
      createElement("div", { className: "text-sm font-semibold text-slate-900" }, "Subscription required"),
      createElement(
        "div",
        { className: "mt-2 text-xs text-slate-500 leading-relaxed" },
        "Your read-only period has ended. Reactivate your subscription to restore access — your data has been preserved."
      ),
      label &&
        createElement(
          "button",
          {
            type: "button",
            onClick: activate,
            disabled: pending,
            "aria-busy": pending,
            className:
              "mt-6 w-full rounded-xl bg-[#0f172a] px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 transition-colors",
          },
          pending ? "Working..." : label
        ),
      errorMessage && createElement("div", { role: "alert", className: "mt-3 text-xs text-rose-700" }, errorMessage)
    )
  );
}
