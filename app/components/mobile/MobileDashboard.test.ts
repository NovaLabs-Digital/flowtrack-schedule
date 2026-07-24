// Phase 5.5E-E1C: MobileDashboard.tsx is a .tsx file and cannot be loaded by
// Node's built-in test runner (this repo's only test runner) -- the same
// limitation documented in TopBar.test.ts and every other .tsx production
// file in this entitlement-enforcement effort. This file proves what SOURCE
// INSPECTION can prove: prop wiring, guard placement, exact wording, and
// structural absence of forbidden content. It does not claim to exercise
// real DOM rendering or real mouse/keyboard/touch events for THIS component.
//
// The "+ Add Appointment" control here IS rendered through
// CapabilityGatedButton (unlike TopBar's desktop control, which carries a
// data-tour attribute CapabilityGatedButton cannot pass through). Real
// rendered mouse/keyboard interaction proof for that shared primitive
// (disabled, aria-disabled, zero-call mouse/Enter/Space/repeated activation
// while restricted) already exists in CapabilityGatedButton.test.ts and is
// cited here, not re-executed.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./MobileDashboard.tsx", import.meta.url)), "utf8");
const shellSource = fs.readFileSync(
  fileURLToPath(new URL("../dashboard/DashboardShell.tsx", import.meta.url)),
  "utf8"
);

const APPROVED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

describe("prop wiring", () => {
  test("Props includes canMutateOperationalData: boolean", () => {
    assert.match(source, /canMutateOperationalData:\s*boolean;/);
  });

  test("the component destructures canMutateOperationalData from its props", () => {
    const fnStart = source.indexOf("export default function MobileDashboard({");
    const fnParamsEnd = source.indexOf("}: Props)", fnStart);
    const params = source.slice(fnStart, fnParamsEnd);
    assert.match(params, /^\s*canMutateOperationalData,$/m);
  });

  test("DashboardShell passes entitlement.canMutateOperationalData to MobileDashboard", () => {
    const idx = shellSource.indexOf("<MobileDashboard");
    assert.notEqual(idx, -1, "MobileDashboard must be rendered in DashboardShell");
    const closeIdx = shellSource.indexOf("/>", idx);
    const jsx = shellSource.slice(idx, closeIdx);
    assert.match(jsx, /canMutateOperationalData=\{entitlement\.canMutateOperationalData\}/);
  });
});

describe("+ Add Appointment control governed by CapabilityGatedButton", () => {
  // Anchored on the JSX comment marker and searched FORWARD to the opening
  // tag, rather than backward from the "+ Add Appointment" child text --
  // this file's own header comment (line ~35) legitimately names that
  // control by its exact label when explaining why it differs from TopBar's
  // control, so a backward search from the child text's first occurrence
  // would land on that unrelated comment instead of the real button.
  const containerMarkerIdx = source.indexOf("{/* Add Appointment */}");
  const capabilityGatedButtonIdx = source.indexOf("<CapabilityGatedButton", containerMarkerIdx);

  test("the container marker and the CapabilityGatedButton call site are both found, in that order", () => {
    assert.notEqual(containerMarkerIdx, -1);
    assert.notEqual(capabilityGatedButtonIdx, -1);
    assert.ok(containerMarkerIdx < capabilityGatedButtonIdx);
  });

  test("the control is a CapabilityGatedButton, not a plain <button>", () => {
    assert.ok(source.includes("import CapabilityGatedButton from"));
  });

  test("allowed is wired to canMutateOperationalData", () => {
    const block = source.slice(capabilityGatedButtonIdx, capabilityGatedButtonIdx + 400);
    assert.match(block, /allowed=\{canMutateOperationalData\}/);
  });

  test("onClick is passed directly as onAdd -- CapabilityGatedButton's own internal guard is the gate, no extra wrapping that could reintroduce a bypass", () => {
    const block = source.slice(capabilityGatedButtonIdx, capabilityGatedButtonIdx + 400);
    assert.match(block, /onClick=\{onAdd\}/);
    assert.ok(!block.includes("onClick={() =>"));
  });

  test("ariaDescribedBy points at this component's own notice id", () => {
    const block = source.slice(capabilityGatedButtonIdx, capabilityGatedButtonIdx + 400);
    assert.match(block, /ariaDescribedBy=\{RESTRICTED_NOTICE_ID\}/);
  });

  test("original className (full-width block, background, text styling) is preserved with disabled:opacity-50 added", () => {
    assert.ok(
      source.includes(
        'className="w-full rounded-xl bg-slate-900 px-4 py-3.5 text-sm font-semibold text-white active:bg-slate-800 disabled:opacity-50 transition-colors"'
      )
    );
  });

  test('type="button" is preserved', () => {
    const block = source.slice(capabilityGatedButtonIdx, capabilityGatedButtonIdx + 400);
    assert.match(block, /type="button"/);
  });
});

