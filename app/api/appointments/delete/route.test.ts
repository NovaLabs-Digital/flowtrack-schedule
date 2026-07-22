// Phase 5.4E3: route-level tests for app/api/appointments/delete/route.ts
// (POST only -- this file has no GET handler; despite the route name this
// is a soft-cancel, status="cancelled", not a DB delete). Proves
// requireCapability(session, "canMutateOperationalData") is correctly wired
// before body parsing, appointment/client reads, writes, notification
// construction, provider calls, and messages_sent inserts.
// @/lib/session, @/lib/supabaseAdmin, and @/lib/notify are mocked
// in-process; @/lib/entitlementServer is DELIBERATELY LEFT UNMOCKED -- the
// real requireCapability chain runs against a fake "subscriptions" table.
// The REAL lib/notify.ts constructs a Twilio client at module-load time and
// would throw without real credentials, so it must never be imported --
// this is the test-only import seam contemplated for notification-capable
// routes; no production behavior changes. No real Supabase/Stripe/Twilio/
// Resend/network call is reachable. Run with
// --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import {
  createFakeSupabaseAdmin,
  createFakeNotify,
  writeCalls,
  fakeSessionNamedExports,
  subscriptionRow,
  SUBSCRIPTION_RESTRICTED_BODY,
} from "../../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../../lib/testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});
let currentNotify = createFakeNotify({ from: (t: string) => currentFake.supabaseAdmin.from(t) });
let sessionToReturn: unknown = { role: "none" };

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});
mock.module("@/lib/notify", {
  namedExports: {
    // See app/api/appointments/update/route.test.ts for why this inert
    // placeholder is required (NotifyChannel is a type-only export the
    // route imports via a plain, non-`type` import).
    NotifyChannel: undefined,
    shouldSend: (...args: [string | undefined, "email" | "sms"]) => currentNotify.namedExports.shouldSend(...args),
    describeProviderError: (...args: [unknown]) => currentNotify.namedExports.describeProviderError(...args),
    recordMessageSent: (...args: [unknown]) => currentNotify.namedExports.recordMessageSent(...(args as [never])),
    sendEmail: (...args: [string, string, string, string]) => currentNotify.namedExports.sendEmail(...args),
    sendSms: (...args: [string, string, string]) => currentNotify.namedExports.sendSms(...args),
  },
});
mock.module("@/lib/session", { namedExports: fakeSessionNamedExports(async () => sessionToReturn) });

const { POST } = await import("./route.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
  currentNotify = createFakeNotify({ from: (t: string) => currentFake.supabaseAdmin.from(t) });
}
function req(body?: unknown, url = "http://localhost/api/appointments/delete") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID };

function existingAppt(overrides: Record<string, unknown> = {}) {
  return {
    id: "appt-1",
    client_id: "client-1",
    service_type: "Haircut",
    scheduled_for: "2026-08-03T14:00:00.000Z",
    status: "scheduled",
    series_id: null,
    is_demo: false,
    ...overrides,
  };
}
function optedInClient() {
  return { name: "Jane Doe", email: "jane@example.com", phone: "+15551234567", auto_email: true, auto_sms: true };
}

