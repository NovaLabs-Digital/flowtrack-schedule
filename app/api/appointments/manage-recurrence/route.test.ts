// Route-level tests for app/api/appointments/manage-recurrence/route.ts (POST).
//
// SCOPE OF THESE TESTS: the route is now a thin wrapper around ONE database
// call (apply_recurrence_change, migrations/029). These tests use a mocked
// RPC and therefore prove only the route's own behavior: authentication and
// entitlement ordering, input validation, request building (including the
// DST-safe date generation), outcome -> HTTP mapping, that exactly one RPC and
// zero direct table writes happen, and that notifications are sent only after
// a fresh commit. They CANNOT prove transaction rollback, locking, replay or
// concurrency -- those are proven against real PostgreSQL by
// test-db/recurrence.test.ts (`npm run test:db`).
//
// @/lib/session and @/lib/supabaseAdmin are mocked in-process;
// @/lib/entitlementServer is DELIBERATELY LEFT UNMOCKED (the real
// requireCapability chain runs against a fake "subscriptions" table).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { createFakeSupabaseAdmin, writeCalls, fakeSessionNamedExports, subscriptionRow, SUBSCRIPTION_RESTRICTED_BODY, SERVICE_UNAVAILABLE_BODY } from "../../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../../lib/testSupport.ts";
import type { RecurrenceChangeRequest } from "../../../../lib/recurrenceChange.ts";

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

// Records the notification helper's calls together with how many RPC calls had
// completed when it ran -- proving "after the transaction", not merely "called".
const notifyCalls: { params: Record<string, unknown>; rpcCallsSoFar: number }[] = [];
let notifyShouldThrow = false;
mock.module("@/lib/notifyAppointmentChange", {
  namedExports: {
    sendAppointmentChangeNotification: async (params: Record<string, unknown>) => {
      notifyCalls.push({ params, rpcCallsSoFar: currentFake.rpcCalls.length });
      if (notifyShouldThrow) throw new Error("provider down");
    },
  },
});

const { POST } = await import("./route.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>, rpcResponses: Record<string, FakeSupabaseFixture[]> = {}) {
  currentFake = createFakeSupabaseAdmin(responses, rpcResponses);
  notifyCalls.length = 0;
  notifyShouldThrow = false;
}
function req(body?: unknown, url = "http://localhost/api/appointments/manage-recurrence") {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

type RpcArgs = {
  p_workspace_id: string; p_appointment_id: string; p_operation_id: string;
  p_request: RecurrenceChangeRequest; p_expected: Record<string, unknown>;
};
const rpcArgs = (i = 0) => currentFake.rpcCalls[i].args as RpcArgs;

const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID, authUserId: "aaaaaaaa-0000-0000-0000-00000000owna", sessionEpoch: 1 };
const OP_ID = "11111111-1111-4111-8111-111111111111";
const EMP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// The reported case: edited to Sept 22, 2026 9:00 AM New York, every 4 weeks.
const SEPT_22_9AM_NY = "2026-09-22T13:00:00.000Z";
function validBody(over: Record<string, unknown> = {}) {
  return {
    appointment_id: "appt-1",
    client_operation_id: OP_ID,
    frequency_type: "weekly",
    repeat_weeks: 4,
    fields: {
      scheduled_for: SEPT_22_9AM_NY,
      scheduled_end: "2026-09-22T14:00:00.000Z",
      service_type: "Regular Cleaning",
      notes: null,
      duration_minutes: 60,
      price_cents: 9000,
      team_color: null,
      status: "scheduled",
    },
    employee_ids: [],
    expected: {
      scheduled_for: "2026-09-29T08:30:00.000Z",
      scheduled_end: "2026-09-29T09:30:00.000Z",
      service_type: "Regular Cleaning",
      notes: null,
      duration_minutes: 60,
      price_cents: 9000,
      team_color: null,
      status: "scheduled",
      series_id: null,
      frequency_type: "one_time",
      employee_ids: [],
      timezone: "America/New_York",
    },
    notify_channel: "none",
    ...over,
  };
}

const APPLIED = {
  outcome: "applied", operation_id: OP_ID, appointment_id: "appt-1", previous_scheduled_for: "2026-09-29T08:30:00+00:00",
  previous_series_id: null, new_series_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", old_series_stopped: false,
  cancelled_count: 0, protected_count: 0, protected: [], created_count: 6, skipped_for_exclusion_count: 0, client_visible_change: true,
};

