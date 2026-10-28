// Route-level tests for GET /api/dashboard/needs-attention.
// @/lib/session and @/lib/supabaseAdmin are mocked; @/lib/entitlementServer
// is DELIBERATELY UNMOCKED (real requireCapability chain over a fake
// "workspace_memberships"/"subscriptions" table) -- same discipline as
// app/api/billing/completed-jobs/route.test.ts.
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

// Frozen clock (same technique as lib/needsAttention.test.ts) -- the
// route computes rangeStart/rangeEnd from "now," so every fixture date
// below must be anchored to this same fixed instant, not the real wall
// clock.
mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-20T18:00:00.000Z").getTime() });

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}
function req(query = "") {
  return new Request(`http://localhost/api/dashboard/needs-attention${query}`, { method: "GET" });
}

const OWNER_AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";
const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID, authUserId: OWNER_AUTH_USER_ID, sessionEpoch: 1 };
const TESTER_SESSION = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };
const MEMBERSHIP = { workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }] };
const ACTIVE = { ...MEMBERSHIP, subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] };

// "Now" is frozen (see below) to 2026-08-20T18:00:00Z -- every fixture
// date below is chosen relative to that, same technique already
// established by lib/needsAttention.test.ts and lib/payroll.test.ts.
const UNRESOLVED_APPT = {
  id: "appt-untracked", client_id: "client-1", service_type: "Lawn Mowing",
  scheduled_for: "2026-08-12T13:00:00.000Z", scheduled_end: "2026-08-12T14:00:00.000Z",
  duration_minutes: 60, status: "scheduled", price_cents: 8000,
};
const COMPLETED_UNBILLED_APPT = {
  id: "appt-unbilled", client_id: "client-2", service_type: "Window Washing",
  scheduled_for: "2026-08-13T13:00:00.000Z", scheduled_end: "2026-08-13T14:00:00.000Z",
  duration_minutes: 60, status: "scheduled", price_cents: 12000,
};
const CLEAN_APPT = {
  id: "appt-clean", client_id: "client-3", service_type: "Gutter Cleaning",
  scheduled_for: "2026-08-14T13:00:00.000Z", scheduled_end: "2026-08-14T14:00:00.000Z",
  duration_minutes: 60, status: "scheduled", price_cents: 9000,
};
const UNRESOLVED_ASSIGNMENT = {
  id: "ae-1", appointment_id: "appt-untracked", employee_id: "emp-1",
  actual_started_at: null, actual_completed_at: null, job_notes: null, created_at: "x", updated_at: "x",
};
const COMPLETED_UNBILLED_ASSIGNMENT = {
  id: "ae-2", appointment_id: "appt-unbilled", employee_id: "emp-1",
  actual_started_at: "2026-08-13T13:00:00.000Z", actual_completed_at: "2026-08-13T14:00:00.000Z",
  job_notes: null, created_at: "x", updated_at: "x",
};
const CLEAN_ASSIGNMENT = {
  id: "ae-3", appointment_id: "appt-clean", employee_id: "emp-1",
  actual_started_at: "2026-08-14T13:00:00.000Z", actual_completed_at: "2026-08-14T14:00:00.000Z",
  job_notes: null, created_at: "x", updated_at: "x",
};
const CLEAN_BILLING = {
  id: "bill-clean", workspace_id: REAL_WORKSPACE_ID, appointment_id: "appt-clean",
  invoice_number: "INV-1", paid: true, payment_method: "zelle", created_at: "x", updated_at: "x",
};
const CLIENTS = [
  { id: "client-1", name: "Petra Lindqvist", email: null, phone: null },
  { id: "client-2", name: "Simon Aldercott", email: null, phone: null },
  { id: "client-3", name: "Wren Castellan", email: null, phone: null },
];

