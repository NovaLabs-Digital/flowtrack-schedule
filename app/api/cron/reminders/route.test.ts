// Phase 5.4E5: route-level tests for app/api/cron/reminders/route.ts
// (GET only, scheduler-triggered, no session -- authenticated by a
// query-string secret compared with process.env.CRON_SECRET via
// safeEqual). Proves requireCapabilityForWorkspace(workspaceId,
// "canSendNotifications") is resolved once per unique workspace present in
// a run, strictly after scheduler authentication and strictly before any
// per-workspace operational read (the client lookup), mutation, or
// provider/audit call. @/lib/supabaseAdmin and @/lib/notify are mocked
// in-process; @/lib/entitlementServer is DELIBERATELY LEFT UNMOCKED -- the
// real requireCapabilityForWorkspace/fetchEntitlementForWorkspace/
// resolveWorkspaceEntitlement chain runs against a fake "subscriptions"
// table. This route has no session at all, so @/lib/session is not
// involved and is not mocked. The REAL lib/notify.ts constructs a Twilio
// client at module-load time and would throw without real credentials, so
// it must never be imported -- this is the test-only import seam already
// used by every other notification-capable route's tests; no production
// behavior changes. No real Supabase/Stripe/Twilio/Resend/network call is
// reachable. Run with --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.CRON_SECRET = "test-cron-secret";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createFakeSupabaseAdmin, createFakeNotify, subscriptionRow, writeCalls } from "../../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../../lib/testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});
let currentNotify = createFakeNotify({ from: (t: string) => currentFake.supabaseAdmin.from(t) });

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});
mock.module("@/lib/notify", {
  namedExports: {
    shouldSend: (...args: [string | undefined, "email" | "sms"]) => currentNotify.namedExports.shouldSend(...args),
    describeProviderError: (...args: [unknown]) => currentNotify.namedExports.describeProviderError(...args),
    recordMessageSent: (...args: [unknown]) => currentNotify.namedExports.recordMessageSent(...(args as [never])),
    sendEmail: (...args: [string, string, string, string]) => currentNotify.namedExports.sendEmail(...args),
    sendSms: (...args: [string, string, string]) => currentNotify.namedExports.sendSms(...args),
  },
});

const { GET } = await import("./route.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
  currentNotify = createFakeNotify({ from: (t: string) => currentFake.supabaseAdmin.from(t) });
}
function req(secret: string | null | undefined = "test-cron-secret", extra = "") {
  const base = "http://localhost/api/cron/reminders";
  if (secret === null || secret === undefined) return new Request(`${base}${extra ? `?${extra}` : ""}`);
  const qs = `secret=${encodeURIComponent(secret)}${extra ? `&${extra}` : ""}`;
  return new Request(`${base}?${qs}`);
}

const WORKSPACE_A = "aaaaaaaa-0000-0000-0000-0000000000a1";
const WORKSPACE_B = "bbbbbbbb-0000-0000-0000-0000000000b1";
const WORKSPACE_C = "cccccccc-0000-0000-0000-0000000000c1";

function apptCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "appt-1",
    scheduled_for: "2026-08-03T14:00:00.000Z",
    service_type: "Haircut",
    client_id: "client-1",
    workspace_id: REAL_WORKSPACE_ID,
    ...overrides,
  };
}
function optedInClient(overrides: Record<string, unknown> = {}) {
  return { name: "Jane Doe", email: "jane@example.com", phone: "+15551234567", auto_email: true, auto_sms: true, ...overrides };
}

describe("GET /api/cron/reminders -- scheduler authentication", () => {
  test("missing secret is denied before any Supabase call", async () => {
    resetFixtures({});
    const res = await GET(req(null));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
    assert.equal(currentFake.calls.length, 0);
  });

  test("wrong secret is denied before any Supabase call", async () => {
    resetFixtures({});
    const res = await GET(req("wrong-secret"));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
    assert.equal(currentFake.calls.length, 0);
  });

  test("correct secret reaches entitlement/operational processing", async () => {
    resetFixtures({ appointments: [{ data: [] }] });
    const res = await GET(req("test-cron-secret"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 0, sent: 0, entitlementSkipped: 0 });
  });

  test("the secret value never appears in any response body", async () => {
    resetFixtures({});
    const denied = await GET(req("wrong-secret"));
    const deniedText = JSON.stringify(await denied.json());
    assert.ok(!deniedText.includes("test-cron-secret"));

    resetFixtures({ appointments: [{ data: [] }] });
    const allowed = await GET(req("test-cron-secret"));
    const allowedText = JSON.stringify(await allowed.json());
    assert.ok(!allowedText.includes("test-cron-secret"));
  });
});

