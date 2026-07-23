// Phase 5.4E4: route-level tests for app/api/appointments/create/route.ts
// (POST only -- this file has no GET handler). This route uniquely combines
// two independent entitlement branches in one handler:
//   - authenticated owner/tester creation -> requireCapability(session,
//     "canMutateOperationalData"), workspace identity from the session;
//   - unauthenticated public booking -> requireCapabilityForWorkspace(
//     REAL_WORKSPACE_ID, "canUsePublicBooking"), workspace identity a fixed
//     server-side constant, never derived from the request.
// Both gates run before any operational read (including the pre-existing
// booking_enabled check), any mutation, and any notification/provider/audit
// work. @/lib/session, @/lib/supabaseAdmin, and @/lib/notify are mocked
// in-process; @/lib/entitlementServer is DELIBERATELY LEFT UNMOCKED -- the
// real requireCapability/requireCapabilityForWorkspace/
// fetchEntitlementForWorkspace/resolveWorkspaceEntitlement chain runs
// against a fake "subscriptions" table for both branches. The REAL
// lib/notify.ts constructs a Twilio client at module-load time and would
// throw without real credentials, so it must never be imported -- this is
// the test-only import seam contemplated for notification-capable routes;
// no production behavior changes. No real Supabase/Stripe/Twilio/Resend/
// network call is reachable. Run with --experimental-test-module-mocks
// (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createFakeSupabaseAdmin,
  createFakeNotify,
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
    // runtime type-stripping doesn't elide, so the mocked module must still
    // provide *a* runtime binding for it. It is never read as a value.
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
function req(body?: unknown, url = "http://localhost/api/appointments/create") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID };
const TESTER_SESSION = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };

function authBody(overrides: Record<string, unknown> = {}) {
  return {
    client_id: "client-1",
    service_type: "Haircut",
    scheduled_for: "2026-08-03T14:00:00.000Z", // Monday 10:00am America/New_York
    ...overrides,
  };
}
function publicBody(overrides: Record<string, unknown> = {}) {
  return {
    service_type: "Haircut",
    scheduled_for: "2026-08-03T14:00:00.000Z", // Monday 10:00am America/New_York
    name: "Jane Public",
    email: "jane@public.example",
    phone: "+15559876543",
    address: "123 Main St",
    ...overrides,
  };
}

const FIVE_HAS_COLUMN_OK: FakeSupabaseFixture[] = [{ error: null }, { error: null }, { error: null }, { error: null }, { error: null }];