describe("GET /api/dashboard/needs-attention -- auth/role gate", () => {
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

describe("GET /api/dashboard/needs-attention -- entitlement gate", () => {
  test("a restricted (canceled) subscription is denied, zero aggregation queries", async () => {
    resetFixtures({ ...MEMBERSHIP, subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await GET(req());
    assert.equal(res.status, 403);
    assert.equal(currentFake.calls.filter((c) => c.table === "appointments").length, 0);
  });
});

describe("GET /api/dashboard/needs-attention -- date range (failed-message window only -- see the \"unbounded history\" describe block below for items 1/2)", () => {
  test("rangeEnd is today and rangeStart is exactly NEEDS_ATTENTION_LOOKBACK_DAYS earlier, both returned in the response", async () => {
    resetFixtures({ ...ACTIVE, company_settings: [{ data: { timezone: "America/New_York" } }], appointments: [{ data: [] }] });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.match(body.rangeStart, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(body.rangeEnd, /^\d{4}-\d{2}-\d{2}$/);
    const daysApart = (new Date(body.rangeEnd).getTime() - new Date(body.rangeStart).getTime()) / (24 * 60 * 60 * 1000);
    assert.equal(Math.round(daysApart), 60);
  });
});

describe("GET /api/dashboard/needs-attention -- happy path", () => {
  test("returns one entry per distinct appointment, each with its own issues, and the overall range/timezone", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [UNRESOLVED_APPT, COMPLETED_UNBILLED_APPT, CLEAN_APPT] }],
      appointment_employees: [{ data: [UNRESOLVED_ASSIGNMENT, COMPLETED_UNBILLED_ASSIGNMENT, CLEAN_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [CLEAN_BILLING] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET(req());
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.entries.length, 2, "appt-clean is fully resolved and must not appear");
    assert.equal(body.totalCount, 2, "totalCount matches the full distinct-appointment count");
    assert.equal(body.hasMore, false);
    const byId = new Map<string, any>(body.entries.map((e: any) => [e.appointmentId, e]));
    assert.deepEqual(byId.get("appt-untracked").issues, [{ kind: "worked_time_review", label: "Worked time needs review" }]);
    assert.deepEqual(byId.get("appt-unbilled").issues, [{ kind: "needs_invoicing", label: "Needs invoice number" }]);
    assert.equal(byId.get("appt-untracked").clientName, "Petra Lindqvist");
    assert.equal(body.timezone, "America/New_York");
  });

  test("zero appointments in range short-circuits before querying assignments/billing/messages/clients", async () => {
    resetFixtures({ ...ACTIVE, company_settings: [{ data: { timezone: "America/New_York" } }], appointments: [{ data: [] }] });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.deepEqual(body.entries, []);
    assert.equal(currentFake.calls.filter((c) => c.table === "appointment_employees").length, 0);
    assert.equal(currentFake.calls.filter((c) => c.table === "completed_job_billing").length, 0);
    assert.equal(currentFake.calls.filter((c) => c.table === "messages_sent").length, 0);
    assert.equal(currentFake.calls.filter((c) => c.table === "clients").length, 0);
  });

  test("the appointments query is scoped to is_demo=false for an owner (real-workspace) session", async () => {
    resetFixtures({ ...ACTIVE, company_settings: [{ data: { timezone: "America/New_York" } }], appointments: [{ data: [] }] });
    sessionToReturn = OWNER_SESSION;
    await GET(req());
    const apptCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "eq" && c.args[0] === "is_demo");
    assert.deepEqual(apptCall?.args, ["is_demo", false]);
  });

  test("a tester session is scoped to is_demo=true and the fixed demo workspace -- never the real workspace", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: DEMO_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [] }],
    });
    sessionToReturn = TESTER_SESSION;
    await GET(req());
    const apptCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "eq" && c.args[0] === "is_demo");
    assert.deepEqual(apptCall?.args, ["is_demo", true]);
    const workspaceCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "eq" && c.args[0] === "workspace_id");
    assert.deepEqual(workspaceCall?.args, ["workspace_id", DEMO_WORKSPACE_ID]);
  });
});

describe("GET /api/dashboard/needs-attention -- failed messages (item 3)", () => {
  test("an appointment with an explicit failed-send row is flagged; classification reuses classifyMessageStatus, never a parallel rule", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [CLEAN_APPT] }],
      appointment_employees: [{ data: [CLEAN_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [CLEAN_BILLING] }],
      messages_sent: [{ data: [{ appointment_id: "appt-clean", channel: "sms", provider_id: "failed" }] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 1);
    assert.deepEqual(body.entries[0].issues, [{ kind: "failed_message", label: "1 failed message" }]);
  });

  test("an unrecognized/unknown provider_id (never confirmed accepted, but never an explicit failure either) is NOT flagged -- only an explicit \"failed\" sentinel counts", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [CLEAN_APPT] }],
      appointment_employees: [{ data: [CLEAN_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [CLEAN_BILLING] }],
      messages_sent: [{ data: [{ appointment_id: "appt-clean", channel: "sms", provider_id: "some-unrecognized-value" }] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 0, "unknown is not failure -- never inferred as a problem");
  });

  test("an appointment with no message row at all is never flagged -- absence is never inferred as failure", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [CLEAN_APPT] }],
      appointment_employees: [{ data: [CLEAN_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [CLEAN_BILLING] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 0);
  });

  test("the messages_sent query selects ONLY non-content columns -- never body, to_value, or subject", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [CLEAN_APPT] }],
      appointment_employees: [{ data: [CLEAN_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [CLEAN_BILLING] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    await GET(req());
    const selectCall = currentFake.calls.find((c) => c.table === "messages_sent" && c.method === "select");
    assert.ok(selectCall, "messages_sent was queried");
    const columns = String(selectCall!.args[0]);
    assert.ok(!columns.includes("body"), "must never select message body");
    assert.ok(!columns.includes("to_value"), "must never select recipient");
    assert.ok(!columns.includes("subject"), "must never select subject");
  });
});

describe("GET /api/dashboard/needs-attention -- billing scope (needs invoicing / payment outstanding, mutually exclusive)", () => {
  const INVOICED_UNPAID_BILLING = {
    id: "bill-unpaid", workspace_id: REAL_WORKSPACE_ID, appointment_id: "appt-unbilled",
    invoice_number: "INV-9", paid: false, payment_method: null, created_at: "x", updated_at: "x",
  };
  const PAID_BILLING = {
    id: "bill-paid", workspace_id: REAL_WORKSPACE_ID, appointment_id: "appt-unbilled",
    invoice_number: "INV-9", paid: true, payment_method: "zelle", created_at: "x", updated_at: "x",
  };

  test("a completed job that's invoiced but not yet paid is flagged \"Payment outstanding\" -- a distinct issue from \"Needs invoice number\"", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [COMPLETED_UNBILLED_APPT] }],
      appointment_employees: [{ data: [COMPLETED_UNBILLED_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [INVOICED_UNPAID_BILLING] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 1);
    assert.deepEqual(body.entries[0].issues, [{ kind: "payment_outstanding", label: "Payment outstanding" }]);
  });

  test("a completed, invoiced, PAID job is flagged with neither billing issue", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [COMPLETED_UNBILLED_APPT] }],
      appointment_employees: [{ data: [COMPLETED_UNBILLED_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [PAID_BILLING] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 0);
  });

  // Regression: the full lifecycle through the live route -- missing
  // invoice (no billing row at all) -> invoiced/unpaid -> paid. Each stage
  // re-fetches independently (resetFixtures starts a fresh fake Supabase
  // each time), exactly like three separate real requests as the owner's
  // own saves progress the same job through Billing.
  test("the full missing-invoice -> invoiced/unpaid -> paid lifecycle produces exactly one issue (or none) at each stage, through the live route", async () => {
    const baseFixtures = {
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [COMPLETED_UNBILLED_APPT] }],
      appointment_employees: [{ data: [COMPLETED_UNBILLED_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    };
    sessionToReturn = OWNER_SESSION;

    resetFixtures({ ...baseFixtures, completed_job_billing: [{ data: [] }] });
    const stage1 = await (await GET(req())).json();
    assert.deepEqual(stage1.entries[0].issues.map((i: any) => i.kind), ["needs_invoicing"]);

    resetFixtures({ ...baseFixtures, completed_job_billing: [{ data: [INVOICED_UNPAID_BILLING] }] });
    const stage2 = await (await GET(req())).json();
    assert.deepEqual(stage2.entries[0].issues.map((i: any) => i.kind), ["payment_outstanding"]);

    resetFixtures({ ...baseFixtures, completed_job_billing: [{ data: [PAID_BILLING] }] });
    const stage3 = await (await GET(req())).json();
    assert.equal(stage3.entries.length, 0);
  });
});

