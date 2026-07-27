// Phase 5.7D-R11: focused tests for fetchEntitlementForWorkspace's actual
// Supabase read and column mapping (lib/entitlementServer.ts's toRecord).
// Deliberately a SEPARATE file from lib/entitlementServer.test.ts, which
// commits explicitly (see that file's own header comment) to testing
// requireCapability/requireCapabilityForWorkspace's LOGIC in isolation
// with no @/lib/supabaseAdmin mock at all, via an injected fetcher instead
// -- this file is the one place that mocks @/lib/supabaseAdmin, so it can
// prove the real SELECT statement actually selects trial_consumed_at/
// stripe_customer_id/stripe_subscription_id (the new columns added in
// Phase 5.7D-R11) and that toRecord() correctly reduces the two raw
// Stripe identity columns to a single hasStripeIdentity boolean before
// anything reaches the pure resolver.
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
  test("the SELECT statement includes trial_consumed_at, stripe_customer_id, and stripe_subscription_id", async () => {
    resetFixtures({ subscriptions: [{ data: { ...PRISTINE_ROW, stripe_status: "active" } }] });
    await fetchEntitlementForWorkspace(REAL_WORKSPACE_ID);
    const selectCall = currentFake.calls.find((c) => c.table === "subscriptions" && c.method === "select");
    assert.ok(selectCall, "expected a select() call against subscriptions");
    const columns = selectCall!.args[0] as string;
    for (const column of ["trial_consumed_at", "stripe_customer_id", "stripe_subscription_id"]) {
      assert.ok(columns.includes(column), `SELECT must include ${column}`);
    }
  });

  test("a genuinely pristine row (matching exactly what provision_owner_workspace leaves behind) resolves to trial_not_started", async () => {
    resetFixtures({ subscriptions: [{ data: PRISTINE_ROW }] });
    const result = await fetchEntitlementForWorkspace(REAL_WORKSPACE_ID);
    assert.equal(result.state, "trial_not_started");
    assert.equal(result.canManageBilling, true);
    assert.equal(result.canViewExistingData, false);
    assert.equal(result.hasOperationalAccess, false);
  });

  test("the same row shape but with a stripe_customer_id attached resolves to malformed, not trial_not_started", async () => {
    resetFixtures({ subscriptions: [{ data: { ...PRISTINE_ROW, stripe_customer_id: "cus_123" } }] });
    const result = await fetchEntitlementForWorkspace(REAL_WORKSPACE_ID);
    assert.equal(result.state, "malformed");
  });

  test("the same row shape but with only stripe_subscription_id attached (no customer id) also resolves to malformed", async () => {
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