describe("POST /api/appointments/delete -- entitlement gate", () => {
  const FULL_STATES: Array<[string, ReturnType<typeof subscriptionRow>]> = [
    ["active", subscriptionRow({ stripe_status: "active" })],
    ["trialing", subscriptionRow({ stripe_status: "trialing" })],
    ["past_due_grace", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() + 1000).toISOString() })],
    ["internal", subscriptionRow({ billing_mode: "internal", stripe_status: null })],
  ];

  for (const [label, row] of FULL_STATES) {
    test(`${label} permits cancelling a single appointment, response unchanged`, async () => {
      resetFixtures({
        subscriptions: [{ data: row }],
        appointments: [{ data: existingAppt() }, { error: null }],
      });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ appointment_id: "appt-1", mode: "single" }));
      assert.equal(res.status, 200, label);
      assert.deepEqual(await res.json(), { ok: true, cancelled: 1 }, label);
      assert.equal(writeCalls(currentFake.calls).length, 1, label);
    });
  }

  test("exact trusted demo workspace permits cancelling with zero subscriptions-table queries (real short-circuit)", async () => {
    resetFixtures({
      appointments: [{ data: existingAppt({ is_demo: true }) }, { error: null }],
    });
    sessionToReturn = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };
    const res = await POST(req({ appointment_id: "appt-1", mode: "single" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, cancelled: 1 });
  });

  const RESTRICTED_STATES: Array<[string, ReturnType<typeof subscriptionRow> | null]> = [
    ["past_due_expired", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() - 1000).toISOString() })],
    ["canceled", subscriptionRow({ stripe_status: "canceled" })],
    ["unpaid", subscriptionRow({ stripe_status: "unpaid" })],
    ["no_subscription (no row)", null],
    ["malformed", subscriptionRow({ stripe_status: "not_a_real_status" })],
  ];

  for (const [label, row] of RESTRICTED_STATES) {
    test(`${label} returns the exact SUBSCRIPTION_RESTRICTED 403, zero reads/writes, zero provider calls`, async () => {
      resetFixtures({ subscriptions: [{ data: row }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ appointment_id: "appt-1", mode: "single", notify_channel: "both" }));
      assert.equal(res.status, 403, label);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY, label);
      assert.deepEqual(currentFake.calls.filter((c) => c.table !== "subscriptions"), [], label);
      assert.equal(currentNotify.emailCalls.length, 0, label);
      assert.equal(currentNotify.smsCalls.length, 0, label);
    });
  }

  test("query_error on the subscriptions read denies, zero reads/writes, zero provider calls", async () => {
    resetFixtures({ subscriptions: [{ error: { message: "simulated DB error" } }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", mode: "single", notify_channel: "both" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table !== "subscriptions"), []);
    assert.equal(currentNotify.emailCalls.length, 0);
  });

  test("non-owner/tester role (employee) retains the existing role-denial, never queries entitlement", async () => {
    resetFixtures({});
    sessionToReturn = { role: "employee", employeeId: "e1", workspaceId: REAL_WORKSPACE_ID };
    const res = await POST(req({ appointment_id: "appt-1", mode: "single" }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
    assert.equal(body.code, undefined);
    assert.equal(currentFake.calls.length, 0);
  });

  test("tester session with a non-demo workspace fails closed with the generic session-integrity denial, not SUBSCRIPTION_RESTRICTED", async () => {
    resetFixtures({});
    sessionToReturn = { role: "tester", workspaceId: REAL_WORKSPACE_ID };
    const res = await POST(req({ appointment_id: "appt-1", mode: "single" }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
    assert.equal(body.code, undefined);
  });

  test("unauthenticated (role: none) receives the existing role-denial and cannot probe subscription status", async () => {
    resetFixtures({});
    sessionToReturn = { role: "none" };
    const res = await POST(req({ appointment_id: "appt-1", mode: "single" }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
    assert.equal(body.code, undefined);
    assert.equal(currentFake.calls.length, 0);
  });

  test("a non-demo workspace cannot manufacture demo access via any request-supplied value", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", mode: "single", workspace_id: DEMO_WORKSPACE_ID }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  test("a spoofed workspace_id/query-string value does not change which workspace's entitlement is checked", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", mode: "single", workspace_id: "attacker-ws" }, "http://localhost/api/appointments/delete?workspace_id=attacker-ws-2"));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  describe("mutation-specific validation runs only after auth/role/entitlement", () => {
    test("missing appointment_id + unauthenticated -> the existing role-denial, not 400, zero Supabase calls", async () => {
      resetFixtures({});
      sessionToReturn = { role: "none" };
      const res = await POST(req({ mode: "single" }));
      assert.equal(res.status, 403);
      assert.equal(currentFake.calls.length, 0);
    });

    test("missing appointment_id + restricted workspace -> the exact SUBSCRIPTION_RESTRICTED 403, not 400", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ mode: "single" }));
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    });

    test("missing appointment_id + entitled workspace -> the existing 400 'Missing appointment_id' response", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ mode: "single" }));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Missing appointment_id" });
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments"), []);
    });

    test("invalid mode + entitled workspace -> the existing 400 response, after entitlement passes", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ appointment_id: "appt-1", mode: "bogus" }));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Invalid mode" });
    });
  });
});

