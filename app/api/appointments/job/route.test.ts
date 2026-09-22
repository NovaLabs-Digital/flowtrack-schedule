// Route-level tests for app/api/appointments/job/route.ts (POST only).
//
// The write itself is now ONE database call, record_job_action
// (migrations/030), which locks the parent appointment, revalidates it, and
// writes the employee's own assignment row. These tests use a mocked RPC and
// so prove only the route's behavior: requireCapability(session,
// "canUseJobTracking") runs before anything, validation order, that the RPC
// receives the AUTHENTICATED employee and workspace (never body values), and
// the outcome -> HTTP mapping. The locking / revalidation / rollback
// behavior itself is proven against real PostgreSQL in test-db/recurrence.test.ts.
// @/lib/session and @/lib/supabaseAdmin are mocked; @/lib/entitlementServer is
// DELIBERATELY UNMOCKED (the real capability chain runs against a fake
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
  currentFake = createFakeSupabaseAdmin(responses, rpc.length ? { record_job_action: rpc } : {});
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
const ACTIVE = { subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] };
const ok = (extra: Record<string, unknown> = {}): FakeSupabaseFixture => ({ data: { outcome: "ok", ...extra } });

describe("POST /api/appointments/job -- entitlement gate", () => {
  const FULL_STATES: Array<[string, ReturnType<typeof subscriptionRow>]> = [
    ["active", subscriptionRow({ stripe_status: "active" })],
    ["trialing", subscriptionRow({ stripe_status: "trialing" })],
    ["past_due_grace", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() + 1000).toISOString() })],
    ["internal", subscriptionRow({ billing_mode: "internal", stripe_status: null })],
  ];

  for (const [label, row] of FULL_STATES) {
    test(`${label} permits "start", response unchanged`, async () => {
      resetFixtures({ subscriptions: [{ data: row }] }, [ok({ actual_started_at: "2026-07-21T10:00:00.000Z" })]);
      sessionToReturn = EMPLOYEE_SESSION;
      const res = await POST(req({ appointment_id: "appt-1", action: "start" }));
      assert.equal(res.status, 200, label);
      assert.deepEqual(await res.json(), { ok: true, actual_started_at: "2026-07-21T10:00:00.000Z" }, label);
      assert.equal(currentFake.rpcCalls.length, 1);
      assert.deepEqual(writeCalls(currentFake.calls), [], "the route writes nothing itself; the RPC does");
    });
  }

  test("exact trusted demo workspace permits the action with zero subscriptions-table queries (real short-circuit)", async () => {
    resetFixtures({}, [ok({ actual_started_at: "2026-07-21T10:00:00.000Z" })]);
    sessionToReturn = { role: "employee", employeeId: EMPLOYEE_ID, workspaceId: DEMO_WORKSPACE_ID };
    const res = await POST(req({ appointment_id: "appt-1", action: "start" }));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
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
      resetFixtures({ subscriptions: [{ data: row }] });
      sessionToReturn = EMPLOYEE_SESSION;
      const res = await POST(req({ appointment_id: "appt-1", action: "start" }));
      assert.equal(res.status, 403, label);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY, label);
      assert.equal(currentFake.rpcCalls.length, 0, label);
    });
  }

  test("query_error on the subscriptions read denies (503), zero database work", async () => {
    resetFixtures({ subscriptions: [{ error: { message: "simulated DB error" } }] });
    sessionToReturn = EMPLOYEE_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", action: "start" }));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), SERVICE_UNAVAILABLE_BODY);
    assert.equal(currentFake.rpcCalls.length, 0);
  });

  for (const [label, session] of [
    ["owner", { role: "owner", workspaceId: REAL_WORKSPACE_ID }],
    ["tester", { role: "tester", workspaceId: DEMO_WORKSPACE_ID }],
    ["unauthenticated", { role: "none" }],
  ] as const) {
    test(`${label} retains the existing 401 role-denial and touches nothing (this route is employee-only)`, async () => {
      resetFixtures({});
      sessionToReturn = session;
      const res = await POST(req({ appointment_id: "appt-1", action: "start" }));
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.error, "Unauthorized");
      assert.equal(body.code, undefined);
      assert.equal(currentFake.calls.length, 0);
      assert.equal(currentFake.rpcCalls.length, 0);
    });
  }

  test("a non-demo workspace cannot manufacture demo access by any request-supplied value", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = EMPLOYEE_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", action: "start", workspace_id: DEMO_WORKSPACE_ID }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  describe("mutation-specific validation runs only after auth/role/entitlement", () => {
    test("missing appointment_id + unauthenticated -> the existing 401, not 400, zero Supabase calls", async () => {
      resetFixtures({});
      sessionToReturn = { role: "none" };
      const res = await POST(req({ action: "start" }));
      assert.equal(res.status, 401);
      assert.equal(currentFake.calls.length, 0);
    });

    test("missing appointment_id + restricted workspace -> the exact SUBSCRIPTION_RESTRICTED 403, not 400", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
      sessionToReturn = EMPLOYEE_SESSION;
      const res = await POST(req({ action: "start" }));
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    });

    test("missing appointment_id + entitled workspace -> the existing 400, no RPC", async () => {
      resetFixtures(ACTIVE);
      sessionToReturn = EMPLOYEE_SESSION;
      const res = await POST(req({ action: "start" }));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Missing appointment_id" });
      assert.equal(currentFake.rpcCalls.length, 0);
    });

    test("an unknown action -> the existing 400, no RPC", async () => {
      resetFixtures(ACTIVE);
      sessionToReturn = EMPLOYEE_SESSION;
      const res = await POST(req({ appointment_id: "appt-1", action: "delete" }));
      assert.equal(res.status, 400);
      assert.equal(currentFake.rpcCalls.length, 0);
    });
  });
});

