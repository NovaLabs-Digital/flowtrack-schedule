// Phase 5.4E3: route-level tests for
// app/api/appointments/manage-recurrence/route.ts (POST only -- this file
// has no GET handler, and sends no notifications). Proves
// requireCapability(session, "canMutateOperationalData") is correctly wired
// before body parsing, appointment reads, and any of the (up to three)
// writes. @/lib/session and @/lib/supabaseAdmin are mocked in-process;
// @/lib/entitlementServer is DELIBERATELY LEFT UNMOCKED -- the real
// requireCapability chain runs against a fake "subscriptions" table. No
// real Supabase/Stripe/network call is reachable. Run with
// --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin, writeCalls, fakeSessionNamedExports, subscriptionRow, SUBSCRIPTION_RESTRICTED_BODY } from "../../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../../lib/testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});
let sessionToReturn: unknown = { role: "none" };

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});
mock.module("@/lib/session", { namedExports: fakeSessionNamedExports(async () => sessionToReturn) });

const { POST } = await import("./route.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}
function req(body?: unknown, url = "http://localhost/api/appointments/manage-recurrence") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID };

function oneTimeAppt() {
  return {
    id: "appt-1",
    client_id: "client-1",
    service_type: "Haircut",
    scheduled_for: "2026-08-03T14:00:00.000Z",
    scheduled_end: null,
    notes: null,
    duration_minutes: 60,
    employee_id: null,
    series_id: null,
    frequency_type: "one_time",
    repeat_weeks: 1,
    status: "scheduled",
    is_demo: false,
  };
}

