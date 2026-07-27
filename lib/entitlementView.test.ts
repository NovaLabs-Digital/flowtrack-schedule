// Phase 5.5B: focused tests for the browser-safe entitlement projection
// (lib/entitlementView.ts) and source-level proof that the owner/employee
// server components resolve entitlement correctly. This file never mocks
// Supabase/Stripe -- every fixture is built exclusively via the real,
// already-tested resolveEntitlement/resolveWorkspaceEntitlement/
// noDataResult (lib/entitlement.ts), so a passing test proves the
// projection defers entirely to the canonical resolver rather than
// reinterpreting subscription state. No real Supabase/Stripe/Twilio/Resend/
// network call is reachable from this file.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { projectEntitlementForOwner, projectEntitlementForEmployee } = await import("./entitlementView.ts");
const { resolveEntitlement, resolveWorkspaceEntitlement, noDataResult } = await import("./entitlement.ts");
const { DEMO_WORKSPACE_ID, REAL_WORKSPACE_ID } = await import("./workspace.ts");
import type { SubscriptionRecord } from "./entitlement.ts";

const NOW = new Date("2026-07-22T12:00:00.000Z");

function stripeRecord(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    billingMode: "stripe",
    stripeStatus: "active",
    trialEnd: null,
    currentPeriodEnd: null,
    graceUntil: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    accessEndedAt: null,
    // Phase 5.7D-R11: see lib/entitlement.test.ts's identical helper for
    // why these default to "a row with real Stripe activity" -- inert for
    // every fixture here except the dedicated pristineStripeRecord below.
    trialConsumedAt: null,
    hasStripeIdentity: true,
    ...overrides,
  };
}

// Phase 5.7D-R11: the exact shape provision_owner_workspace leaves a
// brand-new workspace's subscriptions row in.
function pristineStripeRecord(): SubscriptionRecord {
  return stripeRecord({ stripeStatus: null, trialConsumedAt: null, hasStripeIdentity: false });
}

