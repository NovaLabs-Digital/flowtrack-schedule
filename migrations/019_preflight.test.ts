// Phase: static, source-level proof that migrations/019_preflight.sql is
// genuinely read-only. This file is never executed by the test suite (no
// database is reachable from tests anywhere in this repository, and this
// file is never run automatically -- Alberto runs it manually) -- this
// proves the SQL text itself, matching the same discipline established for
// migrations/017_preflight.sql and migrations/018_preflight.sql.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./019_preflight.sql", import.meta.url)), "utf8");

const codeOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

describe("019_preflight.sql -- unquestionably read-only", () => {
  test("contains no DML/DDL statement -- only SELECT, against information_schema/pg_catalog views and employees row counts", () => {
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
});

describe("019_preflight.sql -- exposes no secrets/PII", () => {
  test("no executable statement selects a token or secret-shaped value; password_hash appears only once, as a column-existence check, never a selected value", () => {
    for (const forbidden of ["token", "secret"]) {
      assert.ok(!codeOnly.toLowerCase().includes(forbidden), `must not reference a "${forbidden}"-shaped value in executable SQL`);
    }
    // password_hash's column name is checked for existence in query 1's
    // metadata filter (same pattern 018_preflight.test.ts already
    // established for "email") -- allowed there, and only there. No SELECT
    // list anywhere selects the column's actual data value.
    const passwordMatches = [...codeOnly.matchAll(/password/gi)];
    assert.equal(passwordMatches.length, 1);
    assert.ok(codeOnly.includes("'password_hash'"));
    const selectListLines = codeOnly.split("\n").filter((line) => /^select\b/i.test(line.trim()));
    for (const line of selectListLines) {
      assert.ok(!line.toLowerCase().includes("password"), `a SELECT list must never directly select a password/hash column: ${line}`);
    }
  });

  test("no SELECT list ever retrieves an actual email value -- every email reference is either a column-name filter, a NULL check, or wrapped in lower()/count(), never a selected raw column", () => {
    const selectListLines = codeOnly
      .split("\n")
      .filter((line) => /^select\b/i.test(line.trim()));
    for (const line of selectListLines) {
      // "email" the identifier is allowed to appear (e.g. "email is not
      // null", "lower(email)"), but never as a bare selected column that
      // would return the raw address.
      assert.ok(!/select\s+email\b/i.test(line), `a SELECT list must never directly select a raw email column: ${line}`);
      assert.ok(!/,\s*email\b/i.test(line), `a SELECT list must never directly select a raw email column: ${line}`);
    }
  });
});

describe("019_preflight.sql -- covers the required employees checks", () => {
  test("checks employees.email/workspace_id/password_hash/active columns", () => {
    assert.ok(codeOnly.includes("table_name = 'employees'"));
    assert.ok(codeOnly.includes("'email', 'workspace_id', 'password_hash', 'active'"));
  });

  test("inspects existing indexes on employees via pg_indexes", () => {
    assert.ok(/pg_indexes/i.test(codeOnly));
    assert.ok(codeOnly.includes("tablename = 'employees'"));
  });

  test("checks for within-workspace duplicate normalized email (the blocking precondition) using only counts, grouped by workspace_id and lower(email)", () => {
    assert.ok(/group by workspace_id, lower\(email\)/i.test(codeOnly));
    assert.ok(/having count\(\*\) > 1/i.test(codeOnly));
  });

  test("checks whether any stored email is not already lowercase, via a count only", () => {
    assert.ok(/email <> lower\(email\)/i.test(codeOnly));
    assert.ok(codeOnly.includes("non_lowercase_email_count"));
  });

  test("checks cross-workspace shared-email count as informational, via count(distinct workspace_id)", () => {
    assert.ok(/count\(distinct workspace_id\)/i.test(codeOnly));
  });
});
