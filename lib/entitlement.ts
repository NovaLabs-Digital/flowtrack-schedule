// Pure billing-entitlement resolver. No Supabase, no Next.js, no env vars —
// deliberately dependency-free so it can be unit-tested without a database
// and safely imported into future UI code for typing. Server-only data
// access (fetching a workspace's subscriptions row) lives in
// lib/entitlementServer.ts, which calls resolveEntitlement() below.
//
// Every comparison in this module is an exact instant comparison
// (now.getTime() < expiry.getTime()): access is already read-only AT the
// expiration instant, never one millisecond after it. There is no leniency
// window anywhere in this file.

export type EntitlementAccess = "full" | "read_only";

// One reason per branch of the decision table below — kept distinct (rather
// than collapsing to a handful of generic codes) so a future UI can explain
// *why* a workspace is read-only without re-deriving the logic, and so tests
// can assert the resolver took the branch they expect, not just the right
// access level.
export type EntitlementReason =
  | "no_subscription"
  | "query_error"
  | "internal"
  | "trialing"
  | "trial_ended"
  | "active"
  | "active_canceling"
  | "active_canceling_ended"
  | "past_due_in_grace"
  | "past_due_grace_expired"
  | "canceled_pending_period_end"
  | "canceled_period_ended"
  | "inactive_status"
  | "unknown_status";

// Everything a future UI is allowed to see. Deliberately excludes
// stripe_customer_id / stripe_subscription_id — those never leave the
// server (see lib/entitlementServer.ts).
export interface EntitlementResult {
  access: EntitlementAccess;
  reason: EntitlementReason;
  billingMode: "internal" | "stripe" | null;
  stripeStatus: string | null;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
  graceUntil: Date | null;
  cancelAtPeriodEnd: boolean;
}

// Shape the pure resolver operates on. lib/entitlementServer.ts is
// responsible for turning a raw subscriptions row (Postgres timestamptz
// strings) into this — Date objects here keep the resolver's comparisons
// unambiguous and trivially testable.
export interface SubscriptionRecord {
  billingMode: "internal" | "stripe";
  stripeStatus: string | null;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
  graceUntil: Date | null;
  cancelAtPeriodEnd: boolean;
}

function buildResult(
  access: EntitlementAccess,
  reason: EntitlementReason,
  billingMode: "internal" | "stripe" | null,
  stripeStatus: string | null,
  trialEnd: Date | null,
  currentPeriodEnd: Date | null,
  graceUntil: Date | null,
  cancelAtPeriodEnd: boolean
): EntitlementResult {
  return { access, reason, billingMode, stripeStatus, trialEnd, currentPeriodEnd, graceUntil, cancelAtPeriodEnd };
}

// Fail-closed result for the "we have no usable subscription data at all"
// cases (no row / query error) — a workspace with no row is never granted
// access. Exported so lib/entitlementServer.ts can produce the same shape
// for a query failure without duplicating the all-null field list.
export function noDataResult(reason: "no_subscription" | "query_error"): EntitlementResult {
  return buildResult("read_only", reason, null, null, null, null, null, false);
}

// Deterministic. Given the same (subscription, now), always returns the
// same result — no I/O, no clock reads of its own.
export function resolveEntitlement(subscription: SubscriptionRecord | null, now: Date): EntitlementResult {
  if (!subscription) {
    return noDataResult("no_subscription");
  }

  const { billingMode, stripeStatus, trialEnd, currentPeriodEnd, graceUntil, cancelAtPeriodEnd } = subscription;

  if (billingMode === "internal") {
    return buildResult("full", "internal", billingMode, null, null, null, null, false);
  }

  if (billingMode !== "stripe") {
    // The subscriptions_internal_mode_has_no_stripe_data CHECK constraint
    // (migration 015) and the DB's billing_mode CHECK should make this
    // unreachable, but a resolver that trusts its caller unconditionally
    // is exactly how "grant access by accident" bugs happen. Fail closed.
    return buildResult(
      "read_only",
      "unknown_status",
      billingMode,
      stripeStatus,
      trialEnd,
      currentPeriodEnd,
      graceUntil,
      cancelAtPeriodEnd
    );
  }

  switch (stripeStatus) {
    case "trialing": {
      const valid = trialEnd !== null && now.getTime() < trialEnd.getTime();
      return buildResult(
        valid ? "full" : "read_only",
        valid ? "trialing" : "trial_ended",
        billingMode,
        stripeStatus,
        trialEnd,
        currentPeriodEnd,
        graceUntil,
        cancelAtPeriodEnd
      );
    }

    case "active": {
      if (!cancelAtPeriodEnd) {
        return buildResult("full", "active", billingMode, stripeStatus, trialEnd, currentPeriodEnd, graceUntil, cancelAtPeriodEnd);
      }
      const stillWithinPeriod = currentPeriodEnd !== null && now.getTime() < currentPeriodEnd.getTime();
      return buildResult(
        stillWithinPeriod ? "full" : "read_only",
        stillWithinPeriod ? "active_canceling" : "active_canceling_ended",
        billingMode,
        stripeStatus,
        trialEnd,
        currentPeriodEnd,
        graceUntil,
        cancelAtPeriodEnd
      );
    }

    case "past_due": {
      const inGrace = graceUntil !== null && now.getTime() < graceUntil.getTime();
      return buildResult(
        inGrace ? "full" : "read_only",
        inGrace ? "past_due_in_grace" : "past_due_grace_expired",
        billingMode,
        stripeStatus,
        trialEnd,
        currentPeriodEnd,
        graceUntil,
        cancelAtPeriodEnd
      );
    }

    case "canceled": {
      const beforePeriodEnd = currentPeriodEnd !== null && now.getTime() < currentPeriodEnd.getTime();
      return buildResult(
        beforePeriodEnd ? "full" : "read_only",
        beforePeriodEnd ? "canceled_pending_period_end" : "canceled_period_ended",
        billingMode,
        stripeStatus,
        trialEnd,
        currentPeriodEnd,
        graceUntil,
        cancelAtPeriodEnd
      );
    }

    case "paused":
    case "incomplete":
    case "incomplete_expired":
    case "unpaid":
      return buildResult(
        "read_only",
        "inactive_status",
        billingMode,
        stripeStatus,
        trialEnd,
        currentPeriodEnd,
        graceUntil,
        cancelAtPeriodEnd
      );

    default:
      // Covers NULL (e.g. a 'stripe'-mode row created before its first
      // webhook has landed) and any status Stripe might add in the future
      // that this resolver doesn't yet know how to evaluate.
      return buildResult(
        "read_only",
        "unknown_status",
        billingMode,
        stripeStatus,
        trialEnd,
        currentPeriodEnd,
        graceUntil,
        cancelAtPeriodEnd
      );
  }
}
