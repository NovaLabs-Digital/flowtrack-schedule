// Block 2B + Block 2C-1: route-level tests for
// app/api/recurring-series/activate/route.ts (POST). Governed by
// canMutateOperationalData, the same capability every other
// appointment-adjacent mutation route in this repository uses.
// @/lib/entitlementServer is intentionally NOT mocked -- the real
// requireCapability chain runs against a fake "subscriptions" table. No
// real Supabase/network call is reachable. Run with
// --experimental-test-module-mocks (see package.json).
//
// Block 2C-1: the final activation write moved from a plain application-
// level compare-and-set UPDATE into the atomic activate_recurring_series
// Postgres RPC (see migrations/027a_add_recurring_series_snapshots.sql,
// whose own source-level test file proves the RPC's internal locking/
// validation logic in full -- that logic is opaque to this fake and is
// never re-proven here). This route's own job, and therefore what these
// tests prove, narrowed to: (1) it still performs every one of its own
// upfront reads/checks exactly as before (client, live occurrences,
// explicit template tamper-proof query, evaluateSeriesConsistency), (2) it
// calls the RPC with the correct expected-snapshot parameters built from
// that data, and (3) it maps every one of the RPC's five closed outcomes to
// the correct HTTP response, including two new ones the RPC can now detect
// that the prior JS implementation never could (employee_not_eligible,
// state_changed).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin, fakeSessionNamedExports, subscriptionRow, SUBSCRIPTION_RESTRICTED_BODY } from "../../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../../lib/testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});
let sessionToReturn: unknown = { role: "none" };

mock.module("@/lib/supabaseAdmin", {
  namedExports: {
    supabaseAdmin: {
      from: (table: string) => currentFake.supabaseAdmin.from(table),
      rpc: (fn: string, args?: unknown) => currentFake.supabaseAdmin.rpc(fn, args),
    },
  },
});
mock.module("@/lib/session", { namedExports: fakeSessionNamedExports(async () => sessionToReturn) });

const { POST } = await import("./route.ts");
const { REAL_WORKSPACE_ID } = await import("../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>, rpcResponses: Record<string, FakeSupabaseFixture[]> = {}) {
  currentFake = createFakeSupabaseAdmin(responses, rpcResponses);
}
function req(body?: unknown) {
  return new Request("http://localhost/api/recurring-series/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const OWNER_AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";
const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID, authUserId: OWNER_AUTH_USER_ID, sessionEpoch: 1 };

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
    ...overrides,
  };
}
function activeClient() {
  return { id: "client-1", status: "active", archived_at: null };
}
function occRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "appt-1",
    scheduled_for: "2026-06-02T13:00:00.000Z",
    service_type: "Regular Cleaning",
    price_cents: 10000,
    duration_minutes: 60,
    team_color: null,
    ...overrides,
  };
}
// Standard fixture set for a request that reaches the RPC call: series,
// client, one live occurrence, the explicit template tamper-proof query
// (now also selecting notes), appointment_employees (for
// fetchLiveOccurrenceSnapshots), and company_settings for timezone
// resolution.
function baseFixturesThroughRpc(extra: Record<string, unknown> = {}) {
  return {
    workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
    recurring_series: [{ data: seriesRow() }],
    clients: [{ data: activeClient() }],
    appointments: [{ data: [occRow()] }, { data: { id: "appt-1", notes: "Ring the bell" } }],
    appointment_employees: [{ data: [] }],
    company_settings: [{ data: { timezone: null } }],
    ...extra,
  };
}

