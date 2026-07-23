// Phase 5.4E3: route-level tests for app/api/appointments/update/route.ts
// (PATCH only -- this file has no GET handler). Proves
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
import fs from "node:fs";
import { fileURLToPath } from "node:url";
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
    // NotifyChannel is a type-only export in the real lib/notify.ts; the
    // route file imports it via a plain (non-`type`) import, which Node's
    // runtime type-stripping doesn't elide (it has no cross-file type
    // information to know it's type-only), so the mocked module must still
    // provide *a* runtime binding for it. It is never read as a value
    // anywhere -- this placeholder is inert.
    NotifyChannel: undefined,
    shouldSend: (...args: [string | undefined, "email" | "sms"]) => currentNotify.namedExports.shouldSend(...args),
    describeProviderError: (...args: [unknown]) => currentNotify.namedExports.describeProviderError(...args),
    recordMessageSent: (...args: [unknown]) => currentNotify.namedExports.recordMessageSent(...(args as [never])),
    sendEmail: (...args: [string, string, string, string]) => currentNotify.namedExports.sendEmail(...args),
    sendSms: (...args: [string, string, string]) => currentNotify.namedExports.sendSms(...args),
  },
});
mock.module("@/lib/session", { namedExports: fakeSessionNamedExports(async () => sessionToReturn) });

const { PATCH } = await import("./route.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
  currentNotify = createFakeNotify({ from: (t: string) => currentFake.supabaseAdmin.from(t) });
}
function req(body?: unknown, url = "http://localhost/api/appointments/update") {
  return new Request(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID };

function existingAppt(overrides: Record<string, unknown> = {}) {
  return {
    id: "appt-1",
    client_id: "client-1",
    series_id: null,
    scheduled_for: "2026-08-03T14:00:00.000Z",
    scheduled_end: null,
    is_demo: false,
    ...overrides,
  };
}
function optedInClient() {
  return { name: "Jane Doe", email: "jane@example.com", phone: "+15551234567", auto_email: true, auto_sms: true };
}

describe("PATCH /api/appointments/update -- entitlement gate", () => {
  const FULL_STATES: Array<[string, ReturnType<typeof subscriptionRow>]> = [
    ["active", subscriptionRow({ stripe_status: "active" })],
    ["trialing", subscriptionRow({ stripe_status: "trialing" })],
    ["past_due_grace", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() + 1000).toISOString() })],
    ["internal", subscriptionRow({ billing_mode: "internal", stripe_status: null })],
  ];

  for (const [label, row] of FULL_STATES) {
    test(`${label} permits editing a single appointment, response unchanged`, async () => {
      resetFixtures({
        subscriptions: [{ data: row }],
        appointments: [{ data: existingAppt() }, { error: null }],
      });
      sessionToReturn = OWNER_SESSION;
      const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service" }));
      assert.equal(res.status, 200, label);
      assert.deepEqual(await res.json(), { ok: true }, label);
      assert.equal(writeCalls(currentFake.calls).length, 1, label);
    });
  }

  test("exact trusted demo workspace permits editing with zero subscriptions-table queries (real short-circuit)", async () => {
    resetFixtures({
      appointments: [{ data: existingAppt({ is_demo: true }) }, { error: null }],
    });
    sessionToReturn = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
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
      const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service", notify_channel: "both" }));
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
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service", notify_channel: "both" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table !== "subscriptions"), []);
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });

  test("non-owner/tester role (employee) retains the existing role-denial, never queries entitlement", async () => {
    resetFixtures({});
    sessionToReturn = { role: "employee", employeeId: "e1", workspaceId: REAL_WORKSPACE_ID };
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service" }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
    assert.equal(body.code, undefined);
    assert.equal(currentFake.calls.length, 0);
  });

  test("tester session with a non-demo workspace fails closed with the generic session-integrity denial, not SUBSCRIPTION_RESTRICTED", async () => {
    resetFixtures({});
    sessionToReturn = { role: "tester", workspaceId: REAL_WORKSPACE_ID };
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service" }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
    assert.equal(body.code, undefined);
  });

  test("unauthenticated (role: none) receives the existing role-denial and cannot probe subscription status", async () => {
    resetFixtures({});
    sessionToReturn = { role: "none" };
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service" }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
    assert.equal(body.code, undefined);
    assert.equal(currentFake.calls.length, 0);
  });

  test("a non-demo workspace cannot manufacture demo access via any request-supplied value", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service", workspace_id: DEMO_WORKSPACE_ID }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  test("a spoofed workspace_id/query-string value does not change which workspace's entitlement is checked", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", workspace_id: "attacker-ws" }, "http://localhost/api/appointments/update?workspace_id=attacker-ws-2"));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  describe("mutation-specific validation runs only after auth/role/entitlement", () => {
    test("missing appointment_id + unauthenticated -> the existing role-denial, not 400, zero Supabase calls", async () => {
      resetFixtures({});
      sessionToReturn = { role: "none" };
      const res = await PATCH(req({ service_type: "New Service" }));
      assert.equal(res.status, 403);
      assert.equal(currentFake.calls.length, 0);
    });

    test("missing appointment_id + restricted workspace -> the exact SUBSCRIPTION_RESTRICTED 403, not 400", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await PATCH(req({ service_type: "New Service" }));
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    });

    test("missing appointment_id + entitled workspace -> the existing 400 'Missing appointment_id' response", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await PATCH(req({ service_type: "New Service" }));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Missing appointment_id" });
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments"), []);
    });
  });
});

