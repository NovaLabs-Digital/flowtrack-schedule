// Phase 5.4A (original) / Phase 5.6F (current): focused automated tests for
// the canonical entitlement resolver (lib/entitlement.ts). Pure unit tests
// — no Supabase, no Stripe, no Next.js — run directly under Node's built-in
// test runner:
//
//   node --test lib/entitlement.test.ts
//   (or: npm test)
//
// Relative imports below use their literal .ts extension so this file
// resolves under plain `node --test` with zero bundler/loader tooling,
// matching lib/entitlement.ts's own dependency-free design goal.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEntitlement,
  resolveWorkspaceEntitlement,
  noDataResult,
  READ_ONLY_PERIOD_MS,
  type SubscriptionRecord,
} from "./entitlement.ts";
import { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } from "./workspace.ts";

const NOW = new Date("2026-07-21T12:00:00.000Z");

function stripeRecord(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    billingMode: "stripe",
    stripeStatus: "active",
    trialEnd: null,
    currentPeriodEnd: null,
    graceUntil: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    accessEndedAt: null,
    // Phase 5.7D-R11: defaults represent "a row that has had real Stripe
    // activity at some point" (hasStripeIdentity: true) -- deliberately
    // NOT the genuinely pristine, never-checked-out shape, so every
    // existing fixture in this file that overrides only stripeStatus
    // keeps its exact prior meaning/labeling unchanged. Tests for the new
    // "trial_not_started" state explicitly override both fields to
    // construct a truly pristine record -- see that describe block below.
    trialConsumedAt: null,
    hasStripeIdentity: true,
    ...overrides,
  };
}

// Phase 5.7D-R11: the exact shape provision_owner_workspace (migrations/
// 017-018) leaves a brand-new workspace's subscriptions row in --
// billing_mode='stripe' and every other column at its column default
// (null/false). Used only by the "trial_not_started" describe block below.
function pristineStripeRecord(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return stripeRecord({
    stripeStatus: null,
    trialConsumedAt: null,
    hasStripeIdentity: false,
    canceledAt: null,
    accessEndedAt: null,
    currentPeriodEnd: null,
    ...overrides,
  });
}

function assertTrialNotStarted(result: ReturnType<typeof resolveEntitlement>) {
  assert.equal(result.hasOperationalAccess, false);
  assert.equal(result.isReadOnly, false);
  assert.equal(result.canManageBilling, true, "billing/checkout must remain reachable");
  assert.equal(result.canViewExistingData, false);
  assert.equal(result.canExportData, false);
  assert.equal(result.canMutateOperationalData, false);
  assert.equal(result.canUseJobTracking, false);
  assert.equal(result.canUsePublicBooking, false);
  assert.equal(result.canSendNotifications, false);
}

function assertFullAccess(result: ReturnType<typeof resolveEntitlement>) {
  assert.equal(result.hasOperationalAccess, true);
  assert.equal(result.isReadOnly, false);
  assert.equal(result.canManageBilling, true);
  assert.equal(result.canViewExistingData, true);
  assert.equal(result.canExportData, true);
  assert.equal(result.canMutateOperationalData, true);
  assert.equal(result.canUseJobTracking, true);
  assert.equal(result.canUsePublicBooking, true);
  assert.equal(result.canSendNotifications, true);
}

// "Read-only": the 30-day window (or the one query_error carve-out) --
// billing/view/export remain allowed, everything operational is denied.
function assertRestricted(result: ReturnType<typeof resolveEntitlement>) {
  assert.equal(result.hasOperationalAccess, false);
  assert.equal(result.isReadOnly, true);
  assert.equal(result.canManageBilling, true);
  assert.equal(result.canViewExistingData, true);
  assert.equal(result.canExportData, true);
  assert.equal(result.canMutateOperationalData, false);
  assert.equal(result.canUseJobTracking, false);
  assert.equal(result.canUsePublicBooking, false);
  assert.equal(result.canSendNotifications, false);
}