describe("the RPC receives only trusted identity: the AUTHENTICATED employee and workspace, never body values", () => {
  test("employee_id and workspace_id in the body are ignored; the session's own are passed", async () => {
    resetFixtures(ACTIVE, [ok({ actual_started_at: "2026-07-21T10:00:00.000Z" })]);
    sessionToReturn = EMPLOYEE_SESSION;
    await POST(req({ appointment_id: "appt-1", action: "start", employee_id: "someone-else", workspace_id: "attacker-ws" }));
    assert.deepEqual(currentFake.rpcCalls[0], {
      fn: "record_job_action",
      args: { p_workspace_id: REAL_WORKSPACE_ID, p_employee_id: EMPLOYEE_ID, p_appointment_id: "appt-1", p_action: "start", p_notes: null },
    });
  });

  test("this route never reads or writes any table itself -- appointments, assignments and hours are touched only inside the RPC", async () => {
    resetFixtures(ACTIVE, [ok({ actual_started_at: "2026-07-21T10:00:00.000Z" })]);
    sessionToReturn = EMPLOYEE_SESSION;
    await POST(req({ appointment_id: "appt-1", action: "start" }));
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments" || c.table === "appointment_employees"), []);
  });
});

describe("outcome -> HTTP mapping (existing messages preserved)", () => {
  const CASES: Array<[string, Record<string, unknown>, string, number, Record<string, unknown>]> = [
    ["start ok", { outcome: "ok", actual_started_at: "T1" }, "start", 200, { ok: true, actual_started_at: "T1" }],
    ["complete ok (never started: both timestamps)", { outcome: "ok", actual_started_at: "T1", actual_completed_at: "T1" }, "complete", 200, { ok: true, actual_started_at: "T1", actual_completed_at: "T1" }],
    ["complete ok (already started: completion only)", { outcome: "ok", actual_completed_at: "T2" }, "complete", 200, { ok: true, actual_completed_at: "T2" }],
    ["start twice", { outcome: "already_started" }, "start", 400, { error: "Job already started" }],
    ["already completed", { outcome: "already_completed" }, "complete", 400, { error: "Job already completed" }],
    ["notes before start", { outcome: "not_started" }, "save_notes", 400, { error: "Job has not been started" }],
    // missing appointment / other workspace / not assigned all fail closed identically
    ["not this employee's appointment", { outcome: "unauthorized" }, "start", 403, { error: "Unauthorized" }],
  ];
  for (const [label, rpc, action, status, body] of CASES) {
    test(label, async () => {
      resetFixtures(ACTIVE, [{ data: rpc }]);
      sessionToReturn = EMPLOYEE_SESSION;
      const res = await POST(req({ appointment_id: "appt-1", action }));
      assert.equal(res.status, status);
      assert.deepEqual(await res.json(), body);
    });
  }

  test("a cancelled or replaced appointment is rejected with a clear 409 (revalidated under lock inside the RPC)", async () => {
    resetFixtures(ACTIVE, [{ data: { outcome: "appointment_not_active" } }]);
    sessionToReturn = EMPLOYEE_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", action: "start" }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "APPOINTMENT_NOT_ACTIVE");
    assert.match(body.error, /cancelled or replaced/);
  });

  test("an RPC error is a 500, and nothing is reported as saved", async () => {
    resetFixtures(ACTIVE, [{ error: { message: "deadlock detected" } }]);
    sessionToReturn = EMPLOYEE_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", action: "start" }));
    assert.equal(res.status, 500);
    assert.notEqual((await res.json()).ok, true);
  });

  test("an unknown outcome is never treated as success", async () => {
    resetFixtures(ACTIVE, [{ data: { outcome: "surprise" } }]);
    sessionToReturn = EMPLOYEE_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", action: "start" }));
    assert.equal(res.status, 500);
  });
});

