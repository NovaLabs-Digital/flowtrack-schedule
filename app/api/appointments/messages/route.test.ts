// Route-level tests for app/api/appointments/messages/route.ts (GET).
// @/lib/session and @/lib/supabaseAdmin are mocked; @/lib/entitlementServer
// is DELIBERATELY UNMOCKED (real requireCapability chain over a fake
// "subscriptions" table) -- same convention as every other route test in
// this codebase. Tester-role sessions are used throughout: requireCurrentOwnerSession
// is a no-op for any non-"owner" role (lib/sessionEpoch.ts), so no
// workspace_memberships fixture is needed here, keeping these tests focused
// on this route's own logic (ownership check, scoping, pagination, status
// mapping) rather than re-proving the entitlement gate already covered
// elsewhere.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin, fakeSessionNamedExports, subscriptionRow } from "../../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../../lib/testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});
let sessionToReturn: unknown = { role: "none" };

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});
mock.module("@/lib/session", { namedExports: fakeSessionNamedExports(async () => sessionToReturn) });

const { GET } = await import("./route.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}
function req(url: string) {
  return new Request(url, { method: "GET" });
}

const TESTER_SESSION = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };
const ACTIVE_SUB = { data: subscriptionRow({ stripe_status: "active" }) };
const APPT_ID = "11111111-1111-4111-8111-111111111111";

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "m1", channel: "email", kind: "confirmation", to_value: "client@example.com",
    body: "Your appointment is confirmed.", subject: "Appointment Confirmed", provider_id: "re_abc123",
    created_at: "2026-01-02T10:00:00Z", scheduled_for: null,
    ...overrides,
  };
}

describe("GET /api/appointments/messages -- access control", () => {
  test("rejects a role that isn't owner/tester before any query", async () => {
    sessionToReturn = { role: "employee", employeeId: "e1", workspaceId: DEMO_WORKSPACE_ID };
    resetFixtures({});
    const res = await GET(req(`http://localhost/api/appointments/messages?appointment_id=${APPT_ID}`));
    assert.equal(res.status, 403);
  });

  test("400 when appointment_id is missing", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({ subscriptions: [ACTIVE_SUB] });
    const res = await GET(req("http://localhost/api/appointments/messages"));
    assert.equal(res.status, 400);
  });

  test("404 when the appointment does not belong to this workspace (ownership check fails before messages_sent is ever queried)", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({ subscriptions: [ACTIVE_SUB], appointments: [{ data: null }] });
    const res = await GET(req(`http://localhost/api/appointments/messages?appointment_id=${APPT_ID}`));
    assert.equal(res.status, 404);
    assert.equal(currentFake.calls.some((c) => c.table === "messages_sent"), false, "messages_sent must never be queried once ownership fails");
  });

  test("the ownership check and the messages_sent query are both scoped by this exact session's workspace_id -- the cross-tenant protection", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({ subscriptions: [ACTIVE_SUB], appointments: [{ data: { id: APPT_ID } }], messages_sent: [{ data: [row()] }] });
    const res = await GET(req(`http://localhost/api/appointments/messages?appointment_id=${APPT_ID}`));
    assert.equal(res.status, 200);
    const apptEqCalls = currentFake.calls.filter((c) => c.table === "appointments" && c.method === "eq");
    assert.ok(apptEqCalls.some((c) => c.args[0] === "workspace_id" && c.args[1] === DEMO_WORKSPACE_ID));
    const msgEqCalls = currentFake.calls.filter((c) => c.table === "messages_sent" && c.method === "eq");
    assert.ok(msgEqCalls.some((c) => c.args[0] === "workspace_id" && c.args[1] === DEMO_WORKSPACE_ID));
    assert.ok(msgEqCalls.some((c) => c.args[0] === "appointment_id" && c.args[1] === APPT_ID));
  });

  // Authorization policy under test: a tester (demo) session's workspaceId
  // is a SERVER-ASSIGNED constant (lib/session.ts -- set at login from the
  // signed session cookie's own payload, never derived from this request's
  // appointment_id or any other caller-supplied value). This route never
  // reads a workspace id from the request at all; every query -- the
  // ownership check AND the messages_sent fetch -- is scoped by
  // session.workspaceId alone. So even if a tester session is handed the
  // exact appointment_id of a REAL (non-demo) workspace's appointment, the
  // ownership lookup is still issued as "this id AND workspace_id =
  // DEMO_WORKSPACE_ID" -- which a real database can never match against a
  // row that actually belongs to REAL_WORKSPACE_ID -- so it 404s rather than
  // ever reaching (or being able to leak) that row's real client messages.
  test("a tester (demo) session can never see a real workspace's appointment's messages, even when given that exact appointment_id -- the lookup itself is scoped to DEMO_WORKSPACE_ID, not the real one", async () => {
    sessionToReturn = TESTER_SESSION;
    // Simulates what a REAL database returns for this exact query shape: no
    // row matches "id = <real workspace's appointment> AND workspace_id =
    // DEMO_WORKSPACE_ID" because that appointment actually belongs to
    // REAL_WORKSPACE_ID. The fake client doesn't filter on its own, which is
    // exactly why the assertions below also check the literal eq() argument
    // values -- proving the REQUEST itself was scoped correctly, which is
    // what makes a real Postgres row-match impossible here.
    resetFixtures({ subscriptions: [ACTIVE_SUB], appointments: [{ data: null }] });
    const res = await GET(req(`http://localhost/api/appointments/messages?appointment_id=${APPT_ID}`));
    assert.equal(res.status, 404);
    const apptEqCalls = currentFake.calls.filter((c) => c.table === "appointments" && c.method === "eq");
    assert.ok(apptEqCalls.some((c) => c.args[0] === "workspace_id" && c.args[1] === DEMO_WORKSPACE_ID));
    assert.ok(!apptEqCalls.some((c) => c.args[0] === "workspace_id" && c.args[1] === REAL_WORKSPACE_ID), "a tester session must never scope by the real workspace id");
    assert.equal(currentFake.calls.some((c) => c.table === "messages_sent"), false, "messages_sent must never be reached once the ownership check fails");
  });
});

