// Phase 5.4E1: route-level tests for app/api/employees/route.ts (POST,
// PATCH). GET (read-only) is deliberately left untouched and is proven
// unaffected below. @/lib/entitlementServer is intentionally NOT mocked --
// the real requireCapability chain runs against a fake "subscriptions"
// table. No real Supabase/Stripe/network call is reachable. Run with
// --experimental-test-module-mocks (see package.json).
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

const { GET, POST, PATCH } = await import("./route.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}
function req(method: string, body?: unknown) {
  return new Request("http://localhost/api/employees", {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID };

describe("POST /api/employees -- entitlement gate", () => {
  test("active permits creating an employee, response unchanged", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      employees: [{ data: { id: "emp-1", name: "Bob", phone: null, color: "#3B82F6", active: true, email: null, position: null } }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { name: "Bob" }));
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.id, "emp-1");
    assert.equal(writeCalls(currentFake.calls).length, 1);
    assert.equal(writeCalls(currentFake.calls)[0].method, "insert");
  });

  test("canceled denies with the exact SUBSCRIPTION_RESTRICTED 403, zero writes, zero employees-table reads", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { name: "Bob" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "employees"), []);
  });

  test("internal permits creation without Stripe dependence", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ billing_mode: "internal", stripe_status: null }) }],
      employees: [{ data: { id: "emp-2", name: "Ann" } }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { name: "Ann" }));
    assert.equal(res.status, 201);
  });

  test("exact trusted demo workspace permits creation with zero subscriptions-table queries", async () => {
    resetFixtures({ employees: [{ data: { id: "emp-3", name: "Demo Emp" } }] });
    sessionToReturn = { role: "owner", workspaceId: DEMO_WORKSPACE_ID };
    const res = await POST(req("POST", { name: "Demo Emp" }));
    assert.equal(res.status, 201);
  });

  test("query_error on the subscriptions read denies, zero writes", async () => {
    resetFixtures({ subscriptions: [{ error: { message: "simulated DB error" } }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { name: "Bob" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "employees"), []);
  });

  test("non-owner role denial remains a plain 403 Unauthorized, never SUBSCRIPTION_RESTRICTED, and never queries subscriptions", async () => {
    resetFixtures({});
    sessionToReturn = { role: "employee", employeeId: "e1", workspaceId: REAL_WORKSPACE_ID };
    const res = await POST(req("POST", { name: "Bob" }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, undefined);
    assert.equal(body.error, "Unauthorized");
  });

  test("a spoofed workspace_id in the request body does not change which workspace's entitlement is checked", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { name: "Bob", workspace_id: "attacker-ws" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });
});

describe("PATCH /api/employees -- entitlement gate", () => {
  test("active permits updating an employee, response unchanged", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      employees: [{ data: { is_demo: false } }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req("PATCH", { id: "emp-1", name: "New Name" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(writeCalls(currentFake.calls).length, 1);
  });

  test("trialing permits updating an employee", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "trialing" }) }],
      employees: [{ data: { is_demo: false } }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req("PATCH", { id: "emp-1", name: "New Name" }));
    assert.equal(res.status, 200);
  });

  test("past_due_grace (valid) permits updating an employee", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() + 1000).toISOString() }) }],
      employees: [{ data: { is_demo: false } }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req("PATCH", { id: "emp-1", name: "New Name" }));
    assert.equal(res.status, 200);
  });

  test("past_due_grace expired denies with the exact SUBSCRIPTION_RESTRICTED 403, zero writes", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() - 1000).toISOString() }) }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req("PATCH", { id: "emp-1", name: "New Name" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(writeCalls(currentFake.calls), []);
  });

  test("malformed entitlement data denies, zero writes", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "not_a_real_status" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req("PATCH", { id: "emp-1", name: "New Name" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(writeCalls(currentFake.calls), []);
  });
});

describe("GET /api/employees remains unaffected (read-only, no entitlement gate)", () => {
  test("succeeds even when the workspace is restricted -- GET never calls requireCapability", async () => {
    resetFixtures({
      // No "subscriptions" fixture queued: if GET were ever wired to the
      // gate by accident, the missing fixture would throw and fail this test.
      employees: [{ data: [{ id: "emp-1", name: "Bob" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.length, 1);
  });
});