describe("Employee Job Notes -- action: 'save_notes' (validation stays in the route; storage is the RPC's)", () => {
  async function saveNotes(notes: unknown, rpc: FakeSupabaseFixture[] = [ok({ job_notes: "x" })]) {
    resetFixtures(ACTIVE, rpc);
    sessionToReturn = EMPLOYEE_SESSION;
    return POST(req({ appointment_id: "appt-1", action: "save_notes", ...(notes === undefined ? {} : { notes }) }));
  }

  test("a note is trimmed server-side and passed to the RPC", async () => {
    const res = await saveNotes("  gate code 1234  ", [ok({ job_notes: "gate code 1234" })]);
    assert.equal(res.status, 200);
    assert.equal((currentFake.rpcCalls[0].args as Record<string, unknown>).p_notes, "gate code 1234");
    assert.deepEqual(await res.json(), { ok: true, job_notes: "gate code 1234" });
  });

  test("omitting the field, or a whitespace-only value, is passed as NULL (\"no note\"), never an empty string", async () => {
    await saveNotes(undefined);
    assert.equal((currentFake.rpcCalls[0].args as Record<string, unknown>).p_notes, null);
    await saveNotes("   \n  ");
    assert.equal((currentFake.rpcCalls[0].args as Record<string, unknown>).p_notes, null);
  });

  test("exactly 2000 characters after trimming is accepted; whitespace does not count against the limit", async () => {
    assert.equal((await saveNotes("a".repeat(2000))).status, 200);
    assert.equal((await saveNotes("   " + "a".repeat(2000) + "   ")).status, 200);
  });

  test("2001 characters is rejected with 400 and never reaches the database", async () => {
    const res = await saveNotes("a".repeat(2001));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Job notes must be 2000 characters or fewer" });
    assert.equal(currentFake.rpcCalls.length, 0);
  });

  test("notes are only ever sent for action save_notes (start/complete pass NULL)", async () => {
    resetFixtures(ACTIVE, [ok({ actual_started_at: "T" })]);
    sessionToReturn = EMPLOYEE_SESSION;
    await POST(req({ appointment_id: "appt-1", action: "start", notes: "smuggled" }));
    assert.equal((currentFake.rpcCalls[0].args as Record<string, unknown>).p_notes, null);
  });
});