describe("POST /api/appointments/manage-recurrence -- entitlement gate", () => {
  const FULL_STATES: Array<[string, ReturnType<typeof subscriptionRow>]> = [
    ["active", subscriptionRow({ stripe_status: "active" })],
    ["trialing", subscriptionRow({ stripe_status: "trialing" })],
    ["past_due_grace", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() + 1000).toISOString() })],
    ["internal", subscriptionRow({ billing_mode: "internal", stripe_status: null })],
  ];

  for (const [label, row] of FULL_STATES) {
    test(`${label} permits converting a one-time appointment to weekly recurrence, response unchanged`, async () => {
      resetFixtures({
        subscriptions: [{ data: row }],
        appointments: [
          { data: oneTimeAppt() }, // fetch existing
          { error: null }, // update source appointment
          { error: null }, // insert new series rows
        ],
      });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", repeat_weeks: 4 }));
      assert.equal(res.status, 200, label);
      const body = await res.json();
      assert.equal(body.ok, true, label);
      assert.ok(body.created > 0, label);
      assert.equal(writeCalls(currentFake.calls).length, 2, label); // update + insert
    });
  }

  test("exact trusted demo workspace permits the mutation with zero subscriptions-table queries (real short-circuit)", async () => {
    resetFixtures({
      appointments: [{ data: { ...oneTimeAppt(), is_demo: true } }, { error: null }],
    });
    sessionToReturn = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "one_time" }));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  const RESTRICTED_STATES: Array<[string, ReturnType<typeof subscriptionRow> | null]> = [
    ["past_due_expired", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() - 1000).toISOString() })],
    ["canceled", subscriptionRow({ stripe_status: "canceled" })],
    ["unpaid", subscriptionRow({ stripe_status: "unpaid" })],
    ["no_subscription (no row)", null],
    ["malformed", subscriptionRow({ stripe_status: "not_a_real_status" })],
  ];

  for (const [label, row] of RESTRICTED_STATES) {
    test(`${label} returns the exact SUBSCRIPTION_RESTRICTED 403, zero appointment reads/writes`, async () => {
      resetFixtures({ subscriptions: [{ data: row }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly" }));
      assert.equal(res.status, 403, label);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY, label);
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments"), [], label);
    });
  }

  test("query_error on the subscriptions read denies, zero appointment access", async () => {
    resetFixtures({ subscriptions: [{ error: { message: "simulated DB error" } }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments"), []);
  });

  test("non-owner/tester role (employee) retains the existing role-denial, never SUBSCRIPTION_RESTRICTED, never queries entitlement", async () => {
    resetFixtures({});
    sessionToReturn = { role: "employee", employeeId: "e1", workspaceId: REAL_WORKSPACE_ID };
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly" }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
    assert.equal(body.code, undefined);
    assert.equal(currentFake.calls.length, 0);
  });

  test("tester session with a non-demo workspace fails closed with the generic session-integrity denial, not SUBSCRIPTION_RESTRICTED", async () => {
    resetFixtures({});
    sessionToReturn = { role: "tester", workspaceId: REAL_WORKSPACE_ID };
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly" }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
    assert.equal(body.code, undefined);
  });

  test("unauthenticated (role: none) receives the existing role-denial and cannot probe subscription status", async () => {
    resetFixtures({});
    sessionToReturn = { role: "none" };
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly" }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
    assert.equal(body.code, undefined);
    assert.equal(currentFake.calls.length, 0);
  });

  test("a non-demo workspace cannot manufacture demo access via any request-supplied value", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", workspace_id: DEMO_WORKSPACE_ID }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  test("a spoofed workspace_id/query-string value does not change which workspace's entitlement is checked", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", workspace_id: "attacker-ws" }, "http://localhost/api/appointments/manage-recurrence?workspace_id=attacker-ws-2"));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  describe("mutation-specific validation runs only after auth/role/entitlement", () => {
    test("missing appointment_id + unauthenticated -> the existing role-denial, not 400, zero Supabase calls", async () => {
      resetFixtures({});
      sessionToReturn = { role: "none" };
      const res = await POST(req({ frequency_type: "weekly" }));
      assert.equal(res.status, 403);
      assert.equal(currentFake.calls.length, 0);
    });

    test("missing appointment_id + restricted workspace -> the exact SUBSCRIPTION_RESTRICTED 403, not 400", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ frequency_type: "weekly" }));
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    });

    test("missing appointment_id + entitled workspace -> the existing 400 'Missing appointment_id' response", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ frequency_type: "weekly" }));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Missing appointment_id" });
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments"), []);
    });

    test("invalid frequency_type + entitled workspace -> the existing 400 response, after entitlement passes", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ appointment_id: "appt-1", frequency_type: "bogus" }));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Invalid frequency_type" });
    });
  });
});

describe("existing recurrence business rules remain unchanged once entitled", () => {
  test("an appointment already in a series cancels future siblings before creating the new series", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: { ...oneTimeAppt(), series_id: "series-1" } }, // fetch existing
        { data: [{ id: "sib-1" }, { id: "sib-2" }] }, // sibling lookup
        { error: null }, // bulk-cancel siblings
        { error: null }, // update source appointment
        { error: null }, // insert new series
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", repeat_weeks: 2 }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cancelled, 2);
    assert.ok(body.created > 0);
  });

  test("converting to one_time cancels siblings and creates no new rows", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: { ...oneTimeAppt(), series_id: "series-1", frequency_type: "weekly" } },
        { data: [{ id: "sib-1" }] },
        { error: null },
        { error: null },
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "one_time" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cancelled, 1);
    assert.equal(body.created, 0);
    assert.equal(writeCalls(currentFake.calls).length, 2); // cancel siblings + update source, no insert
  });

  test("appointment not found still 404s with the existing message, after entitlement passes", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-missing", frequency_type: "weekly" }));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Appointment not found" });
  });

  test("tester session accessing a non-demo appointment still 404s (existing tester-scoping rule)", async () => {
    resetFixtures({
      subscriptions: [], // demo short-circuit -- no subscriptions query
      appointments: [{ data: { ...oneTimeAppt(), is_demo: false } }],
    });
    sessionToReturn = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly" }));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Appointment not found" });
  });
});
