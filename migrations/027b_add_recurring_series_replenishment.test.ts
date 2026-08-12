// Block 2C-2B: static, source-level proof that migration 027b is additive,
// non-destructive, and that its new constraints/functions have the exact
// shape the design requires. Migrations are never executed by this test
// suite (no database is reachable from tests anywhere in this repository,
// confirmed again this round -- no psql/postgres/docker/pg driver
// available) -- this file proves the SQL text itself, matching the same
// "prove it from source" discipline as every prior migration's own test.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./027b_add_recurring_series_replenishment.sql", import.meta.url)), "utf8");

// Two functions this migration defines, isolated the identical way
// migrations/027a's own test file already established: the body between
// each "AS $fn$" and its matching "$fn$;", the second search starting
// immediately after the first function's own closing marker so it can
// never accidentally re-match the first function's body.
const fnBodyStart = sql.indexOf("AS $fn$");
const fnBodyEnd = sql.indexOf("$fn$;", fnBodyStart);
const fnBody = sql.slice(fnBodyStart, fnBodyEnd); // replenish_recurring_series
const beforeFnBody = sql.slice(0, fnBodyStart);

const quarantineFnBodyStart = sql.indexOf("AS $fn$", fnBodyEnd + 5);
const quarantineFnBodyEnd = sql.indexOf("$fn$;", quarantineFnBodyStart);
const quarantineFnBody = sql.slice(quarantineFnBodyStart, quarantineFnBodyEnd); // quarantine_recurring_series_for_replenishment
const afterQuarantineFnBody = sql.slice(quarantineFnBodyEnd);

const topLevel = beforeFnBody + afterQuarantineFnBody;

describe("migration 027b -- additive, non-destructive, safely re-runnable shape", () => {
  test("wrapped in an explicit BEGIN/COMMIT transaction", () => {
    assert.ok(/^\s*(--.*\n)*BEGIN;/m.test(sql) || sql.includes("BEGIN;"));
    assert.ok(sql.trim().endsWith("COMMIT;"));
  });

  test("the migration's own top-level statements never UPDATE, INSERT INTO, or DELETE FROM recurring_series, appointments, or appointment_employees", () => {
    const topLevelUpper = topLevel.toUpperCase();
    for (const table of ["RECURRING_SERIES", "APPOINTMENTS", "APPOINTMENT_EMPLOYEES"]) {
      assert.ok(!new RegExp(`UPDATE\\s+${table}\\b`).test(topLevelUpper), `top-level migration text must not UPDATE ${table}`);
      assert.ok(!new RegExp(`INSERT\\s+INTO\\s+${table}\\b`).test(topLevelUpper), `top-level migration text must not INSERT INTO ${table}`);
      assert.ok(!new RegExp(`DELETE\\s+FROM\\s+${table}\\b`).test(topLevelUpper), `top-level migration text must not DELETE FROM ${table}`);
    }
  });

  test("contains no DROP TABLE/DROP COLUMN/TRUNCATE/ALTER COLUMN anywhere", () => {
    const upper = sql.toUpperCase();
    assert.ok(!/DROP TABLE/.test(upper));
    assert.ok(!/DROP COLUMN/.test(upper));
    assert.ok(!/TRUNCATE/.test(upper));
    assert.ok(!/ALTER COLUMN/.test(upper));
  });

  test("does not touch migrations 026/027a's own existing constraints, columns, or functions -- no ALTER TABLE ADD COLUMN, no DROP CONSTRAINT anywhere", () => {
    assert.ok(!/ADD COLUMN/.test(sql.toUpperCase()));
    assert.ok(!/DROP CONSTRAINT/.test(sql.toUpperCase()));
  });

  test("both new CHECK constraints are guarded by an information_schema existence probe (safely re-runnable)", () => {
    for (const name of ["recurring_series_active_snapshot_complete", "recurring_series_review_reason_only_when_review_required"]) {
      const guardRe = new RegExp(
        `IF NOT EXISTS \\(\\s*SELECT 1 FROM information_schema\\.table_constraints\\s*\\n\\s*WHERE table_name = 'recurring_series' AND constraint_name = '${name}'`
      );
      assert.ok(guardRe.test(sql), `expected an existence guard for ${name}`);
    }
  });

  test("production-review correction: no custom PostgreSQL type is created anywhere -- no CREATE TYPE statement, no pg_type existence probe", () => {
    assert.ok(!/CREATE TYPE/.test(sql));
    assert.ok(!/pg_type/.test(sql));
    assert.ok(!/replenish_recurring_series_result/.test(sql));
  });

  test("both CREATE FUNCTION statements use CREATE OR REPLACE (idempotently re-runnable)", () => {
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION replenish_recurring_series\(/g) ?? []).length, 1);
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION quarantine_recurring_series_for_replenishment\(/g) ?? []).length, 1);
  });
});