describe("notification behavior is preserved exactly once entitled", () => {
  test("entitled + notify_channel requested + opted in -> existing provider send + messages_sent behavior occurs", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: existingAppt() }, { error: null }],
      clients: [{ data: optedInClient() }],
      messages_sent: [{ error: null }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", mode: "single", notify_channel: "both" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, cancelled: 1 });
    assert.equal(currentNotify.emailCalls.length, 1);
    assert.equal(currentNotify.smsCalls.length, 1);
    assert.equal(currentFake.calls.filter((c) => c.table === "messages_sent" && c.method === "insert").length, 2);
  });

  test("client opted out (auto_email/auto_sms false) -> notification remains suppressed, zero provider calls", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: existingAppt() }, { error: null }],
      clients: [{ data: { name: "Jane", email: "jane@example.com", phone: "+15551234567", auto_email: false, auto_sms: false } }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", mode: "single", notify_channel: "both" }));
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });

  test("notify_channel = 'none' (default) -> no client re-fetch, no provider calls", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: existingAppt() }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", mode: "single" }));
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentFake.calls.filter((c) => c.table === "clients").length, 0);
  });

  test("a demo appointment is never notified even when notify_channel is requested", async () => {
    resetFixtures({
      appointments: [{ data: existingAppt({ is_demo: true }) }, { error: null }],
    });
    sessionToReturn = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };
    const res = await POST(req({ appointment_id: "appt-1", mode: "single", notify_channel: "both" }));
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls.length, 0);
  });

  test("a provider failure on one channel is isolated -- the other channel still attempts, mutation still succeeds", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: existingAppt() }, { error: null }],
      clients: [{ data: optedInClient() }],
      messages_sent: [{ error: null }, { error: null }],
    });
    currentNotify.setSendEmailImpl(async () => {
      throw new Error("simulated Resend outage");
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", mode: "single", notify_channel: "both" }));
    assert.equal(res.status, 200, "the cancellation succeeds regardless of a provider failure");
    assert.deepEqual(await res.json(), { ok: true, cancelled: 1 });
    assert.equal(currentNotify.emailCalls.length, 1, "email was still attempted");
    assert.equal(currentNotify.smsCalls.length, 1, "sms still attempted despite the email failure");
  });
});

describe("existing cancellation business rules remain unchanged once entitled", () => {
  test("mode = 'future' with a series_id cancels every future occurrence in the series", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1" }) }, // fetch existing
        { error: null }, // hasColumn("series_id") probe
        { data: [{ id: "appt-1" }, { id: "appt-2" }, { id: "appt-3" }] }, // target ids query
        { error: null }, // bulk cancel
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", mode: "future" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, cancelled: 3 });
    assert.equal(writeCalls(currentFake.calls).length, 1); // one bulk update, not one per row
  });

  test("appointment not found still 404s with the existing message, after entitlement passes", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-missing", mode: "single" }));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Appointment not found" });
  });

  test("tester session accessing a non-demo appointment still 404s (existing tester-scoping rule)", async () => {
    resetFixtures({
      appointments: [{ data: existingAppt({ is_demo: false }) }],
    });
    sessionToReturn = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };
    const res = await POST(req({ appointment_id: "appt-1", mode: "single" }));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Appointment not found" });
  });
});