// "Locked": strictly more restricted than read-only -- viewing and
// exporting existing data are ALSO denied. Used for every "_locked" state,
// plus incomplete/incomplete_expired/no_subscription (reason
// "no_subscription")/every malformed_* reason (Phase 5.6F).
function assertLocked(result: ReturnType<typeof resolveEntitlement>) {
  assert.equal(result.hasOperationalAccess, false);
  assert.equal(result.isReadOnly, true);
  assert.equal(result.canManageBilling, true, "billing/reactivation must remain reachable even when locked");
  assert.equal(result.canViewExistingData, false);
  assert.equal(result.canExportData, false);
  assert.equal(result.canMutateOperationalData, false);
  assert.equal(result.canUseJobTracking, false);
  assert.equal(result.canUsePublicBooking, false);
  assert.equal(result.canSendNotifications, false);
}

describe("full operational access states", () => {
  test("billing_mode = internal -> full access", () => {
    const result = resolveEntitlement({ ...stripeRecord(), billingMode: "internal", stripeStatus: null }, NOW);
    assertFullAccess(result);
    assert.equal(result.state, "internal");
    assert.equal(result.reason, "internal");
  });

  test("demo/tester workspace -> full access, independent of any subscription data", () => {
    const result = resolveWorkspaceEntitlement(DEMO_WORKSPACE_ID, null, NOW);
    assertFullAccess(result);
    assert.equal(result.state, "demo");
    assert.equal(result.reason, "demo_workspace");
  });

  test("demo/tester workspace -> full access even if a stray subscription row is passed in", () => {
    // The demo bypass must ignore subscription data entirely, not merely
    // default to it being absent.
    const result = resolveWorkspaceEntitlement(
      DEMO_WORKSPACE_ID,
      stripeRecord({ stripeStatus: "canceled" }),
      NOW
    );
    assertFullAccess(result);
    assert.equal(result.state, "demo");
    // Demo access carries no Stripe identifiers/status at all.
    assert.equal(result.stripeStatus, null);
    assert.equal(result.billingMode, null);
  });

  test("trialing -> full", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "trialing" }), NOW);
    assertFullAccess(result);
    assert.equal(result.state, "trialing");
  });

  test("active -> full", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "active" }), NOW);
    assertFullAccess(result);
    assert.equal(result.state, "active");
  });

  test("past_due, 1ms before grace expiry -> full", () => {
    const graceUntil = new Date(NOW.getTime() + 1);
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "past_due", graceUntil }), NOW);
    assertFullAccess(result);
    assert.equal(result.state, "past_due_grace");
    assert.equal(result.reason, "past_due_in_grace");
    assert.equal(result.graceEndsAt?.getTime(), graceUntil.getTime());
  });
});

// Shared boundary-matrix runner: every timed-restriction status family
// (past_due, canceled, unpaid, paused) follows the exact same 30-day
// read-only-then-locked math off its own reliable boundary timestamp
// (lib/entitlement.ts's resolveTimedRestriction). Running the identical
// four-instant matrix against all four families is what actually proves
// they share one implementation, not four independently-hand-tuned ones.
function timedBoundaryMatrix(
  label: string,
  buildRecord: (boundary: Date) => SubscriptionRecord,
  readOnlyState: string,
  lockedState: string,
  // past_due's boundary (graceUntil) doubles as the full-access/grace gate
  // itself -- a "future" graceUntil means still-in-grace (full access), a
  // fundamentally different scenario from canceled_at/accessEndedAt's
  // "future boundary" clock-skew edge case. Skip that one sub-test for
  // past_due; its full-access-during-grace behavior is already covered by
  // the "full operational access states" describe block above.
  includeFutureBoundaryCase = true
) {
  describe(`${label} 30-day read-only/locked boundary (exact instant)`, () => {
    test("1ms before boundary + 30 days -> read-only (still viewable/exportable)", () => {
      const boundary = new Date(NOW.getTime() - READ_ONLY_PERIOD_MS + 1);
      const result = resolveEntitlement(buildRecord(boundary), NOW);
      assertRestricted(result);
      assert.equal(result.state, readOnlyState);
      assert.equal(result.restrictedSince?.getTime(), boundary.getTime());
      assert.equal(result.readOnlyEndsAt?.getTime(), boundary.getTime() + READ_ONLY_PERIOD_MS);
    });

    test("now === boundary + 30 days exactly -> locked (boundary instant is already locked)", () => {
      const boundary = new Date(NOW.getTime() - READ_ONLY_PERIOD_MS);
      const result = resolveEntitlement(buildRecord(boundary), NOW);
      assertLocked(result);
      assert.equal(result.state, lockedState);
      assert.equal(result.reason, lockedState);
    });

    test("1ms after boundary + 30 days -> locked", () => {
      const boundary = new Date(NOW.getTime() - READ_ONLY_PERIOD_MS - 1);
      const result = resolveEntitlement(buildRecord(boundary), NOW);
      assertLocked(result);
      assert.equal(result.state, lockedState);
    });

    if (includeFutureBoundaryCase) {
      test("boundary in the future (clock skew edge case) -> still read-only, never locked", () => {
        const boundary = new Date(NOW.getTime() + 1000);
        const result = resolveEntitlement(buildRecord(boundary), NOW);
        assertRestricted(result);
        assert.equal(result.state, readOnlyState);
      });
    }
  });
}

