// Phase 5.4E2: route-level tests for
// app/api/appointments/employee-hours/route.ts (POST only -- this file has
// no GET handler). Proves requireCapability(session, "canUseJobTracking")
// is correctly wired before any appointment/employee read or
// appointment_employee_hours write. @/lib/session and @/lib/supabaseAdmin
// are mocked in-process; @/lib/entitlementServer is DELIBERATELY LEFT
// UNMOCKED -- the real requireCapability chain runs against a fake
// "subscriptions" table. No real Supabase/Stripe/network call is
// reachable. Run with --experimental-test-module-mocks (see package.json).
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

const { POST } = await import("./route.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}
function req(body?: unknown, url = "http://localhost/api/appointments/employee-hours") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID };
const VALID_BODY = { appointment_id: "appt-1", employee_id: "emp-1", hours_worked: 2.5, note: "Forgot to clock in" };

function incompleteAppt() {
  return { actual_started_at: null, actual_completed_at: null };
}
function completeAppt() {
  return { actual_started_at: "2026-07-21T09:00:00.000Z", actual_completed_at: "2026-07-21T11:00:00.000Z" };
}

describe("POST /api/appointments/employee-hours -- entitlement gate", () => {
  const FULL_STATES: Array<[string, ReturnType<typeof subscriptionRow>]> = [
    ["active", subscriptionRow({ stripe_status: "active" })],
    ["trialing", subscriptionRow({ stripe_status: "trialing" })],
    ["past_due_grace", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() + 1000).toISOString() })],
    ["internal", subscriptionRow({ billing_mode: "internal", stripe_status: null })],
  ];

  for (const [label, row] of FULL_STATES) {
    test(`${label} permits saving manual hours, response unchanged`, async () => {
      resetFixtures({
        subscriptions: [{ data: row }],
        appointments: [{ data: incompleteAppt() }],
        employees: [{ data: { id: "emp-1" } }],
        appointment_employee_hours: [{ data: { id: "aeh-1", appointment_id: "appt-1", employee_id: "emp-1", hours_worked: 2.5, note: "Forgot to clock in" } }],
      });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req(VALID_BODY));
      assert.equal(res.status, 200, label);
      const body = await res.json();
      assert.equal(body.ok, true, label);
      assert.equal(body.entry.id, "aeh-1", label);
      assert.equal(writeCalls(currentFake.calls).length, 1, label);
    });
  }

  test("exact trusted demo workspace permits saving manual hours with zero subscriptions-table queries", async () => {
    resetFixtures({
      appointments: [{ data: incompleteAppt() }],
      employees: [{ data: { id: "emp-1" } }],
      appointment_employee_hours: [{ data: { id: "aeh-1" } }],
    });
    sessionToReturn = { role: "owner", workspaceId: DEMO_WORKSPACE_ID };
    const res = await POST(req(VALID_BODY));
    assert.equal(res.status, 200);
  });

  const RESTRICTED_STATES: Array<[string, ReturnType<typeof subscriptionRow> | null]> = [
    ["past_due_expired", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() - 1000).toISOString() })],
    ["canceled", subscriptionRow({ stripe_status: "canceled" })],
    ["no_subscription (no row)", null],
    ["malformed", subscriptionRow({ stripe_status: "not_a_real_status" })],
  ];

  for (const [label, row] of RESTRICTED_STATES) {
    test(`${label} returns the exact SUBSCRIPTION_RESTRICTED 403, zero appointment/employee reads, zero writes`, async () => {
      resetFixtures({ subscriptions: [{ data: row }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req(VALID_BODY));
      assert.equal(res.status, 403, label);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY, label);
      assert.deepEqual(currentFake.calls.filter((c) => c.table !== "subscriptions"), [], label);
    });
  }

  test("query_error on the subscriptions read denies, zero appointment/employee access", async () => {
    resetFixtures({ subscriptions: [{ error: { message: "simulated DB error" } }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(VALID_BODY));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table !== "subscriptions"), []);
  });

  test("non-owner role (employee) retains the existing role-denial response, never SUBSCRIPTION_RESTRICTED", async () => {
    resetFixtures({});
    sessionToReturn = { role: "employee", employeeId: "emp-1", workspaceId: REAL_WORKSPACE_ID };
    const res = await POST(req(VALID_BODY));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
    assert.equal(body.code, undefined);
    assert.equal(currentFake.calls.length, 0);
  });

  test("tester role retains the existing role-denial response (owner-only route), never SUBSCRIPTION_RESTRICTED", async () => {
    resetFixtures({});
    sessionToReturn = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };
    const res = await POST(req(VALID_BODY));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
    assert.equal(body.code, undefined);
  });

  test("unauthenticated (role: none) receives the existing role-denial response and cannot probe subscription status", async () => {
    resetFixtures({});
    sessionToReturn = { role: "none" };
    const res = await POST(req(VALID_BODY));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
    assert.equal(body.code, undefined);
    assert.equal(currentFake.calls.length, 0);
  });

  test("a non-demo workspace cannot manufacture demo access by any request-supplied value", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ ...VALID_BODY, workspace_id: DEMO_WORKSPACE_ID }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  test("a spoofed workspace_id/query-string value does not change which workspace's entitlement is checked", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ ...VALID_BODY, workspace_id: "attacker-ws" }, "http://localhost/api/appointments/employee-hours?workspace_id=attacker-ws-2"));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  describe("mutation-specific validation runs only after auth/role/entitlement", () => {
    test("missing appointment_id + unauthenticated -> the existing role-denial, not 400, zero Supabase calls", async () => {
      resetFixtures({});
      sessionToReturn = { role: "none" };
      const res = await POST(req({ employee_id: "emp-1", hours_worked: 2, note: "x" }));
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error, "Unauthorized");
      assert.equal(currentFake.calls.length, 0);
    });

    test("missing appointment_id + restricted workspace -> the exact SUBSCRIPTION_RESTRICTED 403, not 400", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ employee_id: "emp-1", hours_worked: 2, note: "x" }));
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    });

    test("missing appointment_id + entitled workspace -> the existing 400 'Missing appointment_id' response", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ employee_id: "emp-1", hours_worked: 2, note: "x" }));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Missing appointment_id" });
      assert.deepEqual(currentFake.calls.filter((c) => c.table !== "subscriptions"), []);
    });
  });
});

describe("existing manual-hours business rules remain unchanged once entitled", () => {
  test("missing employee_id -> existing 400, after entitlement passes", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", hours_worked: 2, note: "x" }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Missing employee_id" });
  });

  test("non-positive hours_worked -> existing 400, after entitlement passes", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", employee_id: "emp-1", hours_worked: 0, note: "x" }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Hours worked must be a positive number" });
  });

  test("missing note/reason -> existing 400, after entitlement passes", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", employee_id: "emp-1", hours_worked: 2 }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "A reason is required (e.g. forgot to clock in/out)." });
  });

  test("genuinely complete Job Tracking still blocks manual override with the existing 409, after entitlement passes", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: completeAppt() }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(VALID_BODY));
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "This appointment already has tracked time from Job Tracking, which cannot be overridden." });
    assert.equal(writeCalls(currentFake.calls).length, 0);
  });

  test("an employee_id not belonging to this workspace still 404s with the existing message, after entitlement passes", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: incompleteAppt() }],
      employees: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(VALID_BODY));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Employee not found" });
  });
});
