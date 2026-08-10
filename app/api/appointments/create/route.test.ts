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
  SERVICE_UNAVAILABLE_BODY,
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
    sanitizeCompanyName: (...args: [string | null | undefined]) => currentNotify.namedExports.sanitizeCompanyName(...args),
    getCompanyName: (...args: [string]) => currentNotify.namedExports.getCompanyName(...args),
    sendEmail: (...args: [string, string, string, string, string?]) => currentNotify.namedExports.sendEmail(...args),
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

const OWNER_AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";
const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID, authUserId: OWNER_AUTH_USER_ID, sessionEpoch: 1 };
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

// Phase 5.7D-R19: renamed from HAS_COLUMN_OK -- a 7th hasColumn() call
// (team_color) was added alongside duration_minutes/scheduled_end/
// series_id/frequency_type/employee_id/price_cents, so this constant is no
// longer six entries; kept count-agnostic in its name so a future added
// column doesn't require another rename.
// Phase 2 (Monthly Recurring Appointments): an 8th hasColumn() call
// (repeat_months) was added -- same growth pattern as team_color above.
const HAS_COLUMN_OK: FakeSupabaseFixture[] = [{ error: null }, { error: null }, { error: null }, { error: null }, { error: null }, { error: null }, { error: null }, { error: null }];

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
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        company_settings: [{ data: { timezone: null } }],
        subscriptions: [{ data: row }, { data: row }],
        clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: "jane@example.com", phone: "+15551234567", auto_email: true, auto_sms: true } }],
        appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
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
      company_settings: [{ data: { timezone: null } }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Demo Client", email: null, phone: null, auto_email: false, auto_sms: false } }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-demo-1" }] }],
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
      resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: row }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req(authBody()));
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
    const res = await POST(req(authBody()));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), SERVICE_UNAVAILABLE_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table !== "subscriptions" && c.table !== "workspace_memberships"), []);
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
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ workspace_id: DEMO_WORKSPACE_ID })));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  test("a spoofed workspace_id query-string value does not change which workspace's entitlement is checked", async () => {
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody(), "http://localhost/api/appointments/create?workspace_id=attacker-ws"));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  describe("mutation-specific validation runs only after auth/role/entitlement", () => {
    test("missing service_type + restricted workspace -> the exact SUBSCRIPTION_RESTRICTED 403, not 400", async () => {
      resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ scheduled_for: "2026-08-03T14:00:00.000Z" }));
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    });

    test("missing service_type + entitled workspace -> the existing 400 'Missing required fields' response", async () => {
      resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ scheduled_for: "2026-08-03T14:00:00.000Z" }));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Missing required fields" });
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" || c.table === "appointments"), []);
    });
  });
});

describe("Phase 5.7D-R17: appointment price snapshot on create", () => {
  test("a provided price is stored as an integer-cents snapshot on the created row", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ price_cents: 4550, notify_channel: "none" })));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ price_cents?: number | null }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].price_cents, 4550);
  });

  test("Phase 5.7D-R17B: reproduces the exact production scenario -- a $200.00 'Kitchen Renovation' selection sends price_cents: 20000", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ service_type: "Kitchen Renovation", price_cents: 20000, notify_channel: "none" })));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ price_cents?: number | null }>;
    assert.equal(rows[0].price_cents, 20000);
  });

  test("no price provided stores null -- not zero, not omitted", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ notify_channel: "none" })));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ price_cents?: number | null }>;
    assert.equal(rows[0].price_cents, null);
  });

  test("an explicit $0.00 price (integer 0) is stored as 0, distinct from no price", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ price_cents: 0, notify_channel: "none" })));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ price_cents?: number | null }>;
    assert.equal(rows[0].price_cents, 0);
  });

  test("an invalid price is rejected with 400 before any client or appointment write", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ price_cents: -100 })));
    assert.equal(res.status, 400);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" || c.table === "appointments"), []);
  });

  test("every occurrence in a newly created recurring series receives the identical price snapshot", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [
        { data: { id: "client-1" } },
        { data: { id: "client-1", status: "active", archived_at: null } }, // finalizeSeriesActive's own client re-check
        { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } },
      ],
      // repeat_weeks: 26 -> intervalDays 182, generateFutureDates(182-day
      // horizon) yields exactly one future occurrence -- two rows total,
      // small enough to assert on directly.
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }, { id: "appt-new-2" }] }],
      recurring_series: [{ data: null }, { data: [{ id: "series-x" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ price_cents: 7500, frequency_type: "weekly", repeat_weeks: 26, notify_channel: "none" })));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ price_cents?: number | null }>;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.price_cents === 7500));
  });

  test("public booking never stores a price even if price_cents is included in the request body", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true } }],
      services: [{ data: { name: "Haircut", duration_minutes: 45 } }],
      appointments: [{ data: [] }, ...HAS_COLUMN_OK, { data: [{ id: "appt-public-1" }] }],
      clients: [
        { data: null },
        { data: null },
        { data: { id: "new-client-1" } },
        { data: { name: "Jane Public", email: "jane@public.example", phone: "+15559876543", auto_email: true, auto_sms: true } },
      ],
      messages_sent: [{ error: null }, { error: null }],
    });
    sessionToReturn = { role: "none" };
    const res = await POST(req(publicBody({ price_cents: 999999 })));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ price_cents?: number | null }>;
    assert.equal(rows[0].price_cents, null, "public booking must never accept a client-supplied price");
  });
});

