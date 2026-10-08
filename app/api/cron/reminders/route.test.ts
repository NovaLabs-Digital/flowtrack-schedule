// Phase 5.4E5: route-level tests for app/api/cron/reminders/route.ts
// (GET only, scheduler-triggered, no session -- authenticated by an
// `Authorization: Bearer <CRON_SECRET>` header via lib/cronAuth.ts, matching
// how Vercel Cron actually delivers the configured secret -- see Phase
// 5.6C). Proves requireCapabilityForWorkspace(workspaceId,
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
import { DateTime } from "luxon";
import { createFakeSupabaseAdmin, createFakeNotify, subscriptionRow, writeCalls } from "../../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../../lib/testSupport.ts";

// The route's new per-row revalidation (SFT reminder reliability fix) checks
// the fresh row's scheduled_for against the REAL current time (DateTime.now()
// inside the route, not mockable from here) -- so a timezone-content test
// can no longer use an arbitrary fixed historical instant (the fake
// Supabase harness never enforced the 23-25h window itself, but this new
// revalidation genuinely does real Date math). withinWindowIso() picks an
// instant safely inside the real window at whatever moment the test suite
// actually runs; localHour() computes the expected formatted local time for
// that SAME instant via the real Luxon conversion, so these tests stay
// correct across DST boundaries instead of relying on a hardcoded hour tied
// to one specific calendar date.
function withinWindowIso(hoursAhead = 24): string {
  return DateTime.now().plus({ hours: hoursAhead }).toUTC().toISO()!;
}
function localHour(iso: string, tz: string): string {
  // Identical formatting call to lib/templates.ts's own fmtTime, so this
  // always matches exactly what the real route would produce.
  return DateTime.fromISO(iso).setZone(tz).toFormat("h:mm a");
}

let currentFake = createFakeSupabaseAdmin({});
let currentNotify = createFakeNotify({ from: (t: string) => currentFake.supabaseAdmin.from(t) });

// Deterministic claim tokens: the real lib/claimToken.ts wraps
// crypto.randomUUID(), which can't be predicted by a fixture. Mocking this
// thin, dedicated seam (rather than Node's built-in "crypto" module, which
// could affect anything else reachable from this test file) gives every
// claim attempt within a test a known, sequential token -- "test-claim-
// token-1" for the first appointment that reaches the claim step in a run,
// "test-claim-token-2" for the second, and so on -- so revalidate/finalize
// fixtures can assert the exact ownership-check value the real route would
// send. Reset to 0 in resetFixtures() below so every test starts counting
// from 1 regardless of what ran before it.
let claimTokenCounter = 0;
mock.module("@/lib/claimToken", {
  namedExports: { generateClaimToken: () => `test-claim-token-${++claimTokenCounter}` },
});

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});
mock.module("@/lib/notify", {
  namedExports: {
    shouldSend: (...args: [string | undefined, "email" | "sms"]) => currentNotify.namedExports.shouldSend(...args),
    describeProviderError: (...args: [unknown]) => currentNotify.namedExports.describeProviderError(...args),
    recordMessageSent: (...args: [unknown]) => currentNotify.namedExports.recordMessageSent(...(args as [never])),
    sanitizeCompanyName: (...args: [string | null | undefined]) => currentNotify.namedExports.sanitizeCompanyName(...args),
    getCompanyName: (...args: [string]) => currentNotify.namedExports.getCompanyName(...args),
    sendEmail: (...args: [string, string, string, string, string?, string?]) => currentNotify.namedExports.sendEmail(...args),
    sendSms: (...args: [string, string, string]) => currentNotify.namedExports.sendSms(...args),
  },
});

const { GET } = await import("./route.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
  currentNotify = createFakeNotify({ from: (t: string) => currentFake.supabaseAdmin.from(t) });
  claimTokenCounter = 0;
}
// `token` is the Bearer credential sent in the Authorization header (the
// real Vercel Cron transport); `extraQuery` optionally appends an unrelated
// query string to prove it has no bearing on authentication.
function req(token: string | null | undefined = "test-cron-secret", extraQuery = "") {
  const base = "http://localhost/api/cron/reminders";
  const url = `${base}${extraQuery ? `?${extraQuery}` : ""}`;
  const headers: Record<string, string> = {};
  if (token !== null && token !== undefined) headers.authorization = `Bearer ${token}`;
  return new Request(url, { headers });
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
// --- SFT reminder claim protocol fixture helpers -------------------------
// The route's per-appointment sequence against the "appointments" table is
// now: (1) claim (conditional UPDATE...RETURNING), (2) revalidate (SELECT,
// immediately before delivery), and -- only once every applicable channel
// has genuinely succeeded -- (3) finalize (conditional UPDATE...RETURNING).
// A worker that decides not to attempt delivery after claiming (ineligible
// on revalidation, or a client-lookup failure) releases the claim instead
// of finalizing: a bare `.update(...)` await, consumed exactly like any
// other write with no `.select()`/`.maybeSingle()` of its own.

// 1. Claim: `.update(...).select("id").maybeSingle()`. `{data:{id}}` means
// the claim succeeded (no other process holds it, and the row is still
// eligible); `{data:null}` means a concurrent worker already holds it, or
// the row no longer qualifies.
function claimOk(id = "appt-1") {
  return { data: { id } };
}
function claimFail() {
  return { data: null };
}

// 2. Revalidate: `.select(...).maybeSingle()`, immediately before delivery.
// Defaults mirror apptCandidate()'s own defaults so a test that doesn't
// change the candidate's service_type/scheduled_for can queue this with no
// overrides; a test that does must pass the matching override here too,
// since the actual message content now comes from THIS fixture, never the
// stale discovery-query snapshot. `claimToken` defaults to the FIRST token
// claimTokenCounter will mint in a run ("test-claim-token-1") -- a test
// with more than one claiming appointment must pass the next one(s)
// explicitly ("test-claim-token-2", ...), in the order the route will
// actually reach them.
function revalidateOk(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      status: "scheduled",
      is_demo: false,
      service_type: "Haircut",
      // Dynamic, not apptCandidate()'s fixed historical literal: the
      // route's revalidation checks this value against the REAL current
      // time, which the fake Supabase harness never enforces on its own.
      scheduled_for: withinWindowIso(),
      reminder_24h_sent_at: null,
      reminder_24h_claim_token: "test-claim-token-1",
      ...overrides,
    },
  };
}
function revalidateFail() {
  return { data: null };
}

