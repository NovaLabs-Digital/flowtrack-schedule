// Phase 5.4A: focused automated tests for the canonical entitlement
// resolver (lib/entitlement.ts). Pure unit tests — no Supabase, no Stripe,
// no Next.js — run directly under Node's built-in test runner:
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
    ...overrides,
  };
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

function assertRestricted(result: ReturnType<typeof resolveEntitlement>) {
  assert.equal(result.hasOperationalAccess, false);
  assert.equal(result.isReadOnly, true);
  // Approved policy: billing recovery + viewing/exporting existing data
  // must remain allowed in every restricted state, without exception.
  assert.equal(result.canManageBilling, true);
  assert.equal(result.canViewExistingData, true);
  assert.equal(result.canExportData, true);
  // Everything operational is denied.
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

describe("grace-period boundary (exact instant, exclusive of full access)", () => {
  test("now === graceUntil exactly -> restricted (boundary instant is already expired)", () => {
    const graceUntil = new Date(NOW.getTime());
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "past_due", graceUntil }), NOW);
    assertRestricted(result);
    assert.equal(result.state, "past_due_expired");
    assert.equal(result.reason, "past_due_grace_expired");
  });

  test("past_due, 1ms after grace expiry -> restricted", () => {
    const graceUntil = new Date(NOW.getTime() - 1);
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "past_due", graceUntil }), NOW);
    assertRestricted(result);
    assert.equal(result.state, "past_due_expired");
  });
});

describe("restricted states", () => {
  test("unpaid -> restricted", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "unpaid" }), NOW);
    assertRestricted(result);
    assert.equal(result.state, "unpaid");
  });

  test("incomplete -> restricted", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "incomplete" }), NOW);
    assertRestricted(result);
    assert.equal(result.state, "incomplete");
  });

  test("incomplete_expired -> restricted", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "incomplete_expired" }), NOW);
    assertRestricted(result);
    assert.equal(result.state, "incomplete_expired");
  });

  test("canceled -> restricted (unconditionally, regardless of currentPeriodEnd)", () => {
    const result = resolveEntitlement(
      stripeRecord({ stripeStatus: "canceled", currentPeriodEnd: new Date(NOW.getTime() + 1000 * 60 * 60 * 24 * 10) }),
      NOW
    );
    assertRestricted(result);
    assert.equal(result.state, "canceled");
  });

  test("paused -> restricted", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "paused" }), NOW);
    assertRestricted(result);
    assert.equal(result.state, "paused");
  });

  test("no subscription row on a Stripe-billed workspace -> restricted", () => {
    const result = resolveEntitlement(null, NOW);
    assertRestricted(result);
    assert.equal(result.state, "no_subscription");
    assert.equal(result.reason, "no_subscription");
  });

  test("query error (DB read failed) -> restricted, distinct reason from no_subscription", () => {
    const result = noDataResult("query_error");
    assertRestricted(result);
    assert.equal(result.state, "no_subscription");
    assert.equal(result.reason, "query_error");
  });
});

describe("malformed / incomplete billing state -> restricted, never full", () => {
  test("stripe-mode row with null status (pending, before first webhook) -> restricted", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: null }), NOW);
    assertRestricted(result);
    assert.equal(result.state, "malformed");
    assert.equal(result.reason, "malformed_missing_status");
  });

  test("stripe-mode row with empty-string status -> restricted", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "" }), NOW);
    assertRestricted(result);
    assert.equal(result.state, "malformed");
  });

  test("unrecognized Stripe status string -> restricted, not guessed as full", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "some_future_stripe_status" }), NOW);
    assertRestricted(result);
    assert.equal(result.state, "malformed");
    assert.equal(result.reason, "malformed_unknown_status");
  });

  test("past_due with a missing grace date -> restricted, not full", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "past_due", graceUntil: null }), NOW);
    assertRestricted(result);
    assert.equal(result.state, "malformed");
    assert.equal(result.reason, "malformed_grace_date");
  });

  test("past_due with an unparseable grace date (Invalid Date) -> restricted, not full", () => {
    const result = resolveEntitlement(
      stripeRecord({ stripeStatus: "past_due", graceUntil: new Date("not-a-real-date") }),
      NOW
    );
    assertRestricted(result);
    assert.equal(result.state, "malformed");
    assert.equal(result.reason, "malformed_grace_date");
  });

  test("billing_mode neither internal nor stripe -> restricted, fails closed", () => {
    const result = resolveEntitlement(
      { ...stripeRecord(), billingMode: "not_a_real_mode" as SubscriptionRecord["billingMode"] },
      NOW
    );
    assertRestricted(result);
    assert.equal(result.state, "malformed");
    assert.equal(result.reason, "malformed_billing_mode");
  });
});

describe("billing recovery and read access are preserved in every restricted state", () => {
  const restrictedFixtures: Array<[string, SubscriptionRecord | null]> = [
    ["past_due_expired", stripeRecord({ stripeStatus: "past_due", graceUntil: new Date(NOW.getTime() - 1) })],
    ["unpaid", stripeRecord({ stripeStatus: "unpaid" })],
    ["incomplete", stripeRecord({ stripeStatus: "incomplete" })],
    ["incomplete_expired", stripeRecord({ stripeStatus: "incomplete_expired" })],
    ["canceled", stripeRecord({ stripeStatus: "canceled" })],
    ["paused", stripeRecord({ stripeStatus: "paused" })],
    ["no_subscription", null],
    ["malformed_missing_status", stripeRecord({ stripeStatus: null })],
    ["malformed_grace_date", stripeRecord({ stripeStatus: "past_due", graceUntil: null })],
  ];

  for (const [label, subscription] of restrictedFixtures) {
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

describe("recovery: full access resumes immediately once state is entitled again", () => {
  test("a workspace that was past_due_expired is full access again once status is synced back to active", () => {
    const stillPastDue = resolveEntitlement(
      stripeRecord({ stripeStatus: "past_due", graceUntil: new Date(NOW.getTime() - 1) }),
      NOW
    );
    assertRestricted(stillPastDue);

    // Same instant, same function, only the synchronized subscription
    // state changed (as it would after a successful-payment webhook
    // updates the stored row) — no separate "recovery" code path exists,
    // the resolver is simply re-evaluated against the new state.
    const recovered = resolveEntitlement(stripeRecord({ stripeStatus: "active" }), NOW);
    assertFullAccess(recovered);
    assert.equal(recovered.state, "active");
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
  test("a normal Stripe-backed workspace with no subscription row is restricted, not silently treated as demo", () => {
    // REAL_WORKSPACE_ID is not DEMO_WORKSPACE_ID; passing it through the
    // workspace-aware resolver with no subscription data must fail closed
    // exactly like the non-workspace-aware resolveEntitlement(null, now)
    // does — it must not fall through to any full-access default.
    const result = resolveWorkspaceEntitlement(REAL_WORKSPACE_ID, null, NOW);
    assertRestricted(result);
    assert.equal(result.state, "no_subscription");
  });

  test("an arbitrary non-demo workspaceId with a canceled subscription stays restricted", () => {
    const otherWorkspaceId = "11111111-1111-1111-1111-111111111111";
    const result = resolveWorkspaceEntitlement(otherWorkspaceId, stripeRecord({ stripeStatus: "canceled" }), NOW);
    assertRestricted(result);
    assert.equal(result.state, "canceled");
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