describe("Phase 2: Monthly Recurring Appointments on create", () => {
  test("a valid monthly request (repeat_months: 12) generates the origin plus every future occurrence, storing frequency_type/repeat_months on each row", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [
        { data: { id: "client-1" } },
        { data: { id: "client-1", status: "active", archived_at: null } }, // finalizeSeriesActive's own client re-check
        { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } },
      ],
      // repeat_months: 12 -> MAX_MONTHLY_HORIZON_MONTHS (24) / 12 = 2 future
      // occurrences -- three rows total (origin + 2), small enough to assert
      // on directly, same convention as the weekly repeat_weeks: 26 tests
      // above.
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }, { id: "appt-new-2" }, { id: "appt-new-3" }] }],
      recurring_series: [{ data: null }, { data: [{ id: "series-x" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ frequency_type: "monthly", repeat_months: 12, notify_channel: "none" })));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ frequency_type?: string; repeat_months?: number | null; scheduled_for: string }>;
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.frequency_type === "monthly" && r.repeat_months === 12));
    // The origin appointment's own scheduled_for, unmodified.
    assert.equal(rows[0].scheduled_for, "2026-08-03T14:00:00.000Z");
  });

  test("every occurrence in a newly created monthly series receives the identical price snapshot", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [
        { data: { id: "client-1" } },
        { data: { id: "client-1", status: "active", archived_at: null } }, // finalizeSeriesActive's own client re-check
        { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } },
      ],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }, { id: "appt-new-2" }, { id: "appt-new-3" }] }],
      recurring_series: [{ data: null }, { data: [{ id: "series-x" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ frequency_type: "monthly", repeat_months: 12, price_cents: 18500, notify_channel: "none" })));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ price_cents?: number | null }>;
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.price_cents === 18500), "never re-derived from the service default -- every occurrence gets the exact snapshot provided");
  });

  test("a monthly series assigns the same employees (including multiple) to every generated occurrence", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [
        { data: { id: "client-1" } },
        { data: { id: "client-1", status: "active", archived_at: null } }, // finalizeSeriesActive's own client re-check
        { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } },
      ],
      employees: [{ data: [{ id: "teresa" }, { id: "roxana" }] }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }, { id: "appt-new-2" }, { id: "appt-new-3" }] }],
      appointment_employees: [{ data: null, error: null }, { data: null, error: null }, { data: null, error: null }],
      recurring_series: [{ data: null }, { data: [{ id: "series-x" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ frequency_type: "monthly", repeat_months: 12, employee_ids: ["teresa", "roxana"], notify_channel: "none" })));
    assert.equal(res.status, 200);
    const insertCalls = currentFake.calls.filter((c) => c.table === "appointment_employees" && c.method === "insert");
    assert.equal(insertCalls.length, 3, "one assignment-insert call per generated occurrence");
    for (const call of insertCalls) {
      const rows = call.args[0] as Array<{ employee_id: string }>;
      assert.deepEqual(rows.map((r) => r.employee_id), ["teresa", "roxana"]);
    }
  });

  test("missing repeat_months on a monthly request is rejected with 400, before any client or appointment write", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ frequency_type: "monthly" })));
    assert.equal(res.status, 400);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" || c.table === "appointments"), []);
  });

  for (const bad of [0, -1, 1.5, 13, 100, "12", null]) {
    test(`repeat_months=${JSON.stringify(bad)} on a monthly request is rejected with 400 -- never silently falls back to a single one-time appointment`, async () => {
      resetFixtures({
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        company_settings: [{ data: { timezone: null } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req(authBody({ frequency_type: "monthly", repeat_months: bad })));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Repeat interval must be a whole number of months between 1 and 12." });
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" || c.table === "appointments"), []);
    });
  }

  test("a monthly series' notifications are unaffected -- only the first occurrence sends a confirmation, exactly like weekly", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [
        { data: { id: "client-1" } },
        { data: { id: "client-1", status: "active", archived_at: null } }, // finalizeSeriesActive's own client re-check
        { data: { name: "Jane Doe", email: "jane@example.com", phone: "+15551234567", auto_email: true, auto_sms: true } },
      ],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }, { id: "appt-new-2" }, { id: "appt-new-3" }] }],
      messages_sent: [{ error: null }, { error: null }],
      recurring_series: [{ data: null }, { data: [{ id: "series-x" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ frequency_type: "monthly", repeat_months: 12 })));
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls.length, 1, "exactly one confirmation, not one per generated occurrence");
    assert.equal(currentNotify.smsCalls.length, 1);
  });

  test("public booking never accepts monthly recurrence even if frequency_type/repeat_months are included in the request body", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true } }],
      services: [{ data: { name: "Haircut", duration_minutes: 45 } }],
      appointments: [{ data: [] }, ...HAS_COLUMN_OK, { data: [{ id: "appt-public-1" }] }],
      clients: [
        { data: null },
        { data: null },
        { data: { id: "new-client-1" } },
        { data: { name: "Jane Public", email: "jane@public.example", phone: "+15559876543", auto_email: true, auto_sms: true } },
      ],
      messages_sent: [{ error: null }, { error: null }],
    });
    sessionToReturn = { role: "none" };
    const res = await POST(req(publicBody({ frequency_type: "monthly", repeat_months: 3 })));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ frequency_type?: string; repeat_months?: number | null }>;
    assert.equal(rows.length, 1, "public booking is always a single, unrecurring appointment");
    assert.equal(rows[0].frequency_type, "one_time");
    assert.equal(rows[0].repeat_months, null);
  });
});