describe("GET /api/dashboard/needs-attention -- destination-permission gate", () => {
  test("a tester/demo session never receives a needs_invoicing issue, even for an otherwise-eligible job", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: DEMO_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [COMPLETED_UNBILLED_APPT] }],
      appointment_employees: [{ data: [COMPLETED_UNBILLED_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = TESTER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 0, "Billing is owner-only -- a tester must never be offered an action that lands on a placeholder");
  });

  test("an owner session requesting the mobile surface (?surface=mobile) never receives a needs_invoicing issue -- mobile has no Billing destination at all", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [COMPLETED_UNBILLED_APPT] }],
      appointment_employees: [{ data: [COMPLETED_UNBILLED_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req("?surface=mobile"))).json();
    assert.equal(body.entries.length, 0);
  });

  test("the same owner session WITHOUT the mobile surface param still receives the needs_invoicing issue -- the exclusion is request-scoped, not role-scoped", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [COMPLETED_UNBILLED_APPT] }],
      appointment_employees: [{ data: [COMPLETED_UNBILLED_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 1);
    assert.deepEqual(body.entries[0].issues, [{ kind: "needs_invoicing", label: "Needs invoice number" }]);
  });

  const INVOICED_UNPAID_FOR_GATE = {
    id: "bill-unpaid-gate", workspace_id: REAL_WORKSPACE_ID, appointment_id: "appt-unbilled",
    invoice_number: "INV-9", paid: false, payment_method: null, created_at: "x", updated_at: "x",
  };

  test("a tester/demo session never receives a payment_outstanding issue either -- the same destination gate covers both billing issue kinds", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: DEMO_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [COMPLETED_UNBILLED_APPT] }],
      appointment_employees: [{ data: [COMPLETED_UNBILLED_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [INVOICED_UNPAID_FOR_GATE] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = TESTER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 0);
  });

  test("an owner session requesting the mobile surface never receives a payment_outstanding issue either", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [COMPLETED_UNBILLED_APPT] }],
      appointment_employees: [{ data: [COMPLETED_UNBILLED_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [INVOICED_UNPAID_FOR_GATE] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req("?surface=mobile"))).json();
    assert.equal(body.entries.length, 0);
  });
});

