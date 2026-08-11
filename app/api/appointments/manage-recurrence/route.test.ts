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
import { createFakeSupabaseAdmin, writeCalls, fakeSessionNamedExports, subscriptionRow, SUBSCRIPTION_RESTRICTED_BODY, SERVICE_UNAVAILABLE_BODY } from "../../../../lib/testSupport.ts";
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

const { POST } = await import("./route.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>, rpcResponses: Record<string, FakeSupabaseFixture[]> = {}) {
  currentFake = createFakeSupabaseAdmin(responses, rpcResponses);
}
function req(body?: unknown, url = "http://localhost/api/appointments/manage-recurrence") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const OWNER_AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";
const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID, authUserId: OWNER_AUTH_USER_ID, sessionEpoch: 1 };

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
    repeat_months: null,
    status: "scheduled",
    is_demo: false,
    price_cents: 5000,
    team_color: "#2563EB",
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
      resetFixtures(
        {
          workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
          subscriptions: [{ data: row }],
          company_settings: [{ data: { timezone: null } }],
          appointments: [
            { data: oneTimeAppt() }, // fetch existing
            { error: null }, // update source appointment
            { data: [{ id: "new-1" }] }, // insert new series rows (.select("id"))
          ],
          appointment_employees: [{ data: [] }], // fetchAssignments(origin) -- unassigned
          // Block 2B/2C-1 safety correction: a one-time appointment has no
          // old series_id, so the pre-mutation quarantine/post-mutation stop
          // steps never run here -- only the new series' two-step
          // insert-quarantined then activate_recurring_series RPC call. The
          // client re-check now happens entirely inside the RPC's own
          // locked transaction, opaque to this fake.
          recurring_series: [{ data: null }],
        },
        { activate_recurring_series: [{ data: "activated" }] }
      );
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", repeat_weeks: 4 }));
      assert.equal(res.status, 200, label);
      const body = await res.json();
      assert.equal(body.ok, true, label);
      assert.equal(body.warning, undefined, label);
      assert.ok(body.created > 0, label);
      assert.equal(writeCalls(currentFake.calls).length, 3, label); // update appt + insert new rows + registry insert (activation RPC is not a `.from()` write call)
    });
  }

  test("exact trusted demo workspace permits the mutation with zero subscriptions-table queries (real short-circuit)", async () => {
    resetFixtures({
      appointments: [{ data: { ...oneTimeAppt(), is_demo: true } }, { error: null }],
      appointment_employees: [{ data: [] }],
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
      resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: row }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly" }));
      assert.equal(res.status, 403, label);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY, label);
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments"), [], label);
    });
  }

  test("query_error on the subscriptions read denies, zero appointment access", async () => {
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ error: { message: "simulated DB error" } }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly" }));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), SERVICE_UNAVAILABLE_BODY);
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
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", workspace_id: DEMO_WORKSPACE_ID }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  test("a spoofed workspace_id/query-string value does not change which workspace's entitlement is checked", async () => {
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
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
      resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ frequency_type: "weekly" }));
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    });

    test("missing appointment_id + entitled workspace -> the existing 400 'Missing appointment_id' response", async () => {
      resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ frequency_type: "weekly" }));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Missing appointment_id" });
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments"), []);
    });

    test("invalid frequency_type + entitled workspace -> the existing 400 response, after entitlement passes", async () => {
      resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
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
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: null } }],
      appointments: [
        { data: { ...oneTimeAppt(), series_id: "series-1" } }, // fetch existing
        { data: [{ id: "sib-1" }, { id: "sib-2" }] }, // sibling lookup
        { error: null }, // bulk-cancel siblings
        { error: null }, // update source appointment
        { data: [{ id: "new-1" }] }, // insert new series (.select("id"))
      ],
      appointment_employees: [{ data: [] }],
      // Block 2B/2C-1 safety correction: the old series' quarantine is now
      // observe-then-CAS -- fetchSeriesById (observing "active") is its own
      // read, immediately followed by the active -> review_required
      // compare-and-set -- then finalize-stopped (after mutation), then the
      // new series' insert-quarantined, then the atomic activation RPC call
      // (opaque to this fake -- its own client re-check happens inside the
      // RPC's locked transaction, never a separate clients fixture here).
      recurring_series: [
        { data: { id: "series-1", status: "active" } }, // observe old series status
        { data: [{ id: "series-1" }] }, // quarantine old (active -> review_required)
        { data: [{ id: "series-1" }] }, // finalize old stopped
        { data: null }, // insert new quarantined
      ],
    }, { activate_recurring_series: [{ data: "activated" }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", repeat_weeks: 2 }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cancelled, 2);
    assert.ok(body.created > 0);
    assert.equal(body.warning, undefined);
  });

  test("converting to one_time cancels siblings and creates no new rows", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: { ...oneTimeAppt(), series_id: "series-1", frequency_type: "weekly" } },
        { data: [{ id: "sib-1" }] },
        { error: null },
        { error: null },
      ],
      appointment_employees: [{ data: [] }],
      // Block 2B safety correction: converting to one_time observes the old
      // series as active, quarantines it BEFORE the cancellation/update,
      // then finalizes it stopped after -- no new one is created, since
      // it's no longer recurring.
      recurring_series: [
        { data: { id: "series-1", status: "active" } }, // observe old series status
        { data: [{ id: "series-1" }] }, // quarantine old (active -> review_required)
        { data: [{ id: "series-1" }] }, // finalize old stopped
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "one_time" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cancelled, 1);
    assert.equal(body.created, 0);
    assert.equal(body.warning, undefined);
    assert.equal(writeCalls(currentFake.calls).length, 4); // cancel siblings + update source + quarantine old + finalize old stopped
  });

  test("appointment not found still 404s with the existing message, after entitlement passes", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
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

describe("Phase 5.7D-R17: newly generated recurring rows receive the origin appointment's price snapshot", () => {
  test("every generated future row copies the origin appointment's own price_cents, not the service's current default", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: null } }],
      appointments: [
        { data: oneTimeAppt() }, // price_cents: 5000
        { error: null }, // update source appointment
        { data: [{ id: "new-1" }] }, // insert new series rows (.select("id"))
      ],
      appointment_employees: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", repeat_weeks: 26 }));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ price_cents?: number | null }>;
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.price_cents === 5000));
  });

  test("an origin appointment with no price generates rows with price_cents: null, never a fabricated value", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: null } }],
      appointments: [
        { data: { ...oneTimeAppt(), price_cents: null } },
        { error: null },
        { data: [{ id: "new-1" }] },
      ],
      appointment_employees: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", repeat_weeks: 26 }));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ price_cents?: number | null }>;
    assert.ok(rows.every((r) => r.price_cents === null));
  });
});

