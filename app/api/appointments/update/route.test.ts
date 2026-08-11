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
  SERVICE_UNAVAILABLE_BODY,
} from "../../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../../lib/testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});
let currentNotify = createFakeNotify({ from: (t: string) => currentFake.supabaseAdmin.from(t) });
let sessionToReturn: unknown = { role: "none" };

mock.module("@/lib/supabaseAdmin", {
  namedExports: {
    supabaseAdmin: {
      from: (table: string) => currentFake.supabaseAdmin.from(table),
      rpc: (fn: string, args?: unknown) => currentFake.supabaseAdmin.rpc(fn, args),
    },
  },
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
    sanitizeCompanyName: (...args: [string | null | undefined]) => currentNotify.namedExports.sanitizeCompanyName(...args),
    getCompanyName: (...args: [string]) => currentNotify.namedExports.getCompanyName(...args),
    getCompanyIdentity: (...args: [string]) => currentNotify.namedExports.getCompanyIdentity(...args),
    sendEmail: (...args: [string, string, string, string, string?]) => currentNotify.namedExports.sendEmail(...args),
    sendSms: (...args: [string, string, string]) => currentNotify.namedExports.sendSms(...args),
  },
});
mock.module("@/lib/session", { namedExports: fakeSessionNamedExports(async () => sessionToReturn) });

const { PATCH } = await import("./route.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>, rpcResponses: Record<string, FakeSupabaseFixture[]> = {}) {
  currentFake = createFakeSupabaseAdmin(responses, rpcResponses);
  currentNotify = createFakeNotify({ from: (t: string) => currentFake.supabaseAdmin.from(t) });
}
function req(body?: unknown, url = "http://localhost/api/appointments/update") {
  return new Request(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const OWNER_AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";
const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID, authUserId: OWNER_AUTH_USER_ID, sessionEpoch: 1 };

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
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
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
      resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: row }] });
      sessionToReturn = OWNER_SESSION;
      const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service", notify_channel: "both" }));
      assert.equal(res.status, 403, label);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY, label);
      assert.deepEqual(currentFake.calls.filter((c) => c.table !== "subscriptions" && c.table !== "workspace_memberships"), [], label);
      assert.equal(currentNotify.emailCalls.length, 0, label);
      assert.equal(currentNotify.smsCalls.length, 0, label);
    });
  }

  test("query_error on the subscriptions read denies, zero reads/writes, zero provider calls", async () => {
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ error: { message: "simulated DB error" } }] });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service", notify_channel: "both" }));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), SERVICE_UNAVAILABLE_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table !== "subscriptions" && c.table !== "workspace_memberships"), []);
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
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service", workspace_id: DEMO_WORKSPACE_ID }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  test("a spoofed workspace_id/query-string value does not change which workspace's entitlement is checked", async () => {
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
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
      resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await PATCH(req({ service_type: "New Service" }));
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    });

    test("missing appointment_id + entitled workspace -> the existing 400 'Missing appointment_id' response", async () => {
      resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
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
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
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
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
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
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
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
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
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

describe("update/reschedule notifications identify the workspace's own business", () => {
  test("update email uses the workspace's company name as the From display name and sign-off", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt() },
        { error: null },
        { data: { service_type: "New Service", scheduled_for: "2026-08-03T14:00:00.000Z" } },
      ],
      clients: [{ data: optedInClient() }],
      messages_sent: [{ error: null }, { error: null }],
    });
    currentNotify.setCompanyName("Sunshine Cleaning Co.");
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service", notify_channel: "both" }));
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls[0].fromDisplayName, "Sunshine Cleaning Co.");
    assert.ok(currentNotify.emailCalls[0].text.includes("Sunshine Cleaning Co."));
    assert.ok(!currentNotify.emailCalls[0].text.includes("ScheduleFlowTrack"));
  });

  test("update SMS body identifies the business by name", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt() },
        { error: null },
        { data: { service_type: "New Service", scheduled_for: "2026-08-03T14:00:00.000Z" } },
      ],
      clients: [{ data: optedInClient() }],
      messages_sent: [{ error: null }, { error: null }],
    });
    currentNotify.setCompanyName("Sunshine Cleaning Co.");
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service", notify_channel: "both" }));
    assert.equal(res.status, 200);
    const body = currentNotify.smsCalls[0].body;
    assert.ok(body.startsWith("Sunshine Cleaning Co.:"));
    assert.equal(body.split("Sunshine Cleaning Co.").length - 1, 1, "the business name must appear exactly once -- no duplicate trailing sign-off");
    assert.ok(!body.includes("Thank you,"), "the trailing sign-off line was removed for SMS specifically (kept for email)");
  });

  test("Phase 5E: update email/SMS format the appointment time in the workspace's own resolved timezone, not a hardcoded Eastern default", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt() },
        { error: null },
        // 2026-08-03T14:00:00.000Z -- 10:00 AM Eastern, 7:00 AM Pacific.
        { data: { service_type: "New Service", scheduled_for: "2026-08-03T14:00:00.000Z" } },
      ],
      clients: [{ data: optedInClient() }],
      messages_sent: [{ error: null }, { error: null }],
    });
    currentNotify.setTimezone("America/Los_Angeles");
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "New Service", notify_channel: "both" }));
    assert.equal(res.status, 200);
    assert.ok(currentNotify.emailCalls[0].text.includes("7:00 AM"), currentNotify.emailCalls[0].text);
    assert.ok(!currentNotify.emailCalls[0].text.includes("10:00 AM"));
    assert.ok(currentNotify.smsCalls[0].body.includes("7:00 AM"));
  });
});

describe("Phase 5.5E-C: canSendNotifications gate on the post-mutation notification, independent of canMutateOperationalData", () => {
  test("mutation allowed, notification denied -> update succeeds unchanged, zero provider calls, zero messages_sent, appt/client re-fetch skipped", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
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
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
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
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
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
  test("mode = 'future' with a series_id updates future siblings' start time", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1" }) }, // fetch existing
        { error: null }, // update source
        { data: [{ id: "sib-1", scheduled_for: "2026-08-10T14:00:00.000Z", scheduled_end: null }] }, // siblings
        { error: null }, // update sibling
      ],
      // Block 2B safety correction: quarantineIfObservedActive explicitly
      // observes the series' current status first (a read, not a write) --
      // data: null means the series was never registered at all, so it's
      // conclusively "not active" without ever attempting a compare-and-set
      // write, a harmless no-op that skips the reactivation block entirely.
      // Dedicated reactivation-chain coverage lives in its own describe
      // block below.
      recurring_series: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(
      req({ appointment_id: "appt-1", mode: "future", scheduled_for: "2026-08-03T15:00:00.000Z" })
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(writeCalls(currentFake.calls).length, 2); // update source + update sibling -- no quarantine write attempted since it was observed not active
  });

  test("client fields in the body also update the linked client row", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
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
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
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

  test("assigning an employee outside the workspace still 404s, after entitlement passes", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: existingAppt() }], // fetch existing only -- employee validation runs before any write
      employees: [{ data: [] }], // "emp-outside" not found in this workspace
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", employee_ids: ["emp-outside"] }));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "One or more assigned employees were not found." });
  });
});

