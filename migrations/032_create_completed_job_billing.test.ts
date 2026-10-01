// Static, source-level proof that migration 032 is additive and
// non-destructive -- same "prove it from source" discipline as migrations
// 016/020/021's own tests. Migrations are never executed by this test
// suite (no database is reachable from tests in this repository); the
// real-PostgreSQL verification for this migration is run manually via the
// test-db/SCHEMA_VALIDATION.md-style process and reported separately, not
// wired into test-db/harness.ts (that harness's MIGRATIONS/NEW_MIGRATIONS
// lists are purpose-built for the atomic-recurrence-change feature,
// migrations 029/030/031, and intentionally do not include every
// migration -- see harness.ts's own comments).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./032_create_completed_job_billing.sql", import.meta.url)), "utf8");
const upperSql = sql.toUpperCase();

describe("migration 032 -- additive and non-destructive", () => {
  test("contains no DROP/DELETE/TRUNCATE/ALTER COLUMN statement", () => {
    for (const forbidden of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE", "ALTER COLUMN"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("creates exactly one new table, guarded with IF NOT EXISTS, and the only other table touched via ALTER TABLE is `appointments` (adding supporting uniqueness for the composite FK, nothing else)", () => {
    const createMatches = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(createMatches, ["completed_job_billing"]);
    const alterMatches = [...sql.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(new Set(alterMatches), new Set(["appointments", "completed_job_billing"]));
  });

  test("the appointments ALTER TABLE only ADDs a supporting UNIQUE constraint, guarded by an existence check -- never an unguarded/destructive statement", () => {
    assert.ok(/ALTER TABLE appointments\s+ADD CONSTRAINT appointments_id_workspace_id_key UNIQUE \(id, workspace_id\);/.test(sql));
    // Guarded re-runnability, same discipline as migration 017's analogous guard.
    assert.ok(sql.includes("IF NOT EXISTS (\n    SELECT 1 FROM information_schema.table_constraints"));
  });

  test("no INSERT/UPDATE statement at all -- no backfill, no existing row touched", () => {
    assert.ok(!upperSql.includes("INSERT INTO"));
    assert.ok(!upperSql.includes("UPDATE "));
  });

  test("workspace_id is a NOT NULL FK with ON DELETE RESTRICT (never CASCADE), and appointment_id is a NOT NULL UNIQUE column enforced by the composite FK below rather than a single-column REFERENCES", () => {
    assert.ok(/workspace_id\s+uuid NOT NULL REFERENCES workspaces\(id\) ON DELETE RESTRICT/.test(sql));
    assert.ok(/appointment_id\s+uuid NOT NULL UNIQUE,/.test(sql));
    assert.ok(!upperSql.includes("ON DELETE CASCADE"));
  });

  test("appointment_id + workspace_id are enforced together by a composite FK against appointments(id, workspace_id), ON DELETE RESTRICT -- a row can never carry a workspace_id that doesn't match its appointment's real workspace", () => {
    assert.ok(
      /CONSTRAINT completed_job_billing_appointment_workspace_fkey\s+FOREIGN KEY \(appointment_id, workspace_id\) REFERENCES appointments\(id, workspace_id\) ON DELETE RESTRICT/.test(sql)
    );
  });

  test("appointment_id is UNIQUE -- at most one billing row per appointment", () => {
    assert.ok(/appointment_id\s+uuid NOT NULL UNIQUE/.test(sql));
  });

  test("paid is a NOT NULL boolean defaulting to false", () => {
    assert.ok(/paid\s+boolean NOT NULL DEFAULT false/.test(sql));
  });

  test("invoice_number and payment_method are nullable (no NOT NULL)", () => {
    const invoiceLine = sql.split("\n").find((l) => l.trim().startsWith("invoice_number") && l.includes("text"));
    const methodLine = sql.split("\n").find((l) => l.trim().startsWith("payment_method") && l.includes("text"));
    assert.ok(invoiceLine && !invoiceLine.toUpperCase().includes("NOT NULL"));
    assert.ok(methodLine && !methodLine.toUpperCase().includes("NOT NULL"));
  });

  test("payment_method is constrained to the exact five approved values", () => {
    assert.ok(sql.includes("payment_method IN ('zelle', 'check', 'cash', 'quickbooks_card', 'other')"));
  });

  test("a non-null invoice_number must already be stored trimmed and non-blank at the database layer (defense in depth) -- '13425' and ' 13425 ' can never both exist as if they were distinct values", () => {
    assert.ok(
      sql.includes("CHECK (invoice_number IS NULL OR (invoice_number = btrim(invoice_number) AND length(invoice_number) > 0))")
    );
  });

  test("paid = true requires a non-null payment_method at the database layer", () => {
    assert.ok(sql.includes("CHECK (paid = false OR payment_method IS NOT NULL)"));
  });

  test("invoice_number uniqueness is scoped per workspace via a partial unique index (NULLs excluded)", () => {
    assert.ok(sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS idx_completed_job_billing_workspace_invoice_number"));
    assert.ok(sql.includes("ON completed_job_billing(workspace_id, invoice_number)"));
    assert.ok(sql.includes("WHERE invoice_number IS NOT NULL"));
  });

  test("RLS is enabled on the new table at creation time, matching the deny-all-for-anon convention, and no policy is added", () => {
    assert.ok(sql.includes("ALTER TABLE completed_job_billing ENABLE ROW LEVEL SECURITY;"));
    assert.ok(!upperSql.includes("CREATE POLICY"));
  });

  const columnBlock = sql.match(/CREATE TABLE IF NOT EXISTS completed_job_billing \(([\s\S]*?)\n\);/);
  const columnBlockText = columnBlock ? columnBlock[1] : "";

  test("does not add any quickbooks_invoice_id / external_payment_id / reconciled_at column -- V1 schema is intentionally minimal", () => {
    // Scoped to the actual column-definition block, not the whole file --
    // the header comment above deliberately NAMES these columns in prose,
    // explaining that they are NOT included in V1 (see this file's own
    // header). A plain sql.includes() check would false-positive on that
    // explanatory text; checking only the real column list is what this
    // test is actually supposed to prove.
    assert.ok(columnBlockText.length > 0, "expected to find the CREATE TABLE column list");
    for (const forbidden of ["quickbooks_invoice_id", "external_payment_id", "reconciled_at"]) {
      assert.ok(!columnBlockText.includes(forbidden), `must not contain speculative column "${forbidden}"`);
    }
  });

  test("the table has exactly the eight V1 columns, nothing more", () => {
    assert.ok(columnBlockText.length > 0, "expected to find the CREATE TABLE column list");
    const columnNames = [...columnBlockText.matchAll(/^\s{2}(\w+)\s+(?:uuid|text|boolean|timestamptz)/gm)].map((m) => m[1]);
    assert.deepEqual(columnNames, [
      "id", "workspace_id", "appointment_id", "invoice_number", "paid", "payment_method", "created_at", "updated_at",
    ]);
  });
});