describe("Phase 5.7D-R19: newly generated recurring rows receive the origin appointment's team_color snapshot", () => {
  test("every generated future row copies the origin appointment's own team_color", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: null } }],
      appointments: [
        { data: oneTimeAppt() }, // team_color: "#2563EB"
        { error: null }, // update source appointment
        { data: [{ id: "new-1" }] }, // insert new series rows (.select("id"))
      ],
      appointment_employees: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", repeat_weeks: 26 }));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ team_color?: string | null }>;
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.team_color === "#2563EB"));
  });

  test("an origin appointment with no team color generates rows with team_color: null, never a fabricated value", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: null } }],
      appointments: [
        { data: { ...oneTimeAppt(), team_color: null } },
        { error: null },
        { data: [{ id: "new-1" }] },
      ],
      appointment_employees: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", repeat_weeks: 26 }));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ team_color?: string | null }>;
    assert.ok(rows.every((r) => r.team_color === null));
  });
});

describe("Phase 5.7D-R18: newly generated recurring rows receive the origin appointment's full assignment set", () => {
  test("every generated future row gets the same set of assigned employees as the origin, and appointments.employee_id mirrors null for two employees", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: null } }],
      appointments: [
        { data: oneTimeAppt() },
        { error: null }, // update source appointment
        { data: [{ id: "new-1" }, { id: "new-2" }] }, // insert new series rows (.select("id"))
      ],
      appointment_employees: [
        { data: [
          { id: "ae-1", appointment_id: "appt-1", employee_id: "teresa", actual_started_at: null, actual_completed_at: null, created_at: "x", updated_at: "x" },
          { id: "ae-2", appointment_id: "appt-1", employee_id: "roxana", actual_started_at: null, actual_completed_at: null, created_at: "x", updated_at: "x" },
        ] }, // fetchAssignments(origin)
        { data: null, error: null }, // insertAssignments(new-1)
        { data: null, error: null }, // insertAssignments(new-2)
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", repeat_weeks: 26 }));
    assert.equal(res.status, 200);

    const insertApptCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const apptRows = insertApptCall!.args[0] as Array<{ employee_id?: string | null }>;
    assert.ok(apptRows.every((r) => r.employee_id === null), "two assigned employees -> legacy mirror is null, never an arbitrary pick");

    const assignmentInsertCalls = currentFake.calls.filter((c) => c.table === "appointment_employees" && c.method === "insert");
    assert.equal(assignmentInsertCalls.length, 2, "one insertAssignments call per newly generated occurrence");
    for (const call of assignmentInsertCalls) {
      const rows = call.args[0] as Array<{ employee_id: string }>;
      assert.deepEqual(rows.map((r) => r.employee_id), ["teresa", "roxana"]);
    }
  });

  test("an unassigned origin generates rows with no assignment inserts at all", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: null } }],
      appointments: [
        { data: oneTimeAppt() },
        { error: null },
        { data: [{ id: "new-1" }] },
      ],
      appointment_employees: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", repeat_weeks: 26 }));
    assert.equal(res.status, 200);
    assert.equal(currentFake.calls.filter((c) => c.table === "appointment_employees" && c.method === "insert").length, 0);
  });
});

