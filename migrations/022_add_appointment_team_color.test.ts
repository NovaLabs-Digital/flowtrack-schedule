// Phase 5.7D-R19: static, source-level proof that migration 022 is additive
// and non-destructive. Migrations are never executed by this test suite (no
// database is reachable from tests anywhere in this repository) -- this
// file proves the SQL text itself contains no destructive statement,
// matching the same "prove it from source" discipline as migration 020's
// and 021's own tests.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./022_add_appointment_team_color.sql", import.meta.url)), "utf8");
const upperSql = sql.toUpperCase();

describe("migration 022 -- additive and non-destructive", () => {
  test("contains no DROP/DELETE/TRUNCATE/UPDATE statement", () => {
    for (const forbidden of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE", "UPDATE APPOINTMENTS"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("adds exactly one column, guarded with IF NOT EXISTS, nullable TEXT with no default", () => {
    // Excludes comment lines (this migration's own prose explains the
    // statement using the same phrase) -- only real SQL statement lines
    // count.
    const addColumnLines = sql.split("\n").filter((l) => l.trim().startsWith("ALTER TABLE") && l.includes("ADD COLUMN IF NOT EXISTS"));
    assert.equal(addColumnLines.length, 1);
    assert.ok(addColumnLines[0].includes("team_color TEXT"));
    assert.ok(!/\bNOT NULL\b/i.test(addColumnLines[0]), "must not be NOT NULL");
    assert.ok(!/\bDEFAULT\b/i.test(addColumnLines[0]), "must not have a DEFAULT");
    assert.ok(!upperSql.includes("ALTER COLUMN"), "must not modify an existing column's type/default/constraint");
  });

  test("touches only the appointments table -- no other table is referenced by name", () => {
    const alterMatches = [...sql.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(new Set(alterMatches), new Set(["appointments"]));
  });

  test("the CHECK constraint permits NULL or a strict #RRGGBB value, and is idempotently guarded", () => {
    assert.ok(sql.includes("appointments_team_color_hex_format"));
    assert.ok(sql.includes("CHECK (team_color IS NULL OR team_color ~ '^#[0-9A-Fa-f]{6}$')"));
    const doBlockCount = [...sql.matchAll(/DO \$\$/g)].length;
    assert.equal(doBlockCount, 1);
    assert.ok(sql.includes("information_schema.table_constraints"));
  });

  test("does not touch appointment_employees, appointment_employee_hours, employee_id, timestamps, subscriptions, or clients", () => {
    // price_cents is deliberately not in this list -- the migration's own
    // doc comment legitimately references it once, by name, purely to
    // explain why team_color can't reuse price_cents' simple fixed-value
    // CHECK pattern (see the migration's header comment). No SQL statement
    // anywhere in this file actually touches that column -- proven
    // separately below by requiring every ALTER TABLE to target only
    // "appointments" and reference only "team_color".
    for (const forbidden of [
      "appointment_employees", "appointment_employee_hours", "employee_id", "actual_started_at",
      "actual_completed_at", "subscriptions", "CREATE TABLE clients", "ALTER TABLE clients",
    ]) {
      assert.ok(!sql.includes(forbidden), `must not reference "${forbidden}"`);
    }
    const alterStatements = sql.split("\n").filter((l) => l.trim().startsWith("ALTER TABLE") || l.trim().startsWith("ADD CONSTRAINT") || l.trim().startsWith("CHECK"));
    for (const line of alterStatements) {
      assert.ok(!line.includes("price_cents"), `no real SQL statement may reference price_cents: "${line}"`);
    }
  });

  test("no index, RLS, or policy statement is added -- team_color needs none of the three", () => {
    for (const forbidden of ["CREATE INDEX", "CREATE UNIQUE INDEX", "ENABLE ROW LEVEL SECURITY", "CREATE POLICY"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("documents that the column is not backfilled for any existing row", () => {
    assert.ok(/no backfill/i.test(sql) || /None\./.test(sql));
    assert.ok(/every existing appointment simply has team_color = NULL/i.test(sql));
  });
});