timedBoundaryMatrix(
  "canceled_at (canceled)",
  (boundary) => stripeRecord({ stripeStatus: "canceled", canceledAt: boundary }),
  "canceled_read_only",
  "canceled_locked"
);

timedBoundaryMatrix(
  "graceUntil (past_due, post-grace)",
  (boundary) => stripeRecord({ stripeStatus: "past_due", graceUntil: boundary }),
  "past_due_read_only",
  "past_due_locked",
  false
);

timedBoundaryMatrix(
  "accessEndedAt (unpaid)",
  (boundary) => stripeRecord({ stripeStatus: "unpaid", accessEndedAt: boundary }),
  "unpaid_read_only",
  "unpaid_locked"
);

timedBoundaryMatrix(
  "accessEndedAt (paused)",
  (boundary) => stripeRecord({ stripeStatus: "paused", accessEndedAt: boundary }),
  "paused_read_only",
  "paused_locked"
);

describe("canceled -> currentPeriodEnd is irrelevant to the boundary (canceled_at is authoritative)", () => {
  test("a far-future currentPeriodEnd does not extend or shorten the canceled_at-driven window", () => {
    const canceledAt = new Date(NOW.getTime() - 1000);
    const result = resolveEntitlement(
      stripeRecord({
        stripeStatus: "canceled",
        canceledAt,
        currentPeriodEnd: new Date(NOW.getTime() + 1000 * 60 * 60 * 24 * 10),
      }),
      NOW
    );
    assertRestricted(result);
    assert.equal(result.state, "canceled_read_only");
    assert.equal(result.restrictedSince?.getTime(), canceledAt.getTime());
    assert.equal(result.readOnlyEndsAt?.getTime(), canceledAt.getTime() + READ_ONLY_PERIOD_MS);
  });
});

describe("a resubscribed workspace clears every timed restriction", () => {
  test("status active again, canceled_at cleared -> full access, no lingering read-only/locked state", () => {
    // Mirrors what the webhook handler actually writes on resubscription:
    // buildSubscriptionPatchFromStripeSubscription sets canceled_at from
    // the fresh Stripe subscription object (null for a brand new
    // trialing/active subscription), and computeAccessEndedPatchField
    // clears access_ended_at unconditionally on recovery to active/trialing
    // -- see lib/stripeWebhook.ts.
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "active", canceledAt: null, accessEndedAt: null }), NOW);
    assertFullAccess(result);
    assert.equal(result.state, "active");
    assert.equal(result.restrictedSince, null);
    assert.equal(result.readOnlyEndsAt, null);
  });
});

