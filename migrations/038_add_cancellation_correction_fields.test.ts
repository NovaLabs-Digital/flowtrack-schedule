// SOURCE-LEVEL checks of migration 038's SQL text. They read the file; they
// do NOT execute it. The behavioral change itself (the delete route's
// historical-cancellation-correction logic) is proven at the route level in
// app/api/appointments/delete/route.test.ts.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./038_add_cancellation_correction_fields.sql", import.meta.url)), "utf8");

describe("migration 038 -- additive shape", () => {
  test("one transaction, exactly three ALTER TABLE statements, nothing dropped, deleted, or truncated", () => {
    assert.ok(sql.includes("\nBEGIN;\n") && sql.trim().endsWith("COMMIT;"));
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").toUpperCase();
    for (const banned of ["DROP ", "TRUNCATE", "DELETE FROM", "CREATE TABLE", "CREATE INDEX", "ALTER COLUMN", "CREATE OR REPLACE FUNCTION"]) {
      assert.ok(!code.includes(banned), banned);
    }
    const alterLines = sql.split("\n").filter((l) => l.trim().startsWith("ALTER TABLE"));
    assert.equal(alterLines.length, 3);
    assert.ok(alterLines.every((l) => l.includes("appointments")));
  });

  test("adds cancelled_at (TIMESTAMPTZ), cancellation_reported_date (DATE), cancellation_reason (TEXT) -- all guarded with IF NOT EXISTS, nullable, no default", () => {
    assert.ok(sql.includes("ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;"));
    assert.ok(sql.includes("ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancellation_reported_date DATE;"));
    assert.ok(sql.includes("ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;"));
    assert.ok(!/\bNOT NULL\b/i.test(sql) && !/\bDEFAULT\b/i.test(sql));
  });

  test("touches no function, grant, or revoke -- purely a schema addition", () => {
    assert.equal((sql.match(/\bGRANT\b/gi) ?? []).length, 0);
    assert.equal((sql.match(/\bREVOKE\b/gi) ?? []).length, 0);
  });
});