describe("GET /api/cron/reminders -- per-workspace entitlement gate (canSendNotifications)", () => {
  const FULL_STATES: Array<[string, ReturnType<typeof subscriptionRow>]> = [
    ["active", subscriptionRow({ stripe_status: "active" })],
    ["trialing", subscriptionRow({ stripe_status: "trialing" })],
    ["past_due_grace", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() + 1000).toISOString() })],
    ["internal", subscriptionRow({ billing_mode: "internal", stripe_status: null })],
  ];

  for (const [label, row] of FULL_STATES) {
    test(`${label} allows -- the appointment is processed, reminder marked sent`, async () => {
      resetFixtures({
        subscriptions: [{ data: row }],
        appointments: [{ data: [apptCandidate()] }, { error: null }],
        clients: [{ data: optedInClient() }],
        company_settings: [{ data: { notifications_enabled: true } }],
        messages_sent: [{ error: null }, { error: null }],
      });
      const res = await GET(req());
      assert.equal(res.status, 200, label);
      assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 1, entitlementSkipped: 0 }, label);
      assert.equal(currentNotify.emailCalls.length, 1, label);
      assert.equal(currentNotify.smsCalls.length, 1, label);
    });
  }

  test("exact trusted demo workspace resolves via the real short-circuit (zero subscriptions queries) -- opt-in/notifications_enabled suppression still independently applies", async () => {
    resetFixtures({
      appointments: [{ data: [apptCandidate({ workspace_id: DEMO_WORKSPACE_ID })] }, { error: null }],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [{ error: null }, { error: null }],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 1, entitlementSkipped: 0 });
    assert.equal(currentFake.calls.filter((c) => c.table === "subscriptions").length, 0, "the demo bypass never touches Supabase for entitlement");
  });

  test("granting the exact demo workspace entitlement does not override the independent notifications_enabled/opt-in suppression", async () => {
    resetFixtures({
      appointments: [{ data: [apptCandidate({ workspace_id: DEMO_WORKSPACE_ID })] }, { error: null }],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: false } }], // owner toggle off, independent of entitlement
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 1, entitlementSkipped: 0 });
    assert.equal(currentNotify.emailCalls.length, 0, "notifications_enabled=false still suppresses the send regardless of entitlement");
    assert.equal(currentNotify.smsCalls.length, 0);
  });

  const RESTRICTED_STATES: Array<[string, ReturnType<typeof subscriptionRow> | null]> = [
    ["past_due_expired", subscriptionRow({ stripe_status: "past_due", grace_until: new Date(Date.now() - 1000).toISOString() })],
    ["canceled", subscriptionRow({ stripe_status: "canceled" })],
    ["unpaid", subscriptionRow({ stripe_status: "unpaid" })],
    ["no_subscription (no row)", null],
    ["malformed", subscriptionRow({ stripe_status: "not_a_real_status" })],
  ];

  for (const [label, row] of RESTRICTED_STATES) {
    test(`${label} skips the appointment entirely -- zero client read, zero provider calls, zero messages_sent, no reminder-sent update`, async () => {
      resetFixtures({
        subscriptions: [{ data: row }],
        appointments: [{ data: [apptCandidate()] }], // no second (update) fixture -- it must never be reached
      });
      const res = await GET(req());
      assert.equal(res.status, 200, label);
      assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 0, entitlementSkipped: 1 }, label);
      assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" || c.table === "company_settings" || c.table === "messages_sent"), [], label);
      assert.equal(currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update").length, 0, label);
      assert.equal(currentNotify.emailCalls.length, 0, label);
      assert.equal(currentNotify.smsCalls.length, 0, label);
    });
  }

  test("entitlement query_error fails closed -- same skip behavior as a restricted state", async () => {
    resetFixtures({
      subscriptions: [{ error: { message: "simulated DB error" } }],
      appointments: [{ data: [apptCandidate()] }],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 0, entitlementSkipped: 1 });
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" || c.table === "messages_sent"), []);
  });

  test("skip handling reveals no sensitive subscription detail -- response body contains only aggregate counts", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }],
      appointments: [{ data: [apptCandidate()] }],
    });
    const res = await GET(req());
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ["checked", "entitlementSkipped", "ok", "sent"]);
  });
});

