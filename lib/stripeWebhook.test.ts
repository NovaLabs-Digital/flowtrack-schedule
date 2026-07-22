// Phase 5.4B: focused automated tests for lib/stripeWebhook.ts's pure
// synchronization logic (grace-episode handling, conflict detection).
// Dummy Supabase env vars are set before the module under test is imported
// (via dynamic import, since static imports are hoisted ahead of any
// top-level assignment) so importing lib/supabaseAdmin.ts transitively
// doesn't throw — no real network call is ever made by these tests, since
// none of the functions exercised here touch supabaseAdmin directly.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";

const {
  buildSubscriptionPatchFromStripeSubscription,
  isBlockingSubscriptionStatus,
  detectSubscriptionConflict,
  updateSubscriptionIfUnchanged,
} = await import("./stripeWebhook.ts");

function fakeSubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: "sub_123",
    customer: "cus_123",
    status: "active",
    trial_start: null,
    trial_end: null,
    cancel_at_period_end: false,
    canceled_at: null,
    items: { data: [{ current_period_end: 1893456000 }] },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

describe("buildSubscriptionPatchFromStripeSubscription: grace episode logic", () => {
  test("first past_due signal (grace_until currently null) creates exactly one 3-day window", () => {
    const before = Date.now();
    const patch = buildSubscriptionPatchFromStripeSubscription(fakeSubscription({ status: "past_due" }), null);
    const after = Date.now();
    assert.equal(typeof patch.grace_until, "string");
    const graceMs = new Date(patch.grace_until as string).getTime();
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    assert.ok(graceMs >= before + THREE_DAYS_MS, "grace should be at least 3 days out");
    assert.ok(graceMs <= after + THREE_DAYS_MS, "grace should be at most 3 days out");
  });

  test("retry within the same episode (grace_until already set) preserves the original value untouched", () => {
    const existing = new Date(Date.now() + 1000 * 60 * 60 * 10).toISOString(); // 10h from now
    const patch = buildSubscriptionPatchFromStripeSubscription(fakeSubscription({ status: "past_due" }), existing);
    assert.equal("grace_until" in patch, false, "grace_until should be omitted entirely, not touched");
  });

  test("retry immediately before expiry does not extend it (still just an existing, still-open episode)", () => {
    const almostExpired = new Date(Date.now() + 1).toISOString();
    const patch = buildSubscriptionPatchFromStripeSubscription(fakeSubscription({ status: "past_due" }), almostExpired);
    assert.equal("grace_until" in patch, false);
  });

  test("retry after expiry does not create a fresh grace period while continuously past_due", () => {
    const alreadyExpired = new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(); // 5 days ago
    const patch = buildSubscriptionPatchFromStripeSubscription(fakeSubscription({ status: "past_due" }), alreadyExpired);
    // Not extended, not reset -- left exactly as-is (omitted from the patch).
    assert.equal("grace_until" in patch, false);
  });

  test("active recovery clears grace immediately", () => {
    const existing = new Date(Date.now() + 1000 * 60 * 60 * 10).toISOString();
    const patch = buildSubscriptionPatchFromStripeSubscription(fakeSubscription({ status: "active" }), existing);
    assert.equal(patch.grace_until, null);
  });

  test("trialing recovery clears grace immediately", () => {
    const existing = new Date(Date.now() + 1000 * 60 * 60 * 10).toISOString();
    const patch = buildSubscriptionPatchFromStripeSubscription(fakeSubscription({ status: "trialing" }), existing);
    assert.equal(patch.grace_until, null);
  });

  test("a later genuinely new past_due episode (grace cleared, then past_due again) creates a new grace period", () => {
    // Step 1: recovery clears grace.
    const recovered = buildSubscriptionPatchFromStripeSubscription(fakeSubscription({ status: "active" }), "2026-01-01T00:00:00.000Z");
    assert.equal(recovered.grace_until, null);

    // Step 2: a NEW past_due episode begins. The caller would have re-read
    // the row after step 1's write landed, so grace_until is now null --
    // this must produce a fresh window, not treat it as still-open.
    const before = Date.now();
    const newEpisode = buildSubscriptionPatchFromStripeSubscription(fakeSubscription({ status: "past_due" }), recovered.grace_until as null);
    assert.equal(typeof newEpisode.grace_until, "string");
    assert.ok(new Date(newEpisode.grace_until as string).getTime() > before);
  });

  test("UTC only -- grace_until is always an ISO string with a Z/UTC offset", () => {
    const patch = buildSubscriptionPatchFromStripeSubscription(fakeSubscription({ status: "past_due" }), null);
    assert.match(patch.grace_until as string, /Z$/);
  });

  test("malformed stored grace data fails safely -- no fresh window is granted", () => {
    const patch = buildSubscriptionPatchFromStripeSubscription(fakeSubscription({ status: "past_due" }), "not-a-real-date");
    assert.equal("grace_until" in patch, false, "must not silently grant a fresh/extended window for malformed data");
  });

  test("exact-boundary compatibility with Phase 5.4A: a freshly created grace_until resolves to full access right now", async () => {
    const { resolveEntitlement } = await import("./entitlement.ts");
    const patch = buildSubscriptionPatchFromStripeSubscription(fakeSubscription({ status: "past_due" }), null);
    const now = new Date();
    const result = resolveEntitlement(
      {
        billingMode: "stripe",
        stripeStatus: "past_due",
        trialEnd: null,
        currentPeriodEnd: null,
        graceUntil: new Date(patch.grace_until as string),
        cancelAtPeriodEnd: false,
      },
      now
    );
    assert.equal(result.hasOperationalAccess, true);
    assert.equal(result.state, "past_due_grace");
  });
});