// 3a. alreadyDelivered() per-channel check: `.select("id")...maybeSingle()`.
// `{data:null}` = not yet delivered (the route will attempt it);
// `{data:{id}}` = a messages_sent row already exists for this exact
// appointment/channel/kind with a non-"failed" provider_id, so the route
// skips sending it again.
function notDelivered() {
  return { data: null };
}
function delivered() {
  return { data: { id: "msg-already-sent" } };
}

// 3b. recordMessageSent()'s own insert -- a bare `.insert(row)` await, same
// shape as every other write fixture in this file.
const messageRecorded = { error: null };

// 4. Finalize: `.update(...).select("id").maybeSingle()`, conditioned on
// claim_token ownership. `{data:{id}}` = finalized successfully;
// `{data:null}` = ownership was lost (a newer claimant reclaimed this row
// in the meantime) -- the route logs this but still counts the send,
// because delivery (and its messages_sent audit row) already happened
// regardless of who owns the row afterward.
function finalizeOk(id = "appt-1") {
  return { data: { id } };
}
function finalizeOwnershipLost() {
  return { data: null };
}

describe("GET /api/cron/reminders -- scheduler authentication (Bearer, Phase 5.6C)", () => {
  test("missing Authorization header is denied before any Supabase call", async () => {
    resetFixtures({});
    const res = await GET(req(null));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
    assert.equal(currentFake.calls.length, 0);
  });

  test("wrong scheme is denied before any Supabase call", async () => {
    resetFixtures({});
    const res = await GET(new Request("http://localhost/api/cron/reminders", { headers: { authorization: "Basic dGVzdC1jcm9uLXNlY3JldA==" } }));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
    assert.equal(currentFake.calls.length, 0);
  });

  test("empty Bearer token is denied before any Supabase call", async () => {
    resetFixtures({});
    const res = await GET(new Request("http://localhost/api/cron/reminders", { headers: { authorization: "Bearer " } }));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
    assert.equal(currentFake.calls.length, 0);
  });

  test("wrong token is denied before any Supabase call", async () => {
    resetFixtures({});
    const res = await GET(req("wrong-secret"));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
    assert.equal(currentFake.calls.length, 0);
  });

  test("missing CRON_SECRET env fails closed even with a well-formed Bearer header", async () => {
    resetFixtures({});
    const original = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const res = await GET(req("test-cron-secret"));
      assert.equal(res.status, 401);
      assert.equal(currentFake.calls.length, 0);
    } finally {
      process.env.CRON_SECRET = original;
    }
  });

  test("query-string-only authentication (?secret=) is rejected -- the Authorization header is required", async () => {
    resetFixtures({});
    const res = await GET(req(null, "secret=test-cron-secret"));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
    assert.equal(currentFake.calls.length, 0);
  });

  test("correct Bearer token reaches entitlement/operational processing", async () => {
    resetFixtures({ appointments: [{ data: [] }] });
    const res = await GET(req("test-cron-secret"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 0, sent: 0, entitlementSkipped: 0 });
  });

  test("a valid Bearer token still works if an unrelated ?secret= query parameter is present", async () => {
    resetFixtures({ appointments: [{ data: [] }] });
    const res = await GET(req("test-cron-secret", "secret=irrelevant-decoy"));
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
        appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk(), finalizeOk()],
        clients: [{ data: optedInClient() }],
        company_settings: [{ data: { notifications_enabled: true } }],
        messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
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
      appointments: [{ data: [apptCandidate({ workspace_id: DEMO_WORKSPACE_ID })] }, claimOk(), revalidateOk(), finalizeOk()],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 1, entitlementSkipped: 0 });
    assert.equal(currentFake.calls.filter((c) => c.table === "subscriptions").length, 0, "the demo bypass never touches Supabase for entitlement");
  });

  test("granting the exact demo workspace entitlement does not override the independent notifications_enabled/opt-in suppression", async () => {
    resetFixtures({
      appointments: [{ data: [apptCandidate({ workspace_id: DEMO_WORKSPACE_ID })] }, claimOk(), revalidateOk(), finalizeOk()],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: false } }], // owner toggle off, independent of entitlement
      // notifying=false makes both channels "not applicable" before
      // alreadyDelivered() is ever called -- zero messages_sent reads too.
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
        // claim/revalidate/finalize for appt-a only -- b/c are skipped by the entitlement gate first
        claimOk("appt-a"), revalidateOk(), finalizeOk("appt-a"),
      ],
      clients: [{ data: optedInClient() }], // only ever read for WORKSPACE_A's appointment
      company_settings: [{ data: { notifications_enabled: true } }], // only ever read for WORKSPACE_A
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
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
        claimOk("appt-a"), revalidateOk(), finalizeOk("appt-a"), // claim/revalidate/finalize for appt-a only
      ],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
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
        claimOk("appt-1"), revalidateOk({ reminder_24h_claim_token: "test-claim-token-1" }), finalizeOk("appt-1"),
        claimOk("appt-2"), revalidateOk({ reminder_24h_claim_token: "test-claim-token-2" }), finalizeOk("appt-2"),
      ],
      clients: [{ data: optedInClient() }, { data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [
        notDelivered(), messageRecorded, notDelivered(), messageRecorded,
        notDelivered(), messageRecorded, notDelivered(), messageRecorded,
      ],
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
    const url = `http://localhost/api/cron/reminders`;
    const res = await GET(new Request(url, { headers: { authorization: "Bearer test-cron-secret", "x-workspace-id": DEMO_WORKSPACE_ID } }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 0, entitlementSkipped: 1 });
  });
});

