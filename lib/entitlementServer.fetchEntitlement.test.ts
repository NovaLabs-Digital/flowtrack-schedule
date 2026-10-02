// Phase 5.7D-R11: focused tests for fetchEntitlementForWorkspace's actual
// Supabase read and column mapping (lib/entitlementServer.ts's toRecord).
// Deliberately a SEPARATE file from lib/entitlementServer.test.ts, which
// commits explicitly (see that file's own header comment) to testing
// requireCapability/requireCapabilityForWorkspace's LOGIC in isolation
// with no @/lib/supabaseAdmin mock at all, via an injected fetcher instead
// -- this file is the one place that mocks @/lib/supabaseAdmin, so it can
// prove the real SELECT statement actually selects trial_consumed_at and
// stripe_subscription_id, and that toRecord() correctly reduces the raw
// Stripe identity column to a single hasStripeIdentity boolean before
// anything reaches the pure resolver.
//
// Phase 5.7D-R13-HF1: a real production account (sft.test.burns@...)
// exposed a second gap here -- stripe_customer_id used to count toward
// hasStripeIdentity too, but resolveStripeCustomerId (lib/stripeCheckout.ts)
// persists that column the instant "Start Free Trial" is clicked, before a
// Checkout Session exists let alone completes. An abandoned, never-
// completed checkout attempt was therefore indistinguishable from "real
// prior Stripe activity" and got permanently stuck on "malformed" /
// LockedReactivationScreen, even though the workspace never had any access
// to lose. hasStripeIdentity is now derived from stripe_subscription_id
// ALONE -- stripe_customer_id is no longer even selected. See the tests
// below for both the corrected behavior and the still-correct "a real
// subscription id with null status is genuinely anomalous" case.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin } from "./testSupport.ts";
import type { FakeSupabaseFixture } from "./testSupport.ts";
import { REAL_WORKSPACE_ID } from "./workspace.ts";

let currentFake = createFakeSupabaseAdmin({});

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});

const { fetchEntitlementForWorkspace } = await import("./entitlementServer.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}

const PRISTINE_ROW = {
  billing_mode: "stripe",
  stripe_status: null,
  trial_end: null,
  current_period_end: null,
  grace_until: null,
  cancel_at_period_end: false,
  canceled_at: null,
  access_ended_at: null,
  trial_consumed_at: null,
  stripe_customer_id: null,
  stripe_subscription_id: null,
};

describe("fetchEntitlementForWorkspace -- selects and maps the Phase 5.7D-R11 columns", () => {
  test("the SELECT statement includes trial_consumed_at and stripe_subscription_id, but no longer stripe_customer_id", async () => {
    resetFixtures({ subscriptions: [{ data: { ...PRISTINE_ROW, stripe_status: "active" } }] });
    await fetchEntitlementForWorkspace(REAL_WORKSPACE_ID);
    const selectCall = currentFake.calls.find((c) => c.table === "subscriptions" && c.method === "select");
    assert.ok(selectCall, "expected a select() call against subscriptions");
    const columns = selectCall!.args[0] as string;
    for (const column of ["trial_consumed_at", "stripe_subscription_id"]) {
      assert.ok(columns.includes(column), `SELECT must include ${column}`);
    }
    assert.ok(!columns.includes("stripe_customer_id"), "stripe_customer_id must not be selected -- it no longer feeds hasStripeIdentity");
  });

  test("a genuinely pristine row (matching exactly what provision_owner_workspace leaves behind) resolves to trial_not_started", async () => {
    resetFixtures({ subscriptions: [{ data: PRISTINE_ROW }] });
    const result = await fetchEntitlementForWorkspace(REAL_WORKSPACE_ID);
    assert.equal(result.state, "trial_not_started");
    assert.equal(result.canManageBilling, true);
    assert.equal(result.canViewExistingData, false);
    assert.equal(result.hasOperationalAccess, false);
  });

  test("Phase 5.7D-R13-HF1 regression: a stripe_customer_id attached but no subscription id -- an abandoned/in-flight checkout -- resolves to trial_not_started, not malformed", async () => {
    resetFixtures({ subscriptions: [{ data: { ...PRISTINE_ROW, stripe_customer_id: "cus_123" } }] });
    const result = await fetchEntitlementForWorkspace(REAL_WORKSPACE_ID);
    assert.equal(result.state, "trial_not_started");
    assert.equal(result.canManageBilling, true, "must still be able to reach Checkout again");
    assert.equal(result.canViewExistingData, false);
  });

  test("a stripe_subscription_id attached (with or without a customer id) is genuinely anomalous -- a real subscription is never created with a null status -- and still resolves to malformed", async () => {
    resetFixtures({ subscriptions: [{ data: { ...PRISTINE_ROW, stripe_subscription_id: "sub_123" } }] });
    const result = await fetchEntitlementForWorkspace(REAL_WORKSPACE_ID);
    assert.equal(result.state, "malformed");
  });

  test("the same row shape but with trial_consumed_at set resolves to malformed, never offering a second trial", async () => {
    resetFixtures({ subscriptions: [{ data: { ...PRISTINE_ROW, trial_consumed_at: "2026-01-01T00:00:00.000Z" } }] });
    const result = await fetchEntitlementForWorkspace(REAL_WORKSPACE_ID);
    assert.equal(result.state, "malformed");
  });

  test("a real active subscription (all Stripe fields populated) is completely unaffected by the new columns", async () => {
    resetFixtures({
      subscriptions: [
        {
          data: {
            ...PRISTINE_ROW,
            stripe_status: "active",
            stripe_customer_id: "cus_real",
            stripe_subscription_id: "sub_real",
            trial_consumed_at: "2026-01-01T00:00:00.000Z",
          },
        },
      ],
    });
    const result = await fetchEntitlementForWorkspace(REAL_WORKSPACE_ID);
    assert.equal(result.state, "active");
    assert.equal(result.hasOperationalAccess, true);
  });

  test("a query error still fails closed to service_unavailable, unaffected by the new columns", async () => {
    resetFixtures({ subscriptions: [{ error: { message: "connection reset" } }] });
    const result = await fetchEntitlementForWorkspace(REAL_WORKSPACE_ID);
    assert.equal(result.state, "service_unavailable");
  });

  test("no row at all still fails closed to no_subscription (locked), never trial_not_started", async () => {
    resetFixtures({ subscriptions: [{ data: null }] });
    const result = await fetchEntitlementForWorkspace(REAL_WORKSPACE_ID);
    assert.equal(result.state, "no_subscription");
    assert.notEqual(result.state, "trial_not_started");
  });
});
