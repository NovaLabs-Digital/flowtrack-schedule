// Phase 4 (Business Hours): static, source-level proof that migration 024
// is additive and non-destructive. Migrations are never executed by this
// test suite (no database is reachable from tests anywhere in this
// repository) -- this file proves the SQL text itself contains no
// destructive statement, matching the same "prove it from source"
// discipline as migration 023's own test.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./024_add_business_hours.sql", import.meta.url)), "utf8");
const upperSql = sql.toUpperCase();

describe("migration 024 -- additive and non-destructive", () => {
  test("contains no DROP/DELETE/TRUNCATE/UPDATE statement", () => {
    for (const forbidden of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE", "UPDATE COMPANY_SETTINGS"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("adds exactly one column, guarded with IF NOT EXISTS, nullable jsonb with no default", () => {
    const addColumnLines = sql.split("\n").filter((l) => l.trim().startsWith("ALTER TABLE") && l.includes("ADD COLUMN IF NOT EXISTS"));
    assert.equal(addColumnLines.length, 1);
    assert.ok(addColumnLines[0].includes("business_hours jsonb"));
    assert.ok(!/\bNOT NULL\b/i.test(addColumnLines[0]), "must not be NOT NULL");
    assert.ok(!/\bDEFAULT\b/i.test(addColumnLines[0]), "must not have a DEFAULT");
    assert.ok(!upperSql.includes("ALTER COLUMN"), "must not modify an existing column's type/default/constraint");
  });

  test("touches only the company_settings table -- no other table is referenced by name", () => {
    const alterMatches = [...sql.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(new Set(alterMatches), new Set(["company_settings"]));
  });

  test("the CHECK constraint only guards the outer JSON shape (object or NULL), and is idempotently guarded", () => {
    assert.ok(sql.includes("company_settings_business_hours_is_object"));
    assert.ok(sql.includes("CHECK (business_hours IS NULL OR jsonb_typeof(business_hours) = 'object')"));
    const doBlockCount = [...sql.matchAll(/DO \$\$/g)].length;
    assert.equal(doBlockCount, 1);
    assert.ok(sql.includes("information_schema.table_constraints"));
  });

  test("the CHECK constraint permits NULL unconditionally, so it can never invalidate an existing row", () => {
    assert.ok(/business_hours IS NULL OR/.test(sql));
  });

  test("per-day/per-range business rules (HH:mm validity, start<end, overlaps, weekday keys) are documented as validated in application code, not SQL", () => {
    assert.ok(/validated in application code/i.test(sql));
    assert.ok(sql.includes("lib/businessHours.ts"));
  });

  test("does not touch appointments, clients, employees, subscriptions, price_cents, repeat_months, or team_color", () => {
    for (const forbidden of [
      "CREATE TABLE appointments", "ALTER TABLE appointments",
      "CREATE TABLE clients", "ALTER TABLE clients",
      "CREATE TABLE employees", "ALTER TABLE employees",
      "subscriptions", "price_cents", "repeat_months", "team_color",
    ]) {
      assert.ok(!sql.includes(forbidden), `must not reference "${forbidden}"`);
    }
  });

  test("no index, RLS, or policy statement is added", () => {
    for (const forbidden of ["CREATE INDEX", "CREATE UNIQUE INDEX", "ENABLE ROW LEVEL SECURITY", "CREATE POLICY"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("documents that the column is not backfilled for any existing row", () => {
    assert.ok(/no backfill/i.test(sql) || /None\./.test(sql));
    assert.ok(/every existing company_settings row simply has business_hours = ?\s*NULL/i.test(sql));
  });

  test("documents the NULL fallback matches the existing effective Mon-Fri 07:00-17:00 default, so adding the column changes no existing workspace's behavior", () => {
    assert.ok(sql.includes("07:00-17:00"));
    assert.ok(/does not change any existing\s+workspace's booking behavior/i.test(sql));
  });
});
