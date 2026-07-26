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

// Phase 5.6E additions: cancel_scheduled_trial/cancel_scheduled_paid cover
// the owner still having FULL access (trialing/active) with cancellation
// already scheduled -- distinct from "restricted", which this component
// never shows alongside full access. read_only/locked are now the shared
// banner variants for EVERY timed-restriction state family (canceled,
// past_due, unpaid, paused -- Phase 5.6F extends the same 30-day-then-
// locked model to all four; see lib/entitlement.ts's READ_ONLY_PERIOD_MS).
// "restricted" is no longer used by any state as of Phase 5.6F (kept in
// the union in case a future state needs a non-timed restricted banner
// again) -- "locked" now also covers incomplete/incomplete_expired/
// no_subscription, which never had a 30-day read-only phase to begin with.
// Phase 5.6F-R1: "temporarily_unavailable" is its own variant, never reused
// from "locked"/"verification_error" -- a transient infrastructure failure
// must never be worded as a lifecycle determination (cancelled/unpaid/
// permanently locked) that was never actually made. In practice this
// variant is never rendered by app/dashboard/page.tsx (which shows
// TemporaryUnavailableScreen directly, before DashboardShell/
// OwnerBillingBanner would ever mount), but the mapping stays correct here
// for any other consumer and for exhaustiveness.
export type BannerVariant =
  | "none"
  | "grace_warning"
  | "cancel_scheduled_trial"
  | "cancel_scheduled_paid"
  | "read_only"
  | "locked"
  | "restricted"
  | "verification_error"
  | "temporarily_unavailable";
export type RecoveryAction = "checkout" | "portal" | "support" | null;

export type EntitlementView = {
  canMutateOperationalData: boolean;
  canUseJobTracking: boolean;
  canSendNotifications: boolean;
  bannerVariant: BannerVariant;
  recoveryAction: RecoveryAction;
  // Phase 5.6E: the two dates the approved owner-facing UX explicitly
  // requires ("exact final full-access date", "exact read-only end date").
  // Deliberately narrow -- only these two Date fields, never the raw
  // trialEnd/currentPeriodEnd/graceEndsAt/restrictedSince the server-only
  // EntitlementResult carries, and never canceled_at itself. Both are null
  // whenever bannerVariant doesn't need them.
  finalAccessDate: Date | null;
  readOnlyEndsAt: Date | null;
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
  // Phase 5.6E: checked before the state switch since it's orthogonal to
  // state -- a subscription can be trialing/active (full access, matched by
  // the state switch below in every OTHER case) while ALSO having
  // cancellation already scheduled. This is the one case where full
  // capabilities and a non-"none" banner coexist, by design (the approved
  // policy requires the owner to see the scheduled cancellation while they
  // still have full access).
  if (result.cancelAtPeriodEnd && (result.state === "trialing" || result.state === "active")) {
    return {
      bannerVariant: result.state === "trialing" ? "cancel_scheduled_trial" : "cancel_scheduled_paid",
      // "portal" here means "manage/undo this scheduled cancellation," not
      // payment recovery -- the Stripe customer portal is the one existing
      // surface that can do that; this app has no separate undo-cancel route.
      recoveryAction: "portal",
    };
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

    // Phase 5.6F: past_due/unpaid/paused all still have a real Stripe
    // subscription/customer to fix -- the billing portal is the correct
    // recovery surface (unchanged reasoning from Phase 5.5A policy decision
    // #3), now applied consistently across their read-only AND locked
    // sub-states too.
    case "past_due_read_only":
    case "past_due_locked":
    case "unpaid_read_only":
    case "unpaid_locked":
    case "paused_read_only":
    case "paused_locked":
      return { bannerVariant: result.state.endsWith("_locked") ? "locked" : "read_only", recoveryAction: "portal" };

    // Phase 5.6E: the two canceled_at-driven sub-states get their own
    // wording (exact dates) instead of a generic banner -- see
    // OwnerBillingBanner.ts's CONTENT table. Checkout, not portal --
    // canceled means no active Stripe subscription remains to manage.
    case "canceled_read_only":
      return { bannerVariant: "read_only", recoveryAction: "checkout" };

    case "canceled_locked":
      return { bannerVariant: "locked", recoveryAction: "checkout" };

    case "no_subscription":
      // No active subscription to manage -- checkout, not the portal
      // (Phase 5.5A policy decision #3), subject to the existing checkout
      // route's own redirectToPortal response where a subscription turns
      // out to still exist. Phase 5.6F: this reason is now LOCKED-profile
      // (see lib/entitlement.ts), so the banner reflects that -- in
      // practice this banner is never actually rendered for a locked
      // owner (app/dashboard/page.tsx shows LockedReactivationScreen
      // instead of DashboardShell once canViewExistingData is false), but
      // the label stays accurate for any other future consumer.
      return { bannerVariant: "locked", recoveryAction: "checkout" };

    case "malformed":
      // Never claim a payment failure for data we can't confidently
      // interpret, and never guess a specific billing action (Phase 5.5A
      // policy decision #4). Unchanged wording even though Phase 5.6F
      // moved this reason's capabilities to LOCKED -- "we need to verify
      // your account" remains accurate and doesn't overclaim a read-only
      // period that never existed.
      return { bannerVariant: "verification_error", recoveryAction: "support" };

    // incomplete/incomplete_expired: checkout was started but a valid
    // subscription was never established (Phase 5.6F: now LOCKED-profile,
    // no 30-day read-only phase -- see lib/entitlement.ts). Same reasoning
    // as "malformed" above: never claim a read-only period that never
    // existed. recoveryAction is "checkout", not "support" -- the correct
    // next step really is starting a fresh checkout, not contacting
    // support.
    case "incomplete":
    case "incomplete_expired":
      return { bannerVariant: "verification_error", recoveryAction: "checkout" };

    // Phase 5.6F-R1: a transient failure to read the subscription record at
    // all -- never a lifecycle claim, so no recovery action is offered here
    // (retry is the only correct action, and it isn't a Stripe action at
    // all -- see TemporaryUnavailableScreen, which doesn't call
    // beginBillingRecovery).
    case "service_unavailable":
      return { bannerVariant: "temporarily_unavailable", recoveryAction: null };
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
    // Only ever non-null for the exact banner variants that need to display
    // it -- every other variant gets null here regardless of what the
    // underlying EntitlementResult happens to carry, so a future banner
    // variant can never accidentally render a stale/irrelevant date.
    finalAccessDate:
      bannerVariant === "cancel_scheduled_trial"
        ? result.trialEnd
        : bannerVariant === "cancel_scheduled_paid"
          ? result.currentPeriodEnd
          : null,
    // Only "read_only" actually displays this date -- "locked" has already
    // passed it, and neither OwnerBillingBanner.ts's nor
    // LockedReactivationScreen.ts's locked-state copy interpolates a date,
    // so it stays null there too rather than exposing an unused value.
    readOnlyEndsAt: bannerVariant === "read_only" ? result.readOnlyEndsAt : null,
  };
}

export function projectEntitlementForEmployee(result: EntitlementResult): EmployeeEntitlementView {
  return {
    canUseJobTracking: result.canUseJobTracking,
  };
}