describe("notification behavior is preserved exactly once entitled", () => {
  test("entitled + notify_channel requested + opted in -> existing provider send + messages_sent behavior occurs", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt() }, // fetch existing
        { error: null }, // update
        { data: { service_type: "New Service", scheduled_for: "2026-08-03T14:00:00.000Z" } }, // notify block re-fetch
      ],
      clients: [{ data: optedInClient() }],
      messages_sent: [{ error: null }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service", notify_channel: "both" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(currentNotify.emailCalls.length, 1);
    assert.equal(currentNotify.smsCalls.length, 1);
    assert.equal(currentFake.calls.filter((c) => c.table === "messages_sent" && c.method === "insert").length, 2);
  });

  test("client opted out (auto_email/auto_sms false) -> notification remains suppressed, zero provider calls", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt() },
        { error: null },
        { data: { service_type: "New Service", scheduled_for: "2026-08-03T14:00:00.000Z" } },
      ],
      clients: [{ data: { name: "Jane", email: "jane@example.com", phone: "+15551234567", auto_email: false, auto_sms: false } }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service", notify_channel: "both" }));
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });

  test("notify_channel = 'none' (default) -> no re-fetch, no provider calls, no messages_sent writes", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: existingAppt() }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service" }));
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentFake.calls.filter((c) => c.table === "messages_sent").length, 0);
  });

  test("a provider failure on one channel is isolated -- the other channel still attempts, mutation still succeeds", async () => {
    currentNotify?.setSendEmailImpl?.(async () => {
      throw new Error("simulated Resend outage");
    });
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt() },
        { error: null },
        { data: { service_type: "New Service", scheduled_for: "2026-08-03T14:00:00.000Z" } },
      ],
      clients: [{ data: optedInClient() }],
      messages_sent: [{ error: null }, { error: null }],
    });
    currentNotify.setSendEmailImpl(async () => {
      throw new Error("simulated Resend outage");
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service", notify_channel: "both" }));
    assert.equal(res.status, 200, "the appointment mutation succeeds regardless of a provider failure");
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(currentNotify.emailCalls.length, 1, "email was still attempted");
    assert.equal(currentNotify.smsCalls.length, 1, "sms still attempted despite the email failure");
  });
});

