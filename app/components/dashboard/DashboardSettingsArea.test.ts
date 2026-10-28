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
