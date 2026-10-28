// Route-level tests for GET /api/billing/completed-jobs.
// @/lib/session and @/lib/supabaseAdmin are mocked; @/lib/entitlementServer
// is DELIBERATELY UNMOCKED (real requireCapability chain over a fake
// "workspace_memberships"/"subscriptions" table) -- same discipline as
// app/api/appointments/employee-hours/route.test.ts.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin, fakeSessionNamedExports, subscriptionRow } from "../../../../lib/testSupport.ts";
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

const { GET } = await import("./route.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}
function req(qs = "start=2026-08-10&end=2026-08-16") {
  return new Request(`http://localhost/api/billing/completed-jobs?${qs}`, { method: "GET" });
}

const OWNER_AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";
const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID, authUserId: OWNER_AUTH_USER_ID, sessionEpoch: 1 };
const MEMBERSHIP = { workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }] };
const ACTIVE = { ...MEMBERSHIP, subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] };

const COMPLETED_APPT = {
  id: "appt-done", client_id: "client-1", service_type: "Window Washing",
  scheduled_for: "2026-08-12T13:00:00.000Z", scheduled_end: "2026-08-12T14:00:00.000Z",
  duration_minutes: 60, status: "scheduled", price_cents: 12000,
};
const REVIEW_APPT = {
  id: "appt-untracked", client_id: "client-2", service_type: "Lawn Mowing",
  scheduled_for: "2026-08-13T13:00:00.000Z", scheduled_end: "2026-08-13T14:00:00.000Z",
  duration_minutes: 60, status: "scheduled", price_cents: 8000,
};
const ASSIGNMENT = {
  id: "ae-1", appointment_id: "appt-done", employee_id: "emp-1",
  actual_started_at: "2026-08-12T13:00:00.000Z", actual_completed_at: "2026-08-12T14:00:00.000Z",
  job_notes: null, created_at: "x", updated_at: "x",
};
const CLIENTS = [
  { id: "client-1", name: "Petra Lindqvist", email: null, phone: null },
  { id: "client-2", name: "Simon Aldercott", email: null, phone: null },
];

describe("GET /api/billing/completed-jobs -- auth/role gate", () => {
  for (const [label, session] of [
    ["employee", { role: "employee", employeeId: "e1", workspaceId: REAL_WORKSPACE_ID }],
    ["unauthenticated", { role: "none" }],
  ] as const) {
    test(`${label} is denied (403), zero database work`, async () => {
      resetFixtures({});
      sessionToReturn = session;
      const res = await GET(req());
      assert.equal(res.status, 403);
      assert.equal(currentFake.calls.length, 0);
    });
  }
});

