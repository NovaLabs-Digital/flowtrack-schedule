// Phase 2 (Monthly Recurring Appointments): static, source-level proof that
// migration 023 is additive and non-destructive. Migrations are never
// executed by this test suite (no database is reachable from tests
// anywhere in this repository) -- this file proves the SQL text itself
// contains no destructive statement, matching the same "prove it from
// source" discipline as migration 020's, 021's, and 022's own tests.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./023_add_repeat_months.sql", import.meta.url)), "utf8");
const upperSql = sql.toUpperCase();

describe("migration 023 -- additive and non-destructive", () => {
  test("contains no DROP/DELETE/TRUNCATE/UPDATE statement", () => {
    for (const forbidden of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE", "UPDATE APPOINTMENTS"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("adds exactly one column, guarded with IF NOT EXISTS, nullable integer with no default", () => {
    const addColumnLines = sql.split("\n").filter((l) => l.trim().startsWith("ALTER TABLE") && l.includes("ADD COLUMN IF NOT EXISTS"));
    assert.equal(addColumnLines.length, 1);
    assert.ok(addColumnLines[0].includes("repeat_months integer"));
    assert.ok(!/\bNOT NULL\b/i.test(addColumnLines[0]), "must not be NOT NULL");
    assert.ok(!/\bDEFAULT\b/i.test(addColumnLines[0]), "must not have a DEFAULT");
    assert.ok(!upperSql.includes("ALTER COLUMN"), "must not modify an existing column's type/default/constraint");
  });

  test("touches only the appointments table -- no other table is referenced by name", () => {
    const alterMatches = [...sql.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(new Set(alterMatches), new Set(["appointments"]));
  });

  test("no real SQL statement touches or redefines repeat_weeks -- monthly recurrence is additive, never layered onto the existing weekly column (the header comment legitimately mentions it once, by name, to explain why)", () => {
    const realStatements = sql.split("\n").filter((l) => l.trim().startsWith("ALTER TABLE") || l.trim().startsWith("ADD CONSTRAINT") || l.trim().startsWith("CHECK"));
    for (const line of realStatements) {
      assert.ok(!line.includes("repeat_weeks"), `no real SQL statement may reference repeat_weeks: "${line}"`);
    }
  });

  test("the CHECK constraint permits NULL or an integer 1-12, and is idempotently guarded", () => {
    assert.ok(sql.includes("appointments_repeat_months_range"));
    assert.ok(sql.includes("CHECK (repeat_months IS NULL OR (repeat_months >= 1 AND repeat_months <= 12))"));
    const doBlockCount = [...sql.matchAll(/DO \$\$/g)].length;
    assert.equal(doBlockCount, 1);
    assert.ok(sql.includes("information_schema.table_constraints"));
  });

  test("the CHECK constraint permits NULL unconditionally, so it can never invalidate an existing row", () => {
    assert.ok(/repeat_months IS NULL OR/.test(sql));
  });

  test("does not touch appointment_employees, appointment_employee_hours, employee_id, timestamps, subscriptions, price_cents, team_color, or clients", () => {
    for (const forbidden of [
      "appointment_employees", "appointment_employee_hours", "employee_id", "actual_started_at",
      "actual_completed_at", "subscriptions", "CREATE TABLE clients", "ALTER TABLE clients",
    ]) {
      assert.ok(!sql.includes(forbidden), `must not reference "${forbidden}"`);
    }
    const alterStatements = sql.split("\n").filter((l) => l.trim().startsWith("ALTER TABLE") || l.trim().startsWith("ADD CONSTRAINT") || l.trim().startsWith("CHECK"));
    for (const line of alterStatements) {
      assert.ok(!line.includes("price_cents"), `no real SQL statement may reference price_cents: "${line}"`);
      assert.ok(!line.includes("team_color"), `no real SQL statement may reference team_color: "${line}"`);
    }
  });

  test("no index, RLS, or policy statement is added", () => {
    for (const forbidden of ["CREATE INDEX", "CREATE UNIQUE INDEX", "ENABLE ROW LEVEL SECURITY", "CREATE POLICY"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("documents that the column is not backfilled for any existing row", () => {
    assert.ok(/no backfill/i.test(sql) || /None\./.test(sql));
    assert.ok(/every existing appointment simply has repeat_months = NULL/i.test(sql));
  });
});
