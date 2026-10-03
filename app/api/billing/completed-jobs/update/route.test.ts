// Route-level tests for PATCH /api/billing/completed-jobs/update.
// @/lib/session and @/lib/supabaseAdmin are mocked; @/lib/entitlementServer
// is DELIBERATELY UNMOCKED (real requireCapability chain), same discipline
// as app/api/appointments/employee-hours/route.test.ts. This route also
// calls lib/appointmentEmployees.ts's fetchAssignments (a thin, real,
// unmocked wrapper over supabaseAdmin), so its own "appointment_employees"
// query flows through the same fake Supabase client.
//
// Migration 033: this route's actual write (and the cross-client/
// invoice-group-payment-sync enforcement) now happens entirely inside the
// upsert_completed_job_billing Postgres function, called via
// supabaseAdmin.rpc(...) -- see currentFake.rpcCalls/rpcResponses below.
// The REAL multi-row sync/atomicity behavior that function provides is
// proven against a genuine PostgreSQL instance in
// test-db/completed_job_billing.test.ts (npm run test:db:billing); the
// tests here prove only that THIS ROUTE calls that function with the
// correct arguments for each scenario, and translates its errors/success
// correctly -- the fake Supabase client never executes real SQL.
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

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>, rpcResponses: Record<string, FakeSupabaseFixture[]> = {}) {
  currentFake = createFakeSupabaseAdmin(responses, rpcResponses);
}
function req(body?: unknown) {
  return new Request("http://localhost/api/billing/completed-jobs/update", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
function rpcCall() {
  return currentFake.rpcCalls.find((c) => c.fn === "upsert_completed_job_billing");
}
// `FakeSupabaseRpcCall.args` is typed `unknown` (lib/testSupport.ts) since
// the fake accepts any shape for any rpc name -- this route always calls it
// with a known, fixed parameter object, so one cast here avoids repeating
// `as any` at every call site below.
function rpcArgs(): Record<string, unknown> {
  return rpcCall()!.args as Record<string, unknown>;
}

const OWNER_AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";
const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID, authUserId: OWNER_AUTH_USER_ID, sessionEpoch: 1 };
const MEMBERSHIP = { workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }] };
const ACTIVE = { ...MEMBERSHIP, subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] };

const COMPLETED_APPT_ROW = { id: "appt-1", workspace_id: REAL_WORKSPACE_ID, is_demo: false, status: "scheduled", client_id: "client-beth" };
const COMPLETE_ASSIGNMENT = {
  id: "ae-1", appointment_id: "appt-1", employee_id: "emp-1",
  actual_started_at: "2026-08-12T13:00:00.000Z", actual_completed_at: "2026-08-12T14:00:00.000Z",
  job_notes: null, created_at: "x", updated_at: "x",
};
const INCOMPLETE_ASSIGNMENT = { ...COMPLETE_ASSIGNMENT, actual_completed_at: null };
// Real production regression (Holly Williams, Sep 23): no tracking
// timestamps at all -- the employee never used Start Job/Complete Job.
const UNTRACKED_ASSIGNMENT = { ...COMPLETE_ASSIGNMENT, actual_started_at: null, actual_completed_at: null };
const OWNER_HOURS_OVERRIDE = {
  id: "hrs-1", appointment_id: "appt-1", employee_id: "emp-1",
  hours_worked: 3, note: "forgot cell at home", created_at: "x", updated_at: "x",
};

const SAVED_ROW = {
  id: "bill-1", workspace_id: REAL_WORKSPACE_ID, appointment_id: "appt-1", client_id: "client-beth",
  invoice_number: "INV-1", paid: false, payment_method: null, created_at: "x", updated_at: "x",
};
// No sibling row for the inherit-on-join lookup (migration 033) -- the
// default "this is the first/only job under this invoice number so far"
// result.
const NO_SIBLING = { data: null };