describe("Phase 2: Monthly Recurring Appointments via Manage Recurrence", () => {
  test("converting a one-time appointment to monthly recurrence generates every future occurrence and saves repeat_months on the source row", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: null } }],
      appointments: [
        { data: oneTimeAppt() }, // fetch existing
        { error: null }, // update source appointment
        // repeat_months: 12 -> MAX_MONTHLY_HORIZON_MONTHS (24) / 12 = 2 future rows.
        { data: [{ id: "new-1" }, { id: "new-2" }] },
      ],
      appointment_employees: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "monthly", repeat_months: 12 }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.created, 2);

    const updateCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "update");
    const updateArgs = updateCall!.args[0] as { frequency_type: string; repeat_weeks: number; repeat_months: number | null; series_id: string | null };
    assert.equal(updateArgs.frequency_type, "monthly");
    assert.equal(updateArgs.repeat_weeks, 1);
    assert.equal(updateArgs.repeat_months, 12);
    assert.ok(updateArgs.series_id, "a new series_id is generated for the newly-recurring source appointment");

    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ frequency_type?: string; repeat_months?: number | null }>;
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.frequency_type === "monthly" && r.repeat_months === 12));
  });

  test("every generated future row copies the origin appointment's own price_cents for a monthly series, not a service default", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: null } }],
      appointments: [
        { data: oneTimeAppt() }, // price_cents: 5000
        { error: null },
        { data: [{ id: "new-1" }, { id: "new-2" }] },
      ],
      appointment_employees: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "monthly", repeat_months: 12 }));
    assert.equal(res.status, 200);
    const insertCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "insert");
    const rows = insertCall!.args[0] as Array<{ price_cents?: number | null }>;
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.price_cents === 5000));
  });

  test("every generated future row of a monthly series gets the same set of assigned employees as the origin, including multiple", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: null } }],
      appointments: [
        { data: oneTimeAppt() },
        { error: null },
        { data: [{ id: "new-1" }, { id: "new-2" }] },
      ],
      appointment_employees: [
        { data: [
          { id: "ae-1", appointment_id: "appt-1", employee_id: "teresa", actual_started_at: null, actual_completed_at: null, created_at: "x", updated_at: "x" },
          { id: "ae-2", appointment_id: "appt-1", employee_id: "roxana", actual_started_at: null, actual_completed_at: null, created_at: "x", updated_at: "x" },
        ] }, // fetchAssignments(origin)
        { data: null, error: null }, // insertAssignments(new-1)
        { data: null, error: null }, // insertAssignments(new-2)
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "monthly", repeat_months: 12 }));
    assert.equal(res.status, 200);
    const assignmentInsertCalls = currentFake.calls.filter((c) => c.table === "appointment_employees" && c.method === "insert");
    assert.equal(assignmentInsertCalls.length, 2, "one insertAssignments call per newly generated monthly occurrence");
    for (const call of assignmentInsertCalls) {
      const rows = call.args[0] as Array<{ employee_id: string }>;
      assert.deepEqual(rows.map((r) => r.employee_id), ["teresa", "roxana"]);
    }
  });

  test("converting an existing weekly series to monthly cancels its future weekly siblings before generating monthly occurrences", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: null } }],
      appointments: [
        { data: { ...oneTimeAppt(), series_id: "series-1", frequency_type: "weekly", repeat_weeks: 2 } },
        { data: [{ id: "sib-1" }, { id: "sib-2" }] }, // weekly sibling lookup
        { error: null }, // bulk-cancel weekly siblings
        { error: null }, // update source appointment
        { data: [{ id: "new-1" }, { id: "new-2" }] }, // insert new monthly series
      ],
      appointment_employees: [{ data: [] }],
      recurring_series: [
        { data: { id: "series-1", status: "active" } }, // observe old series status
        { data: [{ id: "series-1" }] }, // quarantine old
        { data: [{ id: "series-1" }] }, // finalize old stopped
        { data: null }, // insert new quarantined
      ],
    }, { activate_recurring_series: [{ data: "activated" }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "monthly", repeat_months: 12 }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cancelled, 2);
    assert.equal(body.created, 2);
  });

  test("missing repeat_months on a monthly request is rejected with 400, before any appointment read/write", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "monthly" }));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Repeat interval must be a whole number of months between 1 and 12." });
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments"), []);
  });

  for (const bad of [0, -1, 1.5, 13, 100]) {
    test(`repeat_months=${bad} on a monthly request is rejected with 400 -- never silently regenerates as a broken/empty series`, async () => {
      resetFixtures({
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req({ appointment_id: "appt-1", frequency_type: "monthly", repeat_months: bad }));
      assert.equal(res.status, 400);
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments"), []);
    });
  }

  test("converting a monthly series back to one_time cancels future siblings and creates no new rows", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: { ...oneTimeAppt(), series_id: "series-1", frequency_type: "monthly", repeat_months: 12 } },
        { data: [{ id: "sib-1" }] },
        { error: null },
        { error: null },
      ],
      appointment_employees: [{ data: [] }],
      recurring_series: [
        { data: { id: "series-1", status: "active" } }, // observe old series status
        { data: [{ id: "series-1" }] }, // quarantine old
        { data: [{ id: "series-1" }] }, // finalize old stopped
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "one_time" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cancelled, 1);
    assert.equal(body.created, 0);
    // Two "update" calls happen in this flow: the bulk sibling-cancel
    // (.update({status: "cancelled"})) and the source-row recurrence update
    // -- find the latter specifically by its frequency_type key, rather
    // than assuming call order.
    const updateCall = currentFake.calls.find(
      (c) => c.table === "appointments" && c.method === "update" && (c.args[0] as Record<string, unknown>)?.frequency_type !== undefined
    );
    const updateArgs = updateCall!.args[0] as { frequency_type: string; repeat_months: number | null };
    assert.equal(updateArgs.frequency_type, "one_time");
    assert.equal(updateArgs.repeat_months, null, "converting away from monthly clears repeat_months rather than leaving a stale value");
  });
});