describe("POST /api/appointments/create -- authenticated branch entitlement gate (canMutateOperationalData)", () => {
  const FULL_STATES: Array<[string, ReturnType<typeof subscriptionRow>]> = [
    ["active", subscriptionRow({ stripe_status: "active" })],
    ["trialing", subscriptionRow({ stripe_status: "trialing" })],
    ["past_due_grace", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() + 1000).toISOString() })],
    ["internal", subscriptionRow({ billing_mode: "internal", stripe_status: null })],
  ];

  for (const [label, row] of FULL_STATES) {
    test(`${label} permits owner appointment creation, existing response contract unchanged`, async () => {
      resetFixtures({
        // Two queued rows: the canMutateOperationalData mutation gate consumes
        // the first, and the canSendNotifications gate (Phase 5.5E-C) consumes
        // the second -- both read the same real state here, matching what a
        // single subscriptions row would actually resolve to twice in
        // production.
        subscriptions: [{ data: row }, { data: row }],
        clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: "jane@example.com", phone: "+15551234567", auto_email: true, auto_sms: true } }],
        appointments: [...FIVE_HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
        messages_sent: [{ error: null }, { error: null }],
      });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req(authBody()));
      assert.equal(res.status, 200, label);
      assert.deepEqual(await res.json(), { ok: true, appointmentId: "appt-new-1", created: 1 }, label);
    });
  }

  test("exact trusted demo workspace (tester) permits creation with zero subscriptions-table queries (real short-circuit)", async () => {
    resetFixtures({
      clients: [{ data: { id: "client-1" } }, { data: { name: "Demo Client", email: null, phone: null, auto_email: false, auto_sms: false } }],
      appointments: [...FIVE_HAS_COLUMN_OK, { data: [{ id: "appt-demo-1" }] }],
    });
    sessionToReturn = TESTER_SESSION;
    const res = await POST(req(authBody()));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, appointmentId: "appt-demo-1", created: 1 });
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
      const res = await POST(req(authBody()));
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
    const res = await POST(req(authBody()));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table !== "subscriptions"), []);
  });

  test("employee role retains the existing flat 403 role-denial, never reaches any entitlement check, zero Supabase calls", async () => {
    resetFixtures({});
    sessionToReturn = { role: "employee", employeeId: "e1", workspaceId: REAL_WORKSPACE_ID };
    const res = await POST(req(authBody()));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
    assert.equal(body.code, undefined);
    assert.equal(currentFake.calls.length, 0);
  });

  test("tester session with a non-demo workspace fails closed with the generic session-integrity denial, not SUBSCRIPTION_RESTRICTED", async () => {
    resetFixtures({});
    sessionToReturn = { role: "tester", workspaceId: REAL_WORKSPACE_ID };
    const res = await POST(req(authBody()));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
    assert.equal(body.code, undefined);
    assert.equal(currentFake.calls.length, 0, "the tester-workspace-mismatch guard fires before any subscriptions query");
  });

  test("workspace_id spoofed in the request body has no effect -- entitlement is decided before the body is even parsed", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ workspace_id: DEMO_WORKSPACE_ID })));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  test("a spoofed workspace_id query-string value does not change which workspace's entitlement is checked", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody(), "http://localhost/api/appointments/create?workspace_id=attacker-ws"));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  describe("mutation-specific validation runs only after auth/role/entitlement", () => {
    test("missing service_type + restricted workspace -> the exact SUBSCRIPTION_RESTRICTED 403, not 400", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ scheduled_for: "2026-08-03T14:00:00.000Z" }));
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    });

    test("missing service_type + entitled workspace -> the existing 400 'Missing required fields' response", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ scheduled_for: "2026-08-03T14:00:00.000Z" }));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Missing required fields" });
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" || c.table === "appointments"), []);
    });
  });
});

