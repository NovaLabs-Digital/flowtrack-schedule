"use client";

// Phase 5.5D — the owner-only billing-status banner. Written as a plain
// .ts file using React.createElement instead of JSX/.tsx: Node's built-in
// test runner (this repo's only test runner, per Phase 5.5D-P) cannot load
// a .tsx file at all, with or without JSX content -- its module loader has
// no handler registered for that extension, only .ts/.mts/.cts. Writing
// this file as idiomatic JSX would make the actual shipped component
// unloadable by node:test, forcing tests onto a re-implemented stand-in
// instead of the real thing -- exactly what Phase 5.5D-P's fixture-based
// proof was built to avoid needing. This is the one component in the
// codebase that deviates from the otherwise-universal .tsx/JSX convention,
// and it does so for this single, specific, structural reason.
//
// Receives ONLY the two presentation-relevant fields of the Phase 5.5B
// browser-safe EntitlementView -- never the full projection, never a raw
// EntitlementResult, never a workspace/Stripe/subscription identifier.
// Wording is selected from bannerVariant alone; the recovery action/label
// is selected from recoveryAction alone -- neither is inferred from the
// other, and neither is ever re-derived from subscription state (this
// component has no access to subscription state to re-derive from).
import { createElement, useEffect, useRef, useState } from "react";
import { beginBillingRecovery, type BillingRecoveryAction } from "@/lib/billingRecovery";
import { SUPPORT_MAILTO_URL } from "@/lib/support";
import type { EntitlementView } from "@/lib/entitlementView";

export type OwnerBillingBannerProps = Pick<EntitlementView, "bannerVariant" | "recoveryAction">;

type NonNoneVariant = Exclude<OwnerBillingBannerProps["bannerVariant"], "none">;

// Wording keyed ONLY by bannerVariant -- the approved copy, verbatim, never
// touched by recoveryAction or any other input.
const CONTENT: Record<NonNoneVariant, { title: string; body: string }> = {
  grace_warning: {
    title: "Please update your billing information",
    body:
      "We couldn't confirm your latest payment. Your scheduling tools are still available for now. Update billing to prevent an interruption.",
  },
  restricted: {
    title: "Billing attention is required",
    body: "Please restore your subscription to continue using all scheduling features.",
  },
  verification_error: {
    title: "We need to verify your account",
    body: "Please contact support so we can help restore full access.",
  },
};

// Label keyed ONLY by recoveryAction -- never derived from bannerVariant.
// An unusual but type-valid combination (e.g. "verification_error" paired
// with recoveryAction "checkout") still renders exactly this label with no
// attempt to reconcile, override, or reject it: the canonical server
// projection owns that policy, not this component.
const ACTION_LABEL: Record<Exclude<BillingRecoveryAction, null>, string> = {
  portal: "Update billing",
  checkout: "Restore subscription",
  support: "Contact support",
};

const UNEXPECTED_ERROR_MESSAGE = "We couldn't open billing right now. Please try again.";

// Calm, non-alarming palette shared with this codebase's existing warning
// surfaces (e.g. the job-tracking warning card in AppointmentModal.tsx) --
// amber for "needs attention," a neutral slate for "we're not sure yet,"
// deliberately never the rose/red family this codebase reserves for
// destructive actions and hard failures. Wording, not color, carries the
// meaning (grace_warning and restricted share the same color and are told
// apart only by their approved copy).
const VARIANT_STYLE: Record<NonNoneVariant, { wrap: string; title: string; body: string }> = {
  grace_warning: { wrap: "border-amber-200 bg-amber-50", title: "text-amber-900", body: "text-amber-800" },
  restricted: { wrap: "border-amber-200 bg-amber-50", title: "text-amber-900", body: "text-amber-800" },
  verification_error: { wrap: "border-slate-200 bg-slate-50", title: "text-slate-900", body: "text-slate-600" },
};

export default function OwnerBillingBanner({ bannerVariant, recoveryAction }: OwnerBillingBannerProps) {
  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Synchronous guard, checked and set BEFORE any state update or await --
  // this is what makes two same-tick activations (a double-click landing
  // before React has re-rendered the `disabled` attribute) still only ever
  // call beginBillingRecovery once. `pending` state alone would still be
  // correct once React re-renders, but a ref closes the gap between "user
  // clicks twice" and "React has re-rendered the disabled button."
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  if (bannerVariant === "none") return null;

  const content = CONTENT[bannerVariant];
  const style = VARIANT_STYLE[bannerVariant];
  const label = recoveryAction ? ACTION_LABEL[recoveryAction] : null;

  async function activate() {
    if (inFlightRef.current) return;
    if (!recoveryAction) return;
    inFlightRef.current = true;
    setPending(true);
    setErrorMessage(null);

    try {
      const result = await beginBillingRecovery(recoveryAction);
      if (!mountedRef.current) return;

      if (result.status === "redirecting") {
        // Remain pending -- browser navigation is expected momentarily;
        // clearing pending here would just flash the button re-enabled
        // right before the page unloads.
        return;
      }

      if (result.status === "support_required") {
        // The smallest safe browser mechanism for a mailto: link: the same
        // navigation a plain <a href="mailto:..."> would trigger, using
        // only the canonical constant -- no application/network request,
        // no Stripe call, no invented address. The React Compiler
        // immutability rule flags any assignment into `window` as
        // "modifying a variable defined outside a component" -- a
        // necessary false positive here, since navigating the browser is
        // an intentional side effect of this exact event handler, not
        // component render logic the compiler needs to memoize safely.
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

      // result.status === "error" -- the helper's own fixed, safe message,
      // never a raw caught/provider value.
      inFlightRef.current = false;
      setPending(false);
      setErrorMessage(result.message);
    } catch {
      if (!mountedRef.current) return;
      inFlightRef.current = false;
      setPending(false);
      setErrorMessage(UNEXPECTED_ERROR_MESSAGE);
    }
  }

  return createElement(
    "div",
    {
      role: "status",
      "aria-live": "polite",
      className: `shrink-0 border-b px-4 py-3 ${style.wrap}`,
    },
    createElement(
      "div",
      { className: "flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" },
      createElement(
        "div",
        { className: "min-w-0" },
        createElement("div", { className: `text-sm font-semibold ${style.title}` }, content.title),
        createElement("div", { className: `text-xs mt-0.5 ${style.body}` }, content.body)
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
              "shrink-0 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50 transition-colors",
          },
          pending ? "Working..." : label
        )
    ),
    errorMessage &&
      createElement(
        "div",
        { role: "alert", className: "mt-2 text-xs text-rose-700" },
        errorMessage
      )
  );
}