describe("GET /api/billing/completed-jobs -- entitlement gate", () => {
  test("a restricted (canceled) subscription is denied, zero report queries", async () => {
    resetFixtures({ ...MEMBERSHIP, subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await GET(req());
    assert.equal(res.status, 403);
    assert.equal(currentFake.calls.filter((c) => c.table === "appointments").length, 0);
  });
});

describe("GET /api/billing/completed-jobs -- date-range validation", () => {
  for (const [label, qs] of [
    ["missing start", "end=2026-08-16"],
    ["missing end", "start=2026-08-10"],
    ["malformed start", "start=08-10-2026&end=2026-08-16"],
    ["start after end", "start=2026-08-20&end=2026-08-10"],
  ] as const) {
    test(`${label} -> 400, no appointments query`, async () => {
      resetFixtures(ACTIVE);
      sessionToReturn = OWNER_SESSION;
      const res = await GET(req(qs));
      assert.equal(res.status, 400);
      assert.equal(currentFake.calls.filter((c) => c.table === "appointments").length, 0);
    });
  }
});

describe("GET /api/billing/completed-jobs -- happy path", () => {
  test("returns completed jobs (joined with client name, billing=null when no row exists yet) and a separate reviewNeeded list", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [COMPLETED_APPT, REVIEW_APPT] }],
      appointment_employees: [{ data: [ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET(req());
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.completed.length, 1);
    assert.equal(body.completed[0].appointmentId, "appt-done");
    assert.equal(body.completed[0].clientName, "Petra Lindqvist");
    assert.equal(body.completed[0].priceCents, 12000);
    assert.equal(body.completed[0].billing, null);

    assert.equal(body.reviewNeeded.length, 1);
    assert.equal(body.reviewNeeded[0].appointmentId, "appt-untracked");
    assert.equal(body.reviewNeeded[0].clientName, "Simon Aldercott");
  });

  test("joins an existing billing row onto its completed appointment", async () => {
    const billingRow = {
      id: "bill-1", workspace_id: REAL_WORKSPACE_ID, appointment_id: "appt-done",
      invoice_number: "INV-9001", paid: true, payment_method: "zelle", created_at: "x", updated_at: "x",
    };
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [COMPLETED_APPT] }],
      appointment_employees: [{ data: [ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [billingRow] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.completed[0].billing.invoice_number, "INV-9001");
    assert.equal(body.completed[0].billing.paid, true);
  });

  test("zero appointments in range short-circuits before querying assignments/billing/clients", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET(req());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.completed, []);
    assert.deepEqual(body.reviewNeeded, []);
    assert.equal(currentFake.calls.filter((c) => c.table === "appointment_employees").length, 0);
    assert.equal(currentFake.calls.filter((c) => c.table === "appointment_employee_hours").length, 0);
    assert.equal(currentFake.calls.filter((c) => c.table === "completed_job_billing").length, 0);
    assert.equal(currentFake.calls.filter((c) => c.table === "clients").length, 0);
  });

  test("the appointments query is scoped to is_demo=false for an owner (real-workspace) session", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    await GET(req());
    const apptCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "eq" && c.args[0] === "is_demo");
    assert.deepEqual(apptCall?.args, ["is_demo", false]);
  });

  // Real production regression (Holly Williams, Sep 23): an assigned
  // employee who never used Start Job/Complete Job (no tracking
  // timestamps at all), whose worked time the owner corrected afterward
  // via appointment_employee_hours. Must land in `completed`, using the
  // appointment's existing price, and must NOT appear in `reviewNeeded`.
  test("an appointment resolved only via an owner-approved worked-time override (no Job Tracking at all) appears in completed, not reviewNeeded", async () => {
    const hollyAppt = {
      id: "holly-appt", client_id: "client-holly", service_type: "Regular Cleaning",
      scheduled_for: "2026-08-12T17:00:00.000Z", scheduled_end: "2026-08-12T20:00:00.000Z",
      duration_minutes: 180, status: "scheduled", price_cents: 18000,
    };
    const untrackedAssignment = {
      id: "ae-roxana", appointment_id: "holly-appt", employee_id: "roxana",
      actual_started_at: null, actual_completed_at: null,
      job_notes: null, created_at: "x", updated_at: "x",
    };
    const ownerOverride = {
      id: "hrs-1", appointment_id: "holly-appt", employee_id: "roxana",
      hours_worked: 3, note: "forgot cell at home", created_at: "x", updated_at: "x",
    };
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [hollyAppt] }],
      appointment_employees: [{ data: [untrackedAssignment] }],
      appointment_employee_hours: [{ data: [ownerOverride] }],
      completed_job_billing: [{ data: [] }],
      clients: [{ data: [{ id: "client-holly", name: "Holly Williams", email: null, phone: null }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();

    assert.deepEqual(body.completed.map((r: { appointmentId: string }) => r.appointmentId), ["holly-appt"]);
    assert.equal(body.completed[0].clientName, "Holly Williams");
    assert.equal(body.completed[0].priceCents, 18000);
    assert.deepEqual(body.reviewNeeded, []);
  });

  test("a tester session scopes to the demo workspace and is_demo=true, with zero subscriptions-table queries", async () => {
    resetFixtures({
      workspace_memberships: [],
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [] }],
    });
    sessionToReturn = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.equal(currentFake.calls.filter((c) => c.table === "subscriptions").length, 0);
    assert.equal(currentFake.calls.filter((c) => c.table === "workspace_memberships").length, 0);
    const apptCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "eq" && c.args[0] === "workspace_id");
    assert.deepEqual(apptCall?.args, ["workspace_id", DEMO_WORKSPACE_ID]);
  });
});