describe("projectEntitlementForOwner -- approved state-to-projection mapping", () => {
  test("active: full capabilities, no banner, no recovery action", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "active" }), NOW);
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: true,
      canUseJobTracking: true,
      canSendNotifications: true,
      bannerVariant: "none",
      recoveryAction: null,
      finalAccessDate: null,
      readOnlyEndsAt: null,
    });
  });

  test("trialing: full capabilities, no banner, no recovery action", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "trialing" }), NOW);
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: true,
      canUseJobTracking: true,
      canSendNotifications: true,
      bannerVariant: "none",
      recoveryAction: null,
      finalAccessDate: null,
      readOnlyEndsAt: null,
    });
  });

  test("past_due_grace: capabilities remain fully enabled, grace_warning banner, portal recovery", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "past_due", graceUntil: new Date(NOW.getTime() + 1000) }), NOW);
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: true,
      canUseJobTracking: true,
      canSendNotifications: true,
      bannerVariant: "grace_warning",
      recoveryAction: "portal",
      finalAccessDate: null,
      readOnlyEndsAt: null,
    });
  });

  test("past_due_read_only: restricted capabilities, read_only banner (with the exact read-only end date), portal recovery", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "past_due", graceUntil: new Date(NOW.getTime() - 1000) }), NOW);
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: false,
      canUseJobTracking: false,
      canSendNotifications: false,
      bannerVariant: "read_only",
      recoveryAction: "portal",
      finalAccessDate: null,
      readOnlyEndsAt: result.readOnlyEndsAt,
    });
    assert.ok(result.readOnlyEndsAt);
  });

  test("past_due_locked: locked capabilities, locked banner, portal recovery", () => {
    const result = resolveEntitlement(
      stripeRecord({ stripeStatus: "past_due", graceUntil: new Date(NOW.getTime() - 1000 * 60 * 60 * 24 * 40) }),
      NOW
    );
    assert.equal(result.state, "past_due_locked");
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: false,
      canUseJobTracking: false,
      canSendNotifications: false,
      bannerVariant: "locked",
      recoveryAction: "portal",
      finalAccessDate: null,
      readOnlyEndsAt: null,
    });
  });

  test("unpaid_read_only: restricted capabilities, read_only banner, portal recovery", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "unpaid", accessEndedAt: new Date(NOW.getTime() - 1000) }), NOW);
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: false,
      canUseJobTracking: false,
      canSendNotifications: false,
      bannerVariant: "read_only",
      recoveryAction: "portal",
      finalAccessDate: null,
      readOnlyEndsAt: result.readOnlyEndsAt,
    });
    assert.ok(result.readOnlyEndsAt);
  });

  test("paused_read_only: restricted capabilities, read_only banner, portal recovery", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "paused", accessEndedAt: new Date(NOW.getTime() - 1000) }), NOW);
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: false,
      canUseJobTracking: false,
      canSendNotifications: false,
      bannerVariant: "read_only",
      recoveryAction: "portal",
      finalAccessDate: null,
      readOnlyEndsAt: result.readOnlyEndsAt,
    });
  });

  test("canceled_read_only: restricted capabilities, read_only banner (with the exact read-only end date), checkout recovery", () => {
    const canceledAt = new Date(NOW.getTime() - 1000 * 60 * 60 * 24 * 5);
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "canceled", canceledAt }), NOW);
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: false,
      canUseJobTracking: false,
      canSendNotifications: false,
      bannerVariant: "read_only",
      recoveryAction: "checkout",
      finalAccessDate: null,
      readOnlyEndsAt: result.readOnlyEndsAt,
    });
    assert.ok(result.readOnlyEndsAt);
  });

  test("canceled_locked: restricted capabilities, locked banner, checkout recovery, no dates shown", () => {
    const canceledAt = new Date(NOW.getTime() - 1000 * 60 * 60 * 24 * 40);
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "canceled", canceledAt }), NOW);
    assert.equal(result.state, "canceled_locked");
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: false,
      canUseJobTracking: false,
      canSendNotifications: false,
      bannerVariant: "locked",
      recoveryAction: "checkout",
      finalAccessDate: null,
      readOnlyEndsAt: null,
    });
  });

  test("cancel_scheduled_trial: FULL capabilities (still trialing), cancel_scheduled_trial banner with the exact trial-end date, portal recovery", () => {
    const trialEnd = new Date(NOW.getTime() + 1000 * 60 * 60 * 24 * 10);
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "trialing", trialEnd, cancelAtPeriodEnd: true }), NOW);
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: true,
      canUseJobTracking: true,
      canSendNotifications: true,
      bannerVariant: "cancel_scheduled_trial",
      recoveryAction: "portal",
      finalAccessDate: trialEnd,
      readOnlyEndsAt: null,
    });
  });

  test("cancel_scheduled_paid: FULL capabilities (still active), cancel_scheduled_paid banner with the exact period-end date, portal recovery", () => {
    const currentPeriodEnd = new Date(NOW.getTime() + 1000 * 60 * 60 * 24 * 12);
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "active", currentPeriodEnd, cancelAtPeriodEnd: true }), NOW);
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: true,
      canUseJobTracking: true,
      canSendNotifications: true,
      bannerVariant: "cancel_scheduled_paid",
      recoveryAction: "portal",
      finalAccessDate: currentPeriodEnd,
      readOnlyEndsAt: null,
    });
  });

  test("trialing/active WITHOUT cancelAtPeriodEnd never shows a scheduled-cancellation banner", () => {
    const trialing = resolveEntitlement(stripeRecord({ stripeStatus: "trialing", cancelAtPeriodEnd: false }), NOW);
    const active = resolveEntitlement(stripeRecord({ stripeStatus: "active", cancelAtPeriodEnd: false }), NOW);
    assert.equal(projectEntitlementForOwner(trialing).bannerVariant, "none");
    assert.equal(projectEntitlementForOwner(active).bannerVariant, "none");
  });

  test("no_subscription (genuinely no row): locked capabilities, locked banner, checkout recovery", () => {
    const result = resolveEntitlement(null, NOW);
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: false,
      canUseJobTracking: false,
      canSendNotifications: false,
      bannerVariant: "locked",
      recoveryAction: "checkout",
      finalAccessDate: null,
      readOnlyEndsAt: null,
    });
  });

  test("malformed: restricted capabilities, verification_error banner, support recovery -- never checkout/portal", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "some_unrecognized_status" }), NOW);
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: false,
      canUseJobTracking: false,
      canSendNotifications: false,
      bannerVariant: "verification_error",
      recoveryAction: "support",
      finalAccessDate: null,
      readOnlyEndsAt: null,
    });
  });

  // Phase 5.7D-R11: a real production signup was shown "reactivate your
  // subscription... your data has been preserved" for a workspace that
  // never had a subscription -- see lib/entitlement.test.ts's matching
  // describe block for the resolver-level proof. This proves the
  // projection layer maps the corrected state to the correct, distinct
  // banner/recovery pair, never reusing "locked"/"verification_error".
  test("trial_not_started: no operational capabilities, trial_available banner, checkout recovery -- never locked/verification_error/support", () => {
    const result = resolveEntitlement(pristineStripeRecord(), NOW);
    assert.equal(result.state, "trial_not_started");
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: false,
      canUseJobTracking: false,
      canSendNotifications: false,
      bannerVariant: "trial_available",
      recoveryAction: "checkout",
      finalAccessDate: null,
      readOnlyEndsAt: null,
    });
  });

  test("Phase 5.6F-R1: query_error resolves to its OWN 'service_unavailable' state, banner 'temporarily_unavailable', no recovery action", () => {
    const result = noDataResult("query_error");
    assert.equal(result.state, "service_unavailable", "sanity: query_error is its own state, not shared with no_subscription");
    assert.equal(result.reason, "query_error");
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: false,
      canUseJobTracking: false,
      canSendNotifications: false,
      bannerVariant: "temporarily_unavailable",
      recoveryAction: null,
      finalAccessDate: null,
      readOnlyEndsAt: null,
    });
  });

  test("a genuine no_subscription row gets the 'locked' banner and checkout recovery, never 'temporarily_unavailable'", () => {
    const genuine = resolveEntitlement(null, NOW);
    assert.equal(genuine.state, "no_subscription");
    const view = projectEntitlementForOwner(genuine);
    assert.equal(view.bannerVariant, "locked");
    assert.equal(view.recoveryAction, "checkout");
  });

  test("internal billing: full capabilities, no banner, no recovery action", () => {
    const result = resolveEntitlement({ ...stripeRecord(), billingMode: "internal", stripeStatus: null }, NOW);
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: true,
      canUseJobTracking: true,
      canSendNotifications: true,
      bannerVariant: "none",
      recoveryAction: null,
      finalAccessDate: null,
      readOnlyEndsAt: null,
    });
  });

  test("exact trusted demo workspace: full capabilities via the workspace-aware resolver, no banner, no recovery action", () => {
    const result = resolveWorkspaceEntitlement(DEMO_WORKSPACE_ID, null, NOW);
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: true,
      canUseJobTracking: true,
      canSendNotifications: true,
      bannerVariant: "none",
      recoveryAction: null,
      finalAccessDate: null,
      readOnlyEndsAt: null,
    });
  });

  test("a non-demo workspace with no subscription data does NOT receive the demo projection", () => {
    const result = resolveWorkspaceEntitlement(REAL_WORKSPACE_ID, null, NOW);
    const view = projectEntitlementForOwner(result);
    assert.equal(view.bannerVariant, "locked");
    assert.equal(view.recoveryAction, "checkout");
  });

  // Phase 5.6F: incomplete/incomplete_expired never established valid
  // entitlement -- locked capabilities, verification_error wording (never
  // claims a read-only period that never existed), checkout recovery (the
  // correct next step is a fresh Checkout attempt, not support).
  const NEVER_ESTABLISHED_STATES: Array<[string, SubscriptionRecord]> = [
    ["incomplete", stripeRecord({ stripeStatus: "incomplete" })],
    ["incomplete_expired", stripeRecord({ stripeStatus: "incomplete_expired" })],
  ];
  for (const [label, record] of NEVER_ESTABLISHED_STATES) {
    test(`${label}: locked capabilities, verification_error banner, checkout recovery -- never a guessed read-only period`, () => {
      const result = resolveEntitlement(record, NOW);
      const view = projectEntitlementForOwner(result);
      assert.equal(view.canMutateOperationalData, false, label);
      assert.equal(view.canUseJobTracking, false, label);
      assert.equal(view.canSendNotifications, false, label);
      assert.equal(view.bannerVariant, "verification_error", label);
      assert.equal(view.recoveryAction, "checkout", label);
    });
  }
});

