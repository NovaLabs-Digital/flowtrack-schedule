// Phase 5.5E-E1C: TopBar.tsx is a .tsx file. Node's built-in test runner
// (this repo's only test runner) cannot load a .tsx file at all, with or
// without JSX content -- the same well-documented limitation hit by every
// .tsx production file in this entitlement-enforcement effort
// (AppointmentModal.test.ts, AppointmentDetailPanel.test.ts, MoveConfirmDialog
// .test.ts, ScheduleGrid.test.ts). This file proves what SOURCE INSPECTION
// can actually prove -- prop wiring, guard placement, exact wording, and
// structural absence of forbidden content -- and does not claim to exercise
// real DOM rendering or real mouse/keyboard events for THIS component.
//
// The desktop "Add Appointment" control is deliberately NOT rendered through
// CapabilityGatedButton (see the source comment at its call site): it
// carries data-tour="add-appointment", a load-bearing selector the
// Interactive Business Experience demo tour targets
// (demoExperienceSteps.ts), and CapabilityGatedButton has no passthrough for
// arbitrary attributes. Because of that, CapabilityGatedButton.test.ts's
// existing rendered mouse/keyboard interaction proof does NOT automatically
// cover this control the way it does for MobileDashboard's button or the
// E-E1B controls -- this file's guard-placement and disabled-attribute
// assertions are therefore the primary proof available for this specific
// control within this repository's test architecture, and they are
// source-level only, not executed browser behavior.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./TopBar.tsx", import.meta.url)), "utf8");
const shellSource = fs.readFileSync(fileURLToPath(new URL("./DashboardShell.tsx", import.meta.url)), "utf8");

const APPROVED_WORDING = "Changes are temporarily unavailable. See the account notice for details.";

describe("prop wiring", () => {
  test("the prop-destructuring parameter list includes canMutateOperationalData", () => {
    assert.match(source, /^\s*canMutateOperationalData,$/m);
  });

  test("the type annotation includes canMutateOperationalData: boolean", () => {
    assert.match(source, /canMutateOperationalData:\s*boolean;/);
  });

  test("DashboardShell passes entitlement.canMutateOperationalData to TopBar", () => {
    const idx = shellSource.indexOf("<TopBar");
    assert.notEqual(idx, -1, "TopBar must be rendered in DashboardShell");
    const closeIdx = shellSource.indexOf("/>", idx);
    const jsx = shellSource.slice(idx, closeIdx);
    assert.match(jsx, /canMutateOperationalData=\{entitlement\.canMutateOperationalData\}/);
  });
});

describe("desktop Add Appointment control (not CapabilityGatedButton -- preserves data-tour)", () => {
  test("the control remains a plain <button> carrying data-tour=\"add-appointment\" unchanged", () => {
    assert.ok(source.includes('data-tour="add-appointment"'));
  });

  test("onClick is the local guarded wrapper (handleAddClick), not onAdd directly", () => {
    const idx = source.indexOf('data-tour="add-appointment"');
    const block = source.slice(Math.max(0, idx - 300), idx);
    assert.match(block, /onClick=\{handleAddClick\}/);
    assert.ok(!block.includes("onClick={onAdd}"));
  });

  test("disabled and aria-disabled are both wired to !canMutateOperationalData", () => {
    const idx = source.indexOf('data-tour="add-appointment"');
    const block = source.slice(Math.max(0, idx - 300), idx);
    assert.match(block, /disabled=\{!canMutateOperationalData\}/);
    assert.match(block, /aria-disabled=\{!canMutateOperationalData\}/);
  });

  test("aria-describedby is conditionally set to RESTRICTED_NOTICE_ID only while restricted", () => {
    const idx = source.indexOf('data-tour="add-appointment"');
    const block = source.slice(Math.max(0, idx - 300), idx);
    assert.match(block, /aria-describedby=\{!canMutateOperationalData \? RESTRICTED_NOTICE_ID : undefined\}/);
  });

  test("the button's core className (icon+text layout, background, hover) is preserved, with disabled:opacity-50 added", () => {
    assert.ok(
      source.includes(
        'className="flex items-center gap-1.5 rounded-lg bg-[#0f172a] px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 disabled:opacity-50 transition-colors"'
      )
    );
  });

  test("the icon (+) and label (Add Appointment) text are unchanged", () => {
    assert.ok(source.includes('<span className="text-base leading-none">+</span>'));
    assert.ok(source.includes("Add Appointment"));
  });
});

