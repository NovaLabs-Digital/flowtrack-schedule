// Phase 5.4G: route-level tests for app/api/appointments/cancel/route.ts
// (POST only, fully public/token-authenticated -- no session at all).
// Proves the cancellation mutation itself is NEVER gated by entitlement (a
// valid token always cancels its exact appointment, regardless of
// subscription state -- Phase 5.4F/5.4G policy decision), while the
// outbound email/SMS that follows a successful, non-demo cancellation is
// gated by requireCapabilityForWorkspace(workspaceId, "canSendNotifications"),
// using the workspace_id already read off the matched appointment row.
// @/lib/supabaseAdmin and @/lib/notify are mocked in-process;
// @/lib/entitlementServer is DELIBERATELY LEFT UNMOCKED -- the real
// requireCapabilityForWorkspace/fetchEntitlementForWorkspace/
// resolveWorkspaceEntitlement chain runs against a fake "subscriptions"
// table. The REAL lib/notify.ts constructs a Twilio client at module-load
// time and would throw without real credentials, so it must never be
// imported -- this is the same test-only import seam already used by every
// other notification-capable route's tests; no production behavior
// changes. No real Supabase/Stripe/Twilio/Resend/network call is
// reachable. Run with --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createFakeSupabaseAdmin, createFakeNotify, subscriptionRow } from "../../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../../lib/testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});
let currentNotify = createFakeNotify({ from: (t: string) => currentFake.supabaseAdmin.from(t) });

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});
mock.module("@/lib/notify", {
  namedExports: {
    shouldSend: (...args: [string | undefined, "email" | "sms"]) => currentNotify.namedExports.shouldSend(...args),
    describeProviderError: (...args: [unknown]) => currentNotify.namedExports.describeProviderError(...args),
    recordMessageSent: (...args: [unknown]) => currentNotify.namedExports.recordMessageSent(...(args as [never])),
    sendEmail: (...args: [string, string, string, string]) => currentNotify.namedExports.sendEmail(...args),
    sendSms: (...args: [string, string, string]) => currentNotify.namedExports.sendSms(...args),
  },
});

const { POST } = await import("./route.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
  currentNotify = createFakeNotify({ from: (t: string) => currentFake.supabaseAdmin.from(t) });
}
function req(body?: unknown) {
  return new Request("http://localhost/api/appointments/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function apptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "appt-1",
    status: "scheduled",
    client_id: "client-1",
    service_type: "Haircut",
    is_demo: false,
    workspace_id: REAL_WORKSPACE_ID,
    ...overrides,
  };
}
function optedInClient(overrides: Record<string, unknown> = {}) {
  return { name: "Jane Doe", email: "jane@example.com", phone: "+15551234567", auto_email: true, auto_sms: true, ...overrides };
}