describe("no operational access, ever, regardless of elapsed time -- checkout never completed or never existed", () => {
  test("incomplete -> locked immediately, no 30-day read-only phase", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "incomplete" }), NOW);
    assertLocked(result);
    assert.equal(result.state, "incomplete");
    assert.equal(result.reason, "incomplete");
  });

  test("incomplete_expired -> locked immediately, no 30-day read-only phase", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "incomplete_expired" }), NOW);
    assertLocked(result);
    assert.equal(result.state, "incomplete_expired");
  });

  test("no subscription row on a Stripe-billed workspace -> locked, fails closed", () => {
    const result = resolveEntitlement(null, NOW);
    assertLocked(result);
    assert.equal(result.state, "no_subscription");
    assert.equal(result.reason, "no_subscription");
  });

});

describe("Phase 5.6F-R1: service_unavailable is its own state, never no_subscription/locked/read-only", () => {
  const result = noDataResult("query_error");

  test("state is 'service_unavailable', reason is 'query_error' -- structurally distinct from a genuine no_subscription row", () => {
    assert.equal(result.state, "service_unavailable");
    assert.equal(result.reason, "query_error");
    assert.notEqual(result.state, "no_subscription");
  });

  test("grants no view/export/mutation/notification/job-tracking/booking capability", () => {
    assert.equal(result.hasOperationalAccess, false);
    assert.equal(result.canViewExistingData, false);
    assert.equal(result.canExportData, false);
    assert.equal(result.canMutateOperationalData, false);
    assert.equal(result.canUseJobTracking, false);
    assert.equal(result.canUsePublicBooking, false);
    assert.equal(result.canSendNotifications, false);
  });

  test("billing/reactivation-path capability stays true, matching the locked profile (not that any route currently checks it)", () => {
    assert.equal(result.canManageBilling, true);
  });

  test("carries no lifecycle timestamp -- a transient read failure must never look like an authoritative boundary", () => {
    assert.equal(result.graceEndsAt, null);
    assert.equal(result.restrictedSince, null);
    assert.equal(result.readOnlyEndsAt, null);
    assert.equal(result.billingMode, null);
    assert.equal(result.stripeStatus, null);
  });

  test("a genuine no_subscription row (real missing row, not a query failure) remains its own distinct outcome, unaffected by this change", () => {
    const genuine = resolveEntitlement(null, NOW);
    assert.equal(genuine.state, "no_subscription");
    assert.equal(genuine.reason, "no_subscription");
    assertLocked(genuine);
  });

  test("recovery: a later successful entitlement read (not noDataResult at all) returns the workspace's real lifecycle state, independent of any prior query_error", () => {
    // Nothing about resolveEntitlement's own logic is stateful across
    // calls -- a fresh, successful read simply resolves normally. This
    // proves there is no cached/sticky "service_unavailable" flag anywhere
    // in this module.
    const recovered = resolveEntitlement(stripeRecord({ stripeStatus: "active" }), NOW);
    assertFullAccess(recovered);
    assert.equal(recovered.state, "active");
  });
});

