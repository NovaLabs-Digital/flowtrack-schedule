// Route-level tests for PATCH /api/billing/completed-jobs/update.
// @/lib/session and @/lib/supabaseAdmin are mocked; @/lib/entitlementServer
// is DELIBERATELY UNMOCKED (real requireCapability chain), same discipline
// as app/api/appointments/employee-hours/route.test.ts. This route also
// calls lib/appointmentEmployees.ts's fetchAssignments (a thin, real,
// unmocked wrapper over supabaseAdmin), so its own "appointment_employees"
// query flows through the same fake Supabase client.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin, fakeSessionNamedExports, subscriptionRow } from "../../../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../../../lib/testSupport.ts";

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

const { PATCH } = await import("./route.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}
function req(body?: unknown) {
  return new Request("http://localhost/api/billing/completed-jobs/update", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const OWNER_AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";
const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID, authUserId: OWNER_AUTH_USER_ID, sessionEpoch: 1 };
const MEMBERSHIP = { workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }] };
const ACTIVE = { ...MEMBERSHIP, subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] };

const COMPLETED_APPT_ROW = { id: "appt-1", workspace_id: REAL_WORKSPACE_ID, is_demo: false, status: "scheduled" };
const COMPLETE_ASSIGNMENT = {
  id: "ae-1", appointment_id: "appt-1", employee_id: "emp-1",
  actual_started_at: "2026-08-12T13:00:00.000Z", actual_completed_at: "2026-08-12T14:00:00.000Z",
  job_notes: null, created_at: "x", updated_at: "x",
};
const INCOMPLETE_ASSIGNMENT = { ...COMPLETE_ASSIGNMENT, actual_completed_at: null };

const SAVED_ROW = {
  id: "bill-1", workspace_id: REAL_WORKSPACE_ID, appointment_id: "appt-1",
  invoice_number: "INV-1", paid: false, payment_method: null, created_at: "x", updated_at: "x",
};

function completeAppointmentFixtures(extra: Record<string, FakeSupabaseFixture[]> = {}) {
  return {
    ...ACTIVE,
    appointments: [{ data: COMPLETED_APPT_ROW }],
    appointment_employees: [{ data: [COMPLETE_ASSIGNMENT] }],
    ...extra,
  };
}

describe("PATCH /api/billing/completed-jobs/update -- auth/role/validation gates", () => {
  for (const [label, session] of [
    ["employee", { role: "employee", employeeId: "e1", workspaceId: REAL_WORKSPACE_ID }],
    ["unauthenticated", { role: "none" }],
  ] as const) {
    test(`${label} is denied (403), zero database work`, async () => {
      resetFixtures({});
      sessionToReturn = session;
      const res = await PATCH(req({ appointment_id: "appt-1", paid: true, payment_method: "cash" }));
      assert.equal(res.status, 403);
      assert.equal(currentFake.calls.length, 0);
    });
  }

  test("missing appointment_id -> 400, no queries", async () => {
    resetFixtures(ACTIVE);
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ paid: true }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Missing appointment_id" });
  });

  test("paid must be a boolean", async () => {
    resetFixtures(ACTIVE);
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", paid: "yes" }));
    assert.equal(res.status, 400);
  });

  test("an invalid payment_method is rejected before any appointment lookup", async () => {
    resetFixtures(ACTIVE);
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", payment_method: "venmo" }));
    assert.equal(res.status, 400);
    assert.equal(currentFake.calls.filter((c) => c.table === "appointments").length, 0);
  });
});

describe("PATCH /api/billing/completed-jobs/update -- appointment lookup / completion gate", () => {
  test("appointment not found -> 404", async () => {
    resetFixtures({ ...ACTIVE, appointments: [{ data: null }] });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "missing", paid: false }));
    assert.equal(res.status, 404);
  });

  test("a tester session cannot touch a non-demo appointment -- 404, not a workspace-mismatch detail", async () => {
    resetFixtures({
      ...MEMBERSHIP,
      appointments: [{ data: { ...COMPLETED_APPT_ROW, workspace_id: DEMO_WORKSPACE_ID, is_demo: false } }],
    });
    sessionToReturn = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };
    const res = await PATCH(req({ appointment_id: "appt-1", paid: false }));
    assert.equal(res.status, 404);
  });

  test("an appointment that is not yet completed (per isCompletedForBilling) is rejected with a clear 409", async () => {
    resetFixtures({ ...ACTIVE, appointments: [{ data: COMPLETED_APPT_ROW }], appointment_employees: [{ data: [INCOMPLETE_ASSIGNMENT] }] });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", invoice_number: "INV-1" }));
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /not marked completed/i);
  });

  test("zero assignments at all is also not completed -- 409, not a crash", async () => {
    resetFixtures({ ...ACTIVE, appointments: [{ data: COMPLETED_APPT_ROW }], appointment_employees: [{ data: [] }] });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", invoice_number: "INV-1" }));
    assert.equal(res.status, 409);
  });
});

