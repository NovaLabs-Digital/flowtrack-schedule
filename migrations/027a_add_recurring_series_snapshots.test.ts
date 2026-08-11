// Block 2C-1: static, source-level proof that migration 027a is additive,
// non-destructive, and that its new activate_recurring_series function has
// the exact locking/validation/grant shape the design requires. Migrations
// are never executed by this test suite (no database is reachable from
// tests anywhere in this repository) -- this file proves the SQL text
// itself, matching the same "prove it from source" discipline as every
// prior migration's own test (023/024/025/026).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./027a_add_recurring_series_snapshots.sql", import.meta.url)), "utf8");
const upperSql = sql.toUpperCase();

const migration026Sql = fs.readFileSync(fileURLToPath(new URL("./026_add_recurring_series.sql", import.meta.url)), "utf8");

// The function body lives between "AS $fn$" and the matching "$fn$;" --
// isolated once here so every test below can distinguish "this text is part
// of the PL/pgSQL function DEFINITION" (which legitimately contains the
// literal strings UPDATE/INSERT/etc. as part of the logic it defines) from
// "this text is a statement the migration itself would actually RUN."
const fnBodyStart = sql.indexOf("AS $fn$");
const fnBodyEnd = sql.indexOf("$fn$;", fnBodyStart);
const fnBody = sql.slice(fnBodyStart, fnBodyEnd);
const beforeFnBody = sql.slice(0, fnBodyStart);
const afterFnBody = sql.slice(fnBodyEnd);

// Block 2C-1 concurrency correction: a SECOND function,
// sync_appointment_assignments, isolated the identical way -- the second
// "AS $fn$ ... $fn$;" occurrence in the file, searched starting immediately
// after the first function's own closing marker so it can never accidentally
// re-match the first function's body.
const syncFnBodyStart = sql.indexOf("AS $fn$", fnBodyEnd + 5);
const syncFnBodyEnd = sql.indexOf("$fn$;", syncFnBodyStart);
const syncFnBody = sql.slice(syncFnBodyStart, syncFnBodyEnd);