describe("GET /api/cron/reminders -- existing notification behavior preserved once entitled", () => {
  test("client opted out of both channels -- still marked sent (existing 'processed' semantics), zero provider calls", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk(), finalizeOk()],
      clients: [{ data: optedInClient({ auto_email: false, auto_sms: false }) }],
      company_settings: [{ data: { notifications_enabled: true } }],
      // auto_email/auto_sms both false -- neither channel ever applies, so
      // alreadyDelivered() is never called for either -- zero messages_sent.
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
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk(), finalizeOk()],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: false } }],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 1, entitlementSkipped: 0 });
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });

  test("client lookup failure is skipped exactly as before (not counted as an entitlement skip), and the claim is released", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk(), { error: null }], // release
      clients: [{ error: { message: "not found" } }],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 0, entitlementSkipped: 0 });
    const release = currentFake.calls.find((c) => c.table === "appointments" && c.method === "eq" && c.args[0] === "reminder_24h_claim_token");
    assert.ok(release, "the release write is scoped by the exact claim token this worker held");
  });

  test("a provider failure on one channel is isolated -- the other channel still attempts; under the SFT claim protocol a partial failure is no longer marked sent (see the dedicated per-channel-independence describe block for the full behavior)", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk()], // no finalize -- partial failure never finalizes
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    currentNotify.setSendEmailImpl(async () => {
      throw new Error("simulated Resend outage");
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 0, entitlementSkipped: 0 });
    assert.equal(currentNotify.emailCalls.length, 1, "email was still attempted");
    assert.equal(currentNotify.smsCalls.length, 1, "sms still attempted despite the email failure");
    assert.equal(currentFake.calls.filter((c) => c.table === "messages_sent" && c.method === "insert").length, 2, "both attempts (success and failure) are still audited");
  });

  test("reminder email uses the workspace's company name as the From display name and sign-off", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk(), finalizeOk()],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true, company_name: "Sunshine Cleaning Co." } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls[0].fromDisplayName, "Sunshine Cleaning Co.");
    assert.ok(currentNotify.emailCalls[0].text.includes("Sunshine Cleaning Co."));
    assert.ok(!currentNotify.emailCalls[0].text.includes("ScheduleFlowTrack"));
  });

  test("reminder SMS body identifies the business by name", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk(), finalizeOk()],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true, company_name: "Sunshine Cleaning Co." } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    const body = currentNotify.smsCalls[0].body;
    assert.ok(body.startsWith("Sunshine Cleaning Co.:"));
    assert.equal(body.split("Sunshine Cleaning Co.").length - 1, 1, "the business name must appear exactly once -- no duplicate trailing sign-off");
    assert.ok(!body.includes("Thank you,"), "the trailing sign-off line was removed for SMS specifically (kept for email)");
  });

  test("a workspace with no company name set falls back to ScheduleFlowTrack rather than breaking the reminder", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk(), finalizeOk()],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }], // no company_name field at all
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls[0].fromDisplayName, "ScheduleFlowTrack");
    const smsBody = currentNotify.smsCalls[0].body;
    assert.ok(smsBody.startsWith("ScheduleFlowTrack:"));
    assert.equal(smsBody.split("ScheduleFlowTrack").length - 1, 1, "the fallback name must also appear exactly once, not duplicated");
  });

  test("two different workspaces in the same run each get their own company name -- never the other's", async () => {
    resetFixtures({
      subscriptions: [
        { data: subscriptionRow({ stripe_status: "active" }) },
        { data: subscriptionRow({ stripe_status: "active" }) },
      ],
      appointments: [
        { data: [apptCandidate({ id: "appt-x", workspace_id: "workspace-x" }), apptCandidate({ id: "appt-y", workspace_id: "workspace-y" })] },
        claimOk("appt-x"), revalidateOk({ reminder_24h_claim_token: "test-claim-token-1" }), finalizeOk("appt-x"),
        claimOk("appt-y"), revalidateOk({ reminder_24h_claim_token: "test-claim-token-2" }), finalizeOk("appt-y"),
      ],
      clients: [{ data: optedInClient() }, { data: optedInClient() }],
      company_settings: [
        { data: { notifications_enabled: true, company_name: "Workspace X Cleaning" } },
        { data: { notifications_enabled: true, company_name: "Workspace Y Cleaning" } },
      ],
      messages_sent: [
        notDelivered(), messageRecorded, notDelivered(), messageRecorded,
        notDelivered(), messageRecorded, notDelivered(), messageRecorded,
      ],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls.length, 2);
    const names = currentNotify.emailCalls.map((c) => c.fromDisplayName).sort();
    assert.deepEqual(names, ["Workspace X Cleaning", "Workspace Y Cleaning"]);
  });

  test("no write occurs beyond the pre-existing set (claim + finalize on appointments, 2 messages_sent inserts) for an allowed, fully-opted-in workspace", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk(), finalizeOk()],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    await GET(req());
    const writes = writeCalls(currentFake.calls);
    assert.deepEqual(
      writes.map((w) => w.table).sort(),
      ["appointments", "appointments", "messages_sent", "messages_sent"].sort()
    );
  });
});

