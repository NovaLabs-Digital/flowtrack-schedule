// Phase 5.4E4: route-level tests for app/api/book/availability/route.ts
// (GET only, fully public/unauthenticated by design). Proves
// requireCapabilityForWorkspace(REAL_WORKSPACE_ID, "canUsePublicBooking") is
// wired before the pre-existing booking_enabled check and before any
// operational read (services/appointments). @/lib/supabaseAdmin is mocked
// in-process; @/lib/entitlementServer is DELIBERATELY LEFT UNMOCKED -- the
// real requireCapabilityForWorkspace/fetchEntitlementForWorkspace/
// resolveWorkspaceEntitlement chain runs against a fake "subscriptions"
// table. No real Supabase/Stripe/network call is reachable. This route has
// no session at all, so @/lib/session is not involved and is not mocked.
// Run with --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createFakeSupabaseAdmin, writeCalls, subscriptionRow, SUBSCRIPTION_RESTRICTED_BODY, SERVICE_UNAVAILABLE_BODY } from "../../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../../lib/testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});

const { GET } = await import("./route.ts");
const { computeAvailableSlots } = await import("../../../../lib/availability.ts");
const { DEFAULT_BUSINESS_HOURS, effectiveBusinessHours } = await import("../../../../lib/businessHours.ts");
const { BUSINESS_TZ } = await import("../../../../lib/timezone.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}
function req(query: string) {
  return new Request(`http://localhost/api/book/availability?${query}`);
}

// A Monday, matching the date convention already used by the other
// appointment route tests (e.g. app/api/appointments/update/route.test.ts).
// Not actually "future" from the real system clock forever -- the FULL_STATES
// tests below freeze time (node:test's mock.timers) to an instant before this
// date so "is this slot in the past" resolves the same way no matter when the
// suite actually runs (see lib/payroll.test.ts's computePayrollRows describe
// for the same fix applied to the same class of hardcoded-date flake).
const DATE_STR = "2026-08-03";

describe("GET /api/book/availability -- entitlement gate (canUsePublicBooking)", () => {
  const FULL_STATES: Array<[string, ReturnType<typeof subscriptionRow>]> = [
    ["active", subscriptionRow({ stripe_status: "active" })],
    ["trialing", subscriptionRow({ stripe_status: "trialing" })],
    ["past_due_grace", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() + 1000).toISOString() })],
    ["internal", subscriptionRow({ billing_mode: "internal", stripe_status: null })],
  ];

  describe("FULL_STATES (time frozen before DATE_STR so slots aren't filtered as past)", () => {
    // Freezes Date globally for the process -- both this test file's own
    // computeAvailableSlots(DATE_STR, ...) call (the `expected` value below)
    // and route.ts's internal todayBusinessDate()/computeAvailableSlots()
    // calls (both ultimately backed by Luxon's DateTime.now(), which reads
    // Date.now() live) agree on the same fixed "now" -- Sunday noon UTC,
    // safely before DATE_STR's Monday business day starts in every timezone.
    // Neither lib/availability.ts nor route.ts is modified.
    before(() => {
      mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-02T12:00:00.000Z").getTime() });
    });
    after(() => {
      mock.timers.reset();
    });

    for (const [label, row] of FULL_STATES) {
      test(`${label} permits availability lookup, existing response contract unchanged`, async () => {
        resetFixtures({
          subscriptions: [{ data: row }],
          company_settings: [{ data: { booking_enabled: true } }],
          services: [{ data: { duration_minutes: 60 } }],
          appointments: [{ data: [] }],
        });
        const res = await GET(req(`date=${DATE_STR}&service=Haircut`));
        assert.equal(res.status, 200, label);
        const body = await res.json();
        const expected = computeAvailableSlots(DATE_STR, 60, [], DEFAULT_BUSINESS_HOURS, BUSINESS_TZ);
        assert.deepEqual(body.slots, expected, label);
        assert.ok(expected.length > 0, "sanity: the fixture date/duration actually yields slots");
        assert.equal(writeCalls(currentFake.calls).length, 0, label);
      });
    }
  });

  const RESTRICTED_STATES: Array<[string, ReturnType<typeof subscriptionRow> | null]> = [
    ["past_due_expired", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() - 1000).toISOString() })],
    ["canceled", subscriptionRow({ stripe_status: "canceled" })],
    ["unpaid", subscriptionRow({ stripe_status: "unpaid" })],
    ["no_subscription (no row)", null],
    ["malformed", subscriptionRow({ stripe_status: "not_a_real_status" })],
  ];

  for (const [label, row] of RESTRICTED_STATES) {
    test(`${label} returns the exact SUBSCRIPTION_RESTRICTED 403, zero operational reads`, async () => {
      resetFixtures({ subscriptions: [{ data: row }] });
      const res = await GET(req(`date=${DATE_STR}&service=Haircut`));
      assert.equal(res.status, 403, label);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY, label);
      // Not even the pre-existing booking_enabled (company_settings) read is reached.
      assert.deepEqual(currentFake.calls.filter((c) => c.table !== "subscriptions"), [], label);
    });
  }

  test("query_error on the subscriptions read denies, zero operational reads", async () => {
    resetFixtures({ subscriptions: [{ error: { message: "simulated DB error" } }] });
    const res = await GET(req(`date=${DATE_STR}&service=Haircut`));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), SERVICE_UNAVAILABLE_BODY);
    assert.deepEqual(currentFake.calls.filter((c) => c.table !== "subscriptions"), []);
  });

  test("workspace identity is the fixed REAL_WORKSPACE_ID constant -- there is no request parameter that can select a different workspace", async () => {
    resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
    const res = await GET(req(`date=${DATE_STR}&service=Haircut&workspace_id=attacker-ws`));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    assert.equal(
      currentFake.calls.filter((c) => c.table === "subscriptions" && c.method === "maybeSingle").length,
      1,
      "the real REAL_WORKSPACE_ID path ran exactly once, unaffected by the spoofed param"
    );
  });

  test("existing booking_enabled business rule still applies, unchanged, once entitled", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: false } }],
    });
    const res = await GET(req(`date=${DATE_STR}&service=Haircut`));
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Online booking is currently unavailable." });
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "services" || c.table === "appointments"), []);
  });

  describe("query-parameter validation runs only after entitlement (and the pre-existing booking_enabled check)", () => {
    test("missing service + restricted workspace -> the exact SUBSCRIPTION_RESTRICTED 403, not 400", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
      const res = await GET(req(`date=${DATE_STR}`));
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    });

    test("missing service + entitled + booking enabled -> the existing 400 'Missing service' response", async () => {
      resetFixtures({
        subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
        company_settings: [{ data: { booking_enabled: true } }],
      });
      const res = await GET(req(`date=${DATE_STR}`));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Missing service" });
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "services"), []);
    });

    test("invalid date + restricted workspace -> the exact SUBSCRIPTION_RESTRICTED 403, not 400", async () => {
      resetFixtures({ subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }] });
      const res = await GET(req(`date=not-a-date&service=Haircut`));
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), SUBSCRIPTION_RESTRICTED_BODY);
    });
  });
});

