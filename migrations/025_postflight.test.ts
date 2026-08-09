// Phase 5 post-migration verification: static, source-level proof that
// migrations/025_postflight.sql is genuinely read-only. This file is never
// executed by the test suite (no database is reachable from tests anywhere
// in this repository, and this file is never run automatically -- Alberto
// runs it manually in the Supabase SQL Editor, after migration 025) -- this
// proves the SQL text itself, matching the same discipline established for
// migrations/017_preflight.sql, 018_preflight.sql, 019_preflight.sql, and
// 025_preflight.sql.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./025_postflight.sql", import.meta.url)), "utf8");

const codeOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

describe("025_postflight.sql -- unquestionably read-only", () => {
  test("contains no DML/DDL statement -- only SELECT, against information_schema, company_settings, and appointments' column metadata", () => {
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

  test("only ever reads appointments' column metadata (information_schema), never appointment row data itself", () => {
    assert.ok(!/\bfrom\s+appointments\b/i.test(codeOnly), "must never SELECT FROM appointments directly");
  });
});

describe("025_postflight.sql -- exposes no secrets/PII", () => {
  test("no reference to password_hash, token, or secret-shaped values anywhere in executable SQL", () => {
    for (const forbidden of ["password", "token", "secret"]) {
      assert.ok(!codeOnly.toLowerCase().includes(forbidden), `must not reference a "${forbidden}"-shaped value`);
    }
  });

  test("never selects client/employee PII -- no clients/employees table, email, or phone is referenced", () => {
    for (const forbidden of ["clients", "employees", "email", "phone"]) {
      assert.ok(!codeOnly.toLowerCase().includes(forbidden), `must not reference "${forbidden}"`);
    }
  });
});

describe("025_postflight.sql -- covers the required post-migration checks", () => {
  test("confirms company_settings.timezone exists with the expected shape", () => {
    assert.ok(codeOnly.includes("column_name = 'timezone'"));
    assert.ok(codeOnly.includes("is_nullable"));
    assert.ok(codeOnly.includes("column_default"));
  });

  test("confirms business_hours and appointments.repeat_months are unaffected", () => {
    assert.ok(codeOnly.includes("column_name = 'business_hours'"));
    assert.ok(codeOnly.includes("table_name = 'appointments' and column_name = 'repeat_months'"));
  });

  test("counts total rows for direct comparison against the preflight count", () => {
    assert.ok(/select count\(\*\) as total_rows from company_settings/i.test(codeOnly));
  });

  test("selects every row's timezone value and separately counts any non-NULL timezone", () => {
    assert.ok(/select workspace_id, timezone\s*$/im.test(codeOnly));
    assert.ok(/select count\(\*\) as non_null_timezone_count/i.test(codeOnly));
    assert.ok(/where timezone is not null/i.test(codeOnly));
  });

  test("re-checks workspace_id integrity -- distinct count, NULL count, and duplicate-row detection", () => {
    assert.ok(/count\(distinct workspace_id\)/i.test(codeOnly));
    assert.ok(/null_workspace_id_count/i.test(codeOnly));
    assert.ok(/group by workspace_id/i.test(codeOnly));
    assert.ok(/having count\(\*\) > 1/i.test(codeOnly));
  });

  test("selects every row's company_name/booking_enabled/notifications_enabled/business_hours for field-by-field comparison against the preflight snapshot", () => {
    assert.ok(/select workspace_id, company_name, booking_enabled, notifications_enabled, business_hours/i.test(codeOnly));
  });
});