describe("migration 027b -- recurring_series_active_snapshot_complete constraint", () => {
  const constraintStart = sql.indexOf("ADD CONSTRAINT recurring_series_active_snapshot_complete");
  const constraintText = sql.slice(constraintStart, sql.indexOf("END $$;", constraintStart));

  test("gated by status IS DISTINCT FROM 'active' (NULL-safe), not a bare <> -- vacuously true for every non-active row", () => {
    assert.ok(/status IS DISTINCT FROM 'active'/.test(constraintText));
    assert.ok(!/status <> 'active'/.test(constraintText));
  });

  test("requires every field the task specifies for an active row", () => {
    for (const field of [
      "snapshot_service_type IS NOT NULL AND snapshot_service_type <> ''",
      "snapshot_duration_minutes IS NOT NULL AND snapshot_duration_minutes > 0",
      "snapshot_employee_ids IS NOT NULL",
      "snapshot_updated_at IS NOT NULL",
      "template_appointment_id IS NOT NULL",
      "reviewed_at IS NOT NULL",
      "review_reason IS NULL",
      "anchor_local_date IS NOT NULL",
      "anchor_local_time IS NOT NULL",
      "anchor_timezone IS NOT NULL",
    ]) {
      assert.ok(constraintText.includes(field), `expected active-row requirement: ${field}`);
    }
  });

  test("does NOT require snapshot_price_cents, snapshot_notes, or snapshot_team_color to be non-NULL", () => {
    assert.ok(!/snapshot_price_cents IS NOT NULL/.test(constraintText));
    assert.ok(!/snapshot_notes IS NOT NULL/.test(constraintText));
    assert.ok(!/snapshot_team_color IS NOT NULL/.test(constraintText));
  });

  test("contains no subquery -- PostgreSQL CHECK constraints cannot contain one at all", () => {
    assert.ok(!/SELECT/i.test(constraintText.replace(/-- .*/g, "")), "constraint body must contain no SELECT (i.e. no subquery)");
  });
});

describe("migration 027b -- review_reason lifecycle constraint", () => {
  test("review_reason may be non-NULL only while status IS NOT DISTINCT FROM 'review_required' (NULL-safe), not a bare =", () => {
    assert.ok(/CHECK \(review_reason IS NULL OR status IS NOT DISTINCT FROM 'review_required'\)/.test(sql));
  });

  test("this single CHECK is not duplicated as three separate near-identical constraints", () => {
    assert.equal((sql.match(/ADD CONSTRAINT recurring_series_review_reason_only_when_review_required/g) ?? []).length, 1);
  });
});

describe("migration 027b -- replenish_recurring_series: security posture", () => {
  test("declared SECURITY INVOKER, never SECURITY DEFINER", () => {
    const beforeFn = sql.slice(0, fnBodyStart);
    const fnDeclStart = beforeFn.lastIndexOf("CREATE OR REPLACE FUNCTION replenish_recurring_series");
    const fnDecl = sql.slice(fnDeclStart, fnBodyStart);
    assert.ok(/SECURITY INVOKER/.test(fnDecl));
    assert.ok(!/SECURITY DEFINER/.test(fnDecl));
  });

  test("declares an explicit SET search_path", () => {
    const beforeFn = sql.slice(0, fnBodyStart);
    const fnDeclStart = beforeFn.lastIndexOf("CREATE OR REPLACE FUNCTION replenish_recurring_series");
    assert.ok(/SET search_path = public/.test(sql.slice(fnDeclStart, fnBodyStart)));
  });

  test("language is plpgsql", () => {
    const beforeFn = sql.slice(0, fnBodyStart);
    const fnDeclStart = beforeFn.lastIndexOf("CREATE OR REPLACE FUNCTION replenish_recurring_series");
    assert.ok(/LANGUAGE plpgsql/.test(sql.slice(fnDeclStart, fnBodyStart)));
  });

  test("production-review correction: returns JSONB, not a custom composite type, TABLE, or SETOF", () => {
    const beforeFn = sql.slice(0, fnBodyStart);
    const fnDeclStart = beforeFn.lastIndexOf("CREATE OR REPLACE FUNCTION replenish_recurring_series");
    const decl = sql.slice(fnDeclStart, fnBodyStart);
    assert.ok(/RETURNS JSONB/.test(decl));
    assert.ok(!/RETURNS TABLE/.test(decl));
    assert.ok(!/RETURNS SETOF/.test(decl));
  });
});

describe("migration 027b -- replenish_recurring_series: exact grants and revokes", () => {
  const sig = "UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ\\[\\]";

  test("EXECUTE is revoked from PUBLIC, anon, and authenticated -- each exactly once", () => {
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      const re = new RegExp(`REVOKE ALL ON FUNCTION replenish_recurring_series\\(\\s*${sig}\\s*\\) FROM ${role};`);
      assert.ok(re.test(sql), `expected REVOKE ALL ... FROM ${role}`);
    }
  });

  test("EXECUTE is granted to service_role exactly once, and to no other role", () => {
    const grants = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION replenish_recurring_series\([^)]*\) TO (\w+);/g)];
    assert.equal(grants.length, 1);
    assert.equal(grants[0][1], "service_role");
  });
});