describe("POST /api/appointments/cancel -- the cancellation mutation is never entitlement-gated", () => {
  test("missing token: unchanged 400, zero Supabase calls", async () => {
    resetFixtures({});
    const res = await POST(req({}));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Missing token" });
    assert.equal(currentFake.calls.length, 0);
  });

  test("invalid token: unchanged 404, zero entitlement query (cancellation never reached)", async () => {
    resetFixtures({ appointments: [{ data: null }] });
    const res = await POST(req({ token: "bad-token" }));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Invalid token" });
    assert.equal(currentFake.calls.filter((c) => c.table === "subscriptions").length, 0);
  });

  test("already-cancelled token: unchanged idempotent response, zero entitlement query", async () => {
    resetFixtures({ appointments: [{ data: apptRow({ status: "cancelled" }) }] });
    const res = await POST(req({ token: "tok" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, already: true });
    assert.equal(currentFake.calls.filter((c) => c.table === "subscriptions").length, 0);
  });

  const RESTRICTED_STATES: Array<[string, ReturnType<typeof subscriptionRow> | null]> = [
    ["past_due_expired", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() - 1000).toISOString() })],
    ["canceled", subscriptionRow({ stripe_status: "canceled" })],
    ["unpaid", subscriptionRow({ stripe_status: "unpaid" })],
    ["no_subscription (no row)", null],
    ["malformed", subscriptionRow({ stripe_status: "not_a_real_status" })],
  ];

  for (const [label, row] of RESTRICTED_STATES) {
    test(`${label}: the appointment still cancels, response unchanged, but zero notification/provider/audit work`, async () => {
      resetFixtures({
        subscriptions: [{ data: row }],
        appointments: [{ data: apptRow() }, { error: null }], // fetch, then the UPDATE
      });
      const res = await POST(req({ token: "tok" }));
      assert.equal(res.status, 200, label);
      assert.deepEqual(await res.json(), { ok: true }, label);
      assert.equal(currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update").length, 1, `${label}: the cancellation UPDATE still ran`);
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" || c.table === "messages_sent"), [], label);
      assert.equal(currentNotify.emailCalls.length, 0, label);
      assert.equal(currentNotify.smsCalls.length, 0, label);
    });
  }

  test("entitlement query_error: the appointment still cancels, zero notification/provider/audit work (fails closed)", async () => {
    resetFixtures({
      subscriptions: [{ error: { message: "simulated DB error" } }],
      appointments: [{ data: apptRow() }, { error: null }],
    });
    const res = await POST(req({ token: "tok" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update").length, 1);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" || c.table === "messages_sent"), []);
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });

  test("restricted response reveals no billing/entitlement/workspace detail -- body is exactly { ok: true }", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }],
      appointments: [{ data: apptRow() }, { error: null }],
    });
    const res = await POST(req({ token: "tok" }));
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ["ok"]);
  });
});

describe("POST /api/appointments/cancel -- notification gate (canSendNotifications)", () => {
  const FULL_STATES: Array<[string, ReturnType<typeof subscriptionRow>]> = [
    ["active", subscriptionRow({ stripe_status: "active" })],
    ["trialing", subscriptionRow({ stripe_status: "trialing" })],
    ["past_due_grace", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() + 1000).toISOString() })],
    ["internal", subscriptionRow({ billing_mode: "internal", stripe_status: null })],
  ];

  for (const [label, row] of FULL_STATES) {
    test(`${label} allows the cancellation notification, response unchanged`, async () => {
      resetFixtures({
        subscriptions: [{ data: row }],
        appointments: [{ data: apptRow() }, { error: null }],
        clients: [{ data: optedInClient() }],
        messages_sent: [{ error: null }, { error: null }],
      });
      const res = await POST(req({ token: "tok" }));
      assert.equal(res.status, 200, label);
      assert.deepEqual(await res.json(), { ok: true }, label);
      assert.equal(currentNotify.emailCalls.length, 1, label);
      assert.equal(currentNotify.smsCalls.length, 1, label);
      assert.equal(currentFake.calls.filter((c) => c.table === "messages_sent" && c.method === "insert").length, 2, label);
    });
  }

  test("is_demo = true: existing early-return suppression is unchanged -- entitlement is never even queried", async () => {
    resetFixtures({
      appointments: [{ data: apptRow({ is_demo: true }) }, { error: null }],
    });
    const res = await POST(req({ token: "tok" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(currentFake.calls.filter((c) => c.table === "subscriptions").length, 0, "demo suppression short-circuits before the notification gate");
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });

  test("exact trusted demo workspace resolves via the real short-circuit if ever reached (defense in depth; zero subscriptions queries)", async () => {
    // A row with workspace_id = DEMO_WORKSPACE_ID and is_demo = false cannot
    // occur through real appointment creation (every path that could create
    // such a row sets is_demo from the caller's own role), but this proves
    // the notification gate's demo resolution is structurally correct and
    // independent of the is_demo suppression above, not merely untested.
    resetFixtures({
      appointments: [{ data: apptRow({ workspace_id: DEMO_WORKSPACE_ID }) }, { error: null }],
      clients: [{ data: optedInClient() }],
      messages_sent: [{ error: null }, { error: null }],
    });
    const res = await POST(req({ token: "tok" }));
    assert.equal(res.status, 200);
    assert.equal(currentFake.calls.filter((c) => c.table === "subscriptions").length, 0);
  });

  test("client opted out of both channels (allowed workspace): still { ok: true }, zero provider calls", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: apptRow() }, { error: null }],
      clients: [{ data: optedInClient({ auto_email: false, auto_sms: false }) }],
    });
    const res = await POST(req({ token: "tok" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });

  test("a provider failure on one channel is isolated -- the other channel still attempts, response unchanged", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: apptRow() }, { error: null }],
      clients: [{ data: optedInClient() }],
      messages_sent: [{ error: null }, { error: null }],
    });
    currentNotify.setSendEmailImpl(async () => {
      throw new Error("simulated Resend outage");
    });
    const res = await POST(req({ token: "tok" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(currentNotify.emailCalls.length, 1, "email was still attempted");
    assert.equal(currentNotify.smsCalls.length, 1, "sms still attempted despite the email failure");
    assert.equal(currentFake.calls.filter((c) => c.table === "messages_sent" && c.method === "insert").length, 2, "both outcomes are still audited");
  });
});