describe("Phase 5.7D-R19: team_color on create", () => {
  test("a valid hex value is stored, normalized to uppercase", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ team_color: "#2563eb", notify_channel: "none" })));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ team_color?: string | null }>;
    assert.equal(rows[0].team_color, "#2563EB");
  });

  test("no team_color provided stores null", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ notify_channel: "none" })));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ team_color?: string | null }>;
    assert.equal(rows[0].team_color, null);
  });

  test("an invalid team_color is rejected with 400 before any client or appointment write", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ team_color: "not-a-color" })));
    assert.equal(res.status, 400);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" || c.table === "appointments"), []);
  });

  test("every occurrence in a newly created recurring series receives the identical team_color snapshot", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [
        { data: { id: "client-1" } },
        { data: { id: "client-1", status: "active", archived_at: null } }, // finalizeSeriesActive's own client re-check
        { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } },
      ],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }, { id: "appt-new-2" }] }],
      recurring_series: [{ data: null }, { data: [{ id: "series-x" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ team_color: "#16A34A", frequency_type: "weekly", repeat_weeks: 26, notify_channel: "none" })));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ team_color?: string | null }>;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.team_color === "#16A34A"));
  });

  test("public booking never stores a team color even if team_color is included in the request body", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true } }],
      services: [{ data: { name: "Haircut", duration_minutes: 45 } }],
      appointments: [{ data: [] }, ...HAS_COLUMN_OK, { data: [{ id: "appt-public-1" }] }],
      clients: [
        { data: null },
        { data: null },
        { data: { id: "new-client-1" } },
        { data: { name: "Jane Public", email: "jane@public.example", phone: "+15559876543", auto_email: true, auto_sms: true } },
      ],
      messages_sent: [{ error: null }, { error: null }],
    });
    sessionToReturn = { role: "none" };
    const res = await POST(req(publicBody({ team_color: "#DC2626" })));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ team_color?: string | null }>;
    assert.equal(rows[0].team_color, null, "public booking must never accept a client-supplied team color");
  });
});

