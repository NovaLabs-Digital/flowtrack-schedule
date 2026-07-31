// Phase 5.7D-R17B: source-level regression test for the exact production
// defect -- app/dashboard/page.tsx runs its own server-side services query,
// completely independent from app/api/services/route.ts (which
// ServicesPanel.tsx uses via fetch). Migration 020 added
// services.default_price_cents, and the API route's SELECT was updated to
// include it, but this separate query -- the one that actually populates
// AppointmentModal's `services` prop via DashboardShell -- was missed. The
// result: ServicesPanel correctly showed/stored a service's price, but the
// appointment create/edit form's Price field never received it at all,
// regardless of otherwise-correct downstream service-selection logic. This
// file is a .tsx-adjacent server component and cannot be rendered by this
// repo's test runner (Node's built-in runner has no .tsx/JSX loader) --
// proven via source inspection, matching the established convention.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");

describe("app/dashboard/page.tsx -- services query includes default_price_cents (Phase 5.7D-R17B regression)", () => {
  test("the services SELECT string includes default_price_cents", () => {
    const selectMatch = source.match(/\.from\("services"\)\s*\n\s*\.select\("([^"]*)"\)/);
    assert.ok(selectMatch, "expected to find the services .from(...).select(...) call");
    assert.ok(
      selectMatch![1].includes("default_price_cents"),
      `services SELECT list is missing default_price_cents: "${selectMatch![1]}"`
    );
  });

  test("the services SELECT still includes every previously-selected column -- this fix is additive, not a replacement", () => {
    const selectMatch = source.match(/\.from\("services"\)\s*\n\s*\.select\("([^"]*)"\)/);
    for (const col of ["id", "name", "description", "duration_minutes", "active", "color"]) {
      assert.ok(selectMatch![1].includes(col), `must still select "${col}"`);
    }
  });
});
