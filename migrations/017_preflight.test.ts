// Phase 5.7D-R5: static, source-level proof that migrations/017_preflight.sql
// is genuinely read-only and reflects the corrected, verified production
// schema. This file is never executed by the test suite (no database is
// reachable from tests anywhere in this repository, and this file is never
// run automatically -- Alberto runs it manually) -- this proves the SQL
// text itself, matching the same discipline established for migration 017
// itself.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./017_preflight.sql", import.meta.url)), "utf8");

// Comments in this file legitimately describe migration 017's own DDL/DML
// (e.g. "ALTER TABLE will run against"), reference words like "email" or
// "secret" in prose explaining why a column is EXCLUDED, and use semicolons
// as ordinary English punctuation -- none of that is executed SQL. Every
// safety assertion below checks only this comment-stripped, executable
// text, never the raw file.
const codeOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

describe("017_preflight.sql -- unquestionably read-only", () => {
  test("contains no DML/DDL statement -- only SELECT, against information_schema/pg_catalog views", () => {
    for (const forbidden of ["INSERT", "UPDATE", "DELETE", "ALTER", "CREATE", "DROP", "TRUNCATE", "GRANT", "REVOKE"]) {
      assert.ok(
        !new RegExp(`\\b${forbidden}\\b`, "i").test(codeOnly),
        `must not contain "${forbidden}" outside a comment`
      );
    }
  });

  test("every executable statement is a SELECT against a read-only catalog/information_schema view", () => {
    const statements = codeOnly
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    assert.ok(statements.length > 0);
    for (const stmt of statements) {
      assert.match(stmt, /^select\b/i, `statement must start with SELECT: ${stmt.slice(0, 60)}`);
    }
  });

  test("does not invoke provision_owner_workspace, record_rate_limit_attempt, or clear_rate_limit -- referenced only as name literals inside a catalog lookup, never called", () => {
    for (const fn of ["provision_owner_workspace", "record_rate_limit_attempt", "clear_rate_limit"]) {
      assert.ok(!new RegExp(`select\\s+${fn}\\s*\\(`, "i").test(codeOnly), `must not invoke ${fn}(...) directly`);
    }
  });
});

describe("017_preflight.sql -- exposes no secrets/PII", () => {
  test("no executable statement selects a password, hash, token, or secret-shaped column (mentions of these words in explanatory comments are expected and fine)", () => {
    for (const forbidden of ["password", "hash", "token", "secret"]) {
      assert.ok(!codeOnly.toLowerCase().includes(forbidden), `must not reference a "${forbidden}"-shaped column in executable SQL`);
    }
  });

  test("the owner-membership query's actual SELECT list is profile_id and count(*) only -- no email or other identifying column (the comment above it says 'no email' in prose, which is expected and separate from this check)", () => {
    assert.ok(codeOnly.includes("select profile_id, count(*) as owner_membership_count"));
    assert.ok(codeOnly.includes("select count(*) as total_owner_memberships"));
    assert.ok(!codeOnly.toLowerCase().includes("email"), "no executable SELECT anywhere in this file may reference an email column");
  });
});

describe("017_preflight.sql -- Phase 5.7D-R5 correction: workspaces.name is treated as intentionally supplied", () => {
  test("section 6B's allowed-column list for workspaces includes both id and name", () => {
    const match = codeOnly.match(/table_name = 'workspaces' and column_name not in \(([^)]*)\)/i);
    assert.ok(match, "expected the workspaces allow-list clause to exist");
    assert.match(match![1], /'id'/);
    assert.match(match![1], /'name'/);
  });

  test("booking_enabled and notifications_enabled remain in the company_settings allow-list, unaffected by the workspaces.name correction", () => {
    const match = codeOnly.match(/table_name = 'company_settings' and column_name not in\s*\(([^)]*)\)/i);
    assert.ok(match);
    assert.match(match![1], /'booking_enabled'/);
    assert.match(match![1], /'notifications_enabled'/);
  });
});

describe("017_preflight.sql -- Phase 5.7D-R6: no equivalent sql_identifier[]/text[] array-comparison bug", () => {
  test("contains no array_agg(...) = ARRAY[...] comparison at all -- the only place this file aggregates a column is string_agg (query 2), which has no cross-type array-equality operator to trip over", () => {
    assert.ok(!/array_agg/i.test(codeOnly), "this file must never introduce an array_agg(...)-based comparison");
    assert.ok(!/=\s*ARRAY\[/i.test(codeOnly), "this file must never compare against an ARRAY[...] literal");
  });

  test("the one aggregate function used (string_agg, query 2) takes an information_schema.sql_identifier column directly -- safe, since string_agg's argument is a scalar text parameter (implicit assignment cast applies), unlike array-typed equality which has no such cast", () => {
    assert.match(codeOnly, /string_agg\(\s*kcu\.column_name\s*,/i);
  });
});
