// SOURCE-LEVEL checks of migration 040's SQL text, mirroring migrations/038's
// own test file exactly. They read the file; they do NOT execute it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./040_add_messages_sent_subject.sql", import.meta.url)), "utf8");

describe("migration 040 -- additive shape", () => {
  test("one transaction, exactly one ALTER TABLE statement, nothing dropped, deleted, or truncated", () => {
    assert.ok(sql.includes("\nBEGIN;\n") && sql.trim().endsWith("COMMIT;"));
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").toUpperCase();
    for (const banned of ["DROP ", "TRUNCATE", "DELETE FROM", "CREATE TABLE", "CREATE INDEX", "ALTER COLUMN", "CREATE OR REPLACE FUNCTION"]) {
      assert.ok(!code.includes(banned), banned);
    }
    const alterLines = sql.split("\n").filter((l) => l.trim().startsWith("ALTER TABLE"));
    assert.equal(alterLines.length, 1);
    assert.ok(alterLines[0].includes("messages_sent"));
  });

  test("adds subject (TEXT), guarded with IF NOT EXISTS, nullable, no default", () => {
    assert.ok(sql.includes("ALTER TABLE messages_sent ADD COLUMN IF NOT EXISTS subject TEXT;"));
    assert.ok(!/\bNOT NULL\b/i.test(sql) && !/\bDEFAULT\b/i.test(sql));
  });

  test("touches no function, grant, or revoke -- purely a schema addition", () => {
    assert.equal((sql.match(/\bGRANT\b/gi) ?? []).length, 0);
    assert.equal((sql.match(/\bREVOKE\b/gi) ?? []).length, 0);
  });
});