describe("malformed billing state -> locked, never full, never a guessed read-only window", () => {
  // Phase 5.7D-R11: these two use stripeRecord()'s default
  // hasStripeIdentity: true -- a row with a null/empty status that HAS a
  // Stripe customer/subscription attached is never the pristine
  // first-time case (see pristineStripeRecord below); it stays malformed
  // exactly as before.
  test("stripe-mode row with null status but an attached Stripe identity (pending, before first webhook) -> locked, not the first-time trial state", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: null }), NOW);
    assertLocked(result);
    assert.equal(result.state, "malformed");
    assert.equal(result.reason, "malformed_missing_status");
  });

  test("stripe-mode row with empty-string status and an attached Stripe identity -> locked", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "" }), NOW);
    assertLocked(result);
    assert.equal(result.state, "malformed");
  });

  test("unrecognized Stripe status string -> locked, not guessed as full", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "some_future_stripe_status" }), NOW);
    assertLocked(result);
    assert.equal(result.state, "malformed");
    assert.equal(result.reason, "malformed_unknown_status");
  });

  test("past_due with a missing grace date -> locked, not full", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "past_due", graceUntil: null }), NOW);
    assertLocked(result);
    assert.equal(result.state, "malformed");
    assert.equal(result.reason, "malformed_grace_date");
  });

  test("past_due with an unparseable grace date (Invalid Date) -> locked, not full", () => {
    const result = resolveEntitlement(
      stripeRecord({ stripeStatus: "past_due", graceUntil: new Date("not-a-real-date") }),
      NOW
    );
    assertLocked(result);
    assert.equal(result.state, "malformed");
    assert.equal(result.reason, "malformed_grace_date");
  });

  test("billing_mode neither internal nor stripe -> locked, fails closed", () => {
    const result = resolveEntitlement(
      { ...stripeRecord(), billingMode: "not_a_real_mode" as SubscriptionRecord["billingMode"] },
      NOW
    );
    assertLocked(result);
    assert.equal(result.state, "malformed");
    assert.equal(result.reason, "malformed_billing_mode");
  });

  test("canceled with a missing canceled_at -> locked, not guessed as read-only", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "canceled", canceledAt: null }), NOW);
    assertLocked(result);
    assert.equal(result.state, "malformed");
    assert.equal(result.reason, "malformed_canceled_date");
  });

  test("canceled with an unparseable canceled_at (Invalid Date) -> locked, not full", () => {
    const result = resolveEntitlement(
      stripeRecord({ stripeStatus: "canceled", canceledAt: new Date("not-a-real-date") }),
      NOW
    );
    assertLocked(result);
    assert.equal(result.state, "malformed");
    assert.equal(result.reason, "malformed_canceled_date");
  });

  test("unpaid with a missing access_ended_at -> locked, not guessed as read-only", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "unpaid", accessEndedAt: null }), NOW);
    assertLocked(result);
    assert.equal(result.state, "malformed");
    assert.equal(result.reason, "malformed_access_ended_date");
  });

  test("paused with a missing access_ended_at -> locked, not guessed as read-only", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "paused", accessEndedAt: null }), NOW);
    assertLocked(result);
    assert.equal(result.state, "malformed");
    assert.equal(result.reason, "malformed_access_ended_date");
  });

  test("unpaid with an unparseable access_ended_at (Invalid Date) -> locked, not full", () => {
    const result = resolveEntitlement(
      stripeRecord({ stripeStatus: "unpaid", accessEndedAt: new Date("not-a-real-date") }),
      NOW
    );
    assertLocked(result);
    assert.equal(result.state, "malformed");
    assert.equal(result.reason, "malformed_access_ended_date");
  });
});