describe("capability booleans are always copied verbatim from the canonical resolved result", () => {
  const STATES: Array<[string, SubscriptionRecord | null]> = [
    ["active", stripeRecord({ stripeStatus: "active" })],
    ["trialing", stripeRecord({ stripeStatus: "trialing" })],
    ["past_due_grace", stripeRecord({ stripeStatus: "past_due", graceUntil: new Date(NOW.getTime() + 1000) })],
    ["past_due_read_only", stripeRecord({ stripeStatus: "past_due", graceUntil: new Date(NOW.getTime() - 1000) })],
    ["unpaid_read_only", stripeRecord({ stripeStatus: "unpaid", accessEndedAt: new Date(NOW.getTime() - 1000) })],
    ["canceled_read_only", stripeRecord({ stripeStatus: "canceled", canceledAt: new Date(NOW.getTime() - 1000) })],
    ["no_subscription", null],
    ["malformed", stripeRecord({ stripeStatus: "not_real" })],
  ];
  for (const [label, record] of STATES) {
    test(`${label}: canMutateOperationalData/canUseJobTracking/canSendNotifications match the resolver exactly`, () => {
      const result = resolveEntitlement(record, NOW);
      const view = projectEntitlementForOwner(result);
      assert.equal(view.canMutateOperationalData, result.canMutateOperationalData, label);
      assert.equal(view.canUseJobTracking, result.canUseJobTracking, label);
      assert.equal(view.canSendNotifications, result.canSendNotifications, label);
    });
  }
});

