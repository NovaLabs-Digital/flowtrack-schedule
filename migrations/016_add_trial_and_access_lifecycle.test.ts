// Phase 5.6F: static, source-level proof that migration 016 is additive and
// non-destructive. Migrations are never executed by this test suite (no
// database is reachable from tests anywhere in this repository) -- this
// file proves the SQL text itself contains no destructive statement,
// matching the same "prove it from source" discipline already used for the
// .ts files this project's other tests can't execute directly.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./016_add_trial_and_access_lifecycle.sql", import.meta.url)), "utf8");
const upperSql = sql.toUpperCase();

describe("migration 016 -- additive and non-destructive", () => {
  test("contains no DROP/DELETE/TRUNCATE statement", () => {
    for (const forbidden of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("only ADD COLUMN statements are used, both guarded with IF NOT EXISTS", () => {
    assert.ok(sql.includes("ADD COLUMN IF NOT EXISTS trial_consumed_at"));
    assert.ok(sql.includes("ADD COLUMN IF NOT EXISTS access_ended_at"));
    assert.ok(!upperSql.includes("ALTER COLUMN"), "must not modify an existing column's type/default/constraint");
  });

  test("both new columns are nullable -- no NOT NULL, no DEFAULT forcing a value onto every existing row", () => {
    assert.ok(!/trial_consumed_at\s+timestamptz\s+NOT\s+NULL/i.test(sql));
    assert.ok(!/access_ended_at\s+timestamptz\s+NOT\s+NULL/i.test(sql));
    assert.ok(!/trial_consumed_at[^,\n]*DEFAULT/i.test(sql));
    assert.ok(!/access_ended_at[^,\n]*DEFAULT/i.test(sql));
  });

  test("touches only the subscriptions table -- no other table is referenced by name", () => {
    const alterMatches = [...sql.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(new Set(alterMatches), new Set(["subscriptions"]));
  });

  test("contains no explicit backfill UPDATE statement -- both columns are left null for every existing row", () => {
    assert.ok(!upperSql.includes("UPDATE SUBSCRIPTIONS"));
    assert.ok(!upperSql.includes("UPDATE \"SUBSCRIPTIONS\""));
  });

  test("contains no new constraint, index, or RLS policy change", () => {
    for (const forbidden of ["CREATE INDEX", "CREATE UNIQUE INDEX", "ADD CONSTRAINT", "ENABLE ROW LEVEL SECURITY", "CREATE POLICY"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("documents the backfill decision (no guessed history) directly in the file", () => {
    assert.ok(sql.includes("intentionally NOT backfilled"));
  });

  test("Phase 5.6F-R1: does not claim access_ended_at can only ever be written by a webhook -- reconciliation's documented fallback path must not be described as impossible", () => {
    assert.ok(!sql.includes("never invented by the reconciliation"));
    assert.ok(!/only ever written\s+by a real stripe webhook/i.test(sql));
  });

  test("Phase 5.6F-R1: documents the reconciliation fallback and its bounded read-only extension trade-off", () => {
    assert.ok(sql.includes("reconciliation cron"));
    assert.ok(sql.includes("first observes the"));
    assert.ok(sql.includes("additional read-only access"));
  });
});
