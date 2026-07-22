// Pure billing-entitlement resolver. No Supabase, no Next.js, no env vars,
// no Stripe SDK calls — deliberately dependency-free so it can be
// unit-tested without a database or network and safely imported into future
// UI code for typing. Server-only data access (fetching a workspace's
// subscriptions row) lives in lib/entitlementServer.ts, which calls
// resolveWorkspaceEntitlement() below.
//
// This is Phase 5.4A: the canonical entitlement MODEL only. Nothing in the
// app calls this to gate a route or hide UI yet (requireFullAccess in
// lib/entitlementServer.ts remains uncalled from any route) — that's a
// later phase, once this model itself is reviewed and approved.
//
// Approved product policy (Phase 5.4A), implemented exactly by the switch
// below:
//
//   Full operational access:
//     - billing_mode = internal
//     - demo/tester workspace
//     - Stripe status = trialing
//     - Stripe status = active
//     - Stripe status = past_due, while still inside the 3-day grace period
//
//   Restricted/read-only access (every other reachable state, including
//   unpaid/incomplete/incomplete_expired/canceled/paused/no-subscription/
//   malformed data): owner can still log in, view all existing records,
//   export data, and reach Settings/billing/reactivation. Nothing can be
//   created, edited, deleted, cancelled, or rescheduled; Job Tracking,
//   public booking, and notifications are paused. No record is ever
//   deleted, detached, reassigned, or hidden by this module — it only
//   reports what the caller is allowed to do next.
//
// Deliberate simplification vs. the pre-5.4A resolver: `active` and
// `trialing` are now unconditionally full access, with no local
// trialEnd/currentPeriodEnd boundary check. Stripe itself keeps the status
// string as "active"/"trialing" for the entire duration those states are
// meant to grant access — a local time check duplicated that transition
// instead of trusting it, which is exactly the "second competing grace
// calculation" the approved policy says to avoid. The 3-day past_due grace
// window is the only locally-computed time boundary in this module.
// Likewise, `canceled` is now unconditionally restricted (the approved
// policy's full-access list does not include it), where the prior resolver
// granted access through the remainder of a cancel-at-period-end window.

// Explicit relative specifier with its literal extension (rather than the
// "@/lib/workspace" alias used everywhere else in this codebase) so this
// file stays resolvable by Node's native test runner with zero bundler/
// loader tooling — matching its own "dependency-free, unit-testable
// without a database" design goal one step further. Safe: workspace.ts is
// itself two constants with no further imports.
import { DEMO_WORKSPACE_ID } from "./workspace.ts";

// The canonical, coarse-grained bucket every downstream consumer should
// switch on. This is the "at minimum" list from the Phase 5.4A audit,
// expressed as a closed union so an unhandled state is a compile error, not
// a silent fallthrough.
export type EntitlementState =
  | "internal"
  | "demo"
  | "trialing"
  | "active"
  | "past_due_grace"
  | "past_due_expired"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "canceled"
  | "paused"
  | "no_subscription"
  | "malformed";

// A finer-grained diagnostic code — mostly one-to-one with EntitlementState,
// but splits a few buckets that share the same capability profile and UI
// treatment yet have different root causes worth distinguishing in logs
// (e.g. "no_subscription" vs "query_error" both resolve to the same
// restricted state, but one is "no row" and the other is "couldn't ask").
export type EntitlementReason =
  | "internal"
  | "demo_workspace"
  | "trialing"
  | "active"
  | "past_due_in_grace"
  | "past_due_grace_expired"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "canceled"
  | "paused"
  | "no_subscription"
  | "query_error"
  | "malformed_billing_mode"
  | "malformed_missing_status"
  | "malformed_unknown_status"
  | "malformed_grace_date";

