// Phase 5.7D-R18: source-level tests for app/schedule/page.tsx (the
// employee's own mobile schedule). Before this phase, this page queried
// appointments.employee_id directly -- a shared appointment with two or
// more assigned employees would never appear here at all, since
// appointments.employee_id is NULL for anything other than exactly one
// assignment (see lib/appointmentEmployees.ts's deriveLegacyEmployeeId).
// This file proves the page now resolves "which jobs are mine" from
// appointment_employees (the authoritative source), and that each
// appointment's actual_started_at/actual_completed_at is overwritten with
// THIS employee's own assignment timestamps before being handed to
// EmployeeSchedule.tsx -- never the legacy appointment-level (frozen as of
// this phase) columns, and never another assigned employee's. This is a
// server component and cannot be rendered by this repo's test runner (no
// .tsx/JSX loader) -- proven via source inspection, matching the
// established convention (see app/dashboard/page.test.ts).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");

describe("app/schedule/page.tsx -- resolves assigned appointments from appointment_employees, not appointments.employee_id", () => {
  test("queries appointment_employees scoped by this employee's own employee_id and workspace_id", () => {
    const block = source.match(/\.from\("appointment_employees"\)[\s\S]*?;/);
    assert.ok(block, "expected an appointment_employees query");
    assert.ok(block![0].includes('.eq("employee_id", employeeId)'));
    assert.ok(block![0].includes('.eq("workspace_id", workspaceId)'));
  });

  test("the appointments query filters by the assigned appointment IDs (.in), never by .eq(\"employee_id\", employeeId)", () => {
    assert.ok(source.includes('.in("id", chunk)'));
    assert.ok(!source.includes('.eq("employee_id", employeeId)\n      .eq("workspace_id", workspaceId)\n      .eq("status", "scheduled")'), "must not still filter appointments directly by employee_id");
  });

  test("appointment IDs are fetched in bounded chunks, not one unbounded .in() call -- avoids the previously-observed oversized-query-string failure", () => {
    assert.ok(source.includes("APPOINTMENT_ID_CHUNK_SIZE"));
    assert.ok(/for \(let i = 0; i < assignedApptIds\.length; i \+= APPOINTMENT_ID_CHUNK_SIZE\)/.test(source));
  });

  test("each appointment's actual_started_at/actual_completed_at is overwritten from this employee's own assignment, not left as the appointment-level value", () => {
    const mapBlock = source.match(/appts = appts\s*\.map\(\(a\) => \{[\s\S]*?\}\)/);
    assert.ok(mapBlock, "expected the per-appointment overwrite map()");
    assert.ok(mapBlock![0].includes("assignmentByApptId.get(a.id)"));
    assert.ok(mapBlock![0].includes("actual_started_at: mine?.actual_started_at ?? null"));
    assert.ok(mapBlock![0].includes("actual_completed_at: mine?.actual_completed_at ?? null"));
  });

  test("computePayrollRows is called with this employee's own assignments for both this-week and last-week totals", () => {
    const calls = [...source.matchAll(/computePayrollRows\(\{[\s\S]*?\}\)/g)];
    assert.equal(calls.length, 2, "expected exactly two computePayrollRows calls (this week, last week)");
    for (const call of calls) {
      assert.ok(call[0].includes("assignments: myAssignments"));
    }
  });

  test("a failed appointments fetch fails closed to an empty list, never a partial/truncated schedule", () => {
    assert.ok(source.includes("apptsFetchFailed"));
    assert.ok(source.includes("if (apptsFetchFailed) appts = [];"));
  });
});
