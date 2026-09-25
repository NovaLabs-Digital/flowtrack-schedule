// Route-level tests for app/api/appointments/employee-hours/route.ts (POST only).
//
// The write itself is now ONE database call, save_employee_hours
// (migrations/030): it locks the parent appointment FIRST (so a new manual
// hours row cannot slip past a concurrent recurrence change's recorded-work
// check), revalidates it, enforces "assigned to THIS appointment" and the
// tracked-time override guard, and upserts. These tests use a mocked RPC and
// so prove only the route: the capability gate runs before anything,
// validation order, that the RPC receives the session's workspace, and the
// outcome -> HTTP mapping. Locking / rollback / concurrency are proven
// against real PostgreSQL in test-db/recurrence.test.ts.
// @/lib/session and @/lib/supabaseAdmin are mocked; @/lib/entitlementServer is
// DELIBERATELY UNMOCKED (real requireCapability chain over a fake
// "subscriptions" table).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin, writeCalls, fakeSessionNamedExports, subscriptionRow, SUBSCRIPTION_RESTRICTED_BODY, SERVICE_UNAVAILABLE_BODY } from "../../../../lib/testSupport.ts";
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
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>, rpc: FakeSupabaseFixture[] = []) {
  currentFake = createFakeSupabaseAdmin(responses, rpc.length ? { save_employee_hours: rpc } : {});
}
function req(body?: unknown, url = "http://localhost/api/appointments/employee-hours") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const OWNER_AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";
const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID, authUserId: OWNER_AUTH_USER_ID, sessionEpoch: 1 };
const VALID_BODY = { appointment_id: "appt-1", employee_id: "emp-1", hours_worked: 2.5, note: "Forgot to clock in" };
const MEMBERSHIP = { workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }] };
const ACTIVE = { ...MEMBERSHIP, subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] };
const ENTRY = { id: "aeh-1", appointment_id: "appt-1", employee_id: "emp-1", hours_worked: 2.5, note: "Forgot to clock in", created_at: "x", updated_at: "x" };
const savedOk: FakeSupabaseFixture = { data: { outcome: "ok", entry: ENTRY } };

describe("POST /api/appointments/employee-hours -- entitlement gate", () => {
  const FULL_STATES: Array<[string, ReturnType<typeof subscriptionRow>]> = [
    ["active", subscriptionRow({ stripe_status: "active" })],
    ["trialing", subscriptionRow({ stripe_status: "trialing" })],
    ["past_due_grace", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() + 1000).toISOString() })],
    ["internal", subscriptionRow({ billing_mode: "internal", stripe_status: null })],
  ];

  for (const [label, row] of FULL_STATES) {
    test(`${label} permits saving manual hours, response unchanged`, async () => {
      resetFixtures({ ...MEMBERSHIP, subscriptions: [{ data: row }] }, [savedOk]);
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req(VALID_BODY));
      assert.equal(res.status, 200, label);
      assert.deepEqual(await res.json(), { ok: true, entry: ENTRY }, label);
      assert.equal(currentFake.rpcCalls.length, 1);
      assert.deepEqual(writeCalls(currentFake.calls), [], "the route writes nothing itself; the RPC does");
    });
  }

  test("exact trusted demo workspace permits saving manual hours with zero subscriptions-table queries", async () => {
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: DEMO_WORKSPACE_ID, session_epoch: 1 } }] }, [savedOk]);
    sessionToReturn = { role: "owner", workspaceId: DEMO_WORKSPACE_ID, authUserId: OWNER_AUTH_USER_ID, sessionEpoch: 1 };
    const res = await POST(req(VALID_BODY));
    assert.equal(res.status, 200);
    assert.equal(currentFake.calls.filter((c) => c.table === "subscriptions").length, 0);
  });

  const RESTRICTED_STATES: Array<[string, ReturnType<typeof subscriptionRow> | null]> = [
    ["past_due_expired", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() - 1000).toISOString() })],
    ["canceled", subscriptionRow({ stripe_status: "canceled" })],
    ["no_subscription (no row)", null],
    ["malformed", subscriptionRow({ stripe_status: "not_a_real_status" })],
  ];

  for (const [label, row] of RESTRICTED_STATES) {
    test(`${label} returns the exact SUBSCRIPTION_RESTRICTED 403, zero database work`, async () => {
      resetFixtures({ ...MEMBERSHIP, subscriptions: [{ data: row }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req(VALID_BODY));
      assert.equal(res.status, 403, label);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY, label);
      assert.equal(currentFake.rpcCalls.length, 0, label);
    });
  }

  test("query_error on the subscriptions read denies (503), zero database work", async () => {
    resetFixtures({ ...MEMBERSHIP, subscriptions: [{ error: { message: "simulated DB error" } }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(VALID_BODY));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), SERVICE_UNAVAILABLE_BODY);
    assert.equal(currentFake.rpcCalls.length, 0);
  });

  for (const [label, session] of [
    ["employee", { role: "employee", employeeId: "e1", workspaceId: REAL_WORKSPACE_ID }],
    ["tester", { role: "tester", workspaceId: DEMO_WORKSPACE_ID }],
    ["unauthenticated", { role: "none" }],
  ] as const) {
    test(`${label} keeps the existing role denial and touches nothing (owner-only route)`, async () => {
      resetFixtures({});
      sessionToReturn = session;
      const res = await POST(req(VALID_BODY));
      assert.equal(res.status, 403);
      assert.equal(currentFake.calls.length, 0);
      assert.equal(currentFake.rpcCalls.length, 0);
    });
  }

  test("a spoofed workspace_id in the body/query does not change which workspace's entitlement is checked", async () => {
    resetFixtures({ ...MEMBERSHIP, subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ ...VALID_BODY, workspace_id: DEMO_WORKSPACE_ID }, "http://localhost/api/appointments/employee-hours?workspace_id=attacker"));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  describe("mutation-specific validation runs only after auth/role/entitlement", () => {
    test("missing appointment_id + unauthenticated -> the existing role-denial, not 400, zero Supabase calls", async () => {
      resetFixtures({});
      sessionToReturn = { role: "none" };
      const res = await POST(req({ ...VALID_BODY, appointment_id: undefined }));
      assert.equal(res.status, 403);
      assert.equal(currentFake.calls.length, 0);
    });

    test("missing appointment_id + restricted workspace -> the exact SUBSCRIPTION_RESTRICTED 403, not 400", async () => {
      resetFixtures({ ...MEMBERSHIP, subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ ...VALID_BODY, appointment_id: undefined }));
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    });

    test("missing appointment_id + entitled workspace -> the existing 400, no RPC", async () => {
      resetFixtures(ACTIVE);
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ ...VALID_BODY, appointment_id: undefined }));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Missing appointment_id" });
      assert.equal(currentFake.rpcCalls.length, 0);
    });
  });
});

