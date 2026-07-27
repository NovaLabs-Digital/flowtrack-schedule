"use client";

// Phase 5.7D-R11 — the owner-only screen shown INSTEAD OF the dashboard for
// a genuinely pristine, never-checked-out workspace (lib/entitlement.ts's
// "trial_not_started" state: billing_mode='stripe', no Stripe customer or
// subscription ever attached, trial_consumed_at still null, and no
// cancellation/access-ended history). app/dashboard/page.tsx renders this
// in place of <DashboardShell> (and never fetches clients/appointments/
// services/employees/employeeHours) exactly like <LockedReactivationScreen>
// already does for a locked workspace — there is no business data to show
// a workspace that has never completed Checkout.
//
// A real production signup exposed the bug this corrects: a brand-new
// workspace with no Stripe history at all was reaching
// <LockedReactivationScreen> and being told "Your read-only period has
// ended. Reactivate your subscription to restore access — your data has
// been preserved" — every word of that is false for an account that never
// had a subscription, a read-only period, or any data to preserve. This
// component exists to say the true, first-time thing instead, and never
// renders "reactivate," "read-only period ended," "data preserved," or
// "contact support" as its primary action.
//
// recoveryAction is intentionally NOT a prop: lib/entitlementView.ts's
// presentationFor() always resolves "trial_not_started" to exactly
// "checkout" (the same action canceled_read_only/canceled_locked/
// no_subscription already use — it invokes the existing, independently
// server-revalidated POST /api/stripe/checkout route via
// beginBillingRecovery, never a new route or a client-supplied value), so
// there is nothing for a caller to get wrong by passing something else.
//
// Written as a plain .ts file using React.createElement, matching
// OwnerBillingBanner.ts/LockedReactivationScreen.ts/
// TemporaryUnavailableScreen.ts's exact precedent: Node's built-in test
// runner (this repo's only test runner) cannot load a .tsx file at all.
import { createElement, useRef, useState } from "react";
import { beginBillingRecovery } from "@/lib/billingRecovery";

const UNEXPECTED_ERROR_MESSAGE = "We couldn't open billing right now. Please try again.";

export default function TrialActivationScreen() {
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Same synchronous double-activation guard as OwnerBillingBanner.ts/
  // LockedReactivationScreen.ts -- see either file's comment for why a ref
  // is needed in addition to `pending`.
  const inFlightRef = useRef(false);

  async function activate() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setPending(true);
    setErrorMessage(null);

    try {
      const result = await beginBillingRecovery("checkout");

      if (result.status === "redirecting") {
        return;
      }

      inFlightRef.current = false;
      setPending(false);
      if (result.status === "error") {
        setErrorMessage(result.message);
      }
      // "support_required"/"no_action" are not reachable outcomes for the
      // "checkout" action (see lib/billingRecovery.ts) -- no branch needed.
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
      createElement("div", { className: "text-sm font-semibold text-slate-900" }, "Start your 30-day free trial"),
      createElement(
        "div",
        { className: "mt-2 text-xs text-slate-500 leading-relaxed" },
        "No charge today. $24.99/month after the trial unless canceled."
      ),
      // False positive from react-hooks/refs, disabled just below: this
      // codebase's identical LockedReactivationScreen.ts/
      // OwnerBillingBanner.ts pattern (an inFlightRef-guarded async
      // activate() passed to onClick) passes this rule cleanly ONLY
      // because their activate() also contains an unambiguous
      // window.location.href assignment, which is apparently the sole
      // evidence the React Compiler's static analysis uses to conclude a
      // ref-touching function is exclusively an event handler, never
      // reachable during render. This component's "checkout" action never
      // assigns window.location.href directly in this file (see
      // lib/billingRecovery.ts -- beginBillingRecovery's "checkout" path
      // navigates via its injectable `navigate` callback instead), so that
      // heuristic has no signal to key off here even though activate is
      // exactly as handler-only as its siblings' -- it is defined in this
      // component solely to be this button's onClick, never called during
      // render.
      createElement(
        "button",
        // eslint-disable-next-line react-hooks/refs -- see comment above
        {
          type: "button",
          onClick: activate,
          disabled: pending,
          "aria-busy": pending,
          className:
            "mt-6 w-full rounded-xl bg-[#0f172a] px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 transition-colors",
        },
        pending ? "Working..." : "Start free trial"
      ),
      errorMessage && createElement("div", { role: "alert", className: "mt-3 text-xs text-rose-700" }, errorMessage)
    )
  );
}