describe("Phase 5E: reminder content uses each appointment's own workspace timezone, never a hardcoded America/New_York or the server's own ambient timezone", () => {
  test("a workspace with a saved non-default timezone (Pacific) formats the reminder's date/time in Pacific, not Eastern", async () => {
    const iso = withinWindowIso();
    const pacific = localHour(iso, "America/Los_Angeles");
    const eastern = localHour(iso, "America/New_York");
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: [apptCandidate({ scheduled_for: iso })] },
        claimOk(), revalidateOk({ scheduled_for: iso }), finalizeOk(),
      ],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true, timezone: "America/Los_Angeles" } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.ok(currentNotify.emailCalls[0].text.includes(pacific), currentNotify.emailCalls[0].text);
    assert.ok(!currentNotify.emailCalls[0].text.includes(eastern));
    assert.ok(currentNotify.smsCalls[0].body.includes(pacific), currentNotify.smsCalls[0].body);
  });

  test("Workspace A (New York) and Workspace B (Los Angeles) in the SAME run each format the identical UTC instant in their OWN saved timezone", async () => {
    const iso = withinWindowIso();
    const eastern = localHour(iso, "America/New_York");
    const pacific = localHour(iso, "America/Los_Angeles");
    resetFixtures({
      subscriptions: [
        { data: subscriptionRow({ stripe_status: "active" }) }, // WORKSPACE_A
        { data: subscriptionRow({ stripe_status: "active" }) }, // WORKSPACE_B
      ],
      appointments: [
        {
          data: [
            // Same UTC instant for both -- different local hour per workspace timezone.
            apptCandidate({ id: "appt-a", workspace_id: WORKSPACE_A, client_id: "client-a", scheduled_for: iso }),
            apptCandidate({ id: "appt-b", workspace_id: WORKSPACE_B, client_id: "client-b", scheduled_for: iso }),
          ],
        },
        claimOk("appt-a"), revalidateOk({ scheduled_for: iso, reminder_24h_claim_token: "test-claim-token-1" }), finalizeOk("appt-a"),
        claimOk("appt-b"), revalidateOk({ scheduled_for: iso, reminder_24h_claim_token: "test-claim-token-2" }), finalizeOk("appt-b"),
      ],
      clients: [{ data: optedInClient() }, { data: optedInClient() }],
      company_settings: [
        { data: { notifications_enabled: true, timezone: "America/New_York" } }, // WORKSPACE_A
        { data: { notifications_enabled: true, timezone: "America/Los_Angeles" } }, // WORKSPACE_B
      ],
      messages_sent: [
        notDelivered(), messageRecorded, notDelivered(), messageRecorded,
        notDelivered(), messageRecorded, notDelivered(), messageRecorded,
      ],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.equal(currentNotify.emailCalls.length, 2);

    const workspaceAEmail = currentNotify.emailCalls.find((c) => c.workspaceId === WORKSPACE_A)!;
    const workspaceBEmail = currentNotify.emailCalls.find((c) => c.workspaceId === WORKSPACE_B)!;
    assert.ok(workspaceAEmail.text.includes(eastern), workspaceAEmail.text);
    assert.ok(workspaceBEmail.text.includes(pacific), workspaceBEmail.text);
  });

  test("NULL/missing timezone on the company_settings row falls back to America/New_York, matching effectiveTimezone(null)", async () => {
    const iso = withinWindowIso();
    const eastern = localHour(iso, "America/New_York");
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: [apptCandidate({ scheduled_for: iso })] },
        claimOk(), revalidateOk({ scheduled_for: iso }), finalizeOk(),
      ],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true, timezone: null } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.ok(currentNotify.emailCalls[0].text.includes(eastern));
  });

  test("the timezone cache is extended, not a second per-appointment query -- exactly one company_settings read for two appointments in the same workspace", async () => {
    const iso1 = withinWindowIso(23.5);
    const iso2 = withinWindowIso(24.5);
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        {
          data: [
            apptCandidate({ id: "appt-1", workspace_id: WORKSPACE_A, client_id: "client-1", scheduled_for: iso1 }),
            apptCandidate({ id: "appt-2", workspace_id: WORKSPACE_A, client_id: "client-2", scheduled_for: iso2 }),
          ],
        },
        claimOk("appt-1"), revalidateOk({ scheduled_for: iso1, reminder_24h_claim_token: "test-claim-token-1" }), finalizeOk("appt-1"),
        claimOk("appt-2"), revalidateOk({ scheduled_for: iso2, reminder_24h_claim_token: "test-claim-token-2" }), finalizeOk("appt-2"),
      ],
      clients: [{ data: optedInClient() }, { data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true, timezone: "America/Los_Angeles" } }],
      messages_sent: [
        notDelivered(), messageRecorded, notDelivered(), messageRecorded,
        notDelivered(), messageRecorded, notDelivered(), messageRecorded,
      ],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.equal(currentFake.calls.filter((c) => c.table === "company_settings" && c.method === "maybeSingle").length, 1);
    assert.equal(currentNotify.emailCalls.length, 2);
    assert.ok(currentNotify.emailCalls.some((c) => c.text.includes(localHour(iso1, "America/Los_Angeles"))));
    assert.ok(currentNotify.emailCalls.some((c) => c.text.includes(localHour(iso2, "America/Los_Angeles"))));
  });

  test("the 23-25-hour query window itself is unaffected by workspace timezone -- proven by source (no per-workspace zone feeds the discovery query)", () => {
    const routeSource = fs.readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");
    assert.ok(!routeSource.includes('DateTime.now().setZone("America/New_York")'), "the misleading hardcoded zone on the window calculation must be gone");
    assert.ok(routeSource.includes("const now = DateTime.now();"));
    assert.ok(routeSource.includes("now.plus({ hours: 23 })"));
    assert.ok(routeSource.includes("now.plus({ hours: 25 })"));
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

  test("scheduler Bearer authentication remains the very first check, before the entitlement gate", () => {
    const authIndex = routeSource.indexOf("isAuthorizedCronRequest(authHeader, process.env.CRON_SECRET)");
    const gateIndex = routeSource.indexOf("workspaceEntitled(a.workspace_id)");
    assert.ok(authIndex > -1 && gateIndex > -1 && authIndex < gateIndex);
  });

  test("authentication reads the Authorization header, not a query-string secret", () => {
    assert.ok(routeSource.includes('req.headers.get("authorization")'));
    assert.ok(!routeSource.includes('searchParams.get("secret")'));
  });

  test("demo suppression via is_demo = false on the discovery query is unchanged", () => {
    assert.ok(routeSource.includes('.eq("is_demo", false)'));
  });
});

