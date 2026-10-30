// Source checks for migration 041 (behavior is proven against real
// PostgreSQL in test-db/early_job_start.test.ts).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { TIMEZONE_OPTIONS } from "../lib/timezone.ts";

const read = (name: string) => fs.readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const m041 = read("041_block_early_job_start.sql");
const m030 = read("030_add_work_recording_locking_protocol.sql");

const functionBody = (sql: string) =>
  sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION record_job_action("), sql.indexOf("GRANT EXECUTE ON FUNCTION record_job_action"));
const statements = (sql: string) =>
  functionBody(sql).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("--"));

describe("migration 041 -- timezone rule identical to lib/timezone.ts effectiveTimezone", () => {
  test("the database's supported-zone list is exactly TIMEZONE_OPTIONS", () => {
    const list = m041.slice(m041.indexOf("v_timezone NOT IN ("), m041.indexOf(") THEN", m041.indexOf("v_timezone NOT IN (")));
    const zones = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual([...zones].sort(), TIMEZONE_OPTIONS.map((o) => o.value).sort());
  });

  test("the stored value is trimmed first, and anything else falls back to America/New_York", () => {
    const trim = m041.indexOf("v_timezone := regexp_replace(v_timezone, '^[[:space:]]+|[[:space:]]+$', '', 'g');");
    const check = m041.indexOf("IF v_timezone IS NULL OR v_timezone NOT IN (");
    assert.ok(trim > 0 && check > trim, "trim happens before the allowlist check");
    assert.match(m041.slice(check), /^IF v_timezone IS NULL OR v_timezone NOT IN \([^)]*\) THEN\s+v_timezone := 'America\/New_York';/);
    assert.ok(!m041.includes("pg_timezone_names"), "never 'is this any valid IANA zone' -- same allowlist as the app");
  });
});

describe("migration 041 -- only the scheduled-day check is added to record_job_action", () => {
  test("every statement of migration 030's function is preserved, in order (except the appointment read, which also fetches scheduled_for)", () => {
    const after = statements(m041);
    let cursor = 0;
    for (const line of statements(m030)) {
      const expected = line === "SELECT status INTO v_status" ? "SELECT status, scheduled_for INTO v_status, v_scheduled" : line;
      const found = after.indexOf(expected, cursor);
      assert.ok(found >= 0, `missing or reordered: ${line}`);
      cursor = found + 1;
    }
  });

  test("first work is checked against both past and future days; finished-work paths are untouched", () => {
    const check = m041.slice(m041.indexOf("IF v_assign.actual_started_at IS NULL THEN\n    SELECT timezone"));
    assert.match(check, /IF v_day > v_today THEN\s+RETURN jsonb_build_object\('outcome', 'appointment_not_due'\);\s+ELSIF v_day < v_today THEN\s+RETURN jsonb_build_object\('outcome', 'appointment_day_passed'\);/);
  });

  test("same privileges as 030: service_role only", () => {
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      assert.ok(m041.includes(`REVOKE ALL ON FUNCTION record_job_action(UUID, UUID, UUID, TEXT, TEXT) FROM ${role};`));
    }
    assert.ok(m041.includes("GRANT EXECUTE ON FUNCTION record_job_action(UUID, UUID, UUID, TEXT, TEXT) TO service_role;"));
  });

  test("changes no existing records: no UPDATE/INSERT/DELETE outside the function body", () => {
    const outside = m041.replace(functionBody(m041), "");
    assert.ok(!/\b(UPDATE|INSERT|DELETE)\b/i.test(outside.replace(/--.*$/gm, "")));
  });
});