// Phase 5.7D-R11: a real production signup exposed this exact gap -- a
// brand-new workspace (billing_mode='stripe', stripe_status still null,
// never been to Checkout) was resolving to "malformed" and shown
// "reactivate your subscription... your data has been preserved," both
// false for an account that never had anything. These tests prove the
// corrected, narrowly-scoped distinction.
describe("trial_not_started -- a genuinely pristine, never-checked-out workspace (Phase 5.7D-R11)", () => {
  test("billing_mode='stripe', stripe_status=null, trial_consumed_at=null, no Stripe identity, no prior-access history -> trial_not_started, not malformed", () => {
    const result = resolveEntitlement(pristineStripeRecord(), NOW);
    assertTrialNotStarted(result);
    assert.equal(result.state, "trial_not_started");
    assert.equal(result.reason, "trial_not_started");
  });

  test("the exact same pristine shape with an empty-string status (not just null) also resolves to trial_not_started", () => {
    const result = resolveEntitlement(pristineStripeRecord({ stripeStatus: "" }), NOW);
    assertTrialNotStarted(result);
    assert.equal(result.state, "trial_not_started");
  });

  test("grants zero operational, mutation, notification, public-booking, job-tracking, or export capability -- only canManageBilling", () => {
    const result = resolveEntitlement(pristineStripeRecord(), NOW);
    assert.equal(result.hasOperationalAccess, false);
    assert.equal(result.canMutateOperationalData, false);
    assert.equal(result.canSendNotifications, false);
    assert.equal(result.canUsePublicBooking, false);
    assert.equal(result.canUseJobTracking, false);
    assert.equal(result.canExportData, false);
    assert.equal(result.canViewExistingData, false);
    assert.equal(result.canManageBilling, true);
  });

  test("trial_consumed_at set (a workspace that has consumed a trial before, however its status went null) -> stays malformed, never offered a second trial invitation", () => {
    const result = resolveEntitlement(pristineStripeRecord({ trialConsumedAt: new Date("2026-01-01T00:00:00.000Z") }), NOW);
    assertLocked(result);
    assert.equal(result.state, "malformed");
    assert.equal(result.reason, "malformed_missing_status");
  });

  test("a Stripe customer or subscription id already attached -> stays malformed, not treated as pristine", () => {
    const result = resolveEntitlement(pristineStripeRecord({ hasStripeIdentity: true }), NOW);
    assertLocked(result);
    assert.equal(result.state, "malformed");
  });

  test("a prior canceled_at -> stays malformed (this workspace had access before; a null status now is suspicious, not a first-time signal)", () => {
    const result = resolveEntitlement(pristineStripeRecord({ canceledAt: new Date("2026-01-01T00:00:00.000Z") }), NOW);
    assertLocked(result);
    assert.equal(result.state, "malformed");
  });

  test("a prior access_ended_at -> stays malformed", () => {
    const result = resolveEntitlement(pristineStripeRecord({ accessEndedAt: new Date("2026-01-01T00:00:00.000Z") }), NOW);
    assertLocked(result);
    assert.equal(result.state, "malformed");
  });

  test("a prior current_period_end -> stays malformed (evidence of a once-real billing period)", () => {
    const result = resolveEntitlement(pristineStripeRecord({ currentPeriodEnd: new Date("2026-01-01T00:00:00.000Z") }), NOW);
    assertLocked(result);
    assert.equal(result.state, "malformed");
  });

  test("a formerly canceled-and-now-locked workspace (real lifecycle, real canceled_at, status still 'canceled' -- not null) is completely unaffected by this change", () => {
    const result = resolveEntitlement(
      stripeRecord({ stripeStatus: "canceled", canceledAt: new Date(NOW.getTime() - READ_ONLY_PERIOD_MS - 1) }),
      NOW
    );
    assertLocked(result);
    assert.equal(result.state, "canceled_locked");
    assert.notEqual(result.state, "trial_not_started");
  });

  test("incomplete and incomplete_expired are unaffected -- they have a real, non-null status and never match the null/undefined/empty branch at all", () => {
    const incomplete = resolveEntitlement(stripeRecord({ stripeStatus: "incomplete" }), NOW);
    assertLocked(incomplete);
    assert.equal(incomplete.state, "incomplete");

    const expired = resolveEntitlement(stripeRecord({ stripeStatus: "incomplete_expired" }), NOW);
    assertLocked(expired);
    assert.equal(expired.state, "incomplete_expired");
  });

  test("no client-controlled field can force this state -- resolveEntitlement takes only a SubscriptionRecord already read server-side from the database, never a request body/query param/header", () => {
    // Structural proof, not a runtime one: resolveEntitlement's signature
    // is (subscription: SubscriptionRecord | null, now: Date) -- there is
    // no third "trust me" parameter, and every field on SubscriptionRecord
    // is populated exclusively by lib/entitlementServer.ts's toRecord()
    // from a service-role Supabase read (see that file), never from
    // anything a browser supplies.
    const result = resolveEntitlement(pristineStripeRecord(), NOW);
    assert.equal(result.state, "trial_not_started");
    // Reusing the exact same fixture is itself the point: the ONLY way to
    // reach this state is for the underlying stored row to genuinely be
    // pristine -- there is no flag on the input shape a caller could set
    // to fake it that isn't itself one of the four checked fields, all of
    // which come from the database, not a request.
  });

  test("demo/internal workspaces are unaffected -- they never reach this branch of resolveEntitlement at all", () => {
    const demo = resolveWorkspaceEntitlement(DEMO_WORKSPACE_ID, pristineStripeRecord(), NOW);
    assert.equal(demo.state, "demo");
    assert.notEqual(demo.state, "trial_not_started");

    const internal = resolveEntitlement({ ...pristineStripeRecord(), billingMode: "internal" }, NOW);
    assert.equal(internal.state, "internal");
    assert.notEqual(internal.state, "trial_not_started");
  });
});