describe("POST /api/appointments/cancel -- workspace identity cannot be spoofed", () => {
  test("a body-supplied workspace_id has no effect -- only the matched appointment's own workspace_id is checked", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }],
      appointments: [{ data: apptRow() }, { error: null }],
    });
    const res = await POST(req({ token: "tok", workspace_id: DEMO_WORKSPACE_ID }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(currentFake.calls.filter((c) => c.table === "subscriptions" && c.method === "maybeSingle").length, 1, "the real appointment workspace was checked, not the spoofed one");
    assert.equal(currentNotify.emailCalls.length, 0);
  });

  test("an arbitrary request header cannot select or unlock a different workspace", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }],
      appointments: [{ data: apptRow() }, { error: null }],
    });
    const res = await POST(
      new Request("http://localhost/api/appointments/cancel", {
        method: "POST",
        headers: { "content-type": "application/json", "x-workspace-id": DEMO_WORKSPACE_ID },
        body: JSON.stringify({ token: "tok" }),
      })
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(currentNotify.emailCalls.length, 0);
  });
});

describe("the notification gate is source-correctly placed and scoped (source-level proof)", () => {
  const routeSource = fs.readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

  test("calls requireCapabilityForWorkspace(workspaceId, \"canSendNotifications\") -- never canMutateOperationalData, never requireCapability with a session", () => {
    assert.ok(routeSource.includes('requireCapabilityForWorkspace(workspaceId, "canSendNotifications")'));
    assert.ok(!routeSource.includes("canMutateOperationalData"));
    assert.ok(!routeSource.includes("requireCapability(session"));
  });

  test("the gate runs after the cancellation UPDATE, never before it", () => {
    const updateIndex = routeSource.indexOf('.update({ status: "cancelled" })');
    const gateIndex = routeSource.indexOf("requireCapabilityForWorkspace(workspaceId");
    assert.ok(updateIndex > -1 && gateIndex > -1 && updateIndex < gateIndex);
  });

  test("the gate runs before the client (PII) read used only for notifications", () => {
    const gateIndex = routeSource.indexOf("requireCapabilityForWorkspace(workspaceId");
    const clientReadIndex = routeSource.indexOf('.from("clients")');
    assert.ok(gateIndex > -1 && clientReadIndex > -1 && gateIndex < clientReadIndex);
  });

  test("workspaceId is declared from the matched appointment row, never from request input", () => {
    assert.ok(routeSource.includes("const workspaceId = apptRes.data.workspace_id;"));
  });
});
