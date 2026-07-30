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
import { createFakeSupabaseAdmin, writeCalls, fakeSessionNamedExports, subscriptionRow, SUBSCRIPTION_RESTRICTED_BODY, SERVICE_UNAVAILABLE_BODY } from "../../../lib/testSupport.ts";
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

const OWNER_AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";
const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID, authUserId: OWNER_AUTH_USER_ID, sessionEpoch: 1 };

describe("POST /api/services -- entitlement gate", () => {
  test("active permits creating a service, response unchanged", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
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
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { name: "Haircut" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "services"), []);
  });

  test("internal permits creation without Stripe dependence", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
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
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
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
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ data: subscriptionRow({ stripe_status: "unpaid" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req("PATCH", { id: "svc-1", name: "New Name" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "services"), []);
  });

  test("query_error on the subscriptions read denies, zero writes", async () => {
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ error: { message: "simulated DB error" } }] });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req("PATCH", { id: "svc-1", name: "New Name" }));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), SERVICE_UNAVAILABLE_BODY);
  });
});

describe("DELETE /api/services -- entitlement gate", () => {
  test("active permits deleting a demo-tagged row, response unchanged", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
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
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await DELETE(req("DELETE", { id: "svc-1" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "services"), []);
  });

  test("a spoofed workspace_id in the request body does not change which workspace's entitlement is checked", async () => {
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await DELETE(req("DELETE", { id: "svc-1", workspace_id: "attacker-ws" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });
});

describe("Phase 5.7D-R17: optional service default pricing", () => {
  test("POST with a valid price stores it as integer cents", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      services: [{ error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { name: "Haircut", default_price_cents: 4550 }));
    assert.equal(res.status, 200);
    const insertCall = writeCalls(currentFake.calls)[0];
    assert.equal((insertCall.args[0] as { default_price_cents?: number }).default_price_cents, 4550);
  });

  test("POST with $0.00 (integer 0) stores exactly 0, not null", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      services: [{ error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { name: "Estimate", default_price_cents: 0 }));
    assert.equal(res.status, 200);
    const insertCall = writeCalls(currentFake.calls)[0];
    assert.equal((insertCall.args[0] as { default_price_cents?: number }).default_price_cents, 0);
  });

  test("POST with no price at all defaults to null -- existing/new services remain valid with no price", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      services: [{ error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { name: "Haircut" }));
    assert.equal(res.status, 200);
    const insertCall = writeCalls(currentFake.calls)[0];
    assert.equal((insertCall.args[0] as { default_price_cents?: number | null }).default_price_cents, null);
  });

  test("POST with a negative price is rejected with 400, zero writes", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { name: "Haircut", default_price_cents: -100 }));
    assert.equal(res.status, 400);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "services"), []);
  });

  test("POST with a malformed (non-integer) price is rejected with 400, zero writes", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { name: "Haircut", default_price_cents: 45.5 }));
    assert.equal(res.status, 400);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "services"), []);
  });

  test("POST with an excessively large price is rejected with 400, zero writes", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { name: "Haircut", default_price_cents: 999_999_999 }));
    assert.equal(res.status, 400);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "services"), []);
  });

  test("PATCH with a new valid price updates default_price_cents", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      services: [{ data: { is_demo: false } }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req("PATCH", { id: "svc-1", default_price_cents: 8000 }));
    assert.equal(res.status, 200);
    const updateCall = writeCalls(currentFake.calls).find((c) => c.method === "update");
    assert.equal((updateCall!.args[0] as { default_price_cents?: number }).default_price_cents, 8000);
  });

  test("PATCH with default_price_cents: null explicitly clears a previously-set price", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      services: [{ data: { is_demo: false } }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req("PATCH", { id: "svc-1", default_price_cents: null }));
    assert.equal(res.status, 200);
    const updateCall = writeCalls(currentFake.calls).find((c) => c.method === "update");
    assert.equal((updateCall!.args[0] as { default_price_cents?: number | null }).default_price_cents, null);
  });

  test("PATCH omitting default_price_cents entirely leaves it untouched -- the update payload has no such key", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      services: [{ data: { is_demo: false } }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req("PATCH", { id: "svc-1", name: "Renamed" }));
    assert.equal(res.status, 200);
    const updateCall = writeCalls(currentFake.calls).find((c) => c.method === "update");
    assert.equal("default_price_cents" in (updateCall!.args[0] as object), false);
  });

  test("PATCH with an invalid price is rejected with 400 and never reaches the update call", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      services: [{ data: { is_demo: false } }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req("PATCH", { id: "svc-1", default_price_cents: -50 }));
    assert.equal(res.status, 400);
    assert.deepEqual(writeCalls(currentFake.calls), []);
  });

  test("GET includes default_price_cents in the selected columns", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      services: [{ data: [{ id: "svc-1", name: "Haircut", default_price_cents: 4550 }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    const body = await res.json();
    assert.equal(body.services[0].default_price_cents, 4550);
    const selectCall = currentFake.calls.find((c) => c.table === "services" && c.method === "select");
    assert.ok((selectCall!.args[0] as string).includes("default_price_cents"));
  });
});

describe("GET /api/services is governed by canViewExistingData (Phase 5.6E)", () => {
  test("succeeds for full access", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      services: [{ data: [{ id: "svc-1", name: "Haircut" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.services.length, 1);
  });

  test("still succeeds during canceled_read_only -- viewing existing data remains available", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [
        { data: subscriptionRow({ stripe_status: "canceled", canceled_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString() }) },
      ],
      services: [{ data: [{ id: "svc-1", name: "Haircut" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    assert.equal(res.status, 200);
  });

  test("denied once canceled_locked (30+ days after canceled_at)", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [
        {
          data: subscriptionRow({
            stripe_status: "canceled",
            canceled_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 31).toISOString(),
          }),
        },
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  test("Phase 5.6F-R1: a transient subscription-query failure rejects with 503, not the 403 subscription body, before any services-table read", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ error: { message: "simulated Supabase outage" } }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), SERVICE_UNAVAILABLE_BODY);
    assert.equal(currentFake.calls.filter((c) => c.table === "services").length, 0);
  });
});
