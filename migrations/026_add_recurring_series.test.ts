// Block 2B: static, source-level proof that migration 026 is additive and
// non-destructive. Migrations are never executed by this test suite (no
// database is reachable from tests anywhere in this repository) -- this
// file proves the SQL text itself, matching the same "prove it from source"
// discipline as every prior migration's own test (023/024/025).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./026_add_recurring_series.sql", import.meta.url)), "utf8");
const upperSql = sql.toUpperCase();

describe("migration 026 -- additive and non-destructive", () => {
  test("contains no DROP/TRUNCATE statement, and no UPDATE/DELETE against appointments", () => {
    for (const forbidden of ["DROP TABLE", "DROP COLUMN", "TRUNCATE", "UPDATE APPOINTMENTS", "DELETE FROM APPOINTMENTS"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("never issues UPDATE or DELETE against appointments, clients, employees, workspaces, or company_settings", () => {
    for (const table of ["APPOINTMENTS", "CLIENTS", "EMPLOYEES", "WORKSPACES", "COMPANY_SETTINGS"]) {
      assert.ok(!new RegExp(`UPDATE\\s+${table}\\b`).test(upperSql), `must not UPDATE ${table}`);
      assert.ok(!new RegExp(`DELETE\\s+FROM\\s+${table}\\b`).test(upperSql), `must not DELETE FROM ${table}`);
    }
  });

  test("creates exactly one new table: recurring_series, guarded by IF NOT EXISTS", () => {
    const createTableMatches = [...sql.matchAll(/CREATE TABLE\s+(IF NOT EXISTS\s+)?(\w+)/gi)];
    assert.equal(createTableMatches.length, 1);
    assert.equal(createTableMatches[0][2].toLowerCase(), "recurring_series");
    assert.ok(createTableMatches[0][1], "CREATE TABLE must be guarded with IF NOT EXISTS");
  });

  test("every ALTER TABLE targets only the newly-created recurring_series table (enabling RLS), never an existing table", () => {
    const alterMatches = [...sql.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
    assert.deepEqual(new Set(alterMatches), new Set(["recurring_series"]));
  });

  test("recurring_series.id is not a new appointments column -- appointments.series_id is never referenced as a column to add", () => {
    assert.ok(!/ADD COLUMN/i.test(sql));
  });
});

describe("migration 026 -- recurring_series column shape", () => {
  test("status defaults to review_required and is constrained to the three approved values", () => {
    assert.match(sql, /status\s+TEXT NOT NULL DEFAULT 'review_required'/);
    assert.match(sql, /CHECK\s*\(status IN \('active', 'stopped', 'review_required'\)\)/);
  });

  test("client_id is NOT NULL, references clients, and uses ON DELETE RESTRICT", () => {
    assert.match(sql, /client_id\s+UUID NOT NULL REFERENCES clients\(id\) ON DELETE RESTRICT/);
  });

  test("is_demo is NOT NULL with no default", () => {
    assert.match(sql, /is_demo\s+BOOLEAN NOT NULL,/);
    assert.ok(!/is_demo\s+BOOLEAN NOT NULL DEFAULT/i.test(sql));
  });

  test("template_appointment_id is nullable, references appointments, ON DELETE SET NULL", () => {
    assert.match(sql, /template_appointment_id\s+UUID REFERENCES appointments\(id\) ON DELETE SET NULL/);
    assert.ok(!/template_appointment_id\s+UUID NOT NULL/i.test(sql));
  });

  test("frequency_type excludes one_time", () => {
    assert.match(sql, /CHECK\s*\(frequency_type IN \('daily', 'weekdays', 'weekly', 'monthly'\)\)/);
    const freqCheckLine = sql.split("\n").find((l) => l.includes("frequency_type IN"));
    assert.ok(freqCheckLine && !freqCheckLine.includes("one_time"));
  });

  test("weekly/monthly/daily-weekdays interval CHECK is frequency-specific with the approved bounds", () => {
    assert.ok(sql.includes("repeat_weeks  BETWEEN 1 AND 8"));
    assert.ok(sql.includes("repeat_months BETWEEN 1 AND 12"));
    assert.ok(sql.includes("repeat_weeks IS NULL AND repeat_months IS NULL"));
  });

  test("anchor_timezone is constrained to the exact seven-value IANA allowlist", () => {
    for (const tz of [
      "America/New_York", "America/Chicago", "America/Denver",
      "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu",
    ]) {
      assert.ok(sql.includes(`'${tz}'`), `expected anchor_timezone allowlist to include ${tz}`);
    }
  });

  test("source is constrained to legacy_backfill/owner_created", () => {
    assert.match(sql, /CHECK\s*\(source IN \('legacy_backfill', 'owner_created'\)\)/);
  });

  test("active status requires template_appointment_id and reviewed_at together (DB-enforced)", () => {
    assert.match(sql, /CHECK\s*\(status <> 'active' OR \(template_appointment_id IS NOT NULL AND reviewed_at IS NOT NULL\)\)/);
  });

  test("stopped status requires stopped_at (DB-enforced)", () => {
    assert.match(sql, /CHECK\s*\(status <> 'stopped' OR stopped_at IS NOT NULL\)/);
  });

  test("workspace_id references workspaces with ON DELETE RESTRICT", () => {
    assert.match(sql, /workspace_id\s+UUID NOT NULL REFERENCES workspaces\(id\) ON DELETE RESTRICT/);
  });
});

describe("migration 026 -- indexes and RLS", () => {
  test("creates workspace_id, partial active-status, and client_id indexes, all IF NOT EXISTS", () => {
    assert.ok(/CREATE INDEX IF NOT EXISTS idx_recurring_series_workspace_id ON recurring_series \(workspace_id\)/.test(sql));
    assert.ok(/CREATE INDEX IF NOT EXISTS idx_recurring_series_active ON recurring_series \(workspace_id\) WHERE status = 'active'/.test(sql));
    assert.ok(/CREATE INDEX IF NOT EXISTS idx_recurring_series_client_id ON recurring_series \(client_id\)/.test(sql));
  });

  test("enables RLS on recurring_series with no policy and no GRANT/REVOKE statement", () => {
    assert.ok(/ALTER TABLE recurring_series ENABLE ROW LEVEL SECURITY/.test(sql));
    assert.ok(!upperSql.includes("CREATE POLICY"));
    assert.ok(!upperSql.includes("GRANT "));
    assert.ok(!upperSql.includes("REVOKE "));
  });
});

describe("migration 026 -- occurrence uniqueness", () => {
  test("adds the unconditional, all-status unique index on (series_id, scheduled_for) where series_id is not null", () => {
    assert.ok(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_series_occurrence\s*\n\s*ON appointments \(series_id, scheduled_for\)\s*\n\s*WHERE series_id IS NOT NULL/.test(sql)
    );
  });

  test("the unique index has no additional status filter -- covers scheduled and cancelled rows alike", () => {
    const idxStatement = sql.slice(sql.indexOf("CREATE UNIQUE INDEX"), sql.indexOf("CREATE UNIQUE INDEX") + 300);
    assert.ok(!/status/i.test(idxStatement), "the unique index must not be scheduled-only");
  });
});

describe("migration 026 -- legacy backfill", () => {
  test("every backfilled row is review_required, never active or stopped", () => {
    const insertBlock = sql.slice(sql.indexOf("INSERT INTO recurring_series"));
    assert.ok(insertBlock.includes("'review_required'"));
    assert.ok(!/'active'|'stopped'/.test(insertBlock));
  });

  test("every backfilled row has template_appointment_id explicitly NULL", () => {
    const insertBlock = sql.slice(sql.indexOf("INSERT INTO recurring_series"));
    const selectLines = insertBlock.split("\n").slice(0, 20).join("\n");
    assert.ok(/NULL,\s*\n\s*vs\.frequency_type/.test(selectLines), "template_appointment_id column position must be explicit NULL");
  });

  test("backfill only ever SELECTs from appointments/workspaces/company_settings -- never writes to them", () => {
    const insertBlock = sql.slice(sql.indexOf("WITH tz_allowlist"));
    assert.ok(!/INSERT INTO (appointments|workspaces|company_settings|clients)/i.test(insertBlock));
  });

  test("backfill is idempotent via a NOT EXISTS guard keyed on recurring_series.id", () => {
    assert.ok(/WHERE NOT EXISTS \(SELECT 1 FROM recurring_series rs WHERE rs\.id = vs\.series_id\)/.test(sql));
  });

  test("series_shape requires single workspace/client/is_demo/frequency_type/repeat_weeks/repeat_months before backfilling", () => {
    const shapeBlock = sql.slice(sql.indexOf("series_shape AS"), sql.indexOf("valid_series AS"));
    assert.ok(/COUNT\(DISTINCT workspace_id\) = 1/.test(shapeBlock));
    assert.ok(/COUNT\(DISTINCT client_id\) = 1/.test(shapeBlock));
    assert.ok(/COUNT\(DISTINCT is_demo\) = 1/.test(shapeBlock));
    assert.ok(/COUNT\(DISTINCT frequency_type\) = 1/.test(shapeBlock));
  });

  test("anchor is derived from the EARLIEST appointment across the entire series (DISTINCT ON ... ORDER BY scheduled_for ASC), not the earliest live/future row", () => {
    assert.ok(/DISTINCT ON \(a\.series_id\) a\.series_id, a\.workspace_id, a\.scheduled_for/.test(sql));
    const earliestBlock = sql.slice(sql.indexOf("earliest_appt AS"), sql.indexOf("INSERT INTO recurring_series"));
    assert.ok(!/status = 'scheduled'/.test(earliestBlock), "earliest-appointment derivation must not be restricted to scheduled/live rows");
    assert.ok(!/scheduled_for > now\(\)/.test(earliestBlock), "earliest-appointment derivation must not be restricted to future rows");
  });

  test("anchor timezone resolution mirrors effectiveTimezone's own allowlist + NULL fallback", () => {
    const wtBlock = sql.slice(sql.indexOf("workspace_tz AS"), sql.indexOf("series_shape AS"));
    assert.ok(wtBlock.includes("'America/New_York'"));
    assert.ok(/cs\.timezone IN \(SELECT tz FROM tz_allowlist\)/.test(wtBlock));
  });
});

// Production preflight correction: PostgreSQL has no built-in MIN(uuid)
// aggregate (min/max are only defined for a fixed set of built-in types,
// and uuid is not one of them, even though it has btree ordering) -- a bare
// MIN(workspace_id)/MIN(client_id) in series_shape would fail at migration
// run time with "function min(uuid) does not exist". The fix aggregates
// through text and casts back.
describe("migration 026 -- PostgreSQL-safe UUID aggregation", () => {
  test("workspace_id and client_id are aggregated via MIN(...::text)::uuid, never a bare MIN(uuid column)", () => {
    assert.ok(
      /MIN\(workspace_id::text\)::uuid/.test(sql),
      "expected MIN(workspace_id::text)::uuid in series_shape"
    );
    assert.ok(
      /MIN\(client_id::text\)::uuid/.test(sql),
      "expected MIN(client_id::text)::uuid in series_shape"
    );
  });

  test("no bare MIN(workspace_id) or MIN(client_id) exists anywhere in the file -- PostgreSQL has no min(uuid) aggregate", () => {
    assert.ok(!/MIN\(workspace_id\)/.test(sql), "bare MIN(workspace_id) would fail at runtime: function min(uuid) does not exist");
    assert.ok(!/MIN\(client_id\)/.test(sql), "bare MIN(client_id) would fail at runtime: function min(uuid) does not exist");
  });
});

// Production preflight correction: the legacy appointments table historically
// stored repeat_weeks = 1 as a default even for daily/weekdays/monthly rows
// (frequencies where the column is meaningless). Without normalization, a
// structurally-otherwise-valid daily/weekdays/monthly series with that
// legacy artifact would either be wrongly excluded from the backfill (its
// non-NULL repeat_weeks fails valid_series' own "IS NULL" requirement) or,
// worse, wrongly attempted with a value that violates recurring_series' own
// strict CHECK constraint. The fix normalizes ONLY the exact combination
// (frequency_type <> 'weekly' AND repeat_weeks = 1) to NULL, in a dedicated
// normalized_appts CTE that feeds series_shape -- before any shape or
// validity check runs, and before anything is ever read by earliest_appt
// (which still reads raw appointments rows for scheduled_for, unaffected).
describe("migration 026 -- legacy repeat_weeks normalization (daily/weekdays/monthly's irrelevant default value)", () => {
  const NORMALIZATION_EXPR =
    "CASE WHEN frequency_type <> 'weekly' AND repeat_weeks = 1 THEN NULL ELSE repeat_weeks END AS repeat_weeks";
  const REPEAT_MONTHS_NORMALIZATION_EXPR =
    "CASE WHEN frequency_type <> 'monthly' AND repeat_months = 1 THEN NULL ELSE repeat_months END AS repeat_months";

  test("the exact normalization expression exists, scoped to non-weekly rows whose repeat_weeks is exactly the legacy default (1)", () => {
    assert.ok(sql.includes(NORMALIZATION_EXPR), "expected the exact repeat_weeks normalization CASE expression");
  });

  test("normalization runs in its own CTE (normalized_appts), positioned before series_shape's GROUP BY/HAVING", () => {
    const normalizedIdx = sql.indexOf("normalized_appts AS");
    const seriesShapeIdx = sql.indexOf("series_shape AS");
    const exprIdx = sql.indexOf(NORMALIZATION_EXPR);
    assert.ok(normalizedIdx > -1 && seriesShapeIdx > -1 && exprIdx > -1);
    assert.ok(normalizedIdx < exprIdx, "the CASE expression must live inside normalized_appts");
    assert.ok(exprIdx < seriesShapeIdx, "normalization must happen before series_shape groups the rows");
    // series_shape must read FROM the normalized CTE, not raw appointments.
    const shapeBlock = sql.slice(seriesShapeIdx, sql.indexOf("valid_series AS"));
    assert.ok(/FROM normalized_appts/.test(shapeBlock));
  });

  test("daily: a legacy repeat_weeks of exactly 1 normalizes to NULL (per the locked CASE expression: frequency_type <> 'weekly' AND repeat_weeks = 1 -> NULL)", () => {
    // 'daily' <> 'weekly' is true, so a stored value of 1 hits the THEN
    // branch and becomes NULL -- verified structurally via the single locked
    // expression asserted above, which is frequency-type-agnostic for every
    // non-weekly value: this test documents the daily case specifically.
    assert.ok(sql.includes(NORMALIZATION_EXPR));
  });

  test("weekdays: a legacy repeat_weeks of exactly 1 normalizes to NULL, by the same locked expression", () => {
    // 'weekdays' <> 'weekly' is also true -- same THEN branch, same outcome.
    assert.ok(sql.includes(NORMALIZATION_EXPR));
  });

  test("monthly: a legacy repeat_weeks of exactly 1 normalizes to NULL while monthly's own repeat_months (including a genuine value of 1) is preserved literally", () => {
    assert.ok(sql.includes(NORMALIZATION_EXPR));
    // repeat_months has its OWN, separately-guarded normalization (frequency_type
    // <> 'monthly' AND repeat_months = 1 -> NULL) -- a monthly row never matches
    // that guard, so its repeat_months always falls through to ELSE repeat_months
    // (itself, unchanged), even when the genuine value happens to be 1.
    assert.ok(sql.includes(REPEAT_MONTHS_NORMALIZATION_EXPR));
    assert.ok(sql.includes("frequency_type <> 'monthly' AND repeat_months = 1"));
  });

  test("weekly is excluded from normalization entirely -- its own repeat_weeks (including a genuine value of 1) is preserved literally, and valid_series still requires it BETWEEN 1 AND 8", () => {
    // The CASE condition's guard is `frequency_type <> 'weekly'` -- a weekly
    // row never matches the THEN branch regardless of its repeat_weeks
    // value, so it always falls through to ELSE repeat_weeks (itself,
    // unchanged).
    assert.ok(sql.includes("frequency_type <> 'weekly' AND repeat_weeks = 1"));
    const validBlock = sql.slice(sql.indexOf("valid_series AS"), sql.indexOf("earliest_appt AS"));
    assert.ok(/frequency_type = 'weekly'\s+AND\s+ss\.repeat_weeks\s+BETWEEN 1 AND 8/.test(validBlock.replace(/\s+/g, " ")) ||
      /ss\.frequency_type = 'weekly'  AND ss\.repeat_weeks  BETWEEN 1 AND 8/.test(validBlock));
  });

  test("a non-weekly series whose repeat_weeks is non-null and NOT exactly 1 is still excluded -- normalization forgives only the one known legacy default, never any other value", () => {
    // The CASE condition requires repeat_weeks = 1 literally; any other
    // value (e.g. 3, 5) falls through to ELSE repeat_weeks (itself,
    // unchanged) and therefore still fails valid_series' own
    // "repeat_weeks IS NULL" requirement for daily/weekdays/monthly.
    assert.ok(!sql.includes("repeat_weeks = 1 OR"), "normalization must not be broadened beyond the exact value 1");
    assert.ok(!/repeat_weeks\s*(<=|>=|<|>|BETWEEN)\s*1/.test(sql.slice(sql.indexOf("normalized_appts AS"), sql.indexOf("series_shape AS"))), "normalization must use an exact equality check, not a range");
  });

  test("daily/weekdays: repeat_months has no equivalent forgiveness -- an unexpected non-null value still excludes the series (valid_series requires it IS NULL, untouched by normalization)", () => {
    const validBlock = sql.slice(sql.indexOf("valid_series AS"), sql.indexOf("earliest_appt AS"));
    assert.ok(/frequency_type IN \('daily', 'weekdays'\) AND ss\.repeat_weeks IS NULL AND ss\.repeat_months IS NULL/.test(validBlock));
  });

  test("normalized_appts still only ever SELECTs from appointments -- it is a read-only reshaping CTE, never a write", () => {
    const normalizedBlock = sql.slice(sql.indexOf("normalized_appts AS"), sql.indexOf("series_shape AS"));
    assert.ok(/FROM appointments\b/.test(normalizedBlock));
    assert.ok(!/INSERT|UPDATE|DELETE/i.test(normalizedBlock));
  });
});

// Production preflight finding (post-review, round 2): the same legacy
// default-value-of-1 artifact exists symmetrically in the OTHER interval
// column. A real weekly/repeat_weeks=4/repeat_months=1 series (7
// appointments, is_demo = false) was found wrongly excluded from the
// backfill, because valid_series' own weekly branch requires
// repeat_months IS NULL literally. The fix mirrors the repeat_weeks
// normalization exactly: repeat_months = 1 is normalized to NULL only when
// frequency_type <> 'monthly' (i.e. only when repeat_months is NOT the
// column that actually belongs to that row's own frequency). monthly's own
// repeat_months -- including a genuine value of 1 -- is never touched.
describe("migration 026 -- legacy repeat_months normalization (weekly/daily/weekdays's irrelevant default value)", () => {
  const REPEAT_MONTHS_NORMALIZATION_EXPR =
    "CASE WHEN frequency_type <> 'monthly' AND repeat_months = 1 THEN NULL ELSE repeat_months END AS repeat_months";

  test("the exact normalization expression exists, scoped to non-monthly rows whose repeat_months is exactly the legacy default (1)", () => {
    assert.ok(sql.includes(REPEAT_MONTHS_NORMALIZATION_EXPR), "expected the exact repeat_months normalization CASE expression");
  });

  test("normalization runs inside normalized_appts, positioned before series_shape's GROUP BY/HAVING, and series_shape reads FROM normalized_appts", () => {
    const normalizedIdx = sql.indexOf("normalized_appts AS");
    const seriesShapeIdx = sql.indexOf("series_shape AS");
    const exprIdx = sql.indexOf(REPEAT_MONTHS_NORMALIZATION_EXPR);
    assert.ok(normalizedIdx > -1 && seriesShapeIdx > -1 && exprIdx > -1);
    assert.ok(normalizedIdx < exprIdx, "the CASE expression must live inside normalized_appts");
    assert.ok(exprIdx < seriesShapeIdx, "normalization must happen before series_shape groups the rows");
    const shapeBlock = sql.slice(seriesShapeIdx, sql.indexOf("valid_series AS"));
    assert.ok(/FROM normalized_appts/.test(shapeBlock));
  });

  test("production evidence case: weekly, repeat_weeks=4, legacy repeat_months=1 backfills as weekly/repeat_weeks=4/repeat_months=NULL and is no longer excluded", () => {
    // 'weekly' <> 'monthly' is true, so a stored repeat_months of exactly 1
    // hits the THEN branch and becomes NULL -- repeat_weeks is untouched by
    // the SEPARATE repeat_weeks guard, since frequency_type = 'weekly' fails
    // that guard's `<> 'weekly'` condition. The resulting shape
    // (weekly, repeat_weeks=4, repeat_months=NULL) satisfies valid_series'
    // own weekly branch (repeat_weeks BETWEEN 1 AND 8 AND repeat_months IS
    // NULL) -- exactly the previously-excluded production case.
    assert.ok(sql.includes(REPEAT_MONTHS_NORMALIZATION_EXPR));
    assert.ok(sql.includes("CASE WHEN frequency_type <> 'weekly' AND repeat_weeks = 1 THEN NULL ELSE repeat_weeks END AS repeat_weeks"));
    const validBlock = sql.slice(sql.indexOf("valid_series AS"), sql.indexOf("earliest_appt AS"));
    assert.ok(/ss\.frequency_type = 'weekly'\s+AND ss\.repeat_weeks\s+BETWEEN 1 AND 8\s+AND ss\.repeat_months IS NULL/.test(validBlock));
  });

  test("daily/weekdays: a legacy repeat_months of exactly 1 normalizes to NULL, by the same locked expression", () => {
    assert.ok(sql.includes(REPEAT_MONTHS_NORMALIZATION_EXPR));
  });

  test("a non-monthly series whose repeat_months is non-null and NOT exactly 1 is still excluded -- normalization forgives only the one known legacy default, never any other value", () => {
    const normalizedBlock = sql.slice(sql.indexOf("normalized_appts AS"), sql.indexOf("series_shape AS"));
    assert.ok(!normalizedBlock.includes("repeat_months = 1 OR"), "normalization must not be broadened beyond the exact value 1");
    assert.ok(!/repeat_months\s*(<=|>=|<|>|BETWEEN)\s*1/.test(normalizedBlock), "normalization must use an exact equality check, not a range");
  });

  test("monthly's own repeat_months is never normalized -- valid_series still requires it BETWEEN 1 AND 12 literally, including a genuine value of 1", () => {
    assert.ok(sql.includes("frequency_type <> 'monthly' AND repeat_months = 1"));
    const validBlock = sql.slice(sql.indexOf("valid_series AS"), sql.indexOf("earliest_appt AS"));
    assert.ok(/ss\.frequency_type = 'monthly'\s+AND ss\.repeat_months\s+BETWEEN 1 AND 12/.test(validBlock));
  });

  test("series_shape aggregates BOTH normalized columns from normalized_appts, not raw appointments", () => {
    const shapeBlock = sql.slice(sql.indexOf("series_shape AS"), sql.indexOf("valid_series AS"));
    assert.ok(/FROM normalized_appts/.test(shapeBlock));
    assert.ok(!/FROM appointments\b/.test(shapeBlock), "series_shape must not read raw appointments directly");
    assert.ok(/MIN\(repeat_weeks\)/.test(shapeBlock));
    assert.ok(/MIN\(repeat_months\)/.test(shapeBlock));
  });

  test("normalized_appts remains SELECT-only -- no INSERT/UPDATE/DELETE against appointments or any other table", () => {
    const normalizedBlock = sql.slice(sql.indexOf("normalized_appts AS"), sql.indexOf("series_shape AS"));
    assert.ok(/FROM appointments\b/.test(normalizedBlock));
    assert.ok(!/INSERT|UPDATE|DELETE/i.test(normalizedBlock));
  });

  test("no production appointment row is ever updated by this migration -- confirmed globally, not just within normalized_appts", () => {
    assert.ok(!/UPDATE\s+appointments\b/i.test(sql));
    assert.ok(!/DELETE\s+FROM\s+appointments\b/i.test(sql));
  });
});

describe("migration 026 -- explicit transaction", () => {
  test("the entire migration is wrapped in an explicit BEGIN;/COMMIT; -- all-or-nothing is guaranteed, not assumed from the SQL client's own implicit multi-statement handling", () => {
    // Strip leading `--` line comments (the file's own header documentation)
    // before checking that BEGIN; is the first actual statement.
    const withoutLeadingComments = sql.replace(/^(\s*--[^\n]*\n)+/, "").trim();
    assert.ok(/^BEGIN;/.test(withoutLeadingComments), "the first SQL statement (after any leading comments) must be BEGIN;");
    assert.ok(/COMMIT;\s*$/.test(sql.trim()), "the file must end with COMMIT;");
  });

  test("BEGIN appears exactly once, before every other statement, and COMMIT appears exactly once, after every other statement", () => {
    const beginIdx = sql.indexOf("BEGIN;");
    const commitIdx = sql.indexOf("COMMIT;");
    // "CREATE TABLE IF NOT EXISTS recurring_series" (the real statement),
    // not just "CREATE TABLE" -- the header comment's own prose mentions
    // "CREATE TABLE/INDEX" descriptively, which would otherwise be found
    // first and defeat this ordering check.
    const createTableIdx = sql.indexOf("CREATE TABLE IF NOT EXISTS recurring_series");
    assert.equal((sql.match(/\bBEGIN;/g) ?? []).length, 1);
    assert.equal((sql.match(/\bCOMMIT;/g) ?? []).length, 1);
    assert.ok(beginIdx > -1 && createTableIdx > -1 && commitIdx > -1);
    assert.ok(beginIdx < createTableIdx);
    assert.ok(beginIdx < sql.indexOf("INSERT INTO recurring_series"));
    assert.ok(commitIdx > createTableIdx);
    assert.ok(commitIdx > sql.indexOf("INSERT INTO recurring_series"));
  });

  test("no CREATE INDEX CONCURRENTLY is used -- required, since CONCURRENTLY cannot run inside a transaction block", () => {
    assert.ok(!/CONCURRENTLY/i.test(sql));
  });
});