// Jennifer Gerry bug: an every-4-weeks Thursday series moved with "This &
// future" left every future occurrence stuck on Thursday. Root cause: the
// old sibling-shift logic only compared hour/minute-of-day between the old
// and new selected start, so a pure calendar-date change (Thursday ->
// Wednesday, same clock time) had a zero hour/minute delta and never
// propagated -- future siblings' scheduled_for was left completely
// untouched. The fix computes a full timestamp delta (old start -> new
// start) and adds it to each future sibling's own stored scheduled_for/
// scheduled_end, which is delta-based rather than recomputed from
// frequency_type/repeat_weeks, so it works identically for daily, weekly,
// every-N-weeks, and (Phase 2) monthly series alike, and preserves the
// original spacing between occurrences exactly -- see the source-level
// proof below confirming this route never reads frequency_type,
// repeat_weeks, or repeat_months at all, so monthly recurrence required
// zero changes here.
describe("recurring 'This & future' rescheduling shifts every future occurrence by the same date/time delta", () => {
  const OLD_SELECTED_START = "2026-08-06T14:00:00.000Z"; // Thursday
  const OLD_SELECTED_END = "2026-08-06T15:00:00.000Z";
  const NEW_SELECTED_START = "2026-08-05T14:00:00.000Z"; // Wednesday, same clock time -- delta is -1 day, zero hours/minutes
  const NEW_SELECTED_END = "2026-08-05T15:00:00.000Z";

  const SIB1_OLD_START = "2026-09-03T14:00:00.000Z"; // +28 days
  const SIB1_OLD_END = "2026-09-03T15:00:00.000Z";
  const SIB2_OLD_START = "2026-10-01T14:00:00.000Z"; // +28 more days
  const SIB2_OLD_END = "2026-10-01T15:00:00.000Z";

  const SIB1_NEW_START = "2026-09-02T14:00:00.000Z"; // -1 day
  const SIB1_NEW_END = "2026-09-02T15:00:00.000Z";
  const SIB2_NEW_START = "2026-09-30T14:00:00.000Z"; // -1 day
  const SIB2_NEW_END = "2026-09-30T15:00:00.000Z";

  test("1/2. selected + every future occurrence moves Thursday -> Wednesday, and the four-week spacing between them is unchanged", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1", scheduled_for: OLD_SELECTED_START, scheduled_end: OLD_SELECTED_END }) }, // fetch existing
        { error: null }, // hasColumn("scheduled_end")
        { error: null }, // update source (cutoff)
        {
          data: [
            { id: "sib-1", scheduled_for: SIB1_OLD_START, scheduled_end: SIB1_OLD_END },
            { id: "sib-2", scheduled_for: SIB2_OLD_START, scheduled_end: SIB2_OLD_END },
          ],
        }, // siblings
        { error: null }, // update sib-1
        { error: null }, // update sib-2
      ],
      recurring_series: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(
      req({ appointment_id: "appt-1", mode: "future", scheduled_for: NEW_SELECTED_START, scheduled_end: NEW_SELECTED_END })
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    const updates = currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update");
    assert.equal(updates.length, 3, "cutoff + 2 siblings");

    // Cutoff (selected) occurrence itself moved to the new Wednesday date.
    assert.deepEqual(updates[0].args[0], { scheduled_for: NEW_SELECTED_START, scheduled_end: NEW_SELECTED_END });

    // Both future siblings shifted by the identical -1 day delta.
    assert.deepEqual(updates[1].args[0], { scheduled_for: SIB1_NEW_START, scheduled_end: SIB1_NEW_END });
    assert.deepEqual(updates[2].args[0], { scheduled_for: SIB2_NEW_START, scheduled_end: SIB2_NEW_END });

    // Four-week spacing between the two shifted siblings is preserved exactly.
    const spacingMs = new Date(SIB2_NEW_START).getTime() - new Date(SIB1_NEW_START).getTime();
    assert.equal(spacingMs, 28 * 24 * 60 * 60 * 1000);
  });

  test("3. 'Only this appointment' (mode: single) moves only the selected occurrence -- no sibling query at all", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1", scheduled_for: OLD_SELECTED_START }) }, // fetch existing
        { error: null }, // update source only
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(
      req({ appointment_id: "appt-1", mode: "single", scheduled_for: NEW_SELECTED_START })
    );
    assert.equal(res.status, 200);
    assert.equal(currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update").length, 1);
    assert.equal(currentFake.calls.filter((c) => c.method === "gt").length, 0, "no future-siblings query is issued for mode: single");
  });

  test("4. past occurrences are structurally excluded -- the siblings query's gt() cutoff is the pre-update selected start", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1", scheduled_for: OLD_SELECTED_START }) },
        { error: null }, // update source
        { data: [] }, // no future siblings
      ],
      recurring_series: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({ appointment_id: "appt-1", mode: "future", scheduled_for: NEW_SELECTED_START }));
    const gtCall = currentFake.calls.find((c) => c.method === "gt");
    assert.deepEqual(gtCall?.args, ["scheduled_for", OLD_SELECTED_START]);
  });

  test("5. the cutoff (selected) occurrence itself is always included, via the primary update, independent of the siblings loop", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1", scheduled_for: OLD_SELECTED_START }) },
        { error: null }, // update source
        { data: [] }, // no future siblings -- proves the cutoff update doesn't depend on any sibling existing
      ],
      recurring_series: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "future", scheduled_for: NEW_SELECTED_START }));
    assert.equal(res.status, 200);
    const updates = currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update");
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].args[0], { scheduled_for: NEW_SELECTED_START });
  });

  test("6. future occurrences from another recurring series are unaffected -- the siblings query is scoped to this exact series_id", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1", scheduled_for: OLD_SELECTED_START }) },
        { error: null },
        { data: [] },
      ],
      recurring_series: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({ appointment_id: "appt-1", mode: "future", scheduled_for: NEW_SELECTED_START }));
    const seriesEq = currentFake.calls.find((c) => c.method === "eq" && c.args[0] === "series_id");
    assert.deepEqual(seriesEq?.args, ["series_id", "series-1"]);
  });

  test("7. another workspace's appointments are unaffected -- workspace_id is scoped on the siblings query and every sibling update", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1", scheduled_for: OLD_SELECTED_START }) },
        { error: null },
        { data: [{ id: "sib-1", scheduled_for: SIB1_OLD_START, scheduled_end: null }] },
        { error: null },
      ],
      recurring_series: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({ appointment_id: "appt-1", mode: "future", scheduled_for: NEW_SELECTED_START }));
    const workspaceEqCalls = currentFake.calls.filter(
      (c) => c.table === "appointments" && c.method === "eq" && c.args[0] === "workspace_id"
    );
    // fetch existing, update source, siblings select, update sibling -- exactly four, all scoped
    assert.equal(workspaceEqCalls.length, 4);
    assert.ok(workspaceEqCalls.every((c) => c.args[1] === REAL_WORKSPACE_ID));
  });

  test("8a. a pure time-of-day change (no date shift) still shifts every future sibling's start and end by the same delta", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1", scheduled_for: "2026-08-06T14:00:00.000Z", scheduled_end: "2026-08-06T15:00:00.000Z" }) },
        { error: null }, // hasColumn(scheduled_end)
        { error: null }, // update source
        { data: [{ id: "sib-1", scheduled_for: "2026-08-13T14:00:00.000Z", scheduled_end: "2026-08-13T15:00:00.000Z" }] },
        { error: null },
      ],
      recurring_series: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({
      appointment_id: "appt-1", mode: "future",
      scheduled_for: "2026-08-06T15:00:00.000Z", scheduled_end: "2026-08-06T16:00:00.000Z", // same day, +1 hour
    }));
    const sibUpdate = currentFake.calls.find(
      (c) => c.table === "appointments" && c.method === "update"
        && (c.args[0] as { scheduled_for?: string }).scheduled_for === "2026-08-13T15:00:00.000Z"
    );
    assert.ok(sibUpdate, "sibling shifted +1 hour");
    assert.equal((sibUpdate!.args[0] as { scheduled_end?: string }).scheduled_end, "2026-08-13T16:00:00.000Z");
  });

  test("8b. a duration-only change (start unchanged, end extended) shifts only scheduled_end on future siblings, never scheduled_for", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1", scheduled_for: "2026-08-06T14:00:00.000Z", scheduled_end: "2026-08-06T15:00:00.000Z" }) },
        { error: null }, // hasColumn(scheduled_end)
        { error: null }, // update source
        { data: [{ id: "sib-1", scheduled_for: "2026-08-13T14:00:00.000Z", scheduled_end: "2026-08-13T15:00:00.000Z" }] },
        { error: null },
      ],
      recurring_series: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({
      appointment_id: "appt-1", mode: "future",
      scheduled_for: "2026-08-06T14:00:00.000Z", scheduled_end: "2026-08-06T15:30:00.000Z", // same start, +30 min duration
    }));
    const sibUpdate = currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update")[1];
    assert.deepEqual(sibUpdate.args[0], { scheduled_end: "2026-08-13T15:30:00.000Z" });
  });

  test("9. cancelled/deleted exceptions are never recreated -- the siblings query is scoped to status: 'scheduled' and no row is ever inserted", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1", scheduled_for: OLD_SELECTED_START }) },
        { error: null },
        { data: [{ id: "sib-1", scheduled_for: SIB1_OLD_START, scheduled_end: null }] },
        { error: null },
      ],
      recurring_series: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({ appointment_id: "appt-1", mode: "future", scheduled_for: NEW_SELECTED_START }));
    const statusEq = currentFake.calls.find((c) => c.table === "appointments" && c.method === "eq" && c.args[0] === "status");
    assert.deepEqual(statusEq?.args, ["status", "scheduled"]);
    assert.equal(currentFake.calls.filter((c) => c.method === "insert").length, 0);
  });

  test("10. notifications are sent exactly once per channel, never once per shifted sibling", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [
        { data: subscriptionRow({ stripe_status: "active" }) }, // canMutateOperationalData
        { data: subscriptionRow({ stripe_status: "active" }) }, // canSendNotifications
      ],
      appointments: [
        { data: existingAppt({ series_id: "series-1", scheduled_for: OLD_SELECTED_START }) },
        { error: null }, // update source
        {
          data: [
            { id: "sib-1", scheduled_for: SIB1_OLD_START, scheduled_end: null },
            { id: "sib-2", scheduled_for: SIB2_OLD_START, scheduled_end: null },
          ],
        },
        { error: null }, // update sib-1
        { error: null }, // update sib-2
        { data: { service_type: "Haircut", scheduled_for: NEW_SELECTED_START } }, // notify re-fetch
      ],
      clients: [{ data: optedInClient() }],
      messages_sent: [{ error: null }, { error: null }],
      recurring_series: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({
      appointment_id: "appt-1", mode: "future", scheduled_for: NEW_SELECTED_START, notify_channel: "both",
    }));
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls.length, 1);
    assert.equal(currentNotify.smsCalls.length, 1);
    assert.equal(currentFake.calls.filter((c) => c.table === "messages_sent" && c.method === "insert").length, 2);
  });

  test("11a. edit-modal payload shape (scheduled_for + scheduled_end always both present) shifts siblings correctly", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1", scheduled_for: OLD_SELECTED_START, scheduled_end: OLD_SELECTED_END }) },
        { error: null }, // hasColumn(scheduled_end)
        { error: null }, // update source
        { data: [{ id: "sib-1", scheduled_for: SIB1_OLD_START, scheduled_end: SIB1_OLD_END }] },
        { error: null },
      ],
      recurring_series: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({
      appointment_id: "appt-1", mode: "future",
      scheduled_for: NEW_SELECTED_START, scheduled_end: NEW_SELECTED_END, // AppointmentModal always sends both
    }));
    const sibUpdate = currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update")[1];
    assert.deepEqual(sibUpdate.args[0], { scheduled_for: SIB1_NEW_START, scheduled_end: SIB1_NEW_END });
  });

  test("11b. drag-and-drop payload shape (scheduled_end omitted when the source appointment has none) still shifts sibling start, and shifts a sibling's own end by the same delta", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1", scheduled_for: OLD_SELECTED_START, scheduled_end: null }) },
        { error: null }, // update source (no hasColumn probe -- scheduled_end absent from body, matching MoveConfirmDialog when scheduledEnd is falsy)
        { data: [{ id: "sib-1", scheduled_for: SIB1_OLD_START, scheduled_end: SIB1_OLD_END }] },
        { error: null },
      ],
      recurring_series: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({
      appointment_id: "appt-1", mode: "future", scheduled_for: NEW_SELECTED_START, // MoveConfirmDialog: no scheduled_end key at all
    }));
    const sibUpdate = currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update")[1];
    // startDeltaMs (-1 day) is used as the end-delta fallback too, preserving this sibling's own duration.
    assert.deepEqual(sibUpdate.args[0], { scheduled_for: SIB1_NEW_START, scheduled_end: SIB1_NEW_END });
  });

  test("generalizes beyond weekly/every-4-weeks: a daily-spaced series shifts every sibling by the same delta and keeps 1-day spacing intact", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-daily", scheduled_for: "2026-08-06T09:00:00.000Z" }) },
        { error: null }, // update source
        {
          data: [
            { id: "sib-1", scheduled_for: "2026-08-07T09:00:00.000Z", scheduled_end: null },
            { id: "sib-2", scheduled_for: "2026-08-08T09:00:00.000Z", scheduled_end: null },
          ],
        },
        { error: null },
        { error: null },
      ],
      recurring_series: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    await PATCH(req({
      appointment_id: "appt-1", mode: "future", scheduled_for: "2026-08-06T10:00:00.000Z", // +1 hour, no date change
    }));
    const updates = currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update");
    assert.deepEqual(updates[1].args[0], { scheduled_for: "2026-08-07T10:00:00.000Z" });
    assert.deepEqual(updates[2].args[0], { scheduled_for: "2026-08-08T10:00:00.000Z" });
    const spacingMs = new Date("2026-08-08T10:00:00.000Z").getTime() - new Date("2026-08-07T10:00:00.000Z").getTime();
    assert.equal(spacingMs, 24 * 60 * 60 * 1000);
  });
});

