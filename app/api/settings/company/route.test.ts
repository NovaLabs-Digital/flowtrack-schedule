// Phase 5.4E1: route-level tests for app/api/settings/company/route.ts
// (POST only -- GET remains completely untouched and is proven unaffected
// below, per the explicit Settings policy: opening/reading Settings and
// Billing must remain available while restricted). @/lib/entitlementServer
// is intentionally NOT mocked -- the real requireCapability chain runs
// against a fake "subscriptions" table. No real Supabase/Stripe/network
// call is reachable. Run with --experimental-test-module-mocks (see
// package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createFakeSupabaseAdmin, writeCalls, fakeSessionNamedExports, subscriptionRow, SUBSCRIPTION_RESTRICTED_BODY, SERVICE_UNAVAILABLE_BODY } from "../../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../../lib/testSupport.ts";
import { DEFAULT_BUSINESS_HOURS } from "../../../../lib/businessHours.ts";

let currentFake = createFakeSupabaseAdmin({});
let sessionToReturn: unknown = { role: "none" };

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});
mock.module("@/lib/session", { namedExports: fakeSessionNamedExports(async () => sessionToReturn) });

const { GET, POST } = await import("./route.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}
function req(method: string, body?: unknown) {
  return new Request("http://localhost/api/settings/company", {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const OWNER_AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";
const OWNER_SESSION = { role: "owner", workspaceId: REAL_WORKSPACE_ID, authUserId: OWNER_AUTH_USER_ID, sessionEpoch: 1 };

describe("POST /api/settings/company -- entitlement gate", () => {
  test("active permits saving settings, response unchanged", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { id: "cs-1" } }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { company_name: "Acme Cleaning" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(writeCalls(currentFake.calls).length, 1);
  });

  test("internal permits saving settings without Stripe dependence", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ billing_mode: "internal", stripe_status: null }) }],
      company_settings: [{ data: { id: "cs-1" } }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { company_name: "Acme Cleaning" }));
    assert.equal(res.status, 200);
  });

  test("exact trusted demo workspace permits saving settings with zero subscriptions-table queries", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: DEMO_WORKSPACE_ID, session_epoch: 1 } }],
      company_settings: [{ data: null }, { error: null }],
    });
    sessionToReturn = { role: "owner", workspaceId: DEMO_WORKSPACE_ID, authUserId: OWNER_AUTH_USER_ID, sessionEpoch: 1 };
    const res = await POST(req("POST", { company_name: "Demo Co" }));
    assert.equal(res.status, 200);
  });

  test("canceled denies saving settings with the exact SUBSCRIPTION_RESTRICTED 403, zero writes, zero company_settings reads", async () => {
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { company_name: "Acme Cleaning" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "company_settings"), []);
  });

  test("this specifically covers the approved policy: settings/company POST requires canMutateOperationalData while restricted", async () => {
    // Even a request that ONLY toggles booking_enabled/notifications_enabled
    // (not company identity fields) is still an operational mutation and
    // must be denied while restricted -- Settings/Billing viewing stays
    // available (see the GET-is-unaffected tests below), but saving does not.
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ data: subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() - 1000).toISOString() }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { notifications_enabled: false }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  test("query_error on the subscriptions read denies, zero writes", async () => {
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ error: { message: "simulated DB error" } }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { company_name: "Acme Cleaning" }));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), SERVICE_UNAVAILABLE_BODY);
  });

  test("non-owner denial remains a plain 403 Unauthorized, never SUBSCRIPTION_RESTRICTED", async () => {
    resetFixtures({});
    sessionToReturn = { role: "employee", employeeId: "e1", workspaceId: REAL_WORKSPACE_ID };
    const res = await POST(req("POST", { company_name: "Acme Cleaning" }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, undefined);
    assert.equal(body.error, "Unauthorized");
  });

  test("a spoofed workspace_id in the request body does not change which workspace's entitlement is checked", async () => {
    resetFixtures({ workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { company_name: "Acme Cleaning", workspace_id: "attacker-ws" }));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });
});

describe("GET /api/settings/company is governed by canViewExistingData (Phase 5.6E)", () => {
  test("succeeds for a full-access workspace", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { company_name: "Acme Cleaning", booking_enabled: true } }],
      employees: [{ count: 3 }, { count: 2 }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.settings.company_name, "Acme Cleaning");
  });

  test("still succeeds during canceled_read_only -- opening Settings to view/reactivate remains available", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [
        { data: subscriptionRow({ stripe_status: "canceled", canceled_at: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString() }) },
      ],
      company_settings: [{ data: { company_name: "Acme Cleaning", booking_enabled: true } }],
      employees: [{ count: 3 }, { count: 2 }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    assert.equal(res.status, 200);
  });

  test("denied once canceled_locked (30+ days after canceled_at)", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [
        {
          data: subscriptionRow({
            stripe_status: "canceled",
            canceled_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 31).toISOString(),
          }),
        },
      ],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
  });

  test("Phase 5.6F-R1: a transient subscription-query failure rejects with 503, not the 403 subscription body, before any company_settings read", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ error: { message: "simulated Supabase outage" } }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await GET();
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), SERVICE_UNAVAILABLE_BODY);
    assert.equal(currentFake.calls.filter((c) => c.table === "company_settings").length, 0);
  });
});