describe("isBlockingSubscriptionStatus", () => {
  test("trialing/active/past_due are blocking", () => {
    assert.equal(isBlockingSubscriptionStatus("trialing"), true);
    assert.equal(isBlockingSubscriptionStatus("active"), true);
    assert.equal(isBlockingSubscriptionStatus("past_due"), true);
  });
  test("canceled/unpaid/incomplete_expired/null are not blocking", () => {
    assert.equal(isBlockingSubscriptionStatus("canceled"), false);
    assert.equal(isBlockingSubscriptionStatus("unpaid"), false);
    assert.equal(isBlockingSubscriptionStatus("incomplete_expired"), false);
    assert.equal(isBlockingSubscriptionStatus(null), false);
  });
});

describe("detectSubscriptionConflict", () => {
  test("no existing subscription id -- never a conflict", () => {
    assert.equal(detectSubscriptionConflict(null, "active", "sub_new"), false);
  });
  test("same subscription id -- never a conflict", () => {
    assert.equal(detectSubscriptionConflict("sub_1", "active", "sub_1"), false);
  });
  test("different id while current status is live (active/trialing/past_due) -- conflict", () => {
    assert.equal(detectSubscriptionConflict("sub_1", "active", "sub_2"), true);
    assert.equal(detectSubscriptionConflict("sub_1", "trialing", "sub_2"), true);
    assert.equal(detectSubscriptionConflict("sub_1", "past_due", "sub_2"), true);
  });
  test("different id while current status is terminal (canceled/unpaid) -- no conflict, replacement allowed", () => {
    assert.equal(detectSubscriptionConflict("sub_1", "canceled", "sub_2"), false);
    assert.equal(detectSubscriptionConflict("sub_1", "unpaid", "sub_2"), false);
  });
});

describe("updateSubscriptionIfUnchanged: superseded-row write semantics (Phase 5.4B review)", () => {
  test("is a single atomic write -- the updated_at bump and the last_event_created_at compare-and-swap are the SAME statement, never two", () => {
    // Regression guard for a report/behavior mismatch caught in review: it
    // must be structurally impossible for a future edit to split this into
    // an unconditional "mark checked" write plus a separate conditional
    // patch write -- if the CAS fails, NOTHING may be written, including
    // updated_at. Source-inspected (rather than behaviorally, via a live
    // DB) because this function has no dependency-injection seam for
    // supabaseAdmin, unlike WebhookDeps for the Stripe client.
    const source = updateSubscriptionIfUnchanged.toString();
    const updateCallCount = (source.match(/\.update\(/g) ?? []).length;
    assert.equal(
      updateCallCount,
      1,
      "expected exactly one .update() call -- the updated_at bookkeeping bump must be bundled into the same CAS-gated statement as the subscription patch, not a separate unconditional write"
    );
  });

  test("the CAS predicate (last_event_created_at) is applied on the SAME query object the update() call returned, not a separate one", () => {
    // Guards against a refactor that builds two independent query objects
    // (one for the CAS filter, one for the write) that could accidentally
    // be issued as two separate requests instead of one filtered UPDATE.
    const source = updateSubscriptionIfUnchanged.toString();
    assert.match(source, /last_event_created_at/, "the CAS column must appear in the write path");
    // Exactly one query variable is ever queried against Supabase -- a
    // second `.from("subscriptions")` call would indicate a second,
    // independent statement.
    const fromCallCount = (source.match(/\.from\(/g) ?? []).length;
    assert.equal(fromCallCount, 1, "expected exactly one .from() call -- one table statement, not two");
  });
});
