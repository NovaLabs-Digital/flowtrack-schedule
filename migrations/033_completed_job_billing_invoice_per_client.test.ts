// Static, source-level proof that migration 033 is additive and
// non-destructive -- same "prove it from source" discipline as migration
// 032's own test (see that file's header for why no database is reachable
// from this test suite; real-PostgreSQL verification is run manually,
// per this migration's own header comment).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(
  fileURLToPath(new URL("./033_completed_job_billing_invoice_per_client.sql", import.meta.url)),
  "utf8"
);
// This migration's header comment deliberately explains, in prose, several
// things it does NOT do (DROP COLUMN in the rollback note, CREATE
// EXTENSION/EXCLUDE/trigger as rejected alternatives, the V1-scope column
// names it still doesn't add) -- a naive whole-file substring check would
// false-positive on that explanatory text. Real-statement checks below run
// against `codeSql` (every `--`-comment line stripped), matching migration
// 032's own test file's columnBlockText scoping technique, generalized to a
// migration with no single CREATE TABLE block to scope to instead.
const codeSql = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const upperCodeSql = codeSql.toUpperCase();

describe("migration 033 -- additive and non-destructive", () => {
  test("contains no DROP TABLE/DROP COLUMN/DELETE FROM/TRUNCATE/ALTER COLUMN statement", () => {
    for (const forbidden of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE", "ALTER COLUMN"]) {
      assert.ok(!upperCodeSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("introduces no new PostgreSQL extension or exclusion/trigger-based enforcement -- cross-client validation is deliberately application-layer only (see header comment)", () => {
    for (const forbidden of ["CREATE EXTENSION", "EXCLUDE USING", "CREATE TRIGGER", "CREATE OR REPLACE FUNCTION", "CREATE FUNCTION"]) {
      assert.ok(!upperCodeSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("wrapped in an explicit transaction", () => {
    assert.ok(/^BEGIN;/m.test(sql));
    assert.ok(/COMMIT;\s*$/m.test(sql.trim() + "\n"));
  });

  test("the only ALTER TABLE statement adds client_id to completed_job_billing, guarded by IF NOT EXISTS", () => {
    const alterMatches = [...codeSql.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(alterMatches, ["completed_job_billing"]);
    assert.ok(/ALTER TABLE completed_job_billing\s+ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES clients\(id\) ON DELETE RESTRICT;/.test(sql));
  });

  test("client_id is NOT declared NOT NULL at the database layer (no existing precedent in this schema for backfill-then-SET-NOT-NULL; see header comment)", () => {
    const columnLine = sql.split("\n").find((l) => l.includes("ADD COLUMN IF NOT EXISTS client_id"));
    assert.ok(columnLine);
    assert.ok(!columnLine!.toUpperCase().includes("NOT NULL"));
  });

  test("client_id is never CASCADE on delete, matching every other FK in this schema", () => {
    assert.ok(!upperCodeSql.includes("ON DELETE CASCADE"));
  });

  test("exactly one backfill UPDATE, guarded so it only ever fills a still-NULL client_id -- re-running this file is a safe no-op", () => {
    const updateMatches = [...sql.matchAll(/^UPDATE\s+(\w+)/gim)].map((m) => m[1]);
    assert.deepEqual(updateMatches, ["completed_job_billing"]);
    assert.ok(sql.includes("WHERE a.id = cjb.appointment_id"), "backfill must join on appointment_id");
    assert.ok(sql.includes("AND cjb.client_id IS NULL"), "backfill must only touch still-unset rows");
  });

  test("no INSERT or DELETE statement at all -- no row is created or removed, only an existing column filled and an index replaced", () => {
    assert.ok(!upperCodeSql.includes("INSERT INTO"));
    assert.ok(!upperCodeSql.includes("DELETE FROM"));
  });

  test("drops the old per-workspace UNIQUE invoice-number index and replaces it, under the same name, with a NON-unique index of the identical shape", () => {
    assert.ok(sql.includes("DROP INDEX IF EXISTS idx_completed_job_billing_workspace_invoice_number;"));
    const createIndexMatch = sql.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS idx_completed_job_billing_workspace_invoice_number[\s\S]*?;/);
    assert.ok(createIndexMatch, "expected a replacement CREATE INDEX for the same name");
    assert.equal(createIndexMatch![1], undefined, "the replacement index must NOT be UNIQUE -- see header comment on why uniqueness cannot express the same-client-ok/different-client-rejected rule");
    assert.ok(createIndexMatch![0].includes("ON completed_job_billing(workspace_id, invoice_number)"));
    assert.ok(createIndexMatch![0].includes("WHERE invoice_number IS NOT NULL"));
  });

  test("every statement that touches existing schema objects is guarded for safe re-runnability (IF NOT EXISTS / IF EXISTS)", () => {
    assert.ok(sql.includes("ADD COLUMN IF NOT EXISTS client_id"));
    assert.ok(sql.includes("DROP INDEX IF EXISTS idx_completed_job_billing_workspace_invoice_number"));
    assert.ok(sql.includes("CREATE INDEX IF NOT EXISTS idx_completed_job_billing_workspace_invoice_number"));
  });

  test("adds no quickbooks_invoice_id / external_payment_id / reconciled_at column -- scope stays exactly migration 032's own V1 boundary", () => {
    for (const forbidden of ["quickbooks_invoice_id", "external_payment_id", "reconciled_at"]) {
      assert.ok(!codeSql.includes(forbidden), `must not introduce speculative column "${forbidden}"`);
    }
  });
});