describe("the owner projection never leaks raw entitlement/billing fields", () => {
  const FIXTURES = [
    resolveEntitlement(stripeRecord({ stripeStatus: "active" }), NOW),
    resolveEntitlement(stripeRecord({ stripeStatus: "canceled", canceledAt: new Date(NOW.getTime() - 1000) }), NOW),
    resolveEntitlement(null, NOW),
    noDataResult("query_error"),
    resolveWorkspaceEntitlement(DEMO_WORKSPACE_ID, null, NOW),
    resolveEntitlement({ ...stripeRecord(), billingMode: "internal", stripeStatus: null }, NOW),
  ];

  test("contains exactly the seven approved keys, nothing else, for every fixture", () => {
    for (const result of FIXTURES) {
      const view = projectEntitlementForOwner(result);
      assert.deepEqual(
        Object.keys(view).sort(),
        [
          "bannerVariant",
          "canMutateOperationalData",
          "canSendNotifications",
          "canUseJobTracking",
          "finalAccessDate",
          "readOnlyEndsAt",
          "recoveryAction",
        ]
      );
    }
  });

  test("no forbidden raw field or value ever appears in the serialized projection", () => {
    const sensitiveResult = resolveEntitlement(
      stripeRecord({ stripeStatus: "past_due", graceUntil: new Date(NOW.getTime() - 1000) }),
      NOW
    );
    // Sanity: the fixture really does carry sensitive, diagnosable detail
    // (proving this test would catch a leak if one were introduced).
    assert.equal(sensitiveResult.reason, "past_due_read_only");
    assert.equal(sensitiveResult.state, "past_due_read_only");
    assert.ok(sensitiveResult.graceEndsAt);

    const serialized = JSON.stringify(projectEntitlementForOwner(sensitiveResult));
    for (const forbidden of [
      "past_due", "grace", "expired", "state", "reason", "billingmode", "billing_mode",
      "stripestatus", "stripe_status", "graceendsat", "trialend", "currentperiodend",
      "cancelatperiodend", "workspace", "customer", "sub_", "cus_",
    ]) {
      assert.ok(!serialized.toLowerCase().includes(forbidden), `projection must not contain "${forbidden}"`);
    }
  });
});

