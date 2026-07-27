// Phase 5.7D-R11: source-level proof tests for TrialActivationScreen.ts,
// matching TemporaryUnavailableScreen.test.ts's/LockedReactivationScreen's
// established convention -- Node's test runner cannot load a .tsx file,
// and this component (createElement-authored specifically so it CAN be
// loaded here) has one interactive action (activate() calling
// beginBillingRecovery("checkout")), whose real behavior is already
// proven at the beginBillingRecovery level (lib/billingRecovery.test.ts);
// this file proves the component's own wiring, content, and capability
// profile via source inspection.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./TrialActivationScreen.ts", import.meta.url)), "utf8");
// This file's own header comment legitimately explains what business-data
// fetches it deliberately DOESN'T perform (naming clients/appointments/
// etc. to say so) -- checks for the absence of real data access must
// operate on executable code only, not that explanatory prose.
const codeOnly = source
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

describe("TrialActivationScreen -- exact required customer-facing wording (Phase 5.7D-R11)", () => {
  test('shows "Start your 30-day free trial"', () => {
    assert.ok(source.includes("Start your 30-day free trial"));
  });

  test('states "No charge today. $24.99/month after the trial unless canceled."', () => {
    assert.ok(source.includes("No charge today. $24.99/month after the trial unless canceled."));
  });

  test("never displays reactivate/read-only-period-ended/data-preserved/contact-support as the primary action", () => {
    // Checked against executable code only -- this file's own header
    // comment legitimately quotes the old, wrong copy to explain the bug
    // being corrected (see its top-of-file explanation), which is not
    // itself a UI string.
    for (const forbidden of [
      "reactivate",
      "Reactivate",
      "read-only period has ended",
      "data has been preserved",
      "Contact support",
    ]) {
      assert.ok(!codeOnly.includes(forbidden), `must not contain "${forbidden}" in executable code`);
    }
  });

  test("the primary button label is 'Start free trial', not any LockedReactivationScreen label", () => {
    assert.ok(source.includes('"Start free trial"'));
    for (const forbidden of ["Reactivate subscription", "Update billing", "ACTION_LABEL"]) {
      assert.ok(!source.includes(forbidden), `must not reference "${forbidden}"`);
    }
  });
});

describe("TrialActivationScreen -- primary action targets the existing authenticated Checkout flow (Phase 5.7D-R11)", () => {
  test("imports and calls beginBillingRecovery with exactly the literal 'checkout' action -- never 'portal', 'support', a variable, or a client-supplied value", () => {
    assert.ok(source.includes('import { beginBillingRecovery } from "@/lib/billingRecovery";'));
    assert.match(source, /beginBillingRecovery\(\s*"checkout"\s*\)/);
    assert.ok(!source.includes('beginBillingRecovery("portal")'));
    assert.ok(!source.includes('beginBillingRecovery("support")'));
  });

  test("does not accept recoveryAction as a prop -- there is nothing for a caller to override; the action is always checkout", () => {
    assert.ok(source.includes("export default function TrialActivationScreen()"));
    // Checked against executable code only -- this file's own header
    // comment explains, in prose, why recoveryAction is deliberately NOT
    // a prop here (unlike LockedReactivationScreen), which necessarily
    // names the concept to explain its absence.
    assert.ok(!codeOnly.includes("recoveryAction"));
  });

  test("never fetches or constructs a Stripe/checkout URL directly -- delegates entirely to beginBillingRecovery, which owns the trusted-URL check", () => {
    for (const forbidden of ["fetch(", "/api/stripe/checkout", "stripe.com"]) {
      assert.ok(!codeOnly.includes(forbidden), `must not reference "${forbidden}" directly in executable code`);
    }
  });

  test("has a synchronous in-flight guard preventing a duplicate concurrent checkout request from one rapid double-click", () => {
    assert.ok(source.includes("const inFlightRef = useRef(false);"));
    assert.ok(source.includes("if (inFlightRef.current) return;"));
  });
});

describe("TrialActivationScreen -- no operational capability or business-data access (Phase 5.7D-R11)", () => {
  test("imports no data-fetching hook and receives no props at all -- there is no client/appointment/service/employee data for a never-checked-out workspace to leak", () => {
    assert.ok(source.includes("export default function TrialActivationScreen()"));
    for (const forbidden of ["clients", "appointments", "employees", "services"]) {
      assert.ok(!codeOnly.toLowerCase().includes(forbidden), `must not reference "${forbidden}" in executable code`);
    }
  });

  test("never imports raw entitlement/workspace/Stripe SDK modules -- only billingRecovery, matching LockedReactivationScreen's precedent", () => {
    for (const forbidden of ['from "@/lib/entitlement"', 'from "@/lib/entitlementServer"', 'from "@/lib/workspace"', 'from "stripe"']) {
      assert.ok(!source.includes(forbidden), `must not import ${forbidden}`);
    }
  });

  test("is a client component (owns onClick/useState/useRef)", () => {
    assert.ok(source.startsWith('"use client";'));
  });
});
