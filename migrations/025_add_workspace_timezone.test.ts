// Phase 5B (Workspace Time Zone Foundation): static, source-level proof
// that migration 025 is additive and non-destructive. Migrations are never
// executed by this test suite (no database is reachable from tests
// anywhere in this repository) -- this file proves the SQL text itself
// contains no destructive statement, matching the same "prove it from
// source" discipline as migrations 023's and 024's own tests.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./025_add_workspace_timezone.sql", import.meta.url)), "utf8");
const upperSql = sql.toUpperCase();

describe("migration 025 -- additive and non-destructive", () => {
  test("contains no DROP/DELETE/TRUNCATE/UPDATE statement", () => {
    for (const forbidden of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE", "UPDATE COMPANY_SETTINGS", "UPDATE APPOINTMENTS"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("adds exactly one column, guarded with IF NOT EXISTS, nullable text with no default", () => {
    const addColumnLines = sql.split("\n").filter((l) => l.trim().startsWith("ALTER TABLE") && l.includes("ADD COLUMN IF NOT EXISTS"));
    assert.equal(addColumnLines.length, 1);
    assert.ok(addColumnLines[0].includes("timezone text"));
    assert.ok(!/\bNOT NULL\b/i.test(addColumnLines[0]), "must not be NOT NULL");
    assert.ok(!/\bDEFAULT\b/i.test(addColumnLines[0]), "must not have a DEFAULT");
    assert.ok(!upperSql.includes("ALTER COLUMN"), "must not modify an existing column's type/default/constraint");
  });

  test("touches only the company_settings table -- no other table is referenced by name", () => {
    const alterMatches = [...sql.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(new Set(alterMatches), new Set(["company_settings"]));
  });

  test("no CHECK constraint or allowlist is added in SQL -- validation is documented as application-level", () => {
    assert.ok(!upperSql.includes("ADD CONSTRAINT"));
    assert.ok(!upperSql.includes("CHECK ("));
    assert.ok(/validated in application code/i.test(sql));
    assert.ok(sql.includes("lib/timezone.ts"));
  });

  test("no appointment timestamp is touched or rewritten -- no reference to scheduled_for, scheduled_end, or the appointments table", () => {
    for (const forbidden of ["scheduled_for", "scheduled_end", "appointments"]) {
      assert.ok(!sql.toLowerCase().includes(forbidden), `must not reference "${forbidden}"`);
    }
  });

  test("no real SQL statement touches business_hours, repeat_months, price_cents, or team_color (the header comment legitimately cites business_hours' migration 024 by name, matching migration 024's own precedent of citing repeat_months' migration 023)", () => {
    const realStatements = sql.split("\n").filter((l) => l.trim().startsWith("ALTER TABLE") || l.trim().startsWith("ADD CONSTRAINT") || l.trim().startsWith("CHECK"));
    for (const line of realStatements) {
      for (const forbidden of ["business_hours", "repeat_months", "price_cents", "team_color"]) {
        assert.ok(!line.includes(forbidden), `no real SQL statement may reference "${forbidden}": "${line}"`);
      }
    }
  });

  test("no index, RLS, or policy statement is added", () => {
    for (const forbidden of ["CREATE INDEX", "CREATE UNIQUE INDEX", "ENABLE ROW LEVEL SECURITY", "CREATE POLICY", "DO $$"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("documents that the column is not backfilled for any existing row", () => {
    assert.ok(/no backfill/i.test(sql) || /None\./.test(sql));
    assert.ok(/every existing company_settings row simply has timezone = ?NULL/i.test(sql));
  });

  test("documents the NULL fallback matches the existing effective America/New_York default", () => {
    assert.ok(sql.includes("America/New_York"));
    assert.ok(/does not change any existing\s+workspace's scheduling\/display behavior/i.test(sql));
  });

  test("documents that this is a foundation-only migration -- not yet wired into scheduling-critical consumers", () => {
    assert.ok(/foundation only/i.test(sql));
    assert.ok(/no observable effect on scheduling/i.test(sql));
  });
});
