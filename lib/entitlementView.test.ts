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
    ...overrides,
  };
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
    });
  });

  test("past_due_expired: restricted capabilities, restricted banner, portal recovery", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "past_due", graceUntil: new Date(NOW.getTime() - 1000) }), NOW);
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: false,
      canUseJobTracking: false,
      canSendNotifications: false,
      bannerVariant: "restricted",
      recoveryAction: "portal",
    });
  });

  test("unpaid: restricted capabilities, restricted banner, portal recovery", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "unpaid" }), NOW);
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: false,
      canUseJobTracking: false,
      canSendNotifications: false,
      bannerVariant: "restricted",
      recoveryAction: "portal",
    });
  });

  test("canceled: restricted capabilities, restricted banner, checkout recovery", () => {
    const result = resolveEntitlement(stripeRecord({ stripeStatus: "canceled" }), NOW);
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: false,
      canUseJobTracking: false,
      canSendNotifications: false,
      bannerVariant: "restricted",
      recoveryAction: "checkout",
    });
  });

  test("no_subscription (genuinely no row): restricted capabilities, restricted banner, checkout recovery", () => {
    const result = resolveEntitlement(null, NOW);
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: false,
      canUseJobTracking: false,
      canSendNotifications: false,
      bannerVariant: "restricted",
      recoveryAction: "checkout",
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
    });
  });

  test("query_error: shares no_subscription's STATE but must resolve to verification_error/support, never checkout", () => {
    const result = noDataResult("query_error");
    assert.equal(result.state, "no_subscription", "sanity: query_error and genuine no_subscription share the same state");
    assert.equal(result.reason, "query_error", "sanity: reason is the only field distinguishing them");
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: false,
      canUseJobTracking: false,
      canSendNotifications: false,
      bannerVariant: "verification_error",
      recoveryAction: "support",
    });
  });

  test("internal billing: full capabilities, no banner, no recovery action", () => {
    const result = resolveEntitlement({ ...stripeRecord(), billingMode: "internal", stripeStatus: null }, NOW);
    assert.deepEqual(projectEntitlementForOwner(result), {
      canMutateOperationalData: true,
      canUseJobTracking: true,
      canSendNotifications: true,
      bannerVariant: "none",
      recoveryAction: null,
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
    });
  });

  test("a non-demo workspace with no subscription data does NOT receive the demo projection", () => {
    const result = resolveWorkspaceEntitlement(REAL_WORKSPACE_ID, null, NOW);
    const view = projectEntitlementForOwner(result);
    assert.equal(view.bannerVariant, "restricted");
    assert.equal(view.recoveryAction, "checkout");
  });

  const UNMAPPED_RESTRICTED_STATES: Array<[string, SubscriptionRecord]> = [
    ["incomplete", stripeRecord({ stripeStatus: "incomplete" })],
    ["incomplete_expired", stripeRecord({ stripeStatus: "incomplete_expired" })],
    ["paused", stripeRecord({ stripeStatus: "paused" })],
  ];
  for (const [label, record] of UNMAPPED_RESTRICTED_STATES) {
    test(`${label}: not explicitly assigned by the Phase 5.5A mapping -- fails safe to restricted capabilities + verification_error/support, never a guessed checkout/portal action`, () => {
      const result = resolveEntitlement(record, NOW);
      const view = projectEntitlementForOwner(result);
      assert.equal(view.canMutateOperationalData, false, label);
      assert.equal(view.canUseJobTracking, false, label);
      assert.equal(view.canSendNotifications, false, label);
      assert.equal(view.bannerVariant, "verification_error", label);
      assert.equal(view.recoveryAction, "support", label);
    });
  }
});

describe("capability booleans are always copied verbatim from the canonical resolved result", () => {
  const STATES: Array<[string, SubscriptionRecord | null]> = [
    ["active", stripeRecord({ stripeStatus: "active" })],
    ["trialing", stripeRecord({ stripeStatus: "trialing" })],
    ["past_due_grace", stripeRecord({ stripeStatus: "past_due", graceUntil: new Date(NOW.getTime() + 1000) })],
    ["past_due_expired", stripeRecord({ stripeStatus: "past_due", graceUntil: new Date(NOW.getTime() - 1000) })],
    ["unpaid", stripeRecord({ stripeStatus: "unpaid" })],
    ["canceled", stripeRecord({ stripeStatus: "canceled" })],
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
    resolveEntitlement(stripeRecord({ stripeStatus: "canceled" }), NOW),
    resolveEntitlement(null, NOW),
    noDataResult("query_error"),
    resolveWorkspaceEntitlement(DEMO_WORKSPACE_ID, null, NOW),
    resolveEntitlement({ ...stripeRecord(), billingMode: "internal", stripeStatus: null }, NOW),
  ];

  test("contains exactly the five approved keys, nothing else, for every fixture", () => {
    for (const result of FIXTURES) {
      const view = projectEntitlementForOwner(result);
      assert.deepEqual(
        Object.keys(view).sort(),
        ["bannerVariant", "canMutateOperationalData", "canSendNotifications", "canUseJobTracking", "recoveryAction"]
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
    assert.equal(sensitiveResult.reason, "past_due_grace_expired");
    assert.equal(sensitiveResult.state, "past_due_expired");
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