describe("PATCH /api/billing/completed-jobs/update -- paid requires payment_method (server-side, merged-state)", () => {
  test("setting paid=true with no existing row and no payment_method in this request -> 400, no write", async () => {
    resetFixtures(completeAppointmentFixtures({ completed_job_billing: [{ data: null }] }));
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", paid: true }));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /payment method is required/i);
  });

  test("setting paid=true in the SAME request as a payment_method succeeds", async () => {
    resetFixtures(
      completeAppointmentFixtures({
        completed_job_billing: [{ data: null }, { data: { ...SAVED_ROW, paid: true, payment_method: "cash" } }],
      })
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", paid: true, payment_method: "cash" }));
    assert.equal(res.status, 200);
  });

  test("setting paid=true when a payment_method was already saved on an earlier edit succeeds (merged state, not just this request's fields)", async () => {
    resetFixtures(
      completeAppointmentFixtures({
        completed_job_billing: [
          { data: { ...SAVED_ROW, payment_method: "check" } }, // existing row already has a method
          { data: { ...SAVED_ROW, paid: true, payment_method: "check" } },
        ],
      })
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", paid: true }));
    assert.equal(res.status, 200);
  });

  test("clearing payment_method back to null while paid is still true (from the existing row) -> 400", async () => {
    resetFixtures(
      completeAppointmentFixtures({
        completed_job_billing: [{ data: { ...SAVED_ROW, paid: true, payment_method: "zelle" } }],
      })
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", payment_method: null }));
    assert.equal(res.status, 400);
  });

  test("paid=false allows a null payment_method", async () => {
    resetFixtures(
      completeAppointmentFixtures({
        completed_job_billing: [{ data: null }, { data: { ...SAVED_ROW, paid: false, payment_method: null } }],
      })
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", paid: false }));
    assert.equal(res.status, 200);
  });
});

describe("PATCH /api/billing/completed-jobs/update -- invoice number normalization + persistence", () => {
  test("invoice_number is trimmed before being written", async () => {
    resetFixtures(completeAppointmentFixtures({ completed_job_billing: [{ data: null }, { data: SAVED_ROW }] }));
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({ appointment_id: "appt-1", invoice_number: "  INV-1  " }));
    const upsertCall = currentFake.calls.find((c) => c.table === "completed_job_billing" && c.method === "upsert");
    assert.equal((upsertCall!.args[0] as any).invoice_number, "INV-1");
  });

  test("a blank invoice_number normalizes to null, not an empty string", async () => {
    resetFixtures(completeAppointmentFixtures({ completed_job_billing: [{ data: null }, { data: { ...SAVED_ROW, invoice_number: null } }] }));
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({ appointment_id: "appt-1", invoice_number: "   " }));
    const upsertCall = currentFake.calls.find((c) => c.table === "completed_job_billing" && c.method === "upsert");
    assert.equal((upsertCall!.args[0] as any).invoice_number, null);
  });

  test("a duplicate invoice number within the workspace (unique_violation, 23505) is translated into a clear, owner-friendly 409", async () => {
    resetFixtures(
      completeAppointmentFixtures({
        completed_job_billing: [{ data: null }, { error: { code: "23505", message: 'duplicate key value violates unique constraint "idx_completed_job_billing_workspace_invoice_number"' } }],
      })
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", invoice_number: "INV-DUPLICATE" }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, "That invoice number is already used by another job in this workspace.");
    assert.doesNotMatch(body.error, /constraint|sql|23505/i);
  });

  test("updating only paid (invoice_number absent from the request) keeps the existing invoice_number unchanged", async () => {
    resetFixtures(
      completeAppointmentFixtures({
        completed_job_billing: [{ data: { ...SAVED_ROW, invoice_number: "INV-KEEP-ME" } }, { data: SAVED_ROW }],
      })
    );
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({ appointment_id: "appt-1", paid: false }));
    const upsertCall = currentFake.calls.find((c) => c.table === "completed_job_billing" && c.method === "upsert");
    assert.equal((upsertCall!.args[0] as any).invoice_number, "INV-KEEP-ME");
  });
});

describe("PATCH /api/billing/completed-jobs/update -- upsert shape", () => {
  test("upserts with onConflict: appointment_id, and includes the session's own workspace_id (never a client-supplied one)", async () => {
    resetFixtures(completeAppointmentFixtures({ completed_job_billing: [{ data: null }, { data: SAVED_ROW }] }));
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({ appointment_id: "appt-1", invoice_number: "INV-1", workspace_id: "attacker-ws" }));
    const upsertCall = currentFake.calls.find((c) => c.table === "completed_job_billing" && c.method === "upsert");
    assert.equal((upsertCall!.args[0] as any).workspace_id, REAL_WORKSPACE_ID);
    assert.deepEqual(upsertCall!.args[1], { onConflict: "appointment_id" });
  });

  test("a successful save returns { ok: true, billing: <row> }", async () => {
    resetFixtures(completeAppointmentFixtures({ completed_job_billing: [{ data: null }, { data: SAVED_ROW }] }));
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", invoice_number: "INV-1" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, billing: SAVED_ROW });
  });
});