describe("Phase 4: Business Hours drive public availability", () => {
  before(() => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-02T12:00:00.000Z").getTime() });
  });
  after(() => {
    mock.timers.reset();
  });

  test("a workspace-saved Closed day (empty array) yields zero slots, even though the default hours would be open", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true, business_hours: { monday: [] } } }],
      services: [{ data: { duration_minutes: 60 } }],
      appointments: [{ data: [] }],
    });
    const res = await GET(req(`date=${DATE_STR}&service=Haircut`));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.slots, []);
  });

  test("a workspace-saved split-hours day (lunch gap) produces zero slots inside the gap", async () => {
    const businessHours = {
      monday: [
        { start: "08:00", end: "12:00" },
        { start: "13:00", end: "17:00" },
      ],
    };
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true, business_hours: businessHours } }],
      services: [{ data: { duration_minutes: 30 } }],
      appointments: [{ data: [] }],
    });
    const res = await GET(req(`date=${DATE_STR}&service=Haircut`));
    assert.equal(res.status, 200);
    const body = await res.json();
    const expected = computeAvailableSlots(DATE_STR, 30, [], effectiveBusinessHours(businessHours), BUSINESS_TZ);
    assert.deepEqual(body.slots, expected);
    for (const s of body.slots as string[]) {
      const hm = s.slice(11, 16);
      assert.ok(!(hm >= "12:00" && hm < "13:00"), `unexpected slot inside the lunch gap: ${s}`);
    }
  });

  test("NULL business_hours falls back to the default Mon-Fri 07:00-17:00 hours, matching pre-Phase-4 behavior", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true, business_hours: null } }],
      services: [{ data: { duration_minutes: 60 } }],
      appointments: [{ data: [] }],
    });
    const res = await GET(req(`date=${DATE_STR}&service=Haircut`));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.slots, computeAvailableSlots(DATE_STR, 60, [], DEFAULT_BUSINESS_HOURS, BUSINESS_TZ));
    assert.ok(body.slots.length > 0);
  });
});