describe("Phase 5.7D-R17: appointment price snapshot on edit", () => {
  test("mode: single with a valid price updates only price_cents on the selected occurrence", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt() }, // fetch existing
        { error: null }, // hasColumn("price_cents")
        { error: null }, // update source
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", price_cents: 8000 }));
    assert.equal(res.status, 200);
    const updateCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "update");
    assert.deepEqual(updateCall!.args[0], { price_cents: 8000 });
  });

  test("price_cents: null explicitly clears a previously-set price", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt() },
        { error: null }, // hasColumn("price_cents")
        { error: null },
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", price_cents: null }));
    assert.equal(res.status, 200);
    const updateCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "update");
    assert.deepEqual(updateCall!.args[0], { price_cents: null });
  });

  test("an invalid price is rejected with 400, zero writes", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt() },
        { error: null }, // hasColumn("price_cents")
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", price_cents: -500 }));
    assert.equal(res.status, 400);
    assert.deepEqual(writeCalls(currentFake.calls), []);
  });

  test("price_cents omitted entirely leaves the appointment's price untouched -- not part of the update payload", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: existingAppt() }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "Deep Cleaning" }));
    assert.equal(res.status, 200);
    const updateCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "update");
    assert.equal("price_cents" in (updateCall!.args[0] as object), false);
  });

  test("mode: future propagates the new price to every future sibling, as a plain value (not a delta)", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1" }) },
        { error: null }, // hasColumn("price_cents")
        { error: null }, // update source
        { data: [{ id: "sib-1", scheduled_for: "2026-08-10T14:00:00.000Z", scheduled_end: null }] }, // siblings
        { error: null }, // update sib-1
      ],
      recurring_series: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "future", price_cents: 9000 }));
    assert.equal(res.status, 200);
    const updates = currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update");
    assert.deepEqual(updates[0].args[0], { price_cents: 9000 });
    assert.deepEqual(updates[1].args[0], { price_cents: 9000 });
  });

  test("mode: single never touches a sibling's price, even within a recurring series", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1" }) },
        { error: null }, // hasColumn("price_cents")
        { error: null }, // update source only
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "single", price_cents: 9000 }));
    assert.equal(res.status, 200);
    assert.equal(currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update").length, 1);
    assert.equal(currentFake.calls.filter((c) => c.method === "gt").length, 0);
  });
});