// Tenant isolation: the billing-status derivation added by this feature
// reads the SAME completed_job_billing query every other issue already
// reads from -- this proves that query (and the appointments query it's
// joined against) is scoped to the session's own workspace, exactly like
// the pre-existing is_demo/workspace_id assertions above, now re-verified
// specifically for a session that has an invoiced-unpaid job in scope.
describe("GET /api/dashboard/needs-attention -- tenant isolation (payment outstanding)", () => {
  test("an owner (real-workspace) session's completed_job_billing query is scoped to workspace_id=REAL_WORKSPACE_ID, never the demo workspace", async () => {
    const invoicedUnpaid = {
      id: "bill-unpaid-tenant", workspace_id: REAL_WORKSPACE_ID, appointment_id: "appt-unbilled",
      invoice_number: "INV-9", paid: false, payment_method: null, created_at: "x", updated_at: "x",
    };
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [COMPLETED_UNBILLED_APPT] }],
      appointment_employees: [{ data: [COMPLETED_UNBILLED_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [invoicedUnpaid] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 1, "the owner's own invoiced-unpaid job is surfaced");
    assert.deepEqual(body.entries[0].issues, [{ kind: "payment_outstanding", label: "Payment outstanding" }]);

    const billingWorkspaceCall = currentFake.calls.find(
      (c) => c.table === "completed_job_billing" && c.method === "eq" && c.args[0] === "workspace_id"
    );
    assert.deepEqual(billingWorkspaceCall?.args, ["workspace_id", REAL_WORKSPACE_ID]);
    const apptWorkspaceCall = currentFake.calls.find(
      (c) => c.table === "appointments" && c.method === "eq" && c.args[0] === "workspace_id"
    );
    assert.deepEqual(apptWorkspaceCall?.args, ["workspace_id", REAL_WORKSPACE_ID]);
  });

  test("a tester (demo-workspace) session's completed_job_billing query is scoped to the fixed DEMO_WORKSPACE_ID, never the real workspace", async () => {
    const invoicedUnpaid = {
      id: "bill-unpaid-tenant-demo", workspace_id: DEMO_WORKSPACE_ID, appointment_id: "appt-unbilled",
      invoice_number: "INV-9", paid: false, payment_method: null, created_at: "x", updated_at: "x",
    };
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: DEMO_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [COMPLETED_UNBILLED_APPT] }],
      appointment_employees: [{ data: [COMPLETED_UNBILLED_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [invoicedUnpaid] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    // Tester is also the destination-permission-excluded case -- entries
    // are empty for that reason, but the QUERY must still be correctly
    // workspace-scoped before that gate is ever applied client-side.
    sessionToReturn = TESTER_SESSION;
    await GET(req());
    const billingWorkspaceCall = currentFake.calls.find(
      (c) => c.table === "completed_job_billing" && c.method === "eq" && c.args[0] === "workspace_id"
    );
    assert.deepEqual(billingWorkspaceCall?.args, ["workspace_id", DEMO_WORKSPACE_ID]);
  });
});

describe("GET /api/dashboard/needs-attention -- failed-message retry resolution", () => {
  test("a failed send followed by a later accepted retry for the exact same appointment/channel/kind/occurrence is resolved -- not flagged", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [CLEAN_APPT] }],
      appointment_employees: [{ data: [CLEAN_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [CLEAN_BILLING] }],
      messages_sent: [{
        data: [
          { id: "m1", appointment_id: "appt-clean", channel: "sms", kind: "confirmation", scheduled_for: null, provider_id: "failed", created_at: "2026-08-14T10:00:00.000Z" },
          { id: "m2", appointment_id: "appt-clean", channel: "sms", kind: "confirmation", scheduled_for: null, provider_id: "SMa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", created_at: "2026-08-14T11:00:00.000Z" },
        ],
      }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 0, "the retry resolved the earlier failure");
  });

  test("a failed send followed by a later UNRESOLVED (unknown-status) attempt stays flagged -- Unknown never resolves a failure", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [CLEAN_APPT] }],
      appointment_employees: [{ data: [CLEAN_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [CLEAN_BILLING] }],
      messages_sent: [{
        data: [
          { id: "m1", appointment_id: "appt-clean", channel: "sms", kind: "confirmation", scheduled_for: null, provider_id: "failed", created_at: "2026-08-14T10:00:00.000Z" },
          { id: "m2", appointment_id: "appt-clean", channel: "sms", kind: "confirmation", scheduled_for: null, provider_id: "some-unrecognized-value", created_at: "2026-08-14T11:00:00.000Z" },
        ],
      }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 1);
    assert.deepEqual(body.entries[0].issues, [{ kind: "failed_message", label: "1 failed message" }]);
  });

  test("the messages_sent query selects kind/scheduled_for/created_at/id (needed for retry grouping) alongside the existing non-content columns", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [CLEAN_APPT] }],
      appointment_employees: [{ data: [CLEAN_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [CLEAN_BILLING] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    await GET(req());
    const selectCall = currentFake.calls.find((c) => c.table === "messages_sent" && c.method === "select");
    const columns = String(selectCall!.args[0]);
    for (const col of ["id", "channel", "kind", "scheduled_for", "provider_id", "created_at"]) {
      assert.ok(columns.includes(col), `expected to select ${col}`);
    }
    assert.ok(!columns.includes("body") && !columns.includes("to_value") && !columns.includes("subject"));
  });
});

describe("GET /api/dashboard/needs-attention -- bounded pagination", () => {
  function manyUnresolvedAppointments(n: number) {
    const appts = [];
    const assignments = [];
    for (let i = 0; i < n; i++) {
      const id = `appt-many-${i}`;
      appts.push({
        id, client_id: "client-1", service_type: "Lawn Mowing",
        scheduled_for: `2026-08-${String(1 + (i % 19)).padStart(2, "0")}T13:00:00.000Z`,
        scheduled_end: `2026-08-${String(1 + (i % 19)).padStart(2, "0")}T14:00:00.000Z`,
        duration_minutes: 60, status: "scheduled", price_cents: 8000,
      });
      assignments.push({
        id: `ae-many-${i}`, appointment_id: id, employee_id: "emp-1",
        actual_started_at: null, actual_completed_at: null, job_notes: null, created_at: "x", updated_at: "x",
      });
    }
    return { appts, assignments };
  }

  test("the response is paginated (default page size), with totalCount reflecting the FULL distinct-appointment count, independent of the page returned", async () => {
    const { appts, assignments } = manyUnresolvedAppointments(30);
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: appts }],
      appointment_employees: [{ data: assignments }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.totalCount, 30);
    assert.ok(body.entries.length < 30, "the page itself must be bounded, not the full set");
    assert.equal(body.hasMore, true);
  });

  test("?limit=&offset= returns a later page, and hasMore is false once every entry has been returned", async () => {
    const { appts, assignments } = manyUnresolvedAppointments(5);
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: appts }],
      appointment_employees: [{ data: assignments }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req("?limit=2&offset=4"))).json();
    assert.equal(body.totalCount, 5);
    assert.equal(body.entries.length, 1, "only one entry remains past offset 4");
    assert.equal(body.hasMore, false);
  });

  test("an out-of-range limit is clamped to MAX_LIMIT, never trusted verbatim", async () => {
    resetFixtures({ ...ACTIVE, company_settings: [{ data: { timezone: "America/New_York" } }], appointments: [{ data: [] }] });
    sessionToReturn = OWNER_SESSION;
    const res = await GET(req("?limit=999999"));
    assert.equal(res.status, 200, "an oversized limit must not error -- it is clamped, not rejected");
  });
});

