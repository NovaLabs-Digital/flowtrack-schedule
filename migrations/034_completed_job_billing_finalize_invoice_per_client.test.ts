// Static, source-level proof that migration 034 (PHASE 2/finalization of
// the two-phase same-client-invoice rollout -- see migration 033 for PHASE
// 1) correctly finishes the job: enforces client_id NOT NULL and swaps the
// old UNIQUE invoice-number index for a non-unique one of the identical
// shape, without touching upsert_completed_job_billing itself. Same
// "prove it from source" discipline as migrations 032/033's own tests.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(
  fileURLToPath(new URL("./034_completed_job_billing_finalize_invoice_per_client.sql", import.meta.url)),
  "utf8"
);
// Same scoping technique as migration 033's test: strip `--`-comment lines
// before running structural checks, since the header comment explains
// things (DROP INDEX / CREATE UNIQUE INDEX in the rollback note) that would
// otherwise false-positive a naive whole-file substring check.
const codeSql = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const upperCodeSql = codeSql.toUpperCase();

describe("migration 034 (PHASE 2) -- finalizes client_id NOT NULL and the non-unique invoice index", () => {
  test("wrapped in an explicit transaction", () => {
    assert.ok(/^BEGIN;/m.test(sql));
    assert.ok(/COMMIT;\s*$/m.test(sql.trim() + "\n"));
  });

  test("contains no DROP TABLE/DROP COLUMN/TRUNCATE statement, and no unguarded DELETE FROM", () => {
    for (const forbidden of ["DROP TABLE", "DROP COLUMN", "TRUNCATE", "DELETE FROM"]) {
      assert.ok(!upperCodeSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("introduces no new PostgreSQL extension, exclusion constraint, standalone trigger, or new CREATE OR REPLACE FUNCTION -- this file only finalizes what migration 033 already built", () => {
    for (const forbidden of ["CREATE EXTENSION", "EXCLUDE USING", "CREATE TRIGGER", "CREATE OR REPLACE FUNCTION", "CREATE FUNCTION"]) {
      assert.ok(!upperCodeSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("re-runs the client_id backfill before enforcing NOT NULL, guarded identically to migration 033's own backfill", () => {
    assert.ok(sql.includes("SET client_id = a.client_id"), "expected the same backfill shape as migration 033");
    assert.ok(sql.includes("WHERE a.id = cjb.appointment_id"));
    assert.ok(sql.includes("AND cjb.client_id IS NULL"));
  });

  test("explicitly guards against any remaining NULL client_id with a named, readable exception BEFORE the ALTER -- not just relying on the ALTER's own generic error", () => {
    const guardIndex = codeSql.indexOf("RAISE EXCEPTION 'completed_job_billing_finalize_null_client_id");
    const alterIndex = codeSql.indexOf("ALTER COLUMN client_id SET NOT NULL");
    assert.ok(guardIndex >= 0, "expected a named guard exception");
    assert.ok(alterIndex >= 0, "expected the SET NOT NULL statement");
    assert.ok(guardIndex < alterIndex, "the guard must run BEFORE the ALTER, not after");
  });

  test("the backfill UPDATE runs before the NULL guard, which runs before SET NOT NULL -- correct order, not just correct presence", () => {
    const backfillIndex = codeSql.indexOf("SET client_id = a.client_id");
    const guardIndex = codeSql.indexOf("v_null_count");
    const alterIndex = codeSql.indexOf("ALTER COLUMN client_id SET NOT NULL");
    assert.ok(backfillIndex >= 0 && guardIndex >= 0 && alterIndex >= 0);
    assert.ok(backfillIndex < guardIndex && guardIndex < alterIndex);
  });

  test("the only ALTER TABLE statement sets client_id NOT NULL on completed_job_billing -- nothing else is altered", () => {
    const alterMatches = [...codeSql.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(new Set(alterMatches), new Set(["completed_job_billing"]));
    assert.ok(/ALTER TABLE completed_job_billing\s+ALTER COLUMN client_id SET NOT NULL;/.test(sql));
  });

  test("drops the old per-workspace UNIQUE invoice-number index and replaces it, under the same name, with a NON-unique index of the identical shape", () => {
    assert.ok(sql.includes("DROP INDEX IF EXISTS idx_completed_job_billing_workspace_invoice_number;"));
    const createIndexMatch = sql.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS idx_completed_job_billing_workspace_invoice_number[\s\S]*?;/);
    assert.ok(createIndexMatch, "expected a replacement CREATE INDEX for the same name");
    assert.equal(createIndexMatch![1], undefined, "the replacement index must NOT be UNIQUE -- see migration 033's header comment on why uniqueness cannot express the same-client-ok/different-client-rejected rule");
    assert.ok(createIndexMatch![0].includes("ON completed_job_billing(workspace_id, invoice_number)"));
    assert.ok(createIndexMatch![0].includes("WHERE invoice_number IS NOT NULL"));
  });

  test("the index swap happens AFTER SET NOT NULL in file order (order doesn't matter functionally, but this documents the intended final sequence)", () => {
    const alterIndex = codeSql.indexOf("ALTER COLUMN client_id SET NOT NULL");
    const dropIndexIndex = codeSql.indexOf("DROP INDEX IF EXISTS idx_completed_job_billing_workspace_invoice_number");
    assert.ok(alterIndex >= 0 && dropIndexIndex >= 0);
    assert.ok(alterIndex < dropIndexIndex);
  });

  test("every re-runnable statement is guarded (IF NOT EXISTS / IF EXISTS) so a second run is a safe no-op", () => {
    assert.ok(sql.includes("DROP INDEX IF EXISTS idx_completed_job_billing_workspace_invoice_number"));
    assert.ok(sql.includes("CREATE INDEX IF NOT EXISTS idx_completed_job_billing_workspace_invoice_number"));
  });

  test("the header explicitly states the required pre-conditions (migration 033 applied, new app code already deployed) before this file may run", () => {
    assert.ok(sql.includes("DO NOT APPLY THIS MIGRATION UNTIL BOTH OF THE FOLLOWING ARE TRUE"));
    assert.ok(sql.toLowerCase().includes("migration 033"));
  });
});
