// Phase 5.7D-R9: static, source-level proof that migrations/018_preflight.sql
// is genuinely read-only. This file is never executed by the test suite (no
// database is reachable from tests anywhere in this repository, and this
// file is never run automatically -- Alberto runs it manually) -- this
// proves the SQL text itself, matching the same discipline established for
// migrations/017_preflight.sql.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./018_preflight.sql", import.meta.url)), "utf8");

const codeOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

describe("018_preflight.sql -- unquestionably read-only", () => {
  test("contains no DML/DDL statement -- only SELECT, against information_schema/pg_catalog views and profiles/workspace_memberships row counts", () => {
    for (const forbidden of ["INSERT", "UPDATE", "DELETE", "ALTER", "CREATE", "DROP", "TRUNCATE", "GRANT", "REVOKE"]) {
      assert.ok(
        !new RegExp(`\\b${forbidden}\\b`, "i").test(codeOnly),
        `must not contain "${forbidden}" outside a comment`
      );
    }
  });

  test("every executable statement is a SELECT", () => {
    const statements = codeOnly
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    assert.ok(statements.length > 0);
    for (const stmt of statements) {
      assert.match(stmt, /^select\b/i, `statement must start with SELECT: ${stmt.slice(0, 60)}`);
    }
  });

  test("does not invoke provision_owner_workspace -- referenced only in comments, never called", () => {
    assert.ok(!/select\s+provision_owner_workspace\s*\(/i.test(codeOnly));
  });
});

describe("018_preflight.sql -- exposes no secrets/PII", () => {
  test("no executable statement selects a password, hash, token, or secret-shaped column", () => {
    for (const forbidden of ["password", "hash", "token", "secret"]) {
      assert.ok(!codeOnly.toLowerCase().includes(forbidden), `must not reference a "${forbidden}"-shaped column in executable SQL`);
    }
  });

  test("no SELECT list ever retrieves actual email values -- the one reference to 'email' in executable code is a column-NAME filter (excluding it from the unexpected-NOT-NULL-column check in section 4), never a selected data column", () => {
    const selectListLines = codeOnly
      .split("\n")
      .filter((line) => /^select\b/i.test(line.trim()));
    for (const line of selectListLines) {
      assert.ok(!line.toLowerCase().includes("email"), `a SELECT list must never directly select email: ${line}`);
    }
    // The only "email" reference anywhere in executable code is this exact
    // metadata filter -- not a data-returning column.
    const emailReferences = [...codeOnly.matchAll(/email/gi)];
    assert.equal(emailReferences.length, 1);
    assert.ok(codeOnly.includes("column_name not in ('id', 'email')"));
  });
});

describe("018_preflight.sql -- covers the required profiles checks", () => {
  test("checks profiles columns, primary key, foreign key to auth.users, delete rule, and unexpected NOT NULL columns", () => {
    assert.ok(codeOnly.includes("table_name = 'profiles'"));
    assert.ok(/referenced_table/i.test(codeOnly));
    assert.ok(/delete_rule/i.test(codeOnly));
    assert.ok(codeOnly.includes("column_name not in ('id', 'email')"));
  });

  test("checks the exact foreign key on workspace_memberships that production's error named", () => {
    assert.ok(codeOnly.includes("table_name = 'workspace_memberships'"));
    assert.ok(codeOnly.includes("constraint_type = 'FOREIGN KEY'"));
  });
});
