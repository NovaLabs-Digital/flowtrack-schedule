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

const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID };

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
    resetFixtures({ subscriptions: [{ error: { message: "simulated DB error" } }] });
    sessionToReturn = OWNER_SESSION;
    const res = await PATCH(req("PATCH", { id: "client-1", name: "New Name" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
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
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
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
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await PATCH(req("PATCH", { name: "New Name" })); // no id at all
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients"), []);
    });

    test("missing id + authenticated, authorized, entitled workspace -> the existing 400 'Missing client id' response", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
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
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      clients: [{ data: { is_demo: false } }, { error: null }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { id: "client-1", action: "archive" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(writeCalls(currentFake.calls).length, 1);
  });

  test("canceled denies archive with the exact SUBSCRIPTION_RESTRICTED 403, zero writes", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { id: "client-1", action: "archive" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(writeCalls(currentFake.calls), []);
  });

  test("canceled denies restore with the exact SUBSCRIPTION_RESTRICTED 403, zero writes", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
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
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req("POST", { action: "archive" })); // no id at all
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients"), []);
    });

    test("missing id + authenticated, authorized, entitled workspace -> the existing 400 'Missing client id' response", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }] });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req("POST", { action: "archive" })); // no id at all
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Missing client id" });
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients"), []);
    });
  });
});