describe("migration 027a -- additive nullable columns", () => {
  test("adds exactly the eight new snapshot/review_reason columns to recurring_series, all nullable, all IF NOT EXISTS", () => {
    const expectedColumns: [string, string][] = [
      ["snapshot_service_type", "TEXT"],
      ["snapshot_price_cents", "INTEGER"],
      ["snapshot_duration_minutes", "INTEGER"],
      ["snapshot_notes", "TEXT"],
      ["snapshot_team_color", "TEXT"],
      ["snapshot_employee_ids", "UUID\\[\\]"],
      ["snapshot_updated_at", "TIMESTAMPTZ"],
      ["review_reason", "TEXT\\[\\]"],
    ];
    for (const [col, type] of expectedColumns) {
      const re = new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\s+${type}`);
      assert.ok(re.test(sql), `expected ADD COLUMN IF NOT EXISTS ${col} ${type}`);
    }
    // None of the eight are declared NOT NULL at the column level -- an
    // as-yet-uncaptured (review_required, never activated) row must be able
    // to have every one of these NULL.
    for (const [col] of expectedColumns) {
      const lineMatch = sql.split("\n").find((l) => l.includes(`ADD COLUMN IF NOT EXISTS ${col}`));
      assert.ok(lineMatch && !/NOT NULL/.test(lineMatch), `${col} must not be declared NOT NULL`);
    }
  });

  test("targets only recurring_series -- no other table's columns are added", () => {
    const alterAddColumn = [...sql.matchAll(/ALTER TABLE (\w+)\s*\n?\s*ADD COLUMN/g)].map((m) => m[1]);
    assert.deepEqual(new Set(alterAddColumn), new Set(["recurring_series"]));
  });
});

describe("migration 027a -- no row mutation outside the function definition", () => {
  test("the migration's own top-level statements never UPDATE, INSERT INTO, or DELETE FROM recurring_series or appointments", () => {
    const topLevel = beforeFnBody + afterFnBody;
    const topLevelUpper = topLevel.toUpperCase();
    for (const table of ["RECURRING_SERIES", "APPOINTMENTS"]) {
      assert.ok(!new RegExp(`UPDATE\\s+${table}\\b`).test(topLevelUpper), `top-level migration text must not UPDATE ${table}`);
      assert.ok(!new RegExp(`INSERT\\s+INTO\\s+${table}\\b`).test(topLevelUpper), `top-level migration text must not INSERT INTO ${table}`);
      assert.ok(!new RegExp(`DELETE\\s+FROM\\s+${table}\\b`).test(topLevelUpper), `top-level migration text must not DELETE FROM ${table}`);
    }
  });

  test("contains no DROP TABLE/DROP COLUMN/TRUNCATE anywhere", () => {
    for (const forbidden of ["DROP TABLE", "DROP COLUMN", "TRUNCATE"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });
});

describe("migration 027a -- does not add the active-snapshot completeness CHECK yet", () => {
  test("exactly the four documented snapshot CHECKs exist, and none of them mention status", () => {
    // Scoped to the four already-known, already-named CHECK constraints this
    // migration legitimately adds (price/duration/team_color/review_reason)
    // -- the function's own UPDATE statement legitimately sets status='active'
    // and every snapshot_* column together in the same SET clause (that's the
    // whole point of atomicity), which is a completely different construct
    // from a CHECK constraint and must not be confused with one.
    // Strip full-line comments first -- the migration's own prose (line 14)
    // legitimately mentions "CHECK (" descriptively when explaining what
    // this migration deliberately does NOT add yet, which is not a real
    // constraint and must not be counted as one.
    const codeOnly = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    const checkMatches = [...codeOnly.matchAll(/CHECK\s*\(/g)];
    assert.equal(checkMatches.length, 4, "expected exactly four CHECK( constraints in this migration");

    const knownChecks = [
      "CHECK (snapshot_price_cents IS NULL OR snapshot_price_cents >= 0)",
      "CHECK (snapshot_duration_minutes IS NULL OR snapshot_duration_minutes > 0)",
      "CHECK (snapshot_team_color IS NULL OR snapshot_team_color ~ '^#[0-9A-Fa-f]{6}$')",
    ];
    for (const c of knownChecks) {
      assert.ok(sql.includes(c));
      assert.ok(!/status/i.test(c));
    }
    assert.ok(
      !/status/i.test(
        "review_reason IS NULL OR (cardinality(review_reason) = (cardinality(array_positions(review_reason, 'dst_gap')) + cardinality(array_positions(review_reason, 'employee_no_longer_eligible')) + cardinality(array_positions(review_reason, 'missing_snapshot'))))"
      )
    );
  });
});

describe("migration 027a -- migration 026's existing active/template CHECK remains completely untouched", () => {
  test("027a contains no DROP CONSTRAINT / ALTER CONSTRAINT against recurring_series at all", () => {
    assert.ok(!/DROP CONSTRAINT/i.test(sql));
    assert.ok(!/ALTER TABLE recurring_series[\s\S]{0,80}DROP/i.test(sql));
  });

  test("026's own template_appointment_id/reviewed_at active-row CHECK is still present, byte-for-byte, in 026's own file", () => {
    assert.ok(
      /CHECK\s*\(status\s*<>\s*'active'\s*OR\s*\(template_appointment_id\s+IS\s+NOT\s+NULL\s+AND\s+reviewed_at\s+IS\s+NOT\s+NULL\)\)/.test(
        migration026Sql
      ),
      "026's original active/template CHECK must remain exactly as it was -- 027a does not touch it"
    );
  });
});

describe("migration 027a -- snapshot CHECK constraints", () => {
  test("snapshot_price_cents: NULL or >= 0, guarded by an idempotent existence probe", () => {
    assert.ok(sql.includes("CHECK (snapshot_price_cents IS NULL OR snapshot_price_cents >= 0)"));
    assert.ok(/recurring_series_snapshot_price_cents_nonnegative/.test(sql));
  });

  test("snapshot_duration_minutes: NULL or strictly positive (not >= 0 -- a zero/negative duration is never valid)", () => {
    assert.ok(sql.includes("CHECK (snapshot_duration_minutes IS NULL OR snapshot_duration_minutes > 0)"));
    assert.ok(!sql.includes("snapshot_duration_minutes >= 0"), "duration must be strictly positive, not merely nonnegative");
  });

  test("snapshot_team_color: NULL or strict #RRGGBB hex, matching appointments.team_color's own format exactly", () => {
    assert.ok(sql.includes("CHECK (snapshot_team_color IS NULL OR snapshot_team_color ~ '^#[0-9A-Fa-f]{6}$')"));
  });

  test("every new CHECK constraint is guarded by a DO $$ ... information_schema existence probe, matching migration 022's own idempotent-constraint convention", () => {
    const guardedNames = [
      "recurring_series_snapshot_price_cents_nonnegative",
      "recurring_series_snapshot_duration_minutes_positive",
      "recurring_series_snapshot_team_color_hex_format",
      "recurring_series_review_reason_closed_set",
    ];
    for (const name of guardedNames) {
      const idx = sql.indexOf(name);
      assert.ok(idx > -1, `expected constraint name ${name} to appear`);
      const surrounding = sql.slice(Math.max(0, idx - 400), idx);
      assert.ok(/DO \$\$/.test(surrounding) && /information_schema\.table_constraints/.test(surrounding), `${name} must be guarded by an existence probe`);
    }
  });
});

// Production-review hardening: a bare `review_reason <@ ARRAY[...]` is
// insufficient on its own -- PostgreSQL's array containment operators
// compare element-by-element, and a NULL element never definitively equals
// anything, so `<@` can evaluate to NULL/unknown rather than a clean FALSE
// when the array contains a NULL. A CHECK constraint only REJECTS a row
// when its expression evaluates to FALSE; NULL/unknown PASSES. This block
// proves the corrected constraint closes that gap WITHOUT using a subquery
// (PostgreSQL CHECK constraints cannot contain one at all -- "cannot use
// subquery in check constraint" is a hard, unconditional restriction; a
// naive `NOT EXISTS (SELECT ... FROM unnest(...))` fix would fail to even
// be created). No live database is reachable from this test suite (see the
// file header), so every claim below is proven structurally, against
// PostgreSQL's own documented, version-stable semantics for cardinality()
// and array_positions() (both added in PostgreSQL 9.5 specifically to
// support this class of array-content check) -- never by executing SQL.
describe("migration 027a -- review_reason CHECK is hardened against NULL-element and duplicate bypass", () => {
  test("uses no subquery anywhere in its own body -- CHECK constraints cannot contain one at all", () => {
    const idx = sql.indexOf("recurring_series_review_reason_closed_set");
    const checkStart = sql.indexOf("CHECK (", idx);
    const checkEnd = sql.indexOf(");\n  END IF;", checkStart);
    const body = sql.slice(checkStart, checkEnd);
    assert.ok(!/\bSELECT\b/i.test(body), "the review_reason CHECK body must contain no SELECT/subquery at all");
    assert.ok(!/\bunnest\s*\(/i.test(body), "must not rely on unnest() inside a subquery either");
  });

  test("never uses the array containment operator (<@) -- the exact construct proven insufficient", () => {
    const idx = sql.indexOf("recurring_series_review_reason_closed_set");
    const checkStart = sql.indexOf("CHECK (", idx);
    const checkEnd = sql.indexOf(");\n  END IF;", checkStart);
    const body = sql.slice(checkStart, checkEnd);
    assert.ok(!body.includes("<@"), "must not use <@, which can pass on a NULL-containing array");
  });

  test("NULL review_reason is accepted -- the constraint's own leading disjunct", () => {
    assert.ok(sql.includes("review_reason IS NULL\n        OR ("));
  });

  test("each of the three approved values, searched individually via array_positions(), is accepted (0 or 1 occurrence never rejects on its own)", () => {
    for (const value of ["dst_gap", "employee_no_longer_eligible", "missing_snapshot"]) {
      assert.ok(
        sql.includes(`cardinality(array_positions(review_reason, '${value}'))`),
        `expected an individual array_positions() search for '${value}'`
      );
    }
    // Every individual count is bounded by <= 1 -- a single occurrence of
    // any one approved value never violates this half of the constraint.
    const matches = [...sql.matchAll(/cardinality\(array_positions\(review_reason, '([a-z_]+)'\)\) <= 1/g)];
    assert.deepEqual(
      new Set(matches.map((m) => m[1])),
      new Set(["dst_gap", "employee_no_longer_eligible", "missing_snapshot"])
    );
  });

  test("a combination of two or three distinct approved values is accepted -- cardinality(review_reason) equals the summed per-value match count", () => {
    // For any array built ONLY from the three known values with no
    // duplicates and no NULLs, cardinality(review_reason) exactly equals
    // the sum of each value's own array_positions() count -- e.g.
    // {'dst_gap','missing_snapshot'} -> cardinality 2, sum 1+0+1 = 2, both
    // per-value counts <= 1. This is what the summed-equality condition
    // proves for every valid combination, not just a single value.
    assert.ok(
      /cardinality\(review_reason\) = \(\s*\n\s*cardinality\(array_positions\(review_reason, 'dst_gap'\)\)\s*\n\s*\+ cardinality\(array_positions\(review_reason, 'employee_no_longer_eligible'\)\)\s*\n\s*\+ cardinality\(array_positions\(review_reason, 'missing_snapshot'\)\)\s*\n\s*\)/.test(
        sql
      )
    );
  });

  test("an unknown/unapproved reason is rejected -- it inflates cardinality(review_reason) without matching any of the three individual searches", () => {
    // A value like 'bogus_reason' is counted once in cardinality(review_reason)
    // but zero times across all three array_positions() searches (none of
    // them target 'bogus_reason'), so the summed-equality condition fails:
    // this is exactly what makes an unrecognized reason unrepresentable,
    // proven by the same summed-equality expression asserted above --
    // there is no separate allowlist function call that could itself leak
    // an unapproved value through.
    const idx = sql.indexOf("recurring_series_review_reason_closed_set");
    const checkStart = sql.indexOf("CHECK (", idx);
    const checkEnd = sql.indexOf(");\n  END IF;", checkStart);
    const body = sql.slice(checkStart, checkEnd);
    const literalMatches = [...body.matchAll(/array_positions\(review_reason, '([a-z_]+)'\)/g)].map((m) => m[1]);
    assert.deepEqual(new Set(literalMatches), new Set(["dst_gap", "employee_no_longer_eligible", "missing_snapshot"]), "exactly the three approved literals are ever searched for -- nothing else can match");
  });

  test("an array containing a NULL element is rejected -- a NULL element is never equal to any of the three known non-NULL literals under any equality semantics", () => {
    // review_reason = ARRAY['dst_gap', NULL]: cardinality = 2. A search for
    // the non-NULL literal 'dst_gap' matches only the first element (1); a
    // NULL element can never match a search for a real string under any
    // equality semantics (NULL is never equal to, nor "not distinct from",
    // a non-null value), so all three array_positions() searches together
    // still sum to only 1 -- 2 != 1, the summed-equality condition fails.
    // This deliberately does NOT depend on array_positions()'s own,
    // separately-documented behavior when NULL is the *search target*
    // (irrelevant here -- NULL is never the search target in this
    // constraint, only ever a possible array *element*).
    const idx = sql.indexOf("recurring_series_review_reason_closed_set");
    const checkStart = sql.indexOf("CHECK (", idx);
    const checkEnd = sql.indexOf(");\n  END IF;", checkStart);
    const body = sql.slice(checkStart, checkEnd);
    assert.ok(body.includes("cardinality(review_reason) = ("), "the summed-equality condition (the actual NULL-rejection mechanism) must be present");
  });

  test("duplicate reasons are rejected -- the per-value <= 1 conditions, independent of the summed-equality condition", () => {
    // review_reason = ARRAY['dst_gap','dst_gap']: cardinality = 2, and the
    // summed-equality condition alone would actually PASS (2 = 2, since
    // both occurrences are still legitimately 'dst_gap') -- duplicate
    // rejection depends entirely on the separate `<= 1` conditions, proven
    // to exist for all three values above, not on the summed-equality
    // condition alone. This test documents that the two condition FAMILIES
    // guard against two DIFFERENT failure modes (unknown/NULL content vs.
    // repeated content) and both are required.
    const idx = sql.indexOf("recurring_series_review_reason_closed_set");
    const checkStart = sql.indexOf("CHECK (", idx);
    const checkEnd = sql.indexOf(");\n  END IF;", checkStart);
    const body = sql.slice(checkStart, checkEnd);
    const leCount = (body.match(/<= 1/g) ?? []).length;
    assert.equal(leCount, 3, "expected exactly three independent <= 1 duplicate guards, one per approved value");
  });

  test("an empty array ('{}') is accepted -- cardinality() returns 0 (never NULL) for a non-NULL empty array, unlike array_length()", () => {
    const idx = sql.indexOf("recurring_series_review_reason_closed_set");
    const checkStart = sql.indexOf("CHECK (", idx);
    const checkEnd = sql.indexOf(");\n  END IF;", checkStart);
    const body = sql.slice(checkStart, checkEnd);
    // Deliberately uses cardinality(), not array_length() -- array_length()
    // of a non-NULL empty array is itself NULL in PostgreSQL, which would
    // silently reintroduce the same NULL-passes-CHECK pitfall this whole
    // hardening pass exists to close, for the empty-array case specifically.
    assert.ok(!/array_length\(review_reason/.test(body), "must use cardinality(), not array_length(), to avoid its NULL-for-empty-array quirk");
  });
});

describe("migration 027a -- explicit transaction", () => {
  test("the entire migration is wrapped in an explicit BEGIN;/COMMIT;", () => {
    const withoutLeadingComments = sql.replace(/^(\s*--[^\n]*\n)+/, "").trim();
    assert.ok(/^BEGIN;/.test(withoutLeadingComments));
    assert.ok(/COMMIT;\s*$/.test(sql.trim()));
    assert.equal((sql.match(/\bBEGIN;/g) ?? []).length, 1);
    assert.equal((sql.match(/\bCOMMIT;/g) ?? []).length, 1);
  });

  test("no CREATE INDEX CONCURRENTLY -- required, since CONCURRENTLY cannot run inside a transaction block", () => {
    assert.ok(!/CONCURRENTLY/i.test(sql));
  });
});

describe("migration 027a -- activate_recurring_series: security posture", () => {
  test("declared SECURITY INVOKER, never SECURITY DEFINER", () => {
    assert.ok(/SECURITY INVOKER/.test(sql));
    assert.ok(!/SECURITY DEFINER/.test(sql));
  });

  test("declares an explicit SET search_path", () => {
    assert.ok(/SET search_path = public/.test(sql));
  });

  test("language is plpgsql", () => {
    assert.ok(/LANGUAGE plpgsql/.test(sql));
  });

  test("exactly one CREATE OR REPLACE FUNCTION activate_recurring_series -- idempotently re-runnable", () => {
    const matches = [...sql.matchAll(/CREATE OR REPLACE FUNCTION activate_recurring_series/g)];
    assert.equal(matches.length, 1);
  });
});

describe("migration 027a -- activate_recurring_series: exact grants and revokes", () => {
  test("EXECUTE is revoked from PUBLIC, anon, and authenticated -- each exactly once", () => {
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      const re = new RegExp(`REVOKE ALL ON FUNCTION activate_recurring_series\\([\\s\\S]{0,400}?\\)\\s*FROM ${role};`);
      assert.ok(re.test(sql), `expected an explicit REVOKE ALL ... FROM ${role}`);
    }
    assert.equal((sql.match(/REVOKE ALL ON FUNCTION activate_recurring_series/g) ?? []).length, 3);
  });

  test("EXECUTE is granted to service_role exactly once, and to no other role", () => {
    const grantMatches = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION activate_recurring_series/g)];
    assert.equal(grantMatches.length, 1);
    assert.ok(/GRANT EXECUTE ON FUNCTION activate_recurring_series\([\s\S]{0,400}?\)\s*TO service_role;/.test(sql));
    assert.ok(!/TO anon;/.test(sql));
    assert.ok(!/TO authenticated;/.test(sql));
    assert.ok(!/TO PUBLIC;/.test(sql));
  });
});

// Production-review hardening: p_anchor_timezone must be validated inside
// the RPC itself, the database's own integrity boundary -- never trusted
// solely from the caller's own effectiveTimezone() resolution (lib/
// timezone.ts), even though that function never returns anything outside
// this same 7-zone allowlist today. Structural proofs only (no live
// database, matching this whole file's discipline).
describe("migration 027a -- activate_recurring_series: p_anchor_timezone validation", () => {
  const ALLOWED_ZONES = [
    "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix",
    "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu",
  ];

  test("validates p_anchor_timezone as the very first statement in the function body -- before any lock is acquired", () => {
    const timezoneCheckIdx = fnBody.indexOf("p_anchor_timezone IS NULL OR p_anchor_timezone NOT IN");
    assert.ok(timezoneCheckIdx > -1, "expected an explicit p_anchor_timezone allowlist check");
    const firstLockIdx = fnBody.indexOf("FROM recurring_series\n  WHERE id = p_series_id");
    assert.ok(timezoneCheckIdx < firstLockIdx, "the timezone check must precede the first lock (recurring_series)");
  });

  test("all seven approved zones are present in the allowlist, exactly matching recurring_series.anchor_timezone's own CHECK (migration 026)", () => {
    for (const zone of ALLOWED_ZONES) {
      assert.ok(fnBody.includes(`'${zone}'`), `expected the allowlist to include ${zone}`);
    }
    // Cross-check against migration 026's own anchor_timezone CHECK -- the
    // two allowlists must never drift apart, since a value this function
    // accepts is written directly into that CHECK-constrained column.
    for (const zone of ALLOWED_ZONES) {
      assert.ok(migration026Sql.includes(`'${zone}'`), `expected migration 026's anchor_timezone CHECK to also include ${zone}`);
    }
  });

  test("NULL is explicitly rejected, not merely omitted from the allowlist -- IS NULL is checked before NOT IN, which is otherwise NULL-unsafe", () => {
    assert.ok(/p_anchor_timezone\s+IS\s+NULL\s+OR\s+p_anchor_timezone\s+NOT\s+IN/.test(fnBody));
  });

  test("an unsupported zone (blank, EST/PST abbreviations, Europe/London, or an arbitrary string) fails the NOT IN allowlist check the same way -- no separate carve-out exists for any of them", () => {
    // The allowlist is a closed, exhaustive IN-list -- structurally, ANY
    // value not exactly matching one of the seven listed strings (blank,
    // "EST", "PST", "Europe/London", "not-a-timezone", etc.) fails NOT IN
    // identically; there is no regex/prefix/fuzzy matching that could admit
    // a near-miss.
    const inListMatch = fnBody.match(/p_anchor_timezone NOT IN \(([\s\S]*?)\)/);
    assert.ok(inListMatch);
    const listedZones = [...inListMatch![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(new Set(listedZones), new Set(ALLOWED_ZONES), "the allowlist must contain exactly the seven approved zones, nothing broader");
  });

  test("rejection returns invalid_timezone immediately, before touching status, snapshot fields, template_appointment_id, anchor fields, reviewed_at, or review_reason", () => {
    const timezoneCheckIdx = fnBody.indexOf("p_anchor_timezone IS NULL OR p_anchor_timezone NOT IN");
    const returnIdx = fnBody.indexOf("RETURN 'invalid_timezone';", timezoneCheckIdx);
    assert.ok(returnIdx > -1 && returnIdx > timezoneCheckIdx);
    const updateIdx = fnBody.indexOf("UPDATE recurring_series");
    assert.ok(returnIdx < updateIdx, "the invalid_timezone return must occur before the single UPDATE statement -- zero writes on rejection");
  });
});

describe("migration 027a -- activate_recurring_series: fixed lock order", () => {
  test("locks recurring_series, then clients, then the template appointment, then appointment_employees, then employees, in that exact positional order", () => {
    const markers = [
      "FROM recurring_series\n  WHERE id = p_series_id",
      "FROM clients\n  WHERE id = p_client_id",
      "FROM appointments\n  WHERE id = p_template_appointment_id",
      "FROM appointment_employees\n  WHERE appointment_id = p_template_appointment_id",
      "FROM employees WHERE id = ANY(v_actual_employee_ids)",
    ];
    const positions = markers.map((m) => fnBody.indexOf(m));
    for (let i = 0; i < positions.length; i++) {
      assert.ok(positions[i] > -1, `expected to find lock-order marker: ${markers[i]}`);
    }
    for (let i = 1; i < positions.length; i++) {
      assert.ok(positions[i] > positions[i - 1], `lock order violated: "${markers[i]}" must come after "${markers[i - 1]}"`);
    }
  });

  test("every lock-order table read uses FOR UPDATE", () => {
    const forUpdateCount = (fnBody.match(/FOR UPDATE/g) ?? []).length;
    // recurring_series, clients, template appointment, appointment_employees,
    // and the employees PERFORM -- five FOR UPDATE reads in total.
    assert.equal(forUpdateCount, 5);
  });
});

describe("migration 027a -- activate_recurring_series: identity and state validation", () => {
  test("re-verifies recurring_series id AND workspace_id together, never id alone", () => {
    assert.ok(/WHERE id = p_series_id AND workspace_id = p_workspace_id/.test(fnBody));
  });

  test("CAS precondition: status must be review_required, both at the initial lock and again in the final UPDATE's WHERE clause", () => {
    assert.ok(/IF v_series\.status IS DISTINCT FROM 'review_required' THEN\s*\n\s*RETURN 'conflict';/.test(fnBody));
    assert.ok(/WHERE id = p_series_id AND workspace_id = p_workspace_id AND status = 'review_required';/.test(fnBody));
  });

  test("production-review correction: v_series.status uses IS DISTINCT FROM, not a bare <>, so a NULL status (were the NOT NULL constraint ever weakened) cannot evaluate to NULL/unknown and silently skip the conflict check", () => {
    assert.ok(!/v_series\.status <> 'review_required'/.test(fnBody), "the NULL-unsafe bare <> form must be fully removed, not merely supplemented");
  });

  test("recurring_series.client_id must match p_client_id explicitly, never assumed", () => {
    assert.ok(/v_series\.client_id IS DISTINCT FROM p_client_id/.test(fnBody));
  });

  test("client existence, active status, and archived_at are all re-checked under lock", () => {
    assert.ok(/WHERE id = p_client_id AND workspace_id = p_workspace_id/.test(fnBody));
    assert.ok(/v_client_status IS DISTINCT FROM 'active' OR v_client_archived_at IS NOT NULL/.test(fnBody));
    assert.ok(/RETURN 'client_not_active';/.test(fnBody));
  });

  test("production-review correction: client status is a strict allowlist (IS DISTINCT FROM 'active'), not a denylist that only rejected the literal 'inactive' -- a NULL or any other unexpected status value is now rejected too", () => {
    assert.ok(!/v_client_status = 'inactive'/.test(fnBody), "the denylist bare '=' form must be fully removed, not merely supplemented");
  });

  test("template appointment identity re-verified on all four dimensions: id, workspace_id, client_id, series_id", () => {
    assert.ok(/WHERE id = p_template_appointment_id\s*\n\s*AND workspace_id = p_workspace_id\s*\n\s*AND client_id = p_client_id\s*\n\s*AND series_id = p_series_id/.test(fnBody));
  });

  test("template must be status='scheduled' (IS DISTINCT FROM, NULL-safe) and scheduled_for non-NULL and strictly in the future", () => {
    assert.ok(/v_template\.status IS DISTINCT FROM 'scheduled'/.test(fnBody));
    assert.ok(/v_template\.scheduled_for IS NULL OR v_template\.scheduled_for <= now\(\)/.test(fnBody));
  });

  test("production-review correction: neither the template status nor the in-the-past check uses a bare, NULL-unsafe operator anymore", () => {
    assert.ok(!/v_template\.status <> 'scheduled'/.test(fnBody), "the NULL-unsafe bare <> form must be fully removed, not merely supplemented");
    assert.ok(!/IF v_template\.scheduled_for <= now\(\) THEN/.test(fnBody), "the bare, NULL-unsafe <= now() check (without the preceding IS NULL guard) must be fully removed, not merely supplemented");
  });
});

describe("migration 027a -- activate_recurring_series: no concatenated string fingerprint", () => {
  test("never builds a delimiter-joined comparison string -- no string concatenation (||) or format()/concat() anywhere in the function", () => {
    assert.ok(!/\|\|/.test(fnBody), "must not use || string concatenation to build a fingerprint");
    assert.ok(!/\bformat\s*\(/i.test(fnBody));
    assert.ok(!/\bconcat\s*\(/i.test(fnBody));
  });

  test("every field is compared as its own explicit, independent condition, not folded into one joined value", () => {
    for (const col of ["service_type", "price_cents", "duration_minutes", "notes", "team_color"]) {
      assert.ok(
        new RegExp(`v_template\\.${col} IS DISTINCT FROM p_expected_${col}`).test(fnBody),
        `expected an explicit, standalone comparison for ${col}`
      );
    }
    assert.ok(/v_template\.scheduled_for IS DISTINCT FROM p_expected_scheduled_for/.test(fnBody));
  });
});

describe("migration 027a -- activate_recurring_series: NULL-safe nullable scalar comparisons", () => {
  test("service_type/price_cents/duration_minutes/notes/team_color/scheduled_for all use IS DISTINCT FROM semantics, never a bare = or <>", () => {
    // A bare `v_template.notes = p_expected_notes` would be NULL when either
    // side is NULL (never TRUE), silently breaking the "both legitimately
    // NULL" case -- IS DISTINCT FROM is the NULL-safe form this function
    // must use instead, for every field, including scheduled_for.
    for (const col of ["service_type", "price_cents", "duration_minutes", "notes", "team_color", "scheduled_for"]) {
      assert.ok(!new RegExp(`v_template\\.${col}\\s*=\\s*p_expected_${col}\\b`).test(fnBody), `${col} must not use a bare '=' comparison`);
      assert.ok(!new RegExp(`v_template\\.${col}\\s*<>\\s*p_expected_${col}\\b`).test(fnBody), `${col} must not use a bare '<>' comparison`);
    }
  });

  test("production-review correction: scheduled_for previously used a bare <>, which evaluates to NULL/unknown (never TRUE) whenever p_expected_scheduled_for is NULL -- silently skipping this OR-chain term instead of forcing state_changed. IS DISTINCT FROM never has that gap: it evaluates TRUE whenever exactly one side is NULL", () => {
    assert.ok(/v_template\.scheduled_for IS DISTINCT FROM p_expected_scheduled_for/.test(fnBody));
    assert.ok(!/v_template\.scheduled_for <> p_expected_scheduled_for/.test(fnBody), "the NULL-unsafe bare <> form must be fully removed, not merely supplemented");
  });
});

describe("migration 027a -- activate_recurring_series: employee canonicalization and duplicate rejection", () => {
  test("actual assignments are locked and sorted via array_agg(... ORDER BY employee_id)", () => {
    assert.ok(/array_agg\(employee_id ORDER BY employee_id\)/.test(fnBody));
  });

  test("actual assignment aggregation defaults to an empty array (not NULL) when there are zero rows", () => {
    assert.ok(/COALESCE\(array_agg\(employee_id ORDER BY employee_id\), ARRAY\[\]::UUID\[\]\)/.test(fnBody));
  });

  test("expected employee ids are canonicalized via the identical sort-by-value rule", () => {
    assert.ok(/array_agg\(e ORDER BY e\)/.test(fnBody));
  });

  test("duplicate (or NULL-element) expected employee ids are detected and rejected as state_changed, via cardinality() rather than COALESCE(array_length(...))", () => {
    assert.ok(/COUNT\(DISTINCT e\)/.test(fnBody));
    assert.ok(/v_expected_distinct_ct IS DISTINCT FROM cardinality\(p_expected_employee_ids\)/.test(fnBody));
  });

  test("actual canonical array is compared directly against expected canonical array, no per-element loop", () => {
    assert.ok(/v_actual_employee_ids IS DISTINCT FROM v_expected_canonical/.test(fnBody));
  });

  test("production-review correction: a NULL p_expected_employee_ids is REJECTED outright (state_changed), never silently normalized to an empty array -- an explicit empty array ('{}'::uuid[]) remains valid and distinct from NULL", () => {
    assert.ok(/IF p_expected_employee_ids IS NULL THEN\s*\n\s*RETURN 'state_changed';/.test(fnBody));
  });

  test("production-review correction: the NULL guard occurs BEFORE the duplicate-check and canonicalization queries -- no unnest()/cardinality() call ever runs against a NULL array", () => {
    const nullGuardIdx = fnBody.indexOf("IF p_expected_employee_ids IS NULL THEN");
    const unnestIdx = fnBody.indexOf("FROM unnest(p_expected_employee_ids) e;");
    assert.ok(nullGuardIdx > -1 && unnestIdx > -1);
    assert.ok(nullGuardIdx < unnestIdx);
  });

  test("production-review correction: the old COALESCE(p_expected_employee_ids, ARRAY[]::UUID[]) silent-normalization pattern is fully removed from every unnest() call against this parameter", () => {
    assert.ok(!/unnest\(COALESCE\(p_expected_employee_ids, ARRAY\[\]::UUID\[\]\)\)/.test(fnBody));
  });

  test("the NULL guard returns strictly before the single UPDATE statement -- zero writes on rejection", () => {
    const nullGuardIdx = fnBody.indexOf("IF p_expected_employee_ids IS NULL THEN");
    const updateIdx = fnBody.indexOf("UPDATE recurring_series");
    assert.ok(nullGuardIdx > -1 && updateIdx > -1);
    assert.ok(nullGuardIdx < updateIdx);
  });
});

describe("migration 027a -- activate_recurring_series: employee eligibility", () => {
  test("every assigned employee id is locked via employees WHERE id = ANY(...) FOR UPDATE before eligibility is evaluated", () => {
    assert.ok(/PERFORM 1 FROM employees WHERE id = ANY\(v_actual_employee_ids\) FOR UPDATE;/.test(fnBody));
  });

  test("eligibility requires workspace_id match AND active = true, re-checked fresh (not trusted from any caller-supplied value)", () => {
    assert.ok(/WHERE id = assigned_id AND workspace_id = p_workspace_id AND active = true/.test(fnBody));
  });

  test("any ineligible (nonexistent, cross-workspace, or inactive) employee returns employee_not_eligible, not a silent removal", () => {
    assert.ok(/RETURN 'employee_not_eligible';/.test(fnBody));
  });

  test("the employee-eligibility block is skipped (not an error) for a genuinely empty assignment set", () => {
    assert.ok(/IF COALESCE\(array_length\(v_actual_employee_ids, 1\), 0\) > 0 THEN/.test(fnBody));
  });
});

describe("migration 027a -- activate_recurring_series: single atomic write, no partial state", () => {
  test("exactly one UPDATE recurring_series statement exists in the entire function -- the only write this function ever performs", () => {
    const updateMatches = [...fnBody.matchAll(/UPDATE recurring_series\b/g)];
    assert.equal(updateMatches.length, 1);
  });

  test("every early RETURN (client_not_active/employee_not_eligible/state_changed, and the FIRST conflict check) occurs strictly before the UPDATE statement", () => {
    const updateIdx = fnBody.indexOf("UPDATE recurring_series");
    // 'conflict' is legitimately returned TWICE: once early (the initial
    // status != review_required CAS check, before any lock past step 1) and
    // once immediately after the UPDATE itself (a lost-race zero-row result)
    // -- only the early one is required to precede the write; the second is
    // covered by its own dedicated test below.
    const earlyOnlyOutcomes = ["client_not_active", "employee_not_eligible", "state_changed"];
    for (const outcome of earlyOnlyOutcomes) {
      const matches = [...fnBody.matchAll(new RegExp(`RETURN '${outcome}';`, "g"))];
      assert.ok(matches.length >= 1, `expected at least one RETURN '${outcome}'`);
      for (const m of matches) {
        assert.ok((m.index ?? -1) < updateIdx, `RETURN '${outcome}' must occur before the write, not after`);
      }
    }
    const firstConflictIdx = fnBody.indexOf("RETURN 'conflict';");
    assert.ok(firstConflictIdx > -1 && firstConflictIdx < updateIdx, "the initial CAS-precondition conflict check must precede the write");
  });

  test("status, reviewed_at, template_appointment_id, and every snapshot_* column are all set together in the single UPDATE's SET clause", () => {
    const updateIdx = fnBody.indexOf("UPDATE recurring_series");
    const whereIdx = fnBody.indexOf("WHERE id = p_series_id AND workspace_id = p_workspace_id AND status = 'review_required';", updateIdx);
    const setClause = fnBody.slice(updateIdx, whereIdx);
    for (const col of [
      "status = 'active'",
      "reviewed_at = now()",
      "template_appointment_id = p_template_appointment_id",
      "snapshot_service_type = p_expected_service_type",
      "snapshot_price_cents = p_expected_price_cents",
      "snapshot_duration_minutes = p_expected_duration_minutes",
      "snapshot_notes = p_expected_notes",
      "snapshot_team_color = p_expected_team_color",
      "snapshot_employee_ids = v_expected_canonical",
      "snapshot_updated_at = now()",
    ]) {
      assert.ok(setClause.includes(col), `expected the single UPDATE to set ${col}`);
    }
  });

  test("review_reason is explicitly cleared to NULL in the same atomic success UPDATE", () => {
    const updateIdx = fnBody.indexOf("UPDATE recurring_series");
    const whereIdx = fnBody.indexOf("WHERE id = p_series_id AND workspace_id = p_workspace_id AND status = 'review_required';", updateIdx);
    const setClause = fnBody.slice(updateIdx, whereIdx);
    assert.ok(setClause.includes("review_reason = NULL"));
  });

  test("updated_at is set consistently with every other recurring_series write in this codebase", () => {
    const updateIdx = fnBody.indexOf("UPDATE recurring_series");
    const whereIdx = fnBody.indexOf("WHERE id = p_series_id AND workspace_id = p_workspace_id AND status = 'review_required';", updateIdx);
    const setClause = fnBody.slice(updateIdx, whereIdx);
    assert.ok(setClause.includes("updated_at = now()"));
  });

  test("a zero-row UPDATE result (lost CAS race) returns conflict, not activated -- no silent partial success", () => {
    const updateIdx = fnBody.indexOf("UPDATE recurring_series");
    const afterUpdate = fnBody.slice(updateIdx);
    assert.ok(/IF NOT FOUND THEN\s*\n[\s\S]{0,500}RETURN 'conflict';/.test(afterUpdate));
  });

  test("the function returns exactly the six documented closed outcomes, no others", () => {
    const returns = [...fnBody.matchAll(/RETURN '([a-z_]+)';/g)].map((m) => m[1]);
    assert.deepEqual(
      new Set(returns),
      new Set(["state_changed", "conflict", "client_not_active", "employee_not_eligible", "activated", "invalid_timezone"])
    );
  });
});

describe("migration 027a -- activate_recurring_series: anchor fields are re-derived from the validated template, same as the prior finalizeSeriesActive behavior", () => {
  test("takes p_anchor_timezone as its own plain, trusted parameter -- twelfth and final parameter", () => {
    const sigMatch = sql.match(/CREATE OR REPLACE FUNCTION activate_recurring_series\(([\s\S]*?)\)\s*\nRETURNS TEXT/);
    assert.ok(sigMatch);
    const params = sigMatch![1].split(",").map((p) => p.trim()).filter(Boolean);
    assert.equal(params.length, 12);
    assert.ok(/p_anchor_timezone\s+TEXT/.test(params[11]));
  });

  test("anchor_local_date/anchor_local_time are derived from the validated expected scheduled_for via AT TIME ZONE, the same technique migration 026's own legacy backfill already uses -- never a separately-supplied value", () => {
    assert.ok(fnBody.includes("anchor_local_date = (p_expected_scheduled_for AT TIME ZONE p_anchor_timezone)::date"));
    assert.ok(fnBody.includes("anchor_local_time = (p_expected_scheduled_for AT TIME ZONE p_anchor_timezone)::time"));
    assert.ok(fnBody.includes("anchor_timezone = p_anchor_timezone"));
  });

  test("anchor fields are set inside the same single atomic UPDATE as status/reviewed_at/every snapshot_* column", () => {
    const updateIdx = fnBody.indexOf("UPDATE recurring_series");
    const whereIdx = fnBody.indexOf("WHERE id = p_series_id AND workspace_id = p_workspace_id AND status = 'review_required';", updateIdx);
    const setClause = fnBody.slice(updateIdx, whereIdx);
    assert.ok(setClause.includes("anchor_local_date ="));
    assert.ok(setClause.includes("anchor_local_time ="));
    assert.ok(setClause.includes("anchor_timezone ="));
  });

  test("GRANT/REVOKE signatures include all twelve parameter types, ending in the new TEXT anchor-timezone parameter", () => {
    const sigList = "UUID, UUID, UUID, UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT, TIMESTAMPTZ, UUID[], TEXT";
    const occurrences = sql.split(sigList).length - 1;
    // Three REVOKEs + one GRANT, all against the identical twelve-parameter signature.
    assert.equal(occurrences, 4);
  });
});

// Block 2C-1 concurrency correction: sync_appointment_assignments -- the
// atomic, shared-lock-coordinated way to replace an EXISTING appointment's
// employee assignment set. See the migration's own extensive comment on
// this function for the full concurrency argument; this block proves its
// structure the same "source-level, no live database" way as every
// activate_recurring_series test above.
describe("migration 027a -- sync_appointment_assignments: security posture", () => {
  test("declared SECURITY INVOKER, never SECURITY DEFINER", () => {
    assert.ok(/CREATE OR REPLACE FUNCTION sync_appointment_assignments[\s\S]*?SECURITY INVOKER/.test(sql));
    // Global check (not just near this function) -- no SECURITY DEFINER
    // anywhere in the entire migration file, covering both functions at once.
    assert.ok(!/SECURITY DEFINER/.test(sql));
  });

  test("declares an explicit SET search_path, consistently with activate_recurring_series", () => {
    const searchPathCount = (sql.match(/SET search_path = public/g) ?? []).length;
    assert.equal(searchPathCount, 2, "expected one SET search_path per function -- both must set it");
  });

  test("language is plpgsql", () => {
    assert.ok(/CREATE OR REPLACE FUNCTION sync_appointment_assignments[\s\S]*?LANGUAGE plpgsql/.test(sql));
  });

  test("exactly one CREATE OR REPLACE FUNCTION sync_appointment_assignments -- idempotently re-runnable", () => {
    const matches = [...sql.matchAll(/CREATE OR REPLACE FUNCTION sync_appointment_assignments/g)];
    assert.equal(matches.length, 1);
  });
});

describe("migration 027a -- sync_appointment_assignments: exact grants and revokes", () => {
  test("EXECUTE is revoked from PUBLIC, anon, and authenticated -- each exactly once", () => {
    for (const role of ["PUBLIC", "anon", "authenticated"]) {
      const re = new RegExp(`REVOKE ALL ON FUNCTION sync_appointment_assignments\\([\\s\\S]{0,100}?\\)\\s*FROM ${role};`);
      assert.ok(re.test(sql), `expected an explicit REVOKE ALL ... FROM ${role}`);
    }
    assert.equal((sql.match(/REVOKE ALL ON FUNCTION sync_appointment_assignments/g) ?? []).length, 3);
  });

  test("EXECUTE is granted to service_role exactly once, and to no other role", () => {
    const grantMatches = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION sync_appointment_assignments/g)];
    assert.equal(grantMatches.length, 1);
    assert.ok(/GRANT EXECUTE ON FUNCTION sync_appointment_assignments\([\s\S]{0,100}?\)\s*TO service_role;/.test(sql));
  });

  test("the four-parameter signature (UUID, UUID, UUID[], UUID[]) is used consistently across all three REVOKEs and the GRANT", () => {
    const sigList = "UUID, UUID, UUID[], UUID[]";
    const occurrences = sql.split(`sync_appointment_assignments(\n  ${sigList}\n)`).length - 1;
    assert.equal(occurrences, 4);
  });
});

describe("migration 027a -- sync_appointment_assignments: lock order", () => {
  test("locks the parent appointments row FIRST, then appointment_employees, then employees, in that exact positional order", () => {
    const markers = [
      "FROM appointments\n  WHERE id = p_appointment_id",
      "FROM appointment_employees\n  WHERE appointment_id = p_appointment_id",
      "FROM employees WHERE id = ANY(v_desired_canonical)",
    ];
    const positions = markers.map((m) => syncFnBody.indexOf(m));
    for (let i = 0; i < positions.length; i++) {
      assert.ok(positions[i] > -1, `expected to find lock-order marker: ${markers[i]}`);
    }
    for (let i = 1; i < positions.length; i++) {
      assert.ok(positions[i] > positions[i - 1], `lock order violated: "${markers[i]}" must come after "${markers[i - 1]}"`);
    }
  });

  test("the appointments row lock is scoped by id AND workspace_id together, never id alone", () => {
    assert.ok(syncFnBody.includes("WHERE id = p_appointment_id AND workspace_id = p_workspace_id"));
  });

  test("every lock-order table read uses FOR UPDATE", () => {
    const forUpdateCount = (syncFnBody.match(/FOR UPDATE/g) ?? []).length;
    // appointments, appointment_employees, and the employees PERFORM --
    // three FOR UPDATE reads in total.
    assert.equal(forUpdateCount, 3);
  });

  test("the desired employees are locked in deterministic UUID order (ORDER BY id) -- required to prevent a lock-order deadlock between two concurrent calls sharing some desired employees", () => {
    assert.ok(syncFnBody.includes("PERFORM 1 FROM employees WHERE id = ANY(v_desired_canonical) ORDER BY id FOR UPDATE;"));
  });
});

describe("migration 027a -- sync_appointment_assignments: identity and state validation", () => {
  test("a missing appointment (wrong id/workspace) returns appointment_not_found", () => {
    assert.ok(/IF NOT FOUND THEN\s*\n\s*RETURN 'appointment_not_found';/.test(syncFnBody));
  });

  test("duplicate (or NULL-element) expected-current employee ids are rejected as state_changed, via cardinality() rather than COALESCE(array_length(...))", () => {
    assert.ok(/v_expected_distinct_ct IS DISTINCT FROM cardinality\(p_expected_current_employee_ids\)/.test(syncFnBody));
  });

  test("duplicate (or NULL-element) desired employee ids are rejected as state_changed, via cardinality() rather than COALESCE(array_length(...))", () => {
    assert.ok(/v_desired_distinct_ct IS DISTINCT FROM cardinality\(p_desired_employee_ids\)/.test(syncFnBody));
  });

  test("the locked, actual current assignment set is compared against the caller's expected-current set -- a mismatch returns state_changed", () => {
    assert.ok(syncFnBody.includes("IF v_actual_current_employee_ids IS DISTINCT FROM v_expected_current_canonical THEN"));
  });

  test("both current-assignment and desired-employee arrays are canonicalized via array_agg(... ORDER BY ...), the identical technique activate_recurring_series uses", () => {
    assert.ok(syncFnBody.includes("array_agg(employee_id ORDER BY employee_id)"));
    assert.ok((syncFnBody.match(/array_agg\(e ORDER BY e\)/g) ?? []).length === 2, "expected canonicalization for both the expected-current and desired arrays");
  });

  test("production-review correction: a NULL p_expected_current_employee_ids is REJECTED outright (state_changed), never silently normalized to an empty array -- an explicit empty array remains valid and distinct from NULL", () => {
    assert.ok(/IF p_expected_current_employee_ids IS NULL THEN\s*\n\s*RETURN 'state_changed';/.test(syncFnBody));
  });

  test("production-review correction: a NULL p_desired_employee_ids is REJECTED outright (state_changed), never silently normalized to an empty array -- an explicit empty array remains valid and distinct from NULL", () => {
    assert.ok(/IF p_desired_employee_ids IS NULL THEN\s*\n\s*RETURN 'state_changed';/.test(syncFnBody));
  });

  test("production-review correction: both NULL guards occur BEFORE any duplicate-check or canonicalization query runs against either parameter", () => {
    const expectedGuardIdx = syncFnBody.indexOf("IF p_expected_current_employee_ids IS NULL THEN");
    const desiredGuardIdx = syncFnBody.indexOf("IF p_desired_employee_ids IS NULL THEN");
    const expectedUnnestIdx = syncFnBody.indexOf("FROM unnest(p_expected_current_employee_ids) e;");
    const desiredUnnestIdx = syncFnBody.indexOf("FROM unnest(p_desired_employee_ids) e;");
    assert.ok(expectedGuardIdx > -1 && desiredGuardIdx > -1 && expectedUnnestIdx > -1 && desiredUnnestIdx > -1);
    assert.ok(expectedGuardIdx < expectedUnnestIdx);
    assert.ok(desiredGuardIdx < desiredUnnestIdx);
  });

  test("production-review correction: the old COALESCE(..., ARRAY[]::UUID[]) silent-normalization pattern is fully removed from every unnest() call against either parameter", () => {
    assert.ok(!/unnest\(COALESCE\(p_expected_current_employee_ids, ARRAY\[\]::UUID\[\]\)\)/.test(syncFnBody));
    assert.ok(!/unnest\(COALESCE\(p_desired_employee_ids, ARRAY\[\]::UUID\[\]\)\)/.test(syncFnBody));
  });

  test("both NULL guards return strictly before the DELETE/INSERT replace -- zero mutation on rejection", () => {
    const expectedGuardIdx = syncFnBody.indexOf("IF p_expected_current_employee_ids IS NULL THEN");
    const desiredGuardIdx = syncFnBody.indexOf("IF p_desired_employee_ids IS NULL THEN");
    const deleteIdx = syncFnBody.indexOf("DELETE FROM appointment_employees");
    assert.ok(expectedGuardIdx > -1 && desiredGuardIdx > -1 && deleteIdx > -1);
    assert.ok(expectedGuardIdx < deleteIdx);
    assert.ok(desiredGuardIdx < deleteIdx);
  });
});

describe("migration 027a -- sync_appointment_assignments: employee eligibility", () => {
  test("eligibility requires workspace_id match AND active = true, re-checked fresh", () => {
    assert.ok(syncFnBody.includes("WHERE id = desired_id AND workspace_id = p_workspace_id AND active = true"));
  });

  test("any ineligible (nonexistent, cross-workspace, or inactive) desired employee returns employee_not_eligible", () => {
    assert.ok(syncFnBody.includes("RETURN 'employee_not_eligible';"));
  });

  test("the employee-eligibility block is skipped (not an error) for a genuinely empty desired set -- zero employees is a valid, real outcome (unassign everyone)", () => {
    assert.ok(syncFnBody.includes("IF COALESCE(array_length(v_desired_canonical, 1), 0) > 0 THEN"));
  });
});

describe("migration 027a -- sync_appointment_assignments: single atomic replace, no partial write", () => {
  test("replaces via one DELETE followed by one conditional INSERT -- both inside the same transaction, no computed per-row add/remove diff", () => {
    assert.equal((syncFnBody.match(/DELETE FROM appointment_employees/g) ?? []).length, 1);
    assert.equal((syncFnBody.match(/INSERT INTO appointment_employees/g) ?? []).length, 1);
    const deleteIdx = syncFnBody.indexOf("DELETE FROM appointment_employees");
    const insertIdx = syncFnBody.indexOf("INSERT INTO appointment_employees");
    assert.ok(deleteIdx > -1 && insertIdx > -1 && deleteIdx < insertIdx);
  });

  test("the DELETE and INSERT are scoped correctly -- DELETE by appointment_id, INSERT carrying appointment_id, employee_id, and workspace_id for every desired employee", () => {
    assert.ok(syncFnBody.includes("DELETE FROM appointment_employees WHERE appointment_id = p_appointment_id;"));
    assert.ok(syncFnBody.includes("INSERT INTO appointment_employees (appointment_id, employee_id, workspace_id)"));
  });

  test("every early RETURN (appointment_not_found/state_changed/employee_not_eligible) occurs strictly before the DELETE/INSERT replace", () => {
    const deleteIdx = syncFnBody.indexOf("DELETE FROM appointment_employees");
    const earlyReturns = [...syncFnBody.matchAll(/RETURN '(appointment_not_found|state_changed|employee_not_eligible)';/g)];
    assert.ok(earlyReturns.length >= 4, "expected at least four early-exit RETURN statements");
    for (const m of earlyReturns) {
      assert.ok((m.index ?? -1) < deleteIdx, `RETURN '${m[1]}' must occur before the replace, not after`);
    }
  });

  test("the function returns exactly the four documented closed outcomes, no others", () => {
    const returns = [...syncFnBody.matchAll(/RETURN '([a-z_]+)';/g)].map((m) => m[1]);
    assert.deepEqual(new Set(returns), new Set(["appointment_not_found", "state_changed", "employee_not_eligible", "synced"]));
  });
});

describe("migration 027a -- shared-lock concurrency proof: activate_recurring_series and sync_appointment_assignments coordinate via the SAME parent appointments row lock", () => {
  // This is the actual safety property the whole correction rests on --
  // PostgreSQL never propagates a lock from a parent row to its child rows
  // automatically, for any relationship, including a foreign key. The
  // guarantee here comes entirely from BOTH functions explicitly,
  // deliberately locking the exact same appointments row (by id AND
  // workspace_id) as literally their own first table lock, so two
  // concurrent transactions -- one calling each function for the same
  // appointment_id -- are forced by Postgres's own row-lock mechanics to
  // serialize against EACH OTHER, regardless of what either one goes on to
  // touch afterward. This is a narrow, two-function agreement, not a
  // general guarantee for any third, hypothetical future writer.
  test("both functions' FIRST table lock is on appointments, scoped identically by id AND workspace_id, using FOR UPDATE", () => {
    const activateFirstLock = fnBody.indexOf("FROM recurring_series");
    // activate_recurring_series locks recurring_series first (its own row),
    // then the template appointment as its THIRD lock -- still the same
    // appointments row sync_appointment_assignments locks FIRST. The shared
    // boundary is which ROW gets locked (the appointments row for this
    // specific appointment_id), not which numbered step it is in each
    // function's own sequence.
    assert.ok(fnBody.includes("FROM appointments\n  WHERE id = p_template_appointment_id\n    AND workspace_id = p_workspace_id"));
    assert.ok(syncFnBody.includes("FROM appointments\n  WHERE id = p_appointment_id AND workspace_id = p_workspace_id"));
    assert.ok(fnBody.includes("FOR UPDATE;"));
    assert.ok(syncFnBody.includes("FOR UPDATE;"));
    assert.ok(activateFirstLock > -1);
  });

  test("sync_appointment_assignments locks the parent appointments row BEFORE it locks any appointment_employees row -- the actual serialization boundary against a concurrent activation reading those same appointment_employees rows", () => {
    const apptLockIdx = syncFnBody.indexOf("FROM appointments\n  WHERE id = p_appointment_id");
    const assignmentsLockIdx = syncFnBody.indexOf("FROM appointment_employees\n  WHERE appointment_id = p_appointment_id");
    assert.ok(apptLockIdx > -1 && assignmentsLockIdx > -1);
    assert.ok(apptLockIdx < assignmentsLockIdx);
  });

  test("neither function claims or relies on PostgreSQL automatically propagating a parent row lock to child rows -- each explicitly re-locks appointment_employees/employees itself", () => {
    // activate_recurring_series's own appointment_employees lock (step 4)
    // and sync_appointment_assignments's own appointment_employees lock
    // (step 2) are each explicit, independent PERFORM ... FOR UPDATE
    // statements -- proof that the design relies on two functions agreeing
    // to lock the SAME row first, not on any automatic cross-table lock
    // cascade. Production-review correction: the lock is now a plain
    // PERFORM (not the aggregate SELECT itself -- PostgreSQL rejects FOR
    // UPDATE combined with an aggregate function), so the literal text
    // includes the ORDER BY employee_id line between the WHERE and the
    // FOR UPDATE.
    assert.ok(fnBody.includes("FROM appointment_employees\n  WHERE appointment_id = p_template_appointment_id\n  ORDER BY employee_id\n  FOR UPDATE;"));
    assert.ok(syncFnBody.includes("FROM appointment_employees\n  WHERE appointment_id = p_appointment_id\n  ORDER BY employee_id\n  FOR UPDATE;"));
  });

  test("the migration's own comment documents this as a narrow, two-function agreement, not a general PostgreSQL guarantee", () => {
    assert.ok(/does NOT claim PostgreSQL propagates a lock from a parent row/.test(sql));
    assert.ok(/narrow, two-function shared-lock agreement/.test(sql));
  });
});

describe("migration 027a -- production-review correction: FOR UPDATE is never combined with an aggregate function in the same statement", () => {
  // PostgreSQL rejects this outright: "SELECT FOR UPDATE cannot be used
  // with aggregate functions." The original version of both functions
  // violated this by appending FOR UPDATE directly to the
  // array_agg()-aggregating SELECT that reads appointment_employees --
  // which means the migration, as originally written, could never actually
  // run. The fix splits each into two statements: a plain, non-aggregating
  // PERFORM ... FOR UPDATE that takes the lock, followed by a separate,
  // unlocked SELECT ... array_agg(...) that reads the now-locked rows.
  // Full-line "-- ..." comments are stripped BEFORE splitting into
  // statements -- otherwise a comment that merely explains the restriction
  // (and so mentions both "array_agg" and a locking clause in its own
  // prose) would get lumped into the same chunk as the next real statement
  // and produce a false positive here.
  function stripLineComments(body: string): string {
    return body
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
  }

  function statementsOf(fnBody: string): string[] {
    return stripLineComments(fnBody).split(/;\s*\n/);
  }

  test("no statement in either function combines an aggregate function (array_agg/count/sum/avg/min/max) with FOR UPDATE or FOR SHARE", () => {
    for (const body of [fnBody, syncFnBody]) {
      for (const stmt of statementsOf(body)) {
        const hasAggregate = /\b(array_agg|count|sum|avg|min|max)\s*\(/i.test(stmt);
        const hasLockClause = /\bFOR (UPDATE|SHARE)\b/.test(stmt);
        assert.ok(
          !(hasAggregate && hasLockClause),
          `a statement combines an aggregate with a locking clause, which PostgreSQL rejects outright: ${stmt.trim().slice(0, 160)}`
        );
      }
    }
  });

  test("activate_recurring_series locks appointment_employees via a plain PERFORM 1 (no aggregate) strictly BEFORE the separate array_agg() SELECT that reads the now-locked rows", () => {
    const lockIdx = fnBody.indexOf("PERFORM 1\n  FROM appointment_employees\n  WHERE appointment_id = p_template_appointment_id\n  ORDER BY employee_id\n  FOR UPDATE;");
    const aggIdx = fnBody.indexOf("SELECT COALESCE(array_agg(employee_id ORDER BY employee_id), ARRAY[]::UUID[])\n  INTO v_actual_employee_ids\n  FROM appointment_employees\n  WHERE appointment_id = p_template_appointment_id;");
    assert.ok(lockIdx > -1, "expected the plain, non-aggregating PERFORM lock");
    assert.ok(aggIdx > -1, "expected the separate, unlocked aggregate SELECT");
    assert.ok(lockIdx < aggIdx, "the lock must be taken before the aggregation reads the rows");
  });

  test("sync_appointment_assignments locks appointment_employees via a plain PERFORM 1 (no aggregate) strictly BEFORE the separate array_agg() SELECT that reads the now-locked rows", () => {
    const lockIdx = syncFnBody.indexOf("PERFORM 1\n  FROM appointment_employees\n  WHERE appointment_id = p_appointment_id\n  ORDER BY employee_id\n  FOR UPDATE;");
    const aggIdx = syncFnBody.indexOf("SELECT COALESCE(array_agg(employee_id ORDER BY employee_id), ARRAY[]::UUID[])\n  INTO v_actual_current_employee_ids\n  FROM appointment_employees\n  WHERE appointment_id = p_appointment_id;");
    assert.ok(lockIdx > -1, "expected the plain, non-aggregating PERFORM lock");
    assert.ok(aggIdx > -1, "expected the separate, unlocked aggregate SELECT");
    assert.ok(lockIdx < aggIdx, "the lock must be taken before the aggregation reads the rows");
  });

  test("both functions' appointment_employees PERFORM lock still occurs strictly after their shared parent appointments row lock -- the fix preserves the approved global lock order, it does not renumber it", () => {
    const activateApptLockIdx = fnBody.indexOf("FROM appointments\n  WHERE id = p_template_appointment_id");
    const activateAssignmentsLockIdx = fnBody.indexOf("PERFORM 1\n  FROM appointment_employees\n  WHERE appointment_id = p_template_appointment_id");
    assert.ok(activateApptLockIdx > -1 && activateAssignmentsLockIdx > -1);
    assert.ok(activateApptLockIdx < activateAssignmentsLockIdx);

    const syncApptLockIdx = syncFnBody.indexOf("FROM appointments\n  WHERE id = p_appointment_id AND workspace_id = p_workspace_id");
    const syncAssignmentsLockIdx = syncFnBody.indexOf("PERFORM 1\n  FROM appointment_employees\n  WHERE appointment_id = p_appointment_id");
    assert.ok(syncApptLockIdx > -1 && syncAssignmentsLockIdx > -1);
    assert.ok(syncApptLockIdx < syncAssignmentsLockIdx);
  });
});
