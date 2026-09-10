// Employee Job Notes: static, source-level proof that migration 028 is
// additive and non-destructive. Migrations are never executed by this test
// suite (no database is reachable from tests anywhere in this repository)
// -- this file proves the SQL text itself contains no destructive
// statement, matching the same "prove it from source" discipline as
// migration 022's own test.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./028_add_appointment_employees_job_notes.sql", import.meta.url)), "utf8");
const upperSql = sql.toUpperCase();
// Comment prose with "-- " line-continuation markers stripped, so a
// sentence that happens to word-wrap across multiple comment lines can
// still be matched as one continuous phrase.
const proseText = sql.replace(/^--\s?/gm, "").replace(/\s+/g, " ");

describe("migration 028 -- additive and non-destructive", () => {
  test("contains no DROP/DELETE/TRUNCATE/UPDATE statement", () => {
    for (const forbidden of ["DROP TABLE", "DROP COLUMN", "DELETE FROM", "TRUNCATE", "UPDATE APPOINTMENT_EMPLOYEES"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("adds exactly one column, guarded with IF NOT EXISTS, nullable TEXT with no default", () => {
    const addColumnLines = sql.split("\n").filter((l) => l.trim().startsWith("ALTER TABLE") && l.includes("ADD COLUMN IF NOT EXISTS"));
    assert.equal(addColumnLines.length, 1);
    assert.ok(addColumnLines[0].includes("job_notes TEXT"));
    assert.ok(!/\bNOT NULL\b/i.test(addColumnLines[0]), "must not be NOT NULL");
    assert.ok(!/\bDEFAULT\b/i.test(addColumnLines[0]), "must not have a DEFAULT");
    assert.ok(!upperSql.includes("ALTER COLUMN"), "must not modify an existing column's type/default/constraint");
  });

  test("touches only the appointment_employees table -- no other table is referenced by name", () => {
    const alterMatches = [...sql.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(new Set(alterMatches), new Set(["appointment_employees"]));
  });

  test("does not touch appointments.notes, clients.notes, appointment_employee_hours.note, or any other column -- job_notes is a genuinely new, independent field", () => {
    // appointments.notes/clients.notes are legitimately named in this
    // migration's own PROSE comment, to explain why job_notes is a new
    // column rather than a reuse of one of them (same documentation
    // pattern as migration 022's own header comment re: price_cents) --
    // what must actually be proven is that no REAL SQL STATEMENT touches
    // any table/column other than appointment_employees.job_notes.
    for (const forbidden of ["ALTER TABLE appointments", "ALTER TABLE clients", "ALTER TABLE appointment_employee_hours"]) {
      assert.ok(!upperSql.includes(forbidden.toUpperCase()), `must not reference "${forbidden}"`);
    }
    const alterStatements = sql.split("\n").filter((l) => l.trim().startsWith("ALTER TABLE"));
    for (const line of alterStatements) {
      assert.ok(line.includes("job_notes"), `every ALTER TABLE statement must be about job_notes: "${line}"`);
    }
  });

  test("no index, RLS, constraint, or policy statement is added -- job_notes needs none of them", () => {
    for (const forbidden of ["CREATE INDEX", "CREATE UNIQUE INDEX", "ENABLE ROW LEVEL SECURITY", "CREATE POLICY", "ADD CONSTRAINT"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("documents that the column is not backfilled for any existing row", () => {
    assert.ok(/no backfill/i.test(sql) || /None\./.test(sql));
    assert.ok(/every existing appointment_employees row simply has job_notes = NULL/i.test(proseText));
  });

  test("re-running the file's only ALTER statement is safe (idempotent) -- IF NOT EXISTS guard, exactly once", () => {
    const occurrences = [...sql.matchAll(/ADD COLUMN IF NOT EXISTS job_notes TEXT/g)];
    assert.equal(occurrences.length, 1);
  });
});
