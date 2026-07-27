// Pure billing-entitlement resolver. No Supabase, no Next.js, no env vars,
// no Stripe SDK calls — deliberately dependency-free so it can be
// unit-tested without a database or network and safely imported into future
// UI code for typing. Server-only data access (fetching a workspace's
// subscriptions row) lives in lib/entitlementServer.ts, which calls
// resolveWorkspaceEntitlement() below.
//
// Approved product policy (Phase 5.6F, the current and authoritative
// version of this module):
//
//   Full operational access:
//     - billing_mode = internal
//     - demo/tester workspace
//     - Stripe status = trialing
//     - Stripe status = active
//     - Stripe status = past_due, while still inside the 3-day grace period
//
//   Read-only access, for 30 calendar days starting from a reliable,
//   status-specific boundary timestamp:
//     - canceled:  30 days from canceled_at (Phase 5.6E, unchanged)
//     - past_due:  30 days from the exact instant the 3-day grace expired
//                  (graceUntil) -- previously indefinite; Phase 5.6F fixes
//                  this to match the approved "do not allow indefinite
//                  read-only" policy.
//     - unpaid:    30 days from access_ended_at (Phase 5.6F; see
//                  SubscriptionRecord.accessEndedAt below)
//     - paused:    30 days from access_ended_at (Phase 5.6F)
//   During read-only: owner can log in, view all existing records, export
//   data, and reach Settings/billing/reactivation. Nothing can be created,
//   edited, deleted, cancelled, or rescheduled; Job Tracking, public
//   booking, and notifications are paused.
//
//   Locked access, starting exactly 30 calendar days after the same
//   status-specific boundary: everything read-only denies, PLUS viewing
//   and exporting existing business data. Billing/reactivation remains the
//   one reachable path back to full access.
//
//   Locked access, IMMEDIATELY and INDEFINITELY (no 30-day read-only phase
//   at all -- these states never had real operational access to lose):
//     - incomplete / incomplete_expired: checkout was started but a valid
//       subscription was never established. Phase 5.6F policy: "do not
//       grant a 30-day read-only entitlement merely because checkout did
//       not complete."
//     - no_subscription (reason "no_subscription" -- a genuine missing
//       row): never had a subscription at all.
//     - malformed (every malformed_* reason): data this module cannot
//       confidently interpret.
//   Billing/reactivation remains reachable in all of these; nothing else
//   is.
//
//   A wholly separate, non-lifecycle outcome (Phase 5.6F-R1): reason
//   "query_error" (a transient Supabase/infrastructure read failure) is
//   reported as its OWN dedicated state, "service_unavailable" -- never
//   the "no_subscription" state, and never granted read-only viewing
//   either. A transient failure in OUR OWN infrastructure is not
//   authoritative evidence of anything about the workspace's real
//   lifecycle, so it must not be reported, displayed, or persisted as one
//   -- not as "locked" (which would falsely claim a lifecycle
//   determination that was never made), and not as "read-only" (which
//   would expose tenant data based on a state this module explicitly
//   could not verify). It fails closed to the same capability denial as
//   locked (SERVICE_UNAVAILABLE_CAPABILITIES), but callers can and must
//   render it as "temporarily unavailable, please retry" rather than any
//   cancellation/payment/lock messaging -- see
//   app/components/dashboard/TemporaryUnavailableScreen.ts. This state is
//   never written to persisted lifecycle timestamps (trial_consumed_at,
//   access_ended_at, canceled_at, grace_until) by any caller -- a
//   transient failure to READ the record must never become a WRITE to it.
//
//   No record is ever deleted, detached, reassigned, or hidden IN THE
//   DATABASE by this module — it only reports what the caller is allowed
//   to do/show next. The locked and service_unavailable capability
//   profiles hide existing data from the API/UI layer; neither changes
//   anything about what's actually stored.
//
// Trial-eligibility for what Stripe Checkout SESSION to create (whether to
// pass trial_period_days) is NOT decided by this module at all -- it is a
// Stripe-Checkout-time decision made independently in lib/stripeCheckout.ts
// (and revalidated server-side in app/api/stripe/checkout/route.ts) from
// the same subscriptions row's trial_consumed_at column, every time
// Checkout is invoked. That route is the actual security boundary for
// starting a trial-bearing subscription; it never trusts anything this
// resolver or the UI layer computes.
//
// Phase 5.7D-R11: this module DOES now distinguish one narrow case in its
// own right -- "trial_not_started" -- purely so the UI can show the
// correct FIRST-TIME invitation ("Start your 30-day free trial") instead
// of the "reactivate/read-only period ended" copy that a genuinely
// billing_mode='stripe' row with stripe_status still NULL was previously
// (and wrongly) resolving to via the "malformed" branch. A real production
// signup exposed this: a brand-new workspace, provisioned moments earlier,
// with no Stripe customer/subscription ever created, no trial ever
// consumed, and no cancellation/access-ended history, reached the
// dashboard and was shown "Your read-only period has ended... your data
// has been preserved" -- both false for an account that never had
// anything to lose. See resolveEntitlement's `case null/undefined/""`
// branch below for the exact, conservative distinguishing evidence
// required (trialConsumedAt IS NULL, no Stripe identity attached, no
// canceledAt/accessEndedAt/currentPeriodEnd) -- ANY of those being set
// still falls back to "malformed" exactly as before, unchanged and
// equally fail-closed.
//
// This new state grants NO operational access and NO viewing of existing
// data (there is none) -- only canManageBilling, the minimum needed to
// reach Stripe Checkout. It is not itself a trial-eligibility DECISION;
// Checkout's own server-side trial_consumed_at check remains the sole
// authority for whether the resulting subscription actually includes a
// trial period.