function happy(over: { rpc?: Record<string, unknown>; appt?: Record<string, unknown>; timezone?: string | null } = {}, extra: Record<string, FakeSupabaseFixture[]> = {}) {
  resetFixtures(
    {
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: { id: "appt-1", client_id: "client-1", is_demo: false, ...over.appt } }],
      company_settings: [{ data: { timezone: over.timezone === undefined ? null : over.timezone } }],
      ...extra,
    },
    { apply_recurrence_change: [{ data: { ...APPLIED, ...over.rpc } }] }
  );
  sessionToReturn = OWNER_SESSION;
}

describe("entitlement gate and role gate run before anything else", () => {
  const FULL_STATES: Array<[string, ReturnType<typeof subscriptionRow>]> = [
    ["active", subscriptionRow({ stripe_status: "active" })],
    ["trialing", subscriptionRow({ stripe_status: "trialing" })],
    ["past_due_grace", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() + 60000).toISOString() })],
    ["internal", subscriptionRow({ billing_mode: "internal", stripe_status: null })],
  ];
  for (const [label, row] of FULL_STATES) {
    test(`${label} permits the change: exactly one RPC, zero direct table writes`, async () => {
      resetFixtures(
        {
          workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
          subscriptions: [{ data: row }],
          appointments: [{ data: { id: "appt-1", client_id: "client-1", is_demo: false } }],
          company_settings: [{ data: { timezone: null } }],
        },
        { apply_recurrence_change: [{ data: APPLIED }] }
      );
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req(validBody()));
      assert.equal(res.status, 200, label);
      assert.equal(currentFake.rpcCalls.length, 1);
      assert.deepEqual(writeCalls(currentFake.calls), [], "atomicity lives in the RPC; the route writes nothing itself");
    });
  }

  test("exact trusted demo workspace permits the mutation with zero subscriptions-table queries", async () => {
    resetFixtures(
      { appointments: [{ data: { id: "appt-1", client_id: "client-1", is_demo: true } }], company_settings: [{ data: { timezone: null } }] },
      { apply_recurrence_change: [{ data: APPLIED }] }
    );
    sessionToReturn = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };
    const res = await POST(req(validBody()));
    assert.equal(res.status, 200);
    assert.equal(currentFake.calls.filter((c) => c.table === "subscriptions").length, 0);
  });

  const RESTRICTED: Array<[string, ReturnType<typeof subscriptionRow> | null]> = [
    ["past_due_expired", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() - 1000).toISOString() })],
    ["canceled", subscriptionRow({ stripe_status: "canceled" })],
    ["unpaid", subscriptionRow({ stripe_status: "unpaid" })],
    ["no_subscription (no row)", null],
    ["malformed", subscriptionRow({ stripe_status: "not_a_real_status" })],
  ];
  for (const [label, row] of RESTRICTED) {
    test(`${label} returns the exact SUBSCRIPTION_RESTRICTED 403 with zero appointment reads and zero RPC calls`, async () => {
      resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }], subscriptions: [{ data: row }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req(validBody()));
      assert.equal(res.status, 403, label);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY, label);
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "appointments"), []);
      assert.equal(currentFake.rpcCalls.length, 0);
    });
  }

  test("query_error on the subscriptions read denies (503) with zero appointment access", async () => {
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }], subscriptions: [{ error: { message: "simulated" } }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(validBody()));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), SERVICE_UNAVAILABLE_BODY);
    assert.equal(currentFake.rpcCalls.length, 0);
  });

  for (const [label, session] of [
    ["employee", { role: "employee", employeeId: "e1", workspaceId: REAL_WORKSPACE_ID }],
    ["unauthenticated", { role: "none" }],
  ] as const) {
    test(`${label} keeps the existing role denial and touches nothing`, async () => {
      resetFixtures({});
      sessionToReturn = session;
      const res = await POST(req(validBody()));
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error, "Unauthorized");
      assert.equal(currentFake.calls.length, 0);
      assert.equal(currentFake.rpcCalls.length, 0);
    });
  }

  test("a tester session on a non-demo workspace fails closed and never reaches the RPC", async () => {
    resetFixtures({});
    sessionToReturn = { role: "tester", workspaceId: REAL_WORKSPACE_ID };
    const res = await POST(req(validBody()));
    assert.equal(res.status, 403);
    assert.equal(currentFake.rpcCalls.length, 0);
  });
});