describe("existing manual-hours validation is unchanged and never reaches the database", () => {
  for (const [label, body, status, message] of [
    ["missing employee_id", { ...VALID_BODY, employee_id: undefined }, 400, "Missing employee_id"],
    ["zero hours", { ...VALID_BODY, hours_worked: 0 }, 400, "Hours worked must be a positive number"],
    ["negative hours", { ...VALID_BODY, hours_worked: -1 }, 400, "Hours worked must be a positive number"],
    ["non-numeric hours", { ...VALID_BODY, hours_worked: "abc" }, 400, "Hours worked must be a positive number"],
    ["missing note/reason", { ...VALID_BODY, note: "  " }, 400, "A reason is required (e.g. forgot to clock in/out)."],
  ] as const) {
    test(`${label} -> ${status}`, async () => {
      resetFixtures(ACTIVE);
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req(body));
      assert.equal(res.status, status);
      assert.deepEqual(await res.json(), { error: message });
      assert.equal(currentFake.rpcCalls.length, 0);
    });
  }
});

describe("the RPC receives the session's workspace and the trimmed inputs", () => {
  test("workspace_id in the body is ignored; the note is trimmed; hours are passed as a number", async () => {
    resetFixtures(ACTIVE, [savedOk]);
    sessionToReturn = OWNER_SESSION;
    await POST(req({ ...VALID_BODY, workspace_id: "attacker-ws", note: "  Forgot to clock in  " }));
    assert.deepEqual(currentFake.rpcCalls[0], {
      fn: "save_employee_hours",
      args: { p_workspace_id: REAL_WORKSPACE_ID, p_appointment_id: "appt-1", p_employee_id: "emp-1", p_hours_worked: 2.5, p_note: "Forgot to clock in" },
    });
  });

  test("this route reads and writes no table itself -- the assignment lookup, override guard and upsert all happen inside the RPC", async () => {
    resetFixtures(ACTIVE, [savedOk]);
    sessionToReturn = OWNER_SESSION;
    await POST(req(VALID_BODY));
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointment_employees" || c.table === "appointment_employee_hours"), []);
  });
});

describe("outcome -> HTTP mapping (existing messages preserved)", () => {
  test("an employee who is not assigned to this appointment is a 404", async () => {
    resetFixtures(ACTIVE, [{ data: { outcome: "not_assigned" } }]);
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(VALID_BODY));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Employee is not assigned to this appointment." });
  });

  // migrations/031: a complete Job Tracking duration no longer blocks this
  // write -- this route is owner-only (requireOwner above), so a save here
  // is always an owner-approved correction/override. The RPC's "ok" outcome
  // is what it returns in exactly this case; there is no separate
  // "tracked_time_exists" outcome to map any more.
  test("an owner correction succeeds even when Job Tracking is already complete (owner override wins)", async () => {
    resetFixtures(ACTIVE, [savedOk]);
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(VALID_BODY));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, entry: ENTRY });
  });

  test("a NEW entry on a cancelled or replaced appointment is rejected (revalidated under the parent lock inside the RPC)", async () => {
    resetFixtures(ACTIVE, [{ data: { outcome: "appointment_not_active" } }]);
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(VALID_BODY));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "APPOINTMENT_NOT_ACTIVE");
    assert.match(body.error, /cancelled or replaced/);
  });

  test("an RPC error is a 500 and nothing is reported as saved", async () => {
    resetFixtures(ACTIVE, [{ error: { message: "deadlock detected" } }]);
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(VALID_BODY));
    assert.equal(res.status, 500);
    assert.notEqual((await res.json()).ok, true);
  });

  test("an unknown outcome is never treated as success", async () => {
    resetFixtures(ACTIVE, [{ data: { outcome: "surprise" } }]);
    sessionToReturn = OWNER_SESSION;
    assert.equal((await POST(req(VALID_BODY))).status, 500);
  });
});
