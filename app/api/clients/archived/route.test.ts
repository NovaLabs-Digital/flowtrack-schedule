// Phase 5.6E: route-level tests for app/api/clients/archived/route.ts
// (GET). This route previously had no entitlement check at all; it now
// requires canViewExistingData, the same defense-in-depth guard added to
// the employees/services/settings-company GET routes in this phase.
// @/lib/entitlementServer is intentionally NOT mocked -- the real
// requireCapability chain runs against a fake "subscriptions" table. No
// real Supabase/Stripe/network call is reachable. Run with
// --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin, fakeSessionNamedExports, subscriptionRow, SUBSCRIPTION_RESTRICTED_BODY, SERVICE_UNAVAILABLE_BODY } from "../../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../../lib/testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});
let sessionToReturn: unknown = { role: "none" };

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});
mock.module("@/lib/session", { namedExports: fakeSessionNamedExports(async () => sessionToReturn) });

const { GET } = await import("./route.ts");
const { REAL_WORKSPACE_ID } = await import("../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}

const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID };

describe("GET /api/clients/archived is governed by canViewExistingData (Phase 5.6E)", () => {
  test("succeeds for full access", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: [{ id: "c1", name: "Jane", email: null, phone: null, archived_at: "2026-01-01T00:00:00.000Z", status: "archived" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.clients.length, 1);
  });

  test("still succeeds during canceled_read_only -- viewing existing data remains available", async () => {
    resetFixtures({
      subscriptions: [
        { data: subscriptionRow({ stripe_status: "canceled", canceled_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString() }) },
      ],
      clients: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    assert.equal(res.status, 200);
  });

  test("denied once canceled_locked (30+ days after canceled_at)", async () => {
    resetFixtures({
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

  test("canceled_locked denial happens before any clients-table read", async () => {
    resetFixtures({
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
    await GET();
    assert.equal(currentFake.calls.filter((c) => c.table === "clients").length, 0);
  });

  test("Phase 5.6F-R1: a transient subscription-query failure rejects with 503, not the 403 subscription body, before any clients-table read", async () => {
    resetFixtures({
      subscriptions: [{ error: { message: "simulated Supabase outage" } }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), SERVICE_UNAVAILABLE_BODY);
    assert.equal(currentFake.calls.filter((c) => c.table === "clients").length, 0);
  });
});