describe("POST /api/appointments/create -- public booking branch entitlement gate (canUsePublicBooking)", () => {
  const FULL_STATES: Array<[string, ReturnType<typeof subscriptionRow>]> = [
    ["active", subscriptionRow({ stripe_status: "active" })],
    ["trialing", subscriptionRow({ stripe_status: "trialing" })],
    ["past_due_grace", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() + 1000).toISOString() })],
    ["internal", subscriptionRow({ billing_mode: "internal", stripe_status: null })],
  ];

  for (const [label, row] of FULL_STATES) {
    test(`${label} permits public booking, existing response contract unchanged`, async () => {
      resetFixtures({
        // Two queued rows: canUsePublicBooking consumes the first, and the
        // canSendNotifications gate (Phase 5.5E-C) consumes the second.
        subscriptions: [{ data: row }, { data: row }],
        company_settings: [{ data: { booking_enabled: true } }],
        services: [{ data: { name: "Haircut", duration_minutes: 45 } }],
        appointments: [{ data: [] }, ...FIVE_HAS_COLUMN_OK, { data: [{ id: "appt-public-1" }] }],
        clients: [
          { data: null }, // email lookup: not found
          { data: null }, // phone lookup: not found
          { data: { id: "new-client-1" } }, // insert new client
          { data: { name: "Jane Public", email: "jane@public.example", phone: "+15559876543", auto_email: true, auto_sms: true } }, // notify re-fetch
        ],
        messages_sent: [{ error: null }, { error: null }],
      });
      sessionToReturn = { role: "none" };
      const res = await POST(req(publicBody()));
      assert.equal(res.status, 200, label);
      assert.deepEqual(await res.json(), { ok: true, appointmentId: "appt-public-1", created: 1 }, label);
    });
  }

  const RESTRICTED_STATES: Array<[string, ReturnType<typeof subscriptionRow> | null]> = [
    ["past_due_expired", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() - 1000).toISOString() })],
    ["canceled", subscriptionRow({ stripe_status: "canceled" })],
    ["unpaid", subscriptionRow({ stripe_status: "unpaid" })],
    ["no_subscription (no row)", null],
    ["malformed", subscriptionRow({ stripe_status: "not_a_real_status" })],
  ];

  for (const [label, row] of RESTRICTED_STATES) {
    test(`${label} returns the exact SUBSCRIPTION_RESTRICTED 403 (not a role/auth denial), zero operational reads, zero provider calls`, async () => {
      resetFixtures({ subscriptions: [{ data: row }] });
      sessionToReturn = { role: "none" };
      const res = await POST(req(publicBody()));
      assert.equal(res.status, 403, label);
      const body = await res.json();
      assert.deepEqual(body, SUBSCRIPTION_RESTRICTED_BODY, label);
      assert.notEqual(body.error, "Unauthorized", label);
      // Not even the pre-existing booking_enabled (company_settings) read is reached.
      assert.deepEqual(currentFake.calls.filter((c) => c.table !== "subscriptions"), [], label);
      assert.equal(currentNotify.emailCalls.length, 0, label);
      assert.equal(currentNotify.smsCalls.length, 0, label);
    });
  }

  test("query_error on the subscriptions read denies, zero operational reads, zero provider calls", async () => {
    resetFixtures({ subscriptions: [{ error: { message: "simulated DB error" } }] });
    sessionToReturn = { role: "none" };
    const res = await POST(req(publicBody()));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table !== "subscriptions"), []);
  });

  test("public workspace identity is the fixed REAL_WORKSPACE_ID constant -- a spoofed body workspace_id (including the demo id) has no effect", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = { role: "none" };
    const res = await POST(req(publicBody({ workspace_id: DEMO_WORKSPACE_ID })));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    // The subscriptions table WAS queried exactly once (proves the real,
    // non-short-circuited Stripe path ran for REAL_WORKSPACE_ID) rather than
    // the demo bypass -- counting the terminal "maybeSingle" call, not every
    // intermediate builder-chain call (from/select/eq), which is the one
    // that corresponds to an actual round trip.
    assert.equal(currentFake.calls.filter((c) => c.table === "subscriptions" && c.method === "maybeSingle").length, 1);
  });

  test("a spoofed workspace_id query-string value does not change which workspace's entitlement is checked", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = { role: "none" };
    const res = await POST(req(publicBody(), "http://localhost/api/appointments/create?workspace_id=attacker-ws"));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  test("existing booking_enabled business rule still applies, unchanged, once entitled", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: false } }],
    });
    sessionToReturn = { role: "none" };
    const res = await POST(req(publicBody()));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Online booking is currently unavailable." });
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "services" || c.table === "clients"), []);
  });

  describe("mutation-specific validation runs only after entitlement (and the pre-existing booking_enabled check)", () => {
    test("missing service_type + restricted workspace -> the exact SUBSCRIPTION_RESTRICTED 403, not 400", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
      sessionToReturn = { role: "none" };
      const res = await POST(req({ scheduled_for: "2026-08-03T14:00:00.000Z" }));
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    });

    test("missing service_type + entitled + booking enabled -> the existing 400 'Missing required fields' response", async () => {
      resetFixtures({
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        company_settings: [{ data: { booking_enabled: true } }],
      });
      sessionToReturn = { role: "none" };
      const res = await POST(req({ scheduled_for: "2026-08-03T14:00:00.000Z" }));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Missing required fields" });
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "services"), []);
    });
  });
});