describe("projectEntitlementForEmployee -- employee-only shape", () => {
  const FIXTURES = [
    resolveEntitlement(stripeRecord({ stripeStatus: "active" }), NOW),
    resolveEntitlement(stripeRecord({ stripeStatus: "canceled" }), NOW),
    resolveEntitlement(stripeRecord({ stripeStatus: "past_due", graceUntil: new Date(NOW.getTime() - 1000) }), NOW),
    resolveWorkspaceEntitlement(DEMO_WORKSPACE_ID, null, NOW),
  ];

  test("contains exactly canUseJobTracking, nothing else, for every fixture", () => {
    for (const result of FIXTURES) {
      const view = projectEntitlementForEmployee(result);
      assert.deepEqual(Object.keys(view), ["canUseJobTracking"]);
    }
  });

  test("canUseJobTracking is copied verbatim from the resolved result", () => {
    const full = resolveEntitlement(stripeRecord({ stripeStatus: "active" }), NOW);
    const restricted = resolveEntitlement(stripeRecord({ stripeStatus: "canceled" }), NOW);
    assert.equal(projectEntitlementForEmployee(full).canUseJobTracking, true);
    assert.equal(projectEntitlementForEmployee(restricted).canUseJobTracking, false);
  });

  test("never contains billing/recovery/banner fields, even for a restricted state", () => {
    const restricted = resolveEntitlement(stripeRecord({ stripeStatus: "past_due", graceUntil: new Date(NOW.getTime() - 1000) }), NOW);
    const view = projectEntitlementForEmployee(restricted) as unknown as Record<string, unknown>;
    assert.equal(view.recoveryAction, undefined);
    assert.equal(view.bannerVariant, undefined);
    assert.equal(view.canMutateOperationalData, undefined);
    assert.equal(view.canSendNotifications, undefined);
  });
});

