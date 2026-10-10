// Route-level tests for app/api/clients/messages/route.ts (GET). Same
// conventions as app/api/appointments/messages/route.test.ts (tester-role
// sessions, entitlementServer unmocked over a fake "subscriptions" table) --
// see that file's header comment for why.
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
const CLIENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
// A correctly-shaped Resend id (UUID) -- matches lib/messageStatus.ts's real
// format validation, so these fixtures classify as "sent" the same way a
// real email row would.
const REAL_RESEND_ID = "4ef9a417-02e9-4d39-ad75-9611e0fcc33c";

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "m1", appointment_id: "appt-a", channel: "email", kind: "update", to_value: "client@example.com",
    body: "Your appointment changed.", subject: "Appointment Updated", provider_id: REAL_RESEND_ID,
    created_at: "2026-01-02T10:00:00Z", scheduled_for: null,
    ...overrides,
  };
}

describe("GET /api/clients/messages -- access control", () => {
  test("rejects a role that isn't owner/tester", async () => {
    sessionToReturn = { role: "employee", employeeId: "e1", workspaceId: DEMO_WORKSPACE_ID };
    resetFixtures({});
    const res = await GET(req(`http://localhost/api/clients/messages?client_id=${CLIENT_ID}`));
    assert.equal(res.status, 403);
  });

  test("400 when client_id is missing", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({ subscriptions: [ACTIVE_SUB] });
    const res = await GET(req("http://localhost/api/clients/messages"));
    assert.equal(res.status, 400);
  });

  test("404 when the client does not belong to this workspace -- appointments and messages_sent are never queried", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({ subscriptions: [ACTIVE_SUB], clients: [{ data: null }] });
    const res = await GET(req(`http://localhost/api/clients/messages?client_id=${CLIENT_ID}`));
    assert.equal(res.status, 404);
    assert.equal(currentFake.calls.some((c) => c.table === "appointments"), false);
    assert.equal(currentFake.calls.some((c) => c.table === "messages_sent"), false);
  });

  test("a client with zero appointments short-circuits to an empty list without ever querying messages_sent", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({ subscriptions: [ACTIVE_SUB], clients: [{ data: { id: CLIENT_ID } }], appointments: [{ data: [] }] });
    const res = await GET(req(`http://localhost/api/clients/messages?client_id=${CLIENT_ID}`));
    const data = await res.json();
    assert.deepEqual(data.messages, []);
    assert.equal(currentFake.calls.some((c) => c.table === "messages_sent"), false);
  });

  test("the client lookup, the appointment-id lookup, and the messages_sent query are all scoped by this exact session's workspace_id", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({
      subscriptions: [ACTIVE_SUB],
      clients: [{ data: { id: CLIENT_ID } }],
      appointments: [{ data: [{ id: "appt-a" }, { id: "appt-b" }] }],
      messages_sent: [{ data: [row()] }],
    });
    await GET(req(`http://localhost/api/clients/messages?client_id=${CLIENT_ID}`));
    const clientEq = currentFake.calls.filter((c) => c.table === "clients" && c.method === "eq");
    assert.ok(clientEq.some((c) => c.args[0] === "workspace_id" && c.args[1] === DEMO_WORKSPACE_ID));
    const apptEq = currentFake.calls.filter((c) => c.table === "appointments" && c.method === "eq");
    assert.ok(apptEq.some((c) => c.args[0] === "client_id" && c.args[1] === CLIENT_ID));
    assert.ok(apptEq.some((c) => c.args[0] === "workspace_id" && c.args[1] === DEMO_WORKSPACE_ID));
    const msgIn = currentFake.calls.find((c) => c.table === "messages_sent" && c.method === "in");
    assert.deepEqual(msgIn?.args, ["appointment_id", ["appt-a", "appt-b"]]);
    const msgEq = currentFake.calls.filter((c) => c.table === "messages_sent" && c.method === "eq");
    assert.ok(msgEq.some((c) => c.args[0] === "workspace_id" && c.args[1] === DEMO_WORKSPACE_ID));
  });

  // Same authorization policy as app/api/appointments/messages's own test of
  // this name -- see that file's comment. A tester session's workspaceId is
  // server-assigned and fixed to DEMO_WORKSPACE_ID; this route never reads a
  // workspace id from the request, so handing it a real workspace's
  // client_id still only ever queries "AND workspace_id = DEMO_WORKSPACE_ID",
  // which a real database can't match against a row that actually belongs
  // to REAL_WORKSPACE_ID.
  test("a tester (demo) session can never see a real workspace's client's messages, even when given that exact client_id -- the lookup itself is scoped to DEMO_WORKSPACE_ID, not the real one", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({ subscriptions: [ACTIVE_SUB], clients: [{ data: null }] });
    const res = await GET(req(`http://localhost/api/clients/messages?client_id=${CLIENT_ID}`));
    assert.equal(res.status, 404);
    const clientEq = currentFake.calls.filter((c) => c.table === "clients" && c.method === "eq");
    assert.ok(clientEq.some((c) => c.args[0] === "workspace_id" && c.args[1] === DEMO_WORKSPACE_ID));
    assert.ok(!clientEq.some((c) => c.args[0] === "workspace_id" && c.args[1] === REAL_WORKSPACE_ID), "a tester session must never scope by the real workspace id");
    assert.equal(currentFake.calls.some((c) => c.table === "appointments"), false);
    assert.equal(currentFake.calls.some((c) => c.table === "messages_sent"), false);
  });
});