describe("Phase 5.7D-R18: multi-employee assignment on create", () => {
  test("creating with two employees inserts one appointment_employees row per employee, referencing the created appointment", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } }],
      employees: [{ data: [{ id: "teresa" }, { id: "roxana" }] }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
      appointment_employees: [{ data: null, error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ employee_ids: ["teresa", "roxana"], notify_channel: "none" })));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointment_employees" && c.method === "insert");
    assert.ok(insertCall);
    const rows = insertCall!.args[0] as Array<{ appointment_id: string; employee_id: string; workspace_id: string }>;
    assert.deepEqual(rows.map((r) => r.employee_id), ["teresa", "roxana"]);
    assert.ok(rows.every((r) => r.appointment_id === "appt-new-1" && r.workspace_id === REAL_WORKSPACE_ID));
  });

  test("exactly one employee dual-writes appointments.employee_id to that employee's id", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } }],
      employees: [{ data: [{ id: "teresa" }] }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
      appointment_employees: [{ data: null, error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ employee_ids: ["teresa"], notify_channel: "none" })));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ employee_id?: string | null }>;
    assert.equal(rows[0].employee_id, "teresa");
  });

  test("two or more employees dual-write appointments.employee_id to null -- never an arbitrary 'primary' pick", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } }],
      employees: [{ data: [{ id: "teresa" }, { id: "roxana" }] }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
      appointment_employees: [{ data: null, error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ employee_ids: ["teresa", "roxana"], notify_channel: "none" })));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ employee_id?: string | null }>;
    assert.equal(rows[0].employee_id, null);
  });

  test("zero employees -> no appointment_employees insert call at all, appointments.employee_id is null", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ notify_channel: "none" })));
    assert.equal(res.status, 200);
    assert.equal(currentFake.calls.filter((c) => c.table === "appointment_employees").length, 0);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ employee_id?: string | null }>;
    assert.equal(rows[0].employee_id, null);
  });

  test("an employee_id not belonging to this workspace is rejected with 404 before any appointment write", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }],
      employees: [{ data: [] }], // neither ID found in this workspace
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ employee_ids: ["cross-workspace-emp"] })));
    assert.equal(res.status, 404);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments"), []);
  });

  test("duplicate employee_ids in the request are deduped -- exactly one assignment row per unique employee", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } }],
      employees: [{ data: [{ id: "teresa" }] }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
      appointment_employees: [{ data: null, error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ employee_ids: ["teresa", "teresa"], notify_channel: "none" })));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointment_employees" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ employee_id: string }>;
    assert.equal(rows.length, 1);
  });

  test("a recurring series assigns the same employees to every generated occurrence, not recomputed per date", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [
        { data: { id: "client-1" } },
        { data: { id: "client-1", status: "active", archived_at: null } }, // finalizeSeriesActive's own client re-check
        { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } },
      ],
      employees: [{ data: [{ id: "teresa" }, { id: "roxana" }] }],
      // repeat_weeks: 26 -> intervalDays 182, generateFutureDates yields
      // exactly one future occurrence -- two rows total (matches the
      // existing price-snapshot recurrence test's fixture shape).
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }, { id: "appt-new-2" }] }],
      appointment_employees: [{ data: null, error: null }, { data: null, error: null }],
      recurring_series: [{ data: null }, { data: [{ id: "series-x" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ employee_ids: ["teresa", "roxana"], frequency_type: "weekly", repeat_weeks: 26, notify_channel: "none" })));
    assert.equal(res.status, 200);
    const insertCalls = currentFake.calls.filter((c) => c.table === "appointment_employees" && c.method === "insert");
    assert.equal(insertCalls.length, 2);
    const apptIds = insertCalls.map((c) => (c.args[0] as Array<{ appointment_id: string }>)[0].appointment_id);
    assert.deepEqual(apptIds, ["appt-new-1", "appt-new-2"]);
    for (const call of insertCalls) {
      const rows = call.args[0] as Array<{ employee_id: string }>;
      assert.deepEqual(rows.map((r) => r.employee_id), ["teresa", "roxana"]);
    }
  });

  test("public booking never assigns any employee even if employee_ids is included in the request body", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true } }],
      services: [{ data: { name: "Haircut", duration_minutes: 45 } }],
      appointments: [{ data: [] }, ...HAS_COLUMN_OK, { data: [{ id: "appt-public-1" }] }],
      clients: [
        { data: null },
        { data: null },
        { data: { id: "new-client-1" } },
        { data: { name: "Jane Public", email: "jane@public.example", phone: "+15559876543", auto_email: true, auto_sms: true } },
      ],
      messages_sent: [{ error: null }, { error: null }],
    });
    sessionToReturn = { role: "none" };
    const res = await POST(req(publicBody({ employee_ids: ["teresa"] })));
    assert.equal(res.status, 200);
    assert.equal(currentFake.calls.filter((c) => c.table === "appointment_employees").length, 0);
    assert.equal(currentFake.calls.filter((c) => c.table === "employees").length, 0);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ employee_id?: string | null }>;
    assert.equal(rows[0].employee_id, null);
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
        appointments: [{ data: [] }, ...HAS_COLUMN_OK, { data: [{ id: "appt-public-1" }] }],
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
      assert.deepEqual(currentFake.calls.filter((c) => c.table !== "subscriptions" && c.table !== "workspace_memberships"), [], label);
      assert.equal(currentNotify.emailCalls.length, 0, label);
      assert.equal(currentNotify.smsCalls.length, 0, label);
    });
  }

  test("query_error on the subscriptions read denies, zero operational reads, zero provider calls", async () => {
    resetFixtures({ subscriptions: [{ error: { message: "simulated DB error" } }] });
    sessionToReturn = { role: "none" };
    const res = await POST(req(publicBody()));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), SERVICE_UNAVAILABLE_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table !== "subscriptions" && c.table !== "workspace_memberships"), []);
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

