// SOURCE-LEVEL checks of migration 036's SQL text. They read the file; they
// do NOT execute it. The behavioral change itself (the claim/finalize
// protocol in app/api/cron/reminders/route.ts, and apply_recurrence_change
// clearing the new claim columns on an anchor reschedule) is proven against
// real PostgreSQL in test-db/recurrence.test.ts and test-db/reminder_claims.test.ts.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./036_reminder_claim_protocol.sql", import.meta.url)), "utf8");
const upperSql = sql.toUpperCase();
const body = (name: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  return sql.slice(sql.indexOf("AS $fn$", start), sql.indexOf("$fn$;", start));
};
const fn = body("apply_recurrence_change");

describe("migration 036 -- additive shape", () => {
  test("contains no DROP/TRUNCATE/ALTER COLUMN statement", () => {
    // DELETE FROM is deliberately not banned here -- the copied,
    // unchanged apply_recurrence_change body already deletes a
    // de-assigned employee's appointment_employees row (migrations/029's
    // own pre-existing behavior); this check is about schema-level drops.
    for (const forbidden of ["DROP TABLE", "DROP COLUMN", "TRUNCATE", "ALTER COLUMN"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("adds exactly two new columns on appointments, both guarded with IF NOT EXISTS, nullable, no default", () => {
    const addColumnLines = sql.split("\n").filter((l) => l.trim().startsWith("ALTER TABLE") && l.includes("ADD COLUMN IF NOT EXISTS"));
    assert.equal(addColumnLines.length, 2);
    assert.ok(addColumnLines.every((l) => l.includes("appointments")));
    assert.ok(addColumnLines.some((l) => l.includes("reminder_24h_claimed_at TIMESTAMPTZ")));
    assert.ok(addColumnLines.some((l) => l.includes("reminder_24h_claim_token UUID")));
    assert.ok(addColumnLines.every((l) => !/\bNOT NULL\b/i.test(l) && !/\bDEFAULT\b/i.test(l)));
  });

  test("adds exactly one index, guarded with IF NOT EXISTS, on messages_sent(appointment_id, channel, kind)", () => {
    const createIndexLines = sql.split("\n").filter((l) => l.trim().toUpperCase().startsWith("CREATE INDEX IF NOT EXISTS"));
    assert.equal(createIndexLines.length, 1);
    assert.ok(sql.includes("idx_messages_sent_appt_channel_kind"));
    assert.ok(sql.includes("ON messages_sent (appointment_id, channel, kind)"));
  });

  test("one transaction, one function REPLACED, nothing else dropped or deleted", () => {
    assert.ok(sql.includes("\nBEGIN;\n") && sql.trim().endsWith("COMMIT;"));
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 1);
    assert.ok(sql.includes("CREATE OR REPLACE FUNCTION apply_recurrence_change("));
  });

  test("the function signature is byte-identical to migrations/029's/035's (so its existing grants carry over)", () => {
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

describe("migration 036 -- the claim-invalidation behavior change (source-level)", () => {
  test("the anchor's own UPDATE now also clears both new claim columns, in the same statement that already clears reminder_24h_sent_at", () => {
    const anchorUpdate = fn.slice(fn.indexOf("UPDATE appointments\n    SET scheduled_for"), fn.indexOf("WHERE id = p_appointment_id AND workspace_id = p_workspace_id;\n\n    -- Assignment DIFF"));
    assert.ok(anchorUpdate.includes("scheduled_for  = v_new_start"));
    assert.ok(anchorUpdate.includes("reminder_24h_sent_at = NULL"));
    assert.ok(anchorUpdate.includes("reminder_24h_claimed_at = NULL"));
    assert.ok(anchorUpdate.includes("reminder_24h_claim_token = NULL"));
  });

  test("every other field migrations/029/035 already wrote on the anchor UPDATE is still written, unchanged", () => {
    const anchorUpdate = fn.slice(fn.indexOf("UPDATE appointments\n    SET scheduled_for"), fn.indexOf("WHERE id = p_appointment_id AND workspace_id = p_workspace_id;\n\n    -- Assignment DIFF"));
    for (const field of [
      "scheduled_end  = v_new_end", "service_type   = v_service", "notes          = v_notes",
      "duration_minutes = v_duration", "price_cents    = v_price", "team_color     = v_color",
      "status         = 'scheduled'", "frequency_type = v_freq", "series_id      = v_new_series",
    ]) {
      assert.ok(anchorUpdate.includes(field), field);
    }
  });

  test("newly INSERTed replacement occurrences are untouched -- a fresh row has no default for either claim column, so both already start NULL", () => {
    const insertCols = fn.slice(fn.indexOf("INSERT INTO appointments ("), fn.indexOf("FROM unnest(v_occ) occ"));
    assert.ok(!insertCols.includes("reminder_24h_claimed_at") && !insertCols.includes("reminder_24h_claim_token"));
  });

  test("the cancel-siblings UPDATE (status = 'cancelled') is unchanged -- this migration only touches the anchor's own UPDATE", () => {
    assert.ok(fn.includes("UPDATE appointments SET status = 'cancelled'\n      WHERE id = ANY (v_cancel_ids)"));
  });
});