describe("validation happens after entitlement and before any RPC", () => {
  async function rejected(body: unknown, expectedStatus: number, expectedError?: string | RegExp) {
    happy();
    const res = await POST(req(body));
    assert.equal(res.status, expectedStatus);
    const json = await res.json();
    if (typeof expectedError === "string") assert.equal(json.error, expectedError);
    else if (expectedError) assert.match(json.error, expectedError);
    assert.equal(currentFake.rpcCalls.length, 0, "no RPC for an invalid request");
    assert.deepEqual(writeCalls(currentFake.calls), []);
  }

  test("missing appointment_id", () => rejected(validBody({ appointment_id: "" }), 400, "Missing appointment_id"));
  test("invalid frequency_type", () => rejected(validBody({ frequency_type: "yearly" }), 400, "Invalid frequency_type"));
  test("missing client_operation_id", () => rejected(validBody({ client_operation_id: undefined }), 400, /client_operation_id/));
  test("malformed client_operation_id", () => rejected(validBody({ client_operation_id: "not-a-uuid" }), 400, /client_operation_id/));
  test("missing expected snapshot", () => rejected(validBody({ expected: undefined }), 400, /expected snapshot/));
  test("malformed expected snapshot", () => rejected(validBody({ expected: { scheduled_for: "nope" } }), 400, /expected snapshot/));
  test("missing fields", () => rejected(validBody({ fields: undefined }), 400, "Missing appointment fields"));
  test("a recurring change requires a whole number of weeks between 1 and 8", () => rejected(validBody({ repeat_weeks: 9 }), 400, /weeks between 1 and 8/));
  for (const bad of [0, -1, 1.5, 13, 100]) {
    test(`monthly repeat_months=${bad} is rejected before any RPC`, () =>
      rejected(validBody({ frequency_type: "monthly", repeat_months: bad }), 400, /months between 1 and 12/));
  }
  test("changing recurrence while the status is Cancelled is rejected", () =>
    rejected(validBody({ fields: { ...validBody().fields, status: "cancelled" } }), 400, /status back to Scheduled/));
  test("a generated occurrence on a nonexistent DST local time rejects the WHOLE request before any RPC", () =>
    // 2026-02-22T07:30Z = 2:30 AM New York; +1 week lands in the March 8 spring-forward gap
    rejected(validBody({ frequency_type: "weekly", repeat_weeks: 1, fields: { ...validBody().fields, scheduled_for: "2026-02-22T07:30:00.000Z", scheduled_end: "2026-02-22T08:30:00.000Z" } }), 400, /daylight-saving/));

  test("an appointment that does not exist is a 404 with no RPC", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(validBody()));
    assert.equal(res.status, 404);
    assert.equal(currentFake.rpcCalls.length, 0);
  });

  test("a tester session cannot reach a non-demo appointment (404, no RPC)", async () => {
    resetFixtures({ appointments: [{ data: { id: "appt-1", client_id: "client-1", is_demo: false } }] });
    sessionToReturn = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };
    const res = await POST(req(validBody()));
    assert.equal(res.status, 404);
    assert.equal(currentFake.rpcCalls.length, 0);
  });
});

