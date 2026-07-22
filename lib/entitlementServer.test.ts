// Phase 5.4D: focused automated tests for the capability-aware server
// enforcement foundation in lib/entitlementServer.ts. Dummy Supabase env
// vars are set before the module under test is imported (via dynamic
// import, since static imports are hoisted ahead of any top-level
// assignment) so importing lib/supabaseAdmin.ts transitively doesn't
// throw. No real Supabase/Stripe call is ever made by these tests: every
// non-demo case uses an injected fake fetchEntitlement function, and the
// one case that exercises the true default (the demo workspace) never
// reaches Supabase at all, by design (Phase 5.4B's short-circuit).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { requireCapability, requireCapabilityForWorkspace } = await import("./entitlementServer.ts");
const { resolveEntitlement, resolveWorkspaceEntitlement, noDataResult } = await import("./entitlement.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("./workspace.ts");
import type { EntitlementResult, SubscriptionRecord } from "./entitlement.ts";
import type { Session } from "./session.ts";
import type { EntitlementCapability } from "./entitlementServer.ts";

const NOW = new Date("2026-07-21T12:00:00.000Z");

const ALL_CAPABILITIES: EntitlementCapability[] = [
  "canManageBilling",
  "canViewExistingData",
  "canExportData",
  "canMutateOperationalData",
  "canUseJobTracking",
  "canUsePublicBooking",
  "canSendNotifications",
];
const OPERATIONAL_CAPABILITIES: EntitlementCapability[] = [
  "canMutateOperationalData",
  "canUseJobTracking",
  "canUsePublicBooking",
  "canSendNotifications",
];
const ALWAYS_RETAINED_CAPABILITIES: EntitlementCapability[] = ["canManageBilling", "canViewExistingData", "canExportData"];

function stripeRecord(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    billingMode: "stripe",
    stripeStatus: "active",
    trialEnd: null,
    currentPeriodEnd: null,
    graceUntil: null,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

function ownerSession(workspaceId: string): Session {
  return { role: "owner", workspaceId };
}
function employeeSession(workspaceId: string): Session {
  return { role: "employee", employeeId: "emp_1", workspaceId };
}
function testerSession(workspaceId: string): Session {
  return { role: "tester", workspaceId };
}

// A fake fetchEntitlement that always returns the same result, regardless
// of workspaceId -- used when the test wants full control over the
// EntitlementResult without depending on how it was produced.
function fixedFetcher(result: EntitlementResult) {
  const calls: string[] = [];
  const fetcher = async (workspaceId: string) => {
    calls.push(workspaceId);
    return result;
  };
  return { fetcher, calls };
}

async function readResponseJson(response: { json: () => Promise<unknown> }) {
  return response.json();
}

// --- Full-state fixtures, built exclusively via the real, already-tested
// resolveEntitlement/resolveWorkspaceEntitlement/noDataResult -- this file
// never hand-constructs an EntitlementResult, so any test that passes
// proves requireCapability/requireCapabilityForWorkspace defer entirely to
// the canonical resolver rather than reinterpreting subscription state.
const FULL_FIXTURES: Array<[string, EntitlementResult]> = [
  ["internal", resolveEntitlement({ ...stripeRecord(), billingMode: "internal", stripeStatus: null }, NOW)],
  ["trialing", resolveEntitlement(stripeRecord({ stripeStatus: "trialing" }), NOW)],
  ["active", resolveEntitlement(stripeRecord({ stripeStatus: "active" }), NOW)],
  [
    "past_due_grace",
    resolveEntitlement(stripeRecord({ stripeStatus: "past_due", graceUntil: new Date(NOW.getTime() + 1000) }), NOW),
  ],
];

const RESTRICTED_FIXTURES: Array<[string, EntitlementResult]> = [
  [
    "past_due_expired",
    resolveEntitlement(stripeRecord({ stripeStatus: "past_due", graceUntil: new Date(NOW.getTime() - 1000) }), NOW),
  ],
  ["unpaid", resolveEntitlement(stripeRecord({ stripeStatus: "unpaid" }), NOW)],
  ["incomplete", resolveEntitlement(stripeRecord({ stripeStatus: "incomplete" }), NOW)],
  ["incomplete_expired", resolveEntitlement(stripeRecord({ stripeStatus: "incomplete_expired" }), NOW)],
  ["canceled", resolveEntitlement(stripeRecord({ stripeStatus: "canceled" }), NOW)],
  ["paused", resolveEntitlement(stripeRecord({ stripeStatus: "paused" }), NOW)],
  ["no_subscription", resolveEntitlement(null, NOW)],
  ["malformed", resolveEntitlement(stripeRecord({ stripeStatus: "some_unrecognized_status" }), NOW)],
  ["query_error", noDataResult("query_error")],
];

describe("every canonical capability is requestable through the typed helper", () => {
  for (const capability of ALL_CAPABILITIES) {
    test(`${capability}: full result -> allowed`, async () => {
      const { fetcher } = fixedFetcher(resolveEntitlement(stripeRecord({ stripeStatus: "active" }), NOW));
      const check = await requireCapability(ownerSession(REAL_WORKSPACE_ID), capability, fetcher);
      assert.equal(check.allowed, true);
    });

    test(`${capability}: restricted result -> allowed only if it's a retained capability`, async () => {
      const { fetcher } = fixedFetcher(resolveEntitlement(stripeRecord({ stripeStatus: "canceled" }), NOW));
      const check = await requireCapability(ownerSession(REAL_WORKSPACE_ID), capability, fetcher);
      const shouldBeAllowed = (ALWAYS_RETAINED_CAPABILITIES as string[]).includes(capability);
      assert.equal(check.allowed, shouldBeAllowed);
    });
  }
});

describe("full operational states permit operational capabilities", () => {
  for (const [label, result] of FULL_FIXTURES) {
    for (const capability of OPERATIONAL_CAPABILITIES) {
      test(`${label} -> ${capability} allowed`, async () => {
        const { fetcher } = fixedFetcher(result);
        const check = await requireCapability(ownerSession(REAL_WORKSPACE_ID), capability, fetcher);
        assert.equal(check.allowed, true, `${label}/${capability}`);
      });
    }
  }
});

describe("restricted states deny operational capabilities but retain billing/view/export", () => {
  for (const [label, result] of RESTRICTED_FIXTURES) {
    for (const capability of OPERATIONAL_CAPABILITIES) {
      test(`${label} -> ${capability} denied`, async () => {
        const { fetcher } = fixedFetcher(result);
        const check = await requireCapability(ownerSession(REAL_WORKSPACE_ID), capability, fetcher);
        assert.equal(check.allowed, false, `${label}/${capability}`);
      });
    }
    for (const capability of ALWAYS_RETAINED_CAPABILITIES) {
      test(`${label} -> ${capability} still allowed`, async () => {
        const { fetcher } = fixedFetcher(result);
        const check = await requireCapability(ownerSession(REAL_WORKSPACE_ID), capability, fetcher);
        assert.equal(check.allowed, true, `${label}/${capability}`);
      });
    }
  }
});

describe("internal workspace resolves without Stripe-status dependence", () => {
  test("internal result grants operational capabilities regardless of any Stripe field", async () => {
    const internalResult = resolveEntitlement({ ...stripeRecord(), billingMode: "internal", stripeStatus: null }, NOW);
    assert.equal(internalResult.stripeStatus, null, "sanity: internal carries no Stripe status");
    const { fetcher } = fixedFetcher(internalResult);
    const check = await requireCapability(ownerSession(REAL_WORKSPACE_ID), "canMutateOperationalData", fetcher);
    assert.equal(check.allowed, true);
  });
});

describe("only the exact trusted demo workspace receives demo capabilities", () => {
  test("owner session with workspaceId = DEMO_WORKSPACE_ID resolves full access via the REAL default fetcher (no Supabase call required)", async () => {
    const check = await requireCapability(ownerSession(DEMO_WORKSPACE_ID), "canMutateOperationalData");
    assert.equal(check.allowed, true);
  });

  test("tester session with workspaceId = DEMO_WORKSPACE_ID resolves full access via the REAL default fetcher", async () => {
    const check = await requireCapability(testerSession(DEMO_WORKSPACE_ID), "canMutateOperationalData");
    assert.equal(check.allowed, true);
  });

  test("a non-demo workspaceId does not receive demo capabilities even with an otherwise-empty subscription", async () => {
    const { fetcher } = fixedFetcher(resolveWorkspaceEntitlement(REAL_WORKSPACE_ID, null, NOW));
    const check = await requireCapability(ownerSession(REAL_WORKSPACE_ID), "canMutateOperationalData", fetcher);
    assert.equal(check.allowed, false, "no_subscription must not be mistaken for demo");
  });
});

describe("tester session with a non-demo workspace fails closed", () => {
  test("denied with the generic role/auth response, not the subscription-restricted one", async () => {
    const check = await requireCapability(testerSession(REAL_WORKSPACE_ID), "canMutateOperationalData");
    assert.equal(check.allowed, false);
    if (!check.allowed) {
      const body = (await readResponseJson(check.response)) as Record<string, unknown>;
      assert.equal(body.code, undefined, "must not carry the SUBSCRIPTION_RESTRICTED code");
      assert.equal(body.error, "Unauthorized");
    }
  });

  test("session.role === 'none' is also denied with the generic response", async () => {
    const check = await requireCapability({ role: "none" }, "canMutateOperationalData");
    assert.equal(check.allowed, false);
    if (!check.allowed) {
      const body = (await readResponseJson(check.response)) as Record<string, unknown>;
      assert.equal(body.error, "Unauthorized");
      assert.equal(body.code, undefined);
    }
  });
});

describe("owner and employee sessions resolve entitlement from their signed session workspace", () => {
  test("owner session: the fetcher is called with exactly session.workspaceId", async () => {
    const workspaceId = "aaaaaaaa-0000-0000-0000-000000000001";
    const { fetcher, calls } = fixedFetcher(resolveEntitlement(stripeRecord({ stripeStatus: "active" }), NOW));
    await requireCapability(ownerSession(workspaceId), "canMutateOperationalData", fetcher);
    assert.deepEqual(calls, [workspaceId]);
  });

  test("employee session: the fetcher is called with exactly session.workspaceId (the employer's workspace)", async () => {
    const workspaceId = "bbbbbbbb-0000-0000-0000-000000000002";
    const { fetcher, calls } = fixedFetcher(resolveEntitlement(stripeRecord({ stripeStatus: "active" }), NOW));
    await requireCapability(employeeSession(workspaceId), "canUseJobTracking", fetcher);
    assert.deepEqual(calls, [workspaceId]);
  });
});

describe("trusted workspace identity cannot be overridden by caller-supplied data", () => {
  test("requireCapability has no workspaceId parameter -- its only inputs are (session, capability, [fetcher])", () => {
    assert.equal(requireCapability.length, 2, "the 3rd param (fetcher) has a default and is excluded from .length");
  });

  test("passing extra/unexpected properties on a session-like object has no effect beyond the trusted workspaceId field", async () => {
    const spoofed = { role: "owner", workspaceId: "trusted-ws", workspaceIdOverride: "attacker-ws", body: { workspaceId: "attacker-ws-2" } } as unknown as Session;
    const { fetcher, calls } = fixedFetcher(resolveEntitlement(stripeRecord({ stripeStatus: "active" }), NOW));
    await requireCapability(spoofed, "canMutateOperationalData", fetcher);
    assert.deepEqual(calls, ["trusted-ws"]);
  });
});

describe("requireCapabilityForWorkspace uses the same canonical resolution path -- no second interpretation", () => {
  for (const [label, result] of [...FULL_FIXTURES, ...RESTRICTED_FIXTURES]) {
    test(`${label}: requireCapability and requireCapabilityForWorkspace agree, given the same EntitlementResult`, async () => {
      const { fetcher: fetcherA } = fixedFetcher(result);
      const { fetcher: fetcherB } = fixedFetcher(result);
      const viaSession = await requireCapability(ownerSession(REAL_WORKSPACE_ID), "canMutateOperationalData", fetcherA);
      const viaWorkspace = await requireCapabilityForWorkspace(REAL_WORKSPACE_ID, "canMutateOperationalData", fetcherB);
      assert.equal(viaSession.allowed, viaWorkspace.allowed, label);
    });
  }

  test("is called with exactly the trusted workspaceId passed in, nothing derived or defaulted", async () => {
    const { fetcher, calls } = fixedFetcher(resolveEntitlement(stripeRecord({ stripeStatus: "active" }), NOW));
    await requireCapabilityForWorkspace("some-server-trusted-id", "canUsePublicBooking", fetcher);
    assert.deepEqual(calls, ["some-server-trusted-id"]);
  });
});

describe("denial response contract", () => {
  test("is exactly HTTP 403 with the approved safe code and message", async () => {
    const { fetcher } = fixedFetcher(resolveEntitlement(stripeRecord({ stripeStatus: "canceled" }), NOW));
    const check = await requireCapability(ownerSession(REAL_WORKSPACE_ID), "canMutateOperationalData", fetcher);
    assert.equal(check.allowed, false);
    if (!check.allowed) {
      assert.equal(check.response.status, 403);
      const body = (await readResponseJson(check.response)) as Record<string, unknown>;
      assert.deepEqual(body, {
        error: "This action isn't available right now — visit Billing to restore full access.",
        code: "SUBSCRIPTION_RESTRICTED",
      });
    }
  });

  test("exposes no reason, state, workspace id, customer id, subscription id, or provider error", async () => {
    const sensitiveResult = resolveEntitlement(
      stripeRecord({
        stripeStatus: "past_due",
        graceUntil: new Date(NOW.getTime() - 1000),
      }),
      NOW
    );
    // Sanity: the fixture itself really does carry a diagnosable reason/state
    // (proving this test would catch a leak if one were introduced).
    assert.equal(sensitiveResult.reason, "past_due_grace_expired");
    assert.equal(sensitiveResult.state, "past_due_expired");

    const secretWorkspaceId = "workspace-should-never-appear-in-body";
    const { fetcher } = fixedFetcher(sensitiveResult);
    const check = await requireCapability(ownerSession(secretWorkspaceId), "canMutateOperationalData", fetcher);
    assert.equal(check.allowed, false);
    if (!check.allowed) {
      const bodyText = JSON.stringify(await readResponseJson(check.response));
      assert.equal(Object.keys(JSON.parse(bodyText)).sort().join(","), "code,error");
      for (const forbidden of ["past_due", "grace", "expired", secretWorkspaceId, "cus_", "sub_", "Supabase", "Stripe"]) {
        assert.ok(!bodyText.includes(forbidden), `denial body must not contain "${forbidden}"`);
      }
    }
  });

  test("an unauthenticated (role: none) caller never receives the subscription-restricted body, only the generic one", async () => {
    const check = await requireCapability({ role: "none" }, "canMutateOperationalData");
    assert.equal(check.allowed, false);
    if (!check.allowed) {
      const body = (await readResponseJson(check.response)) as Record<string, unknown>;
      assert.notEqual(body.code, "SUBSCRIPTION_RESTRICTED");
    }
  });
});

describe("resolver/query failure denies mutations without blocking view/export/billing", () => {
  test("query_error: canMutateOperationalData denied, canViewExistingData/canExportData/canManageBilling allowed", async () => {
    const { fetcher } = fixedFetcher(noDataResult("query_error"));
    const mutate = await requireCapability(ownerSession(REAL_WORKSPACE_ID), "canMutateOperationalData", fetcher);
    const view = await requireCapability(ownerSession(REAL_WORKSPACE_ID), "canViewExistingData", fetcher);
    const billing = await requireCapability(ownerSession(REAL_WORKSPACE_ID), "canManageBilling", fetcher);
    assert.equal(mutate.allowed, false);
    assert.equal(view.allowed, true);
    assert.equal(billing.allowed, true);
  });
});

describe("no database mutation or external provider call is reachable from these helpers", () => {
  test("requireCapability's source contains no write/mutation call patterns", () => {
    const source = requireCapability.toString();
    for (const pattern of [".insert(", ".update(", ".delete(", ".upsert(", "stripe.", "sendEmail", "sendSms"]) {
      assert.ok(!source.includes(pattern), `unexpected "${pattern}" in requireCapability`);
    }
  });

  test("requireCapabilityForWorkspace's source contains no write/mutation call patterns", () => {
    const source = requireCapabilityForWorkspace.toString();
    for (const pattern of [".insert(", ".update(", ".delete(", ".upsert(", "stripe.", "sendEmail", "sendSms"]) {
      assert.ok(!source.includes(pattern), `unexpected "${pattern}" in requireCapabilityForWorkspace`);
    }
  });
});

describe("only the approved routes reference the capability gates -- every other route remains unwired", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, out);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
    return out;
  }

  // requireCapability( and requireCapabilityForWorkspace( are two distinct
  // gates, never interchangeable, so they get two separate inventories
  // rather than one merged "references the new gate" list. Matching on the
  // literal "(" after the name is deliberate: "requireCapabilityForWorkspace("
  // never matches the "requireCapability(" pattern (the character right
  // after "requireCapability" there is "F", not "("), so a file that only
  // calls the workspace-trusted helper is never miscounted as calling the
  // session-based one, and vice versa. Any file outside these sets that
  // starts referencing either helper means enforcement crept into a route
  // nobody reviewed for it yet -- this test exists specifically to catch
  // that, not just to check the routes below were wired correctly (their
  // own route.test.ts files already prove that).

  // Session-based gate: authenticated routes, workspace identity taken
  // exclusively from the caller's own signed session.
  const REQUIRE_CAPABILITY_ROUTES = [
    // Phase 5.4E1 -- simple authenticated operational mutations.
    path.join("app", "api", "clients", "route.ts"),
    path.join("app", "api", "employees", "route.ts"),
    path.join("app", "api", "services", "route.ts"),
    path.join("app", "api", "settings", "company", "route.ts"),
    // Phase 5.4E2 -- authenticated job tracking / manual employee hours.
    path.join("app", "api", "appointments", "job", "route.ts"),
    path.join("app", "api", "appointments", "employee-hours", "route.ts"),
    // Phase 5.4E3 -- authenticated appointment editing/cancellation/recurrence.
    path.join("app", "api", "appointments", "update", "route.ts"),
    path.join("app", "api", "appointments", "delete", "route.ts"),
    path.join("app", "api", "appointments", "manage-recurrence", "route.ts"),
    // Phase 5.4E4 -- the authenticated owner/tester branch of the mixed
    // create route (see REQUIRE_CAPABILITY_FOR_WORKSPACE_ROUTES below for
    // its other, unauthenticated public-booking branch).
    path.join("app", "api", "appointments", "create", "route.ts"),
  ];

  // Server-trusted-workspace gate: no session exists at this call site at
  // all -- the workspace identity is a fixed, server-side constant, or a
  // value already read from the database by the server itself, never a
  // caller-supplied value.
  const REQUIRE_CAPABILITY_FOR_WORKSPACE_ROUTES = [
    // Phase 5.4E4 -- the unauthenticated public-booking branch of the mixed
    // create route.
    path.join("app", "api", "appointments", "create", "route.ts"),
    // Phase 5.4E4 -- public availability lookup, the read-only half of the
    // same public-booking flow.
    path.join("app", "api", "book", "availability", "route.ts"),
    // Phase 5.4E5 -- the scheduled 24h-reminder cron, gated per-workspace
    // using the workspace_id already read off each candidate appointment
    // row. The other cron route (reconcile-subscriptions) sends no client
    // notifications at all -- it only synchronizes Stripe subscription
    // state -- so it remains unwired.
    path.join("app", "api", "cron", "reminders", "route.ts"),
    // Phase 5.4G -- public token-based cancellation. The cancellation
    // mutation itself is deliberately NEVER gated (a valid token must
    // always be able to cancel its exact appointment, regardless of
    // subscription state -- see the Phase 5.4F audit and Phase 5.4G policy
    // decision); only the outbound email/SMS that follows a successful
    // cancellation is gated, using the workspace_id already read off the
    // matched appointment row. This route intentionally does NOT appear in
    // REQUIRE_CAPABILITY_ROUTES above -- it has no session to check.
    path.join("app", "api", "appointments", "cancel", "route.ts"),
  ];

  test("exactly the approved routes call requireCapability(session, ...); every other app/ file does not", () => {
    const projectRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
    const appDir = path.join(projectRoot, "app");
    const referencing: string[] = [];
    for (const file of walk(appDir)) {
      const text = fs.readFileSync(file, "utf8");
      if (text.includes("requireCapability(")) referencing.push(path.relative(projectRoot, file));
    }
    assert.deepEqual(referencing.sort(), [...REQUIRE_CAPABILITY_ROUTES].sort());
  });

  test("exactly the approved routes call requireCapabilityForWorkspace(...); every other app/ file does not", () => {
    const projectRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
    const appDir = path.join(projectRoot, "app");
    const referencing: string[] = [];
    for (const file of walk(appDir)) {
      const text = fs.readFileSync(file, "utf8");
      if (text.includes("requireCapabilityForWorkspace(")) referencing.push(path.relative(projectRoot, file));
    }
    assert.deepEqual(referencing.sort(), [...REQUIRE_CAPABILITY_FOR_WORKSPACE_ROUTES].sort());
  });

  test("subscription-reconciliation cron and Stripe routes remain unwired to either capability gate", () => {
    const projectRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
    const outOfScope = [
      // Sends no client notifications -- only synchronizes Stripe
      // subscription state -- so it has no notification capability to gate.
      path.join("app", "api", "cron", "reconcile-subscriptions", "route.ts"),
      path.join("app", "api", "stripe", "checkout", "route.ts"),
      path.join("app", "api", "stripe", "portal", "route.ts"),
      path.join("app", "api", "stripe", "webhook", "route.ts"),
    ];
    for (const rel of outOfScope) {
      const full = path.join(projectRoot, rel);
      const text = fs.readFileSync(full, "utf8");
      assert.ok(!text.includes("requireCapability("), `${rel} must not call requireCapability(...)`);
      assert.ok(!text.includes("requireCapabilityForWorkspace("), `${rel} must not call requireCapabilityForWorkspace(...)`);
    }
  });
});