describe("SFT reminder claim protocol -- the atomic claim and its WHERE clause (application-level; the true row-level atomicity guarantee is proven against real PostgreSQL in test-db/reminder_claims.test.ts)", () => {
  test("a claim attempt that returns zero rows (another execution already holds it, or the row is no longer eligible) is skipped before any client read, revalidation, or provider call", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimFail()],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 0, entitlementSkipped: 0 });
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" || c.table === "messages_sent"), []);
    assert.equal(currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update").length, 1, "only the one failed claim attempt, no revalidate/release/finalize");
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });

  test("the claim UPDATE's WHERE includes the staleness OR-branch (claimed_at IS NULL OR older than the lease), proving an abandoned claim is reclaimable without any explicit unclaim step", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk(), finalizeOk()],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    await GET(req());
    const orCall = currentFake.calls.find((c) => c.table === "appointments" && c.method === "or");
    assert.ok(orCall, "the claim issues an .or() filter");
    assert.match(String(orCall!.args[0]), /reminder_24h_claimed_at\.is\.null,reminder_24h_claimed_at\.lt\./);
  });

  test("cron skips an appointment cancelled between claiming and delivery, and releases the claim (ownership-checked)", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: [apptCandidate()] },
        claimOk(), // claim succeeds -- still "scheduled" at claim time
        revalidateOk({ status: "cancelled" }), // the owner cancelled it a moment later
        { error: null }, // release
      ],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 0, entitlementSkipped: 0 });
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" || c.table === "messages_sent"), []);
    const release = currentFake.calls.find((c) => c.table === "appointments" && c.method === "eq" && c.args[0] === "reminder_24h_claim_token");
    assert.ok(release, "the release is scoped by this worker's own claim token");
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });

  test("cron skips an appointment rescheduled out of the window between claiming and delivery, and releases the claim", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: [apptCandidate()] },
        claimOk(),
        // The owner moved it to next month a moment after the claim.
        revalidateOk({ scheduled_for: withinWindowIso(24 * 30) }),
        { error: null }, // release
      ],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 0, entitlementSkipped: 0 });
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" || c.table === "messages_sent"), []);
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });

  test("cron releases the claim if the row was already fully sent by the time of revalidation (defensive -- the claim's own WHERE should already have excluded this)", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: [apptCandidate()] },
        claimOk(),
        revalidateOk({ reminder_24h_sent_at: "2026-08-02T12:00:00.000Z" }),
        { error: null }, // release
      ],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 0, entitlementSkipped: 0 });
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "clients" || c.table === "messages_sent"), []);
  });

  test("cron releases the claim if, impossibly, the revalidated row's own claim_token no longer matches what was just claimed (defense in depth)", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: [apptCandidate()] },
        claimOk(),
        revalidateOk({ reminder_24h_claim_token: "someone-elses-token" }),
        { error: null }, // release
      ],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 0, entitlementSkipped: 0 });
  });

  test("a normal, still-eligible appointment is sent exactly as before, and finalized with this worker's own claim token", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk(), finalizeOk()],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 1, entitlementSkipped: 0 });
    assert.equal(currentNotify.emailCalls.length, 1);
    assert.equal(currentNotify.smsCalls.length, 1);
    const finalizeCall = currentFake.calls.find(
      (c) => c.table === "appointments" && c.method === "eq" && c.args[0] === "reminder_24h_claim_token" && c.args[1] === "test-claim-token-1"
    );
    assert.ok(finalizeCall, "the finalize write is scoped by this exact worker's own claim token");
  });

  test("a deleted/missing appointment (revalidation finds no row) is skipped, not thrown, and the claim is released", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: [apptCandidate()] },
        claimOk(),
        revalidateFail(), // maybeSingle() found nothing
        { error: null }, // release
      ],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 0, entitlementSkipped: 0 });
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
  });

  test("the reminder content itself comes from the fresh (revalidated) row, not the stale discovery snapshot -- a service_type changed after discovery is reflected correctly", async () => {
    const iso = withinWindowIso();
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: [apptCandidate({ service_type: "STALE Haircut", scheduled_for: iso })] },
        claimOk(), revalidateOk({ service_type: "Fresh Haircut", scheduled_for: iso }), finalizeOk(),
      ],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.ok(currentNotify.emailCalls[0].text.includes("Fresh Haircut"), currentNotify.emailCalls[0].text);
    assert.ok(!currentNotify.emailCalls[0].text.includes("STALE Haircut"));
  });
});

