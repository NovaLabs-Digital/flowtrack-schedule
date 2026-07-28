// Phase 5.6D: focused automated tests for lib/stripeCancelTrial.ts -- the
// core "cancel my trial right now" logic, exercised entirely with fake deps
// (no real Stripe/Supabase connection), matching the WebhookDeps/
// ReconcileDeps injection pattern already established in lib/stripeWebhook.ts
// and lib/reconcileSubscriptions.ts.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";

const { cancelTrialSubscription } = await import("./stripeCancelTrial.ts");
import type { TrialCancelSubscriptionRow } from "./stripeCancelTrial.ts";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";

function row(overrides: Partial<TrialCancelSubscriptionRow> = {}): TrialCancelSubscriptionRow {
  return {
    stripe_subscription_id: "sub_trial_1",
    stripe_status: "trialing",
    grace_until: null,
    trial_consumed_at: "2026-07-01T00:00:00.000Z",
    access_ended_at: null,
    last_event_created_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakeCanceledSubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: "sub_trial_1",
    customer: "cus_abc",
    status: "canceled",
    trial_start: 1782288000,
    trial_end: 1784880000,
    cancel_at_period_end: false,
    canceled_at: 1782400000,
    items: { data: [{ current_period_end: 1784880000 }] },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function spyDeps(overrides: {
  cancelSubscription?: (id: string) => Promise<Stripe.Subscription>;
  applyPatch?: (workspaceId: string, observed: string | null, patch: Record<string, unknown>) => Promise<boolean>;
  now?: () => Date;
} = {}) {
  const cancelCalls: string[] = [];
  const applyCalls: Array<{ workspaceId: string; observed: string | null; patch: Record<string, unknown> }> = [];
  const deps = {
    cancelSubscription: async (id: string) => {
      cancelCalls.push(id);
      return overrides.cancelSubscription ? overrides.cancelSubscription(id) : fakeCanceledSubscription();
    },
    applyPatch: async (workspaceId: string, observed: string | null, patch: Record<string, unknown>) => {
      applyCalls.push({ workspaceId, observed, patch });
      return overrides.applyPatch ? overrides.applyPatch(workspaceId, observed, patch) : true;
    },
    now: overrides.now ?? (() => new Date("2026-07-05T12:00:00.000Z")),
  };
  return { deps, cancelCalls, applyCalls };
}

describe("cancelTrialSubscription -- happy path", () => {
  test("cancels the exact stored subscription id via the immediate-cancel deps call", async () => {
    const { deps, cancelCalls } = spyDeps();
    const outcome = await cancelTrialSubscription(row(), WORKSPACE_ID, deps);
    assert.deepEqual(outcome, { outcome: "canceled" });
    assert.deepEqual(cancelCalls, ["sub_trial_1"]);
  });

  test("persists the resulting canceled status via applyPatch, using the row's own last_event_created_at for the compare-and-swap", async () => {
    const { deps, applyCalls } = spyDeps();
    await cancelTrialSubscription(row({ last_event_created_at: "2026-06-15T00:00:00.000Z" }), WORKSPACE_ID, deps);
    assert.equal(applyCalls.length, 1);
    assert.equal(applyCalls[0]!.workspaceId, WORKSPACE_ID);
    assert.equal(applyCalls[0]!.observed, "2026-06-15T00:00:00.000Z");
    assert.equal(applyCalls[0]!.patch.stripe_status, "canceled");
  });

  test("the persisted patch never sets cancel_at_period_end alone -- stripe_status itself is already the terminal canceled value from the immediate cancel", async () => {
    const { deps, applyCalls } = spyDeps();
    await cancelTrialSubscription(row(), WORKSPACE_ID, deps);
    assert.equal(applyCalls[0]!.patch.stripe_status, "canceled");
    assert.equal(applyCalls[0]!.patch.canceled_at, new Date(1782400000 * 1000).toISOString());
  });

  test("trial_consumed_at is preserved exactly as it was -- never cleared, never overwritten", async () => {
    const { deps, applyCalls } = spyDeps();
    await cancelTrialSubscription(row({ trial_consumed_at: "2026-06-01T00:00:00.000Z" }), WORKSPACE_ID, deps);
    // computeTrialConsumedPatchField omits the field entirely once a value
    // already exists -- proving it, not merely asserting no explicit clear.
    assert.equal("trial_consumed_at" in applyCalls[0]!.patch, false);
  });

  test("grace_until is cleared as part of the standard patch, matching every other authoritative transition out of past_due-adjacent states", async () => {
    const { deps, applyCalls } = spyDeps();
    await cancelTrialSubscription(row({ grace_until: "2026-07-10T00:00:00.000Z" }), WORKSPACE_ID, deps);
    assert.equal(applyCalls[0]!.patch.grace_until, null);
  });
});

describe("cancelTrialSubscription -- refuses to act on anything but a currently trialing row", () => {
  for (const status of ["active", "past_due", "canceled", "unpaid", "paused", "incomplete", null]) {
    test(`stripe_status=${status} -> "not_trialing", Stripe is never called`, async () => {
      const { deps, cancelCalls, applyCalls } = spyDeps();
      const outcome = await cancelTrialSubscription(row({ stripe_status: status }), WORKSPACE_ID, deps);
      assert.deepEqual(outcome, { outcome: "not_trialing" });
      assert.equal(cancelCalls.length, 0);
      assert.equal(applyCalls.length, 0);
    });
  }

  test("trialing but no stored subscription id -> \"no_subscription\", Stripe is never called", async () => {
    const { deps, cancelCalls } = spyDeps();
    const outcome = await cancelTrialSubscription(row({ stripe_subscription_id: null }), WORKSPACE_ID, deps);
    assert.deepEqual(outcome, { outcome: "no_subscription" });
    assert.equal(cancelCalls.length, 0);
  });
});

describe("cancelTrialSubscription -- repeated/double-submitted requests are handled safely", () => {
  test("a second call after the first already persisted (row now reports 'canceled') is a safe no-op, not a second Stripe call", async () => {
    const { deps, cancelCalls } = spyDeps();
    const first = await cancelTrialSubscription(row(), WORKSPACE_ID, deps);
    assert.deepEqual(first, { outcome: "canceled" });
    // Simulates the second request reading the row AFTER the first one's
    // write landed -- the exact shape of a real repeated click once the
    // first request has already completed.
    const second = await cancelTrialSubscription(row({ stripe_status: "canceled" }), WORKSPACE_ID, deps);
    assert.deepEqual(second, { outcome: "not_trialing" });
    assert.deepEqual(cancelCalls, ["sub_trial_1"], "Stripe's cancel endpoint is only ever reached once");
  });

  test("a lost compare-and-swap race (applyPatch returns false) reports 'conflict', not an error -- the cancellation already genuinely happened at Stripe", async () => {
    const { deps } = spyDeps({ applyPatch: async () => false });
    const outcome = await cancelTrialSubscription(row(), WORKSPACE_ID, deps);
    assert.deepEqual(outcome, { outcome: "conflict" });
  });
});

describe("cancelTrialSubscription -- never touches business data", () => {
  test("its only dependencies are a Stripe cancel call and a subscriptions-row patch -- no client/appointment/employee/service table is ever referenced", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./stripeCancelTrial.ts", import.meta.url), "utf8")
    );
    for (const forbidden of ["from(\"clients\"", "from(\"appointments\"", "from(\"employees\"", "from(\"services\"", ".delete("]) {
      assert.ok(!source.includes(forbidden), `must not reference "${forbidden}"`);
    }
  });
});