describe("GET /api/appointments/messages -- status accuracy and content preservation", () => {
  test("a real provider id maps to 'sent' with the delivery-unconfirmed qualifier, and the stored recipient/body/subject are returned verbatim", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({
      subscriptions: [ACTIVE_SUB],
      appointments: [{ data: { id: APPT_ID } }],
      messages_sent: [{ data: [row({ to_value: "historic-address@example.com", body: "Historic body text.", subject: "Historic subject" })] }],
    });
    const res = await GET(req(`http://localhost/api/appointments/messages?appointment_id=${APPT_ID}`));
    const data = await res.json();
    assert.equal(data.messages.length, 1);
    const m = data.messages[0];
    assert.deepEqual(m.status, { code: "sent", label: "Sent — delivery unconfirmed" });
    assert.equal(m.toValue, "historic-address@example.com");
    assert.equal(m.body, "Historic body text.");
    assert.equal(m.subject, "Historic subject");
  });

  test("a failed send maps to Failed", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({ subscriptions: [ACTIVE_SUB], appointments: [{ data: { id: APPT_ID } }], messages_sent: [{ data: [row({ provider_id: "failed" })] }] });
    const res = await GET(req(`http://localhost/api/appointments/messages?appointment_id=${APPT_ID}`));
    const data = await res.json();
    assert.deepEqual(data.messages[0].status, { code: "failed", label: "Failed" });
  });

  test("the two recorded skip reasons are shown accurately and distinctly", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({
      subscriptions: [ACTIVE_SUB],
      appointments: [{ data: { id: APPT_ID } }],
      messages_sent: [{ data: [row({ id: "m1", provider_id: "disabled" }), row({ id: "m2", provider_id: "notifications-off" })] }],
    });
    const res = await GET(req(`http://localhost/api/appointments/messages?appointment_id=${APPT_ID}`));
    const data = await res.json();
    assert.deepEqual(data.messages[0].status, { code: "skipped_disabled", label: "Skipped — message sending was disabled" });
    assert.deepEqual(data.messages[1].status, { code: "skipped_notifications_off", label: "Skipped — client notifications were off" });
  });

  test("an older record with no subject/scheduled_for captured is returned as null, never guessed or backfilled", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({
      subscriptions: [ACTIVE_SUB],
      appointments: [{ data: { id: APPT_ID } }],
      messages_sent: [{ data: [row({ subject: null, scheduled_for: null })] }],
    });
    const res = await GET(req(`http://localhost/api/appointments/messages?appointment_id=${APPT_ID}`));
    const data = await res.json();
    assert.equal(data.messages[0].subject, null);
    assert.equal(data.messages[0].scheduledFor, null);
  });

  test("a null provider_id maps to Unknown, never Sent or Failed", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({ subscriptions: [ACTIVE_SUB], appointments: [{ data: { id: APPT_ID } }], messages_sent: [{ data: [row({ provider_id: null })] }] });
    const res = await GET(req(`http://localhost/api/appointments/messages?appointment_id=${APPT_ID}`));
    const data = await res.json();
    assert.deepEqual(data.messages[0].status, { code: "unknown", label: "Unknown" });
  });

  test("a non-empty but unexpected provider_id (e.g. a stringified-bug artifact) is NOT labelled Sent merely for being non-empty -- it maps to Unknown through the real route, end to end", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({ subscriptions: [ACTIVE_SUB], appointments: [{ data: { id: APPT_ID } }], messages_sent: [{ data: [row({ id: "m1", provider_id: "undefined" }), row({ id: "m2", provider_id: "null" })] }] });
    const res = await GET(req(`http://localhost/api/appointments/messages?appointment_id=${APPT_ID}`));
    const data = await res.json();
    assert.deepEqual(data.messages[0].status, { code: "unknown", label: "Unknown" });
    assert.deepEqual(data.messages[1].status, { code: "unknown", label: "Unknown" });
    assert.notEqual(data.messages[0].status.code, "sent");
    assert.notEqual(data.messages[1].status.code, "sent");
  });

  test("zero rows returns an empty list, not an error", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({ subscriptions: [ACTIVE_SUB], appointments: [{ data: { id: APPT_ID } }], messages_sent: [{ data: [] }] });
    const res = await GET(req(`http://localhost/api/appointments/messages?appointment_id=${APPT_ID}`));
    const data = await res.json();
    assert.deepEqual(data.messages, []);
    assert.equal(data.hasMore, false);
  });
});