describe("SFT reminder claim protocol -- per-channel independence (email/SMS never double-sent or incorrectly resent)", () => {
  test("email succeeds, SMS fails: finalize is NOT reached -- reminder_24h_sent_at stays unset so SMS can be retried on a later run, without ever resending the already-successful email", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk()], // no finalize fixture -- must never be reached
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    currentNotify.setSendSmsImpl(async () => {
      throw new Error("simulated Twilio outage");
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 0, entitlementSkipped: 0 });
    assert.equal(currentNotify.emailCalls.length, 1, "email was attempted and succeeded");
    assert.equal(currentNotify.smsCalls.length, 1, "sms was attempted and failed");
    assert.equal(currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update").length, 1, "only the claim write -- finalize never ran");
  });

  test("SMS succeeds, email fails: finalize is NOT reached -- email can be retried on a later run without resending the already-successful SMS", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk()],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    currentNotify.setSendEmailImpl(async () => {
      throw new Error("simulated Resend outage");
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 0, entitlementSkipped: 0 });
    assert.equal(currentNotify.emailCalls.length, 1);
    assert.equal(currentNotify.smsCalls.length, 1);
  });

  test("complete delivery failure (both channels fail): zero finalize, appointment remains fully retryable", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk()],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    currentNotify.setSendEmailImpl(async () => {
      throw new Error("simulated Resend outage");
    });
    currentNotify.setSendSmsImpl(async () => {
      throw new Error("simulated Twilio outage");
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 0, entitlementSkipped: 0 });
    assert.equal(currentFake.calls.filter((c) => c.table === "appointments" && c.method === "update").length, 1, "only the claim -- no finalize");
    assert.equal(currentFake.calls.filter((c) => c.table === "messages_sent" && c.method === "insert").length, 2, "both failures are still audited");
  });

  test("a channel already delivered (messages_sent shows a prior success) is never re-sent, even though it is still 'applicable' per the client's opt-in", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk(), finalizeOk()],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      // email already delivered on an earlier attempt -- skip straight to
      // "done" for it; sms still needs a real attempt.
      messages_sent: [delivered(), notDelivered(), messageRecorded],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 1, entitlementSkipped: 0 });
    assert.equal(currentNotify.emailCalls.length, 0, "email was already delivered -- never resent");
    assert.equal(currentNotify.smsCalls.length, 1, "sms still needed a real attempt");
  });

  test("both channels already delivered (e.g. a prior attempt by a now-expired claim succeeded on both): finalize runs with zero new provider calls", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk(), finalizeOk()],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [delivered(), delivered()],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 1, entitlementSkipped: 0 });
    assert.equal(currentNotify.emailCalls.length, 0);
    assert.equal(currentNotify.smsCalls.length, 0);
    assert.equal(currentFake.calls.filter((c) => c.table === "messages_sent" && c.method === "insert").length, 0, "nothing new to audit -- both were already recorded");
  });

  test("alreadyDelivered() excludes the 'failed' sentinel specifically -- .neq('provider_id','failed') is the exact filter used", () => {
    const routeSource = fs.readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");
    assert.ok(routeSource.includes('.neq("provider_id", "failed")'));
  });
});

