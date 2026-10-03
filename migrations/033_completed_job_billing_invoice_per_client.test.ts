// Static, source-level proof that migration 033 (PHASE 1 of the two-phase
// same-client-invoice rollout -- see migration 034 for PHASE 2) is additive,
// non-destructive, and genuinely backward compatible with the CURRENTLY
// DEPLOYED application -- same "prove it from source" discipline as
// migration 032's own test (see that file's header for why no database is
// reachable from this test suite; real-PostgreSQL verification is run
// manually, per this migration's own header comment).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(
  fileURLToPath(new URL("./033_completed_job_billing_invoice_per_client.sql", import.meta.url)),
  "utf8"
);
// This migration's header comment deliberately explains, in prose, several
// things it does and does NOT do (DROP COLUMN/DROP FUNCTION in the rollback
// note, CREATE EXTENSION/EXCLUDE as rejected alternatives, references to
// "SET NOT NULL" and the old UNIQUE index that only exist to explain why
// THIS file deliberately does NOT do them yet) -- a naive whole-file
// substring check would false-positive on that explanatory text. Real-
// statement checks below run against `codeSql` (every `--`-comment line
// stripped), matching migration 032's own test file's columnBlockText
// scoping technique, generalized to a migration with no single CREATE
// TABLE block to scope to instead.
const codeSql = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");
const upperCodeSql = codeSql.toUpperCase();

// The function body (between its AS $$ ... $$ markers) -- scoped separately
// so statement-shape assertions about the MIGRATION's own top-level DDL
// (e.g. "exactly one ALTER TABLE") aren't confused by statements that only
// exist INSIDE the function body (e.g. its own INSERT/UPDATE), and vice
// versa.
const functionBodyMatch = codeSql.match(/AS \$\$([\s\S]*?)\$\$;/);
const functionBody = functionBodyMatch ? functionBodyMatch[1] : "";

