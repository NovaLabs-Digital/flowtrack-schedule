// Phase 5.7D-R17: static, source-level proof that migration 020 is additive
// and non-destructive. Migrations are never executed by this test suite (no
// database is reachable from tests anywhere in this repository) -- this
// file proves the SQL text itself contains no destructive statement,
// matching the same "prove it from source" discipline as migration 016's
// own test.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./020_add_service_and_appointment_pricing.sql", import.meta.url)), "utf8");
const upperSql = sql.toUpperCase();

describe("migration 020 -- additive and non-destructive", () => {
  test("contains no DROP/DELETE/TRUNCATE statement", () => {
    for (const forbidden of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("only ADD COLUMN statements are used, both guarded with IF NOT EXISTS", () => {
    assert.ok(sql.includes("ADD COLUMN IF NOT EXISTS default_price_cents"));
    assert.ok(sql.includes("ADD COLUMN IF NOT EXISTS price_cents"));
    assert.ok(!upperSql.includes("ALTER COLUMN"), "must not modify an existing column's type/default/constraint");
  });

  test("both new columns are integer, nullable -- no NOT NULL, no DEFAULT forcing a value onto every existing row", () => {
    const addColumnLines = sql.split("\n").filter((l) => l.includes("ADD COLUMN IF NOT EXISTS"));
    assert.equal(addColumnLines.length, 2);
    for (const line of addColumnLines) {
      assert.ok(!/\bNOT NULL\b/i.test(line), `must not be NOT NULL: ${line}`);
      assert.ok(!/\bDEFAULT\b/i.test(line), `must not have a DEFAULT: ${line}`);
    }
    assert.ok(addColumnLines.some((l) => l.includes("default_price_cents integer")));
    assert.ok(addColumnLines.some((l) => l.trim().endsWith("price_cents integer;") && !l.includes("default_price_cents")));
  });

  test("touches only services and appointments -- no other table is referenced by name", () => {
    const alterMatches = [...sql.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(new Set(alterMatches), new Set(["services", "appointments"]));
  });

  test("contains no explicit backfill UPDATE statement -- both columns are left null for every existing row", () => {
    assert.ok(!upperSql.includes("UPDATE SERVICES"));
    assert.ok(!upperSql.includes("UPDATE APPOINTMENTS"));
  });

  test("the only new constraints are the two non-negative CHECK guards, both idempotently guarded", () => {
    assert.ok(sql.includes("services_default_price_cents_nonnegative"));
    assert.ok(sql.includes("appointments_price_cents_nonnegative"));
    assert.ok(sql.includes("CHECK (default_price_cents IS NULL OR default_price_cents >= 0)"));
    assert.ok(sql.includes("CHECK (price_cents IS NULL OR price_cents >= 0)"));
    // Idempotent: each ADD CONSTRAINT is wrapped in an information_schema
    // existence check, not a bare statement that would error on a re-run.
    const doBlockCount = [...sql.matchAll(/DO \$\$/g)].length;
    assert.equal(doBlockCount, 2);
    for (const forbidden of ["CREATE INDEX", "CREATE UNIQUE INDEX", "ENABLE ROW LEVEL SECURITY", "CREATE POLICY"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("no foreign key ties appointments.price_cents back to services -- it is an independent snapshot, not a reference", () => {
    assert.ok(!upperSql.includes("REFERENCES SERVICES"));
  });

  test("documents that neither column is backfilled and that changing a service's default never rewrites existing appointments", () => {
    assert.ok(/neither column is backfilled/i.test(sql));
    const normalized = sql.replace(/\n--\s*/g, " ");
    assert.ok(normalized.includes("never rewrites any existing appointment"));
  });
});