describe("Phase 4: Business Hours enforcement on public create (owner/tester remain exempt)", () => {
  test("public booking inside the workspace's saved business hours succeeds", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true, business_hours: { monday: [{ start: "08:00", end: "18:00" }] } } }],
      services: [{ data: { name: "Haircut", duration_minutes: 45 } }],
      appointments: [{ data: [] }, ...HAS_COLUMN_OK, { data: [{ id: "appt-public-1" }] }],
      clients: [
        { data: null },
        { data: null },
        { data: { id: "new-client-1" } },
        { data: { name: "Jane Public", email: "jane@public.example", phone: "+15559876543", auto_email: true, auto_sms: true } },
      ],
      messages_sent: [{ error: null }, { error: null }],
    });
    sessionToReturn = { role: "none" };
    const res = await POST(req(publicBody()));
    assert.equal(res.status, 200);
  });

  test("public booking on a day the workspace has marked Closed is rejected with 400, before any client or appointment write", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true, business_hours: { monday: [] } } }],
      services: [{ data: { name: "Haircut", duration_minutes: 45 } }],
    });
    sessionToReturn = { role: "none" };
    const res = await POST(req(publicBody()));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "That time is outside business hours. Please choose another time." });
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" || c.table === "appointments"), []);
  });

  test("public booking outside the workspace's saved hours (before opening) is rejected with 400", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true, business_hours: { monday: [{ start: "12:00", end: "17:00" }] } } }],
      services: [{ data: { name: "Haircut", duration_minutes: 45 } }],
    });
    sessionToReturn = { role: "none" };
    // publicBody()'s default scheduled_for is 2026-08-03T14:00:00.000Z, 10:00am ET -- before the 12:00 open.
    const res = await POST(req(publicBody()));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "That time is outside business hours. Please choose another time." });
  });

  test("public booking that starts within the saved range but crosses its end is rejected with 400", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true, business_hours: { monday: [{ start: "08:00", end: "12:00" }] } } }],
      services: [{ data: { name: "Haircut", duration_minutes: 90 } }],
    });
    sessionToReturn = { role: "none" };
    // 11:00am ET start + 90 minutes = 12:30pm ET, crossing the 12:00 close.
    const res = await POST(req(publicBody({ scheduled_for: "2026-08-03T15:00:00.000Z" })));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "That time is outside business hours. Please choose another time." });
  });

  test("owner-created appointments remain exempt from Business Hours entirely -- a time far outside any plausible saved range still succeeds", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    // 10:00pm ET -- well outside any plausible saved business hours. Phase
    // 5D: the owner branch now queries company_settings once too, but only
    // to resolve the trusted timezone for recurrence generation -- the
    // fixture above deliberately omits business_hours entirely, proving
    // isWithinBusinessHours is still never consulted for this branch.
    const res = await POST(req(authBody({ scheduled_for: "2026-08-04T02:00:00.000Z", notify_channel: "none" })));
    assert.equal(res.status, 200);
  });
});