describe("Phase 5.7D-R19: team_color on edit", () => {
  test("a valid hex value updates only team_color on the selected occurrence, normalized to uppercase", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt() },
        { error: null }, // hasColumn("team_color")
        { error: null }, // update source
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", team_color: "#2563eb" }));
    assert.equal(res.status, 200);
    const updateCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "update");
    assert.deepEqual(updateCall!.args[0], { team_color: "#2563EB" });
  });

  test("team_color: null explicitly clears a previously-selected team color", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt() },
        { error: null }, // hasColumn("team_color")
        { error: null },
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", team_color: null }));
    assert.equal(res.status, 200);
    const updateCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "update");
    assert.deepEqual(updateCall!.args[0], { team_color: null });
  });

  test("an invalid team_color is rejected with 400, zero writes", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt() },
        { error: null }, // hasColumn("team_color")
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", team_color: "#FFF" }));
    assert.equal(res.status, 400);
    assert.deepEqual(writeCalls(currentFake.calls), []);
  });

  test("a CSS name is rejected the same way a malformed hex value is", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt() },
        { error: null }, // hasColumn("team_color")
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", team_color: "blue" }));
    assert.equal(res.status, 400);
    assert.deepEqual(writeCalls(currentFake.calls), []);
  });

  test("team_color omitted entirely leaves the appointment's team color untouched -- not part of the update payload", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: existingAppt() }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "Deep Cleaning" }));
    assert.equal(res.status, 200);
    const updateCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "update");
    assert.equal("team_color" in (updateCall!.args[0] as object), false);
  });

  test("mode: future propagates the new team_color to every future sibling, as a plain value", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1" }) },
        { error: null }, // hasColumn("team_color")
        { error: null }, // update source
        { data: [{ id: "sib-1", scheduled_for: "2026-08-10T14:00:00.000Z", scheduled_end: null }] }, // siblings
        { error: null }, // update sib-1
      ],
      recurring_series: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "future", team_color: "#16A34A" }));
    assert.equal(res.status, 200);
    const updates = currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update");
    assert.deepEqual(updates[0].args[0], { team_color: "#16A34A" });
    assert.deepEqual(updates[1].args[0], { team_color: "#16A34A" });
  });

  test("mode: future propagates an explicit null (clearing) to every future sibling too", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1" }) },
        { error: null }, // hasColumn("team_color")
        { error: null }, // update source
        { data: [{ id: "sib-1", scheduled_for: "2026-08-10T14:00:00.000Z", scheduled_end: null }] }, // siblings
        { error: null }, // update sib-1
      ],
      recurring_series: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "future", team_color: null }));
    assert.equal(res.status, 200);
    const updates = currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update");
    assert.deepEqual(updates[0].args[0], { team_color: null });
    assert.deepEqual(updates[1].args[0], { team_color: null });
  });

  test("mode: single never touches a sibling's team color, even within a recurring series", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1" }) },
        { error: null }, // hasColumn("team_color")
        { error: null }, // update source only
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "single", team_color: "#16A34A" }));
    assert.equal(res.status, 200);
    assert.equal(currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update").length, 1);
    assert.equal(currentFake.calls.filter((c) => c.method === "gt").length, 0);
  });
});

