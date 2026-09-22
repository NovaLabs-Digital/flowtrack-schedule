// SOURCE-LEVEL checks of migration 029's SQL text (regression guards on shape,
// ordering, permissions and reuse). These read the file; they do NOT execute
// it. Behavior -- rollback, locking, replay, concurrency, replenishment -- is
// proven by executing the real SQL on a real PostgreSQL instance in
// test-db/recurrence.test.ts (`npm run test:db`).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const read = (name: string) => fs.readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
const sql = read("029_add_atomic_recurrence_change.sql");
const sql027b = read("027b_add_recurring_series_replenishment.sql");

const applyStart = sql.indexOf("CREATE OR REPLACE FUNCTION apply_recurrence_change(");
const applyBody = sql.slice(sql.indexOf("AS $fn$", applyStart), sql.indexOf("$fn$;", applyStart));
const order = (needles: string[]) => needles.map((n) => {
  const i = applyBody.indexOf(n);
  assert.ok(i > -1, `missing in apply_recurrence_change: ${n}`);
  return i;
});
const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]);

describe("migration 029 -- additive and non-destructive", () => {
  test("one transaction, and nothing is dropped, truncated, deleted or rewritten", () => {
    assert.ok(sql.includes("\nBEGIN;\n") && sql.trim().endsWith("COMMIT;"));
    // Function bodies legitimately write (they are the feature); what the
    // migration itself does at top level must be purely additive.
    const outsideFns = sql.replace(/AS \$fn\$[\s\S]*?\$fn\$;/g, "").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").toUpperCase();
    for (const banned of ["DROP TABLE", "DROP COLUMN", "DROP FUNCTION", "TRUNCATE", "DELETE FROM", "ALTER COLUMN", "RENAME"]) {
      assert.ok(!outsideFns.includes(banned), banned);
    }
    for (const w of ["UPDATE APPOINTMENTS", "UPDATE RECURRING_SERIES", "INSERT INTO APPOINTMENTS", "INSERT INTO RECURRING_SERIES"]) assert.ok(!outsideFns.includes(w), w);
  });

  test("new recurring_series columns are additive (IF NOT EXISTS, nullable or defaulted) and lineage deletes never block cleanup", () => {
    assert.match(sql, /ADD COLUMN IF NOT EXISTS excluded_occurrences TIMESTAMPTZ\[\] NOT NULL DEFAULT '\{\}'/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS superseded_series_id UUID REFERENCES recurring_series\(id\) ON DELETE SET NULL/);
  });

  test("the operations table cascades from appointments (demo reset / cleanup never blocked) and restricts only workspace deletion", () => {
    assert.match(sql, /appointment_id\s+UUID NOT NULL REFERENCES appointments\(id\) ON DELETE CASCADE/);
    assert.match(sql, /workspace_id\s+UUID NOT NULL REFERENCES workspaces\(id\) ON DELETE RESTRICT/);
    assert.match(sql, /request_fingerprint\s+TEXT NOT NULL CHECK \(request_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  });
});

describe("migration 029 -- permissions and workspace isolation", () => {
  test("RLS enabled; anon/authenticated/PUBLIC denied; service_role NARROWED (Supabase default privileges grant ALL) to SELECT+INSERT", () => {
    assert.ok(sql.includes("ALTER TABLE recurrence_change_operations ENABLE ROW LEVEL SECURITY;"));
    for (const role of ["PUBLIC", "anon", "authenticated", "service_role"]) {
      assert.ok(sql.includes(`REVOKE ALL ON TABLE recurrence_change_operations FROM ${role};`), role);
    }
    assert.ok(sql.includes("GRANT SELECT, INSERT ON TABLE recurrence_change_operations TO service_role;"));
    assert.ok(sql.indexOf("FROM service_role;") < sql.indexOf("GRANT SELECT, INSERT ON TABLE recurrence_change_operations"));
  });

  test("apply_recurrence_change is SECURITY INVOKER with a pinned search_path and executable only by service_role", () => {
    const header = sql.slice(applyStart, sql.indexOf("AS $fn$", applyStart));
    assert.ok(header.includes("SECURITY INVOKER") && header.includes("SET search_path = public"));
    const sig = "apply_recurrence_change(UUID, UUID, UUID, JSONB, JSONB)";
    for (const role of ["PUBLIC", "anon", "authenticated"]) assert.ok(sql.includes(`REVOKE ALL ON FUNCTION ${sig} FROM ${role};`), role);
    assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`));
  });

  test("every appointment/series/client/assignment access inside the function is scoped by the workspace parameter", () => {
    for (const table of ["appointments", "recurring_series", "clients"]) {
      const re = new RegExp(`FROM ${table}\\s+WHERE[^;]*`, "g");
      const stmts = applyBody.match(re) ?? [];
      assert.ok(stmts.length > 0, table);
      assert.ok(stmts.every((s) => s.includes("workspace_id = p_workspace_id")), `unscoped ${table} read: ${stmts.find((s) => !s.includes("workspace_id = p_workspace_id"))}`);
    }
  });
});

describe("migration 029 -- transaction, rollback and ordering rules (source-level)", () => {
  test("a rejection AFTER writes rolls back via a subtransaction (RAISE 'RC001' caught by an EXCEPTION block), not by returning JSON", () => {
    assert.ok(applyBody.includes("RAISE EXCEPTION 'activation_failed' USING ERRCODE = 'RC001'"));
    assert.ok(applyBody.includes("EXCEPTION WHEN SQLSTATE 'RC001' THEN"));
    // every early `RETURN jsonb_build_object('outcome', <rejection>)` comes before the first write
    const firstWrite = applyBody.indexOf("UPDATE appointments SET status = 'cancelled'");
    const lastRejection = Math.max(...["'employee_not_eligible'", "'assignment_removal_blocked'", "'stale_snapshot'", "'appointment_is_historical'"].map((o) => applyBody.indexOf(o)));
    assert.ok(lastRejection < firstWrite, "rejections happen before any write");
    const beginBlock = applyBody.indexOf("  BEGIN\n    IF cardinality(v_cancel_ids)");
    assert.ok(beginBlock > lastRejection && beginBlock < firstWrite, "the write block starts after all validation");
  });

  test("the operation identity is claimed and a completed identical operation replayed BEFORE any snapshot rejection or business read", () => {
    assert.ok(ascending(order([
      "pg_advisory_xact_lock(hashtext('apply_recurrence_change')",
      "SELECT * INTO v_op FROM recurrence_change_operations",
      "RETURN v_op.result || jsonb_build_object('replayed', TRUE)",
      "RETURN jsonb_build_object('outcome', 'operation_id_conflict')",
      "-- 3. Discovery read",
      "'stale_snapshot'",
    ])));
    assert.ok(applyBody.includes("v_op.workspace_id = p_workspace_id") && applyBody.includes("v_op.appointment_id = p_appointment_id") && applyBody.includes("v_op.request_fingerprint = v_fingerprint"));
  });

  test("the fingerprint binds workspace, appointment and the ENTIRE request; the expected snapshot is deliberately excluded", () => {
    const fp = applyBody.slice(applyBody.indexOf("v_fingerprint := encode("), applyBody.indexOf("'hex'", applyBody.indexOf("v_fingerprint := encode(")));
    assert.ok(fp.includes("p_workspace_id::TEXT") && fp.includes("p_appointment_id::TEXT") && fp.includes("p_request::TEXT"));
    assert.ok(!fp.includes("p_expected"));
    assert.ok(fp.includes("sha256("));
  });

  test("locks are taken in the documented global order, employees LAST (regression: locking employees earlier deadlocked against manual-hours inserts)", () => {
    assert.ok(ascending(order([
      "FROM recurring_series\n    WHERE id = v_disc_series AND workspace_id = p_workspace_id\n    FOR UPDATE",
      "FROM clients\n  WHERE id = v_client_id AND workspace_id = p_workspace_id\n  FOR UPDATE",
      "FROM appointments\n  WHERE id = p_appointment_id AND workspace_id = p_workspace_id\n  FOR UPDATE",
      "PERFORM 1 FROM appointment_employees WHERE appointment_id = p_appointment_id ORDER BY employee_id FOR UPDATE",
      "AND scheduled_for > v_prev_start\n      ORDER BY scheduled_for, id\n      FOR UPDATE",
      "WHERE appointment_id = ANY (v_cand_ids)\n      ORDER BY appointment_id, employee_id\n      FOR UPDATE",
      "PERFORM 1 FROM employees\n    WHERE id = ANY",
      "-- 14. Writes.",
    ])));
  });

  test("recorded work is evaluated in a statement AFTER the sibling locks, and covers timestamps, job notes, manual hours and elapsed end", () => {
    const evalIdx = applyBody.indexOf("(EXISTS (SELECT 1 FROM appointment_employees ae");
    assert.ok(evalIdx > applyBody.indexOf("WHERE appointment_id = ANY (v_cand_ids)"));
    const block = applyBody.slice(evalIdx, applyBody.indexOf(") AS is_protected", evalIdx));
    for (const n of ["actual_started_at IS NOT NULL", "actual_completed_at IS NOT NULL", "job_notes IS NOT NULL", "appointment_employee_hours", "scheduled_end"]) assert.ok(block.includes(n), n);
  });

  test("the original boundary comes from the LOCKED anchor row; nothing takes a previous position from the caller", () => {
    assert.ok(applyBody.includes("v_prev_start := v_appt.scheduled_for;"));
    assert.ok(!/p_request->>'previous/.test(applyBody) && !/previous_scheduled_for'\)::/.test(applyBody));
  });

  test("assignments are DIFFED (never delete-and-reinsert), so recorded work on a kept assignment survives", () => {
    assert.ok(applyBody.includes("DELETE FROM appointment_employees\n      WHERE appointment_id = p_appointment_id AND employee_id = ANY (v_to_remove)"));
    assert.ok(!applyBody.includes("DELETE FROM appointment_employees WHERE appointment_id = p_appointment_id;"));
  });

  test("retained occurrences are excluded durably: carried-forward exclusions + every live old occurrence, stored on the NEW series, and generation filters by them", () => {
    assert.ok(applyBody.includes("v_old_series.excluded_occurrences"));
    assert.ok(applyBody.includes("a.status <> 'cancelled'"));
    assert.ok(applyBody.includes("reviewed_at, excluded_occurrences, superseded_series_id"));
    assert.ok(applyBody.includes("WHERE occ <> ALL (v_exclusions)"));
  });

  test("activation reuses the existing activate_recurring_series function inside the same transaction", () => {
    assert.ok(applyBody.includes("v_act := activate_recurring_series("));
  });
});

describe("migration 029 -- replenish_recurring_series is replaced with ONLY the exclusion filter added", () => {
  test("the replaced function is identical to migration 027b's apart from the three inserted lines", () => {
    const grab = (s: string) => {
      const start = s.indexOf("CREATE OR REPLACE FUNCTION replenish_recurring_series(");
      const endMarker = "GRANT EXECUTE ON FUNCTION replenish_recurring_series(\n  UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ[]\n) TO service_role;";
      return s.slice(start, s.indexOf(endMarker, start) + endMarker.length);
    };
    const original = grab(sql027b);
    const replaced = grab(sql);
    assert.ok(original.length > 1000 && replaced.length > original.length);
    const insertion = "    -- Migration 029: never generate an instant excluded by a replacement\n    -- (retained occurrences with recorded work, carried across A -> B -> C).\n    WHERE occ <> ALL (v_series.excluded_occurrences)\n";
    assert.ok(replaced.includes(insertion));
    assert.equal(replaced.replace(insertion, ""), original);
  });
});

test("no test shims in production SQL: no sleeps or delays anywhere in migrations 029/030", () => {
  for (const f of ["029_add_atomic_recurrence_change.sql", "030_add_work_recording_locking_protocol.sql"]) {
    assert.ok(!/pg_sleep|pg_sleep_for|pg_sleep_until/i.test(read(f)), f);
  }
});