describe("handleAddClick guard", () => {
  test("handleAddClick guards on canMutateOperationalData before calling onAdd", () => {
    const fnStart = source.indexOf("function handleAddClick()");
    assert.notEqual(fnStart, -1);
    const braceIdx = source.indexOf("{", fnStart);
    const afterBrace = source.slice(braceIdx + 1, braceIdx + 200);
    const firstNonCommentNonBlank = afterBrace
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("//"));
    assert.equal(firstNonCommentNonBlank, "if (!canMutateOperationalData) return;");
    const guardIdx = source.indexOf("if (!canMutateOperationalData) return;", fnStart);
    const onAddIdx = source.indexOf("onAdd();", fnStart);
    assert.ok(guardIdx < onAddIdx, "guard must run before onAdd() is invoked");
  });

  test("this is a SECOND, independent guard layer -- DashboardShell's handleAdd (this control's onAdd) already guards the same way", () => {
    const idx = shellSource.indexOf("function handleAdd()");
    assert.notEqual(idx, -1);
    const fnEnd = shellSource.indexOf("setModal({ mode: \"create\" });", idx);
    const body = shellSource.slice(idx, fnEnd);
    assert.match(body, /if \(!entitlement\.canMutateOperationalData\) return;/);
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
    assert.equal(declared, "topbar-restricted-notice");
    assert.notEqual(declared, "appointment-modal-restricted-notice");
    assert.notEqual(declared, "appointment-detail-restricted-notice");
    assert.notEqual(declared, "move-confirm-dialog-restricted-notice");
    assert.notEqual(declared, "mobile-dashboard-restricted-notice");
  });

  test("only one notice block exists in this file", () => {
    const matches = source.match(/id=\{RESTRICTED_NOTICE_ID\}/g) ?? [];
    assert.equal(matches.length, 1);
  });

  test("the notice reuses this file's own established absolute-dropdown pattern (absolute top-full mt-1 ... rounded-xl border ... bg-white shadow-lg), not a newly invented tooltip mechanism", () => {
    const idx = source.indexOf("id={RESTRICTED_NOTICE_ID}");
    const block = source.slice(idx, idx + 250);
    assert.match(block, /absolute top-full mt-1/);
    assert.match(block, /rounded-xl border border-slate-200 bg-white shadow-lg/);
    // The pre-existing user-menu dropdown in this same file uses the
    // identical positioning idiom -- confirms reuse, not invention.
    assert.ok(source.includes('className="absolute top-full mt-1 right-0 w-44 rounded-xl border border-slate-200 bg-white shadow-lg p-1 z-50"'));
  });
});

describe("non-mutating desktop controls remain available", () => {
  test("Today/Prev/Next navigation buttons carry no capability guard", () => {
    assert.ok(source.includes("onClick={onGoToday}"));
    assert.ok(source.includes("onClick={() => onWeekChange(weekOffset - 1)}"));
    assert.ok(source.includes("onClick={() => onWeekChange(weekOffset + 1)}"));
    for (const handler of ["onClick={onGoToday}", "onClick={() => onWeekChange(weekOffset - 1)}", "onClick={() => onWeekChange(weekOffset + 1)}"]) {
      const idx = source.indexOf(handler);
      const block = source.slice(Math.max(0, idx - 50), idx);
      assert.ok(!block.includes("canMutateOperationalData"));
    }
  });

  test("Sign Out, search box, and notification bell remain unconditional (unchanged, coming-soon placeholders untouched)", () => {
    assert.ok(source.includes("onClick={handleLogout}"));
    assert.ok(source.includes('title="Search (coming soon)"'));
    assert.ok(source.includes('title="Notifications (coming soon)"'));
  });
});

describe("no duplicated billing surface, no leaked internal detail", () => {
  test("no OwnerBillingBanner reference in this file", () => {
    assert.ok(!source.includes("OwnerBillingBanner"));
  });

  test("no billing/subscription/Stripe/entitlement-reason/workspace vocabulary appears in this file", () => {
    for (const forbidden of [
      "subscription", "Subscription", "Stripe", "stripe",
      "grace", "Grace", "trial", "Trial", "workspace", "Workspace",
      "past_due", "canceled", "malformed", "checkout", "portal",
      ".reason", ".state", "billingMode",
    ]) {
      assert.ok(!source.includes(forbidden), `TopBar.tsx must not contain "${forbidden}"`);
    }
  });

  test("canMutateOperationalData is consumed as a plain prop -- no session/workspace/fetch-based re-derivation inside this component", () => {
    for (const forbidden of ["getSession", "fetchEntitlementForWorkspace", "requireCapability", "localStorage", "sessionStorage"]) {
      assert.ok(!source.includes(forbidden), `TopBar.tsx must not contain "${forbidden}"`);
    }
  });
});

describe("mobile branch of TopBar has no appointment-entry control to govern", () => {
  test("the isMobile early-return branch contains no Add Appointment control and is unreachable from DashboardShell (which never passes isMobile to TopBar)", () => {
    const mobileBranchStart = source.indexOf("if (isMobile) {");
    const mobileBranchEnd = source.indexOf("// --- DESKTOP TOP BAR");
    assert.notEqual(mobileBranchStart, -1);
    assert.notEqual(mobileBranchEnd, -1);
    const mobileBranch = source.slice(mobileBranchStart, mobileBranchEnd);
    assert.ok(!mobileBranch.includes("Add Appointment"));
    assert.ok(!mobileBranch.includes("onAdd"));

    const shellTopBarIdx = shellSource.indexOf("<TopBar");
    const shellTopBarClose = shellSource.indexOf("/>", shellTopBarIdx);
    const shellTopBarJsx = shellSource.slice(shellTopBarIdx, shellTopBarClose);
    assert.ok(!shellTopBarJsx.includes("isMobile"));
  });
});
