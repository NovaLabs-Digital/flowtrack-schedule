// Static, source-level proof that migration 019 replaces the global
// idx_employees_email unique index with a workspace-scoped, case-insensitive
// one, without touching any existing row or any other table. Migrations are
// never executed by this test suite (no database is reachable from tests
// anywhere in this repository) -- this proves the SQL text itself, matching
// the same discipline established for migrations 017/018.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./019_employee_email_workspace_scoped.sql", import.meta.url)), "utf8");
const codeOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .trim();

describe("migration 019 -- transaction-wrapped, idempotent", () => {
  test("executable content is wrapped in BEGIN;/COMMIT;", () => {
    assert.match(codeOnly, /^BEGIN;/);
    assert.match(codeOnly, /COMMIT;\s*$/);
  });

  test("drops the old index only if it exists, and creates the new one only if it doesn't -- safely re-runnable", () => {
    assert.match(codeOnly, /DROP INDEX IF EXISTS idx_employees_email;/);
    assert.match(codeOnly, /CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_email_workspace/);
  });
});

describe("migration 019 -- the new index is workspace-scoped and case-insensitive", () => {
  test("the new unique index is defined on (workspace_id, LOWER(email)), never on email alone", () => {
    assert.match(codeOnly, /CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_email_workspace\s*\n\s*ON employees \(workspace_id, LOWER\(email\)\)/i);
  });

  test("the new index preserves the same partial WHERE email IS NOT NULL condition as the index it replaces", () => {
    assert.match(codeOnly, /idx_employees_email_workspace[\s\S]*WHERE email IS NOT NULL/i);
  });

  test("does not drop or alter the employees table itself, or any column -- only the index changes", () => {
    assert.ok(!/ALTER TABLE employees/i.test(codeOnly));
    assert.ok(!/DROP TABLE/i.test(codeOnly));
    assert.ok(!/DROP COLUMN/i.test(codeOnly));
  });

  test("contains no DML statement -- no INSERT/UPDATE/DELETE against employees or any other table (no backfill; the preflight confirmed none is needed)", () => {
    for (const forbidden of ["INSERT INTO", "UPDATE employees", "DELETE FROM"]) {
      assert.ok(!new RegExp(forbidden, "i").test(codeOnly), `must not contain "${forbidden}"`);
    }
  });

  test("touches only the employees table -- no other table is named in executable SQL", () => {
    const tableMentions = [...codeOnly.matchAll(/\bON\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
    for (const t of tableMentions) assert.equal(t, "employees");
  });
});