describe("SFT reminder claim protocol -- finalize ownership (a stale/expired worker can never finalize a claim it no longer owns)", () => {
  test("finalize is scoped by .eq('reminder_24h_claim_token', <this worker's own token>) -- proven by source and by the exact call args", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk(), finalizeOk()],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    await GET(req());
    const routeSource = fs.readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");
    assert.ok(routeSource.includes('.eq("reminder_24h_claim_token", claimToken)'));
  });

  test("if this worker's own lease already expired and was reclaimed by a newer attempt, the finalize write affects zero rows -- the route logs it, does not throw, and still counts the send (the delivery itself already happened and is durably audited in messages_sent regardless)", async () => {
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk(), finalizeOwnershipLost()],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 1, entitlementSkipped: 0 });
    assert.equal(currentNotify.emailCalls.length, 1, "delivery still happened");
    assert.equal(currentNotify.smsCalls.length, 1);
  });

  test("release is scoped by the exact same .eq('reminder_24h_claim_token', <this worker's own token>) guard -- proven by source", () => {
    const routeSource = fs.readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");
    assert.ok(routeSource.includes('.eq("reminder_24h_claim_token", claimToken)'));
    assert.match(routeSource, /releaseClaim[\s\S]*?\.eq\("reminder_24h_claim_token", claimToken\)/);
  });
});

describe("SFT reminder claim protocol -- Resend idempotency key (closes the crash-between-provider-call-and-write gap for email; Twilio has no equivalent)", () => {
  test("sendEmail is called with a deterministic idempotencyKey derived from the appointment id, the exact scheduled occurrence, and channel (migrations/037)", async () => {
    const iso = withinWindowIso();
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate({ scheduled_for: iso })] }, claimOk(), revalidateOk({ scheduled_for: iso }), finalizeOk()],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    await GET(req());
    assert.equal(currentNotify.emailCalls[0].idempotencyKey, `reminder_24h:appt-1:${iso}:email`);
  });

  test("the same appointment id AND the same scheduled occurrence always produce the same idempotency key, so a genuine retry of the same logical send is deduplicated by Resend itself", async () => {
    const iso = withinWindowIso();
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate({ id: "appt-fixed", scheduled_for: iso })] }, claimOk("appt-fixed"), revalidateOk({ scheduled_for: iso }), finalizeOk("appt-fixed")],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    await GET(req());
    assert.equal(currentNotify.emailCalls[0].idempotencyKey, `reminder_24h:appt-fixed:${iso}:email`);
  });

  test("a reschedule changes the idempotency key -- a different scheduled occurrence for the SAME appointment id produces a DIFFERENT key, so it can never collide with (or be silently deduped against) the prior occurrence's key within Resend's 24h idempotency window", async () => {
    const before = withinWindowIso(23.2);
    const after = withinWindowIso(24.8);
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: [apptCandidate({ id: "appt-r", scheduled_for: before })] },
        claimOk("appt-r"), revalidateOk({ scheduled_for: before, reminder_24h_claim_token: "test-claim-token-1" }), finalizeOk("appt-r"),
      ],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    await GET(req());
    const firstKey = currentNotify.emailCalls[0].idempotencyKey;

    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: [apptCandidate({ id: "appt-r", scheduled_for: after })] },
        claimOk("appt-r"), revalidateOk({ scheduled_for: after }), finalizeOk("appt-r"),
      ],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    await GET(req());
    const secondKey = currentNotify.emailCalls[0].idempotencyKey;

    assert.notEqual(firstKey, secondKey);
    assert.equal(firstKey, `reminder_24h:appt-r:${before}:email`);
    assert.equal(secondKey, `reminder_24h:appt-r:${after}:email`);
  });

  test("sendSms receives no equivalent idempotency parameter -- Twilio's Messages API has none (documented limitation, not an oversight)", () => {
    const routeSource = fs.readFileSync(fileURLToPath(new URL("./route.ts", import.meta.url)), "utf8");
    const smsCallIndex = routeSource.indexOf("await sendSms(phone, t.sms, a.workspace_id)");
    assert.ok(smsCallIndex > -1);
    assert.ok(!routeSource.slice(smsCallIndex, smsCallIndex + 60).includes("idempotencyKey"));
  });
});