describe("GET /api/clients/messages -- aggregation and content", () => {
  test("messages from different appointments of the same client are all included, each carrying its own appointment_id", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({
      subscriptions: [ACTIVE_SUB],
      clients: [{ data: { id: CLIENT_ID } }],
      appointments: [{ data: [{ id: "appt-a" }, { id: "appt-b" }] }],
      messages_sent: [{
        data: [
          row({ id: "m1", appointment_id: "appt-a", created_at: "2026-01-05T00:00:00Z" }),
          row({ id: "m2", appointment_id: "appt-b", created_at: "2026-01-01T00:00:00Z" }),
        ],
      }],
    });
    const res = await GET(req(`http://localhost/api/clients/messages?client_id=${CLIENT_ID}`));
    const data = await res.json();
    assert.equal(data.messages.length, 2);
    assert.deepEqual(data.messages.map((m: any) => m.appointmentId), ["appt-a", "appt-b"]);
  });

  test("an arbitrary string like 'unexpected-value' remains Unknown across the client-scoped route too, never Sent merely for being non-empty", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({
      subscriptions: [ACTIVE_SUB],
      clients: [{ data: { id: CLIENT_ID } }],
      appointments: [{ data: [{ id: "appt-a" }] }],
      messages_sent: [{ data: [row({ id: "m1", provider_id: "unexpected-value" })] }],
    });
    const res = await GET(req(`http://localhost/api/clients/messages?client_id=${CLIENT_ID}`));
    const data = await res.json();
    assert.deepEqual(data.messages[0].status, { code: "unknown", label: "Unknown" });
  });

  test("bounded pagination: hasMore true when more rows exist than the page size", async () => {
    sessionToReturn = TESTER_SESSION;
    resetFixtures({
      subscriptions: [ACTIVE_SUB],
      clients: [{ data: { id: CLIENT_ID } }],
      appointments: [{ data: [{ id: "appt-a" }] }],
      messages_sent: [{ data: [row({ id: "m1" }), row({ id: "m2" }), row({ id: "m3" })] }],
    });
    const res = await GET(req(`http://localhost/api/clients/messages?client_id=${CLIENT_ID}&limit=2`));
    const data = await res.json();
    assert.equal(data.messages.length, 2);
    assert.equal(data.hasMore, true);
  });
});