describe("GET /api/cron/reminders -- multi-workspace isolation in a single run", () => {
  test("one entitled, one restricted, one query-error workspace: only the entitled one sends; each resolved at most once", async () => {
    resetFixtures({
      subscriptions: [
        { data: subscriptionRow({ stripe_status: "active" }) }, // WORKSPACE_A
        { data: subscriptionRow({ stripe_status: "canceled" }) }, // WORKSPACE_B
        { error: { message: "simulated DB error" } }, // WORKSPACE_C
      ],
      appointments: [
        {
          data: [
            apptCandidate({ id: "appt-a", workspace_id: WORKSPACE_A, client_id: "client-a" }),
            apptCandidate({ id: "appt-b", workspace_id: WORKSPACE_B, client_id: "client-b" }),
            apptCandidate({ id: "appt-c", workspace_id: WORKSPACE_C, client_id: "client-c" }),
          ],
        },
        { error: null }, // update call for appt-a only
      ],
      clients: [{ data: optedInClient() }], // only ever read for WORKSPACE_A's appointment
      company_settings: [{ data: { notifications_enabled: true } }], // only ever read for WORKSPACE_A
      messages_sent: [{ error: null }, { error: null }],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 3, sent: 1, entitlementSkipped: 2 });
    assert.equal(currentNotify.emailCalls.length, 1, "only the entitled workspace's client received an email");
    assert.equal(currentNotify.emailCalls[0]?.workspaceId, WORKSPACE_A);
    assert.equal(currentNotify.smsCalls.length, 1);
    assert.equal(currentNotify.smsCalls[0]?.workspaceId, WORKSPACE_A);
    assert.equal(
      currentFake.calls.filter((c) => c.table === "subscriptions" && c.method === "maybeSingle").length,
      3,
      "entitlement resolved exactly once per unique workspace, not once per appointment"
    );
    assert.equal(
      currentFake.calls.filter((c) => c.table === "clients" && c.method === "single").length,
      1,
      "only WORKSPACE_A's client was ever read"
    );
  });

  test("a restricted workspace does not abort processing of appointments in other workspaces", async () => {
    resetFixtures({
      subscriptions: [
        { data: subscriptionRow({ stripe_status: "canceled" }) }, // WORKSPACE_B first this time
        { data: subscriptionRow({ stripe_status: "active" }) }, // WORKSPACE_A
      ],
      appointments: [
        {
          data: [
            apptCandidate({ id: "appt-b", workspace_id: WORKSPACE_B, client_id: "client-b" }),
            apptCandidate({ id: "appt-a", workspace_id: WORKSPACE_A, client_id: "client-a" }),
          ],
        },
        { error: null },
      ],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [{ error: null }, { error: null }],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 2, sent: 1, entitlementSkipped: 1 });
  });

  test("the same workspace appearing twice in one run resolves entitlement only once (cached)", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        {
          data: [
            apptCandidate({ id: "appt-1", workspace_id: WORKSPACE_A, client_id: "client-1" }),
            apptCandidate({ id: "appt-2", workspace_id: WORKSPACE_A, client_id: "client-2" }),
          ],
        },
        { error: null },
        { error: null },
      ],
      clients: [{ data: optedInClient() }, { data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [{ error: null }, { error: null }, { error: null }, { error: null }],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 2, sent: 2, entitlementSkipped: 0 });
    assert.equal(currentFake.calls.filter((c) => c.table === "subscriptions" && c.method === "maybeSingle").length, 1);
  });
});