describe("Phase 5D: trusted workspace timezone drives recurrence generation, with atomic DST-nonexistent rejection", () => {
  test("converting to one_time never queries company_settings -- the timezone lookup is skipped entirely when there is no recurrence to generate", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: { ...oneTimeAppt(), series_id: "series-1", frequency_type: "weekly" } },
        { data: [{ id: "sib-1" }] },
        { error: null },
        { error: null },
      ],
      appointment_employees: [{ data: [] }],
      recurring_series: [
        { data: { id: "series-1", status: "active" } }, // observe old series status
        { data: [{ id: "series-1" }] }, // quarantine old
        { data: [{ id: "series-1" }] }, // finalize old stopped
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "one_time" }));
    assert.equal(res.status, 200);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "company_settings"), []);
  });

  test("a weekly recurrence whose generated occurrence lands on a nonexistent DST local time is rejected atomically -- 400, zero cancelled siblings, zero source-row update, zero new rows", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: null } }],
      appointments: [
        // 2026-02-22T07:30:00.000Z = 2:30 AM New York (a Sunday). +1 week
        // lands on 2026-03-08 2:30 AM New York -- the exact spring-forward
        // gap. This appointment is ALREADY part of a series (siblings would
        // normally be cancelled) -- proving the atomicity guarantee holds
        // even when there's something to lose by acting too early.
        { data: { ...oneTimeAppt(), series_id: "series-1", scheduled_for: "2026-02-22T07:30:00.000Z" } },
      ],
      appointment_employees: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", repeat_weeks: 1 }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /daylight-saving/);
    // Only the initial fetch + the company_settings read happened -- no
    // sibling lookup/cancel, no source-row update, no insert.
    assert.deepEqual(currentFake.calls.filter((c) => c.method === "update" || c.method === "insert"), []);
  });

  test("a monthly recurrence whose generated occurrence lands on a nonexistent DST local time is also rejected atomically", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: null } }],
      appointments: [
        // 2026-01-08T07:30:00.000Z = 2:30 AM New York, Jan 8. +2 months
        // (repeat_months: 2) lands on Mar 8, 2:30 AM New York -- the gap.
        { data: { ...oneTimeAppt(), scheduled_for: "2026-01-08T07:30:00.000Z" } },
      ],
      appointment_employees: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "monthly", repeat_months: 2 }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /daylight-saving/);
    assert.deepEqual(currentFake.calls.filter((c) => c.method === "update" || c.method === "insert"), []);
  });

  test("the exact same DST-gap origin succeeds for a workspace timezone that never hits it (Arizona, no DST)", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: "America/Phoenix" } }],
      appointments: [
        // 2026-02-22T09:30:00.000Z = 2:30 AM Arizona (no DST, never a gap).
        { data: { ...oneTimeAppt(), scheduled_for: "2026-02-22T09:30:00.000Z" } },
        { error: null }, // update source appointment
        { data: [{ id: "new-1" }] }, // insert new series rows
      ],
      appointment_employees: [{ data: [] }],
      recurring_series: [{ data: null }],
    }, { activate_recurring_series: [{ data: "activated" }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", repeat_weeks: 1 }));
    assert.equal(res.status, 200);
  });

  test("a timezone field included in the request body is silently ignored -- there is no such input the caller can spoof", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { timezone: null } }], // trusted: America/New_York
      appointments: [
        { data: { ...oneTimeAppt(), scheduled_for: "2026-02-22T07:30:00.000Z" } },
      ],
      appointment_employees: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    // A body-supplied timezone claiming Arizona (which would NOT hit the
    // gap) must not override the trusted, server-resolved NY timezone.
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", repeat_weeks: 1, timezone: "America/Phoenix" }));
    assert.equal(res.status, 400);
  });
});