describe("migration 027b -- replenish_recurring_series: exact caller signature", () => {
  test("accepts exactly p_series_id, p_workspace_id, p_expected_snapshot_updated_at, p_occurrences -- no snapshot business fields", () => {
    const beforeFn = sql.slice(0, fnBodyStart);
    const fnDeclStart = beforeFn.lastIndexOf("CREATE OR REPLACE FUNCTION replenish_recurring_series");
    const decl = sql.slice(fnDeclStart, fnBodyStart);
    assert.ok(/p_series_id\s+UUID/.test(decl));
    assert.ok(/p_workspace_id\s+UUID/.test(decl));
    assert.ok(/p_expected_snapshot_updated_at\s+TIMESTAMPTZ/.test(decl));
    assert.ok(/p_occurrences\s+TIMESTAMPTZ\[\]/.test(decl));
    for (const forbidden of [
      "p_service_type", "p_price_cents", "p_duration_minutes", "p_notes", "p_team_color", "p_employee_ids",
    ]) {
      assert.ok(!decl.includes(forbidden), `must not accept ${forbidden} as a parameter -- read from the locked row instead`);
    }
  });

  test("every snapshot business value used in the INSERT is read from v_series (the locked row), never from a bare p_ parameter", () => {
    for (const field of [
      "v_series.client_id", "v_series.snapshot_service_type", "v_series.snapshot_notes",
      "v_series.snapshot_duration_minutes", "v_series.snapshot_price_cents", "v_series.snapshot_team_color",
      "v_series.snapshot_employee_ids", "v_series.is_demo", "v_series.frequency_type",
      "v_series.repeat_weeks", "v_series.repeat_months",
    ]) {
      assert.ok(fnBody.includes(field), `expected the INSERT to source ${field} from the locked row`);
    }
  });
});

