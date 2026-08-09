// Phase 5 cumulative final audit: static, source-level proof that
// migrations/025_preflight.sql is genuinely read-only. This file is never
// executed by the test suite (no database is reachable from tests anywhere
// in this repository, and this file is never run automatically -- Alberto
// runs it manually in the Supabase SQL Editor) -- this proves the SQL text
// itself, matching the same discipline established for
// migrations/017_preflight.sql, migrations/018_preflight.sql, and
// migrations/019_preflight.sql.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./025_preflight.sql", import.meta.url)), "utf8");

const codeOnly = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

describe("025_preflight.sql -- unquestionably read-only", () => {
  test("contains no DML/DDL statement -- only SELECT, against information_schema and company_settings", () => {
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

  test("touches only information_schema and company_settings -- no other table is referenced by name", () => {
    const fromMatches = [...codeOnly.matchAll(/\bfrom\s+([a-z_][a-z0-9_.]*)/gi)].map((m) => m[1].toLowerCase());
    for (const table of fromMatches) {
      assert.ok(
        table === "information_schema.columns" || table === "company_settings" || table.startsWith("(") || /^t$/.test(table),
        `unexpected table reference: ${table}`
      );
    }
  });
});

describe("025_preflight.sql -- exposes no secrets/PII", () => {
  test("no reference to password_hash, token, or secret-shaped values anywhere in executable SQL", () => {
    for (const forbidden of ["password", "token", "secret"]) {
      assert.ok(!codeOnly.toLowerCase().includes(forbidden), `must not reference a "${forbidden}"-shaped value`);
    }
  });

  test("never selects client PII -- no clients/employees table is referenced at all", () => {
    for (const forbidden of ["clients", "employees", "email", "phone"]) {
      assert.ok(!codeOnly.toLowerCase().includes(forbidden), `must not reference "${forbidden}"`);
    }
  });

  test("the row-snapshot query (query 7) selects only owner-facing business settings, never a secret or credential column", () => {
    const selectListLines = codeOnly.split("\n").filter((line) => /^select\b/i.test(line.trim()));
    const snapshotLine = selectListLines.find((l) => l.includes("company_name"));
    assert.ok(snapshotLine, "expected a SELECT list including company_name");
    assert.deepEqual(
      snapshotLine!.replace(/^select\s+/i, "").split(",").map((s) => s.trim()),
      ["workspace_id", "company_name", "booking_enabled", "notifications_enabled", "business_hours"]
    );
  });
});

describe("025_preflight.sql -- covers the required company_settings checks", () => {
  test("checks company_settings's full current column shape via information_schema.columns", () => {
    assert.ok(codeOnly.includes("table_name = 'company_settings'"));
    assert.ok(/order by ordinal_position/i.test(codeOnly));
  });

  test("explicitly checks for a pre-existing timezone column (the collision check)", () => {
    assert.ok(codeOnly.includes("column_name = 'timezone'"));
  });

  test("explicitly checks for the business_hours column (migration 024's own column)", () => {
    assert.ok(codeOnly.includes("column_name = 'business_hours'"));
  });

  test("counts total company_settings rows", () => {
    assert.ok(/select count\(\*\) as total_rows from company_settings/i.test(codeOnly));
  });

  test("checks workspace_id integrity -- distinct count, NULL count, and duplicate-row detection, via counts/grouping only", () => {
    assert.ok(/count\(distinct workspace_id\)/i.test(codeOnly));
    assert.ok(/null_workspace_id_count/i.test(codeOnly));
    assert.ok(/group by workspace_id/i.test(codeOnly));
    assert.ok(/having count\(\*\) > 1/i.test(codeOnly));
  });

  test("selects every row's company_name/booking_enabled/notifications_enabled/business_hours for visual confirmation", () => {
    assert.ok(/select workspace_id, company_name, booking_enabled, notifications_enabled, business_hours/i.test(codeOnly));
  });
});