describe("POST /api/recurring-series/activate is governed by canMutateOperationalData", () => {
  test("a fully consistent series activates: the RPC is called with the exact expected snapshot, and 'activated' returns 200", async () => {
    resetFixtures(baseFixturesThroughRpc(), { activate_recurring_series: [{ data: "activated" }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, timePattern: "consistent" });
    assert.equal(currentFake.rpcCalls.length, 1);
    const call = currentFake.rpcCalls[0];
    assert.equal(call.fn, "activate_recurring_series");
    assert.deepEqual(call.args, {
      p_series_id: "series-1",
      p_workspace_id: REAL_WORKSPACE_ID,
      p_client_id: "client-1",
      p_template_appointment_id: "appt-1",
      p_expected_service_type: "Regular Cleaning",
      p_expected_price_cents: 10000,
      p_expected_duration_minutes: 60,
      p_expected_notes: "Ring the bell",
      p_expected_team_color: null,
      p_expected_scheduled_for: "2026-06-02T13:00:00.000Z",
      p_expected_employee_ids: [],
      p_anchor_timezone: "America/New_York",
    });
  });

  test("failure injection: an RPC-call error returns 500 without leaking the raw error", async () => {
    resetFixtures(baseFixturesThroughRpc(), { activate_recurring_series: [{ error: { message: "simulated rpc failure" } }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes("simulated rpc failure"));
  });

  test("outcome 'conflict' -- already reviewed by someone else, 409", async () => {
    resetFixtures(baseFixturesThroughRpc(), { activate_recurring_series: [{ data: "conflict" }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "This series was already reviewed by someone else. Please refresh and try again." });
  });

  test("outcome 'client_not_active' -- the client became inactive/archived under the RPC's own lock, 409", async () => {
    resetFixtures(baseFixturesThroughRpc(), { activate_recurring_series: [{ data: "client_not_active" }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "This series' client is inactive or archived and cannot be activated." });
  });

  test("outcome 'employee_not_eligible' -- an assigned employee is no longer active/in-workspace, 409, safe owner-readable message", async () => {
    resetFixtures(baseFixturesThroughRpc(), { activate_recurring_series: [{ data: "employee_not_eligible" }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), {
      error: "One or more assigned employees are no longer active or no longer belong to this workspace. Update the assignment and try again.",
    });
  });

  test("outcome 'state_changed' -- the template's fields/assignments/identity no longer match what was validated, 409", async () => {
    resetFixtures(baseFixturesThroughRpc(), { activate_recurring_series: [{ data: "state_changed" }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "This appointment's details changed since you loaded this page. Please refresh and try again." });
  });

  test("outcome 'invalid_timezone' -- the RPC rejected an unsupported workspace timezone, 400, safe owner-readable message, never a raw error", async () => {
    resetFixtures(baseFixturesThroughRpc(), { activate_recurring_series: [{ data: "invalid_timezone" }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "This workspace's saved timezone isn't currently supported. Please update it in Settings and try again." });
  });

  test("a series with inconsistent live occurrences is refused with the specific blockers, never reaches the RPC at all", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      recurring_series: [{ data: seriesRow() }],
      clients: [{ data: activeClient() }],
      appointments: [
        { data: [occRow({ id: "appt-1", price_cents: 100 }), occRow({ id: "appt-2", price_cents: 200 })] },
        { data: { id: "appt-1", notes: null } },
      ],
      appointment_employees: [{ data: [] }, { data: [] }],
      company_settings: [{ data: { timezone: null } }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.ok(body.blockers.includes("price_mismatch"));
    assert.deepEqual(currentFake.rpcCalls, []);
  });

  test("a demo series can never be activated, regardless of role, never reaches the RPC", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      recurring_series: [{ data: seriesRow({ is_demo: true }) }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Demo series cannot be activated." });
    assert.deepEqual(currentFake.rpcCalls, []);
  });

  test("a series on an inactive client (upfront check) is refused, never reaches the RPC", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      recurring_series: [{ data: seriesRow() }],
      clients: [{ data: { id: "client-1", status: "inactive", archived_at: null } }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 409);
    assert.deepEqual(currentFake.rpcCalls, []);
  });

  test("a series with no live occurrences at all is refused with no_live_occurrences, never reaches the RPC", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      recurring_series: [{ data: seriesRow() }],
      clients: [{ data: activeClient() }],
      appointments: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.deepEqual(body.blockers, ["no_live_occurrences"]);
    assert.deepEqual(currentFake.rpcCalls, []);
  });

  test("an already-active series cannot be re-activated through this route, never reaches the RPC", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      recurring_series: [{ data: seriesRow({ status: "active", template_appointment_id: "appt-old", reviewed_at: "2026-01-01T00:00:00.000Z" }) }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "Only a series awaiting review can be activated." });
    assert.deepEqual(currentFake.rpcCalls, []);
  });

  test("series not found (wrong workspace) 404s, never leaks whether it exists elsewhere", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      recurring_series: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-none", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 404);
  });

  test("canceled denies activation with the exact SUBSCRIPTION_RESTRICTED 403, zero recurring_series reads or RPC calls", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "recurring_series"), []);
    assert.deepEqual(currentFake.rpcCalls, []);
  });

  test("missing series_id or template_appointment_id is rejected with 400 before any read", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1" }));
    assert.equal(res.status, 400);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "recurring_series"), []);
    assert.deepEqual(currentFake.rpcCalls, []);
  });

  test("a chosen template not among the series' current live occurrences is rejected, never reaches the RPC", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      recurring_series: [{ data: seriesRow() }],
      clients: [{ data: activeClient() }],
      appointments: [
        { data: [occRow({ id: "appt-1" })] },
        { data: null }, // the explicit template tamper-proof query finds no matching row for "appt-does-not-exist"
      ],
      appointment_employees: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-does-not-exist" }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body.blockers, ["template_not_in_series"]);
    assert.deepEqual(currentFake.rpcCalls, []);
  });
});

