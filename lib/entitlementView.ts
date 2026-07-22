import "server-only";
import type { EntitlementResult } from "@/lib/entitlement";

// Phase 5.5B — the ONE place a canonical EntitlementResult (lib/entitlement.ts)
// is turned into the minimum browser-safe shape a server component may pass
// as a prop. This is a pure projection, not a second policy: every capability
// boolean below is copied verbatim from the already-resolved result (never
// re-derived from state/stripeStatus/billingMode), and state/reason are read
// ONLY inside this file, ONLY to choose presentation metadata (which banner,
// which recovery action) -- neither ever appears in the returned value.
//
// Forbidden in the return value of either projection below, always:
//   canonical state/reason names, billing_mode, Stripe status, grace
//   deadlines, subscription/customer/workspace IDs, database diagnostics,
//   provider errors, or the raw EntitlementResult itself.

export type BannerVariant = "none" | "grace_warning" | "restricted" | "verification_error";
export type RecoveryAction = "checkout" | "portal" | "support" | null;

export type EntitlementView = {
  canMutateOperationalData: boolean;
  canUseJobTracking: boolean;
  canSendNotifications: boolean;
  bannerVariant: BannerVariant;
  recoveryAction: RecoveryAction;
};

// Employees never see billing language or a recovery action -- only whether
// job tracking (Start/Complete) is currently available to them. Deliberately
// NOT a subset destructured from EntitlementView at call sites: a dedicated
// type means a future field added to EntitlementView (e.g. a new billing
// capability) can never leak into an employee prop by accident.
export type EmployeeEntitlementView = {
  canUseJobTracking: boolean;
};

// Presentation-only decision, resolved from state (and, for the one case
// where state alone is ambiguous, reason). Never influences the capability
// booleans returned by the projections below -- those always come straight
// from the resolved result, regardless of what's decided here.
function presentationFor(result: EntitlementResult): { bannerVariant: BannerVariant; recoveryAction: RecoveryAction } {
  // "no_subscription" is the state for BOTH a genuine no-row workspace and a
  // Supabase query failure (see lib/entitlementServer.ts's noDataResult) --
  // these need different UI treatment (checkout vs. "we couldn't verify
  // this, contact support") even though they share the same state and the
  // same restricted capability profile. reason is the only field that tells
  // them apart, so it's checked first, ahead of the state switch below.
  if (result.reason === "query_error") {
    return { bannerVariant: "verification_error", recoveryAction: "support" };
  }

  switch (result.state) {
    case "active":
    case "trialing":
    case "internal":
    case "demo":
      return { bannerVariant: "none", recoveryAction: null };

    case "past_due_grace":
      // Fully operational (Phase 5.5A policy decision #2) -- this is a
      // non-blocking warning, not a restriction.
      return { bannerVariant: "grace_warning", recoveryAction: "portal" };

    case "past_due_expired":
    case "unpaid":
      // An existing Stripe subscription/customer needs attention -- the
      // billing portal is the correct recovery surface (Phase 5.5A policy
      // decision #3).
      return { bannerVariant: "restricted", recoveryAction: "portal" };

    case "canceled":
    case "no_subscription":
      // No active subscription to manage -- checkout, not the portal
      // (Phase 5.5A policy decision #3), subject to the existing checkout
      // route's own redirectToPortal response where a subscription turns
      // out to still exist.
      return { bannerVariant: "restricted", recoveryAction: "checkout" };

    case "malformed":
      // Never claim a payment failure for data we can't confidently
      // interpret, and never guess a specific billing action (Phase 5.5A
      // policy decision #4).
      return { bannerVariant: "verification_error", recoveryAction: "support" };

    // Not explicitly assigned a presentation by the Phase 5.5A approved
    // mapping (only active/trialing/past_due_grace/past_due_expired/unpaid/
    // canceled/no_subscription/malformed were enumerated). Each of these is
    // a real, restricted billing state, but routing it to a specific
    // checkout-vs-portal action from state alone would be guessing rather
    // than projecting an approved decision. Treated the same as
    // "malformed": restricted capabilities (unchanged, copied verbatim
    // below), a neutral verification_error banner, and a support recovery
    // action -- never a false claim, never a wrong recovery button. Revisit
    // with an explicit policy decision if/when these states need their own
    // presentation.
    case "incomplete":
    case "incomplete_expired":
    case "paused":
      return { bannerVariant: "verification_error", recoveryAction: "support" };
  }
}

export function projectEntitlementForOwner(result: EntitlementResult): EntitlementView {
  const { bannerVariant, recoveryAction } = presentationFor(result);
  return {
    canMutateOperationalData: result.canMutateOperationalData,
    canUseJobTracking: result.canUseJobTracking,
    canSendNotifications: result.canSendNotifications,
    bannerVariant,
    recoveryAction,
  };
}

export function projectEntitlementForEmployee(result: EntitlementResult): EmployeeEntitlementView {
  return {
    canUseJobTracking: result.canUseJobTracking,
  };
}