describe("notice block", () => {
  test("exact approved wording constant", () => {
    assert.ok(source.includes(`const RESTRICTED_WORDING = "${APPROVED_WORDING}";`));
  });

  test("notice only renders when restricted (negated condition)", () => {
    assert.match(source, /\{!canMutateOperationalData && \(/);
  });

  test("notice id's declared value is unique to this component", () => {
    const declared = source.match(/const RESTRICTED_NOTICE_ID = "([^"]+)";/)?.[1];
    assert.equal(declared, "mobile-dashboard-restricted-notice");
    assert.notEqual(declared, "appointment-modal-restricted-notice");
    assert.notEqual(declared, "appointment-detail-restricted-notice");
    assert.notEqual(declared, "move-confirm-dialog-restricted-notice");
    assert.notEqual(declared, "topbar-restricted-notice");
  });

  test("only one notice block exists, scoped to the Today tab's Add Appointment area -- not duplicated across Schedule/Clients/Settings tabs", () => {
    const matches = source.match(/id=\{RESTRICTED_NOTICE_ID\}/g) ?? [];
    assert.equal(matches.length, 1);
  });

  test("the notice sits inside the same shrink-0 Add-Appointment container as the button, not as a separate global banner", () => {
    const containerIdx = source.indexOf('{/* Add Appointment */}');
    assert.notEqual(containerIdx, -1);
    const nextContainerIdx = source.indexOf("activeTab ===", containerIdx);
    const block = source.slice(containerIdx, nextContainerIdx);
    assert.ok(block.includes("RESTRICTED_NOTICE_ID"));
    assert.ok(block.includes("CapabilityGatedButton"));
  });
});

describe("no other appointment-entry control exists in the mobile tree", () => {
  test("MobileDashboard.tsx contains exactly one onAdd invocation (the governed CapabilityGatedButton call site)", () => {
    const matches = source.match(/onAdd/g) ?? [];
    // 1 in the Props type, 1 in the destructured params, 1 as the onClick
    // value passed to CapabilityGatedButton -- three textual occurrences,
    // one logical call site.
    assert.equal(matches.length, 3);
  });
});

describe("mobile tab navigation and non-mutating controls remain available", () => {
  test("MobileBottomNav is rendered unconditionally, not gated on canMutateOperationalData", () => {
    const idx = source.indexOf("<MobileBottomNav");
    assert.notEqual(idx, -1);
    const before = source.slice(Math.max(0, idx - 60), idx);
    assert.ok(!before.includes("canMutateOperationalData &&"));
  });

  test("Schedule/Clients/Settings tab bodies remain unconditional on canMutateOperationalData", () => {
    for (const marker of ['activeTab === "schedule"', 'activeTab === "clients"', 'activeTab === "settings"']) {
      const idx = source.indexOf(marker);
      assert.notEqual(idx, -1, `expected to find ${marker}`);
      const line = source.slice(idx, idx + 80);
      assert.ok(!line.includes("canMutateOperationalData"));
    }
  });

  test("appointment cards (MobileAppointmentCard onTap) and client drawer navigation remain unconditional -- read-only viewing is never gated", () => {
    assert.ok(source.includes("onTap={() => setSelectedApptId(a.id)}"));
    const idx = source.indexOf("onTap={() => setSelectedApptId(a.id)}");
    const block = source.slice(Math.max(0, idx - 100), idx);
    assert.ok(!block.includes("canMutateOperationalData"));
  });

  test("day-strip navigation (prev/next day, day-of-week taps) remains unconditional", () => {
    assert.ok(source.includes("onClick={() => setDayOffset((o) => o - 1)}"));
    assert.ok(source.includes("onClick={() => setDayOffset((o) => o + 1)}"));
  });
});

describe("no leaked internal detail", () => {
  test("no OwnerBillingBanner DUPLICATE -- the existing single OwnerBillingBanner render is untouched, not a second instance added by this phase", () => {
    const matches = source.match(/<OwnerBillingBanner/g) ?? [];
    assert.equal(matches.length, 1);
  });

  test("no billing/subscription/Stripe/entitlement-reason/workspace vocabulary appears in the restricted-state code this phase added", () => {
    // Scoped to the region this phase actually touched (the RESTRICTED_*
    // constants through the end of the Add-Appointment container), not the
    // whole file -- this file has a long pre-existing history unrelated to
    // this phase, including a genuine, unrelated use of the word
    // "subscription" (line ~87, describing a window.postMessage pub/sub
    // relationship for the demo-experience tab-change bridge) that a
    // whole-file search would misread as a billing-vocabulary leak.
    const constantsStart = source.indexOf("const RESTRICTED_NOTICE_ID");
    const constantsEnd = source.indexOf("type Props = {");
    const containerStart = source.indexOf("{/* Add Appointment */}");
    const containerEnd = source.indexOf("activeTab ===", containerStart);
    const region = source.slice(constantsStart, constantsEnd) + source.slice(containerStart, containerEnd);
    for (const forbidden of [
      "subscription", "Subscription", "Stripe", "stripe",
      "grace", "Grace", "trial", "Trial", "workspace", "Workspace",
      "past_due", "canceled", "malformed", "checkout", "portal",
      ".reason", ".state", "billingMode",
    ]) {
      assert.ok(!region.includes(forbidden), `the restricted-state code added by this phase must not contain "${forbidden}"`);
    }
  });

  test("canMutateOperationalData is consumed as a plain prop -- no session/workspace/fetch-based re-derivation inside this component", () => {
    for (const forbidden of ["getSession", "fetchEntitlementForWorkspace", "requireCapability", "localStorage", "sessionStorage"]) {
      assert.ok(!source.includes(forbidden), `MobileDashboard.tsx must not contain "${forbidden}"`);
    }
  });
});