describe("migration 027b -- replenish_recurring_series: occurrence array validation", () => {
  test("rejects a NULL p_occurrences, before any lock", () => {
    const nullCheckIdx = fnBody.indexOf("IF p_occurrences IS NULL THEN");
    const lockIdx = fnBody.indexOf("FOR UPDATE");
    assert.ok(nullCheckIdx > -1 && lockIdx > -1 && nullCheckIdx < lockIdx);
  });

  test("rejects a NULL p_expected_snapshot_updated_at, before any lock", () => {
    const nullCheckIdx = fnBody.indexOf("IF p_expected_snapshot_updated_at IS NULL THEN");
    const lockIdx = fnBody.indexOf("FOR UPDATE");
    assert.ok(nullCheckIdx > -1 && lockIdx > -1 && nullCheckIdx < lockIdx);
  });

  test("enforces cardinality between 1 and 20 inclusive, via cardinality() not array_length()", () => {
    assert.ok(fnBody.includes("cardinality(p_occurrences) < 1 OR cardinality(p_occurrences) > 20"));
    assert.ok(!/array_length\(p_occurrences/.test(fnBody));
  });

  test("rejects any NULL element", () => {
    assert.ok(fnBody.includes("FROM unnest(p_occurrences) occ WHERE occ IS NULL"));
  });

  test("strictly-increasing check uses WITH ORDINALITY + LAG over the array's OWN given order, not a re-sorted copy", () => {
    assert.ok(fnBody.includes("WITH ORDINALITY AS t(occ, ord)"));
    assert.ok(fnBody.includes("LAG(occ) OVER (ORDER BY ord)"));
    assert.ok(fnBody.includes("prev_occ IS NOT NULL AND occ <= prev_occ"));
  });

  test("rejects any occurrence that is not strictly future at execution time, compared against the database's own now()", () => {
    assert.ok(fnBody.includes("FROM unnest(p_occurrences) occ WHERE occ <= now()"));
  });

  test("every occurrence-array validation failure returns a jsonb_build_object with outcome invalid_input and zero counts", () => {
    const validationBlock = fnBody.slice(0, fnBody.indexOf("SELECT * INTO v_series"));
    const returns = [
      ...validationBlock.matchAll(
        /RETURN jsonb_build_object\('outcome', '([a-z_]+)', 'inserted_count', (\d+), 'skipped_count', (\d+)\);/g
      ),
    ];
    assert.ok(returns.length >= 5, "expected multiple invalid_input early returns before the first lock");
    for (const m of returns) {
      assert.equal(m[1], "invalid_input");
      assert.equal(m[2], "0");
      assert.equal(m[3], "0");
    }
  });
});

describe("migration 027b -- replenish_recurring_series: fixed lock order", () => {
  test("locks recurring_series, then clients, then employees, in that exact positional order", () => {
    const markers = [
      "FROM recurring_series\n  WHERE id = p_series_id",
      "FROM clients\n  WHERE id = v_series.client_id",
      "FROM employees WHERE id = ANY(v_series.snapshot_employee_ids)",
    ];
    const positions = markers.map((m) => fnBody.indexOf(m));
    for (let i = 0; i < positions.length; i++) {
      assert.ok(positions[i] > -1, `expected to find lock-order marker: ${markers[i]}`);
    }
    for (let i = 1; i < positions.length; i++) {
      assert.ok(positions[i] > positions[i - 1], `lock order violated: "${markers[i]}" must come after "${markers[i - 1]}"`);
    }
  });

  test("the recurring_series lock is scoped by id AND workspace_id together, matching activate_recurring_series's own step 1", () => {
    assert.ok(fnBody.includes("WHERE id = p_series_id AND workspace_id = p_workspace_id"));
  });

  test("the clients lock is scoped by the LOCKED series' own client_id AND workspace_id, never a caller-supplied client id", () => {
    assert.ok(fnBody.includes("WHERE id = v_series.client_id AND workspace_id = p_workspace_id"));
  });

  test("employees are locked in deterministic UUID order (ORDER BY id) -- matching sync_appointment_assignments's own precedent", () => {
    assert.ok(fnBody.includes("PERFORM 1 FROM employees WHERE id = ANY(v_series.snapshot_employee_ids) ORDER BY id FOR UPDATE;"));
  });

  test("the employee-eligibility block is skipped (not an error) for a genuinely empty snapshot employee set", () => {
    assert.ok(fnBody.includes("IF cardinality(v_series.snapshot_employee_ids) > 0 THEN"));
  });
});

describe("migration 027b -- replenish_recurring_series: no aggregate combined with FOR UPDATE/FOR SHARE anywhere", () => {
  function stripLineComments(body: string): string {
    return body
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
  }
  // Splits on statement-terminating semicolons AND on a line-ending "THEN"
  // (an IF/WHEN control-flow header, never itself part of the following
  // SQL statement) -- without the second split point, "IF cardinality(...)
  // > 0 THEN\n  PERFORM ... FOR UPDATE;" is one naive semicolon-delimited
  // chunk containing both an aggregate-looking call and a locking clause,
  // even though they belong to two entirely separate PL/pgSQL statements.
  // An inline "CASE WHEN x THEN y ELSE z END" (same line, no newline
  // immediately after THEN) is unaffected -- this only matches a
  // line-ending THEN.
  function statementsOf(body: string): string[] {
    return stripLineComments(body).split(/;\s*\n|THEN\s*\n/);
  }

  test("no statement combines an aggregate function (array_agg/count/sum/avg/min/max/cardinality) with FOR UPDATE or FOR SHARE", () => {
    for (const stmt of statementsOf(fnBody)) {
      const hasAggregate = /\b(array_agg|count|sum|avg|min|max|cardinality)\s*\(/i.test(stmt);
      const hasLockClause = /\bFOR (UPDATE|SHARE)\b/.test(stmt);
      assert.ok(
        !(hasAggregate && hasLockClause),
        `a statement combines an aggregate with a locking clause, which PostgreSQL rejects outright: ${stmt.trim().slice(0, 160)}`
      );
    }
  });
});

describe("migration 027b -- replenish_recurring_series: identity and state validation", () => {
  test("a missing recurring_series row (wrong id/workspace) returns conflict", () => {
    assert.ok(
      /IF NOT FOUND THEN\s*\n\s*RETURN jsonb_build_object\('outcome', 'conflict', 'inserted_count', 0, 'skipped_count', 0\);/.test(fnBody)
    );
  });

  test("status must be exactly 'active', via NULL-safe IS DISTINCT FROM, never a bare <>/=", () => {
    assert.ok(fnBody.includes("IF v_series.status IS DISTINCT FROM 'active' THEN"));
    assert.ok(!/v_series\.status\s*<>\s*'active'/.test(fnBody));
    assert.ok(!/v_series\.status\s*=\s*'active'/.test(fnBody.replace(/IS DISTINCT FROM 'active'/g, "")));
  });

  test("snapshot_updated_at is compared to the expected value via NULL-safe IS DISTINCT FROM, never a bare <>/=", () => {
    assert.ok(fnBody.includes("IF v_series.snapshot_updated_at IS DISTINCT FROM p_expected_snapshot_updated_at THEN"));
  });
});

describe("migration 027b -- replenish_recurring_series: snapshot/metadata completeness quarantine (missing_snapshot_review_required)", () => {
  const snapshotCheckIdx = fnBody.indexOf("IF NOT COALESCE(\n    v_series.snapshot_service_type");
  const snapshotCheckEndIdx = fnBody.indexOf("END IF;", fnBody.indexOf("missing_snapshot_review_required", snapshotCheckIdx));
  const snapshotCheckBlock = fnBody.slice(snapshotCheckIdx, snapshotCheckEndIdx + "END IF;".length);

  test("production-review correction: wraps the entire completeness expression in COALESCE(..., FALSE) -- an unexpected NULL anywhere inside must fail closed (quarantine fires), never silently skip the check the way PL/pgSQL's IF treats a bare NULL condition as FALSE", () => {
    assert.ok(snapshotCheckIdx > -1, "expected to find the COALESCE-wrapped completeness check");
    assert.ok(snapshotCheckBlock.includes(",\n    FALSE\n  ) THEN"), "expected the COALESCE(..., FALSE) closing form");
  });

  test("no bare, unwrapped 'IF NOT (' form remains for this check -- the COALESCE wrapper is not merely supplemented, the old NULL-unsafe form is fully removed", () => {
    assert.ok(!fnBody.includes("IF NOT (\n    v_series.snapshot_service_type"));
  });

  test("re-verifies every required snapshot field, matching Part 1's own active-completeness CHECK", () => {
    for (const field of [
      "v_series.snapshot_service_type IS NOT NULL AND v_series.snapshot_service_type <> ''",
      "v_series.snapshot_duration_minutes IS NOT NULL AND v_series.snapshot_duration_minutes > 0",
      "v_series.snapshot_employee_ids IS NOT NULL",
      "v_series.snapshot_updated_at IS NOT NULL",
      "v_series.template_appointment_id IS NOT NULL",
      "v_series.reviewed_at IS NOT NULL",
      "v_series.review_reason IS NULL",
    ]) {
      assert.ok(snapshotCheckBlock.includes(field), `expected ${field}`);
    }
  });

  test("also re-verifies frequency_type/repeat_weeks/repeat_months internal consistency, mirroring migration 026's own CHECK", () => {
    assert.ok(snapshotCheckBlock.includes("v_series.frequency_type = 'weekly' AND v_series.repeat_weeks BETWEEN 1 AND 8 AND v_series.repeat_months IS NULL"));
    assert.ok(snapshotCheckBlock.includes("v_series.frequency_type = 'monthly' AND v_series.repeat_months BETWEEN 1 AND 12 AND v_series.repeat_weeks IS NULL"));
    assert.ok(snapshotCheckBlock.includes("v_series.frequency_type IN ('daily', 'weekdays') AND v_series.repeat_weeks IS NULL AND v_series.repeat_months IS NULL"));
  });

  test("on failure: sets status = review_required and review_reason = ARRAY['missing_snapshot'], never touches appointments", () => {
    assert.ok(snapshotCheckBlock.includes("SET status = 'review_required', review_reason = ARRAY['missing_snapshot'], updated_at = now()"));
  });

  test("the quarantine UPDATE re-asserts status = 'active' in its own WHERE clause (CAS re-check) and falls back to conflict if NOT FOUND", () => {
    assert.ok(snapshotCheckBlock.includes("WHERE id = p_series_id AND workspace_id = p_workspace_id AND status = 'active';"));
    assert.ok(snapshotCheckBlock.includes("IF NOT FOUND THEN"));
  });

  test("occurs strictly BEFORE the client lock -- an incomplete snapshot is diagnosed before any client/employee check runs", () => {
    const clientLockIdx = fnBody.indexOf("FROM clients\n  WHERE id = v_series.client_id");
    assert.ok(snapshotCheckIdx > -1 && clientLockIdx > -1 && snapshotCheckIdx < clientLockIdx);
  });
});

describe("migration 027b -- replenish_recurring_series: client stop transition (client_stopped)", () => {
  const clientBlockStart = fnBody.indexOf("FROM clients\n  WHERE id = v_series.client_id");
  const clientBlockEnd = fnBody.indexOf("END IF;", fnBody.indexOf("client_stopped", clientBlockStart)) + "END IF;".length;
  const clientBlock = fnBody.slice(clientBlockStart, clientBlockEnd);

  test("triggers on a missing client row, OR an inactive status, OR a non-NULL archived_at -- via NULL-safe IS DISTINCT FROM", () => {
    assert.ok(clientBlock.includes("IF NOT FOUND OR v_client_status IS DISTINCT FROM 'active' OR v_client_archived_at IS NOT NULL THEN"));
  });

  test("atomically sets status = stopped, stopped_at = now(), and CLEARS review_reason to NULL", () => {
    assert.ok(clientBlock.includes("SET status = 'stopped', stopped_at = now(), review_reason = NULL, updated_at = now()"));
  });

  test("never touches appointments -- the stop transition returns before Part 5's INSERT", () => {
    const insertIdx = fnBody.indexOf("INSERT INTO appointments");
    assert.ok(clientBlockEnd < insertIdx);
  });
});

describe("migration 027b -- replenish_recurring_series: employee quarantine transition (employee_review_required)", () => {
  const employeeBlockStart = fnBody.indexOf("FROM employees WHERE id = ANY(v_series.snapshot_employee_ids)");
  const employeeBlockEnd =
    fnBody.indexOf("END IF;", fnBody.indexOf("employee_review_required", employeeBlockStart)) + "END IF;".length;
  const employeeBlock = fnBody.slice(employeeBlockStart, employeeBlockEnd);

  test("eligibility requires workspace_id match AND active = true, re-checked fresh against locked rows", () => {
    assert.ok(employeeBlock.includes("WHERE id = emp_id AND workspace_id = p_workspace_id AND active = true"));
  });

  test("atomically sets status = review_required and review_reason = ARRAY['employee_no_longer_eligible']", () => {
    assert.ok(employeeBlock.includes("SET status = 'review_required', review_reason = ARRAY['employee_no_longer_eligible'], updated_at = now()"));
  });

  test("never touches appointments -- the quarantine transition returns before Part 5's INSERT", () => {
    const insertIdx = fnBody.indexOf("INSERT INTO appointments");
    assert.ok(employeeBlockEnd < insertIdx);
  });
});

describe("migration 027b -- replenish_recurring_series: appointment insertion field mapping", () => {
  const insertStart = fnBody.indexOf("INSERT INTO appointments (");
  const insertEnd = fnBody.indexOf("RETURNING id", insertStart);
  const insertBlock = fnBody.slice(insertStart, insertEnd);
  // The exact column-list text -- between the opening "(" right after
  // "INSERT INTO appointments" and its OWN matching closing ")" (the one
  // immediately followed by the SELECT list), never the whole insertBlock
  // (which also contains the SELECT list's own value expressions, some of
  // which share substrings with column names, e.g. v_series.repeat_weeks).
  const columnListStart = insertStart + "INSERT INTO appointments (".length;
  const columnListEnd = fnBody.indexOf(")", columnListStart);
  const columnListText = fnBody.slice(columnListStart, columnListEnd);

  test("column list includes every field the audited existing row-builders (create/manage-recurrence routes) populate", () => {
    for (const col of [
      "client_id", "service_type", "scheduled_for", "scheduled_end", "notes", "cancel_token",
      "status", "is_demo", "workspace_id", "duration_minutes", "series_id", "frequency_type",
      "repeat_weeks", "repeat_months", "employee_id", "price_cents", "team_color",
    ]) {
      assert.ok(new RegExp(`\\b${col}\\b`).test(columnListText), `expected column ${col} in the INSERT column list`);
    }
  });

  test("the column list contains exactly these 17 columns, no more, no fewer", () => {
    const columns = columnListText.split(",").map((c) => c.trim()).filter(Boolean);
    assert.equal(columns.length, 17);
  });

  test("status is always the literal 'scheduled' -- never any other value", () => {
    assert.ok(insertBlock.includes("'scheduled',"));
  });

  test("scheduled_end is computed as occ + make_interval(mins => snapshot_duration_minutes)", () => {
    assert.ok(insertBlock.includes("occ + make_interval(mins => v_series.snapshot_duration_minutes)"));
  });

  test("employee_id (legacy single-employee mirror) is NULL for zero/2+ assigned employees, the one id for exactly one -- matching deriveLegacyEmployeeId", () => {
    assert.ok(insertBlock.includes("CASE WHEN cardinality(v_series.snapshot_employee_ids) = 1 THEN v_series.snapshot_employee_ids[1] ELSE NULL END"));
  });

  test("cancel_token is freshly generated per row via gen_random_uuid(), never a fixed/shared value, never an actual pgcrypto gen_random_bytes() call", () => {
    assert.ok(insertBlock.includes("replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')"));
    // Comment lines stripped first -- the SELECT list itself has an
    // adjacent comment legitimately explaining, in prose, WHY
    // gen_random_bytes() (pgcrypto-only, never enabled in this schema) was
    // deliberately NOT used, which would otherwise make even an
    // insertBlock-scoped substring check a false positive against that
    // very explanation.
    const insertBlockCodeOnly = insertBlock
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    assert.ok(!/gen_random_bytes/.test(insertBlockCodeOnly));
  });

  test("never writes actual_started_at or actual_completed_at", () => {
    assert.ok(!insertBlock.includes("actual_started_at"));
    assert.ok(!insertBlock.includes("actual_completed_at"));
  });

  test("client_id, is_demo, frequency_type, repeat_weeks, repeat_months are sourced from the locked recurring_series row, not re-derived", () => {
    assert.ok(insertBlock.includes("v_series.client_id"));
    assert.ok(insertBlock.includes("v_series.is_demo"));
    assert.ok(insertBlock.includes("v_series.frequency_type"));
    assert.ok(insertBlock.includes("v_series.repeat_weeks"));
    assert.ok(insertBlock.includes("v_series.repeat_months"));
  });

  test("workspace_id on the inserted appointment row is the validated p_workspace_id, matching the locked series' own workspace", () => {
    assert.ok(insertBlock.includes("p_workspace_id"));
  });

  test("series_id on every inserted row is the exact p_series_id this call operates on", () => {
    assert.ok(insertBlock.includes("p_series_id"));
  });
});

describe("migration 027b -- replenish_recurring_series: idempotency and assignment creation", () => {
  test("uses ON CONFLICT (series_id, scheduled_for) WHERE series_id IS NOT NULL DO NOTHING -- matching migrations/026's own partial unique index exactly", () => {
    assert.ok(fnBody.includes("ON CONFLICT (series_id, scheduled_for) WHERE series_id IS NOT NULL DO NOTHING"));
  });

  test("assignment rows are inserted ONLY from the RETURNING output of the appointment INSERT (inserted_appts), never from a separately re-queried set", () => {
    const assignmentInsertStart = fnBody.indexOf("INSERT INTO appointment_employees");
    const assignmentBlock = fnBody.slice(assignmentInsertStart, fnBody.indexOf("RETURNING 1", assignmentInsertStart));
    assert.ok(assignmentBlock.includes("FROM inserted_appts ia"));
    assert.ok(assignmentBlock.includes("CROSS JOIN unnest(v_series.snapshot_employee_ids) e"));
    assert.ok(assignmentBlock.includes("ia.id"));
  });

  test("both the appointment INSERT and the assignment INSERT are CTEs of ONE WITH statement -- a single atomic operation, not two separate statements", () => {
    const withIdx = fnBody.indexOf("WITH inserted_appts AS (");
    const apptInsertIdx = fnBody.indexOf("INSERT INTO appointments (", withIdx);
    const assignmentInsertIdx = fnBody.indexOf("INSERT INTO appointment_employees", withIdx);
    assert.ok(withIdx > -1 && apptInsertIdx > withIdx && assignmentInsertIdx > apptInsertIdx);
  });

  test("both data-modifying CTEs are explicitly referenced in the final SELECT (not left as an unreferenced WITH branch)", () => {
    assert.ok(fnBody.includes("(SELECT COUNT(*)::INTEGER FROM inserted_appts)"));
    assert.ok(fnBody.includes("(SELECT COUNT(*)::INTEGER FROM inserted_assignments)"));
  });

  test("inserted_count and skipped_count are derived correctly: skipped_count = cardinality(p_occurrences) - inserted_count", () => {
    assert.ok(fnBody.includes("v_skipped_count := cardinality(p_occurrences) - v_inserted_count;"));
  });

  test("last_replenished_at is updated unconditionally on a successful replenishment pass, regardless of inserted_count", () => {
    const lastReplenishedIdx = fnBody.indexOf("SET last_replenished_at = now()");
    assert.ok(lastReplenishedIdx > -1);
    const withIdx = fnBody.indexOf("WITH inserted_appts AS (");
    assert.ok(lastReplenishedIdx > withIdx, "last_replenished_at update must occur after the insert, on the same success path");
  });

  test("last_replenished_at update is scoped by id, workspace_id, AND status = 'active' (CAS re-check), falling back to conflict if NOT FOUND", () => {
    const lastReplenishedIdx = fnBody.indexOf("SET last_replenished_at = now()");
    const block = fnBody.slice(lastReplenishedIdx, lastReplenishedIdx + 300);
    assert.ok(block.includes("WHERE id = p_series_id AND workspace_id = p_workspace_id AND status = 'active';"));
    assert.ok(block.includes("IF NOT FOUND THEN"));
  });
});

describe("migration 027b -- replenish_recurring_series: closed outcome set and no unrelated side effects", () => {
  test("returns exactly the six documented closed outcomes, no others", () => {
    const returns = [...fnBody.matchAll(/RETURN jsonb_build_object\('outcome', '([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(
      new Set(returns),
      new Set(["invalid_input", "conflict", "missing_snapshot_review_required", "client_stopped", "employee_review_required", "replenished"])
    );
  });

  test("production-review correction: every single RETURN in this function uses jsonb_build_object -- no bare RETURN 'text' or composite-cast form remains anywhere", () => {
    assert.ok(!/RETURN '[a-z_]+';/.test(fnBody));
    assert.ok(!/::replenish_recurring_series_result/.test(fnBody));
    const allReturns = [...fnBody.matchAll(/RETURN\s+[^;]+;/g)];
    for (const m of allReturns) {
      assert.ok(m[0].includes("jsonb_build_object"), `expected every RETURN to use jsonb_build_object: ${m[0]}`);
    }
  });

  test("every jsonb_build_object call uses exactly the three documented keys, in the same stable order, on every RETURN", () => {
    const calls = [...fnBody.matchAll(/jsonb_build_object\(([^)]+)\)/g)];
    assert.ok(calls.length >= 6, "expected at least one jsonb_build_object call per closed outcome");
    for (const m of calls) {
      const argsText = m[1];
      const keyOrder = [...argsText.matchAll(/'(outcome|inserted_count|skipped_count)'/g)].map((k) => k[1]);
      assert.deepEqual(keyOrder, ["outcome", "inserted_count", "skipped_count"], `unexpected key order/shape: ${argsText}`);
    }
  });

  test("every non-'replenished' outcome uses the literal integers 0, 0 for inserted_count/skipped_count -- only 'replenished' uses the computed variables", () => {
    const nonReplenishedReturns = [
      ...fnBody.matchAll(/RETURN jsonb_build_object\('outcome', '(?!replenished)[a-z_]+', 'inserted_count', ([^,]+), 'skipped_count', ([^)]+)\);/g),
    ];
    assert.ok(nonReplenishedReturns.length >= 9, "expected every non-replenished RETURN to be checked");
    for (const m of nonReplenishedReturns) {
      assert.equal(m[1], "0");
      assert.equal(m[2], "0");
    }
    assert.ok(
      fnBody.includes("RETURN jsonb_build_object('outcome', 'replenished', 'inserted_count', v_inserted_count, 'skipped_count', v_skipped_count);"),
      "expected the sole 'replenished' RETURN to use the computed v_inserted_count/v_skipped_count variables"
    );
  });

  test("never sends email/SMS or writes a messages_sent-style row -- no notification code referenced anywhere in the function", () => {
    for (const forbidden of ["sendgrid", "twilio", "sendEmail", "sendSms", "messages_sent", "notify"]) {
      assert.ok(!fnBody.toLowerCase().includes(forbidden.toLowerCase()), `must not reference ${forbidden}`);
    }
  });

  test("never updates any appointment row other than a brand-new INSERT -- no UPDATE appointments anywhere in this function", () => {
    assert.ok(!/UPDATE\s+appointments\b/i.test(fnBody));
  });
});

describe("migration 027b -- quarantine_recurring_series_for_replenishment: security posture, grants, and signature", () => {
  test("declared SECURITY INVOKER, never SECURITY DEFINER", () => {
    const beforeFn = sql.slice(0, quarantineFnBodyStart);
    const fnDeclStart = beforeFn.lastIndexOf("CREATE OR REPLACE FUNCTION quarantine_recurring_series_for_replenishment");
    const decl = sql.slice(fnDeclStart, quarantineFnBodyStart);
    assert.ok(/SECURITY INVOKER/.test(decl));
    assert.ok(!/SECURITY DEFINER/.test(decl));
    assert.ok(/RETURNS TEXT/.test(decl));
    assert.ok(/LANGUAGE plpgsql/.test(decl));
    assert.ok(/SET search_path = public/.test(decl));
  });

  test("exact four-parameter signature: p_series_id, p_workspace_id, p_expected_snapshot_updated_at, p_reason", () => {
    const beforeFn = sql.slice(0, quarantineFnBodyStart);
    const fnDeclStart = beforeFn.lastIndexOf("CREATE OR REPLACE FUNCTION quarantine_recurring_series_for_replenishment");
    const decl = sql.slice(fnDeclStart, quarantineFnBodyStart);
    assert.ok(/p_series_id\s+UUID/.test(decl));
    assert.ok(/p_workspace_id\s+UUID/.test(decl));
    assert.ok(/p_expected_snapshot_updated_at\s+TIMESTAMPTZ/.test(decl));
    assert.ok(/p_reason\s+TEXT/.test(decl));
  });

  test("EXECUTE is revoked from PUBLIC, anon, and authenticated -- each exactly once", () => {
    const sig = "UUID, UUID, TIMESTAMPTZ, TEXT";
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      const re = new RegExp(`REVOKE ALL ON FUNCTION quarantine_recurring_series_for_replenishment\\(\\s*${sig}\\s*\\) FROM ${role};`);
      assert.ok(re.test(sql), `expected REVOKE ALL ... FROM ${role}`);
    }
  });

  test("EXECUTE is granted to service_role exactly once, and to no other role", () => {
    const grants = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION quarantine_recurring_series_for_replenishment\([^)]*\) TO (\w+);/g)];
    assert.equal(grants.length, 1);
    assert.equal(grants[0][1], "service_role");
  });
});