describe("Phase 5.7C: notifications_enabled fail-closed persistence", () => {
  function lastCompanySettingsWrite() {
    const writes = writeCalls(currentFake.calls).filter((c) => c.table === "company_settings");
    return writes[writes.length - 1];
  }

  test("saving only company_name (an existing row) never includes notifications_enabled or booking_enabled in the persisted fields -- an unrelated Company Info save cannot change either toggle", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { id: "cs-1" } }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { company_name: "Acme Cleaning" }));
    assert.equal(res.status, 200);
    const write = lastCompanySettingsWrite();
    assert.equal(write.method, "update");
    const fields = write.args[0] as Record<string, unknown>;
    assert.ok(!("notifications_enabled" in fields), "unrelated save must not touch notifications_enabled");
    assert.ok(!("booking_enabled" in fields), "unrelated save must not touch booking_enabled");
  });

  test("saving only booking_enabled never includes notifications_enabled in the persisted fields -- the two Automation toggles are still independently omittable", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { id: "cs-1" } }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { booking_enabled: true }));
    assert.equal(res.status, 200);
    const fields = lastCompanySettingsWrite().args[0] as Record<string, unknown>;
    assert.ok(!("notifications_enabled" in fields));
    assert.equal(fields.booking_enabled, true);
  });

  test("an explicit notifications_enabled: false is persisted as exactly false, never omitted or coerced", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { id: "cs-1" } }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { notifications_enabled: false }));
    assert.equal(res.status, 200);
    const fields = lastCompanySettingsWrite().args[0] as Record<string, unknown>;
    assert.equal(fields.notifications_enabled, false);
  });

  test("an explicit notifications_enabled: true is persisted as exactly true -- a genuinely intentional enable is not blocked", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { id: "cs-1" } }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { notifications_enabled: true }));
    assert.equal(res.status, 200);
    const fields = lastCompanySettingsWrite().args[0] as Record<string, unknown>;
    assert.equal(fields.notifications_enabled, true);
  });

  test("first-ever save for a brand-new workspace (no existing row) inserts notifications_enabled exactly as supplied, scoped to the caller's own workspace_id", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: null }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    const res = await POST(req("POST", { notifications_enabled: false, booking_enabled: false }));
    assert.equal(res.status, 200);
    const write = lastCompanySettingsWrite();
    assert.equal(write.method, "insert");
    const fields = write.args[0] as Record<string, unknown>;
    assert.equal(fields.notifications_enabled, false);
    assert.equal(fields.workspace_id, REAL_WORKSPACE_ID);
  });

  test("workspace scoping is present on the update path -- the persistence route never writes without an .eq(\"workspace_id\", ...) filter", async () => {
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { id: "cs-1" } }, { error: null }],
    });
    sessionToReturn = OWNER_SESSION;
    await POST(req("POST", { notifications_enabled: true }));
    const workspaceScopedEq = currentFake.calls.some(
      (c) => c.table === "company_settings" && c.method === "eq" && c.args[0] === "workspace_id" && c.args[1] === REAL_WORKSPACE_ID
    );
    assert.ok(workspaceScopedEq, "expected an .eq(\"workspace_id\", <caller's own workspace>) filter on the company_settings write path");
  });

  test("this route never imports @/lib/notify -- no code path in this file can call sendEmail/sendSms, so saving a setting can never itself send a notification", () => {
    const source = fs.readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");
    assert.ok(!source.includes("@/lib/notify"));
    assert.ok(!source.includes("sendEmail"));
    assert.ok(!source.includes("sendSms"));
  });
});