// Named per-capability flags rather than a single access level, so a
// downstream route/component checks exactly the permission it needs instead
// of re-deriving "does read-only mean I can do this?" from a single enum.
// Under the approved Phase 5.4A policy every capability moves in lockstep
// with hasOperationalAccess (there is no state today that grants some
// operational capabilities but not others) — the fields are still kept
// distinct, not collapsed into one boolean, so a future policy change (e.g.
// notifications gated separately from mutations) only touches the
// capability profile below, not every call site's field name.
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
  // Populated only for past_due_grace / past_due_expired — the one state
  // family with a real time boundary. Null everywhere else.
  graceEndsAt: Date | null;
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
// anywhere in the grace-boundary comparison below.
export interface SubscriptionRecord {
  billingMode: "internal" | "stripe";
  stripeStatus: string | null;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
  graceUntil: Date | null;
  cancelAtPeriodEnd: boolean;
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

// Billing/viewing/export/login stay allowed in every restricted state —
// the owner must never be trapped outside the app with no way to pay, and
// existing business records must remain visible/exportable even when
// nothing new can be created. This is the one restricted profile used for
// every non-full state below, including error/malformed cases, so a
// temporary data problem degrades to "read-only," never to "locked out."
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

interface DiagnosticFields {
  billingMode?: "internal" | "stripe" | null;
  stripeStatus?: string | null;
  trialEnd?: Date | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  graceEndsAt?: Date | null;
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

// Fail-closed result for the "we have no usable subscription data at all"
// cases (no row / query error) — a workspace with no row is never granted
// access. Exported so lib/entitlementServer.ts can produce the same shape
// for a query failure without duplicating the field list.
export function noDataResult(reason: "no_subscription" | "query_error"): EntitlementResult {
  return buildResult("no_subscription", reason, RESTRICTED_CAPABILITIES);
}

// Deterministic. Given the same (subscription, now), always returns the
// same result — no I/O, no clock reads of its own. Does not know about
// workspace identity or the demo bypass — see resolveWorkspaceEntitlement
// below for the workspace-aware entry point. Kept exported/standalone
// because most of the Phase 5.4A test matrix is exactly "given this
// subscription row and this instant, what's the result," independent of
// any workspace concept.
export function resolveEntitlement(subscription: SubscriptionRecord | null, now: Date): EntitlementResult {
  if (!subscription) {
    return noDataResult("no_subscription");
  }

  const { billingMode, stripeStatus, trialEnd, currentPeriodEnd, graceUntil, cancelAtPeriodEnd } = subscription;

  if (billingMode === "internal") {
    return buildResult("internal", "internal", FULL_CAPABILITIES, { billingMode });
  }

  if (billingMode !== "stripe") {
    // The subscriptions_internal_mode_has_no_stripe_data CHECK constraint
    // (migration 015) and the DB's billing_mode CHECK should make this
    // unreachable, but a resolver that trusts its caller unconditionally is
    // exactly how "grant access by accident" bugs happen. Fail closed.
    return buildResult("malformed", "malformed_billing_mode", RESTRICTED_CAPABILITIES, {
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
      // The one locally-computed time boundary in this module. Comparison
      // is an exact instant comparison (now.getTime() < graceUntil.getTime()):
      // access is full for every instant strictly before graceUntil, and
      // already restricted AT the boundary instant itself and every instant
      // after — the boundary is exclusive of full access / inclusive of
      // restriction. graceUntil is set by the webhook handler to
      // now + GRACE_PERIOD_DAYS(3 days) at the moment a payment fails (see
      // lib/stripeWebhook.ts) — this module does not recompute or duplicate
      // that 3-day arithmetic, it only compares against the stored value.
      if (!isValidDate(graceUntil)) {
        return buildResult("malformed", "malformed_grace_date", RESTRICTED_CAPABILITIES, diagnostics);
      }
      const inGrace = now.getTime() < graceUntil.getTime();
      return buildResult(
        inGrace ? "past_due_grace" : "past_due_expired",
        inGrace ? "past_due_in_grace" : "past_due_grace_expired",
        inGrace ? FULL_CAPABILITIES : RESTRICTED_CAPABILITIES,
        { ...diagnostics, graceEndsAt: graceUntil }
      );
    }

    case "canceled":
      return buildResult("canceled", "canceled", RESTRICTED_CAPABILITIES, diagnostics);

    case "paused":
      return buildResult("paused", "paused", RESTRICTED_CAPABILITIES, diagnostics);

    case "unpaid":
      return buildResult("unpaid", "unpaid", RESTRICTED_CAPABILITIES, diagnostics);

    case "incomplete":
      return buildResult("incomplete", "incomplete", RESTRICTED_CAPABILITIES, diagnostics);

    case "incomplete_expired":
      return buildResult("incomplete_expired", "incomplete_expired", RESTRICTED_CAPABILITIES, diagnostics);

    case null:
    case undefined:
    case "":
      // A 'stripe'-mode row before its first webhook has landed (e.g.
      // immediately after checkout-session creation, before
      // checkout.session.completed arrives) — a real, expected transient
      // state, not corruption, but there is no usable status yet, so it
      // fails closed the same as any other incomplete billing state.
      return buildResult("malformed", "malformed_missing_status", RESTRICTED_CAPABILITIES, diagnostics);

    default:
      // Any Stripe status string this resolver doesn't yet recognize
      // (including a future status Stripe might add). Fail closed rather
      // than guess.
      return buildResult("malformed", "malformed_unknown_status", RESTRICTED_CAPABILITIES, diagnostics);
  }
}

// Workspace-aware entry point — the one function downstream server code
// should actually call. Wraps resolveEntitlement() with the demo/tester
// bypass so callers get one normalized result without needing to
// separately special-case the demo workspace.
//
// The demo bypass is matched on workspaceId ALONE, never on any role/user
// hint — entitlement in this app is a workspace property, not a user
// property (approved policy item 4), and keying the bypass on workspaceId
// means there is no input this function accepts that could trick a normal
// Stripe-backed workspace into demo/internal access: the only way to get
// the "demo" state is for workspaceId to be exactly DEMO_WORKSPACE_ID, a
// fixed server-side constant never sourced from request input (see
// lib/workspace.ts and lib/session.ts — a session's workspaceId is minted
// server-side at login, never accepted from the browser).
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
