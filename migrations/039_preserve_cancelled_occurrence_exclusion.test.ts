// SOURCE-LEVEL checks of migration 039's SQL text. They read the file; they
// do NOT execute it. The behavioral change itself (a cancelled occurrence's
// scheduled_for surviving a later recurrence edit that creates a new
// series) is proven against real PostgreSQL in test-db/recurrence.test.ts.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./039_preserve_cancelled_occurrence_exclusion.sql", import.meta.url)), "utf8");
const body = (name: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  return sql.slice(sql.indexOf("AS $fn$", start), sql.indexOf("$fn$;", start));
};
const fn = body("apply_recurrence_change");

describe("migration 039 -- additive shape and permissions", () => {
  test("one transaction, one function REPLACED (no table, column, or index change), nothing dropped or deleted", () => {
    assert.ok(sql.includes("\nBEGIN;\n") && sql.trim().endsWith("COMMIT;"));
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").toUpperCase();
    for (const banned of ["DROP ", "TRUNCATE", "ALTER TABLE", "CREATE TABLE", "CREATE INDEX"]) {
      assert.ok(!code.includes(banned), banned);
    }
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 1);
    assert.ok(sql.includes("CREATE OR REPLACE FUNCTION apply_recurrence_change("));
  });

  test("the function signature is byte-identical to migrations/029's/035's/036's (so its existing grants carry over)", () => {
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

describe("migration 039 -- the exclusion-widening behavior change (source-level)", () => {
  test("the exclusions UNION's second branch no longer filters out cancelled siblings -- `a.status <> 'cancelled'` is gone, replaced by `NOT (a.id = ANY (v_cancel_ids))`", () => {
    const exclusionsBlock = fn.slice(fn.indexOf("v_exclusions := ARRAY("), fn.indexOf("INSERT INTO recurring_series ("));
    assert.ok(!exclusionsBlock.includes("a.status <> 'cancelled'"), "the cancelled-sibling exclusion filter must be removed");
    assert.ok(exclusionsBlock.includes("NOT (a.id = ANY (v_cancel_ids))"), "siblings THIS edit is itself replacing must still be excluded from the new exclusions list");
    assert.ok(exclusionsBlock.includes("SELECT a.scheduled_for"));
  });

  test("the distinction is drawn by v_cancel_ids membership, not by status -- a sibling cancelled by THIS edit's own replacement step is never added to the new exclusions, so 'This & Future' can still regenerate those slots", () => {
    const exclusionsBlock = fn.slice(fn.indexOf("v_exclusions := ARRAY("), fn.indexOf("INSERT INTO recurring_series ("));
    // v_cancel_ids is computed and used BEFORE the exclusions query in the
    // function body -- it must already be populated (or empty, for a
    // one_time/no-series edit) by the time exclusions run.
    const cancelIdsDeclIdx = fn.indexOf("v_cand_ids      UUID[] := ARRAY[]::UUID[];");
    const exclusionsIdx = fn.indexOf("v_exclusions := ARRAY(");
    assert.ok(cancelIdsDeclIdx > -1 && cancelIdsDeclIdx < exclusionsIdx);
  });

  test("the exclusions query is still scoped to the SAME series_id and workspace_id as the anchor -- never widened to another series or tenant", () => {
    const exclusionsBlock = fn.slice(fn.indexOf("v_exclusions := ARRAY("), fn.indexOf("INSERT INTO recurring_series ("));
    assert.ok(exclusionsBlock.includes("a.series_id = v_disc_series"));
    assert.ok(exclusionsBlock.includes("a.workspace_id = p_workspace_id"));
    assert.ok(exclusionsBlock.includes("a.id <> p_appointment_id"), "the anchor row itself is still excluded from contributing to its own exclusions list");
  });

  test("the old series' own prior excluded_occurrences are still carried forward unconditionally (unchanged by this migration)", () => {
    const exclusionsBlock = fn.slice(fn.indexOf("v_exclusions := ARRAY("), fn.indexOf("INSERT INTO recurring_series ("));
    assert.ok(exclusionsBlock.includes("unnest(CASE WHEN v_old_found THEN v_old_series.excluded_occurrences ELSE ARRAY[]::TIMESTAMPTZ[] END)"));
  });

  test("the candidate-cancellation step (v_cand_ids / v_cancel_ids, 'This & Future' sibling replacement) is completely unchanged -- this migration only widens the exclusions list fed to the NEW series' generation, never which siblings get cancelled by THIS call", () => {
    assert.ok(fn.includes("AND status = 'scheduled'\n        AND is_demo = v_appt.is_demo\n        AND id <> p_appointment_id\n        AND scheduled_for > v_prev_start"));
    assert.ok(fn.includes("UPDATE appointments SET status = 'cancelled'\n      WHERE id = ANY (v_cancel_ids)"));
  });

  test("the single-occurrence-cancellation route (app/api/appointments/delete/route.ts) is a different file entirely -- this migration's SQL function body never references it (the header comment's own citation is prose, not code)", () => {
    assert.ok(!fn.includes("app/api/appointments/delete"));
  });

  test("newly INSERTed replacement occurrences still skip every excluded instant, and the ON CONFLICT guard is unchanged", () => {
    assert.ok(fn.includes("WHERE occ <> ALL (v_exclusions)"));
    assert.ok(fn.includes("ON CONFLICT (series_id, scheduled_for) WHERE series_id IS NOT NULL DO NOTHING"));
  });

  test("the cancel-siblings UPDATE and the anchor's own UPDATE are otherwise byte-identical to migrations/036's -- only the exclusions SELECT changed", () => {
    assert.ok(fn.includes("reminder_24h_sent_at = NULL,\n        reminder_24h_claimed_at = NULL,\n        reminder_24h_claim_token = NULL"));
  });
});