describe("Block 2B safety correction: recurring_series registry lifecycle is fail-closed", () => {
  test("changing frequency on a one-time appointment inserts a review_required row FIRST, then activates it with the EDITED appointment as its own template", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        company_settings: [{ data: { timezone: null } }],
        appointments: [
          { data: oneTimeAppt() },
          { error: null },
          { data: [{ id: "new-1" }] },
        ],
        appointment_employees: [{ data: [] }],
        recurring_series: [{ data: null }],
      },
      { activate_recurring_series: [{ data: "activated" }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", repeat_weeks: 2 }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.warning, undefined);

    const insertCall = currentFake.calls.find((c) => c.table === "recurring_series" && c.method === "insert");
    assert.ok(insertCall);
    const insertedRow = insertCall!.args[0] as Record<string, unknown>;
    assert.equal(insertedRow.status, "review_required");
    assert.equal(insertedRow.source, "owner_created");
    assert.equal(insertedRow.template_appointment_id, null);
    assert.equal(insertedRow.reviewed_at, null);

    assert.equal(currentFake.rpcCalls.length, 1);
    const rpcCall = currentFake.rpcCalls[0];
    assert.equal(rpcCall.fn, "activate_recurring_series");
    assert.equal((rpcCall.args as Record<string, unknown>).p_template_appointment_id, "appt-1"); // the edited row itself, not a newly generated one
  });

  test("converting a recurring series to one_time quarantines the OLD series BEFORE cancelling siblings, then finalizes it stopped after", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: { ...oneTimeAppt(), series_id: "series-old", frequency_type: "weekly" } },
        { data: [{ id: "sib-1" }] },
        { error: null },
        { error: null },
      ],
      appointment_employees: [{ data: [] }],
      recurring_series: [
        { data: { id: "series-old", status: "active" } }, // observe old series status
        { data: [{ id: "series-old" }] }, // quarantine
        { data: [{ id: "series-old" }] }, // finalize stopped
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "one_time" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.warning, undefined);

    const updateCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "update");
    assert.equal(updateCalls.length, 2, "quarantine then finalize-stopped");
    assert.equal((updateCalls[0].args[0] as Record<string, unknown>).status, "review_required");
    assert.equal((updateCalls[1].args[0] as Record<string, unknown>).status, "stopped");
    const eqCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "eq");
    assert.ok(eqCalls.some((c) => (c.args as unknown[])[0] === "id" && (c.args as unknown[])[1] === "series-old"));

    // The quarantine call must be recorded before ANY appointment write.
    const quarantineCallIdx = currentFake.calls.indexOf(updateCalls[0]);
    const firstApptWriteIdx = currentFake.calls.findIndex(
      (c) => c.table === "appointments" && (c.method === "update" || c.method === "insert")
    );
    assert.ok(quarantineCallIdx < firstApptWriteIdx);
  });

  test("failure injection: a quarantine failure on the OLD series aborts BEFORE any appointment mutation, 500, zero appointment writes", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: { ...oneTimeAppt(), series_id: "series-old", frequency_type: "weekly" } }],
      appointment_employees: [{ data: [] }],
      recurring_series: [{ error: { message: "simulated quarantine failure" } }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "one_time" }));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes("simulated quarantine failure"), "must not leak the raw database error");
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments" && (c.method === "update" || c.method === "insert")), []);
  });

  test("failure injection: a finalize-stopped failure after a successful mutation still returns success, with a warning -- the old series is never left active", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: { ...oneTimeAppt(), series_id: "series-old", frequency_type: "weekly" } },
        { data: [{ id: "sib-1" }] },
        { error: null },
        { error: null },
      ],
      appointment_employees: [{ data: [] }],
      recurring_series: [
        { data: { id: "series-old", status: "active" } }, // observe
        { data: [{ id: "series-old" }] }, // quarantine
        { error: { message: "simulated finalize-stopped failure" } }, // finalize fails
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "one_time" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cancelled, 1);
    assert.ok(body.warning, "expected a structured warning on the still-successful response");
    assert.equal(body.warning.code, "recurring_series_review_required");
    assert.ok(!JSON.stringify(body.warning).includes("simulated finalize-stopped failure"));
  });

  test("race: concurrent review cannot be overwritten by Manage Recurrence -- observed active, but the quarantine CAS finds nothing (already changed elsewhere), aborts 409 with zero appointment writes", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: { ...oneTimeAppt(), series_id: "series-old", frequency_type: "weekly" } }],
      appointment_employees: [{ data: [] }],
      recurring_series: [
        { data: { id: "series-old", status: "active" } }, // observed active
        { data: [] }, // but the compare-and-set matches nothing -- raced by another request
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "one_time" }));
    assert.equal(res.status, 409);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments" && (c.method === "update" || c.method === "insert")), []);
    // No later finalize/reactivate attempt of any kind.
    assert.equal(currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "update").length, 1, "only the failed quarantine CAS, nothing else");
  });

  test("failure injection: a new-series activation RPC error still returns the successful appointment mutation, with a warning", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        company_settings: [{ data: { timezone: null } }],
        appointments: [
          { data: oneTimeAppt() },
          { error: null },
          { data: [{ id: "new-1" }] },
        ],
        appointment_employees: [{ data: [] }],
        recurring_series: [{ data: null }],
      },
      { activate_recurring_series: [{ error: { message: "simulated activation failure" } }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", repeat_weeks: 2 }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.created > 0);
    assert.ok(body.warning, "expected a structured warning on the still-successful response");
    assert.equal(body.warning.code, "recurring_series_review_required");
  });

  test("outcome 'invalid_timezone' from the RPC still returns the successful appointment mutation, with the same structured warning", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        company_settings: [{ data: { timezone: null } }],
        appointments: [
          { data: oneTimeAppt() },
          { error: null },
          { data: [{ id: "new-1" }] },
        ],
        appointment_employees: [{ data: [] }],
        recurring_series: [{ data: null }],
      },
      { activate_recurring_series: [{ data: "invalid_timezone" }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", repeat_weeks: 2 }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.created > 0);
    assert.ok(body.warning);
    assert.equal(body.warning.code, "recurring_series_review_required");
  });

  test("race: activating a managed series cannot succeed after its client becomes inactive -- stays review_required, appointment mutation still succeeds with a warning", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        company_settings: [{ data: { timezone: null } }],
        appointments: [
          { data: oneTimeAppt() },
          { error: null },
          { data: [{ id: "new-1" }] },
        ],
        appointment_employees: [{ data: [] }],
        recurring_series: [{ data: null }],
      },
      // The client-active re-check now happens entirely inside the RPC's
      // own locked transaction -- simulated here by the RPC itself
      // reporting client_not_active, not a second JS-level clients fixture.
      { activate_recurring_series: [{ data: "client_not_active" }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "weekly", repeat_weeks: 2 }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.created > 0, "the appointment mutation itself must not be blocked or retried");
    assert.ok(body.warning);
    assert.equal(body.warning.code, "recurring_series_review_required");
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "update"), []);
  });

  test("a one-time-to-one-time edit (no series involved at all) never touches recurring_series", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: oneTimeAppt() },
        { error: null },
      ],
      appointment_employees: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req({ appointment_id: "appt-1", frequency_type: "one_time" }));
    assert.equal(res.status, 200);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "recurring_series"), []);
  });
});
