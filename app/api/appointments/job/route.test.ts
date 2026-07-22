// Phase 5.4E2: route-level tests for app/api/appointments/job/route.ts
// (POST only -- this file has no GET handler). Proves
// requireCapability(session, "canUseJobTracking") is correctly wired before
// any appointment read/write. @/lib/session and @/lib/supabaseAdmin are
// mocked in-process; @/lib/entitlementServer is DELIBERATELY LEFT UNMOCKED
// -- the real requireCapability/fetchEntitlementForWorkspace/
// resolveWorkspaceEntitlement chain runs for real against a fake
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
function req(body?: unknown, url = "http://localhost/api/appointments/job") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const EMPLOYEE_ID = "emp-1";
const EMPLOYEE_SESSION = { role: "employee", employeeId: EMPLOYEE_ID, workspaceId: REAL_WORKSPACE_ID };

function notStartedAppt() {
  return { id: "appt-1", employee_id: EMPLOYEE_ID, actual_started_at: null, actual_completed_at: null };
}
function startedAppt() {
  return { id: "appt-1", employee_id: EMPLOYEE_ID, actual_started_at: "2026-07-21T10:00:00.000Z", actual_completed_at: null };
}

describe("POST /api/appointments/job -- entitlement gate", () => {
  const FULL_STATES: Array<[string, ReturnType<typeof subscriptionRow>]> = [
    ["active", subscriptionRow({ stripe_status: "active" })],
    ["trialing", subscriptionRow({ stripe_status: "trialing" })],
    ["past_due_grace", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() + 1000).toISOString() })],
    ["internal", subscriptionRow({ billing_mode: "internal", stripe_status: null })],
  ];

  for (const [label, row] of FULL_STATES) {
    test(`${label} permits "start", response unchanged`, async () => {
      resetFixtures({
        subscriptions: [{ data: row }],
        appointments: [{ data: notStartedAppt() }, { error: null }],
      });
      sessionToReturn = EMPLOYEE_SESSION;
      const res = await POST(req({ appointment_id: "appt-1", action: "start" }));
      assert.equal(res.status, 200, label);
      const body = await res.json();
      assert.equal(body.ok, true, label);
      assert.ok(body.actual_started_at, label);
      assert.equal(writeCalls(currentFake.calls).length, 1, label);
    });
  }

  test("exact trusted demo workspace permits the action with zero subscriptions-table queries (real short-circuit)", async () => {
    resetFixtures({
      appointments: [{ data: notStartedAppt() }, { error: null }],
    });
    sessionToReturn = { role: "employee", employeeId: EMPLOYEE_ID, workspaceId: DEMO_WORKSPACE_ID };
    const res = await POST(req({ appointment_id: "appt-1", action: "start" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  const RESTRICTED_STATES: Array<[string, ReturnType<typeof subscriptionRow> | null]> = [
    ["past_due_expired", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() - 1000).toISOString() })],
    ["canceled", subscriptionRow({ stripe_status: "canceled" })],
    ["no_subscription (no row)", null],
    ["malformed", subscriptionRow({ stripe_status: "not_a_real_status" })],
  ];

  for (const [label, row] of RESTRICTED_STATES) {
    test(`${label} returns the exact SUBSCRIPTION_RESTRICTED 403, zero appointment reads/writes`, async () => {
      resetFixtures({ subscriptions: [{ data: row }] });
      sessionToReturn = EMPLOYEE_SESSION;
      const res = await POST(req({ appointment_id: "appt-1", action: "start" }));
      assert.equal(res.status, 403, label);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY, label);
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments"), [], label);
    });
  }

  test("query_error on the subscriptions read denies, zero appointment access", async () => {
    resetFixtures({ subscriptions: [{ error: { message: "simulated DB error" } }] });
    sessionToReturn = EMPLOYEE_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", action: "start" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments"), []);
  });

  test("non-employee role (owner) retains the existing 401 role-denial, never reaches the entitlement check", async () => {
    resetFixtures({});
    sessionToReturn = { role: "owner", workspaceId: REAL_WORKSPACE_ID };
    const res = await POST(req({ appointment_id: "appt-1", action: "start" }));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
    assert.equal(body.code, undefined);
    assert.equal(currentFake.calls.length, 0, "no Supabase call at all -- role check happens first");
  });

  test("tester role retains the existing 401 role-denial (this route is employee-only), never SUBSCRIPTION_RESTRICTED", async () => {
    resetFixtures({});
    sessionToReturn = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };
    const res = await POST(req({ appointment_id: "appt-1", action: "start" }));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
    assert.equal(body.code, undefined);
  });

  test("unauthenticated (role: none) receives the existing 401 response and cannot probe subscription status", async () => {
    resetFixtures({});
    sessionToReturn = { role: "none" };
    const res = await POST(req({ appointment_id: "appt-1", action: "start" }));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
    assert.equal(body.code, undefined);
    assert.equal(currentFake.calls.length, 0);
  });

  test("a non-demo workspace cannot manufacture demo access by any request-supplied value", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = EMPLOYEE_SESSION; // REAL_WORKSPACE_ID, not demo
    const res = await POST(req({ appointment_id: "appt-1", action: "start", workspace_id: DEMO_WORKSPACE_ID }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  test("a spoofed workspace_id/query-string value does not change which workspace's entitlement is checked", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = EMPLOYEE_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", action: "start", workspace_id: "attacker-ws" }, "http://localhost/api/appointments/job?workspace_id=attacker-ws-2"));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  describe("mutation-specific validation runs only after auth/role/entitlement", () => {
    test("missing appointment_id + unauthenticated -> the existing 401, not 400, zero Supabase calls", async () => {
      resetFixtures({});
      sessionToReturn = { role: "none" };
      const res = await POST(req({ action: "start" })); // no appointment_id
      assert.equal(res.status, 401);
      assert.equal(currentFake.calls.length, 0);
    });

    test("missing appointment_id + restricted workspace -> the exact SUBSCRIPTION_RESTRICTED 403, not 400", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
      sessionToReturn = EMPLOYEE_SESSION;
      const res = await POST(req({ action: "start" })); // no appointment_id
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    });

    test("missing appointment_id + entitled workspace -> the existing 400 'Missing appointment_id' response", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
      sessionToReturn = EMPLOYEE_SESSION;
      const res = await POST(req({ action: "start" })); // no appointment_id
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Missing appointment_id" });
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments"), []);
    });
  });
});

describe("existing job-tracking business rules remain unchanged once entitled", () => {
  test("'complete' sets both actual_started_at and actual_completed_at when never started", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: notStartedAppt() }, { error: null }],
    });
    sessionToReturn = EMPLOYEE_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", action: "complete" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.actual_started_at);
    assert.ok(body.actual_completed_at);
  });

  test("'complete' after already started only sets actual_completed_at", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: startedAppt() }, { error: null }],
    });
    sessionToReturn = EMPLOYEE_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", action: "complete" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.actual_started_at, undefined);
    assert.ok(body.actual_completed_at);
  });

  test("'start' twice is rejected with the existing 'Job already started' 400, after entitlement passes", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: startedAppt() }],
    });
    sessionToReturn = EMPLOYEE_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", action: "start" }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Job already started" });
    assert.equal(writeCalls(currentFake.calls).length, 0);
  });

  test("an appointment assigned to a different employee is rejected with the existing 403, after entitlement passes", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: { ...notStartedAppt(), employee_id: "someone-else" } }],
    });
    sessionToReturn = EMPLOYEE_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", action: "start" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
  });
});