describe("GET /api/appointments/messages -- bounded pagination", () => {
  test("requesting limit=2 with 3 rows available reports hasMore=true and returns exactly 2, ordered newest-first with a stable id tiebreaker", async () => {
    sessionToReturn = TESTER_SESSION;
    const rows = [row({ id: "m3", created_at: "2026-01-03T00:00:00Z" }), row({ id: "m2", created_at: "2026-01-02T00:00:00Z" }), row({ id: "m1", created_at: "2026-01-01T00:00:00Z" })];
    resetFixtures({ subscriptions: [ACTIVE_SUB], appointments: [{ data: { id: APPT_ID } }], messages_sent: [{ data: rows }] });
    const res = await GET(req(`http://localhost/api/appointments/messages?appointment_id=${APPT_ID}&limit=2`));
    const data = await res.json();
    assert.equal(data.messages.length, 2);
    assert.equal(data.hasMore, true);
    const orderCalls = currentFake.calls.filter((c) => c.table === "messages_sent" && c.method === "order");
    assert.deepEqual(orderCalls.map((c) => c.args), [["created_at", { ascending: false }], ["id", { ascending: false }]]);
  });

  test("a limit above MAX_LIMIT is clamped, and offset is forwarded to the range() call", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({ subscriptions: [ACTIVE_SUB], appointments: [{ data: { id: APPT_ID } }], messages_sent: [{ data: [] }] });
    await GET(req(`http://localhost/api/appointments/messages?appointment_id=${APPT_ID}&limit=9999&offset=20`));
    const rangeCall = currentFake.calls.find((c) => c.table === "messages_sent" && c.method === "range");
    assert.deepEqual(rangeCall?.args, [20, 20 + 50]); // clamped to MAX_LIMIT (50)
  });

  test("no more rows than the page reports hasMore=false", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({ subscriptions: [ACTIVE_SUB], appointments: [{ data: { id: APPT_ID } }], messages_sent: [{ data: [row()] }] });
    const res = await GET(req(`http://localhost/api/appointments/messages?appointment_id=${APPT_ID}&limit=20`));
    const data = await res.json();
    assert.equal(data.hasMore, false);
    assert.equal(data.messages.length, 1);
  });
});
