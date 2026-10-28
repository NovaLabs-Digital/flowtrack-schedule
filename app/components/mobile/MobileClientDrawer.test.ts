// Phase 5C: source-level proof tests for MobileClientDrawer.tsx.
// MobileClientDrawer.tsx is a .tsx file and cannot be loaded by Node's
// built-in test runner (this repo's only test runner) -- the same
// limitation documented throughout this repo's other .tsx production
// files. No test file previously existed for this component; one is added
// here because this phase introduced a real behavior change (the "Next:
// [date]" display previously used the device's own ambient timezone via a
// bare `new Date(iso).toLocaleDateString(...)`, now uses the workspace's
// resolved timezone).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./MobileClientDrawer.tsx", import.meta.url)), "utf8");
const mobileDashboardSource = fs.readFileSync(fileURLToPath(new URL("./MobileDashboard.tsx", import.meta.url)), "utf8");

describe("Phase 5C: workspace-timezone-aware 'Next' appointment display, date-only client_since left alone", () => {
  test("Props declares timezone: string", () => {
    assert.ok(source.includes("timezone: string;"));
  });

  test("MobileDashboard passes timezone={timezone} to this component", () => {
    const idx = mobileDashboardSource.indexOf("<MobileClientDrawer");
    assert.notEqual(idx, -1);
    const closeIdx = mobileDashboardSource.indexOf("/>", idx);
    const jsx = mobileDashboardSource.slice(idx, closeIdx);
    assert.match(jsx, /timezone=\{timezone\}/);
  });

  test("a real timestamp (nextAppt.scheduled_for) is formatted via the new fmtApptDate helper, anchored to the explicit timezone prop -- never the device's own ambient timezone", () => {
    assert.ok(source.includes('import { formatMMDDYY, formatTimestampMMDDYY } from "@/lib/dateDisplay";'));
    assert.ok(source.includes("function fmtApptDate(iso: string, tz: string) {"));
    assert.ok(source.includes("formatTimestampMMDDYY(iso, tz)"));
    assert.ok(source.includes("fmtApptDate(nextAppt.scheduled_for, timezone)"));
  });

  // Date-formatting standardization: both display helpers now go through
  // the shared MM/DD/YY formatter (lib/dateDisplay.ts). As a direct
  // consequence, fmtDate no longer constructs a Date at all for the
  // date-only client_since field -- the PREVIOUS local implementation
  // (`new Date(iso).toLocaleDateString(...)`) actually contradicted its own
  // comment's stated intent, since a bare `new Date("YYYY-MM-DD")` parses
  // as UTC midnight and can shift the displayed day backward in a
  // negative-UTC-offset zone. The shared formatMMDDYY never constructs a
  // Date at all, so that mismatch is gone, not just relabeled.
  test("fmtDate (the date-only client_since field) uses the shared formatMMDDYY -- never a Date construction, so it can never be timezone-shifted", () => {
    assert.ok(source.includes("function fmtDate(iso: string) {"));
    assert.ok(source.includes("formatMMDDYY(iso)"));
    assert.ok(!source.includes("new Date(iso)"), "the old bare Date-construction parse must be gone entirely");
    assert.ok(source.includes("fmtDate(client.client_since)"));
    // The two formatters must stay distinct -- client_since never routes
    // through fmtApptDate, and nextAppt's real timestamp never routes
    // through the date-only fmtDate.
    assert.ok(!source.includes("fmtApptDate(client.client_since"));
    assert.ok(!source.includes("fmtDate(nextAppt.scheduled_for"));
  });

  test("past/future classification (pastCompletedCount/nextAppt selection) remains a pure instant comparison on bare new Date(), unaffected by the display-formatter fix", () => {
    assert.ok(source.includes("const now = new Date();"));
  });
});
