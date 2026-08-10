// Block 2B: route-level tests for app/api/recurring-series/route.ts (GET).
// Governed by canViewExistingData, matching the established pattern for
// other read-heavy business-data GET routes (clients/archived, employees,
// services, settings/company). @/lib/entitlementServer is intentionally NOT
// mocked -- the real requireCapability chain runs against a fake
// "subscriptions" table. No real Supabase/network call is reachable. Run
// with --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin, fakeSessionNamedExports, subscriptionRow, SUBSCRIPTION_RESTRICTED_BODY } from "../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../lib/testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});
let sessionToReturn: unknown = { role: "none" };

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});
mock.module("@/lib/session", { namedExports: fakeSessionNamedExports(async () => sessionToReturn) });

const { GET } = await import("./route.ts");
const { REAL_WORKSPACE_ID, DEMO_WORKSPACE_ID } = await import("../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}

const OWNER_AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";
const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID, authUserId: OWNER_AUTH_USER_ID, sessionEpoch: 1 };

const NOW_ISO = new Date().toISOString();
const FUTURE_SOON = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days out
const FUTURE_FAR = new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString(); // 200 days out

function seriesRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "series-1",
    workspace_id: REAL_WORKSPACE_ID,
    status: "review_required",
    client_id: "client-1",
    is_demo: false,
    template_appointment_id: null,
    frequency_type: "weekly",
    repeat_weeks: 1,
    repeat_months: null,
    anchor_local_date: "2026-06-02",
    anchor_local_time: "09:00",
    anchor_timezone: "America/New_York",
    source: "legacy_backfill",
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    stopped_at: null,
    reviewed_at: null,
    last_replenished_at: null,
    ...overrides,
  };
}

describe("GET /api/recurring-series is governed by canViewExistingData", () => {
  test("full access returns the review queue with client/occurrence context, no PII beyond what the owner's own client record already carries", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      recurring_series: [{ data: [seriesRow()] }],
      clients: [{ data: [{ id: "client-1", name: "Jane Doe", status: "active", archived_at: null }] }],
      appointments: [
        {
          data: [
            { id: "appt-1", series_id: "series-1", scheduled_for: FUTURE_SOON, service_type: "Regular Cleaning", price_cents: 10000, duration_minutes: 60 },
          ],
        },
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.series.length, 1);
    assert.equal(body.series[0].clientName, "Jane Doe");
    assert.equal(body.series[0].candidates.length, 1);
    assert.equal(body.series[0].hasLiveOccurrences, true);
    assert.equal(body.series[0].expiresWithin30Days, true);
  });

  test("a series with no live occurrences is still listed, flagged hasLiveOccurrences: false", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      recurring_series: [{ data: [seriesRow({ id: "series-dead" })] }],
      clients: [{ data: [{ id: "client-1", name: "Jane Doe", status: "active", archived_at: null }] }],
      appointments: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.series[0].hasLiveOccurrences, false);
    assert.equal(body.series[0].expiresWithin30Days, false);
  });

  test("a series on an inactive/archived client is flagged clientInactiveOrArchived: true", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      recurring_series: [{ data: [seriesRow()] }],
      clients: [{ data: [{ id: "client-1", name: "Jane Doe", status: "inactive", archived_at: "2026-01-01T00:00:00.000Z" }] }],
      appointments: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    const body = await res.json();
    assert.equal(body.series[0].clientInactiveOrArchived, true);
  });

  test("only review_required series are returned -- the query itself is scoped, not filtered client-side after the fact", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      recurring_series: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    await GET();
    const eqCall = currentFake.calls.find(
      (c) => c.table === "recurring_series" && c.method === "eq" && (c.args as unknown[])[0] === "status"
    );
    assert.deepEqual(eqCall!.args, ["status", "review_required"]);
  });

  test("a tester session is scoped to is_demo=true series only, matching the established defense-in-depth convention", async () => {
    resetFixtures({ recurring_series: [{ data: [] }] });
    sessionToReturn = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };
    await GET();
    const eqCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "eq");
    assert.ok(eqCalls.some((c) => (c.args as unknown[])[0] === "is_demo" && (c.args as unknown[])[1] === true));
  });

  test("series expiring soonest sort before series expiring later, and series with no live occurrences sort last", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      recurring_series: [{ data: [seriesRow({ id: "series-far" }), seriesRow({ id: "series-soon" }), seriesRow({ id: "series-none" })] }],
      clients: [{ data: [{ id: "client-1", name: "Jane Doe", status: "active", archived_at: null }] }],
      appointments: [
        {
          data: [
            { id: "appt-far", series_id: "series-far", scheduled_for: FUTURE_FAR, service_type: "Regular", price_cents: null, duration_minutes: 60 },
            { id: "appt-soon", series_id: "series-soon", scheduled_for: FUTURE_SOON, service_type: "Regular", price_cents: null, duration_minutes: 60 },
          ],
        },
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    const body = await res.json();
    const order = body.series.map((s: any) => s.id);
    assert.deepEqual(order, ["series-soon", "series-far", "series-none"]);
  });

  test("canceled denies the review queue with the exact SUBSCRIPTION_RESTRICTED 403, zero recurring_series reads", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "recurring_series"), []);
  });

  test("non-owner/tester role (employee) is denied before any entitlement query", async () => {
    resetFixtures({});
    sessionToReturn = { role: "employee", employeeId: "e1", workspaceId: REAL_WORKSPACE_ID };
    const res = await GET();
    assert.equal(res.status, 403);
    assert.equal(currentFake.calls.length, 0);
  });
});
