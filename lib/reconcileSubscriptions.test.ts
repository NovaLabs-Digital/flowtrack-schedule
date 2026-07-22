// Phase 5.4B: focused automated tests for lib/reconcileSubscriptions.ts —
// the reconciliation route's core per-row logic, exercised entirely with
// fake deps (no real Stripe/Supabase connection, matching the WebhookDeps
// injection pattern already used for lib/stripeWebhook.ts).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";

const { reconcileRows, isAuthorizedCronRequest, RECONCILE_BATCH_LIMIT, RECONCILE_STALE_THRESHOLD_MS } = await import(
  "./reconcileSubscriptions.ts"
);
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("./workspace.ts");
import type { ReconcileRow } from "./reconcileSubscriptions.ts";

function row(overrides: Partial<ReconcileRow> = {}): ReconcileRow {
  return {
    workspace_id: "11111111-1111-1111-1111-111111111111",
    billing_mode: "stripe",
    stripe_subscription_id: "sub_abc",
    grace_until: null,
    last_event_created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakeSubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: "sub_abc",
    customer: "cus_abc",
    status: "active",
    trial_start: null,
    trial_end: null,
    cancel_at_period_end: false,
    canceled_at: null,
    items: { data: [{ current_period_end: 1893456000 }] },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function spyDeps(overrides: { retrieveSubscription?: (id: string) => Promise<Stripe.Subscription>; applyPatch?: (...args: unknown[]) => Promise<boolean> } = {}) {
  const retrieveCalls: string[] = [];
  const applyCalls: Array<{ workspaceId: string; observed: string | null; patch: Record<string, unknown> }> = [];
  const deps = {
    retrieveSubscription: async (id: string) => {
      retrieveCalls.push(id);
      return overrides.retrieveSubscription ? overrides.retrieveSubscription(id) : fakeSubscription();
    },
    applyPatch: async (workspaceId: string, observed: string | null, patch: Record<string, unknown>) => {
      applyCalls.push({ workspaceId, observed, patch });
      return overrides.applyPatch ? overrides.applyPatch(workspaceId, observed, patch) : true;
    },
  };
  return { deps, retrieveCalls, applyCalls };
}

describe("eligibility: internal/demo rows are never processed", () => {
  test("billing_mode = 'internal' row is skipped, no Stripe call, no write", async () => {
    const { deps, retrieveCalls, applyCalls } = spyDeps();
    const result = await reconcileRows([row({ billing_mode: "internal", workspace_id: REAL_WORKSPACE_ID })], deps);
    assert.equal(result.processed, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.synchronized, 0);
    assert.equal(result.failed, 0);
    assert.equal(retrieveCalls.length, 0);
    assert.equal(applyCalls.length, 0);
  });

  test("a row claiming the demo workspace id is skipped even if billing_mode says 'stripe'", async () => {
    const { deps, retrieveCalls } = spyDeps();
    const result = await reconcileRows([row({ workspace_id: DEMO_WORKSPACE_ID })], deps);
    assert.equal(result.skipped, 1);
    assert.equal(retrieveCalls.length, 0);
  });

  test("a genuine billing_mode = 'stripe', non-demo row IS processed", async () => {
    const { deps, retrieveCalls } = spyDeps();
    const result = await reconcileRows([row()], deps);
    assert.equal(result.synchronized, 1);
    assert.equal(retrieveCalls.length, 1);
  });
});

describe("missing subscription id", () => {
  test("is skipped safely, marked checked (applyPatch called with empty patch), no Stripe call", async () => {
    const { deps, retrieveCalls, applyCalls } = spyDeps();
    const result = await reconcileRows([row({ stripe_subscription_id: null })], deps);
    assert.equal(result.skipped, 1);
    assert.equal(result.failed, 0);
    assert.equal(retrieveCalls.length, 0);
    assert.equal(applyCalls.length, 1);
    assert.deepEqual(applyCalls[0].patch, {});
  });
});

describe("authoritative status mapping reuses the canonical patch builder", () => {
  for (const status of ["active", "trialing", "past_due", "canceled", "paused"]) {
    test(`live status '${status}' is written through to stripe_status unchanged`, async () => {
      const { deps, applyCalls } = spyDeps({ retrieveSubscription: async () => fakeSubscription({ status: status as Stripe.Subscription.Status }) });
      await reconcileRows([row()], deps);
      assert.equal(applyCalls[0].patch.stripe_status, status);
    });
  }

  test("payment recovery (status active, grace_until previously set) clears grace in the written patch", async () => {
    const openGrace = new Date(Date.now() + 1000 * 60 * 60).toISOString();
    const { deps, applyCalls } = spyDeps({ retrieveSubscription: async () => fakeSubscription({ status: "active" }) });
    await reconcileRows([row({ grace_until: openGrace })], deps);
    assert.equal(applyCalls[0].patch.grace_until, null);
  });

  test("still past_due with an existing grace_until preserves it (patch omits grace_until entirely)", async () => {
    const openGrace = new Date(Date.now() + 1000 * 60 * 60).toISOString();
    const { deps, applyCalls } = spyDeps({ retrieveSubscription: async () => fakeSubscription({ status: "past_due" }) });
    await reconcileRows([row({ grace_until: openGrace })], deps);
    assert.equal("grace_until" in applyCalls[0].patch, false);
  });
});

describe("conflicting subscription id (defensive id-match guard)", () => {
  test("if the retrieved object's id doesn't match what was requested, the row is skipped, not written", async () => {
    const { deps, applyCalls } = spyDeps({ retrieveSubscription: async () => fakeSubscription({ id: "sub_completely_different" }) });
    const result = await reconcileRows([row({ stripe_subscription_id: "sub_abc" })], deps);
    assert.equal(result.skipped, 1);
    assert.equal(applyCalls.length, 0);
  });
});

describe("error isolation", () => {
  test("one row's Stripe fetch failure does not abort the batch -- remaining rows still process", async () => {
    let call = 0;
    const { deps, applyCalls } = spyDeps({
      retrieveSubscription: async () => {
        call++;
        if (call === 2) throw new Error("simulated Stripe outage");
        return fakeSubscription();
      },
    });
    const rows = [
      row({ workspace_id: "11111111-1111-1111-1111-111111111111" }),
      row({ workspace_id: "22222222-2222-2222-2222-222222222222" }),
      row({ workspace_id: "33333333-3333-3333-3333-333333333333" }),
    ];
    const result = await reconcileRows(rows, deps);
    assert.equal(result.processed, 3);
    assert.equal(result.failed, 1);
    assert.equal(result.synchronized, 2);
    assert.equal(applyCalls.length, 2, "the two healthy rows were still written");
  });

  test("a failed row is NOT marked checked (no applyPatch call), so it stays eligible for immediate retry", async () => {
    const { deps, applyCalls } = spyDeps({ retrieveSubscription: async () => { throw new Error("boom"); } });
    await reconcileRows([row()], deps);
    assert.equal(applyCalls.length, 0);
  });

  test("an unexpected error anywhere in a row's processing is caught and counted as failed, not thrown", async () => {
    const { deps } = spyDeps({
      applyPatch: async () => {
        throw new Error("simulated DB error");
      },
    });
    const result = await reconcileRows([row()], deps);
    assert.equal(result.failed, 1);
  });
});

describe("delayed/out-of-order webhook safety after reconciliation", () => {
  test("if applyPatch reports the row changed concurrently (CAS rejected), it's counted as skipped, not failed or synchronized", async () => {
    const { deps } = spyDeps({ applyPatch: async () => false });
    const result = await reconcileRows([row()], deps);
    assert.equal(result.skipped, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.synchronized, 0);
  });

  test("a superseded row does not abort processing of subsequent rows", async () => {
    let call = 0;
    const { deps } = spyDeps({
      applyPatch: async () => {
        call++;
        return call !== 1; // first row loses the race, second succeeds
      },
    });
    const rows = [row({ workspace_id: "11111111-1111-1111-1111-111111111111" }), row({ workspace_id: "22222222-2222-2222-2222-222222222222" })];
    const result = await reconcileRows(rows, deps);
    assert.equal(result.skipped, 1);
    assert.equal(result.synchronized, 1);
  });
});

describe("batch boundedness", () => {
  test("RECONCILE_BATCH_LIMIT is a small, positive, finite conservative cap", () => {
    assert.ok(Number.isFinite(RECONCILE_BATCH_LIMIT));
    assert.ok(RECONCILE_BATCH_LIMIT > 0);
    assert.ok(RECONCILE_BATCH_LIMIT <= 100, "should be conservative, not effectively unbounded");
  });

  test("RECONCILE_STALE_THRESHOLD_MS is a positive, multi-hour-scale duration (not near-zero, not unbounded)", () => {
    const ONE_HOUR = 60 * 60 * 1000;
    const ONE_WEEK = 7 * 24 * ONE_HOUR;
    assert.ok(RECONCILE_STALE_THRESHOLD_MS >= ONE_HOUR);
    assert.ok(RECONCILE_STALE_THRESHOLD_MS <= ONE_WEEK);
  });

  test("reconcileRows performs exactly one Stripe call and at most one write per row it's given -- no hidden fan-out", async () => {
    const { deps, retrieveCalls, applyCalls } = spyDeps();
    const rows = Array.from({ length: 5 }, (_, i) => row({ workspace_id: `${i}${i}${i}${i}${i}${i}${i}${i}-0000-0000-0000-000000000000` }));
    await reconcileRows(rows, deps);
    assert.equal(retrieveCalls.length, 5);
    assert.equal(applyCalls.length, 5);
  });
});

describe("cron authorization", () => {
  test("missing secret param is unauthorized", () => {
    assert.equal(isAuthorizedCronRequest(null, "the-real-secret"), false);
  });
  test("missing configured env secret is unauthorized (fails closed, never open)", () => {
    assert.equal(isAuthorizedCronRequest("guess", undefined), false);
  });
  test("wrong secret is unauthorized", () => {
    assert.equal(isAuthorizedCronRequest("wrong", "the-real-secret"), false);
  });
  test("correct secret is authorized", () => {
    assert.equal(isAuthorizedCronRequest("the-real-secret", "the-real-secret"), true);
  });
});

describe("result shape exposes only non-sensitive aggregate counts", () => {
  test("ReconcileResult has exactly the four documented numeric fields, nothing else", async () => {
    const { deps } = spyDeps();
    const result = await reconcileRows([row()], deps);
    assert.deepEqual(Object.keys(result).sort(), ["failed", "processed", "skipped", "synchronized"]);
    for (const value of Object.values(result)) {
      assert.equal(typeof value, "number");
    }
  });
});