describe("notification behavior is preserved exactly once entitled, on both branches", () => {
  test("authenticated: a provider failure on one channel is isolated -- the other channel still attempts, mutation still succeeds", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: "jane@example.com", phone: "+15551234567", auto_email: true, auto_sms: true } }],
      appointments: [...FIVE_HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
      messages_sent: [{ error: null }, { error: null }],
    });
    currentNotify.setSendEmailImpl(async () => {
      throw new Error("simulated Resend outage");
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody()));
    assert.equal(res.status, 200, "creation succeeds regardless of a provider failure");
    assert.deepEqual(await res.json(), { ok: true, appointmentId: "appt-new-1", created: 1 });
    assert.equal(currentNotify.emailCalls.length, 1, "email was still attempted");
    assert.equal(currentNotify.smsCalls.length, 1, "sms still attempted despite the email failure");
  });

  test("public: notify_channel = 'none' suppresses both provider calls, mutation still succeeds", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true } }],
      services: [{ data: { name: "Haircut", duration_minutes: 45 } }],
      appointments: [{ data: [] }, ...FIVE_HAS_COLUMN_OK, { data: [{ id: "appt-public-1" }] }],
      clients: [
        { data: null },
        { data: null },
        { data: { id: "new-client-1" } },
        { data: { name: "Jane Public", email: "jane@public.example", phone: "+15559876543", auto_email: true, auto_sms: true } },
      ],
    });
    sessionToReturn = { role: "none" };
    const res = await POST(req(publicBody({ notify_channel: "none" })));
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
    assert.equal(currentFake.calls.filter((c) => c.table === "messages_sent").length, 0);
  });

  test("public: client opted out (auto_email/auto_sms false) -> notification remains suppressed, zero provider calls", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true } }],
      services: [{ data: { name: "Haircut", duration_minutes: 45 } }],
      appointments: [{ data: [] }, ...FIVE_HAS_COLUMN_OK, { data: [{ id: "appt-public-2" }] }],
      clients: [
        { data: null },
        { data: null },
        { data: { id: "new-client-2" } },
        { data: { name: "Jane Public", email: "jane@public.example", phone: "+15559876543", auto_email: false, auto_sms: false } },
      ],
    });
    sessionToReturn = { role: "none" };
    const res = await POST(req(publicBody()));
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });
});

describe("Phase 5.5E-C: canSendNotifications gate on the post-mutation confirmation, independent of the mutation capability", () => {
  test("authenticated: mutation allowed, notification denied -> creation succeeds unchanged, zero provider calls, zero messages_sent, notify client re-fetch skipped", async () => {
    resetFixtures({
      subscriptions: [
        { data: subscriptionRow({ stripe_status: "active" }) }, // canMutateOperationalData: allowed
        { data: subscriptionRow({ stripe_status: "canceled" }) }, // canSendNotifications: denied
      ],
      clients: [{ data: { id: "client-1" } }], // only the client_id validation lookup -- no notify re-fetch
      appointments: [...FIVE_HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody()));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, appointmentId: "appt-new-1", created: 1 });
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
    assert.equal(currentFake.calls.filter((c) => c.table === "messages_sent").length, 0);
    // The client_id validation lookup (.maybeSingle()) still ran; the notify
    // re-fetch (.single()) is the one that must never run.
    assert.equal(currentFake.calls.filter((c) => c.table === "clients" && c.method === "single").length, 0, "the notify re-fetch never happened");
  });

  test("authenticated: mutation allowed, notification entitlement check query_error -> fails closed, creation still succeeds, zero provider calls", async () => {
    resetFixtures({
      subscriptions: [
        { data: subscriptionRow({ stripe_status: "active" }) },
        { error: { message: "simulated DB error" } },
      ],
      clients: [{ data: { id: "client-1" } }],
      appointments: [...FIVE_HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody()));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, appointmentId: "appt-new-1", created: 1 });
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });

  test("authenticated: a spoofed workspace_id in the body does not change which workspace's notification capability is checked", async () => {
    resetFixtures({
      subscriptions: [
        { data: subscriptionRow({ stripe_status: "active" }) },
        { data: subscriptionRow({ stripe_status: "canceled" }) },
      ],
      clients: [{ data: { id: "client-1" } }],
      appointments: [...FIVE_HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ workspace_id: DEMO_WORKSPACE_ID })));
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });

  test("public: booking allowed, notification denied -> booking succeeds unchanged, zero provider calls, zero messages_sent, notify client re-fetch skipped", async () => {
    resetFixtures({
      subscriptions: [
        { data: subscriptionRow({ stripe_status: "active" }) }, // canUsePublicBooking: allowed
        { data: subscriptionRow({ stripe_status: "canceled" }) }, // canSendNotifications: denied
      ],
      company_settings: [{ data: { booking_enabled: true } }],
      services: [{ data: { name: "Haircut", duration_minutes: 45 } }],
      appointments: [{ data: [] }, ...FIVE_HAS_COLUMN_OK, { data: [{ id: "appt-public-1" }] }],
      clients: [
        { data: null }, // email lookup: not found
        { data: null }, // phone lookup: not found
        { data: { id: "new-client-1" } }, // insert new client
        // deliberately no fourth fixture -- proves the notify re-fetch is never queried
      ],
    });
    sessionToReturn = { role: "none" };
    const res = await POST(req(publicBody()));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, appointmentId: "appt-public-1", created: 1 });
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
    assert.equal(currentFake.calls.filter((c) => c.table === "messages_sent").length, 0);
  });

  test("tester/demo creation never reaches a notification-capability check at all (existing !isTester short-circuit, zero subscriptions queries)", async () => {
    resetFixtures({
      clients: [{ data: { id: "client-1" } }, { data: { name: "Demo Client", email: null, phone: null, auto_email: false, auto_sms: false } }],
      appointments: [...FIVE_HAS_COLUMN_OK, { data: [{ id: "appt-demo-1" }] }],
    });
    sessionToReturn = TESTER_SESSION;
    const res = await POST(req(authBody()));
    assert.equal(res.status, 200);
    assert.equal(currentFake.calls.filter((c) => c.table === "subscriptions").length, 0);
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });
});

