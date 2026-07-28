// Phase 5.6D: route-level tests for app/api/stripe/cancel-trial/route.ts --
// the ONE application-controlled action that immediately cancels a TRIALING
// subscription on the owner's explicit request. @/lib/session,
// @/lib/supabaseAdmin, and @/lib/stripe are mocked in-process (matching the
// established route-test convention in lib/testSupport.ts); requireRole/
// assertWorkspace/requireCurrentOwnerSession all run for REAL against a fake
// Supabase client. No real Supabase/Stripe/network call is reachable. Run
// with --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake";
process.env.STRIPE_PRICE_MONTHLY_TEST = "price_fake";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createFakeSupabaseAdmin, fakeSessionNamedExports, GENERIC_FORBIDDEN_BODY } from "../../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../../lib/testSupport.ts";

const routeSource = fs.readFileSync(new URL("./route.ts", import.meta.url), "utf8");

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const OWNER_AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";
const OWNER_SESSION = { role: "owner", workspaceId: WORKSPACE_ID, authUserId: OWNER_AUTH_USER_ID, sessionEpoch: 1 };
const EMPLOYEE_SESSION = { role: "employee", workspaceId: WORKSPACE_ID, employeeId: "emp-1" };
const TESTER_SESSION = { role: "tester", workspaceId: WORKSPACE_ID };

let currentFake = createFakeSupabaseAdmin({});
let sessionToReturn: unknown = { role: "none" };
let cancelSubscriptionCalls: Array<{ id: string; params: unknown; options: unknown }> = [];
let cancelSubscriptionImpl: (id: string) => Promise<unknown> = async (id) => ({
  id,
  customer: "cus_abc",
  status: "canceled",
  trial_start: 1782288000,
  trial_end: 1784880000,
  cancel_at_period_end: false,
  canceled_at: 1782400000,
  items: { data: [{ current_period_end: 1784880000 }] },
});

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});
mock.module("@/lib/session", { namedExports: fakeSessionNamedExports(async () => sessionToReturn) });
mock.module("@/lib/stripe", {
  namedExports: {
    getStripeConfig: () => ({
      client: {
        subscriptions: {
          cancel: async (id: string, params: unknown, options: unknown) => {
            cancelSubscriptionCalls.push({ id, params, options });
            return cancelSubscriptionImpl(id);
          },
        },
      },
      priceId: "price_fake",
      webhookSecret: "whsec_fake",
    }),
  },
});

const { POST } = await import("./route.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}

function resetState() {
  sessionToReturn = OWNER_SESSION;
  cancelSubscriptionCalls = [];
}

const TRIALING_ROW = {
  stripe_subscription_id: "sub_trial_1",
  stripe_status: "trialing",
  grace_until: null,
  trial_consumed_at: "2026-06-01T00:00:00.000Z",
  access_ended_at: null,
  last_event_created_at: "2026-06-01T00:00:00.000Z",
};

function membershipFixture() {
  return { workspace_memberships: [{ data: { workspace_id: WORKSPACE_ID, session_epoch: 1 } }] };
}

describe("POST /api/stripe/cancel-trial -- authorization", () => {
  test("an employee session is rejected before any subscription data is touched", async () => {
    resetState();
    resetFixtures({});
    sessionToReturn = EMPLOYEE_SESSION;
    const res = await POST();
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), GENERIC_FORBIDDEN_BODY);
    assert.equal(currentFake.calls.length, 0, "no query is ever made for a rejected role");
    assert.equal(cancelSubscriptionCalls.length, 0);
  });

  test("a tester session is rejected before any subscription data is touched", async () => {
    resetState();
    resetFixtures({});
    sessionToReturn = TESTER_SESSION;
    const res = await POST();
    assert.equal(res.status, 403);
    assert.equal(currentFake.calls.length, 0);
    assert.equal(cancelSubscriptionCalls.length, 0);
  });

  test("no session at all is rejected", async () => {
    resetState();
    resetFixtures({});
    sessionToReturn = { role: "none" };
    const res = await POST();
    assert.equal(res.status, 403);
    assert.equal(cancelSubscriptionCalls.length, 0);
  });

  test("takes zero request input -- workspace identity always comes from the session, never anything client-supplied", () => {
    const source = routeSource;
    assert.match(source, /export async function POST\(\)/, "POST accepts no Request/body parameter at all");
    assert.ok(!source.includes("req.json()"));
    assert.ok(!source.includes("searchParams"));
  });
});

