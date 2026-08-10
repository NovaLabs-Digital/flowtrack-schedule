// Phase 5.4E1: route-level tests for app/api/clients/route.ts (PATCH, POST)
// proving requireCapability("canMutateOperationalData") is correctly wired
// before any write. @/lib/session and @/lib/supabaseAdmin are mocked
// in-process via node:test's mock.module; @/lib/entitlementServer is
// DELIBERATELY LEFT UNMOCKED -- the real requireCapability/
// fetchEntitlementForWorkspace/resolveWorkspaceEntitlement chain runs for
// real against the fake Supabase "subscriptions" table, so these tests
// prove the actual production entitlement logic gates the route, not a
// stand-in. No real Supabase/Stripe/network call is reachable. Run with
// --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import {
  createFakeSupabaseAdmin,
  writeCalls,
  fakeSessionNamedExports,
  subscriptionRow,
  SUBSCRIPTION_RESTRICTED_BODY,
  SERVICE_UNAVAILABLE_BODY,
} from "../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../lib/testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});
let sessionToReturn: unknown = { role: "none" };

mock.module("@/lib/supabaseAdmin", {
  namedExports: {
    supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) },
  },
});
mock.module("@/lib/session", {
  namedExports: fakeSessionNamedExports(async () => sessionToReturn),
});
// @/lib/entitlementServer is intentionally NOT mocked here.

const { PATCH, POST } = await import("./route.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}

function req(method: string, body: unknown, url = "http://localhost/api/clients") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const OWNER_AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";
const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID, authUserId: OWNER_AUTH_USER_ID, sessionEpoch: 1 };