describe("the RPC request is built from trusted inputs and the DST-safe generator", () => {
  test("workspace comes from the SESSION, never the body; operation id is normalized; the expected snapshot is canonicalized", async () => {
    happy();
    const res = await POST(req({ ...validBody({ client_operation_id: OP_ID.toUpperCase(), employee_ids: [EMP_B, EMP_A, EMP_A] }), workspace_id: "attacker-ws" }));
    assert.equal(res.status, 200);
    const args = rpcArgs();
    assert.equal(currentFake.rpcCalls[0].fn, "apply_recurrence_change");
    assert.equal(args.p_workspace_id, REAL_WORKSPACE_ID);
    assert.equal(args.p_appointment_id, "appt-1");
    assert.equal(args.p_operation_id, OP_ID);
    assert.deepEqual(args.p_request.employee_ids, [EMP_A, EMP_B], "deduplicated and sorted");
    assert.equal(args.p_expected.scheduled_for, "2026-09-29T08:30:00.000Z");
    assert.equal(args.p_expected.frequency_type, "one_time");
    assert.equal(args.p_expected.timezone, "America/New_York");
    // no client-supplied "previous scheduled_for" exists anywhere in the request
    assert.ok(!JSON.stringify(args).includes("previous_scheduled_for"));
  });

  test("Izabel: Sept 22 2026 9:00 AM every 4 weeks generates Oct 20 / Nov 17 / Dec 15 at 9:00 AM New York across the DST end", async () => {
    happy();
    const res = await POST(req(validBody()));
    assert.equal(res.status, 200);
    const { occurrences, fields, recurrence, timezone } = rpcArgs().p_request;
    assert.equal(timezone, "America/New_York");
    assert.equal(fields.scheduled_for, SEPT_22_9AM_NY);
    assert.deepEqual(recurrence, { frequency_type: "weekly", repeat_weeks: 4, repeat_months: null });
    const local = occurrences.map((iso: string) => DateTime.fromISO(iso).setZone("America/New_York"));
    assert.deepEqual(local.slice(0, 3).map((d: DateTime) => d.toFormat("yyyy-MM-dd h:mm a")), ["2026-10-20 9:00 AM", "2026-11-17 9:00 AM", "2026-12-15 9:00 AM"]);
    assert.ok(local.every((d: DateTime) => d.toFormat("h:mm a") === "9:00 AM"));
    assert.ok(occurrences.every((iso: string) => new Date(iso).getTime() > new Date(SEPT_22_9AM_NY).getTime()));
  });

  test("the generator uses the workspace's own timezone (a Chicago workspace keeps 9:00 AM Chicago)", async () => {
    happy({ timezone: "America/Chicago" });
    const chicago9 = "2026-09-22T14:00:00.000Z";
    const res = await POST(req(validBody({ fields: { ...validBody().fields, scheduled_for: chicago9, scheduled_end: "2026-09-22T15:00:00.000Z" } })));
    assert.equal(res.status, 200);
    const { occurrences, timezone } = rpcArgs().p_request;
    assert.equal(timezone, "America/Chicago");
    assert.ok(occurrences.every((iso: string) => DateTime.fromISO(iso).setZone("America/Chicago").toFormat("h:mm a") === "9:00 AM"));
  });

  test("one_time sends no occurrences and no interval", async () => {
    happy();
    const res = await POST(req(validBody({ frequency_type: "one_time", repeat_weeks: undefined })));
    assert.equal(res.status, 200);
    const { occurrences, recurrence } = rpcArgs().p_request;
    assert.deepEqual(occurrences, []);
    assert.deepEqual(recurrence, { frequency_type: "one_time", repeat_weeks: null, repeat_months: null });
  });

  test("monthly sends repeat_months and month-stepped occurrences", async () => {
    happy();
    const res = await POST(req(validBody({ frequency_type: "monthly", repeat_months: 12, repeat_weeks: undefined })));
    assert.equal(res.status, 200);
    const { occurrences, recurrence } = rpcArgs().p_request;
    assert.deepEqual(recurrence, { frequency_type: "monthly", repeat_weeks: null, repeat_months: 12 });
    assert.equal(occurrences.length, 2);
  });

  test("identical input yields byte-identical requests (what makes the operation fingerprint stable across retries)", async () => {
    happy();
    await POST(req(validBody()));
    happy();
    await POST(req(validBody()));
    const first = JSON.stringify(rpcArgs().p_request);
    happy();
    await POST(req(validBody()));
    assert.equal(first, JSON.stringify(rpcArgs().p_request));
  });
});