describe("POST /api/recurring-series/activate -- explicit template validation (never implicit, including client matching)", () => {
  // Every one of these five tampering scenarios is caught by the SAME
  // explicit, standalone query in the route: a single appointments row must
  // match template_appointment_id AND workspace_id AND series_id AND
  // series.client_id AND status='scheduled' AND a future scheduled_for, all
  // as their own .eq()/.gt() filters -- never inferred from the broader
  // occurrenceSnapshots list (which never checks client_id at all). The
  // occurrenceSnapshots fixture below always has a genuine, otherwise-valid
  // live occurrence so the "no_live_occurrences" check passes first and
  // each test exercises the explicit proof query specifically.
  function baseFixtures(templateProofResult: unknown) {
    return {
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      recurring_series: [{ data: seriesRow() }],
      clients: [{ data: activeClient() }],
      appointments: [{ data: [occRow({ id: "appt-1" })] }, { data: templateProofResult }],
      appointment_employees: [{ data: [] }],
    };
  }

  test("tampering: template belongs to a different workspace -- explicitly filtered by workspace_id, rejected", async () => {
    resetFixtures(baseFixtures(null));
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 400);
    assert.deepEqual((await res.json()).blockers, ["template_not_in_series"]);
    const eqCalls = currentFake.calls.filter((c) => c.table === "appointments" && c.method === "eq");
    assert.ok(eqCalls.some((c) => (c.args as unknown[])[0] === "workspace_id" && (c.args as unknown[])[1] === REAL_WORKSPACE_ID));
  });

  test("tampering: template belongs to a different series -- explicitly filtered by series_id, rejected", async () => {
    resetFixtures(baseFixtures(null));
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 400);
    assert.deepEqual((await res.json()).blockers, ["template_not_in_series"]);
    const eqCalls = currentFake.calls.filter((c) => c.table === "appointments" && c.method === "eq");
    assert.ok(eqCalls.some((c) => (c.args as unknown[])[0] === "series_id" && (c.args as unknown[])[1] === "series-1"));
  });

  test("tampering: template belongs to a different client -- client matching is explicit, never implicit, rejected", async () => {
    resetFixtures(baseFixtures(null));
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 400);
    assert.deepEqual((await res.json()).blockers, ["template_not_in_series"]);
    const eqCalls = currentFake.calls.filter((c) => c.table === "appointments" && c.method === "eq");
    assert.ok(
      eqCalls.some((c) => (c.args as unknown[])[0] === "client_id" && (c.args as unknown[])[1] === "client-1"),
      "the series' own client_id must be its own explicit filter, not assumed from series_id/workspace_id alone"
    );
  });

  test("tampering: template is a cancelled occurrence -- explicitly filtered by status='scheduled', rejected", async () => {
    resetFixtures(baseFixtures(null));
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 400);
    assert.deepEqual((await res.json()).blockers, ["template_not_in_series"]);
    const eqCalls = currentFake.calls.filter((c) => c.table === "appointments" && c.method === "eq");
    assert.ok(eqCalls.some((c) => (c.args as unknown[])[0] === "status" && (c.args as unknown[])[1] === "scheduled"));
  });

  test("tampering: template is a past appointment -- explicitly filtered to a future scheduled_for, rejected", async () => {
    resetFixtures(baseFixtures(null));
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 400);
    assert.deepEqual((await res.json()).blockers, ["template_not_in_series"]);
    const gtCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "gt");
    assert.ok(gtCall);
    assert.equal((gtCall!.args as unknown[])[0], "scheduled_for");
  });

  test("a genuinely matching template (all five dimensions correct) passes the explicit proof and activates successfully", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        recurring_series: [{ data: seriesRow() }],
        clients: [{ data: activeClient() }],
        appointments: [{ data: [occRow({ id: "appt-1" })] }, { data: { id: "appt-1", notes: null } }],
        appointment_employees: [{ data: [] }],
        company_settings: [{ data: { timezone: null } }],
      },
      { activate_recurring_series: [{ data: "activated" }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ series_id: "series-1", template_appointment_id: "appt-1" }));
    assert.equal(res.status, 200);
  });
});