describe("Phase 5.7D-R18: multi-employee assignment on update", () => {
  test("adding a second employee (Roxana) while Teresa remains -- the atomic sync RPC is called with the full desired set and the exact observed current set", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        appointments: [{ data: existingAppt() }, { error: null }, { error: null }],
        employees: [{ data: [{ id: "teresa" }, { id: "roxana" }] }],
        appointment_employee_hours: [{ data: [] }],
        appointment_employees: [
          { data: [{ id: "ae-1", appointment_id: "appt-1", employee_id: "teresa", actual_started_at: null, actual_completed_at: null, created_at: "x", updated_at: "x" }] }, // planAssignmentSync's own fetchAssignments
        ],
      },
      { sync_appointment_assignments: [{ data: "synced" }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", employee_ids: ["teresa", "roxana"] }));
    assert.equal(res.status, 200);
    assert.equal(currentFake.rpcCalls.length, 1);
    const call = currentFake.rpcCalls[0];
    assert.equal(call.fn, "sync_appointment_assignments");
    assert.deepEqual(call.args, {
      p_appointment_id: "appt-1",
      p_workspace_id: REAL_WORKSPACE_ID,
      p_expected_current_employee_ids: ["teresa"],
      p_desired_employee_ids: ["roxana", "teresa"],
    });
    // No direct .insert()/.delete() against appointment_employees anymore --
    // the atomic RPC is the only path, never a plain Supabase-client write.
    assert.equal(currentFake.calls.filter((c) => c.table === "appointment_employees" && (c.method === "insert" || c.method === "delete")).length, 0);
  });

  test("removing Teresa while Alberto remains -- the atomic sync RPC receives the full desired set (Alberto only)", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        appointments: [{ data: existingAppt() }, { error: null }, { error: null }],
        employees: [{ data: [{ id: "alberto" }] }],
        appointment_employee_hours: [{ data: [] }],
        appointment_employees: [
          {
            data: [
              { id: "ae-1", appointment_id: "appt-1", employee_id: "alberto", actual_started_at: null, actual_completed_at: null, created_at: "x", updated_at: "x" },
              { id: "ae-2", appointment_id: "appt-1", employee_id: "teresa", actual_started_at: null, actual_completed_at: null, created_at: "x", updated_at: "x" },
            ],
          },
        ],
      },
      { sync_appointment_assignments: [{ data: "synced" }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", employee_ids: ["alberto"] }));
    assert.equal(res.status, 200);
    assert.equal(currentFake.rpcCalls.length, 1);
    const call = currentFake.rpcCalls[0].args as Record<string, unknown>;
    assert.deepEqual(call.p_expected_current_employee_ids, ["alberto", "teresa"]);
    assert.deepEqual(call.p_desired_employee_ids, ["alberto"]);
    assert.equal(currentFake.calls.filter((c) => c.table === "appointment_employees" && (c.method === "insert" || c.method === "delete")).length, 0);
  });

  test("removing the last employee is allowed at the API level -- last-employee confirmation is a client-side (AppointmentModal) concern", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        appointments: [{ data: existingAppt() }, { error: null }, { error: null }],
        appointment_employee_hours: [{ data: [] }],
        appointment_employees: [
          { data: [{ id: "ae-1", appointment_id: "appt-1", employee_id: "teresa", actual_started_at: null, actual_completed_at: null, created_at: "x", updated_at: "x" }] },
        ],
      },
      { sync_appointment_assignments: [{ data: "synced" }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", employee_ids: [] }));
    assert.equal(res.status, 200);
    const updateCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "update");
    assert.equal((updateCall!.args[0] as { employee_id?: string | null }).employee_id, null);
    const call = currentFake.rpcCalls[0].args as Record<string, unknown>;
    assert.deepEqual(call.p_desired_employee_ids, []);
  });

  test("a blocked removal (recorded work) rejects the entire request with 409, zero mutation of any kind -- not even an unrelated field change", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: existingAppt() }],
      appointment_employee_hours: [{ data: [] }],
      appointment_employees: [
        { data: [{ id: "ae-1", appointment_id: "appt-1", employee_id: "teresa", actual_started_at: "2026-07-30T09:00:00.000Z", actual_completed_at: "2026-07-30T12:00:00.000Z", created_at: "x", updated_at: "x" }] },
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", employee_ids: [], service_type: "Deep Cleaning" }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "ASSIGNMENT_REMOVAL_BLOCKED");
    assert.deepEqual(body.blockedEmployeeIds, ["teresa"]);
    assert.equal(writeCalls(currentFake.calls).length, 0, "no mutation anywhere -- not even the unrelated service_type change");
  });

  test("mode: future propagates a newly added employee to every future sibling -- the atomic sync RPC is called once per appointment (origin + each sibling), each with its own observed current set", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        appointments: [
          { data: existingAppt({ series_id: "series-1" }) }, // existing fetch
          { data: [{ id: "sib-1", scheduled_for: "2026-08-10T14:00:00.000Z", scheduled_end: null }] }, // siblings (fetched early for validation)
          { error: null }, // hasColumn("employee_id")
          { error: null }, // update origin
          { error: null }, // update sibling
        ],
        employees: [{ data: [{ id: "teresa" }, { id: "roxana" }] }],
        appointment_employee_hours: [{ data: [] }],
        appointment_employees: [
          { data: [{ id: "ae-o", appointment_id: "appt-1", employee_id: "teresa", actual_started_at: null, actual_completed_at: null, created_at: "x", updated_at: "x" }] }, // planAssignmentSync's own fetchAssignments(origin)
          { data: [{ id: "ae-s", appointment_id: "sib-1", employee_id: "teresa", actual_started_at: null, actual_completed_at: null, created_at: "x", updated_at: "x" }] }, // planAssignmentSync's own fetchAssignments(sib-1)
        ],
        recurring_series: [{ data: null }],
      },
      { sync_appointment_assignments: [{ data: "synced" }, { data: "synced" }] } // origin, then sib-1
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "future", employee_ids: ["teresa", "roxana"] }));
    assert.equal(res.status, 200);
    assert.equal(currentFake.rpcCalls.length, 2);
    const [originCall, sibCall] = currentFake.rpcCalls.map((c) => c.args as Record<string, unknown>);
    assert.equal(originCall.p_appointment_id, "appt-1");
    assert.deepEqual(originCall.p_expected_current_employee_ids, ["teresa"]);
    assert.deepEqual(originCall.p_desired_employee_ids, ["roxana", "teresa"]);
    assert.equal(sibCall.p_appointment_id, "sib-1");
    assert.deepEqual(sibCall.p_expected_current_employee_ids, ["teresa"]);
    assert.deepEqual(sibCall.p_desired_employee_ids, ["roxana", "teresa"]);
    assert.equal(currentFake.calls.filter((c) => c.table === "appointment_employees" && (c.method === "insert" || c.method === "delete")).length, 0);
  });

  test("mode: future -- a blocked removal on ANY sibling aborts the whole request, including the origin's own (unblocked) change", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1" }) },
        { data: [{ id: "sib-1", scheduled_for: "2026-08-10T14:00:00.000Z", scheduled_end: null }] },
      ],
      employees: [{ data: [{ id: "teresa" }] }],
      appointment_employee_hours: [{ data: [] }],
      appointment_employees: [
        {
          data: [
            { id: "ae-o1", appointment_id: "appt-1", employee_id: "teresa", actual_started_at: null, actual_completed_at: null, created_at: "x", updated_at: "x" },
            { id: "ae-o2", appointment_id: "appt-1", employee_id: "roxana", actual_started_at: null, actual_completed_at: null, created_at: "x", updated_at: "x" },
          ],
        }, // fetchAssignments(origin) -- roxana unworked here, removal would be fine on its own
        {
          data: [
            { id: "ae-s1", appointment_id: "sib-1", employee_id: "teresa", actual_started_at: null, actual_completed_at: null, created_at: "x", updated_at: "x" },
            { id: "ae-s2", appointment_id: "sib-1", employee_id: "roxana", actual_started_at: "2026-08-10T14:00:00.000Z", actual_completed_at: "2026-08-10T15:00:00.000Z", created_at: "x", updated_at: "x" },
          ],
        }, // fetchAssignments(sib-1) -- roxana IS worked here
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "future", employee_ids: ["teresa"] }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "ASSIGNMENT_REMOVAL_BLOCKED");
    assert.deepEqual(body.blockedEmployeeIds, ["roxana"]);
    assert.equal(writeCalls(currentFake.calls).length, 0, "the origin's own unblocked removal must not be applied either -- whole request aborts");
  });

  test("employee_ids omitted entirely leaves existing assignments untouched -- not part of the update payload", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: existingAppt() }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", service_type: "Deep Cleaning" }));
    assert.equal(res.status, 200);
    assert.equal(currentFake.calls.filter((c) => c.table === "appointment_employees").length, 0);
    assert.equal(currentFake.calls.filter((c) => c.table === "employees").length, 0);
    const updateCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "update");
    assert.equal("employee_id" in (updateCall!.args[0] as object), false);
  });
});

