// Phase 5.7D-R18 Review Corrections: tests for scripts/seed-demo-data.cjs's
// appointment_employees compatibility. This is a standalone CommonJS dev
// script (not part of the Next.js app bundle), so it's required directly
// via createRequire rather than through the app's own module-alias
// resolution. Requiring it only constructs a @supabase/supabase-js client
// (harmless with fake credentials -- no network call happens at
// construction time); `main()` is guarded by `require.main === module` and
// is never invoked here, so no real Supabase call is reachable from this
// file. Run with --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const seeder = require("./seed-demo-data.cjs");
const source = fs.readFileSync(fileURLToPath(new URL("./seed-demo-data.cjs", import.meta.url)), "utf8");

describe("buildAssignmentRows -- Phase 5.7D-R18 compatibility with the authoritative appointment_employees model", () => {
  test("an appointment with an employee_id gets exactly one matching assignment row", () => {
    const rows = seeder.buildAssignmentRows([
      { id: "appt-1", employee_id: "emp-1", workspace_id: "ws-1", actual_started_at: null, actual_completed_at: null },
    ]);
    assert.deepEqual(rows, [{ appointment_id: "appt-1", employee_id: "emp-1", workspace_id: "ws-1", actual_started_at: null, actual_completed_at: null }]);
  });

  test("an unassigned appointment (employee_id null) produces no row", () => {
    const rows = seeder.buildAssignmentRows([
      { id: "appt-1", employee_id: null, workspace_id: "ws-1", actual_started_at: null, actual_completed_at: null },
    ]);
    assert.deepEqual(rows, []);
  });

  test("a simulated already-completed demo appointment carries its actual_started_at/actual_completed_at onto the assignment row -- never left blank while the appointment shows as done", () => {
    const rows = seeder.buildAssignmentRows([
      { id: "appt-1", employee_id: "emp-1", workspace_id: "ws-1", actual_started_at: "2026-01-01T09:00:00.000Z", actual_completed_at: "2026-01-01T11:00:00.000Z" },
    ]);
    assert.equal(rows[0].actual_started_at, "2026-01-01T09:00:00.000Z");
    assert.equal(rows[0].actual_completed_at, "2026-01-01T11:00:00.000Z");
  });

  test("multiple appointments each get their own row, matched by their own id/employee_id/workspace_id", () => {
    const inserted = [
      { id: "appt-1", employee_id: "emp-1", workspace_id: "ws-1" },
      { id: "appt-2", employee_id: "emp-2", workspace_id: "ws-1" },
      { id: "appt-3", employee_id: null, workspace_id: "ws-1" },
    ];
    const rows = seeder.buildAssignmentRows(inserted);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].appointment_id, "appt-1");
    assert.equal(rows[0].employee_id, "emp-1");
    assert.equal(rows[1].appointment_id, "appt-2");
    assert.equal(rows[1].employee_id, "emp-2");
  });

  test("never produces a duplicate (appointment_id, employee_id) pair, even if the input somehow repeats one", () => {
    const rows = seeder.buildAssignmentRows([
      { id: "appt-1", employee_id: "emp-1", workspace_id: "ws-1" },
      { id: "appt-1", employee_id: "emp-1", workspace_id: "ws-1" },
    ]);
    assert.equal(rows.length, 1);
  });

  test("each row's workspace_id comes from that specific appointment's own real inserted value, never a shared constant", () => {
    const rows = seeder.buildAssignmentRows([
      { id: "appt-1", employee_id: "emp-1", workspace_id: "ws-a" },
      { id: "appt-2", employee_id: "emp-2", workspace_id: "ws-b" },
    ]);
    assert.equal(rows[0].workspace_id, "ws-a");
    assert.equal(rows[1].workspace_id, "ws-b");
  });

  test("never references or writes appointment_employee_hours", () => {
    const fnStart = source.indexOf("function buildAssignmentRows(");
    const fnEnd = source.indexOf("\n}", fnStart);
    const body = source.slice(fnStart, fnEnd);
    assert.ok(!body.includes("appointment_employee_hours"));
  });
});

describe("buildAppointments -- unchanged compatibility-mirror generation", () => {
  test("every generated appointment has exactly one employee_id, drawn from the provided employee pool", () => {
    const employeeIds = ["emp-1", "emp-2", "emp-3"];
    const rows = seeder.buildAppointments(
      ["client-1"],
      [{ name: "Test Service", duration_minutes: 60 }],
      employeeIds
    );
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.ok(typeof r.employee_id === "string");
      assert.ok(employeeIds.includes(r.employee_id));
    }
  });
});

describe("the seeder fails closed, before any insert or delete, when appointment_employees doesn't exist yet", () => {
  test("hasAppointmentEmployeesTable is exported and is the first thing main() checks", () => {
    assert.equal(typeof seeder.hasAppointmentEmployeesTable, "function");
    const mainStart = source.indexOf("async function main() {");
    const firstAwait = source.indexOf("await hasAppointmentEmployeesTable()", mainStart);
    assert.ok(firstAwait > -1, "main() must call hasAppointmentEmployeesTable()");
    // Nothing that reads/writes clients/employees/services/appointments
    // appears between the start of main() and this check.
    const beforeCheck = source.slice(mainStart, firstAwait);
    for (const forbidden of ['.from("clients")', '.from("employees")', '.from("services")', '.from("appointments")', ".delete(", ".insert("]) {
      assert.ok(!beforeCheck.includes(forbidden), `must not touch "${forbidden}" before the table-existence check`);
    }
  });

  test("a missing table exits the process with a non-zero code and a clear message, never a silent partial seed", () => {
    const mainStart = source.indexOf("async function main() {");
    const checkIdx = source.indexOf("if (!tableReady) {", mainStart);
    const exitIdx = source.indexOf("process.exit(1)", checkIdx);
    assert.ok(checkIdx > -1 && exitIdx > -1);
    const block = source.slice(checkIdx, exitIdx);
    assert.ok(block.includes("SEED_ABORTED"));
    assert.ok(/migration 021|migrations\/021/i.test(block));
  });

  test("direct execution is guarded -- requiring this module for its exports never calls main() or touches Supabase", () => {
    assert.ok(source.includes("if (require.main === module) {"));
    assert.ok(source.includes("module.exports = { buildAppointments, buildAssignmentRows, hasAppointmentEmployeesTable };"));
  });
});

describe("reset ordering still safe under the new FK shape (appointment_employees.employee_id has no cascade)", () => {
  test("appointments are deleted before employees in --reset, so cascade-cleared assignment rows never block the employees delete", () => {
    const resetIdx = source.indexOf('console.log("Resetting existing demo rows...");');
    assert.ok(resetIdx > -1);
    const apptDeleteIdx = source.indexOf('supabase.from("appointments").delete()', resetIdx);
    const empDeleteIdx = source.indexOf('supabase.from("employees").delete()', resetIdx);
    assert.ok(apptDeleteIdx > -1 && empDeleteIdx > -1);
    assert.ok(apptDeleteIdx < empDeleteIdx, "appointments must be deleted before employees");
  });
});