// Explicit relative specifier with its literal extension (rather than the
// "@/lib/workspace" alias used everywhere else in this codebase) so this
// file stays resolvable by Node's native test runner with zero bundler/
// loader tooling — matching its own "dependency-free, unit-testable
// without a database" design goal one step further. Safe: workspace.ts is
// itself two constants with no further imports.
import { DEMO_WORKSPACE_ID } from "./workspace.ts";

// The canonical, coarse-grained bucket every downstream consumer should
// switch on. Expressed as a closed union so an unhandled state is a
// compile error, not a silent fallthrough.
export type EntitlementState =
  | "internal"
  | "demo"
  | "trial_not_started"
  | "trialing"
  | "active"
  | "past_due_grace"
  | "past_due_read_only"
  | "past_due_locked"
  | "unpaid_read_only"
  | "unpaid_locked"
  | "paused_read_only"
  | "paused_locked"
  | "canceled_read_only"
  | "canceled_locked"
  | "incomplete"
  | "incomplete_expired"
  | "no_subscription"
  | "malformed"
  // Phase 5.6F-R1: a transient failure to read the authoritative
  // subscription record at all -- structurally distinct from every state
  // above, all of which represent an AUTHORITATIVE read of real data.
  // Never used for a genuine "no row" or "corrupted row" case (those stay
  // "no_subscription"/"malformed") -- only for the query/infrastructure
  // failure itself. See noDataResult below.
  | "service_unavailable";

// A finer-grained diagnostic code — mostly one-to-one with EntitlementState,
// but splits a few buckets that share the same capability profile yet have
// different root causes worth distinguishing in logs (e.g. every
// malformed_* reason shares the "malformed" state but not the same root
// cause). As of Phase 5.6F-R1, "no_subscription" and "query_error" are no
// longer one such pair -- they now resolve to different STATES
// ("no_subscription" vs "service_unavailable") precisely because they are
// not the same kind of outcome -- see the module header comment above.
export type EntitlementReason =
  | "internal"
  | "demo_workspace"
  | "trial_not_started"
  | "trialing"
  | "active"
  | "past_due_in_grace"
  | "past_due_read_only"
  | "past_due_locked"
  | "unpaid_read_only"
  | "unpaid_locked"
  | "paused_read_only"
  | "paused_locked"
  | "canceled_read_only"
  | "canceled_locked"
  | "incomplete"
  | "incomplete_expired"
  | "no_subscription"
  | "query_error"
  | "malformed_billing_mode"
  | "malformed_missing_status"
  | "malformed_unknown_status"
  | "malformed_grace_date"
  | "malformed_canceled_date"
  | "malformed_access_ended_date";