describe("Block 2C-1: assignment sync failure stops the request safely -- never reports success, never reactivates a series with an unconfirmed employee set", () => {
  test("outcome 'state_changed' from the sync RPC returns 409 ASSIGNMENT_SYNC_FAILED, not ok:true", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        appointments: [{ data: existingAppt() }, { error: null }, { error: null }],
        employees: [{ data: [{ id: "teresa" }] }],
        appointment_employee_hours: [{ data: [] }],
        appointment_employees: [{ data: [] }],
      },
      { sync_appointment_assignments: [{ data: "state_changed" }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", employee_ids: ["teresa"] }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "ASSIGNMENT_SYNC_FAILED");
    assert.equal(body.ok, undefined);
  });

  test("outcome 'employee_not_eligible' from the sync RPC returns 409 ASSIGNMENT_SYNC_FAILED", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        appointments: [{ data: existingAppt() }, { error: null }, { error: null }],
        employees: [{ data: [{ id: "teresa" }] }],
        appointment_employee_hours: [{ data: [] }],
        appointment_employees: [{ data: [] }],
      },
      { sync_appointment_assignments: [{ data: "employee_not_eligible" }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", employee_ids: ["teresa"] }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "ASSIGNMENT_SYNC_FAILED");
  });

  test("outcome 'appointment_not_found' from the sync RPC returns 409 ASSIGNMENT_SYNC_FAILED", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        appointments: [{ data: existingAppt() }, { error: null }, { error: null }],
        employees: [{ data: [{ id: "teresa" }] }],
        appointment_employee_hours: [{ data: [] }],
        appointment_employees: [{ data: [] }],
      },
      { sync_appointment_assignments: [{ data: "appointment_not_found" }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", employee_ids: ["teresa"] }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "ASSIGNMENT_SYNC_FAILED");
  });

  test("a real sync RPC-call error propagates as a generic 500, never a raw database detail", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        appointments: [{ data: existingAppt() }, { error: null }, { error: null }],
        employees: [{ data: [{ id: "teresa" }] }],
        appointment_employee_hours: [{ data: [] }],
        appointment_employees: [{ data: [] }],
      },
      { sync_appointment_assignments: [{ error: { message: "simulated sync rpc failure" } }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", employee_ids: ["teresa"] }));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes("simulated sync rpc failure"));
  });

  test("disclosed partial-mutation limitation: the appointment's own scalar field change already committed (a separate, independent PostgREST call) BEFORE the sync failure is detected -- this route is a sequence of independent calls, not one transaction, and this correction does not change that", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        appointments: [{ data: existingAppt() }, { error: null }, { error: null }],
        employees: [{ data: [{ id: "teresa" }] }],
        appointment_employee_hours: [{ data: [] }],
        appointment_employees: [{ data: [] }],
      },
      { sync_appointment_assignments: [{ data: "state_changed" }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", employee_ids: ["teresa"], service_type: "Deep Cleaning" }));
    assert.equal(res.status, 409);
    // The scalar field update DID already happen -- proving it is not, and
    // cannot be, rolled back by this correction alone.
    const updateCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "update");
    assert.ok(updateCall, "the appointment's own scalar field update already committed before the sync failure was detected");
    assert.equal((updateCall!.args[0] as { service_type?: string }).service_type, "Deep Cleaning");
  });

  test("mode: future -- a sibling's sync failure aborts before ANY registry re-finalize is attempted, so a failed sync can never reactivate a series with an unconfirmed employee set", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        appointments: [
          { data: existingAppt({ series_id: "series-1" }) },
          { data: [{ id: "sib-1", scheduled_for: "2026-08-10T14:00:00.000Z", scheduled_end: null }] },
          { error: null }, // hasColumn("employee_id")
          { error: null }, // update origin
          { error: null }, // update sibling
        ],
        employees: [{ data: [{ id: "teresa" }] }],
        appointment_employee_hours: [{ data: [] }],
        appointment_employees: [
          { data: [] }, // planAssignmentSync fetchAssignments(origin)
          { data: [] }, // planAssignmentSync fetchAssignments(sib-1)
        ],
        recurring_series: [
          { data: { id: "series-1", status: "active" } }, // observe old series status
          { data: [{ id: "series-1" }] }, // quarantine (active -> review_required)
        ],
      },
      { sync_appointment_assignments: [{ data: "synced" }, { data: "state_changed" }] } // origin ok, sibling fails
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "future", employee_ids: ["teresa"] }));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "ASSIGNMENT_SYNC_FAILED");
    // The registry re-finalize step never ran -- no activate_recurring_series
    // RPC call was ever attempted, so the series stays quarantined in
    // review_required rather than being reactivated using an employee set a
    // sync failure just proved could not be confirmed.
    assert.deepEqual(currentFake.rpcCalls.filter((c) => c.fn === "activate_recurring_series"), []);
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

// Phase 2 (Monthly Recurring Appointments): this route's "Only this" (mode:
// single) and "This & future" (mode: future) mechanisms are proven
// frequency-agnostic above via the delta-based sibling shift (daily/weekly/
// every-N-weeks all pass through the exact same code path). Monthly
// recurrence deliberately required ZERO changes to app/api/appointments/
// update/route.ts -- this source-level proof is the evidence: the route
// never reads frequency_type, repeat_weeks, or repeat_months from either
// its own SELECT or its sibling propagation logic, so a monthly series'
// "Only this"/"This & future" behavior is identical, by construction, to
// every existing frequency this file already covers above.
describe("Phase 2: monthly recurrence required no changes to this route (source-level proof)", () => {
  const routeSource = fs.readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

  test("this route's own appointment SELECT never fetches frequency_type, repeat_weeks, or repeat_months, and no apptUpdate.* write ever touches them -- 'Only this'/'This & future' are frequency-agnostic by construction, covering monthly with zero changes", () => {
    const selectMatch = routeSource.match(/\.select\("([^"]*)"\)/);
    assert.ok(selectMatch, "expected to find the appointment SELECT field list");
    for (const forbidden of ["frequency_type", "repeat_weeks", "repeat_months"]) {
      assert.ok(!selectMatch![1].includes(forbidden), `SELECT must not fetch "${forbidden}": "${selectMatch![1]}"`);
      assert.ok(!routeSource.includes(`apptUpdate.${forbidden}`), `must never write apptUpdate.${forbidden}`);
      assert.ok(!routeSource.includes(`sibUpdate.${forbidden}`), `must never write sibUpdate.${forbidden}`);
    }
  });

  test("the sibling ('This & future') shift is delta-based (old vs. new timestamp), not recomputed from any recurrence rule", () => {
    assert.ok(routeSource.includes("startDeltaMs"));
    assert.ok(routeSource.includes("endDeltaMs"));
  });
});

function seriesRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "series-1",
    workspace_id: REAL_WORKSPACE_ID,
    status: "active",
    client_id: "client-1",
    is_demo: false,
    template_appointment_id: "appt-old",
    frequency_type: "weekly",
    repeat_weeks: 1,
    repeat_months: null,
    anchor_local_date: "2026-08-03",
    anchor_local_time: "10:00",
    anchor_timezone: "America/New_York",
    source: "owner_created",
    ...overrides,
  };
}
function liveOcc(overrides: Record<string, unknown> = {}) {
  return {
    id: "appt-1",
    scheduled_for: "2026-08-03T15:00:00.000Z",
    service_type: "Haircut",
    price_cents: 5000,
    duration_minutes: 60,
    team_color: null,
    ...overrides,
  };
}

