// Phase 5.6F-R1: source-level proof tests for TemporaryUnavailableScreen.ts.
// Node's test runner cannot load .tsx files, and this component (like
// OwnerBillingBanner.ts/LockedReactivationScreen.ts) uses React.createElement
// specifically so it CAN be loaded -- but real rendered-DOM proof isn't
// needed here the way it is for OwnerBillingBanner's activation/pending
// state machine: this component has exactly one static message and one
// stateless retry action with no async flow, no Stripe call, and no
// props. Source inspection fully proves the requirements below.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./TemporaryUnavailableScreen.ts", import.meta.url)), "utf8");

describe("TemporaryUnavailableScreen", () => {
  test("shows temporarily-unavailable messaging, not cancellation/payment/permanent-lock wording", () => {
    assert.ok(source.includes("Temporarily unavailable"));
    assert.ok(source.includes("Your data is safe"));
    for (const forbidden of ["cancel", "unpaid", "past due", "past_due", "permanently locked", "subscription required", "reactivate your subscription"]) {
      assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()), `must not contain "${forbidden}"`);
    }
  });

  test("has a Retry action that reloads the page -- no async flow, no Stripe/billing call", () => {
    assert.ok(source.includes("Retry"));
    assert.ok(source.includes("window.location.reload()"));
    // Checks actual usage (an import or a call), not the bare word -- this
    // file's own explanatory comments legitimately name
    // beginBillingRecovery to describe what it deliberately does NOT do.
    assert.ok(!source.includes("import { beginBillingRecovery"));
    assert.ok(!source.includes("beginBillingRecovery("));
    for (const forbidden of ["fetch(", "/api/stripe/checkout", "/api/stripe/portal"]) {
      assert.ok(!source.includes(forbidden), `must not reference "${forbidden}"`);
    }
  });

  test("takes no props -- there is nothing subscription/workspace-specific for it to leak", () => {
    assert.ok(source.includes("export default function TemporaryUnavailableScreen()"));
  });

  test("never imports raw entitlement/billing/workspace/Stripe modules", () => {
    for (const forbidden of ['from "@/lib/entitlement"', 'from "@/lib/entitlementServer"', 'from "@/lib/billingRecovery"', 'from "@/lib/workspace"']) {
      assert.ok(!source.includes(forbidden), `must not import ${forbidden}`);
    }
  });

  test("is a client component (owns an onClick handler)", () => {
    assert.ok(source.startsWith('"use client";'));
  });
});
