// Phase 5.4E1: route-level tests for app/api/settings/company/route.ts
// (POST only -- GET remains completely untouched and is proven unaffected
// below, per the explicit Settings policy: opening/reading Settings and
// Billing must remain available while restricted). @/lib/entitlementServer
// is intentionally NOT mocked -- the real requireCapability chain runs
// against a fake "subscriptions" table. No real Supabase/Stripe/network
// call is reachable. Run with --experimental-test-module-mocks (see
// package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin, writeCalls, fakeSessionNamedExports, subscriptionRow, SUBSCRIPTION_RESTRICTED_BODY } from "../../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../../lib/testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});
let sessionToReturn: unknown = { role: "none" };

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});
mock.module("@/lib/session", { namedExports: fakeSessionNamedExports(async () => sessionToReturn) });

const { GET, POST } = await import("./route.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}
function req(method: string, body?: unknown) {
  return new Request("http://localhost/api/settings/company", {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID };

describe("POST /api/settings/company -- entitlement gate", () => {
  test("active permits saving settings, response unchanged", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { id: "cs-1" } }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { company_name: "Acme Cleaning" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(writeCalls(currentFake.calls).length, 1);
  });

  test("internal permits saving settings without Stripe dependence", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ billing_mode: "internal", stripe_status: null }) }],
      company_settings: [{ data: { id: "cs-1" } }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { company_name: "Acme Cleaning" }));
    assert.equal(res.status, 200);
  });

  test("exact trusted demo workspace permits saving settings with zero subscriptions-table queries", async () => {
    resetFixtures({ company_settings: [{ data: null }, { error: null }] });
    sessionToReturn = { role: "owner", workspaceId: DEMO_WORKSPACE_ID };
    const res = await POST(req("POST", { company_name: "Demo Co" }));
    assert.equal(res.status, 200);
  });

  test("canceled denies saving settings with the exact SUBSCRIPTION_RESTRICTED 403, zero writes, zero company_settings reads", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { company_name: "Acme Cleaning" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "company_settings"), []);
  });

  test("this specifically covers the approved policy: settings/company POST requires canMutateOperationalData while restricted", async () => {
    // Even a request that ONLY toggles booking_enabled/notifications_enabled
    // (not company identity fields) is still an operational mutation and
    // must be denied while restricted -- Settings/Billing viewing stays
    // available (see the GET-is-unaffected tests below), but saving does not.
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() - 1000).toISOString() }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { notifications_enabled: false }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  test("query_error on the subscriptions read denies, zero writes", async () => {
    resetFixtures({ subscriptions: [{ error: { message: "simulated DB error" } }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { company_name: "Acme Cleaning" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  test("non-owner denial remains a plain 403 Unauthorized, never SUBSCRIPTION_RESTRICTED", async () => {
    resetFixtures({});
    sessionToReturn = { role: "employee", employeeId: "e1", workspaceId: REAL_WORKSPACE_ID };
    const res = await POST(req("POST", { company_name: "Acme Cleaning" }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, undefined);
    assert.equal(body.error, "Unauthorized");
  });

  test("a spoofed workspace_id in the request body does not change which workspace's entitlement is checked", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { company_name: "Acme Cleaning", workspace_id: "attacker-ws" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });
});

describe("GET /api/settings/company remains fully available while restricted (Settings/Billing viewing policy)", () => {
  test("succeeds for a restricted workspace -- GET never calls requireCapability, opening Settings is never blocked", async () => {
    resetFixtures({
      // No "subscriptions" fixture queued: GET must never query entitlement
      // at all -- if it did, the missing fixture would throw.
      company_settings: [{ data: { company_name: "Acme Cleaning", booking_enabled: true } }],
      employees: [{ count: 3 }, { count: 2 }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.settings.company_name, "Acme Cleaning");
  });
});