describe("notification behavior is preserved exactly once entitled, on both branches", () => {
  test("authenticated: a provider failure on one channel is isolated -- the other channel still attempts, mutation still succeeds", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: "jane@example.com", phone: "+15551234567", auto_email: true, auto_sms: true } }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
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
      appointments: [{ data: [] }, ...HAS_COLUMN_OK, { data: [{ id: "appt-public-1" }] }],
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
      appointments: [{ data: [] }, ...HAS_COLUMN_OK, { data: [{ id: "appt-public-2" }] }],
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

describe("confirmation notifications identify the workspace's own business, not generic ScheduleFlowTrack branding", () => {
  test("confirmation email uses the workspace's company name as both the From display name and the body sign-off", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: "jane@example.com", phone: "+15551234567", auto_email: true, auto_sms: true } }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-2" }] }],
      messages_sent: [{ error: null }, { error: null }],
    });
    currentNotify.setCompanyName("Sunshine Cleaning Co.");
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody()));
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls.length, 1);
    assert.equal(currentNotify.emailCalls[0].fromDisplayName, "Sunshine Cleaning Co.");
    assert.ok(currentNotify.emailCalls[0].text.includes("Sunshine Cleaning Co."));
    assert.ok(!currentNotify.emailCalls[0].text.includes("ScheduleFlowTrack"), "the generic platform sign-off must be replaced, not merely supplemented");
  });

  test("Phase 5E: confirmation email/SMS format the appointment time in the workspace's own resolved timezone, not a hardcoded Eastern default", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: "America/Los_Angeles" } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: "jane@example.com", phone: "+15551234567", auto_email: true, auto_sms: true } }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-tz" }] }],
      messages_sent: [{ error: null }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    // authBody()'s default scheduled_for is 2026-08-03T14:00:00.000Z --
    // 10:00 AM Eastern, but 7:00 AM Pacific for this LA workspace.
    const res = await POST(req(authBody()));
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls.length, 1);
    assert.ok(currentNotify.emailCalls[0].text.includes("7:00 AM"), currentNotify.emailCalls[0].text);
    assert.ok(!currentNotify.emailCalls[0].text.includes("10:00 AM"));
    assert.ok(currentNotify.smsCalls[0].body.includes("7:00 AM"));
  });

  test("confirmation SMS body identifies the business by name", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: "jane@example.com", phone: "+15551234567", auto_email: true, auto_sms: true } }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-3" }] }],
      messages_sent: [{ error: null }, { error: null }],
    });
    currentNotify.setCompanyName("Sunshine Cleaning Co.");
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody()));
    assert.equal(res.status, 200);
    assert.equal(currentNotify.smsCalls.length, 1);
    const body = currentNotify.smsCalls[0].body;
    assert.ok(body.startsWith("Sunshine Cleaning Co.:"), "the business name should be immediately visible at the start of the SMS");
    assert.equal(body.split("Sunshine Cleaning Co.").length - 1, 1, "the business name must appear exactly once -- no duplicate trailing sign-off");
    assert.ok(!body.includes("Thank you,"), "the trailing sign-off line was removed for SMS specifically (kept for email)");
  });

  test("a workspace with no company name set falls back to ScheduleFlowTrack rather than breaking the notification", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: "jane@example.com", phone: "+15551234567", auto_email: true, auto_sms: true } }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-4" }] }],
      messages_sent: [{ error: null }, { error: null }],
    });
    // Deliberately not calling setCompanyName -- exercises the fake's own
    // default, which mirrors the real getCompanyName's fallback.
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody()));
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls[0].fromDisplayName, "ScheduleFlowTrack");
    assert.ok(currentNotify.smsCalls[0].body.startsWith("ScheduleFlowTrack:"));
  });
});