// Regression: an older Needs Attention item (no rolling-cutoff limit on its
// age) can deep-link into this route with a date range the owner then
// widens, and appointment_employees/completed_job_billing/clients were
// previously single, unbounded .in() queries here -- a real row-limit-
// truncation risk that could silently drop an older flagged job's own
// billing/assignment data. Proves the fetchAllPagesChunkedIn fix actually
// runs in bounded, chunked batches, not a single unbounded request.
describe("GET /api/billing/completed-jobs -- bounded, chunked batches for appointment_employees/completed_job_billing/clients (regression)", () => {
  const CHUNK_SIZE = 300; // lib/paginate.ts's DEFAULT_ID_CHUNK_SIZE

  function manyAppointments(n: number) {
    const appts = [];
    const assignments = [];
    const billing = [];
    for (let i = 0; i < n; i++) {
      const id = `appt-many-${i}`;
      appts.push({
        id, client_id: "client-shared", service_type: "Lawn Mowing",
        scheduled_for: `2026-08-${String(10 + (i % 7)).padStart(2, "0")}T13:00:00.000Z`,
        scheduled_end: `2026-08-${String(10 + (i % 7)).padStart(2, "0")}T14:00:00.000Z`,
        duration_minutes: 60, status: "scheduled", price_cents: 8000,
      });
      assignments.push({
        id: `ae-many-${i}`, appointment_id: id, employee_id: "emp-1",
        actual_started_at: "2026-08-10T13:00:00.000Z", actual_completed_at: "2026-08-10T14:00:00.000Z",
        job_notes: null, created_at: "x", updated_at: "x",
      });
      billing.push({
        id: `bill-many-${i}`, workspace_id: REAL_WORKSPACE_ID, appointment_id: id, client_id: "client-shared",
        invoice_number: `INV-${i}`, paid: true, payment_method: "zelle", created_at: "x", updated_at: "x",
      });
    }
    return { appts, assignments, billing };
  }

  test("an apptIds list larger than one chunk (301 ids) is queried in TWO chunked batches, not one oversized .in() call", async () => {
    const { appts, assignments, billing } = manyAppointments(CHUNK_SIZE + 1);
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: appts }],
      // Two queued responses per table -- fetchAllPagesChunkedIn's first
      // chunk (300 ids) gets the first, the second chunk (1 id) gets the
      // second; each call only returns ITS OWN chunk's rows, proving the
      // route actually issued two separate, correctly-scoped requests
      // rather than one unbounded one.
      appointment_employees: [{ data: assignments.slice(0, CHUNK_SIZE) }, { data: assignments.slice(CHUNK_SIZE) }],
      completed_job_billing: [{ data: billing.slice(0, CHUNK_SIZE) }, { data: billing.slice(CHUNK_SIZE) }],
      // fetchEmployeeHoursForAppointments is ALSO chunked now (lib/
      // appointmentEmployees.ts) -- same 2-chunk split needs 2 responses.
      appointment_employee_hours: [{ data: [] }, { data: [] }],
      clients: [{ data: [{ id: "client-shared", name: "Shared Client", email: null, phone: null }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req("start=2026-08-01&end=2026-08-31"))).json();

    assert.equal(body.completed.length, CHUNK_SIZE + 1, "every appointment's billing row was actually fetched, including the one in the second chunk");

    const assignCalls = currentFake.calls.filter((c) => c.table === "appointment_employees" && c.method === "in");
    assert.equal(assignCalls.length, 2, "exactly two .in() calls -- one per chunk");
    assert.equal((assignCalls[0].args[1] as string[]).length, CHUNK_SIZE);
    assert.equal((assignCalls[1].args[1] as string[]).length, 1);

    const billingCalls = currentFake.calls.filter((c) => c.table === "completed_job_billing" && c.method === "in");
    assert.equal(billingCalls.length, 2);
  });
});