describe("RPC outcome -> HTTP mapping", () => {
  const CASES: Array<[string, Record<string, unknown>, number, string | null]> = [
    ["operation_id_conflict", { outcome: "operation_id_conflict" }, 409, "OPERATION_ID_CONFLICT"],
    ["stale_snapshot", { outcome: "stale_snapshot", mismatched: ["notes"] }, 409, "STALE_SNAPSHOT"],
    ["state_changed", { outcome: "state_changed" }, 409, "STATE_CHANGED"],
    ["appointment_is_historical", { outcome: "appointment_is_historical" }, 409, "APPOINTMENT_IS_HISTORICAL"],
    ["assignment_removal_blocked", { outcome: "assignment_removal_blocked", blocked_employee_ids: [EMP_A] }, 409, "ASSIGNMENT_REMOVAL_BLOCKED"],
    ["employee_not_eligible", { outcome: "employee_not_eligible" }, 409, "ASSIGNMENT_SYNC_FAILED"],
    ["client_not_active", { outcome: "client_not_active" }, 409, "CLIENT_NOT_ACTIVE"],
    ["rolled_back", { outcome: "rolled_back", reason: "activation_failed" }, 409, "ROLLED_BACK"],
    ["appointment_not_found", { outcome: "appointment_not_found" }, 404, null],
    ["invalid_input", { outcome: "invalid_input" }, 400, null],
    ["unknown outcome", { outcome: "surprise" }, 500, null],
  ];
  for (const [label, rpc, status, code] of CASES) {
    test(`${label} -> ${status}${code ? ` ${code}` : ""}, never a success body, never a notification`, async () => {
      happy({ rpc: { ...rpc } });
      const res = await POST(req(validBody({ notify_channel: "both" })));
      assert.equal(res.status, status);
      const json = await res.json();
      if (code) assert.equal(json.code, code);
      assert.notEqual(json.ok, true);
      assert.equal(notifyCalls.length, 0);
    });
  }

  test("stale/rolled-back responses tell the owner nothing was saved and never leak the internal reason", async () => {
    happy({ rpc: { outcome: "rolled_back", reason: "activation_failed" } });
    const res = await POST(req(validBody()));
    const json = await res.json();
    assert.match(json.error, /nothing was saved/i);
    assert.ok(!JSON.stringify(json).includes("activation_failed"));
    happy({ rpc: { outcome: "stale_snapshot", mismatched: ["notes"] } });
    const stale = await (await POST(req(validBody()))).json();
    assert.match(stale.error, /Nothing was saved/);
  });

  test("applied: reports counts and the protected occurrences, with a notice naming how many were kept", async () => {
    happy({ rpc: { cancelled_count: 3, created_count: 5, protected_count: 2, protected: [{ id: "x", scheduled_for: "2026-10-27T13:00:00+00:00" }, { id: "y", scheduled_for: "2026-11-03T13:00:00+00:00" }], skipped_for_exclusion_count: 1 } });
    const res = await POST(req(validBody()));
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.cancelled, 3);
    assert.equal(json.created, 5);
    assert.equal(json.protectedOccurrences, 2);
    assert.equal(json.protected.length, 2);
    assert.equal(json.skippedForExclusion, 1);
    assert.match(json.notice.message, /2 occurrences with recorded work were kept/);
    assert.equal(json.alreadyApplied, undefined);
  });

  test("applied with nothing protected has no notice; a replay is marked alreadyApplied", async () => {
    happy();
    const fresh = await (await POST(req(validBody()))).json();
    assert.equal(fresh.notice, undefined);
    assert.equal(fresh.protectedOccurrences, 0);
    happy({ rpc: { replayed: true } });
    const replay = await (await POST(req(validBody()))).json();
    assert.equal(replay.alreadyApplied, true);
    assert.equal(replay.ok, true);
  });

  test("an RPC error (which aborts the whole transaction) returns a generic 500 that leaks nothing and notifies no one", async () => {
    resetFixtures(
      {
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        appointments: [{ data: { id: "appt-1", client_id: "client-1", is_demo: false } }],
        company_settings: [{ data: { timezone: null } }],
      },
      { apply_recurrence_change: [{ error: { message: 'deadlock detected on relation "appointments"' } }] }
    );
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req(validBody({ notify_channel: "both" })));
    assert.equal(res.status, 500);
    const json = await res.json();
    assert.match(json.error, /Nothing was saved/);
    assert.ok(!JSON.stringify(json).includes("deadlock"));
    assert.equal(notifyCalls.length, 0);
  });
});

describe("notifications: only after a fresh commit -- and no delivery guarantee is claimed", () => {
  test("a freshly applied, client-visible change notifies once, AFTER the RPC has completed, with the appointment's own client and the chosen channel", async () => {
    happy();
    const res = await POST(req(validBody({ notify_channel: "both" })));
    assert.equal(res.status, 200);
    assert.equal(notifyCalls.length, 1);
    assert.equal(notifyCalls[0].rpcCallsSoFar, 1, "the notification ran after the transaction returned");
    assert.deepEqual(notifyCalls[0].params, { workspaceId: REAL_WORKSPACE_ID, appointmentId: "appt-1", clientId: "client-1", channel: "both" });
  });

  const SILENT: Array<[string, { rpc?: Record<string, unknown>; appt?: Record<string, unknown> }, string]> = [
    ["notify_channel none", {}, "none"],
    ["an identical replay (already notified the first time)", { rpc: { replayed: true } }, "both"],
    ["a change the client would not see (fields/date/employees unchanged)", { rpc: { client_visible_change: false } }, "both"],
    ["demo data", { appt: { is_demo: true } }, "both"],
  ];
  for (const [label, over, channel] of SILENT) {
    test(`no notification for ${label}`, async () => {
      happy(over);
      const res = await POST(req(validBody({ notify_channel: channel })));
      assert.equal(res.status, 200);
      assert.equal(notifyCalls.length, 0);
    });
  }

  test("a notification failure after commit never turns a committed change into an error response", async () => {
    happy();
    notifyShouldThrow = true;
    const res = await POST(req(validBody({ notify_channel: "email" })));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.equal(notifyCalls.length, 1);
  });
});