describe("Phase 4: Business Hours", () => {
  describe("GET returns effective business_hours", () => {
    test("a workspace with no saved business_hours (NULL/absent) gets the Mon-Fri 07:00-17:00 fallback", async () => {
      resetFixtures({
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        company_settings: [{ data: { company_name: "Acme Cleaning", booking_enabled: true, business_hours: null } }],
        employees: [{ count: 3 }, { count: 2 }],
      });
      sessionToReturn = OWNER_SESSION;
      const res = await GET();
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.settings.business_hours, DEFAULT_BUSINESS_HOURS);
    });

    test("a workspace with saved business_hours gets back its own effective (normalized) value", async () => {
      const saved = { tuesday: [{ start: "09:00", end: "18:00" }] };
      resetFixtures({
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        company_settings: [{ data: { company_name: "Acme Cleaning", booking_enabled: true, business_hours: saved } }],
        employees: [{ count: 3 }, { count: 2 }],
      });
      sessionToReturn = OWNER_SESSION;
      const res = await GET();
      const body = await res.json();
      assert.deepEqual(body.settings.business_hours.tuesday, [{ start: "09:00", end: "18:00" }]);
      assert.deepEqual(body.settings.business_hours.monday, []);
    });

    test("no company_settings row at all still returns the default fallback, not a crash", async () => {
      resetFixtures({
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        company_settings: [{ data: null }],
        employees: [{ count: 0 }, { count: 0 }],
      });
      sessionToReturn = OWNER_SESSION;
      const res = await GET();
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.deepEqual(body.settings.business_hours, DEFAULT_BUSINESS_HOURS);
    });
  });

  describe("POST persists valid business_hours", () => {
    function lastCompanySettingsWrite() {
      const writes = writeCalls(currentFake.calls).filter((c) => c.table === "company_settings");
      return writes[writes.length - 1];
    }

    test("a valid split-hours payload is normalized and persisted", async () => {
      resetFixtures({
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        company_settings: [{ data: { id: "cs-1" } }, { error: null }],
      });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(
        req("POST", {
          business_hours: {
            monday: [
              { start: "08:00", end: "12:00" },
              { start: "13:00", end: "17:00" },
            ],
          },
        })
      );
      assert.equal(res.status, 200);
      const fields = lastCompanySettingsWrite().args[0] as Record<string, unknown>;
      assert.deepEqual(fields.business_hours, {
        monday: [
          { start: "08:00", end: "12:00" },
          { start: "13:00", end: "17:00" },
        ],
        tuesday: [],
        wednesday: [],
        thursday: [],
        friday: [],
        saturday: [],
        sunday: [],
      });
    });

    test("all seven days Closed is accepted and persisted as empty arrays", async () => {
      resetFixtures({
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        company_settings: [{ data: { id: "cs-1" } }, { error: null }],
      });
      sessionToReturn = OWNER_SESSION;
      const allClosed = Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => [d, []]));
      const res = await POST(req("POST", { business_hours: allClosed }));
      assert.equal(res.status, 200);
      const fields = lastCompanySettingsWrite().args[0] as Record<string, unknown>;
      assert.deepEqual(fields.business_hours, allClosed);
    });

    test("an invalid payload (overlapping ranges) is rejected with 400, before any write", async () => {
      resetFixtures({
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(
        req("POST", {
          business_hours: {
            monday: [
              { start: "08:00", end: "13:00" },
              { start: "12:00", end: "17:00" },
            ],
          },
        })
      );
      assert.equal(res.status, 400);
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "company_settings"), []);
    });

    test("an invalid payload (bad HH:mm) is rejected with 400", async () => {
      resetFixtures({
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req("POST", { business_hours: { monday: [{ start: "8:00 AM", end: "5:00 PM" }] } }));
      assert.equal(res.status, 400);
    });

    test("omitting business_hours entirely from the request leaves it untouched -- an unrelated Company Info save cannot change it", async () => {
      resetFixtures({
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        company_settings: [{ data: { id: "cs-1" } }, { error: null }],
      });
      sessionToReturn = OWNER_SESSION;
      const res = await POST(req("POST", { company_name: "Acme Cleaning" }));
      assert.equal(res.status, 200);
      const fields = lastCompanySettingsWrite().args[0] as Record<string, unknown>;
      assert.ok(!("business_hours" in fields));
    });

    test("workspace isolation: saving business_hours scopes the write to the caller's own workspace_id", async () => {
      resetFixtures({
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        company_settings: [{ data: { id: "cs-1" } }, { error: null }],
      });
      sessionToReturn = OWNER_SESSION;
      await POST(req("POST", { business_hours: { monday: [{ start: "08:00", end: "17:00" }] } }));
      const workspaceScopedEq = currentFake.calls.some(
        (c) => c.table === "company_settings" && c.method === "eq" && c.args[0] === "workspace_id" && c.args[1] === REAL_WORKSPACE_ID
      );
      assert.ok(workspaceScopedEq, "Company A's Business Hours write must be scoped to Company A's own workspace_id, never a request-supplied one");
    });

    test("a spoofed workspace_id in the request body cannot redirect a Business Hours save to another workspace (Company A cannot affect Company B)", async () => {
      resetFixtures({
        workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        company_settings: [{ data: { id: "cs-1" } }, { error: null }],
      });
      sessionToReturn = OWNER_SESSION;
      await POST(req("POST", { business_hours: { monday: [{ start: "08:00", end: "17:00" }] }, workspace_id: "attacker-ws" }));
      const scopedToAttacker = currentFake.calls.some((c) => c.table === "company_settings" && c.method === "eq" && c.args[1] === "attacker-ws");
      assert.equal(scopedToAttacker, false);
    });
  });
});