// Named per-capability flags rather than a single access level, so a
// downstream route/component checks exactly the permission it needs instead
// of re-deriving "does read-only mean I can do this?" from a single enum.
export interface EntitlementCapabilities {
  hasOperationalAccess: boolean;
  isReadOnly: boolean;
  canManageBilling: boolean;
  canViewExistingData: boolean;
  canExportData: boolean;
  canMutateOperationalData: boolean;
  canUseJobTracking: boolean;
  canUsePublicBooking: boolean;
  canSendNotifications: boolean;
}

// Everything a future UI/route is allowed to see. Deliberately excludes
// stripe_customer_id / stripe_subscription_id — those never leave the
// server (see lib/entitlementServer.ts). billingMode/stripeStatus/trialEnd/
// currentPeriodEnd/cancelAtPeriodEnd are diagnostic/display fields only —
// none of them gate access directly; the capability flags above are the
// single source of truth for "may I do X."
export interface EntitlementResult extends EntitlementCapabilities {
  state: EntitlementState;
  reason: EntitlementReason;
  // Populated only for past_due_grace — the boundary at which grace itself
  // expires. Distinct from restrictedSince/readOnlyEndsAt below even for
  // past_due_read_only/past_due_locked (where graceEndsAt and
  // restrictedSince happen to hold the same instant) so a caller that only
  // ever cared about the grace deadline doesn't need to know this module
  // grew a second, more general timed-restriction concept later.
  graceEndsAt: Date | null;
  // Populated for every "_read_only"/"_locked" state family (canceled,
  // past_due, unpaid, paused): restrictedSince is the reliable boundary
  // full access ended; readOnlyEndsAt is restrictedSince + 30 days (when
  // the account locks). Null everywhere else.
  restrictedSince: Date | null;
  readOnlyEndsAt: Date | null;
  billingMode: "internal" | "stripe" | null;
  stripeStatus: string | null;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

// Shape the pure resolver operates on. lib/entitlementServer.ts is
// responsible for turning a raw subscriptions row (Postgres timestamptz
// strings) into this — Date objects here keep the resolver's comparisons
// unambiguous and trivially testable. Every Date field is a UTC instant
// (Date.getTime() is always UTC epoch milliseconds); this module never
// reads the server's local time zone, so there is no local-time ambiguity
// anywhere in any boundary comparison below.
export interface SubscriptionRecord {
  billingMode: "internal" | "stripe";
  stripeStatus: string | null;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
  graceUntil: Date | null;
  cancelAtPeriodEnd: boolean;
  // Stripe's own canceled_at, verbatim (migrations/015). Set by Stripe the
  // instant a subscription actually stops. The one reliable boundary for
  // "canceled" (Phase 5.6E).
  canceledAt: Date | null;
  // This app's own bookkeeping (migrations/016) of the instant full access
  // ended for 'unpaid'/'paused' -- the two statuses Stripe itself gives no
  // boundary timestamp for. Null for every workspace until a real webhook
  // event observes one of those statuses. See lib/stripeWebhook.ts's
  // computeAccessEndedPatchField for exactly how/when this is written.
  accessEndedAt: Date | null;
  // Phase 5.7D-R11 (migrations/016): set exactly once, the first time
  // Stripe confirms this workspace's subscription actually entered a
  // trial -- never cleared by cancellation or reactivation. Read here
  // ONLY to distinguish a genuinely pristine, never-checked-out workspace
  // (this field null, alongside no Stripe identity and no prior-access
  // history) from every other stripe_status-is-null case, which stays
  // "malformed" exactly as before. This module still makes no trial
  // ELIGIBILITY decision of its own -- see the module header comment.
  trialConsumedAt: Date | null;
  // Phase 5.7D-R11: true if either stripe_customer_id or
  // stripe_subscription_id is present on the row. The raw IDs themselves
  // are never passed into this pure resolver (they never leave the
  // server at all -- see lib/entitlementServer.ts) -- only this derived
  // boolean, which is all resolveEntitlement needs to help confirm a row
  // is genuinely untouched.
  hasStripeIdentity: boolean;
}

const FULL_CAPABILITIES: EntitlementCapabilities = {
  hasOperationalAccess: true,
  isReadOnly: false,
  canManageBilling: true,
  canViewExistingData: true,
  canExportData: true,
  canMutateOperationalData: true,
  canUseJobTracking: true,
  canUsePublicBooking: true,
  canSendNotifications: true,
};

// Billing/viewing/export/login stay allowed — the owner must never be
// trapped outside the app with no way to pay, and existing business
// records must remain visible/exportable during the 30-day read-only
// window. Used for every "_read_only" state. NOT used for query_error as
// of Phase 5.6F-R1 -- see SERVICE_UNAVAILABLE_CAPABILITIES below.
const RESTRICTED_CAPABILITIES: EntitlementCapabilities = {
  hasOperationalAccess: false,
  isReadOnly: true,
  canManageBilling: true,
  canViewExistingData: true,
  canExportData: true,
  canMutateOperationalData: false,
  canUseJobTracking: false,
  canUsePublicBooking: false,
  canSendNotifications: false,
};

// Strictly more restricted than RESTRICTED_CAPABILITIES above — used for
// every "_locked" state, plus incomplete/incomplete_expired/no_subscription
// (reason "no_subscription" only)/malformed (see module header comment for
// the full policy). Billing/reactivation must remain reachable (the owner
// can never be trapped with no way to pay), but viewing and exporting
// existing business data is not allowed. No record is deleted, altered, or
// hidden from the DATABASE by this — only what the API/UI layer will hand
// back stops here.
const LOCKED_CAPABILITIES: EntitlementCapabilities = {
  hasOperationalAccess: false,
  isReadOnly: true,
  canManageBilling: true,
  canViewExistingData: false,
  canExportData: false,
  canMutateOperationalData: false,
  canUseJobTracking: false,
  canUsePublicBooking: false,
  canSendNotifications: false,
};

// Phase 5.6F-R1: the ONE profile used exclusively for a transient
// subscription-query failure (reason "query_error"). Numerically identical
// to LOCKED_CAPABILITIES today, but kept as its own named constant
// deliberately -- these are conceptually different outcomes (an
// infrastructure hiccup vs. an authoritative locked lifecycle) that happen
// to warrant the same capability denial right now, not the same thing.
// canManageBilling stays true only because it isn't actually consumed by
// any route today (checkout/portal are already unconditionally reachable
// regardless of entitlement) -- it costs nothing to leave it true and
// avoids inventing a new false-by-default gate this phase wasn't asked to
// build. Never used for a genuine no-row or corrupted-row case.
const SERVICE_UNAVAILABLE_CAPABILITIES: EntitlementCapabilities = {
  hasOperationalAccess: false,
  isReadOnly: true,
  canManageBilling: true,
  canViewExistingData: false,
  canExportData: false,
  canMutateOperationalData: false,
  canUseJobTracking: false,
  canUsePublicBooking: false,
  canSendNotifications: false,
};

// Phase 5.7D-R11: the ONE profile for "trial_not_started" -- a genuinely
// pristine, never-checked-out workspace. Deliberately its own named
// constant rather than reusing LOCKED_CAPABILITIES, even though every
// boolean below happens to match it today (same reasoning as
// SERVICE_UNAVAILABLE_CAPABILITIES above: conceptually distinct outcomes
// that currently warrant the same denial). No operational, mutation,
// notification, public-booking, job-tracking, or data-export capability
// (there is no data yet to export or view) -- canManageBilling is the
// ONLY true flag, the minimum needed to reach Stripe Checkout.
// isReadOnly is false (not true, unlike LOCKED_CAPABILITIES): this is not
// a restriction on previously-had access, there was never any access to
// restrict.
const TRIAL_NOT_STARTED_CAPABILITIES: EntitlementCapabilities = {
  hasOperationalAccess: false,
  isReadOnly: false,
  canManageBilling: true,
  canViewExistingData: false,
  canExportData: false,
  canMutateOperationalData: false,
  canUseJobTracking: false,
  canUsePublicBooking: false,
  canSendNotifications: false,
};

// Exactly "30 calendar days" expressed as a fixed millisecond duration,
// matching the same precedent already established for the payment-failure
// grace window (GRACE_PERIOD_DAYS in lib/stripeWebhook.ts) -- an instant
// comparison against a stored timestamp, not a timezone-sensitive
// calendar-date computation. Exported so tests and any future caller share
// exactly one definition of "30 days," never a second duplicated constant.
export const READ_ONLY_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

interface DiagnosticFields {
  billingMode?: "internal" | "stripe" | null;
  stripeStatus?: string | null;
  trialEnd?: Date | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  graceEndsAt?: Date | null;
  restrictedSince?: Date | null;
  readOnlyEndsAt?: Date | null;
}

function buildResult(
  state: EntitlementState,
  reason: EntitlementReason,
  capabilities: EntitlementCapabilities,
  fields: DiagnosticFields = {}
): EntitlementResult {
  return {
    state,
    reason,
    ...capabilities,
    graceEndsAt: fields.graceEndsAt ?? null,
    restrictedSince: fields.restrictedSince ?? null,
    readOnlyEndsAt: fields.readOnlyEndsAt ?? null,
    billingMode: fields.billingMode ?? null,
    stripeStatus: fields.stripeStatus ?? null,
    trialEnd: fields.trialEnd ?? null,
    currentPeriodEnd: fields.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: fields.cancelAtPeriodEnd ?? false,
  };
}

function isValidDate(d: Date | null): d is Date {
  return d !== null && !Number.isNaN(d.getTime());
}

// Shared 30-day timed-restriction math for every status family that has a
// reliable boundary timestamp (canceled_at, graceUntil, accessEndedAt).
// Returns null when the boundary itself isn't usable -- the caller must
// fail closed to "malformed" rather than guess a start time. The boundary
// convention matches the pre-existing past_due grace check exactly: full
// read-only viewing for every instant strictly before readOnlyEndsAt;
// locked AT that instant and every instant after.
function resolveTimedRestriction(now: Date, boundary: Date | null): { locked: boolean; readOnlyEndsAt: Date } | null {
  if (!isValidDate(boundary)) return null;
  const readOnlyEndsAt = new Date(boundary.getTime() + READ_ONLY_PERIOD_MS);
  return { locked: now.getTime() >= readOnlyEndsAt.getTime(), readOnlyEndsAt };
}

// Fail-closed result for the "we have no usable subscription data at all"
// cases (no row / query error). Exported so lib/entitlementServer.ts can
// produce the same shape for a query failure without duplicating the field
// list.
//
// Phase 5.6F-R1: these two reasons now produce genuinely DIFFERENT states,
// not just different reasons sharing one state -- "no_subscription" (a
// genuine missing row) never had legitimate access to begin with and is
// locked. "query_error" (a transient read failure) is NOT a lifecycle
// determination at all -- it's "we don't currently know," and is reported
// as its own dedicated "service_unavailable" state so callers can never
// mistake a transient infrastructure failure for an authoritative
// locked/read-only outcome (see the module header comment and
// SERVICE_UNAVAILABLE_CAPABILITIES above).
export function noDataResult(reason: "no_subscription" | "query_error"): EntitlementResult {
  if (reason === "query_error") {
    return buildResult("service_unavailable", "query_error", SERVICE_UNAVAILABLE_CAPABILITIES);
  }
  return buildResult("no_subscription", "no_subscription", LOCKED_CAPABILITIES);
}

// Deterministic. Given the same (subscription, now), always returns the
// same result — no I/O, no clock reads of its own. Does not know about
// workspace identity or the demo bypass — see resolveWorkspaceEntitlement
// below for the workspace-aware entry point.
export function resolveEntitlement(subscription: SubscriptionRecord | null, now: Date): EntitlementResult {
  if (!subscription) {
    return noDataResult("no_subscription");
  }

  const { billingMode, stripeStatus, trialEnd, currentPeriodEnd, graceUntil, cancelAtPeriodEnd, canceledAt, accessEndedAt, trialConsumedAt, hasStripeIdentity } =
    subscription;

  if (billingMode === "internal") {
    return buildResult("internal", "internal", FULL_CAPABILITIES, { billingMode });
  }

  if (billingMode !== "stripe") {
    // The subscriptions_internal_mode_has_no_stripe_data CHECK constraint
    // (migration 015) and the DB's billing_mode CHECK should make this
    // unreachable, but a resolver that trusts its caller unconditionally is
    // exactly how "grant access by accident" bugs happen. Fail closed.
    return buildResult("malformed", "malformed_billing_mode", LOCKED_CAPABILITIES, {
      billingMode,
      stripeStatus,
      trialEnd,
      currentPeriodEnd,
      cancelAtPeriodEnd,
    });
  }

  const diagnostics: DiagnosticFields = { billingMode, stripeStatus, trialEnd, currentPeriodEnd, cancelAtPeriodEnd };

  switch (stripeStatus) {
    case "trialing":
      return buildResult("trialing", "trialing", FULL_CAPABILITIES, diagnostics);

    case "active":
      return buildResult("active", "active", FULL_CAPABILITIES, diagnostics);

    case "past_due": {
      // The full-access/grace check is unchanged from Phase 5.4A/5.6E:
      // access is full for every instant strictly before graceUntil.
      if (!isValidDate(graceUntil)) {
        return buildResult("malformed", "malformed_grace_date", LOCKED_CAPABILITIES, diagnostics);
      }
      if (now.getTime() < graceUntil.getTime()) {
        return buildResult("past_due_grace", "past_due_in_grace", FULL_CAPABILITIES, { ...diagnostics, graceEndsAt: graceUntil });
      }
      // Phase 5.6F: grace has expired -- start the same 30-day read-only
      // clock every other timed state uses, anchored to the exact grace
      // boundary (graceUntil is already a reliable, validated timestamp;
      // no new column needed for this status).
      const timed = resolveTimedRestriction(now, graceUntil)!;
      return buildResult(
        timed.locked ? "past_due_locked" : "past_due_read_only",
        timed.locked ? "past_due_locked" : "past_due_read_only",
        timed.locked ? LOCKED_CAPABILITIES : RESTRICTED_CAPABILITIES,
        { ...diagnostics, graceEndsAt: graceUntil, restrictedSince: graceUntil, readOnlyEndsAt: timed.readOnlyEndsAt }
      );
    }

    case "canceled": {
      // Phase 5.6E, unchanged: the boundary is canceled_at -- Stripe sets
      // it at the exact instant the subscription actually stops, which is
      // what "trial or paid access ends" means for both the trial-expiry
      // and paid-cancellation approved scenarios.
      const timed = resolveTimedRestriction(now, canceledAt);
      if (!timed) {
        return buildResult("malformed", "malformed_canceled_date", LOCKED_CAPABILITIES, diagnostics);
      }
      return buildResult(
        timed.locked ? "canceled_locked" : "canceled_read_only",
        timed.locked ? "canceled_locked" : "canceled_read_only",
        timed.locked ? LOCKED_CAPABILITIES : RESTRICTED_CAPABILITIES,
        { ...diagnostics, restrictedSince: canceledAt, readOnlyEndsAt: timed.readOnlyEndsAt }
      );
    }

    case "unpaid": {
      // Phase 5.6F: unpaid has no Stripe-provided boundary -- accessEndedAt
      // is this app's own bookkeeping (migrations/016), written by the
      // webhook handler the moment this status is first observed. Missing/
      // invalid data fails closed to LOCKED (not the gentler RESTRICTED
      // malformed_canceled_date treatment) -- see the module header
      // comment for why this one is stricter: there is no legitimate way
      // for a correctly-functioning system to have a 'canceled' subscription
      // without canceled_at, but a pre-migration or webhook-missed 'unpaid'
      // row without accessEndedAt is an expected, real possibility, not
      // just corruption -- and this module has zero evidence of when
      // read-only should have started for it.
      const timed = resolveTimedRestriction(now, accessEndedAt);
      if (!timed) {
        return buildResult("malformed", "malformed_access_ended_date", LOCKED_CAPABILITIES, diagnostics);
      }
      return buildResult(
        timed.locked ? "unpaid_locked" : "unpaid_read_only",
        timed.locked ? "unpaid_locked" : "unpaid_read_only",
        timed.locked ? LOCKED_CAPABILITIES : RESTRICTED_CAPABILITIES,
        { ...diagnostics, restrictedSince: accessEndedAt, readOnlyEndsAt: timed.readOnlyEndsAt }
      );
    }

    case "paused": {
      // Identical shape to unpaid -- see that branch's comment.
      const timed = resolveTimedRestriction(now, accessEndedAt);
      if (!timed) {
        return buildResult("malformed", "malformed_access_ended_date", LOCKED_CAPABILITIES, diagnostics);
      }
      return buildResult(
        timed.locked ? "paused_locked" : "paused_read_only",
        timed.locked ? "paused_locked" : "paused_read_only",
        timed.locked ? LOCKED_CAPABILITIES : RESTRICTED_CAPABILITIES,
        { ...diagnostics, restrictedSince: accessEndedAt, readOnlyEndsAt: timed.readOnlyEndsAt }
      );
    }

    case "incomplete":
      // Phase 5.6F: never established valid entitlement -- locked
      // immediately, no 30-day read-only phase (there is no prior full
      // access to grace from).
      return buildResult("incomplete", "incomplete", LOCKED_CAPABILITIES, diagnostics);

    case "incomplete_expired":
      return buildResult("incomplete_expired", "incomplete_expired", LOCKED_CAPABILITIES, diagnostics);

    case null:
    case undefined:
    case "": {
      // A 'stripe'-mode row with no usable status yet splits into two
      // genuinely different cases (Phase 5.7D-R11):
      //
      //   1. A brand-new workspace that has never been to Checkout at
      //      all -- provision_owner_workspace (migrations/017-018)
      //      inserts the subscriptions row with billing_mode='stripe'
      //      and every other column left at its default/null. This is
      //      NOT corruption; it's the normal, expected shape of a
      //      first-time customer who hasn't started Checkout yet, and
      //      must be offered the trial invitation, not "reactivate."
      //
      //   2. Every other reason a status could be missing (a webhook
      //      race immediately after Checkout-session creation but before
      //      checkout.session.completed arrives, a row that once had
      //      real Stripe activity now in an unexpected state, etc.) --
      //      still fails closed to "malformed" exactly as before.
      //
      // The distinguishing evidence required is deliberately narrow and
      // conservative: ALL of trialConsumedAt/hasStripeIdentity/
      // canceledAt/accessEndedAt/currentPeriodEnd must confirm "nothing
      // has ever happened to this row." Any single one of them
      // indicating prior activity falls back to "malformed" -- this
      // never widens what already fails closed, it only narrows the one
      // specific case that was being MISCLASSIFIED as malformed.
      const neverWentToCheckout = trialConsumedAt === null && !hasStripeIdentity;
      const neverHadAccessBefore = !isValidDate(canceledAt) && !isValidDate(accessEndedAt) && !isValidDate(currentPeriodEnd);
      if (neverWentToCheckout && neverHadAccessBefore) {
        return buildResult("trial_not_started", "trial_not_started", TRIAL_NOT_STARTED_CAPABILITIES, diagnostics);
      }
      return buildResult("malformed", "malformed_missing_status", LOCKED_CAPABILITIES, diagnostics);
    }

    default:
      // Any Stripe status string this resolver doesn't yet recognize
      // (including a future status Stripe might add). Fail closed rather
      // than guess.
      return buildResult("malformed", "malformed_unknown_status", LOCKED_CAPABILITIES, diagnostics);
  }
}

// Workspace-aware entry point — the one function downstream server code
// should actually call. Wraps resolveEntitlement() with the demo/tester
// bypass so callers get one normalized result without needing to
// separately special-case the demo workspace.
//
// The demo bypass is matched on workspaceId ALONE, never on any role/user
// hint — entitlement in this app is a workspace property, not a user
// property, and keying the bypass on workspaceId means there is no input
// this function accepts that could trick a normal Stripe-backed workspace
// into demo/internal access: the only way to get the "demo" state is for
// workspaceId to be exactly DEMO_WORKSPACE_ID, a fixed server-side constant
// never sourced from request input (see lib/workspace.ts and lib/session.ts
// — a session's workspaceId is minted server-side at login, never accepted
// from the browser).
//
// When workspaceId is the demo workspace, the passed-in subscription is
// ignored entirely, even if one happened to be non-null — demo access does
// not depend on any Stripe/subscription data being present, correct, or
// even queried (see fetchEntitlementForWorkspace's matching short-circuit,
// which skips the DB read too).
export function resolveWorkspaceEntitlement(
  workspaceId: string,
  subscription: SubscriptionRecord | null,
  now: Date
): EntitlementResult {
  if (workspaceId === DEMO_WORKSPACE_ID) {
    return buildResult("demo", "demo_workspace", FULL_CAPABILITIES);
  }
  return resolveEntitlement(subscription, now);
}
