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

describe("DashboardSettingsArea: owner-path Settings scroll container reserves its scrollbar gutter", () => {
  test("the flex-1 min-h-0 overflow-auto pt-8 div (Billing's own scrollable ancestor) carries scrollbarGutter: \"stable\"", () => {
    const block = source.match(/<div className="flex-1 min-h-0 overflow-auto pt-8"[^>]*>/);
    assert.ok(block, "the owner-path scroll container div is present");
    assert.match(block![0], /style=\{\{\s*scrollbarGutter:\s*"stable"\s*\}\}/, "overflow-auto itself is untouched -- this only reserves the scrollbar's gutter width, never hides overflow");
  });

  test("this is the OWNER path specifically -- the tester/Demo Mode and interactive-carve-out branches are untouched (Billing is never reachable from either)", () => {
    const ownerBlockStart = source.indexOf('if (!isTester) {');
    const ownerBlockEnd = source.indexOf("const carveOutActive");
    const ownerBlock = source.slice(ownerBlockStart, ownerBlockEnd);
    assert.match(ownerBlock, /scrollbarGutter/);
    const restOfFile = source.slice(ownerBlockEnd);
    assert.doesNotMatch(restOfFile, /scrollbarGutter/, "the tester-only branches never render Billing, so they need no scrollbar-gutter fix");
  });
});

describe("DashboardSettingsArea: browser-local demo (isLocalDemo) carve-out", () => {
  test("isLocalDemo is an optional prop defaulting to false, so the real dashboard (which never passes it) is unchanged", () => {
    assert.match(source, /isLocalDemo\?:\s*boolean;/);
    assert.match(source, /export default function DashboardSettingsArea\(\{\s*isTester,\s*isLocalDemo = false,/);
  });

  test("the owner path (!isTester) never references isLocalDemo or the demo-only panels", () => {
    const ownerBlock = source.slice(source.indexOf("if (!isTester) {"), source.indexOf("const carveOutActive"));
    assert.doesNotMatch(ownerBlock, /isLocalDemo|DemoControlsPanel|demoControlsOpen/);
  });

  test("the carve-out condition is isLocalDemo OR the original Employees/Services experience-step condition", () => {
    assert.match(
      source,
      /const carveOutActive = isLocalDemo \|\| \(active && \(currentStep\?\.id === "employees" \|\| currentStep\?\.id === "services"\)\);/
    );
  });

  test("Billing is only a valid carve-out section when isLocalDemo; otherwise the original staff fallback applies", () => {
    assert.match(source, /settingsSection === "staff" \|\| settingsSection === "services" \|\| \(isLocalDemo && settingsSection === "billing"\)/);
  });

  test("the Billing and Demo Controls sidebar entries render only under isLocalDemo", () => {
    const gated = source.slice(source.indexOf("{isLocalDemo && ("), source.indexOf("<div className=\"flex-1\" />"));
    assert.match(gated, /onSettingsSelect\("billing"\)/);
    assert.match(gated, />\s*Billing\s*</);
    assert.match(gated, /setDemoControlsOpen\(true\)/);
    assert.match(gated, />\s*Demo Controls\s*</);
  });

  test("the carve-out render path uses the real SettingsPanel section=\"billing\" with the already-threaded props, and DemoControlsPanel", () => {
    const carveOut = source.slice(source.indexOf("if (carveOutActive) {"));
    const panel = carveOut.match(/<SettingsPanel[\s\S]*?\/>/);
    assert.ok(panel);
    for (const p of [
      'section="billing"',
      "canMutateOperationalData={canMutateOperationalData}",
      "isTrialing={isTrialing}",
      "timezone={timezone}",
      "workspaceId={workspaceId}",
      "userId={userId}",
      "billingFocusAppointmentId={billingFocusAppointmentId}",
      "billingFocusServiceDate={billingFocusServiceDate}",
      "onBillingSaved={onBillingSaved}",
    ]) {
      assert.ok(panel![0].includes(p), `SettingsPanel missing ${p}`);
    }
    assert.match(carveOut, /<DemoControlsPanel onBack=\{onBack\} \/>/);
  });

  test("Demo Controls is shown only when isLocalDemo AND selected (component-local, not a persisted SettingsSection)", () => {
    assert.match(source, /const showDemoControls = isLocalDemo && demoControlsOpen;/);
    assert.match(source, /useState\(false\)/);
  });

  test("the non-carve-out tester Demo Mode notice is untouched", () => {
    const notice = source.slice(source.lastIndexOf("return ("));
    assert.ok(notice.includes("Full settings management is available in owner accounts."));
    assert.ok(notice.includes(">20<") && notice.includes(">38<"));
    assert.doesNotMatch(notice, /isLocalDemo|DemoControlsPanel/);
  });
});