describe("PATCH /api/clients -- entitlement gate", () => {
  const FULL_STATES: Array<[string, ReturnType<typeof subscriptionRow>]> = [
    ["active", subscriptionRow({ stripe_status: "active" })],
    ["trialing", subscriptionRow({ stripe_status: "trialing" })],
    ["past_due_grace", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() + 1000).toISOString() })],
    ["internal", subscriptionRow({ billing_mode: "internal", stripe_status: null })],
  ];

  for (const [label, row] of FULL_STATES) {
    test(`${label} permits the existing mutation, response unchanged`, async () => {
      resetFixtures({
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: row }],
        clients: [{ data: { is_demo: false } }, { error: null }],
      });
      sessionToReturn = OWNER_SESSION;
      const res = await PATCH(req("PATCH", { id: "client-1", name: "New Name" }));
      assert.equal(res.status, 200, label);
      assert.deepEqual(await res.json(), { ok: true }, label);
      assert.equal(writeCalls(currentFake.calls).length, 1, label);
    });
  }

  test("exact trusted demo workspace permits the mutation with zero subscriptions-table queries (real short-circuit)", async () => {
    resetFixtures({
      // Deliberately no "subscriptions" fixture queued -- if the demo
      // short-circuit didn't work, the first query would throw
      // FAKE_SUPABASE_NO_QUEUED_RESPONSE and fail this test.
      clients: [{ data: { is_demo: true } }, { error: null }],
    });
    sessionToReturn = { role: "tester", workspaceId: DEMO_WORKSPACE_ID };
    const res = await PATCH(req("PATCH", { id: "client-1", name: "New Name" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  const RESTRICTED_STATES: Array<[string, ReturnType<typeof subscriptionRow>]> = [
    ["past_due_expired", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() - 1000).toISOString() })],
    ["canceled", subscriptionRow({ stripe_status: "canceled" })],
    ["unpaid", subscriptionRow({ stripe_status: "unpaid" })],
    ["no_subscription (no row)", null as unknown as ReturnType<typeof subscriptionRow>],
    ["malformed", subscriptionRow({ stripe_status: "some_unrecognized_status" })],
  ];

  for (const [label, row] of RESTRICTED_STATES) {
    test(`${label} returns the exact SUBSCRIPTION_RESTRICTED 403, zero writes, zero reads of the operational table`, async () => {
      resetFixtures({
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: row }],
        // No "clients" fixture queued at all -- proves the route never
        // reaches its own existence-check read when denied.
      });
      sessionToReturn = OWNER_SESSION;
      const res = await PATCH(req("PATCH", { id: "client-1", name: "New Name" }));
      assert.equal(res.status, 403, label);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY, label);
      assert.deepEqual(writeCalls(currentFake.calls), [], label);
      assert.deepEqual(
        currentFake.calls.filter((c) => c.table === "clients"),
        [],
        label
      );
    });
  }

  test("query_error (Supabase read failure on subscriptions) denies the mutation, zero writes", async () => {
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ error: { message: "simulated DB error" } }] });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req("PATCH", { id: "client-1", name: "New Name" }));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), SERVICE_UNAVAILABLE_BODY);
    assert.deepEqual(writeCalls(currentFake.calls), []);
  });

  test("tester session with a non-demo workspace fails closed with the generic auth response, not SUBSCRIPTION_RESTRICTED, before any subscriptions query", async () => {
    // No "subscriptions" fixture queued -- the session-integrity guard must
    // reject before ever querying, so an accidental query would throw.
    resetFixtures({});
    sessionToReturn = { role: "tester", workspaceId: REAL_WORKSPACE_ID };
    const res = await PATCH(req("PATCH", { id: "client-1", name: "New Name" }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, undefined);
    assert.equal(body.error, "Unauthorized");
  });

  test("authentication failure (no session) stays a role/auth denial, never SUBSCRIPTION_RESTRICTED", async () => {
    resetFixtures({});
    sessionToReturn = { role: "none" };
    const res = await PATCH(req("PATCH", { id: "client-1", name: "New Name" }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, undefined);
    assert.equal(body.error, "Unauthorized");
  });

  test("a spoofed workspace_id in the request body does not change which workspace's entitlement is checked", async () => {
    // The REAL workspace (trusted session) is restricted; a spoofed body
    // workspace_id pointing at a hypothetical "full access" workspace must
    // have no effect -- if it did, this fixture setup would incorrectly
    // succeed instead of denying.
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req("PATCH", { id: "client-1", name: "New Name", workspace_id: "attacker-controlled-full-access-ws" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  describe("security-order correction: missing-id validation runs AFTER auth/role/entitlement, never before", () => {
    test("missing id + no session -> the existing authentication-denial response, NOT a 400, zero Supabase calls", async () => {
      resetFixtures({});
      sessionToReturn = { role: "none" };
      const res = await PATCH(req("PATCH", { name: "New Name" })); // no id at all
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.error, "Unauthorized");
      assert.equal(body.code, undefined);
      assert.notEqual(body.error, "Missing client id");
      assert.equal(currentFake.calls.length, 0);
    });

    test("missing id + authenticated but restricted workspace -> the exact 403 SUBSCRIPTION_RESTRICTED response, not 400, zero clients-table access", async () => {
      resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await PATCH(req("PATCH", { name: "New Name" })); // no id at all
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients"), []);
    });

    test("missing id + authenticated, authorized, entitled workspace -> the existing 400 'Missing client id' response", async () => {
      resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await PATCH(req("PATCH", { name: "New Name" })); // no id at all
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Missing client id" });
      // The entitlement check itself queried "subscriptions" (consuming the
      // one queued fixture), but the clients table was never touched --
      // proving validation ran after the gate and before any operational
      // read/write.
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients"), []);
    });
  });
});

describe("POST /api/clients (archive/restore) -- entitlement gate", () => {
  test("active permits archive, response unchanged", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { is_demo: false } }, { error: null }, { error: null }],
      // Block 2B safety correction: archiving a client quarantines every
      // active recurring series tied to it BEFORE the archive, then
      // finalizes those exact rows stopped after -- fail-closed, never
      // best-effort. A second, independent sweep runs after the archive
      // itself, catching anything that raced into active between the first
      // quarantine and the client actually going inactive -- here it finds
      // nothing new.
      recurring_series: [{ data: [{ id: "series-1" }] }, { data: [{ id: "series-1" }] }, { data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { id: "client-1", action: "archive" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(writeCalls(currentFake.calls).length, 4); // quarantine + client update + finalize-stopped + second-sweep quarantine attempt
  });

  test("canceled denies archive with the exact SUBSCRIPTION_RESTRICTED 403, zero writes", async () => {
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { id: "client-1", action: "archive" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(writeCalls(currentFake.calls), []);
  });

  test("canceled denies restore with the exact SUBSCRIPTION_RESTRICTED 403, zero writes", async () => {
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { id: "client-1", action: "restore" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(writeCalls(currentFake.calls), []);
  });

  describe("security-order correction: missing-id validation runs AFTER auth/role/entitlement, never before", () => {
    test("missing id + no session -> the existing authentication-denial response, NOT a 400, zero Supabase calls", async () => {
      resetFixtures({});
      sessionToReturn = { role: "none" };
      const res = await POST(req("POST", { action: "archive" })); // no id at all
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.error, "Unauthorized");
      assert.equal(body.code, undefined);
      assert.notEqual(body.error, "Missing client id");
      assert.equal(currentFake.calls.length, 0);
    });

    test("missing id + authenticated but restricted workspace -> the exact 403 SUBSCRIPTION_RESTRICTED response, not 400, zero clients-table access", async () => {
      resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req("POST", { action: "archive" })); // no id at all
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients"), []);
    });

    test("missing id + authenticated, authorized, entitled workspace -> the existing 400 'Missing client id' response", async () => {
      resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req("POST", { action: "archive" })); // no id at all
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Missing client id" });
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients"), []);
    });
  });
});

describe("Block 2B safety correction: archiving a client is fail-closed around its recurring series", () => {
  test("archive quarantines then stops recurring_series scoped by client_id and workspace_id, in that order, before/after the client archive itself", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { is_demo: false } }, { error: null }, { error: null }],
      recurring_series: [
        { data: [{ id: "series-1" }, { id: "series-2" }] }, // first sweep quarantines both
        { data: [{ id: "series-1" }, { id: "series-2" }] }, // finalize-stopped
        { data: [] }, // second (post-archive) sweep finds nothing new
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { id: "client-1", action: "archive" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.warning, undefined);

    const updateCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "update");
    assert.equal(updateCalls.length, 3, "first-sweep quarantine, finalize-stopped, second-sweep quarantine attempt");
    assert.equal((updateCalls[0].args[0] as Record<string, unknown>).status, "review_required");
    assert.equal((updateCalls[1].args[0] as Record<string, unknown>).status, "stopped");
    assert.equal((updateCalls[2].args[0] as Record<string, unknown>).status, "review_required");
    const eqCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "eq");
    assert.ok(eqCalls.some((c) => (c.args as unknown[])[0] === "client_id" && (c.args as unknown[])[1] === "client-1"));
    const inCall = currentFake.calls.find((c) => c.table === "recurring_series" && c.method === "in");
    assert.deepEqual(inCall!.args, ["id", ["series-1", "series-2"]]);

    // The first-sweep quarantine must be recorded before the client archive
    // write, and the second sweep must be recorded after it.
    const quarantineIdx = currentFake.calls.indexOf(updateCalls[0]);
    const secondSweepIdx = currentFake.calls.indexOf(updateCalls[2]);
    const clientUpdateIdx = currentFake.calls.findIndex((c) => c.table === "clients" && c.method === "update");
    assert.ok(quarantineIdx < clientUpdateIdx);
    assert.ok(clientUpdateIdx < secondSweepIdx);
  });

  test("archive with no active series at any point issues only the two (empty) sweep attempts -- no finalize call, since nothing was ever quarantined", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { is_demo: false } }, { error: null }, { error: null }],
      recurring_series: [{ data: [] }, { data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { id: "client-1", action: "archive" }));
    assert.equal(res.status, 200);
    assert.equal(currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "update").length, 2);
  });

  test("failure injection: a quarantine failure aborts the archive BEFORE the client is touched, 500, zero client writes", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { is_demo: false } }],
      recurring_series: [{ error: { message: "simulated quarantine failure" } }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { id: "client-1", action: "archive" }));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes("simulated quarantine failure"));
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" && c.method === "update"), []);
  });

  test("race: bulk archive finalizes only successfully quarantined IDs -- a partial miss (one id changed concurrently) is a warning, never silent success", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { is_demo: false } }, { error: null }, { error: null }],
      recurring_series: [
        { data: [{ id: "series-1" }, { id: "series-2" }] }, // both quarantined
        { data: [{ id: "series-1" }] }, // only series-1 still matched review_required when finalized -- series-2 raced
        { data: [] }, // second sweep finds nothing new
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { id: "client-1", action: "archive" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.warning, "a partial finalize must warn, never be reported as complete success");
    assert.equal(body.warning.code, "recurring_series_review_required");
    const inCall = currentFake.calls.find((c) => c.table === "recurring_series" && c.method === "in");
    assert.deepEqual(inCall!.args, ["id", ["series-1", "series-2"]], "the finalize attempt is still scoped to the full quarantined set");
  });

  test("failure injection: a finalize-stopped failure after a successful archive still returns success, with a warning, and the second sweep still runs", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { is_demo: false } }, { error: null }, { error: null }],
      recurring_series: [
        { data: [{ id: "series-1" }] },
        { error: { message: "simulated finalize-stopped failure" } },
        { data: [] }, // second sweep still runs after the first finalize's failure
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { id: "client-1", action: "archive" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.warning);
    assert.equal(body.warning.code, "recurring_series_review_required");
    assert.equal(currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "update").length, 3);
  });

  test("race: a series activated between the archive's first quarantine and the client archive itself is caught by the post-archive sweep", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { is_demo: false } }, { error: null }, { error: null }],
      recurring_series: [
        { data: [{ id: "series-1" }] }, // first sweep: only series-1 was active at that moment
        { data: [{ id: "series-1" }] }, // finalize series-1 stopped
        // series-2 was finalized active by a completely separate request in
        // the window between the first sweep and the client actually going
        // inactive -- the second sweep catches it here.
        { data: [{ id: "series-2" }] },
        { data: [{ id: "series-2" }] }, // finalize series-2 stopped too
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { id: "client-1", action: "archive" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.warning, undefined, "both sweeps fully succeeded -- no warning needed");
    const inCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "in");
    assert.equal(inCalls.length, 2);
    assert.deepEqual(inCalls[0].args, ["id", ["series-1"]]);
    assert.deepEqual(inCalls[1].args, ["id", ["series-2"]], "the second sweep's finalize is scoped to exactly what IT found, not the first sweep's set");
  });

  test("race: post-archive sweep failure leaves the client inactive (never rolled back) and returns a warning", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { is_demo: false } }, { error: null }, { error: null }],
      recurring_series: [
        { data: [] }, // first sweep: nothing active yet
        { error: { message: "simulated second-sweep failure" } }, // the post-archive sweep itself fails
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { id: "client-1", action: "archive" }));
    assert.equal(res.status, 200, "the client archive itself already succeeded and is never rolled back or retried");
    const body = await res.json();
    assert.ok(body.warning);
    assert.equal(body.warning.code, "recurring_series_review_required");
    assert.ok(!JSON.stringify(body.warning).includes("simulated second-sweep failure"));
    assert.equal(currentFake.calls.filter((c) => c.table === "clients" && c.method === "update").length, 1, "the client update was never retried or undone");
  });
});