describe("the two entitlement branches call distinct, correctly-scoped gates (source-level proof)", () => {
  const routeSource = fs.readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

  test("the authenticated branch calls requireCapability(session, \"canMutateOperationalData\")", () => {
    assert.ok(routeSource.includes('requireCapability(session, "canMutateOperationalData")'));
  });

  test("the public branch calls requireCapabilityForWorkspace(workspaceId, \"canUsePublicBooking\") -- never canMutateOperationalData", () => {
    assert.ok(routeSource.includes('requireCapabilityForWorkspace(workspaceId, "canUsePublicBooking")'));
  });

  test("the public branch's workspaceId is always the fixed REAL_WORKSPACE_ID constant, never DEMO_WORKSPACE_ID or a request-derived value", () => {
    assert.ok(routeSource.includes("? session.workspaceId : REAL_WORKSPACE_ID"));
    assert.ok(!routeSource.includes("DEMO_WORKSPACE_ID"), "the create route must never reference the demo workspace directly");
  });

  test("neither entitlement call site reads workspace identity from the request body or query string", () => {
    // The gate block runs before `const body = await req.json();` in this
    // file -- assert that ordering holds so a future edit can't silently
    // move body parsing ahead of the gate.
    const gateIndex = routeSource.indexOf("requireCapabilityForWorkspace(workspaceId");
    const bodyParseIndex = routeSource.indexOf("const body = await req.json();");
    assert.ok(gateIndex > -1 && bodyParseIndex > -1 && gateIndex < bodyParseIndex);
  });

  test("the notification gate calls requireCapabilityForWorkspace(workspaceId, \"canSendNotifications\") exactly once, using the shared workspaceId", () => {
    const count = routeSource.split('requireCapabilityForWorkspace(workspaceId, "canSendNotifications")').length - 1;
    assert.equal(count, 1);
  });

  test("the notification gate runs after the appointments INSERT, never before it", () => {
    const insertIndex = routeSource.indexOf(".insert(rows)");
    const notifyGateIndex = routeSource.indexOf('requireCapabilityForWorkspace(workspaceId, "canSendNotifications")');
    assert.ok(insertIndex > -1 && notifyGateIndex > -1 && insertIndex < notifyGateIndex);
  });

  test("the notification gate runs before the notify client (PII) re-fetch and before any sendEmail/sendSms call", () => {
    const notifyGateIndex = routeSource.indexOf('requireCapabilityForWorkspace(workspaceId, "canSendNotifications")');
    const sendEmailIndex = routeSource.indexOf("sendEmail(");
    const sendSmsIndex = routeSource.indexOf("sendSms(");
    assert.ok(notifyGateIndex > -1 && sendEmailIndex > -1 && sendSmsIndex > -1);
    assert.ok(notifyGateIndex < sendEmailIndex && notifyGateIndex < sendSmsIndex);
  });
});
