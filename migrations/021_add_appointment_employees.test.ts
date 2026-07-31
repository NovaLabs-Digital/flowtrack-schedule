// Phase 5.7D-R18: static, source-level proof that migration 021 is additive
// and non-destructive. Migrations are never executed by this test suite (no
// database is reachable from tests anywhere in this repository) -- this
// file proves the SQL text itself contains no destructive statement,
// matching the same "prove it from source" discipline as migrations 016 and
// 020's own tests.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./021_add_appointment_employees.sql", import.meta.url)), "utf8");
const upperSql = sql.toUpperCase();

describe("migration 021 -- additive and non-destructive", () => {
  test("contains no DROP/DELETE/TRUNCATE/ALTER COLUMN statement", () => {
    for (const forbidden of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE", "ALTER COLUMN"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("creates exactly one new table, guarded with IF NOT EXISTS", () => {
    const createMatches = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(createMatches, ["appointment_employees"]);
    assert.ok(!upperSql.includes("CREATE TABLE APPOINTMENT_EMPLOYEES (") || upperSql.includes("CREATE TABLE IF NOT EXISTS APPOINTMENT_EMPLOYEES"));
  });

  test("no existing table is touched by ALTER TABLE -- only the new table (RLS enable) and nothing else", () => {
    const alterMatches = [...sql.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(new Set(alterMatches), new Set(["appointment_employees"]));
  });

  test("appointment_id and employee_id are NOT NULL FKs; workspace_id is a NOT NULL FK to workspaces", () => {
    assert.ok(/appointment_id\s+UUID NOT NULL REFERENCES appointments\(id\) ON DELETE CASCADE/.test(sql));
    assert.ok(/employee_id\s+UUID NOT NULL REFERENCES employees\(id\)/.test(sql));
    assert.ok(/workspace_id\s+UUID NOT NULL REFERENCES workspaces\(id\) ON DELETE RESTRICT/.test(sql));
  });

  test("employee_id has no ON DELETE CASCADE -- deleting an employee must never silently erase assignment/tracking history", () => {
    const employeeIdLine = sql.split("\n").find((l) => l.trim().startsWith("employee_id") && l.includes("REFERENCES employees"));
    assert.ok(employeeIdLine, "expected to find the employee_id column definition");
    assert.ok(!employeeIdLine!.includes("ON DELETE CASCADE"), `employee_id FK must not cascade-delete: ${employeeIdLine}`);
  });

  test("duplicate (appointment_id, employee_id) pairs are rejected at the database layer via a UNIQUE index", () => {
    assert.ok(sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS idx_appointment_employees_unique"));
    assert.ok(sql.includes("ON appointment_employees(appointment_id, employee_id)"));
  });

  test("has per-assignment actual_started_at/actual_completed_at tracking columns, both nullable", () => {
    assert.ok(/actual_started_at\s+TIMESTAMPTZ,/.test(sql));
    assert.ok(/actual_completed_at\s+TIMESTAMPTZ,/.test(sql));
    // Neither is NOT NULL -- an assignment starts with both null (not yet worked).
    const startedLine = sql.split("\n").find((l) => l.includes("actual_started_at") && l.includes("TIMESTAMPTZ"));
    const completedLine = sql.split("\n").find((l) => l.includes("actual_completed_at") && l.includes("TIMESTAMPTZ"));
    assert.ok(!startedLine!.toUpperCase().includes("NOT NULL"));
    assert.ok(!completedLine!.toUpperCase().includes("NOT NULL"));
  });

  test("RLS is enabled on the new table at creation time, matching the deny-all-for-anon convention, and no policy is added", () => {
    assert.ok(sql.includes("ALTER TABLE appointment_employees ENABLE ROW LEVEL SECURITY;"));
    assert.ok(!upperSql.includes("CREATE POLICY"));
  });

  test("no existing appointments/employees/appointment_employee_hours row is deleted or overwritten -- the only DML is the additive, guarded backfill INSERT", () => {
    assert.ok(!upperSql.includes("UPDATE APPOINTMENTS"));
    assert.ok(!upperSql.includes("UPDATE EMPLOYEES"));
    const insertMatches = [...sql.matchAll(/INSERT INTO\s+(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(insertMatches, ["appointment_employees"]);
  });

  test("the backfill INSERT only targets appointments with a non-null employee_id, carrying its own historical timestamps forward unchanged", () => {
    const backfillMatch = sql.match(/INSERT INTO appointment_employees[\s\S]*?;/);
    assert.ok(backfillMatch, "expected to find the backfill INSERT statement");
    const backfillSql = backfillMatch![0];
    assert.ok(backfillSql.includes("WHERE a.employee_id IS NOT NULL"));
    assert.ok(backfillSql.includes("a.actual_started_at, a.actual_completed_at"));
    // Not derived, invented, or defaulted -- the exact same column values, straight from the source row.
    assert.ok(!/NOW\(\)/.test(backfillSql));
  });

  test("the backfill INSERT is idempotent -- guarded by a NOT EXISTS check against the new table itself", () => {
    const backfillMatch = sql.match(/INSERT INTO appointment_employees[\s\S]*?;/);
    assert.ok(backfillMatch![0].includes("NOT EXISTS"));
    assert.ok(backfillMatch![0].includes("ae.appointment_id = a.id AND ae.employee_id = a.employee_id"));
  });

  test("documents that appointments.employee_id/actual_started_at/actual_completed_at are preserved untouched, not dropped or rewritten by this migration", () => {
    assert.ok(/NOT dropped, renamed, or altered/i.test(sql));
    const normalized = sql.replace(/\n--\s*/g, " ");
    assert.ok(/does not clear, rewrite, or normalize a single existing timestamp/i.test(normalized));
  });

  test("no CASCADE anywhere except the deliberate appointment_id -> appointments ON DELETE CASCADE (deleting the appointment itself deletes its own assignment rows, never the reverse)", () => {
    const cascadeMatches = [...upperSql.matchAll(/ON DELETE CASCADE/g)];
    assert.equal(cascadeMatches.length, 1);
  });
});
