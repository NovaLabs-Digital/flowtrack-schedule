// SOURCE-LEVEL checks of migration 031's SQL text. They read the file; they
// do NOT execute it. The behavioral change itself (an owner correction wins
// over a complete Job Tracking duration, original timestamps untouched) is
// proven against real PostgreSQL in test-db/recurrence.test.ts
// (`npm run test:db`).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./031_add_owner_worked_time_override.sql", import.meta.url)), "utf8");
const body = (name: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  return sql.slice(sql.indexOf("AS $fn$", start), sql.indexOf("$fn$;", start));
};
const hours = body("save_employee_hours");

describe("migration 031 -- additive shape and permissions", () => {
  test("one transaction, one function REPLACED (no table, column, or index change), nothing dropped or deleted", () => {
    assert.ok(sql.includes("\nBEGIN;\n") && sql.trim().endsWith("COMMIT;"));
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").toUpperCase();
    for (const banned of ["DROP ", "TRUNCATE", "DELETE FROM", "ALTER TABLE", "CREATE TABLE", "CREATE INDEX"]) {
      assert.ok(!code.includes(banned), banned);
    }
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 1);
    assert.ok(sql.includes("CREATE OR REPLACE FUNCTION save_employee_hours("));
  });

  test("the function signature is byte-identical to migrations/030's (so its existing grants carry over)", () => {
    const params = "p_workspace_id   UUID,\n  p_appointment_id UUID,\n  p_employee_id    UUID,\n  p_hours_worked   NUMERIC,\n  p_note           TEXT";
    assert.ok(sql.includes(params));
    assert.ok(sql.includes("RETURNS JSONB\nLANGUAGE plpgsql\nSECURITY INVOKER\nSET search_path = public"));
  });

  test("still executable only by service_role, restated defensively", () => {
    const sig = "save_employee_hours(UUID, UUID, UUID, NUMERIC, TEXT)";
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      assert.ok(sql.includes(`REVOKE ALL ON FUNCTION ${sig} FROM ${role};`), role);
    }
    assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`));
  });
});

describe("migration 031 -- the owner-override behavior change (source-level)", () => {
  test("the tracked-time guard from migration 030 (tracked_time_exists) is gone from the function itself", () => {
    // The header comment above explains, in prose, what migration 030's
    // guard used to be called -- only the FUNCTION BODY is asserted here to
    // no longer contain that outcome string.
    assert.ok(!hours.includes("tracked_time_exists"));
  });

  test("the parent-appointment-first, then-assignment-FOR-UPDATE lock order is unchanged from migration 030", () => {
    const parent = hours.indexOf("FROM appointments\n  WHERE id = p_appointment_id AND workspace_id = p_workspace_id\n  FOR SHARE");
    const assignment = hours.indexOf("FROM appointment_employees\n  WHERE appointment_id = p_appointment_id AND employee_id = p_employee_id AND workspace_id = p_workspace_id\n  FOR UPDATE");
    assert.ok(parent > -1 && assignment > parent);
    const firstWrite = hours.indexOf("INSERT INTO appointment_employee_hours");
    assert.ok(firstWrite > assignment, "no write before both locks are held");
  });

  test("still only blocks a brand NEW entry on a non-scheduled appointment; correcting an existing entry is still allowed (unchanged from 030)", () => {
    assert.ok(hours.includes("v_existing IS NULL AND v_status IS DISTINCT FROM 'scheduled'"));
  });

  test("still requires a non-empty reason and a positive hours value before any lock is taken", () => {
    assert.ok(hours.includes("p_hours_worked IS NULL OR p_hours_worked <= 0"));
    assert.ok(hours.includes("p_note IS NULL OR btrim(p_note) = ''"));
  });

  test("never writes appointment_employees (actual_started_at/actual_completed_at are untouched by this function)", () => {
    assert.ok(!hours.includes("UPDATE appointment_employees"));
    assert.ok(!hours.includes("actual_started_at =") && !hours.includes("actual_completed_at ="));
  });

  test("still the same upsert (ON CONFLICT (appointment_id, employee_id) DO UPDATE) into appointment_employee_hours only", () => {
    assert.ok(hours.includes("INSERT INTO appointment_employee_hours"));
    assert.ok(hours.includes("ON CONFLICT (appointment_id, employee_id)\n  DO UPDATE SET hours_worked = EXCLUDED.hours_worked, note = EXCLUDED.note"));
  });
});
