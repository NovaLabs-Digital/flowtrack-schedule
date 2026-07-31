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

// Phase 5.7D-R17B follow-up: the services fix alone was incomplete. The
// price was correctly saved by app/api/appointments/create/route.ts, but
// reopening that same appointment showed a blank Price field, because
// apptFields (the primary appointments SELECT this file uses, feeding
// AppointmentModal's `editing.appointment` on Edit) also never included
// price_cents -- the exact same class of bug, in the same file, one query
// over. Confirmed against real production data (create correctly proposed
// $200.00; reopening the saved appointment showed blank) before this fix.
describe("app/dashboard/page.tsx -- primary appointments query includes price_cents (Phase 5.7D-R17B follow-up)", () => {
  test("apptFields' primary (non-fallback) value includes price_cents", () => {
    const fieldsMatch = source.match(/let apptFields = "([^"]*)";/);
    assert.ok(fieldsMatch, "expected to find the apptFields primary field-list declaration");
    assert.ok(
      fieldsMatch![1].includes("price_cents"),
      `apptFields is missing price_cents: "${fieldsMatch![1]}"`
    );
  });

  test("apptFields still includes every previously-selected column -- additive, not a replacement", () => {
    const fieldsMatch = source.match(/let apptFields = "([^"]*)";/);
    for (const col of [
      "id", "client_id", "service_type", "scheduled_for", "status", "notes",
      "duration_minutes", "scheduled_end", "series_id", "frequency_type",
      "repeat_weeks", "employee_id", "actual_started_at", "actual_completed_at",
    ]) {
      assert.ok(fieldsMatch![1].includes(col), `must still select "${col}"`);
    }
  });

  test("the minimal fallback field list (used only when the primary query errors) is deliberately left unchanged -- it never included duration_minutes/scheduled_end/etc. either", () => {
    const fallbackMatch = source.match(/apptFields = "([^"]*)";\s*\n\s*apptsRes = await fetchAllPages/);
    assert.ok(fallbackMatch);
    assert.ok(!fallbackMatch![1].includes("price_cents"));
    assert.ok(!fallbackMatch![1].includes("duration_minutes"));
  });
});

// Phase 5.7D-R18: this file's own established defect pattern (see the two
// describe blocks above) is exactly why this dedicated query is a source-
// level, tested requirement, not an assumption -- app/dashboard/page.tsx's
// independent server-side queries are the one place R17B was missed twice.
// appointment_employees is the authoritative multi-employee assignment
// source (migrations/021); DashboardShell/AppointmentModal/ScheduleGrid/
// DispatchPanel all need every workspace assignment row, not just the ones
// belonging to whichever appointment happens to be selected.
describe("app/dashboard/page.tsx -- fetches appointment_employees assignments, workspace-scoped (Phase 5.7D-R18)", () => {
  test("queries appointment_employees selecting id, appointment_id, employee_id, and both tracking timestamps", () => {
    const selectMatch = source.match(/\.from\("appointment_employees"\)\s*\n\s*\.select\("([^"]*)"\)/);
    assert.ok(selectMatch, "expected to find the appointment_employees .from(...).select(...) call");
    for (const col of ["id", "appointment_id", "employee_id", "actual_started_at", "actual_completed_at"]) {
      assert.ok(selectMatch![1].includes(col), `must select "${col}"`);
    }
  });

  test("the assignments query is scoped by workspace_id, matching every other business-data query in this file", () => {
    const block = source.match(/\.from\("appointment_employees"\)[\s\S]*?;/);
    assert.ok(block);
    assert.ok(block![0].includes('.eq("workspace_id", workspaceId)'));
  });

  test("a missing/erroring appointment_employees table degrades to an empty list, not a hard failure -- same optional-existence pattern as services/employees/employeeHours", () => {
    const block = source.match(/let assignments[\s\S]*?catch \{[\s\S]*?\}/);
    assert.ok(block, "expected the assignments fetch to be wrapped in try/catch");
    assert.ok(block![0].includes("let assignments: AppointmentEmployeeAssignment[] = [];"));
  });

  test("assignments is passed to DashboardShell", () => {
    const shellBlock = source.match(/<DashboardShell[\s\S]*?\/>/);
    assert.ok(shellBlock);
    assert.ok(shellBlock![0].includes("assignments={assignments}"));
  });
});