describe("billing recovery and read access are preserved in every read-only state", () => {
  const readOnlyFixtures: Array<[string, SubscriptionRecord | null]> = [
    ["past_due_read_only", stripeRecord({ stripeStatus: "past_due", graceUntil: new Date(NOW.getTime() - 1) })],
    ["unpaid_read_only", stripeRecord({ stripeStatus: "unpaid", accessEndedAt: new Date(NOW.getTime() - 1000 * 60 * 60 * 24) })],
    ["paused_read_only", stripeRecord({ stripeStatus: "paused", accessEndedAt: new Date(NOW.getTime() - 1000 * 60 * 60 * 24) })],
    ["canceled_read_only", stripeRecord({ stripeStatus: "canceled", canceledAt: new Date(NOW.getTime() - 1000 * 60 * 60 * 24) })],
  ];

  for (const [label, subscription] of readOnlyFixtures) {
    test(`${label} -> owner can still manage billing, view, and export`, () => {
      const result = resolveEntitlement(subscription, NOW);
      assert.equal(result.hasOperationalAccess, false, `${label} should be restricted`);
      assert.equal(result.canManageBilling, true, `${label} must still allow billing recovery`);
      assert.equal(result.canViewExistingData, true, `${label} must still allow viewing existing data`);
      assert.equal(result.canExportData, true, `${label} must still allow exporting data`);
    });

    test(`${label} -> mutation, Job Tracking, public booking, and notifications are denied`, () => {
      const result = resolveEntitlement(subscription, NOW);
      assert.equal(result.canMutateOperationalData, false, label);
      assert.equal(result.canUseJobTracking, false, label);
      assert.equal(result.canUsePublicBooking, false, label);
      assert.equal(result.canSendNotifications, false, label);
    });
  }
});

describe("every locked state denies viewing/exporting but preserves billing/reactivation", () => {
  const lockedFixtures: Array<[string, SubscriptionRecord | null]> = [
    ["canceled_locked", stripeRecord({ stripeStatus: "canceled", canceledAt: new Date(NOW.getTime() - READ_ONLY_PERIOD_MS - 1) })],
    ["past_due_locked", stripeRecord({ stripeStatus: "past_due", graceUntil: new Date(NOW.getTime() - READ_ONLY_PERIOD_MS - 1) })],
    ["unpaid_locked", stripeRecord({ stripeStatus: "unpaid", accessEndedAt: new Date(NOW.getTime() - READ_ONLY_PERIOD_MS - 1) })],
    ["paused_locked", stripeRecord({ stripeStatus: "paused", accessEndedAt: new Date(NOW.getTime() - READ_ONLY_PERIOD_MS - 1) })],
    ["incomplete", stripeRecord({ stripeStatus: "incomplete" })],
    ["incomplete_expired", stripeRecord({ stripeStatus: "incomplete_expired" })],
    ["no_subscription", null],
    ["malformed_missing_status", stripeRecord({ stripeStatus: null })],
    ["malformed_access_ended_date", stripeRecord({ stripeStatus: "unpaid", accessEndedAt: null })],
  ];

  for (const [label, subscription] of lockedFixtures) {
    test(`${label} -> billing/reactivation remains reachable`, () => {
      const result = resolveEntitlement(subscription, NOW);
      assert.equal(result.canManageBilling, true, label);
    });

    test(`${label} -> viewing and exporting existing data are denied`, () => {
      const result = resolveEntitlement(subscription, NOW);
      assert.equal(result.canViewExistingData, false, label);
      assert.equal(result.canExportData, false, label);
    });

    test(`${label} -> mutation, Job Tracking, public booking, and notifications remain denied`, () => {
      const result = resolveEntitlement(subscription, NOW);
      assert.equal(result.canMutateOperationalData, false, label);
      assert.equal(result.canUseJobTracking, false, label);
      assert.equal(result.canUsePublicBooking, false, label);
      assert.equal(result.canSendNotifications, false, label);
    });
  }
});