describe("Phase 5.5E-C: canSendNotifications gate on the post-mutation confirmation, independent of the mutation capability", () => {
  test("authenticated: mutation allowed, notification denied -> creation succeeds unchanged, zero provider calls, zero messages_sent, notify client re-fetch skipped", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [
        { data: subscriptionRow({ stripe_status: "active" }) }, // canMutateOperationalData: allowed
        { data: subscriptionRow({ stripe_status: "canceled" }) }, // canSendNotifications: denied
      ],
      clients: [{ data: { id: "client-1" } }], // only the client_id validation lookup -- no notify re-fetch
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
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
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [
        { data: subscriptionRow({ stripe_status: "active" }) },
        { error: { message: "simulated DB error" } },
      ],
      clients: [{ data: { id: "client-1" } }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
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
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [
        { data: subscriptionRow({ stripe_status: "active" }) },
        { data: subscriptionRow({ stripe_status: "canceled" }) },
      ],
      clients: [{ data: { id: "client-1" } }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
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
      appointments: [{ data: [] }, ...HAS_COLUMN_OK, { data: [{ id: "appt-public-1" }] }],
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
      company_settings: [{ data: { timezone: null } }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Demo Client", email: null, phone: null, auto_email: false, auto_sms: false } }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-demo-1" }] }],
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

describe("Phase 5D: trusted workspace timezone drives Business Hours enforcement and recurrence generation", () => {
  test("a saved non-default timezone (Pacific) actually changes whether a given instant is within Business Hours -- 8:00 AM New York (within default hours) is 5:00 AM Pacific (before opening) for an LA workspace", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true, timezone: "America/Los_Angeles" } }],
      services: [{ data: { name: "Haircut", duration_minutes: 45 } }],
    });
    sessionToReturn = { role: "none" };
    // 2026-08-03T12:00:00.000Z = 8:00 AM ET (within default hours) but
    // 5:00 AM PT (before the 7:00 AM PT open) -- proves the check actually
    // ran against the workspace's OWN saved timezone, not a hardcoded NY
    // assumption.
    const res = await POST(req(publicBody({ scheduled_for: "2026-08-03T12:00:00.000Z" })));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "That time is outside business hours. Please choose another time." });
  });

  test("the same instant is accepted for the default (NY) workspace timezone -- proves the LA rejection above is genuinely timezone-driven, not a fixed-hour coincidence", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true } }],
      services: [{ data: { name: "Haircut", duration_minutes: 45 } }],
      appointments: [{ data: [] }, ...HAS_COLUMN_OK, { data: [{ id: "appt-public-1" }] }],
      clients: [
        { data: null },
        { data: null },
        { data: { id: "new-client-1" } },
        { data: { name: "Jane Public", email: "jane@public.example", phone: "+15559876543", auto_email: true, auto_sms: true } },
      ],
      messages_sent: [{ error: null }, { error: null }],
    });
    sessionToReturn = { role: "none" };
    const res = await POST(req(publicBody({ scheduled_for: "2026-08-03T12:00:00.000Z" })));
    assert.equal(res.status, 200);
  });

  test("a timezone field included in the request body is silently ignored -- there is no such input the caller can spoof", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true, timezone: "America/Los_Angeles" } }],
      services: [{ data: { name: "Haircut", duration_minutes: 45 } }],
    });
    sessionToReturn = { role: "none" };
    const res = await POST(req(publicBody({ scheduled_for: "2026-08-03T12:00:00.000Z", timezone: "America/New_York" })));
    assert.equal(res.status, 400, "the spoofed body timezone must not override the trusted, server-resolved LA timezone");
  });

  test("a recurring series whose generated occurrence lands on a nonexistent DST local time is rejected atomically -- 400, zero appointment/assignment writes", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }],
      appointments: [...HAS_COLUMN_OK],
    });
    sessionToReturn = OWNER_SESSION;
    // 2026-02-22T07:30:00.000Z = 2:30 AM New York (a Sunday). +1 week lands
    // on 2026-03-08 2:30 AM New York -- the exact spring-forward gap.
    const res = await POST(req(authBody({
      scheduled_for: "2026-02-22T07:30:00.000Z",
      frequency_type: "weekly",
      repeat_weeks: 1,
      notify_channel: "none",
    })));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /daylight-saving/);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments" && c.method === "insert"), []);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointment_employees"), []);
  });

  test("the exact same origin/frequency succeeds for a workspace timezone that doesn't hit the gap (Arizona, no DST)", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: "America/Phoenix" } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [
        { data: { id: "client-1" } },
        { data: { id: "client-1", status: "active", archived_at: null } }, // finalizeSeriesActive's own client re-check
        { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } },
      ],
      // 182-day horizon / 7-day interval = 26 future occurrences, +1 origin = 27 rows.
      appointments: [...HAS_COLUMN_OK, { data: Array.from({ length: 27 }, (_, i) => ({ id: `appt-${i}` })) }],
      recurring_series: [{ data: null }, { data: [{ id: "series-x" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({
      scheduled_for: "2026-02-22T09:30:00.000Z", // 2:30 AM Arizona (no DST, never a gap)
      frequency_type: "weekly",
      repeat_weeks: 1,
      notify_channel: "none",
    })));
    assert.equal(res.status, 200);
  });
});