describe("Block 2B safety correction: restoring a client is fail-closed around its recurring series", () => {
  test("successful restore leaves zero active recurring_series rows and never itself reactivates anything -- the quarantine-then-stop sweep only ever moves active -> stopped", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { is_demo: false } }, { error: null }, { error: null }],
      recurring_series: [
        { data: [{ id: "series-1" }] }, // a stray active row the archive-time sweeps somehow missed
        { data: [{ id: "series-1" }] }, // finalized stopped
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { id: "client-1", action: "restore" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const updateCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "update");
    assert.equal(updateCalls.length, 2);
    assert.ok(
      updateCalls.every((c) => (c.args[0] as Record<string, unknown>).status !== "active"),
      "restore's own registry writes never set status to active -- only review_required (quarantine) or stopped (finalize)"
    );
    // The safety sweep must complete BEFORE the client itself becomes active.
    const finalizeIdx = currentFake.calls.indexOf(updateCalls[1]);
    const clientUpdateIdx = currentFake.calls.findIndex((c) => c.table === "clients" && c.method === "update");
    assert.ok(finalizeIdx < clientUpdateIdx);
  });

  test("restore with no active series at all still runs the (empty) safety sweep, then proceeds -- no finalize call, since nothing was quarantined", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { is_demo: false } }, { error: null }, { error: null }],
      recurring_series: [{ data: [] }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { id: "client-1", action: "restore" }));
    assert.equal(res.status, 200);
    assert.equal(currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "update").length, 1);
    assert.equal(currentFake.calls.filter((c) => c.table === "clients" && c.method === "update").length, 1);
  });

  test("a pre-existing review_required or stopped series is never touched by the restore sweep at all -- it only ever matches status='active'", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { is_demo: false } }, { error: null }, { error: null }],
      recurring_series: [{ data: [] }], // the compare-and-set's own WHERE status='active' excludes them structurally
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { id: "client-1", action: "restore" }));
    assert.equal(res.status, 200);
    const eqCalls = currentFake.calls.filter((c) => c.table === "recurring_series" && c.method === "eq");
    assert.ok(eqCalls.some((c) => (c.args as unknown[])[0] === "status" && (c.args as unknown[])[1] === "active"));
  });

  test("failure injection: a quarantine failure aborts the restore BEFORE the client becomes active, 500, zero client writes", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { is_demo: false } }],
      recurring_series: [{ error: { message: "simulated quarantine failure" } }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { id: "client-1", action: "restore" }));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes("simulated quarantine failure"));
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" && c.method === "update"), []);
  });

  test("race: restore aborts if a stray active series cannot be safely stopped -- a finalize failure blocks the client from ever becoming active", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { is_demo: false } }],
      recurring_series: [
        { data: [{ id: "series-1" }] }, // quarantine succeeds
        { error: { message: "simulated finalize failure" } }, // but finalizing it stopped fails
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { id: "client-1", action: "restore" }));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes("simulated finalize failure"));
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" && c.method === "update"), []);
  });

  test("race: a partial finalize during the restore safety sweep also aborts -- fail-closed even without a thrown error", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { is_demo: false } }],
      recurring_series: [
        { data: [{ id: "series-1" }, { id: "series-2" }] }, // both quarantined
        { data: [{ id: "series-1" }] }, // only series-1 finalized -- series-2 raced away
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { id: "client-1", action: "restore" }));
    assert.equal(res.status, 500);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" && c.method === "update"), []);
  });
});