describe("POST /api/stripe/cancel-trial -- trialing subscription, the happy path", () => {
  test("an owner in trial gets an immediate Stripe cancel call (never cancel_at_period_end) and a 200 ok response", async () => {
    resetState();
    resetFixtures({
      ...membershipFixture(),
      subscriptions: [{ data: TRIALING_ROW }, { data: { workspace_id: WORKSPACE_ID } }],
    });
    const res = await POST();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(cancelSubscriptionCalls.length, 1);
    assert.equal(cancelSubscriptionCalls[0]!.id, "sub_trial_1");
  });

  test("uses a deterministic per-subscription idempotency key, not a random/time-based one", async () => {
    resetState();
    resetFixtures({
      ...membershipFixture(),
      subscriptions: [{ data: TRIALING_ROW }, { data: { workspace_id: WORKSPACE_ID } }],
    });
    await POST();
    assert.deepEqual(cancelSubscriptionCalls[0]!.options, { idempotencyKey: "cancel-trial-sub_trial_1" });
  });

  test("persists the resulting canceled status against this exact workspace_id", async () => {
    resetState();
    resetFixtures({
      ...membershipFixture(),
      subscriptions: [{ data: TRIALING_ROW }, { data: { workspace_id: WORKSPACE_ID } }],
    });
    await POST();
    const updateCall = currentFake.calls.find((c) => c.table === "subscriptions" && c.method === "update");
    assert.ok(updateCall);
    const eqCalls = currentFake.calls.filter((c) => c.table === "subscriptions" && c.method === "eq");
    assert.ok(eqCalls.some((c) => c.args[0] === "workspace_id" && c.args[1] === WORKSPACE_ID));
  });
});

describe("POST /api/stripe/cancel-trial -- not eligible / already resolved", () => {
  for (const status of ["active", "past_due", "canceled", "unpaid", "paused", null]) {
    test(`stripe_status=${status} -> 409, Stripe is never called`, async () => {
      resetState();
      resetFixtures({ ...membershipFixture(), subscriptions: [{ data: { ...TRIALING_ROW, stripe_status: status } }] });
      const res = await POST();
      assert.equal(res.status, 409);
      assert.equal(cancelSubscriptionCalls.length, 0);
    });
  }

  test("no subscriptions row at all for this workspace -> safe 500, never a raw Stripe/DB error", async () => {
    resetState();
    resetFixtures({ ...membershipFixture(), subscriptions: [{ data: null }] });
    const res = await POST();
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(typeof body.error, "string");
  });
});

describe("POST /api/stripe/cancel-trial -- repeated clicks are handled safely", () => {
  test("a second immediate request, after the row already reports canceled, does not call Stripe again", async () => {
    resetState();
    resetFixtures({
      ...membershipFixture(),
      subscriptions: [{ data: { ...TRIALING_ROW, stripe_status: "canceled" } }],
    });
    const res = await POST();
    assert.equal(res.status, 409);
    assert.equal(cancelSubscriptionCalls.length, 0);
  });

  test("a lost compare-and-swap race (concurrent webhook already wrote) still reports success, not an error", async () => {
    resetState();
    resetFixtures({
      ...membershipFixture(),
      // Second "subscriptions" fixture (the update's own .select().maybeSingle())
      // resolves to null -- simulating the WHERE clause matching zero rows.
      subscriptions: [{ data: TRIALING_ROW }, { data: null }],
    });
    const res = await POST();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe("POST /api/stripe/cancel-trial -- never touches business data", () => {
  test("the route's own source references only the subscriptions table, never clients/appointments/employees/services", () => {
    const source = routeSource;
    for (const forbidden of ['from("clients"', 'from("appointments"', 'from("employees"', 'from("services"']) {
      assert.ok(!source.includes(forbidden), `must not reference "${forbidden}"`);
    }
  });
});

describe("POST /api/stripe/cancel-trial -- safe error handling", () => {
  test("a Stripe API error is caught and never leaks its raw message to the client", async () => {
    resetState();
    resetFixtures({ ...membershipFixture(), subscriptions: [{ data: TRIALING_ROW }] });
    cancelSubscriptionImpl = async () => {
      throw new Error("SECRET_STRIPE_INTERNAL_DETAIL");
    };
    const res = await POST();
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes("SECRET_STRIPE_INTERNAL_DETAIL"));
    // Restore for subsequent tests.
    cancelSubscriptionImpl = async (id: string) => ({
      id,
      customer: "cus_abc",
      status: "canceled",
      trial_start: 1782288000,
      trial_end: 1784880000,
      cancel_at_period_end: false,
      canceled_at: 1782400000,
      items: { data: [{ current_period_end: 1784880000 }] },
    });
  });
});
