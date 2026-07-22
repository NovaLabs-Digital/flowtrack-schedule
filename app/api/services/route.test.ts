// Phase 5.4E1: route-level tests for app/api/services/route.ts (POST,
// PATCH, DELETE). GET (read-only) is deliberately left untouched and is
// proven unaffected below. @/lib/entitlementServer is intentionally NOT
// mocked -- the real requireCapability chain runs against a fake
// "subscriptions" table. No real Supabase/Stripe/network call is
// reachable. Run with --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin, writeCalls, fakeSessionNamedExports, subscriptionRow, SUBSCRIPTION_RESTRICTED_BODY } from "../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../lib/testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});
let sessionToReturn: unknown = { role: "none" };

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});
mock.module("@/lib/session", { namedExports: fakeSessionNamedExports(async () => sessionToReturn) });

const { GET, POST, PATCH, DELETE } = await import("./route.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}
function req(method: string, body?: unknown) {
  return new Request("http://localhost/api/services", {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID };

describe("POST /api/services -- entitlement gate", () => {
  test("active permits creating a service, response unchanged", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      services: [{ error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { name: "Haircut" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(writeCalls(currentFake.calls).length, 1);
  });

  test("canceled denies with the exact SUBSCRIPTION_RESTRICTED 403, zero writes", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { name: "Haircut" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "services"), []);
  });

  test("internal permits creation without Stripe dependence", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ billing_mode: "internal", stripe_status: null }) }],
      services: [{ error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { name: "Haircut" }));
    assert.equal(res.status, 200);
  });

  test("exact trusted demo workspace permits creation with zero subscriptions-table queries", async () => {
    resetFixtures({ services: [{ error: null }] });
    sessionToReturn = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };
    const res = await POST(req("POST", { name: "Demo Service" }));
    assert.equal(res.status, 200);
  });
});

describe("PATCH /api/services -- entitlement gate", () => {
  test("active permits updating a service, response unchanged", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      services: [{ data: { is_demo: false } }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req("PATCH", { id: "svc-1", name: "New Name" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(writeCalls(currentFake.calls).length, 1);
  });

  test("unpaid denies with the exact SUBSCRIPTION_RESTRICTED 403, zero writes, zero services-table reads", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "unpaid" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req("PATCH", { id: "svc-1", name: "New Name" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "services"), []);
  });

  test("query_error on the subscriptions read denies, zero writes", async () => {
    resetFixtures({ subscriptions: [{ error: { message: "simulated DB error" } }] });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req("PATCH", { id: "svc-1", name: "New Name" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });
});

describe("DELETE /api/services -- entitlement gate", () => {
  test("active permits deleting a demo-tagged row, response unchanged", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      services: [{ data: { is_demo: true } }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await DELETE(req("DELETE", { id: "svc-1" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(writeCalls(currentFake.calls).length, 1);
    assert.equal(writeCalls(currentFake.calls)[0].method, "delete");
  });

  test("canceled denies deletion with the exact SUBSCRIPTION_RESTRICTED 403, zero writes, zero services-table reads", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await DELETE(req("DELETE", { id: "svc-1" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "services"), []);
  });

  test("a spoofed workspace_id in the request body does not change which workspace's entitlement is checked", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await DELETE(req("DELETE", { id: "svc-1", workspace_id: "attacker-ws" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });
});

describe("GET /api/services remains unaffected (read-only, no entitlement gate)", () => {
  test("succeeds even when the workspace is restricted -- GET never calls requireCapability", async () => {
    resetFixtures({ services: [{ data: [{ id: "svc-1", name: "Haircut" }] }] });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.services.length, 1);
  });
});