describe("Block 2B safety correction: This & Future quarantines an ACTIVE series before mutation, then re-validates and reactivates it after", () => {
  test("an active series: quarantines before mutation, then re-activates atomically with the edited appointment as template and the refreshed anchor", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        appointments: [
          { data: existingAppt({ series_id: "series-1" }) }, // fetch existing
          { error: null }, // update source
          { data: [{ id: "sib-1", scheduled_for: "2026-08-10T14:00:00.000Z", scheduled_end: null }] }, // siblings
          { error: null }, // update sibling
          { data: [liveOcc()] }, // fetchLiveOccurrenceSnapshots -- just the edited appointment, still scheduled/future
          // Block 2C-1: re-fetch the edited appointment's own current,
          // fully-committed fields immediately before the activation RPC.
          { data: { service_type: "Haircut", price_cents: 5000, duration_minutes: 60, notes: null, team_color: null, scheduled_for: "2026-08-03T15:00:00.000Z" } },
        ],
        // fetchAssignments(appt-1) inside fetchLiveOccurrenceSnapshots, then
        // again immediately before the activation RPC (Block 2C-1) -- the
        // second read proves the RPC's expected employee set reflects the
        // CURRENT assignment state, not a stale earlier snapshot.
        appointment_employees: [{ data: [] }, { data: [] }],
        company_settings: [{ data: { timezone: null } }],
        recurring_series: [
          { data: { id: "series-1", status: "active" } }, // observe old series status
          { data: [{ id: "series-1" }] }, // quarantine (active -> review_required)
          { data: seriesRow() }, // fetchSeriesById (post-mutation, for consistency check)
        ],
      },
      { activate_recurring_series: [{ data: "activated" }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "future", scheduled_for: "2026-08-03T15:00:00.000Z" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.warning, undefined);

    const updateCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "update");
    assert.equal(updateCalls.length, 1, "quarantine only -- activation now happens entirely inside the RPC");
    assert.equal((updateCalls[0].args[0] as Record<string, unknown>).status, "review_required");

    assert.equal(currentFake.rpcCalls.length, 1);
    const rpcArgs = currentFake.rpcCalls[0].args as Record<string, unknown>;
    assert.equal(currentFake.rpcCalls[0].fn, "activate_recurring_series");
    assert.equal(rpcArgs.p_template_appointment_id, "appt-1");
    assert.equal(rpcArgs.p_expected_scheduled_for, "2026-08-03T15:00:00.000Z");
    assert.equal(rpcArgs.p_anchor_timezone, "America/New_York");

    // Quarantine must be recorded before the origin appointment's own update.
    const quarantineIdx = currentFake.calls.indexOf(updateCalls[0]);
    const firstApptUpdateIdx = currentFake.calls.findIndex((c) => c.table === "appointments" && c.method === "update");
    assert.ok(quarantineIdx < firstApptUpdateIdx);
  });

  test("a future-mode edit with NO time change (only a field like price) still quarantines-then-reactivates an active series -- template repoints even without a time shift", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        appointments: [
          { data: existingAppt({ series_id: "series-1" }) },
          { error: null },
          { data: [{ id: "sib-1", scheduled_for: "2026-08-10T14:00:00.000Z", scheduled_end: null }] },
          { error: null },
          { data: [liveOcc({ scheduled_for: "2026-08-03T14:00:00.000Z", price_cents: 7500 })] },
          { data: { service_type: "Haircut", price_cents: 7500, duration_minutes: 60, notes: null, team_color: null, scheduled_for: "2026-08-03T14:00:00.000Z" } },
        ],
        appointment_employees: [{ data: [] }, { data: [] }],
        company_settings: [{ data: { timezone: null } }],
        recurring_series: [
          { data: { id: "series-1", status: "active" } }, // observe
          { data: [{ id: "series-1" }] }, // quarantine
          { data: seriesRow() }, // fetchSeriesById
        ],
      },
      { activate_recurring_series: [{ data: "activated" }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "future", price_cents: 7500 }));
    assert.equal(res.status, 200);
    const updateCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "update");
    assert.equal(updateCalls.length, 1);
    assert.equal(currentFake.rpcCalls.length, 1);
    const rpcArgs = currentFake.rpcCalls[0].args as Record<string, unknown>;
    assert.equal(rpcArgs.p_template_appointment_id, "appt-1");
    // The anchor is recomputed from the (unchanged) scheduled_for -- a no-op
    // overwrite, not a special-cased skip.
    assert.equal(rpcArgs.p_expected_scheduled_for, "2026-08-03T14:00:00.000Z");
  });

  test("a series that wasn't active to begin with (review_required legacy, or none at all) is left completely untouched -- never auto-activated by an unrelated edit", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1" }) },
        { error: null },
        { data: [{ id: "sib-1", scheduled_for: "2026-08-10T14:00:00.000Z", scheduled_end: null }] },
        { error: null },
      ],
      recurring_series: [{ data: null }], // observed status: no row exists -- conclusively not active
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "future", scheduled_for: "2026-08-03T15:00:00.000Z" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.warning, undefined);
    // Only the observe READ touches recurring_series -- since it showed the
    // series wasn't active, no compare-and-set write is ever attempted at
    // all, and the later fetchSeriesById/finalize-active reactivation steps
    // never run either.
    const recurringSeriesCalls = currentFake.calls.filter((c) => c.table === "recurring_series");
    assert.equal(recurringSeriesCalls.filter((c) => c.method === "update").length, 0);
    assert.equal(recurringSeriesCalls.filter((c) => c.method === "maybeSingle").length, 1);
  });

  test("mode='single' (Only This) never touches recurring_series, even on an active series with a time change", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: existingAppt({ series_id: "series-1" }) }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "single", scheduled_for: "2026-08-03T15:00:00.000Z" }));
    assert.equal(res.status, 200);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "recurring_series"), []);
    assert.deepEqual(currentFake.rpcCalls, []);
  });

  // Block 2C-1 regression: under the durable-snapshot design,
  // recurring_series.template_appointment_id is purely historical/
  // informational once a series is active -- an Only This edit to the exact
  // appointment a series' template_appointment_id happens to point at must
  // never re-run activate_recurring_series and must never alter that
  // series' snapshot_* columns, even though the edited row's own live
  // fields (price/service/duration/notes/team_color) just changed. This is
  // the direct, named counter-example to the "single edit could silently
  // alter what future replenishment copies" risk identified in the Block 2C
  // architecture review.
  test("Block 2C-1 regression: an Only This edit of a series' own historical template_appointment_id leaves that series' snapshot completely untouched", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      // appt-1 is simultaneously (a) the row being edited here via mode:
      // "single" and (b) some OTHER already-active series' own
      // template_appointment_id -- established purely by convention (its id
      // matching what a real series' template_appointment_id would be), not
      // by any fixture the route itself reads, since mode:"single" never
      // looks up which series (if any) an appointment happens to be a
      // template for.
      appointments: [
        { data: existingAppt({ series_id: null }) }, // fetch existing -- note: this specific appointment need not even carry a series_id itself to be some OTHER series' historical template pointer
        { error: null }, // update source (price/service/etc change)
      ],
    });
    sessionToReturn = OWNER_SESSION;
    // service_type/notes deliberately avoid any hasColumn()-probed field
    // (price_cents/duration_minutes/team_color/scheduled_end/employee_id),
    // keeping the fixture list exactly two entries: fetch existing, then
    // the update itself.
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "single", service_type: "Deep Clean", notes: "Different scope of work entirely" }));
    assert.equal(res.status, 200);
    // The definitive proof: zero reads AND zero writes against
    // recurring_series, and zero activation RPC calls -- structurally
    // impossible for this route to have altered any series' snapshot_*
    // columns, template_appointment_id, or any other registry field.
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "recurring_series"), []);
    assert.deepEqual(currentFake.rpcCalls, []);
  });

  test("failure injection: a quarantine failure on an active series aborts BEFORE any appointment mutation, 500, zero appointment writes", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: existingAppt({ series_id: "series-1" }) }],
      recurring_series: [{ error: { message: "simulated quarantine failure" } }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "future", scheduled_for: "2026-08-03T15:00:00.000Z" }));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes("simulated quarantine failure"));
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update"), []);
  });

  test("failure injection: an inconsistent resulting live tail leaves the series review_required, with a warning -- never auto-reactivated on disagreement", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: existingAppt({ series_id: "series-1" }) },
        { error: null },
        { data: [{ id: "sib-1", scheduled_for: "2026-08-10T14:00:00.000Z", scheduled_end: null }] },
        { error: null },
        // Two live occurrences that disagree on price -- e.g. a sibling this
        // request didn't touch (employee_ids wasn't part of the body, so no
        // propagation occurred) still carries a stale price.
        { data: [liveOcc({ id: "appt-1" }), liveOcc({ id: "sib-1", price_cents: 999999 })] },
      ],
      appointment_employees: [{ data: [] }, { data: [] }],
      company_settings: [{ data: { timezone: null } }],
      recurring_series: [
        { data: { id: "series-1", status: "active" } }, // observe
        { data: [{ id: "series-1" }] }, // quarantine
        { data: seriesRow() }, // fetchSeriesById
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "future", scheduled_for: "2026-08-03T15:00:00.000Z" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.warning, "expected a structured warning -- the series stays in review_required");
    assert.equal(body.warning.code, "recurring_series_review_required");
    const updateCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "update");
    assert.equal(updateCalls.length, 1, "only the quarantine update -- no finalize-active update was ever attempted");
  });

  test("failure injection: an activation RPC error after a successful mutation still returns success, with a warning", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        appointments: [
          { data: existingAppt({ series_id: "series-1" }) },
          { error: null },
          { data: [{ id: "sib-1", scheduled_for: "2026-08-10T14:00:00.000Z", scheduled_end: null }] },
          { error: null },
          { data: [liveOcc()] },
          { data: { service_type: "Haircut", price_cents: 5000, duration_minutes: 60, notes: null, team_color: null, scheduled_for: "2026-08-03T15:00:00.000Z" } },
        ],
        appointment_employees: [{ data: [] }, { data: [] }],
        company_settings: [{ data: { timezone: null } }],
        recurring_series: [
          { data: { id: "series-1", status: "active" } }, // observe
          { data: [{ id: "series-1" }] }, // quarantine
          { data: seriesRow() }, // fetchSeriesById
        ],
      },
      { activate_recurring_series: [{ error: { message: "simulated activation failure" } }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "future", scheduled_for: "2026-08-03T15:00:00.000Z" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.warning);
    assert.equal(body.warning.code, "recurring_series_review_required");
    assert.ok(!JSON.stringify(body.warning).includes("simulated activation failure"));
  });

  test("outcome 'invalid_timezone' from the RPC still returns success, with the same structured warning", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        appointments: [
          { data: existingAppt({ series_id: "series-1" }) },
          { error: null },
          { data: [{ id: "sib-1", scheduled_for: "2026-08-10T14:00:00.000Z", scheduled_end: null }] },
          { error: null },
          { data: [liveOcc()] },
          { data: { service_type: "Haircut", price_cents: 5000, duration_minutes: 60, notes: null, team_color: null, scheduled_for: "2026-08-03T15:00:00.000Z" } },
        ],
        appointment_employees: [{ data: [] }, { data: [] }],
        company_settings: [{ data: { timezone: null } }],
        recurring_series: [
          { data: { id: "series-1", status: "active" } }, // observe
          { data: [{ id: "series-1" }] }, // quarantine
          { data: seriesRow() }, // fetchSeriesById
        ],
      },
      { activate_recurring_series: [{ data: "invalid_timezone" }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "future", scheduled_for: "2026-08-03T15:00:00.000Z" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.warning);
    assert.equal(body.warning.code, "recurring_series_review_required");
  });

  test("race: activating an updated series cannot succeed after its client becomes inactive -- stays review_required, appointment mutation still succeeds with a warning", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        appointments: [
          { data: existingAppt({ series_id: "series-1" }) },
          { error: null },
          { data: [{ id: "sib-1", scheduled_for: "2026-08-10T14:00:00.000Z", scheduled_end: null }] },
          { error: null },
          { data: [liveOcc()] },
          { data: { service_type: "Haircut", price_cents: 5000, duration_minutes: 60, notes: null, team_color: null, scheduled_for: "2026-08-03T15:00:00.000Z" } },
        ],
        appointment_employees: [{ data: [] }, { data: [] }],
        company_settings: [{ data: { timezone: null } }],
        recurring_series: [
          { data: { id: "series-1", status: "active" } }, // observe
          { data: [{ id: "series-1" }] }, // quarantine
          { data: seriesRow() }, // fetchSeriesById
        ],
      },
      // The client-active re-check now happens entirely inside the RPC's
      // own locked transaction -- simulated here by the RPC itself
      // reporting client_not_active, not a second JS-level clients fixture.
      { activate_recurring_series: [{ data: "client_not_active" }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "future", scheduled_for: "2026-08-03T15:00:00.000Z" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.warning);
    assert.equal(body.warning.code, "recurring_series_review_required");
    // No finalize-active update was ever attempted -- the client check
    // short-circuits before the compare-and-set write.
    const updateCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "update");
    assert.equal(updateCalls.length, 1, "only the quarantine update");
  });

  test("race: concurrent stop cannot be overwritten by This & Future -- observed active, but the quarantine CAS finds nothing (already stopped elsewhere), aborts 409 with zero appointment writes", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: existingAppt({ series_id: "series-1" }) }],
      recurring_series: [
        { data: { id: "series-1", status: "active" } }, // observed active
        { data: [] }, // but the CAS matches nothing -- e.g. a concurrent Delete This & Future already stopped it
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req({ appointment_id: "appt-1", mode: "future", scheduled_for: "2026-08-03T15:00:00.000Z" }));
    assert.equal(res.status, 409);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments" && (c.method === "update" || c.method === "insert")), []);
    // No later finalize/reactivate attempt of any kind -- the row is never
    // forced back to active over whatever it concurrently became.
    assert.equal(currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "update").length, 1, "only the failed quarantine CAS, nothing else");
  });
});
