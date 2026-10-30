// SOURCE INSPECTION, matching DashboardShell.test.ts's own established
// convention for this exact component family (DashboardSettingsArea is
// normally only rendered as part of a full DashboardShell render, which no
// test in this codebase attempts -- see that file's own header comment).
//
// This one assertion is the verified fix for the Billing layout-shift bug:
// clicking/editing Invoice #, Paid, or Payment Method could briefly shift
// the whole screen left then back, because the owner-path Settings scroll
// container's own vertical scrollbar toggled on and off in sync with a
// transient row-height change (BillingPanel.tsx's "Saving..." indicator
// wrapping to a second line at narrow viewports). Confirmed via a temporary
// Playwright-driven harness mounting the real BillingPanel with fictional
// data (harness deleted, never committed). scrollbarGutter: "stable"
// reserves that scrollbar's gutter permanently, so it can never again
// toggle the available width -- jsdom does no real layout/scrollbar math,
// so this is tested at the level this suite can actually reach: the style
// property is present on the right element.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./DashboardSettingsArea.tsx", import.meta.url)), "utf8");

describe("DashboardSettingsArea: owner-path (and isLocalDemo) Settings scroll container reserves its scrollbar gutter", () => {
  test("the flex-1 min-h-0 overflow-auto pt-8 div (Billing's own scrollable ancestor) carries scrollbarGutter: \"stable\"", () => {
    const block = source.match(/<div className="flex-1 min-h-0 overflow-auto pt-8"[^>]*>/);
    assert.ok(block, "the owner-path scroll container div is present");
    assert.match(block![0], /style=\{\{\s*scrollbarGutter:\s*"stable"\s*\}\}/, "overflow-auto itself is untouched -- this only reserves the scrollbar's gutter width, never hides overflow");
  });

  test("this is the shared owner/isLocalDemo path specifically -- the tour-carve-out and tester Demo Mode notice branches are untouched (Billing is never reachable from either)", () => {
    const ownerBlockStart = source.indexOf("if (!isTester || isLocalDemo) {");
    const ownerBlockEnd = source.indexOf("const carveOutActive");
    const ownerBlock = source.slice(ownerBlockStart, ownerBlockEnd);
    assert.match(ownerBlock, /scrollbarGutter/);
    const restOfFile = source.slice(ownerBlockEnd);
    assert.doesNotMatch(restOfFile, /scrollbarGutter/, "the tour-carve-out and tester-notice branches never render Billing, so they need no scrollbar-gutter fix");
  });
});

describe("DashboardSettingsArea: isLocalDemo routes through the REAL owner Settings navigation, not a bespoke redesign", () => {
  test("isLocalDemo is an optional prop defaulting to false, so the real dashboard (which never passes it) is unchanged", () => {
    assert.match(source, /isLocalDemo\?:\s*boolean;/);
    assert.match(source, /export default function DashboardSettingsArea\(\{\s*isTester,\s*isLocalDemo = false,/);
  });

  test("the top-level condition is \"!isTester || isLocalDemo\" -- isLocalDemo takes the exact same branch as the real owner, not a parallel one", () => {
    assert.match(source, /if \(!isTester \|\| isLocalDemo\) \{/);
  });

  test("that shared branch renders the real SettingsTabBar + SettingsPanel, unmodified", () => {
    const block = source.slice(source.indexOf("if (!isTester || isLocalDemo) {"), source.indexOf("const carveOutActive"));
    assert.match(block, /<SettingsTabBar activeSection=\{settingsSection\} onSelect=\{onSettingsSelect\} \/>/);
    const panel = block.match(/<SettingsPanel[\s\S]*?\/>/);
    assert.ok(panel, "SettingsPanel is rendered in the shared branch");
    for (const p of [
      "section={settingsSection}",
      "canMutateOperationalData={canMutateOperationalData}",
      "isTrialing={isTrialing}",
      "timezone={timezone}",
      "workspaceId={workspaceId}",
      "userId={userId}",
      "billingFocusAppointmentId={billingFocusAppointmentId}",
      "billingFocusServiceDate={billingFocusServiceDate}",
      "onBillingSaved={onBillingSaved}",
      "isLocalDemo={isLocalDemo}",
    ]) {
      assert.ok(panel![0].includes(p), `SettingsPanel missing ${p}`);
    }
  });

  test("the carve-out condition is the original Employees/Services experience-step condition only -- isLocalDemo plays no part in it", () => {
    assert.match(
      source,
      /const carveOutActive = active && \(currentStep\?\.id === "employees" \|\| currentStep\?\.id === "services"\);/
    );
  });

  test("the carve-out's own section fallback is the original two-way staff/services ternary -- no billing case", () => {
    assert.match(source, /const section = settingsSection === "staff" \|\| settingsSection === "services" \? settingsSection : "staff";/);
  });

  test("isLocalDemo never appears inside the carve-out or the tester Demo Mode notice branch -- only in the prop/doc comment and the shared top-level condition", () => {
    const afterSharedBranch = source.slice(source.indexOf("const carveOutActive"));
    assert.doesNotMatch(afterSharedBranch, /isLocalDemo/, "isLocalDemo must not appear anywhere after the shared owner/demo branch returns");
  });

  test("DemoControlsPanel/demoControlsOpen/showDemoControls are gone from this file entirely -- Demo Controls moved to the banner popover (DemoBannerControls)", () => {
    assert.doesNotMatch(source, /DemoControlsPanel/);
    assert.doesNotMatch(source, /demoControlsOpen|showDemoControls/);
  });

  test("the carve-out's own StaffPanel/ServicesPanel render is the original two-way branch, no billing/Demo Controls option", () => {
    const carveOut = source.slice(source.indexOf("if (carveOutActive) {"), source.lastIndexOf("return (\n    <div className=\"flex-1 min-h-0 overflow-auto pt-2\">"));
    assert.match(carveOut, /section === "staff"\s*\n\s*\? <StaffPanel isTester canMutateOperationalData=\{canMutateOperationalData\} \/>\s*\n\s*: <ServicesPanel isTester canMutateOperationalData=\{canMutateOperationalData\} \/>/);
    assert.doesNotMatch(carveOut, /SettingsPanel/, "Billing is never reachable from the tour carve-out -- only from the real Settings path above");
  });

  test("the non-carve-out tester Demo Mode notice is untouched", () => {
    const notice = source.slice(source.lastIndexOf("return ("));
    assert.ok(notice.includes("Full settings management is available in owner accounts."));
    assert.ok(notice.includes(">20<") && notice.includes(">38<"));
    assert.doesNotMatch(notice, /isLocalDemo|DemoControlsPanel/);
  });
});