describe("recovery: full access resumes immediately once state is entitled again", () => {
  test("a workspace that was past_due_locked is full access again once status is synced back to active", () => {
    const stillPastDue = resolveEntitlement(
      stripeRecord({ stripeStatus: "past_due", graceUntil: new Date(NOW.getTime() - READ_ONLY_PERIOD_MS - 1) }),
      NOW
    );
    assertLocked(stillPastDue);

    // Same instant, same function, only the synchronized subscription
    // state changed (as it would after a successful-payment webhook
    // updates the stored row) — no separate "recovery" code path exists,
    // the resolver is simply re-evaluated against the new state.
    const recovered = resolveEntitlement(stripeRecord({ stripeStatus: "active" }), NOW);
    assertFullAccess(recovered);
    assert.equal(recovered.state, "active");
  });

  test("an unpaid workspace recovers to full access once status is synced back to active", () => {
    const stillUnpaid = resolveEntitlement(
      stripeRecord({ stripeStatus: "unpaid", accessEndedAt: new Date(NOW.getTime() - 1000) }),
      NOW
    );
    assertRestricted(stillUnpaid);
    const recovered = resolveEntitlement(stripeRecord({ stripeStatus: "active" }), NOW);
    assertFullAccess(recovered);
  });
});

describe("internal/demo access is independent of Stripe identifiers and status", () => {
  test("internal-mode result carries no Stripe status even though the field exists on the type", () => {
    const result = resolveEntitlement({ ...stripeRecord(), billingMode: "internal", stripeStatus: null }, NOW);
    assert.equal(result.stripeStatus, null);
    assert.equal(result.billingMode, "internal");
  });

  test("demo workspace result never surfaces trial/period/grace fields", () => {
    const result = resolveWorkspaceEntitlement(DEMO_WORKSPACE_ID, null, NOW);
    assert.equal(result.trialEnd, null);
    assert.equal(result.currentPeriodEnd, null);
    assert.equal(result.graceEndsAt, null);
  });
});

describe("workspace identity is the only thing that can grant demo/internal access", () => {
  test("a normal Stripe-backed workspace with no subscription row is locked, not silently treated as demo", () => {
    // REAL_WORKSPACE_ID is not DEMO_WORKSPACE_ID; passing it through the
    // workspace-aware resolver with no subscription data must fail closed
    // exactly like the non-workspace-aware resolveEntitlement(null, now)
    // does — it must not fall through to any full-access default.
    const result = resolveWorkspaceEntitlement(REAL_WORKSPACE_ID, null, NOW);
    assertLocked(result);
    assert.equal(result.state, "no_subscription");
  });

  test("an arbitrary non-demo workspaceId with a canceled subscription stays read-only", () => {
    const otherWorkspaceId = "11111111-1111-1111-1111-111111111111";
    const result = resolveWorkspaceEntitlement(
      otherWorkspaceId,
      stripeRecord({ stripeStatus: "canceled", canceledAt: new Date(NOW.getTime() - 1000) }),
      NOW
    );
    assertRestricted(result);
    assert.equal(result.state, "canceled_read_only");
  });

  test("resolveWorkspaceEntitlement has no role/user parameter at all -- entitlement is purely workspace-keyed", () => {
    // Structural guarantee, not just a runtime assertion: the function's
    // only inputs are workspaceId, subscription, and now. There is no
    // "role" or "isTester" flag that could be spoofed to convert a normal
    // Stripe workspace into demo/internal access -- the exact-match
    // workspaceId comparison inside resolveWorkspaceEntitlement is the only
    // path to the "demo" state.
    assert.equal(resolveWorkspaceEntitlement.length, 3);
  });
});