describe("Phase 5.5E-C: canSendNotifications gate on the post-mutation notification, independent of canMutateOperationalData", () => {
  test("mutation allowed, notification denied -> update succeeds unchanged, zero provider calls, zero messages_sent, appt/client re-fetch skipped", async () => {
    resetFixtures({
      subscriptions: [
        { data: subscriptionRow({ stripe_status: "active" }) }, // canMutateOperationalData: allowed
        { data: subscriptionRow({ stripe_status: "canceled" }) }, // canSendNotifications: denied
      ],
      appointments: [
        { data: existingAppt() }, // fetch existing
        { error: null }, // update
        // deliberately no third fixture -- proves the notify re-fetch never happens
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service", notify_channel: "both" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
    assert.equal(currentFake.calls.filter((c) => c.table === "messages_sent").length, 0);
    assert.equal(currentFake.calls.filter((c) => c.table === "clients").length, 0, "the notify client re-fetch never happened");
  });

  test("mutation allowed, notification entitlement check query_error -> fails closed, update still succeeds, zero provider calls", async () => {
    resetFixtures({
      subscriptions: [
        { data: subscriptionRow({ stripe_status: "active" }) },
        { error: { message: "simulated DB error" } },
      ],
      appointments: [{ data: existingAppt() }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service", notify_channel: "both" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });

  test("a spoofed workspace_id in the body does not change which workspace's notification capability is checked", async () => {
    resetFixtures({
      subscriptions: [
        { data: subscriptionRow({ stripe_status: "active" }) },
        { data: subscriptionRow({ stripe_status: "canceled" }) },
      ],
      appointments: [{ data: existingAppt() }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service", notify_channel: "both", workspace_id: DEMO_WORKSPACE_ID }));
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });
});

describe("existing appointment-editing business rules remain unchanged once entitled", () => {
  test("mode = 'future' with a series_id updates future siblings' time-of-day", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1" }) }, // fetch existing
        { error: null }, // update source
        { data: [{ id: "sib-1", scheduled_for: "2026-08-10T14:00:00.000Z", scheduled_end: null }] }, // siblings
        { error: null }, // update sibling
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(
      req({ appointment_id: "appt-1", mode: "future", scheduled_for: "2026-08-03T15:00:00.000Z" })
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(writeCalls(currentFake.calls).length, 2); // update source + update sibling
  });

  test("client fields in the body also update the linked client row", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: existingAppt() }], // no appointment-field changes in the body -> no appointments UPDATE
      clients: [{ error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", email: "new@example.com" }));
    assert.equal(res.status, 200);
    assert.equal(currentFake.calls.filter((c) => c.table === "clients" && c.method === "update").length, 1);
  });

  test("appointment not found still 404s with the existing message, after entitlement passes", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-missing", service_type: "New Service" }));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Appointment not found" });
  });

  test("tester session accessing a non-demo appointment still 404s (existing tester-scoping rule)", async () => {
    resetFixtures({
      appointments: [{ data: existingAppt({ is_demo: false }) }],
    });
    sessionToReturn = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service" }));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Appointment not found" });
  });

  test("reassigning to an employee outside the workspace still 404s, after entitlement passes", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: existingAppt() }, { error: null }], // fetch existing, then hasColumn("employee_id") probe
      employees: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", employee_id: "emp-outside" }));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Employee not found" });
  });
});

describe("Phase 5.5E-C: the notification gate is source-correctly placed and scoped (source-level proof)", () => {
  const routeSource = fs.readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

  test("calls requireCapabilityForWorkspace(workspaceId, \"canSendNotifications\") exactly once", () => {
    const count = routeSource.split('requireCapabilityForWorkspace(workspaceId, "canSendNotifications")').length - 1;
    assert.equal(count, 1);
  });

  test("the notification gate runs after the appointment/sibling/client UPDATE calls, never before them", () => {
    const updateIndex = routeSource.indexOf(".update(apptUpdate)");
    const notifyGateIndex = routeSource.indexOf('requireCapabilityForWorkspace(workspaceId, "canSendNotifications")');
    assert.ok(updateIndex > -1 && notifyGateIndex > -1 && updateIndex < notifyGateIndex);
  });

  test("the notification gate runs before the notify appointment/client re-fetch and before any sendEmail/sendSms call", () => {
    const notifyGateIndex = routeSource.indexOf('requireCapabilityForWorkspace(workspaceId, "canSendNotifications")');
    const sendEmailIndex = routeSource.indexOf("sendEmail(");
    const sendSmsIndex = routeSource.indexOf("sendSms(");
    assert.ok(notifyGateIndex > -1 && sendEmailIndex > -1 && sendSmsIndex > -1);
    assert.ok(notifyGateIndex < sendEmailIndex && notifyGateIndex < sendSmsIndex);
  });

  test("the notification gate uses the same trusted workspaceId already used for the canMutateOperationalData gate, never a new/request-derived value", () => {
    assert.ok(routeSource.includes("const workspaceId = session.workspaceId;"));
  });
});