// Regression: the 60-day window bounds the DATE range, not the ROW count --
// a single PostgREST response is itself capped (1000 rows by default, see
// lib/paginate.ts's own doc comment), so every query keyed off apptIds
// (appointments itself, plus appointment_employees/messages_sent/
// completed_job_billing/clients/appointment_employee_hours) must fetch in
// bounded batches via fetchAllPages rather than one unrestricted .in()/
// .select() call that would silently truncate past row 1000 with no error.
// lib/testSupport.ts's fake queues exactly one canned {data} response per
// *call* to a table (not per `.range()` value -- the fake doesn't slice),
// so queuing TWO responses for the same table forces fetchAllPages through
// two real round trips: the first must come back exactly at the page size
// (1000) to look "full" and trigger a second fetch, the second is a short
// page that ends the loop. If the route ever regressed to a single
// unbounded query, it would see only the first queued page (1000 rows) and
// silently lose everything after it.
describe("GET /api/dashboard/needs-attention -- bounded DATABASE batches across more than 1000 rows (regression)", () => {
  const PAGE_SIZE = 1000;

  // n early appointments, all within range and all "unresolved" (no
  // actual_started_at/actual_completed_at -- same shape as
  // manyUnresolvedAppointments above), dated across Aug 1-19 so they
  // always sort strictly BEFORE the dedicated "tail" appointments below.
  function earlyAppointments(n: number) {
    const appts = [];
    const assignments = [];
    for (let i = 0; i < n; i++) {
      const id = `appt-early-${i}`;
      appts.push({
        id, client_id: "client-1", service_type: "Lawn Mowing",
        scheduled_for: `2026-08-${String(1 + (i % 19)).padStart(2, "0")}T13:00:00.000Z`,
        scheduled_end: `2026-08-${String(1 + (i % 19)).padStart(2, "0")}T14:00:00.000Z`,
        duration_minutes: 60, status: "scheduled", price_cents: 8000,
      });
      assignments.push({
        id: `ae-early-${i}`, appointment_id: id, employee_id: "emp-1",
        actual_started_at: null, actual_completed_at: null, job_notes: null, created_at: "x", updated_at: "x",
      });
    }
    return { appts, assignments };
  }

  // A handful of appointments deliberately dated on 2026-08-20 (rangeEnd
  // itself, the latest possible day in range) so they always sort strictly
  // AFTER every "early" appointment above once the full set is merged and
  // sorted -- letting a test target exactly these rows via `offset` without
  // depending on the DB batch boundary lining up with the sort order.
  function tailAppointments(n: number) {
    const appts = [];
    const assignments = [];
    for (let i = 0; i < n; i++) {
      const id = `appt-tail-${i}`;
      appts.push({
        id, client_id: "client-1", service_type: "Window Washing",
        scheduled_for: "2026-08-20T13:00:00.000Z", scheduled_end: "2026-08-20T14:00:00.000Z",
        duration_minutes: 60, status: "scheduled", price_cents: 8000,
      });
      assignments.push({
        id: `ae-tail-${i}`, appointment_id: id, employee_id: "emp-1",
        actual_started_at: null, actual_completed_at: null, job_notes: null, created_at: "x", updated_at: "x",
      });
    }
    return { appts, assignments };
  }

  // apptIds (1005 of them) now ALSO gets chunked (DEFAULT_ID_CHUNK_SIZE=300
  // in lib/paginate.ts) for every .in()-filtered query -- ceil(1005/300) =
  // 4 chunks, matching the id list's own order (appointments is built from
  // the SAME two queued "appointments" pages, early then tail, so chunk 4
  // is the only one that straddles early/tail). Each chunk's own response
  // is short here (well under 1000 rows), so each chunk consumes exactly
  // one queued fixture -- 4 total per .in()-filtered table, not 1.
  function chunkBySize<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
  }

  test("an appointment that only exists on the SECOND database page (rows 1000+) is still returned, and totalCount reflects the full count past 1000", async () => {
    const early = earlyAppointments(PAGE_SIZE); // exactly one full page
    const tail = tailAppointments(5); // the short, terminating page
    const allAssignmentsInApptIdOrder = [...early.assignments, ...tail.assignments];
    const assignmentChunks = chunkBySize(allAssignmentsInApptIdOrder, 300); // -> 4 chunks: 300,300,300,105
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      // Two queued responses for "appointments" -- the first is exactly
      // PAGE_SIZE rows (looks like a full page, so fetchAllPages must ask
      // for more), the second is the remaining 5 (a short page that ends
      // the loop). A single-query regression would see only `early`. This
      // query has no .in() id filter (just the date window), so it is NOT
      // chunked -- only ROW-COUNT paginated, 2 responses total.
      appointments: [{ data: early.appts }, { data: tail.appts }],
      // .in()-filtered queries: 4 chunk responses each (see chunkBySize
      // above), matching apptIds' own 1005-id, 4-chunk split.
      appointment_employees: assignmentChunks.map((chunk) => ({ data: chunk })),
      appointment_employee_hours: assignmentChunks.map(() => ({ data: [] })),
      completed_job_billing: assignmentChunks.map(() => ({ data: [] })),
      // All 1005 appointments fall within the last 60 days of "now"
      // (2026-08-20), so recentApptIds === apptIds here too -- messages_sent
      // is chunked the same 4 ways.
      messages_sent: assignmentChunks.map(() => ({ data: [] })),
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;

    const body = await (await GET(req("?limit=100&offset=1000"))).json();
    assert.equal(body.totalCount, PAGE_SIZE + 5, "totalCount must include every row past the first 1000, not just the first page");
    assert.equal(body.hasMore, false);
    assert.deepEqual(
      body.entries.map((e: any) => e.appointmentId).sort(),
      tail.appts.map((a) => a.id).sort(),
      "the 5 tail appointments (only ever present on the second DB page) must be the last 5 entries once sorted"
    );

    // Confirms the appointments query actually ran in two bounded batches
    // (not one unrestricted call), each ordered deterministically so the
    // two pages can never overlap or skip a row.
    const apptRangeCalls = currentFake.calls.filter((c) => c.table === "appointments" && c.method === "range");
    assert.deepEqual(apptRangeCalls.map((c) => c.args), [[0, 999], [1000, 1999]]);
    const apptOrderCalls = currentFake.calls.filter((c) => c.table === "appointments" && c.method === "order");
    assert.ok(apptOrderCalls.some((c) => c.args[0] === "id"), "appointments must carry a deterministic id tiebreaker");

    // appointment_employees is keyed off apptIds via the CHUNKED helper
    // now (1005 ids -> 4 chunks of <=300), not the row-count pagination
    // the appointments query above uses -- each chunk's own response here
    // is short (well under 1000 rows), so each of the 4 chunks makes
    // exactly one .range(0, 999) call, never a second page within a chunk.
    const assignRangeCalls = currentFake.calls.filter((c) => c.table === "appointment_employees" && c.method === "range");
    assert.deepEqual(assignRangeCalls.map((c) => c.args), [[0, 999], [0, 999], [0, 999], [0, 999]]);
    const assignInCalls = currentFake.calls.filter((c) => c.table === "appointment_employees" && c.method === "in");
    assert.equal(assignInCalls.length, 4, "the id list was chunked into 4 separate .in() calls, never one 1005-id filter");
    assert.deepEqual((assignInCalls.map((c) => (c.args[1] as string[]).length)), [300, 300, 300, 105]);
  });

  test("a failed message that only exists on the SECOND messages_sent database page (rows 1000+) still flags its appointment", async () => {
    // A single appointment with far more than 1000 message attempts
    // (unusual in practice, but exercises the exact mechanics fetchAllPages
    // relies on): page 1 is 1000 resolved/accepted sends across 1000
    // distinct reminder occurrences; page 2 holds one more occurrence whose
    // only attempt failed. If the route only read the first 1000 rows, this
    // failure would be invisible.
    const resolvedRows = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      id: `m-ok-${i}`, appointment_id: "appt-clean", channel: "sms", kind: "reminder",
      scheduled_for: `2026-08-01T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
      provider_id: "SMa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", created_at: "2026-08-01T00:00:00.000Z",
    }));
    const tailRows = [
      {
        id: "m-fail-tail", appointment_id: "appt-clean", channel: "sms", kind: "reminder",
        scheduled_for: "2026-08-19T13:00:00.000Z", provider_id: "failed", created_at: "2026-08-19T12:00:00.000Z",
      },
    ];
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [CLEAN_APPT] }],
      appointment_employees: [{ data: [CLEAN_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [CLEAN_BILLING] }],
      messages_sent: [{ data: resolvedRows }, { data: tailRows }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;

    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 1, "the second-page failure must still surface the appointment");
    assert.deepEqual(body.entries[0].issues, [{ kind: "failed_message", label: "1 failed message" }]);

    const msgRangeCalls = currentFake.calls.filter((c) => c.table === "messages_sent" && c.method === "range");
    assert.deepEqual(msgRangeCalls.map((c) => c.args), [[0, 999], [1000, 1999]]);
    const msgOrderCalls = currentFake.calls.filter((c) => c.table === "messages_sent" && c.method === "order");
    assert.ok(msgOrderCalls.some((c) => c.args[0] === "id"), "messages_sent must carry a deterministic id tiebreaker, required by fetchAllPages' own contract");
  });
});

describe("GET /api/dashboard/needs-attention -- grouping", () => {
  test("an appointment with both a worked-time-review issue and a failed message appears exactly once, with both issues", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [UNRESOLVED_APPT] }],
      appointment_employees: [{ data: [UNRESOLVED_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [] }],
      messages_sent: [{ data: [{ appointment_id: "appt-untracked", channel: "sms", provider_id: "failed" }] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 1);
    assert.deepEqual(
      body.entries[0].issues.map((i: any) => i.kind).sort(),
      ["failed_message", "worked_time_review"]
    );
  });
});

// Unbounded history (SFT scope change): worked-time review, needs-invoicing,
// and payment-outstanding no longer age out at 60 days -- failed messages
// alone keep that window. "Now" is frozen to 2026-08-20; January 2026 is
// ~215 days earlier, well past the old 60-day cutoff.
describe("GET /api/dashboard/needs-attention -- unbounded history for unresolved work/billing (regression)", () => {
  const JANUARY_REVIEW_APPT = {
    id: "appt-january-review", client_id: "client-1", service_type: "Lawn Mowing",
    scheduled_for: "2026-01-15T13:00:00.000Z", scheduled_end: "2026-01-15T14:00:00.000Z",
    duration_minutes: 60, status: "scheduled", price_cents: 8000,
  };
  const JANUARY_REVIEW_ASSIGNMENT = {
    id: "ae-january-review", appointment_id: "appt-january-review", employee_id: "emp-1",
    actual_started_at: null, actual_completed_at: null, job_notes: null, created_at: "x", updated_at: "x",
  };
  const JANUARY_INVOICE_APPT = {
    id: "appt-january-invoice", client_id: "client-2", service_type: "Window Washing",
    scheduled_for: "2026-01-16T13:00:00.000Z", scheduled_end: "2026-01-16T14:00:00.000Z",
    duration_minutes: 60, status: "scheduled", price_cents: 12000,
  };
  const JANUARY_INVOICE_ASSIGNMENT = {
    id: "ae-january-invoice", appointment_id: "appt-january-invoice", employee_id: "emp-1",
    actual_started_at: "2026-01-16T13:00:00.000Z", actual_completed_at: "2026-01-16T14:00:00.000Z",
    job_notes: null, created_at: "x", updated_at: "x",
  };
  const JANUARY_UNPAID_APPT = {
    id: "appt-january-unpaid", client_id: "client-3", service_type: "Gutter Cleaning",
    scheduled_for: "2026-01-17T13:00:00.000Z", scheduled_end: "2026-01-17T14:00:00.000Z",
    duration_minutes: 60, status: "scheduled", price_cents: 9000,
  };
  const JANUARY_UNPAID_ASSIGNMENT = {
    id: "ae-january-unpaid", appointment_id: "appt-january-unpaid", employee_id: "emp-1",
    actual_started_at: "2026-01-17T13:00:00.000Z", actual_completed_at: "2026-01-17T14:00:00.000Z",
    job_notes: null, created_at: "x", updated_at: "x",
  };
  const JANUARY_UNPAID_BILLING = {
    id: "bill-january-unpaid", workspace_id: REAL_WORKSPACE_ID, appointment_id: "appt-january-unpaid",
    invoice_number: "INV-JAN", paid: false, payment_method: null, created_at: "x", updated_at: "x",
  };
  const JANUARY_PAID_APPT = {
    id: "appt-january-paid", client_id: "client-1", service_type: "Regular Cleaning",
    scheduled_for: "2026-01-18T13:00:00.000Z", scheduled_end: "2026-01-18T14:00:00.000Z",
    duration_minutes: 60, status: "scheduled", price_cents: 9000,
  };
  const JANUARY_PAID_ASSIGNMENT = {
    id: "ae-january-paid", appointment_id: "appt-january-paid", employee_id: "emp-1",
    actual_started_at: "2026-01-18T13:00:00.000Z", actual_completed_at: "2026-01-18T14:00:00.000Z",
    job_notes: null, created_at: "x", updated_at: "x",
  };
  const JANUARY_PAID_BILLING = {
    id: "bill-january-paid", workspace_id: REAL_WORKSPACE_ID, appointment_id: "appt-january-paid",
    invoice_number: "INV-JAN-PAID", paid: true, payment_method: "zelle", created_at: "x", updated_at: "x",
  };
  const JANUARY_CANCELLED_APPT = {
    id: "appt-january-cancelled", client_id: "client-1", service_type: "Regular Cleaning",
    scheduled_for: "2026-01-19T13:00:00.000Z", scheduled_end: "2026-01-19T14:00:00.000Z",
    duration_minutes: 60, status: "cancelled", price_cents: 9000,
  };
  const JANUARY_CANCELLED_ASSIGNMENT = {
    id: "ae-january-cancelled", appointment_id: "appt-january-cancelled", employee_id: "emp-1",
    actual_started_at: null, actual_completed_at: null, job_notes: null, created_at: "x", updated_at: "x",
  };

  test("a January appointment with unresolved worked time is flagged -- no rolling cutoff for worked_time_review", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [JANUARY_REVIEW_APPT] }],
      appointment_employees: [{ data: [JANUARY_REVIEW_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0].serviceDate, "2026-01-15", "the deep-link date is the job's own, not clamped to any window");
    assert.deepEqual(body.entries[0].issues, [{ kind: "worked_time_review", label: "Worked time needs review" }]);
  });

  test("a January appointment with no invoice number is flagged -- no rolling cutoff for needs_invoicing", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [JANUARY_INVOICE_APPT] }],
      appointment_employees: [{ data: [JANUARY_INVOICE_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 1);
    assert.deepEqual(body.entries[0].issues, [{ kind: "needs_invoicing", label: "Needs invoice number" }]);
  });

  test("a January appointment invoiced but unpaid is flagged -- no rolling cutoff for payment_outstanding", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [JANUARY_UNPAID_APPT] }],
      appointment_employees: [{ data: [JANUARY_UNPAID_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [JANUARY_UNPAID_BILLING] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 1);
    assert.deepEqual(body.entries[0].issues, [{ kind: "payment_outstanding", label: "Payment outstanding" }]);
  });

  test("a January appointment that's PAID is excluded -- unbounded history never means ignoring resolution", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [JANUARY_PAID_APPT] }],
      appointment_employees: [{ data: [JANUARY_PAID_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [JANUARY_PAID_BILLING] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 0);
  });

  test("a January CANCELLED appointment is excluded -- unbounded history never overrides the cancelled-exclusion rule", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [JANUARY_CANCELLED_APPT] }],
      appointment_employees: [{ data: [JANUARY_CANCELLED_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 0);
  });

  // A January failed message must stay excluded (item 3 keeps its 60-day
  // window) even though a January unresolved-work issue on the SAME
  // appointment is now flagged -- proves the two scopes are independent at
  // the route level, not just in lib/needsAttention.ts's own unit tests.
  test("a January appointment's messages_sent is never even queried -- it falls outside recentApptIds, so item 3 can't see it regardless of what messages_sent would return", async () => {
    resetFixtures({
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [JANUARY_REVIEW_APPT, CLEAN_APPT] }],
      appointment_employees: [{ data: [JANUARY_REVIEW_ASSIGNMENT, CLEAN_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [CLEAN_BILLING] }],
      // Only appt-clean's (recent) failed message -- if the route ever
      // queried messages_sent for the January appointment too, this single
      // queued response would still be consumed either way, so the REAL
      // proof is the asserted .in() call args below, not this fixture data.
      messages_sent: [{ data: [{ appointment_id: "appt-clean", channel: "sms", provider_id: "failed" }] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = OWNER_SESSION;
    const body = await (await GET(req())).json();

    const byId = new Map<string, any>(body.entries.map((e: any) => [e.appointmentId, e]));
    assert.deepEqual(byId.get("appt-january-review").issues, [{ kind: "worked_time_review", label: "Worked time needs review" }]);
    assert.deepEqual(byId.get("appt-clean").issues, [{ kind: "failed_message", label: "1 failed message" }]);

    const msgInCall = currentFake.calls.find((c) => c.table === "messages_sent" && c.method === "in");
    assert.ok(msgInCall, "messages_sent was queried (for the recent appointment)");
    const queriedIds = msgInCall!.args[1] as string[];
    assert.ok(queriedIds.includes("appt-clean"), "the recent appointment IS in the messages_sent query scope");
    assert.ok(!queriedIds.includes("appt-january-review"), "the January appointment must NEVER be in the messages_sent query scope -- item 3 keeps its 60-day window");
  });

  test("mixed old and recent issues: totalCount reflects every distinct unresolved appointment regardless of age, and pagination slices across both", async () => {
    const mixedFixtures = {
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [JANUARY_REVIEW_APPT, JANUARY_INVOICE_APPT, UNRESOLVED_APPT, COMPLETED_UNBILLED_APPT] }],
      appointment_employees: [{ data: [JANUARY_REVIEW_ASSIGNMENT, JANUARY_INVOICE_ASSIGNMENT, UNRESOLVED_ASSIGNMENT, COMPLETED_UNBILLED_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    };
    sessionToReturn = OWNER_SESSION;

    resetFixtures(mixedFixtures);
    const body = await (await GET(req("?limit=2&offset=0"))).json();
    assert.equal(body.totalCount, 4, "all 4 distinct appointments count, 2 old (January) and 2 recent");
    assert.equal(body.entries.length, 2, "the page itself is still bounded by limit");
    assert.equal(body.hasMore, true);

    // A fresh fake per request, same convention as the lifecycle tests
    // above -- each real request re-fetches/re-derives everything from
    // scratch server-side, so a second page is a second independent call,
    // not a second read from the first call's already-exhausted fixtures.
    resetFixtures(mixedFixtures);
    const page2 = await (await GET(req("?limit=2&offset=2"))).json();
    assert.equal(page2.entries.length, 2);
    assert.equal(page2.hasMore, false);
    // Oldest serviceDate first (January before August), same ordering rule
    // as always -- unaffected by the scope change.
    assert.deepEqual(
      [...body.entries, ...page2.entries].map((e: any) => e.appointmentId),
      ["appt-january-review", "appt-january-invoice", "appt-untracked", "appt-unbilled"]
    );
  });

  test("cross-workspace isolation for an OLD (January) appointment: a tester session's appointments query is still scoped to the fixed demo workspace, never the real one", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: DEMO_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [JANUARY_REVIEW_APPT] }],
      appointment_employees: [{ data: [JANUARY_REVIEW_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      completed_job_billing: [{ data: [] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    });
    sessionToReturn = TESTER_SESSION;
    const body = await (await GET(req())).json();
    assert.equal(body.entries.length, 1, "the January appointment is still surfaced -- age alone never excludes it");
    const apptWorkspaceCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "eq" && c.args[0] === "workspace_id");
    assert.deepEqual(apptWorkspaceCall?.args, ["workspace_id", DEMO_WORKSPACE_ID]);
    const apptDemoCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "eq" && c.args[0] === "is_demo");
    assert.deepEqual(apptDemoCall?.args, ["is_demo", true]);
  });

  // "Opening and resolving an older Billing item": the full lifecycle,
  // anchored on a January date -- proves a job doesn't need to be recent
  // for the owner to create its invoice, follow up on payment, and have it
  // disappear from this list once resolved, exactly like a recent job
  // already could.
  test("opening and resolving an older Billing item: the full missing-invoice -> invoiced/unpaid -> paid lifecycle works identically for a January job", async () => {
    const baseFixtures = {
      ...ACTIVE,
      company_settings: [{ data: { timezone: "America/New_York" } }],
      appointments: [{ data: [JANUARY_INVOICE_APPT] }],
      appointment_employees: [{ data: [JANUARY_INVOICE_ASSIGNMENT] }],
      appointment_employee_hours: [{ data: [] }],
      messages_sent: [{ data: [] }],
      clients: [{ data: CLIENTS }],
    };
    sessionToReturn = OWNER_SESSION;

    resetFixtures({ ...baseFixtures, completed_job_billing: [{ data: [] }] });
    const stage1 = await (await GET(req())).json();
    assert.deepEqual(stage1.entries[0].issues.map((i: any) => i.kind), ["needs_invoicing"]);
    assert.equal(stage1.entries[0].serviceDate, "2026-01-16", "the deep-link date BillingPanel needs to open this exact row");
    assert.equal(stage1.entries[0].appointmentId, "appt-january-invoice");

    const invoicedUnpaid = {
      id: "bill-january-lifecycle", workspace_id: REAL_WORKSPACE_ID, appointment_id: "appt-january-invoice",
      invoice_number: "INV-JAN-LC", paid: false, payment_method: null, created_at: "x", updated_at: "x",
    };
    resetFixtures({ ...baseFixtures, completed_job_billing: [{ data: [invoicedUnpaid] }] });
    const stage2 = await (await GET(req())).json();
    assert.deepEqual(stage2.entries[0].issues.map((i: any) => i.kind), ["payment_outstanding"]);

    const paid = { ...invoicedUnpaid, paid: true, payment_method: "zelle" };
    resetFixtures({ ...baseFixtures, completed_job_billing: [{ data: [paid] }] });
    const stage3 = await (await GET(req())).json();
    assert.equal(stage3.entries.length, 0, "resolved -- the owner marked it paid, it drops off the list even though it's months old");
  });
});