describe("migration 027b -- quarantine_recurring_series_for_replenishment: reason allowlist and lock order", () => {
  test("accepts only dst_gap, employee_no_longer_eligible, and missing_snapshot -- rejects NULL or anything else as invalid_reason", () => {
    assert.ok(quarantineFnBody.includes("IF p_reason IS NULL OR p_reason NOT IN ('dst_gap', 'employee_no_longer_eligible', 'missing_snapshot') THEN"));
    assert.ok(quarantineFnBody.includes("RETURN 'invalid_reason';"));
  });

  test("the reason check occurs before any lock", () => {
    const reasonCheckIdx = quarantineFnBody.indexOf("IF p_reason IS NULL");
    const lockIdx = quarantineFnBody.indexOf("FOR UPDATE");
    assert.ok(reasonCheckIdx > -1 && lockIdx > -1 && reasonCheckIdx < lockIdx);
  });

  test("locks only recurring_series -- no clients, employees, or appointments table referenced anywhere", () => {
    for (const table of ["FROM clients", "FROM employees", "FROM appointments", "FROM appointment_employees"]) {
      assert.ok(!quarantineFnBody.includes(table), `must not reference ${table}`);
    }
    assert.ok(quarantineFnBody.includes("FROM recurring_series"));
  });

  test("requires status exactly active and a NULL-safe expected-snapshot-timestamp match, both mapping to conflict", () => {
    assert.ok(quarantineFnBody.includes("IF v_series.status IS DISTINCT FROM 'active' THEN"));
    assert.ok(quarantineFnBody.includes("IF v_series.snapshot_updated_at IS DISTINCT FROM p_expected_snapshot_updated_at THEN"));
  });

  test("on success: status -> review_required, persists exactly ARRAY[p_reason], updates updated_at, never touches appointments", () => {
    assert.ok(quarantineFnBody.includes("SET status = 'review_required',\n      review_reason = ARRAY[p_reason],\n      updated_at = now()"));
    assert.ok(!/INSERT INTO appointments/.test(quarantineFnBody));
    assert.ok(!/UPDATE appointments/.test(quarantineFnBody));
  });

  test("returns exactly the three documented closed outcomes, no others", () => {
    const returns = [...quarantineFnBody.matchAll(/RETURN '([a-z_]+)';/g)].map((m) => m[1]);
    assert.deepEqual(new Set(returns), new Set(["invalid_reason", "conflict", "quarantined"]));
  });
});

describe("migration 027b -- both functions preserve the shared lock order with activate_recurring_series/sync_appointment_assignments", () => {
  test("replenish_recurring_series's FIRST table lock is on recurring_series, scoped identically to activate_recurring_series's own step 1", () => {
    const firstLockIdx = fnBody.indexOf("FOR UPDATE");
    const recurringSeriesIdx = fnBody.indexOf("FROM recurring_series");
    assert.ok(recurringSeriesIdx > -1 && recurringSeriesIdx < firstLockIdx);
  });

  test("quarantine_recurring_series_for_replenishment's FIRST (and only) table lock is also on recurring_series", () => {
    const firstLockIdx = quarantineFnBody.indexOf("FOR UPDATE");
    const recurringSeriesIdx = quarantineFnBody.indexOf("FROM recurring_series");
    assert.ok(recurringSeriesIdx > -1 && recurringSeriesIdx < firstLockIdx);
  });

  test("the migration's own comments document the shared lock-order rationale explicitly", () => {
    assert.ok(/forced to serialize/.test(sql));
  });
});
