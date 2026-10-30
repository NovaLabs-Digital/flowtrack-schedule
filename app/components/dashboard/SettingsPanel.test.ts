// SOURCE INSPECTION, matching DashboardSettingsArea.test.ts's own
// established convention for this component family.
//
// Stage 2 fix: ServicesPanel's own "Delete" action (as opposed to Edit/
// Disable) is gated purely on its isTester prop -- but SettingsPanel never
// forwarded isTester to ANY panel before this change, so a real owner (and
// the browser-local demo, which reuses this exact real owner path per
// DashboardSettingsArea.tsx's isLocalDemo branch) could never reach it.
// Discovered live: the guided tour's "services" step explicitly requires
// creating then deleting a service, which was structurally impossible
// without this fix. isLocalDemo is forwarded ONLY to ServicesPanel --
// never to StaffPanel, whose OWN isTester prop instead HIDES its "+ Add
// Employee" button, the opposite of what the demo's Employees CRUD
// requirement needs.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./SettingsPanel.tsx", import.meta.url)), "utf8");

describe("SettingsPanel: isLocalDemo is forwarded ONLY to ServicesPanel's isTester prop", () => {
  test("isLocalDemo is an optional prop defaulting to false, so the real owner path (which never passes it) is unchanged", () => {
    assert.match(source, /isLocalDemo\?:\s*boolean;/);
    assert.match(source, /isLocalDemo = false,/);
  });

  test("ServicesPanel receives isTester={isLocalDemo}", () => {
    const block = source.match(/if \(section === "services"\) return <ServicesPanel[\s\S]*?\/>;/);
    assert.ok(block, "the services section render line is present");
    assert.match(block![0], /isTester=\{isLocalDemo\}/);
  });

  test("no other panel (CompanyInfoPanel, StaffPanel, ArchivedClientsPanel, RecurringSeriesPanel, BillingPanel) ever receives isTester or isLocalDemo -- especially StaffPanel, whose isTester prop would hide + Add Employee", () => {
    for (const panel of ["CompanyInfoPanel", "StaffPanel", "ArchivedClientsPanel", "RecurringSeriesPanel", "BillingPanel"]) {
      const block = source.match(new RegExp(`<${panel}[\\s\\S]*?\\/>`));
      assert.ok(block, `${panel}'s render line is present`);
      assert.doesNotMatch(block![0], /isTester=|isLocalDemo=/, `${panel} must never receive isTester or isLocalDemo`);
    }
  });
});
