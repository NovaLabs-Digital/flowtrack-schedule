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
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type Stripe from "stripe";

const {
  buildSubscriptionPatchFromStripeSubscription,
  isBlockingSubscriptionStatus,
  detectSubscriptionConflict,
  updateSubscriptionIfUnchanged,
  computeTrialConsumedPatchField,
  computeAccessEndedPatchField,
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
        canceledAt: null,
        accessEndedAt: null,
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

describe("computeTrialConsumedPatchField (Phase 5.6F)", () => {
  test("sub.trial_start present, currentTrialConsumedAt null -> writes trial_consumed_at", () => {
    const sub = fakeSubscription({ status: "trialing", trial_start: 1893456000 });
    const patch = computeTrialConsumedPatchField(sub, null);
    assert.equal(patch.trial_consumed_at, new Date(1893456000 * 1000).toISOString());
  });

  test("sub.trial_start present, currentTrialConsumedAt already set -> first-write-wins, patch omits the field entirely (never overwritten)", () => {
    const sub = fakeSubscription({ status: "trialing", trial_start: 1893456000 });
    const patch = computeTrialConsumedPatchField(sub, "2026-01-01T00:00:00.000Z");
    assert.equal("trial_consumed_at" in patch, false);
  });

  test("sub.trial_start null (no trial on this subscription) -> patch omits the field, never invents a value", () => {
    const sub = fakeSubscription({ status: "active", trial_start: null });
    const patch = computeTrialConsumedPatchField(sub, null);
    assert.equal("trial_consumed_at" in patch, false);
  });

  test("duplicate delivery of the same completion event is idempotent -- second call with the now-set value is a no-op patch", () => {
    const sub = fakeSubscription({ status: "trialing", trial_start: 1893456000 });
    const first = computeTrialConsumedPatchField(sub, null);
    assert.ok(first.trial_consumed_at);
    const second = computeTrialConsumedPatchField(sub, first.trial_consumed_at!);
    assert.equal("trial_consumed_at" in second, false);
  });
});

describe("computeAccessEndedPatchField (Phase 5.6F)", () => {
  const EVENT_CREATED_ISO = "2026-07-21T12:00:00.000Z";

  test("status transitions to unpaid, currentAccessEndedAt null -> writes access_ended_at = event.created", () => {
    const patch = computeAccessEndedPatchField("unpaid", null, EVENT_CREATED_ISO);
    assert.equal(patch.access_ended_at, EVENT_CREATED_ISO);
  });

  test("status transitions to paused, currentAccessEndedAt null -> writes access_ended_at = event.created", () => {
    const patch = computeAccessEndedPatchField("paused", null, EVENT_CREATED_ISO);
    assert.equal(patch.access_ended_at, EVENT_CREATED_ISO);
  });

  test("status stays unpaid, currentAccessEndedAt already set -> first-write-wins, patch omits the field entirely", () => {
    const patch = computeAccessEndedPatchField("unpaid", "2026-01-01T00:00:00.000Z", EVENT_CREATED_ISO);
    assert.equal("access_ended_at" in patch, false);
  });

  test("status recovers to active -> unconditionally clears access_ended_at, even if it was already null", () => {
    const patch = computeAccessEndedPatchField("active", "2026-01-01T00:00:00.000Z", EVENT_CREATED_ISO);
    assert.equal(patch.access_ended_at, null);
  });

  test("status recovers to trialing -> unconditionally clears access_ended_at", () => {
    const patch = computeAccessEndedPatchField("trialing", "2026-01-01T00:00:00.000Z", EVENT_CREATED_ISO);
    assert.equal(patch.access_ended_at, null);
  });

  test("status is canceled/past_due/incomplete/incomplete_expired -- not this function's concern, patch omits the field", () => {
    for (const status of ["canceled", "past_due", "incomplete", "incomplete_expired"]) {
      const patch = computeAccessEndedPatchField(status, null, EVENT_CREATED_ISO);
      assert.equal("access_ended_at" in patch, false, status);
    }
  });

  test("out-of-order duplicate delivery cannot extend a read-only window -- a second observation of the same status after the field is set is a no-op", () => {
    const first = computeAccessEndedPatchField("unpaid", null, EVENT_CREATED_ISO);
    assert.equal(first.access_ended_at, EVENT_CREATED_ISO);
    const later = "2026-07-22T12:00:00.000Z";
    const second = computeAccessEndedPatchField("unpaid", first.access_ended_at!, later);
    assert.equal("access_ended_at" in second, false, "must not move the boundary forward on a later duplicate/out-of-order event");
  });
});

describe("withTrialAndAccessEndedFields (the webhook-event-shaped composer) is only reachable from the three webhook handlers that re-fetch a live subscription (source-level proof)", () => {
  test("lib/reconcileSubscriptions.ts never imports or calls withTrialAndAccessEndedFields itself", () => {
    const source = fs.readFileSync(fileURLToPath(new URL("./reconcileSubscriptions.ts", import.meta.url)), "utf8");
    assert.ok(!source.includes("withTrialAndAccessEndedFields"));
  });

  test("Phase 5.6F-R1: lib/reconcileSubscriptions.ts DOES call computeTrialConsumedPatchField and computeAccessEndedPatchField directly, as its missed-webhook recovery path", () => {
    const source = fs.readFileSync(fileURLToPath(new URL("./reconcileSubscriptions.ts", import.meta.url)), "utf8");
    assert.ok(source.includes("buildSubscriptionPatchFromStripeSubscription"));
    assert.ok(source.includes("computeTrialConsumedPatchField"));
    assert.ok(source.includes("computeAccessEndedPatchField"));
  });
});