function completeAppointmentFixtures(extra: Record<string, FakeSupabaseFixture[]> = {}) {
  return {
    ...ACTIVE,
    appointments: [{ data: COMPLETED_APPT_ROW }],
    appointment_employees: [{ data: [COMPLETE_ASSIGNMENT] }],
    // Overridable default: most tests here care only about the completion
    // gate/validation/RPC-call-shape behavior, not the owner-override-
    // resolves-missing-tracking rule specifically (see the dedicated
    // describe block below for that).
    appointment_employee_hours: [{ data: [] }],
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
    resetFixtures({
      ...ACTIVE,
      appointments: [{ data: COMPLETED_APPT_ROW }],
      appointment_employees: [{ data: [INCOMPLETE_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", invoice_number: "INV-1" }));
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /not marked completed/i);
  });

  test("zero assignments at all is also not completed -- 409, not a crash", async () => {
    resetFixtures({
      ...ACTIVE,
      appointments: [{ data: COMPLETED_APPT_ROW }],
      appointment_employees: [{ data: [] }],
      appointment_employee_hours: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", invoice_number: "INV-1" }));
    assert.equal(res.status, 409);
  });

  // Real production regression (Holly Williams, Sep 23): no Job Tracking
  // timestamps at all, and no owner override yet either -- must still be
  // rejected exactly like INCOMPLETE_ASSIGNMENT above (the safety net
  // holds until the owner actually resolves it).
  test("no tracking AND no owner override yet -- still rejected with 409 (not resolved)", async () => {
    resetFixtures({
      ...ACTIVE,
      appointments: [{ data: COMPLETED_APPT_ROW }],
      appointment_employees: [{ data: [UNTRACKED_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", invoice_number: "INV-1" }));
    assert.equal(res.status, 409);
  });

  // Real production regression (Holly Williams, Sep 23): no Job Tracking
  // timestamps at all, but the owner has already saved a worked-time
  // correction for this employee on this appointment -- the completion
  // gate must now pass, exactly as if Job Tracking itself had completed.
  test("no tracking + an owner-approved worked-time override -- the completion gate now passes (Holly/Roxana scenario)", async () => {
    resetFixtures(
      {
        ...ACTIVE,
        appointments: [{ data: COMPLETED_APPT_ROW }],
        appointment_employees: [{ data: [UNTRACKED_ASSIGNMENT] }],
        appointment_employee_hours: [{ data: [OWNER_HOURS_OVERRIDE] }],
        completed_job_billing: [{ data: null }, NO_SIBLING],
      },
      { upsert_completed_job_billing: [{ data: SAVED_ROW }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", invoice_number: "INV-1" }));
    assert.equal(res.status, 200);
  });
});

describe("PATCH /api/billing/completed-jobs/update -- paid requires payment_method (server-side, merged-state)", () => {
  test("setting paid=true with no existing row and no payment_method in this request -> 400, no write", async () => {
    resetFixtures(completeAppointmentFixtures({ completed_job_billing: [{ data: null }] }));
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", paid: true }));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /payment method is required/i);
    assert.equal(rpcCall(), undefined, "must never reach the RPC");
  });

  test("setting paid=true in the SAME request as a payment_method succeeds", async () => {
    resetFixtures(
      completeAppointmentFixtures({ completed_job_billing: [{ data: null }] }),
      { upsert_completed_job_billing: [{ data: { ...SAVED_ROW, paid: true, payment_method: "cash" } }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", paid: true, payment_method: "cash" }));
    assert.equal(res.status, 200);
  });

  test("setting paid=true when a payment_method was already saved on an earlier edit succeeds (merged state, not just this request's fields)", async () => {
    resetFixtures(
      completeAppointmentFixtures({
        completed_job_billing: [{ data: { ...SAVED_ROW, payment_method: "check" } }], // existing row already has a method
      }),
      { upsert_completed_job_billing: [{ data: { ...SAVED_ROW, paid: true, payment_method: "check" } }] }
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
      completeAppointmentFixtures({ completed_job_billing: [{ data: null }] }),
      { upsert_completed_job_billing: [{ data: { ...SAVED_ROW, paid: false, payment_method: null } }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", paid: false }));
    assert.equal(res.status, 200);
  });
});

describe("PATCH /api/billing/completed-jobs/update -- invoice number normalization + RPC call shape", () => {
  test("invoice_number is trimmed before being passed to the RPC", async () => {
    resetFixtures(
      completeAppointmentFixtures({ completed_job_billing: [{ data: null }, NO_SIBLING] }),
      { upsert_completed_job_billing: [{ data: SAVED_ROW }] }
    );
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({ appointment_id: "appt-1", invoice_number: "  INV-1  " }));
    assert.equal(rpcArgs().p_invoice_number, "INV-1");
    assert.equal(rpcArgs().p_client_id, "client-beth", "client_id is always derived from the appointment, never client-supplied");
  });

  test("a blank invoice_number normalizes to null, not an empty string -- no sibling lookup runs for a null value", async () => {
    resetFixtures(
      completeAppointmentFixtures({ completed_job_billing: [{ data: null }] }),
      { upsert_completed_job_billing: [{ data: { ...SAVED_ROW, invoice_number: null } }] }
    );
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({ appointment_id: "appt-1", invoice_number: "   " }));
    assert.equal(rpcArgs().p_invoice_number, null);
    // Exactly one completed_job_billing SELECT (the existing-row read) --
    // confirms the sibling-inherit lookup is skipped entirely for a null
    // value. Counted via maybeSingle() specifically (not a raw table-name
    // filter) because every chained .eq()/.neq()/etc. call on the fake
    // query builder records its own entry.
    assert.equal(currentFake.calls.filter((c) => c.table === "completed_job_billing" && c.method === "maybeSingle").length, 1);
  });

  test("updating only paid (invoice_number absent from the request) keeps the existing invoice_number unchanged and never runs the sibling-inherit lookup", async () => {
    resetFixtures(
      completeAppointmentFixtures({
        completed_job_billing: [{ data: { ...SAVED_ROW, invoice_number: "INV-KEEP-ME" } }],
      }),
      { upsert_completed_job_billing: [{ data: { ...SAVED_ROW, invoice_number: "INV-KEEP-ME" } }] }
    );
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({ appointment_id: "appt-1", paid: false }));
    assert.equal(rpcArgs().p_invoice_number, "INV-KEEP-ME");
    assert.equal(currentFake.calls.filter((c) => c.table === "completed_job_billing" && c.method === "maybeSingle").length, 1);
  });
});

// Migration 033 / the business rules under test in this file: (a) an
// invoice number MAY repeat for the SAME client, but must never be silently
// reused across DIFFERENT clients in the same workspace, and (b) payment
// status belongs to the invoice group, not any one job. See
// app/api/billing/completed-jobs/update/route.ts's own comment for why (a)
// is enforced inside upsert_completed_job_billing itself rather than by a
// separate pre-check query, and test-db/completed_job_billing.test.ts for
// the real-Postgres proof that the function's multi-row sync and atomicity
// actually work -- the tests below only prove this ROUTE calls that
// function correctly.
describe("PATCH /api/billing/completed-jobs/update -- same invoice number, cross-client validation (migration 033)", () => {
  test("same invoice number, SAME client (Beth Holcomb, two completed jobs, one QuickBooks invoice) -- succeeds", async () => {
    resetFixtures(
      completeAppointmentFixtures({
        appointments: [{ data: { ...COMPLETED_APPT_ROW, client_id: "client-beth" } }],
        completed_job_billing: [{ data: null }, NO_SIBLING],
      }),
      { upsert_completed_job_billing: [{ data: { ...SAVED_ROW, client_id: "client-beth" } }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", invoice_number: "13422" }));
    assert.equal(res.status, 200);
    assert.equal(rpcArgs().p_client_id, "client-beth");
  });

  test("same invoice number, DIFFERENT client -- the RPC's cross-client rejection is translated into a clear 409", async () => {
    resetFixtures(
      completeAppointmentFixtures({
        appointments: [{ data: { ...COMPLETED_APPT_ROW, client_id: "client-walter" } }],
        completed_job_billing: [{ data: null }, NO_SIBLING],
      }),
      {
        upsert_completed_job_billing: [
          { error: { code: "23505", message: "completed_job_billing_invoice_number_different_client" } },
        ],
      }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", invoice_number: "13422" }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, "That invoice number is already used by a different client in this workspace.");
  });

  test("an unexpected 23505 from the RPC (defensive backstop, not the primary path) is still translated into a clear, owner-friendly message", async () => {
    resetFixtures(
      completeAppointmentFixtures({ completed_job_billing: [{ data: null }, NO_SIBLING] }),
      {
        upsert_completed_job_billing: [
          { error: { code: "23505", message: 'duplicate key value violates unique constraint "completed_job_billing_appointment_id_key"' } },
        ],
      }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", invoice_number: "INV-1" }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, "That invoice number is already used by another job in this workspace.");
    assert.doesNotMatch(body.error, /constraint|sql|23505/i);
  });
});

// Migration 033 (correction round): real UI usage edits invoice_number and
// paid/payment_method in SEPARATE requests, so a job can be given an
// ALREADY-paid invoice's number without touching Paid in that same request.
// Left alone, that job would default to paid=false right next to its
// now-paid invoice-mates -- exactly the inconsistent state this feature
// exists to prevent. See route.ts's own comment for the full reasoning.
describe("PATCH /api/billing/completed-jobs/update -- inherit-on-join (a job newly given an already-paid invoice number adopts the group's paid state)", () => {
  test("setting invoice_number to a value an existing SAME-client sibling already has, with no paid/payment_method in this request, inherits the sibling's paid/payment_method", async () => {
    resetFixtures(
      completeAppointmentFixtures({
        completed_job_billing: [{ data: null }, { data: { paid: true, payment_method: "zelle" } }],
      }),
      { upsert_completed_job_billing: [{ data: { ...SAVED_ROW, invoice_number: "13422", paid: true, payment_method: "zelle" } }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", invoice_number: "13422" }));
    assert.equal(res.status, 200);
    assert.equal(rpcArgs().p_paid, true);
    assert.equal(rpcArgs().p_payment_method, "zelle");
  });

  test("setting invoice_number to a brand-new value (no existing sibling) does NOT inherit anything -- stays at the default false/null", async () => {
    resetFixtures(
      completeAppointmentFixtures({ completed_job_billing: [{ data: null }, NO_SIBLING] }),
      { upsert_completed_job_billing: [{ data: SAVED_ROW }] }
    );
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({ appointment_id: "appt-1", invoice_number: "13422" }));
    assert.equal(rpcArgs().p_paid, false);
    assert.equal(rpcArgs().p_payment_method, null);
  });

  test("explicitly setting paid/payment_method in the SAME request as a new invoice_number is never overridden by an inherit lookup -- the inherit lookup doesn't even run", async () => {
    resetFixtures(
      completeAppointmentFixtures({ completed_job_billing: [{ data: null }] }),
      { upsert_completed_job_billing: [{ data: { ...SAVED_ROW, invoice_number: "13422", paid: true, payment_method: "cash" } }] }
    );
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({ appointment_id: "appt-1", invoice_number: "13422", paid: true, payment_method: "cash" }));
    assert.equal(rpcArgs().p_paid, true);
    assert.equal(rpcArgs().p_payment_method, "cash");
    // Only the existing-row read -- no sibling-inherit lookup.
    assert.equal(currentFake.calls.filter((c) => c.table === "completed_job_billing" && c.method === "maybeSingle").length, 1);
  });
});

describe("PATCH /api/billing/completed-jobs/update -- RPC call shape", () => {
  test("calls upsert_completed_job_billing with the session's own workspace_id (never a client-supplied one) and the verified appointment's client_id", async () => {
    resetFixtures(
      completeAppointmentFixtures({ completed_job_billing: [{ data: null }, NO_SIBLING] }),
      { upsert_completed_job_billing: [{ data: SAVED_ROW }] }
    );
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({ appointment_id: "appt-1", invoice_number: "INV-1", workspace_id: "attacker-ws", client_id: "attacker-client" }));
    assert.equal(rpcArgs().p_workspace_id, REAL_WORKSPACE_ID);
    assert.equal(rpcArgs().p_appointment_id, "appt-1");
    assert.equal(rpcArgs().p_client_id, "client-beth");
  });

  test("a successful save returns { ok: true, billing: <row> } -- the exact row the RPC returned", async () => {
    resetFixtures(
      completeAppointmentFixtures({ completed_job_billing: [{ data: null }, NO_SIBLING] }),
      { upsert_completed_job_billing: [{ data: SAVED_ROW }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", invoice_number: "INV-1" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, billing: SAVED_ROW });
  });
});
