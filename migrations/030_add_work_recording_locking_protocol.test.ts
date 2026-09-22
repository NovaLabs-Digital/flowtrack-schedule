// SOURCE-LEVEL checks of migration 030's SQL text. They read the file; they do
// NOT execute it. Locking, revalidation and concurrent behavior are proven on a
// real PostgreSQL instance in test-db/recurrence.test.ts (`npm run test:db`).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./030_add_work_recording_locking_protocol.sql", import.meta.url)), "utf8");
const body = (name: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  return sql.slice(sql.indexOf("AS $fn$", start), sql.indexOf("$fn$;", start));
};
const job = body("record_job_action");
const hours = body("save_employee_hours");

describe("migration 030 -- additive shape and permissions", () => {
  test("one transaction, two new functions, no table or column changes, nothing dropped or deleted", () => {
    assert.ok(sql.includes("\nBEGIN;\n") && sql.trim().endsWith("COMMIT;"));
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").toUpperCase();
    for (const banned of ["DROP ", "TRUNCATE", "DELETE FROM", "ALTER TABLE", "CREATE TABLE"]) assert.ok(!code.includes(banned), banned);
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 2);
  });

  test("both functions are SECURITY INVOKER with a pinned search_path and executable only by service_role", () => {
    for (const sig of ["record_job_action(UUID, UUID, UUID, TEXT, TEXT)", "save_employee_hours(UUID, UUID, UUID, NUMERIC, TEXT)"]) {
      for (const role of ["PUBLIC", "anon", "authenticated"]) assert.ok(sql.includes(`REVOKE ALL ON FUNCTION ${sig} FROM ${role};`), `${sig} ${role}`);
      assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`), sig);
    }
    const codeOnly = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    assert.equal((codeOnly.match(/SECURITY INVOKER/g) ?? []).length, 2);
    assert.equal((codeOnly.match(/SET search_path = public/g) ?? []).length, 2);
  });
});

describe("migration 030 -- the shared locking protocol (source-level)", () => {
  for (const [name, fn] of [["record_job_action", job], ["save_employee_hours", hours]] as const) {
    test(`${name}: the PARENT appointment is locked FOR SHARE first (workspace-scoped), then the assignment row FOR UPDATE -- never the reverse`, () => {
      const parent = fn.indexOf("FROM appointments\n  WHERE id = p_appointment_id AND workspace_id = p_workspace_id\n  FOR SHARE");
      const assignment = fn.indexOf("FROM appointment_employees\n  WHERE appointment_id = p_appointment_id AND employee_id = p_employee_id AND workspace_id = p_workspace_id\n  FOR UPDATE");
      assert.ok(parent > -1 && assignment > parent);
      const firstWrite = Math.min(...["UPDATE appointment_employees", "INSERT INTO appointment_employee_hours"].map((w) => fn.indexOf(w)).filter((i) => i > -1));
      assert.ok(firstWrite > assignment, "no write before both locks are held");
    });

    test(`${name}: the appointment's status is read in the SAME statement as the lock (so it is re-evaluated after any wait), and a non-scheduled target is rejected`, () => {
      assert.ok(fn.includes("SELECT status INTO v_status\n  FROM appointments"));
      assert.ok(fn.includes("v_status IS DISTINCT FROM 'scheduled'"));
      assert.ok(fn.includes("appointment_not_active"));
    });
  }

  test("record_job_action only blocks the FIRST recorded work: finishing already-started work on a cancelled appointment is never blocked", () => {
    assert.ok(job.includes("v_assign.actual_started_at IS NULL AND v_status IS DISTINCT FROM 'scheduled'"));
  });

  test("save_employee_hours only blocks a NEW entry on a non-scheduled appointment; correcting an existing entry is allowed", () => {
    assert.ok(hours.includes("v_existing IS NULL AND v_status IS DISTINCT FROM 'scheduled'"));
  });

  test("the manual-hours override guard is the same predicate as lib/payroll.ts isJobTrackingComplete (both timestamps, at least 60 seconds)", () => {
    assert.ok(hours.includes("actual_completed_at - v_assign.actual_started_at >= INTERVAL '60 seconds'") || hours.includes("v_assign.actual_completed_at - v_assign.actual_started_at >= INTERVAL '60 seconds'"));
  });
});
