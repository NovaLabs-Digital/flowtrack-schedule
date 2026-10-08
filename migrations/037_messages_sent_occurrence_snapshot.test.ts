// SOURCE-LEVEL checks of migration 037's SQL text. They read the file; they
// do NOT execute it. The behavioral change itself (alreadyDelivered()
// matching on the exact scheduled occurrence, and historical NULL rows never
// suppressing a new one) is proven at the route level in
// app/api/cron/reminders/route.test.ts.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./037_messages_sent_occurrence_snapshot.sql", import.meta.url)), "utf8");

describe("migration 037 -- additive shape", () => {
  test("one transaction, exactly one ALTER TABLE, nothing dropped, deleted, or truncated", () => {
    assert.ok(sql.includes("\nBEGIN;\n") && sql.trim().endsWith("COMMIT;"));
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").toUpperCase();
    for (const banned of ["DROP ", "TRUNCATE", "DELETE FROM", "CREATE TABLE", "CREATE INDEX", "ALTER COLUMN"]) {
      assert.ok(!code.includes(banned), banned);
    }
    const alterLines = sql.split("\n").filter((l) => l.trim().startsWith("ALTER TABLE"));
    assert.equal(alterLines.length, 1);
  });

  test("adds exactly one column, on messages_sent, guarded with IF NOT EXISTS, nullable, no default", () => {
    assert.ok(sql.includes("ALTER TABLE messages_sent ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;"));
    assert.ok(!/\bNOT NULL\b/i.test(sql) && !/\bDEFAULT\b/i.test(sql));
  });

  test("touches no function, grant, or revoke -- purely a schema addition", () => {
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 0);
    assert.equal((sql.match(/\bGRANT\b/gi) ?? []).length, 0);
    assert.equal((sql.match(/\bREVOKE\b/gi) ?? []).length, 0);
  });
});