describe("Block 2B safety correction: a new recurring series is inserted quarantined, then finalized active", () => {
  test("a brand-new weekly series inserts a review_required row BEFORE any appointment write, then finalizes it active with the first occurrence as its template", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [
        { data: { id: "client-1" } },
        { data: { id: "client-1", status: "active", archived_at: null } }, // finalizeSeriesActive's own client re-check
        { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } },
      ],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }, { id: "appt-new-2" }] }],
      recurring_series: [{ data: null }, { data: [{ id: "series-x" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ frequency_type: "weekly", repeat_weeks: 4, notify_channel: "none" })));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.warning, undefined);

    const insertCall = currentFake.calls.find((c) => c.table === "recurring_series" && c.method === "insert");
    assert.ok(insertCall, "expected an insert into recurring_series");
    const insertedRow = insertCall!.args[0] as Record<string, unknown>;
    assert.equal(insertedRow.status, "review_required");
    assert.equal(insertedRow.source, "owner_created");
    assert.equal(insertedRow.template_appointment_id, null);
    assert.equal(insertedRow.reviewed_at, null);
    assert.equal(insertedRow.frequency_type, "weekly");
    assert.equal(insertedRow.repeat_weeks, 4);
    assert.equal(insertedRow.repeat_months, null);
    assert.equal(insertedRow.client_id, "client-1");
    assert.equal(insertedRow.is_demo, false);

    const updateCall = currentFake.calls.find((c) => c.table === "recurring_series" && c.method === "update");
    assert.ok(updateCall, "expected a finalize-active update on recurring_series");
    const patch = updateCall!.args[0] as Record<string, unknown>;
    assert.equal(patch.status, "active");
    assert.equal(patch.template_appointment_id, "appt-new-1"); // the first inserted row's id
    assert.ok(patch.reviewed_at);

    // The insert must happen before the finalize update, and both before the
    // appointment insert's assignment work would matter -- the insert call
    // is recorded strictly earlier in the call log than the update call.
    const insertIdx = currentFake.calls.indexOf(insertCall!);
    const updateIdx = currentFake.calls.indexOf(updateCall!);
    assert.ok(insertIdx < updateIdx);
  });

  test("a one-time appointment (no recurrence) never touches recurring_series at all", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } }],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ notify_channel: "none" })));
    assert.equal(res.status, 200);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "recurring_series"), []);
  });

  test("failure injection: a registry-insert failure aborts BEFORE any appointment row is written, and returns a generic, retry-safe error", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { id: "client-1" } }, { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } }],
      appointments: HAS_COLUMN_OK,
      recurring_series: [{ error: { message: "simulated insert failure" } }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ frequency_type: "weekly", repeat_weeks: 4, notify_channel: "none" })));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes("simulated insert failure"), "must not leak the raw database error");
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments" && c.method === "insert"), []);
  });

  test("failure injection: a registry finalize-active failure still returns the successful appointment creation, with a structured warning attached", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [
        { data: { id: "client-1" } },
        { data: { id: "client-1", status: "active", archived_at: null } }, // finalizeSeriesActive's own client re-check
        { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } },
      ],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }, { id: "appt-new-2" }] }],
      recurring_series: [{ data: null }, { error: { message: "simulated finalize failure" } }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ frequency_type: "weekly", repeat_weeks: 4, notify_channel: "none" })));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.appointmentId, "the appointment mutation itself must not be retried or reported as failed");
    assert.ok(body.warning, "expected a structured warning on the still-successful response");
    assert.equal(body.warning.code, "recurring_series_review_required");
    assert.ok(!JSON.stringify(body.warning).includes("simulated finalize failure"), "must not leak the raw database error");
  });

  test("race: the client became inactive between resolution and finalize -- the new series stays review_required, appointment creation still succeeds with a warning", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: { timezone: null } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }, { data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [
        { data: { id: "client-1" } }, // client resolution
        { data: { id: "client-1", status: "inactive", archived_at: null } }, // finalizeSeriesActive's own re-check -- client went inactive concurrently
        { data: { name: "Jane Doe", email: null, phone: null, auto_email: false, auto_sms: false } },
      ],
      appointments: [...HAS_COLUMN_OK, { data: [{ id: "appt-new-1" }, { id: "appt-new-2" }] }],
      recurring_series: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(authBody({ frequency_type: "weekly", repeat_weeks: 4, notify_channel: "none" })));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.appointmentId, "the appointment mutation itself must not be blocked or retried");
    assert.ok(body.warning);
    assert.equal(body.warning.code, "recurring_series_review_required");
    // No finalize-active update was ever attempted -- the client check
    // short-circuits before the compare-and-set write.
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "update"), []);
  });
});
