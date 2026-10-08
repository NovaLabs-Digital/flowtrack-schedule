// SOURCE-LEVEL checks of migration 035's SQL text. They read the file; they
// do NOT execute it. The behavioral change itself (apply_recurrence_change
// clears reminder_24h_sent_at on the anchor row it reschedules) is proven
// against real PostgreSQL in test-db/recurrence.test.ts (`npm run test:db`).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./035_reset_reminder_on_recurrence_change.sql", import.meta.url)), "utf8");
const body = (name: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  return sql.slice(sql.indexOf("AS $fn$", start), sql.indexOf("$fn$;", start));
};
const fn = body("apply_recurrence_change");

describe("migration 035 -- additive shape and permissions", () => {
  test("one transaction, one function REPLACED (no table, column, or index change), nothing dropped or deleted", () => {
    assert.ok(sql.includes("\nBEGIN;\n") && sql.trim().endsWith("COMMIT;"));
    // DELETE FROM is deliberately not banned here -- the copied, unchanged
    // function body already deletes a de-assigned employee's
    // appointment_employees row (migrations/029's own behavior); this check
    // is about schema-level drops, not that pre-existing data statement.
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").toUpperCase();
    for (const banned of ["DROP ", "TRUNCATE", "ALTER TABLE", "CREATE TABLE", "CREATE INDEX"]) {
      assert.ok(!code.includes(banned), banned);
    }
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 1);
    assert.ok(sql.includes("CREATE OR REPLACE FUNCTION apply_recurrence_change("));
  });

  test("the function signature is byte-identical to migrations/029's (so its existing grants carry over)", () => {
    const params = "p_workspace_id   UUID,\n  p_appointment_id UUID,\n  p_operation_id   UUID,\n  p_request        JSONB,\n  p_expected       JSONB";
    assert.ok(sql.includes(params));
    assert.ok(sql.includes("RETURNS JSONB\nLANGUAGE plpgsql\nSECURITY INVOKER\nSET search_path = public"));
  });

  test("still executable only by service_role, restated defensively", () => {
    const sig = "apply_recurrence_change(UUID, UUID, UUID, JSONB, JSONB)";
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      assert.ok(sql.includes(`REVOKE ALL ON FUNCTION ${sig} FROM ${role};`), role);
    }
    assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`));
  });
});

describe("migration 035 -- the reminder-reset behavior change (source-level)", () => {
  test("the anchor's own UPDATE now also clears reminder_24h_sent_at, in the same statement that rewrites scheduled_for", () => {
    const anchorUpdate = fn.slice(fn.indexOf("UPDATE appointments\n    SET scheduled_for"), fn.indexOf("WHERE id = p_appointment_id AND workspace_id = p_workspace_id;\n\n    -- Assignment DIFF"));
    assert.ok(anchorUpdate.includes("scheduled_for  = v_new_start"));
    assert.ok(anchorUpdate.includes("reminder_24h_sent_at = NULL"));
  });

  test("every other field migrations/029 already wrote on the anchor UPDATE is still written, unchanged", () => {
    const anchorUpdate = fn.slice(fn.indexOf("UPDATE appointments\n    SET scheduled_for"), fn.indexOf("WHERE id = p_appointment_id AND workspace_id = p_workspace_id;\n\n    -- Assignment DIFF"));
    for (const field of [
      "scheduled_end  = v_new_end", "service_type   = v_service", "notes          = v_notes",
      "duration_minutes = v_duration", "price_cents    = v_price", "team_color     = v_color",
      "status         = 'scheduled'", "frequency_type = v_freq", "series_id      = v_new_series",
    ]) {
      assert.ok(anchorUpdate.includes(field), field);
    }
  });

  test("newly INSERTed replacement occurrences are untouched by this migration -- a fresh row has no reminder_24h_sent_at default, so it already starts NULL", () => {
    const insertCols = fn.slice(fn.indexOf("INSERT INTO appointments ("), fn.indexOf("FROM unnest(v_occ) occ"));
    assert.ok(!insertCols.includes("reminder_24h_sent_at"), "the INSERT column list was not touched by this migration");
  });

  test("the cancel-siblings UPDATE (status = 'cancelled') is unchanged -- this migration only touches the anchor's own UPDATE", () => {
    assert.ok(fn.includes("UPDATE appointments SET status = 'cancelled'\n      WHERE id = ANY (v_cancel_ids)"));
  });
});