describe("Phase 5D: public availability resolves the trusted workspace timezone, not a hardcoded BUSINESS_TZ", () => {
  before(() => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-02T12:00:00.000Z").getTime() });
  });
  after(() => {
    mock.timers.reset();
  });

  test("a saved non-default timezone (Pacific) shifts the returned UTC slot instants, matching computeAvailableSlots(..., 'America/Los_Angeles') exactly, not the NY default", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true, timezone: "America/Los_Angeles" } }],
      services: [{ data: { duration_minutes: 60 } }],
      appointments: [{ data: [] }],
    });
    const res = await GET(req(`date=${DATE_STR}&service=Haircut`));
    assert.equal(res.status, 200);
    const body = await res.json();
    const expectedLA = computeAvailableSlots(DATE_STR, 60, [], DEFAULT_BUSINESS_HOURS, "America/Los_Angeles");
    const expectedNY = computeAvailableSlots(DATE_STR, 60, [], DEFAULT_BUSINESS_HOURS, BUSINESS_TZ);
    assert.deepEqual(body.slots, expectedLA);
    assert.notDeepEqual(body.slots, expectedNY, "sanity: LA and NY must actually produce different UTC instants for the same local hours");
  });

  test("NULL/missing timezone on the company_settings row falls back to America/New_York, matching effectiveTimezone(null)", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true, timezone: null } }],
      services: [{ data: { duration_minutes: 60 } }],
      appointments: [{ data: [] }],
    });
    const res = await GET(req(`date=${DATE_STR}&service=Haircut`));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.slots, computeAvailableSlots(DATE_STR, 60, [], DEFAULT_BUSINESS_HOURS, BUSINESS_TZ));
  });

  test("there is no request parameter that can influence the resolved timezone -- a spoofed query string is silently ignored", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      company_settings: [{ data: { booking_enabled: true, timezone: "America/Los_Angeles" } }],
      services: [{ data: { duration_minutes: 60 } }],
      appointments: [{ data: [] }],
    });
    const res = await GET(req(`date=${DATE_STR}&service=Haircut&timezone=Pacific/Honolulu&tz=Pacific/Honolulu`));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.slots, computeAvailableSlots(DATE_STR, 60, [], DEFAULT_BUSINESS_HOURS, "America/Los_Angeles"));
  });
});

describe("the entitlement gate is source-correctly scoped to the public-booking capability", () => {
  const routeSource = fs.readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

  test("calls requireCapabilityForWorkspace(REAL_WORKSPACE_ID, \"canUsePublicBooking\") -- never requireCapability or canMutateOperationalData", () => {
    assert.ok(routeSource.includes('requireCapabilityForWorkspace(REAL_WORKSPACE_ID, "canUsePublicBooking")'));
    assert.ok(!routeSource.includes("canMutateOperationalData"));
    assert.ok(!routeSource.includes("requireCapability(session"));
  });

  test("the gate runs before the pre-existing company_settings booking_enabled read", () => {
    const gateIndex = routeSource.indexOf("requireCapabilityForWorkspace(");
    const settingsIndex = routeSource.indexOf('.from("company_settings")');
    assert.ok(gateIndex > -1 && settingsIndex > -1 && gateIndex < settingsIndex);
  });
});