describe("migration 033 (PHASE 1) -- additive, non-destructive, and backward compatible with the currently deployed app", () => {
  test("contains no DROP TABLE/DROP COLUMN/DELETE FROM/TRUNCATE statement", () => {
    for (const forbidden of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE"]) {
      assert.ok(!upperCodeSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("introduces no new PostgreSQL extension, exclusion constraint, or standalone trigger -- the cross-client/sync logic lives inside the write function itself (see header comment)", () => {
    for (const forbidden of ["CREATE EXTENSION", "EXCLUDE USING", "CREATE TRIGGER"]) {
      assert.ok(!upperCodeSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("wrapped in an explicit transaction", () => {
    assert.ok(/^BEGIN;/m.test(sql));
    assert.ok(/COMMIT;\s*$/m.test(sql.trim() + "\n"));
  });

  test("the only ALTER TABLE statement adds client_id (guarded) -- no SET NOT NULL anywhere in this file", () => {
    const alterMatches = [...codeSql.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(new Set(alterMatches), new Set(["completed_job_billing"]));
    assert.ok(/ALTER TABLE completed_job_billing\s+ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES clients\(id\) ON DELETE RESTRICT;/.test(sql));
  });

  test("client_id is NOT set NOT NULL in this file -- that only happens in migration 034, after the new application code is already live (see split rationale in the header)", () => {
    assert.ok(!upperCodeSql.includes("SET NOT NULL"), "PHASE 1 must leave client_id nullable");
    assert.ok(!upperCodeSql.includes("DROP NOT NULL"), "nothing to drop either -- NOT NULL is never applied here");
  });

  test("does NOT touch the old UNIQUE invoice-number index at all -- no DROP INDEX, no CREATE INDEX anywhere in this file", () => {
    assert.ok(!upperCodeSql.includes("DROP INDEX"), "PHASE 1 must leave the old UNIQUE index completely alone");
    assert.ok(!upperCodeSql.includes("CREATE INDEX"), "PHASE 1 must not create any index -- that is migration 034's job");
  });

  test("the ADD COLUMN statement itself never carries NOT NULL", () => {
    const addColumnLine = sql.split("\n").find((l) => l.includes("ADD COLUMN IF NOT EXISTS client_id"));
    assert.ok(addColumnLine, "expected the ADD COLUMN statement");
    assert.ok(!addColumnLine!.toUpperCase().includes("NOT NULL"), "client_id must stay nullable in PHASE 1");
  });

  test("client_id is never CASCADE on delete, matching every other FK in this schema", () => {
    assert.ok(!upperCodeSql.includes("ON DELETE CASCADE"));
  });

  test("exactly one migration-level backfill UPDATE (outside the function body), guarded so it only ever fills a still-NULL client_id -- re-running this file is a safe no-op", () => {
    const migrationLevelSql = codeSql.replace(functionBody, "");
    const updateMatches = [...migrationLevelSql.matchAll(/^UPDATE\s+(\w+)/gim)];
    assert.equal(updateMatches.length, 1, "expected exactly one UPDATE outside the function body");
    assert.equal(updateMatches[0][1], "completed_job_billing");
    assert.ok(sql.includes("WHERE a.id = cjb.appointment_id"), "backfill must join on appointment_id");
    assert.ok(sql.includes("AND cjb.client_id IS NULL"), "backfill must only touch still-unset rows");
  });

  test("no INSERT or DELETE statement outside the function body -- the migration itself creates/removes no row; the function's own INSERT is the only one, scoped to completed_job_billing", () => {
    const migrationLevelSql = codeSql.replace(functionBody, "");
    assert.ok(!migrationLevelSql.toUpperCase().includes("INSERT INTO"));
    assert.ok(!migrationLevelSql.toUpperCase().includes("DELETE FROM"));
  });

  test("every re-runnable statement is guarded (IF NOT EXISTS / CREATE OR REPLACE)", () => {
    assert.ok(sql.includes("ADD COLUMN IF NOT EXISTS client_id"));
    assert.ok(sql.includes("CREATE OR REPLACE FUNCTION upsert_completed_job_billing"));
  });

  test("adds no quickbooks_invoice_id / external_payment_id / reconciled_at column, and no new invoice/invoice-group table -- scope stays exactly migration 032's own V1 boundary plus the approved sync fix", () => {
    for (const forbidden of ["quickbooks_invoice_id", "external_payment_id", "reconciled_at"]) {
      assert.ok(!codeSql.includes(forbidden), `must not introduce speculative column "${forbidden}"`);
    }
    const createTableMatches = [...codeSql.matchAll(/CREATE TABLE/gi)];
    assert.equal(createTableMatches.length, 0, "no new table -- the invoice group stays an implicit (workspace_id, client_id, invoice_number) match, not a modeled entity");
  });

  test("the header documents the full two-phase PRODUCTION EXECUTION ORDER", () => {
    assert.ok(sql.includes("PRODUCTION EXECUTION ORDER"));
    assert.ok(sql.includes("migration 034"), "must point to the finalization migration by name");
  });
});

describe("migration 033 (PHASE 1) -- upsert_completed_job_billing is the one write path, and is race-safe/scope-safe by construction", () => {
  test("exactly one CREATE OR REPLACE FUNCTION, named upsert_completed_job_billing, with the expected parameter list and return type", () => {
    const fnMatches = [...codeSql.matchAll(/CREATE OR REPLACE FUNCTION\s+(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(fnMatches, ["upsert_completed_job_billing"]);
    assert.ok(
      /CREATE OR REPLACE FUNCTION upsert_completed_job_billing\(\s*p_workspace_id uuid,\s*p_appointment_id uuid,\s*p_client_id uuid,\s*p_invoice_number text,\s*p_paid boolean,\s*p_payment_method text\s*\)\s*RETURNS completed_job_billing/.test(sql)
    );
  });

  test("not SECURITY DEFINER -- invoked only via the service-role client, which already bypasses RLS at the role level (same reasoning as provision_owner_workspace)", () => {
    assert.ok(!upperCodeSql.includes("SECURITY DEFINER"));
  });

  test("execution is revoked from authenticated and granted only to service_role, matching every other write-capable function in this schema", () => {
    assert.ok(sql.includes("REVOKE ALL ON FUNCTION upsert_completed_job_billing(uuid, uuid, uuid, text, boolean, text) FROM authenticated;"));
    assert.ok(sql.includes("GRANT EXECUTE ON FUNCTION upsert_completed_job_billing(uuid, uuid, uuid, text, boolean, text) TO service_role;"));
  });

  test("rejects a different client reusing the same invoice number in the same workspace with a distinguishable, catchable error -- BEFORE writing anything", () => {
    assert.ok(functionBody.includes("client_id <> p_client_id"), "conflict check must compare against a DIFFERENT client_id");
    assert.ok(functionBody.includes("RAISE EXCEPTION 'completed_job_billing_invoice_number_different_client'"));
    assert.ok(functionBody.includes("ERRCODE = 'unique_violation'"), "must use a SQLSTATE the route's existing 23505 handling can still catch");
    // The conflict check must appear BEFORE the INSERT in the function body
    // -- a conflict must never partially write, then fail.
    const checkIndex = functionBody.indexOf("RAISE EXCEPTION");
    const insertIndex = functionBody.indexOf("INSERT INTO completed_job_billing");
    assert.ok(checkIndex >= 0 && insertIndex >= 0 && checkIndex < insertIndex);
  });

  test("upserts the current row via INSERT ... ON CONFLICT (appointment_id), matching the existing UNIQUE constraint from migration 032 -- never a second row for the same appointment", () => {
    assert.ok(functionBody.includes("INSERT INTO completed_job_billing"));
    assert.ok(functionBody.includes("ON CONFLICT (appointment_id) DO UPDATE"));
  });

  test("the sibling-sync UPDATE is scoped by workspace_id AND client_id AND invoice_number together, and excludes the row just written -- it can never cross a client or workspace boundary", () => {
    const syncUpdateMatch = functionBody.match(/UPDATE completed_job_billing\s+SET paid = p_paid[\s\S]*?;/);
    assert.ok(syncUpdateMatch, "expected the sibling-sync UPDATE inside the function body");
    const clause = syncUpdateMatch![0];
    assert.ok(clause.includes("workspace_id = p_workspace_id"));
    assert.ok(clause.includes("client_id = p_client_id"));
    assert.ok(clause.includes("invoice_number = p_invoice_number"));
    assert.ok(clause.includes("appointment_id <> p_appointment_id"));
  });

  test("the sibling-sync UPDATE only runs when invoice_number is non-null -- a cash/no-invoice row's edit never scans for siblings to sync", () => {
    const guardedBlock = functionBody.match(/IF p_invoice_number IS NOT NULL THEN\s*UPDATE completed_job_billing[\s\S]*?END IF;/);
    assert.ok(guardedBlock, "the sibling-sync UPDATE must be inside an `IF p_invoice_number IS NOT NULL` guard");
  });

  test("the function returns the upserted row (RETURNING * INTO v_row, then RETURN v_row) -- the caller gets back the exact row it just wrote, same contract as the previous direct .upsert().select().single()", () => {
    assert.ok(functionBody.includes("RETURNING * INTO v_row"));
    assert.ok(/RETURN v_row;\s*END;/.test(functionBody));
  });
});