describe("SFT reminder occurrence-scoped dedup (migrations/037 -- fixes the rescheduled-appointment defect found in final pre-deployment verification)", () => {
  test("alreadyDelivered() is scoped by the exact CURRENT (revalidated/fresh) scheduled_for, never the stale discovery-query snapshot", async () => {
    const staleIso = withinWindowIso(23.2);
    const freshIso = withinWindowIso(24.8);
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [
        { data: [apptCandidate({ scheduled_for: staleIso })] },
        claimOk(), revalidateOk({ scheduled_for: freshIso }), finalizeOk(),
      ],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    await GET(req());
    const scheduledForFilters = currentFake.calls.filter(
      (c) => c.table === "messages_sent" && c.method === "eq" && c.args[0] === "scheduled_for"
    );
    assert.equal(scheduledForFilters.length, 2, "one alreadyDelivered() check per channel");
    for (const f of scheduledForFilters) {
      assert.equal(f.args[1], freshIso, "the dedup check must use the fresh/current scheduled_for, never the stale discovery snapshot");
    }
  });

  test("a rescheduled appointment (previously fully reminded, reset by migrations/035/036, picked up again by the cron for its new date) genuinely attempts delivery for the new occurrence -- it is never silently treated as already handled", async () => {
    const newOccurrence = withinWindowIso();
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk({ scheduled_for: newOccurrence }), finalizeOk()],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      // Modeling exactly what a real database returns for this scenario
      // (proven against actual PostgreSQL in
      // test-db/reminder_occurrence_dedup.test.ts): a messages_sent row for
      // the OLD occurrence exists, but it never matches the NEW
      // scheduled_for, so alreadyDelivered() correctly resolves false here.
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 1, entitlementSkipped: 0 });
    assert.equal(currentNotify.emailCalls.length, 1, "a genuine new send was attempted for the new occurrence");
    assert.equal(currentNotify.smsCalls.length, 1);
    const scheduledForFilters = currentFake.calls.filter(
      (c) => c.table === "messages_sent" && c.method === "eq" && c.args[0] === "scheduled_for"
    );
    assert.ok(scheduledForFilters.every((f) => f.args[1] === newOccurrence), "the dedup check is scoped to the new occurrence");
  });

  test("recordMessageSent persists the occurrence snapshot alongside every write (success and failure alike), on both channels", async () => {
    const iso = withinWindowIso();
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate()] }, claimOk(), revalidateOk({ scheduled_for: iso })],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      messages_sent: [notDelivered(), messageRecorded, notDelivered(), messageRecorded],
    });
    currentNotify.setSendEmailImpl(async () => {
      throw new Error("simulated Resend outage");
    });
    await GET(req());
    const inserts = currentFake.calls.filter((c) => c.table === "messages_sent" && c.method === "insert");
    assert.equal(inserts.length, 2, "one audit row per channel attempt (email failed, sms succeeded)");
    for (const ins of inserts) {
      assert.equal((ins.args[0] as { scheduled_for?: string }).scheduled_for, iso);
    }
  });

  // "SFT -- Final Reminder Release Preparation": move-away-and-back
  // investigation (appointment reminded for Oct 20, rescheduled to Oct 21,
  // then rescheduled BACK to Oct 20). Proven at the real-PostgreSQL level in
  // test-db/reminder_occurrence_dedup.test.ts that the two resets in between
  // correctly re-arm eligibility, and that alreadyDelivered() still
  // correctly recognizes the ORIGINAL success once scheduled_for is restored
  // to its original value. This test proves the SAME scenario's outcome at
  // the route level: once the cron claims and revalidates this row, it must
  // never re-send a channel that already succeeded for this exact
  // (restored) occurrence -- not a defect, by design: the client already
  // received one accurate reminder for the appointment's final time, and a
  // second identical one would be a pure duplicate, not new information.
  test("move-away-and-back: once scheduled_for is restored to the ORIGINAL value, a prior success for that exact occurrence is correctly recognized -- finalize runs with zero new sends, never a duplicate client-facing reminder", async () => {
    const original = withinWindowIso();
    resetFixtures({
      subscriptions: [{ data: subscriptionRow({ stripe_status: "active" }) }],
      appointments: [{ data: [apptCandidate({ scheduled_for: original })] }, claimOk(), revalidateOk({ scheduled_for: original }), finalizeOk()],
      clients: [{ data: optedInClient() }],
      company_settings: [{ data: { notifications_enabled: true } }],
      // Models exactly what test-db/reminder_occurrence_dedup.test.ts proves
      // against real PostgreSQL for this scenario: the original success rows
      // (scheduled_for = original, from BEFORE the away-and-back reschedule)
      // still match, because the restored scheduled_for is byte-identical.
      messages_sent: [delivered(), delivered()],
    });
    const res = await GET(req());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, checked: 1, sent: 1, entitlementSkipped: 0 });
    assert.equal(currentNotify.emailCalls.length, 0, "no duplicate email -- the client already received this exact reminder");
    assert.equal(currentNotify.smsCalls.length, 0, "no duplicate sms, for the same reason");
    assert.equal(currentFake.calls.filter((c) => c.table === "messages_sent" && c.method === "insert").length, 0, "nothing new to audit");
  });
});