describe("GET /api/cron/reminders -- workspace identity cannot be spoofed", () => {
  test("extra query-string parameters (workspace_id, X-Workspace-Id-like values) have no effect -- only the DB-derived workspace_id is ever checked", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }],
      appointments: [{ data: [apptCandidate({ workspace_id: WORKSPACE_A })] }],
    });
    const res = await GET(req("test-cron-secret", `workspace_id=${DEMO_WORKSPACE_ID}`));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 0, entitlementSkipped: 1 });
    assert.equal(currentFake.calls.filter((c) => c.table === "subscriptions" && c.method === "maybeSingle").length, 1, "the real WORKSPACE_A path ran, unaffected by the spoofed param");
  });

  test("an arbitrary request header cannot select or unlock a different workspace", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "canceled" }) }],
      appointments: [{ data: [apptCandidate({ workspace_id: WORKSPACE_A })] }],
    });
    const url = `http://localhost/api/cron/reminders?secret=test-cron-secret`;
    const res = await GET(new Request(url, { headers: { "x-workspace-id": DEMO_WORKSPACE_ID } }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 0, entitlementSkipped: 1 });
  });
});

describe("GET /api/cron/reminders -- existing notification behavior preserved once entitled", () => {
  test("client opted out of both channels -- still marked sent (existing 'processed' semantics), zero provider calls", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, { error: null }],
      clients: [{ data: optedInClient({ auto_email: false, auto_sms: false }) }],
      company_settings: [{ data: { notifications_enabled: true } }],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 1, entitlementSkipped: 0 });
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });

  test("notifications_enabled=false (owner toggle) -- still marked sent, zero provider calls, unchanged from before this phase", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, { error: null }],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: false } }],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 1, entitlementSkipped: 0 });
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });

  test("client lookup failure is skipped exactly as before (not counted as an entitlement skip)", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }],
      clients: [{ error: { message: "not found" } }],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 0, entitlementSkipped: 0 });
  });

  test("a provider failure on one channel is isolated -- the other channel still attempts, the appointment is still marked sent", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, { error: null }],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [{ error: null }, { error: null }],
    });
    currentNotify.setSendEmailImpl(async () => {
      throw new Error("simulated Resend outage");
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 1, entitlementSkipped: 0 });
    assert.equal(currentNotify.emailCalls.length, 1, "email was still attempted");
    assert.equal(currentNotify.smsCalls.length, 1, "sms still attempted despite the email failure");
    assert.equal(currentFake.calls.filter((c) => c.table === "messages_sent" && c.method === "insert").length, 2, "both attempts (success and failure) are still audited");
  });

  test("no write occurs beyond the pre-existing set (appointments update + messages_sent inserts) for an allowed, fully-opted-in workspace", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, { error: null }],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [{ error: null }, { error: null }],
    });
    await GET(req());
    const writes = writeCalls(currentFake.calls);
    assert.deepEqual(
      writes.map((w) => w.table).sort(),
      ["appointments", "messages_sent", "messages_sent"].sort()
    );
  });
});

describe("the entitlement gate is source-correctly scoped (source-level proof)", () => {
  const routeSource = fs.readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");

  test("calls requireCapabilityForWorkspace(workspaceId, \"canSendNotifications\") -- never requireCapability with a manufactured session", () => {
    assert.ok(routeSource.includes('requireCapabilityForWorkspace(workspaceId, "canSendNotifications")'));
    assert.ok(!routeSource.includes("requireCapability(session"));
    assert.ok(!routeSource.includes('"canMutateOperationalData"'));
  });

  test("the entitlement check runs before the per-appointment client (PII) read", () => {
    const gateIndex = routeSource.indexOf("if (!(await workspaceEntitled(a.workspace_id)))");
    const clientReadIndex = routeSource.indexOf('.from("clients")');
    assert.ok(gateIndex > -1 && clientReadIndex > -1 && gateIndex < clientReadIndex);
  });

  test("scheduler-secret authentication remains the very first check, before the entitlement gate", () => {
    const authIndex = routeSource.indexOf("safeEqual(secret, cronSecret)");
    const gateIndex = routeSource.indexOf("workspaceEntitled(a.workspace_id)");
    assert.ok(authIndex > -1 && gateIndex > -1 && authIndex < gateIndex);
  });

  test("demo suppression via is_demo = false on the discovery query is unchanged", () => {
    assert.ok(routeSource.includes('.eq("is_demo", false)'));
  });
});