describe("owner/employee page wiring is source-correctly scoped (source-level proof)", () => {
  const projectRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const dashboardSource = fs.readFileSync(path.join(projectRoot, "app", "dashboard", "page.tsx"), "utf8");
  const scheduleSource = fs.readFileSync(path.join(projectRoot, "app", "schedule", "page.tsx"), "utf8");

  test("app/dashboard/page.tsx derives workspaceId only from the verified session, resolves through the canonical resolver, and passes the owner projection to DashboardShell", () => {
    assert.ok(dashboardSource.includes("const workspaceId = session.workspaceId;"));
    assert.ok(dashboardSource.includes("fetchEntitlementForWorkspace(workspaceId)"));
    assert.ok(dashboardSource.includes("projectEntitlementForOwner(entitlementResult)"));
    assert.ok(dashboardSource.includes("entitlement={entitlement}"));
  });

  test("app/schedule/page.tsx derives workspaceId only from the verified session, resolves through the same canonical resolver, and passes the employee-only projection to EmployeeSchedule", () => {
    assert.ok(scheduleSource.includes("const workspaceId = session.workspaceId;"));
    assert.ok(scheduleSource.includes("fetchEntitlementForWorkspace(workspaceId)"));
    assert.ok(scheduleSource.includes("projectEntitlementForEmployee(entitlementResult)"));
    assert.ok(scheduleSource.includes("entitlement={entitlement}"));
  });

  test("Phase 5.6F-R1: app/dashboard/page.tsx checks state === 'service_unavailable' BEFORE the canViewExistingData gate, and renders TemporaryUnavailableScreen there -- never LockedReactivationScreen", () => {
    assert.ok(dashboardSource.includes('import TemporaryUnavailableScreen from "@/app/components/dashboard/TemporaryUnavailableScreen"'));
    const serviceUnavailableCheckIndex = dashboardSource.indexOf('entitlementResult.state === "service_unavailable"');
    const canViewCheckIndex = dashboardSource.indexOf("!entitlementResult.canViewExistingData");
    assert.ok(serviceUnavailableCheckIndex > -1 && canViewCheckIndex > -1);
    assert.ok(serviceUnavailableCheckIndex < canViewCheckIndex, "the service_unavailable branch must be checked first");
    // Phase 5.7D: a second, earlier <TemporaryUnavailableScreen /> render
    // site now exists for the session_epoch re-verification gate (see
    // lib/sessionEpoch.ts) -- searching from serviceUnavailableCheckIndex
    // onward specifically finds the entitlement branch's own render site,
    // not that earlier, structurally distinct one.
    const tempScreenIndex = dashboardSource.indexOf("<TemporaryUnavailableScreen", serviceUnavailableCheckIndex);
    assert.ok(tempScreenIndex > serviceUnavailableCheckIndex && tempScreenIndex < canViewCheckIndex);
  });

  test("Phase 5.6F-R1: no business-data query (clients/appointments/services/employees) appears before the service_unavailable branch in app/dashboard/page.tsx", () => {
    const serviceUnavailableCheckIndex = dashboardSource.indexOf('entitlementResult.state === "service_unavailable"');
    const beforeCheck = dashboardSource.slice(0, serviceUnavailableCheckIndex);
    for (const forbidden of ['.from("clients")', '.from("appointments")', '.from("services")', '.from("employees")']) {
      assert.ok(!beforeCheck.includes(forbidden), `must not query ${forbidden} before the service_unavailable check`);
    }
  });

  // Phase 5.7D-R11: identical structural proof to the service_unavailable
  // tests above, for the new trial_not_started branch -- it must be
  // checked before the generic canViewExistingData gate (since its
  // capability profile also denies canViewExistingData, it would
  // otherwise be swallowed by the LockedReactivationScreen branch), and
  // no business-data query may run before it either.
  test("app/dashboard/page.tsx checks state === 'trial_not_started' BEFORE the canViewExistingData gate, and renders TrialActivationScreen there -- never LockedReactivationScreen", () => {
    assert.ok(dashboardSource.includes('import TrialActivationScreen from "@/app/components/dashboard/TrialActivationScreen"'));
    const trialCheckIndex = dashboardSource.indexOf('entitlementResult.state === "trial_not_started"');
    const canViewCheckIndex = dashboardSource.indexOf("!entitlementResult.canViewExistingData");
    assert.ok(trialCheckIndex > -1 && canViewCheckIndex > -1);
    assert.ok(trialCheckIndex < canViewCheckIndex, "the trial_not_started branch must be checked before the generic locked gate");
    const trialScreenIndex = dashboardSource.indexOf("<TrialActivationScreen", trialCheckIndex);
    assert.ok(trialScreenIndex > trialCheckIndex && trialScreenIndex < canViewCheckIndex);
  });

  test("no business-data query appears before the trial_not_started branch in app/dashboard/page.tsx", () => {
    const trialCheckIndex = dashboardSource.indexOf('entitlementResult.state === "trial_not_started"');
    const beforeCheck = dashboardSource.slice(0, trialCheckIndex);
    for (const forbidden of ['.from("clients")', '.from("appointments")', '.from("services")', '.from("employees")']) {
      assert.ok(!beforeCheck.includes(forbidden), `must not query ${forbidden} before the trial_not_started check`);
    }
  });

  test("neither page reads workspace identity from request-controlled input", () => {
    for (const source of [dashboardSource, scheduleSource]) {
      for (const forbidden of ["searchParams", "req.json", "headers.get"]) {
        assert.ok(!source.includes(forbidden), `must not read workspace identity via "${forbidden}"`);
      }
    }
  });

  test("neither page calls requireCapability/requireCapabilityForWorkspace directly -- resolution stays on the fetchEntitlementForWorkspace path only", () => {
    for (const source of [dashboardSource, scheduleSource]) {
      assert.ok(!source.includes("requireCapability("));
      assert.ok(!source.includes("requireCapabilityForWorkspace("));
    }
  });
});
