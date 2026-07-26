// Phase 5.7D: static, source-level proof that migration 017 is additive and
// non-destructive. Migrations are never executed by this test suite (no
// database is reachable from tests anywhere in this repository) -- this
// file proves the SQL text itself contains no destructive statement and
// carries the required safety properties, matching the same discipline
// already established for migration 016.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./017_add_signup_and_owner_mfa.sql", import.meta.url)), "utf8");
const upperSql = sql.toUpperCase();

describe("migration 017 -- additive and non-destructive", () => {
  test("contains no DROP TABLE/DROP COLUMN/TRUNCATE statement anywhere", () => {
    for (const forbidden of ["DROP TABLE", "DROP COLUMN", "TRUNCATE"]) {
      assert.ok(!upperSql.includes(forbidden), `must not contain "${forbidden}"`);
    }
  });

  test("the only DELETE FROM statement targets rate_limit_counters (a table this same migration creates, holding only ephemeral abuse-protection counters, never business/audit data) -- and is scoped, not a bare unscoped delete", () => {
    const deleteMatches = [...sql.matchAll(/DELETE FROM \w+/gi)];
    assert.deepEqual(
      deleteMatches.map((m) => m[0].toUpperCase()),
      ["DELETE FROM RATE_LIMIT_COUNTERS"]
    );
    assert.ok(sql.includes("DELETE FROM rate_limit_counters WHERE bucket_key = p_bucket_key"), "must be scoped by bucket_key, never a bare unscoped delete");
  });

  test("only ADD COLUMN statements touch the pre-existing workspace_memberships table, guarded with IF NOT EXISTS", () => {
    assert.ok(sql.includes("ADD COLUMN IF NOT EXISTS terms_accepted_at"));
    assert.ok(sql.includes("ADD COLUMN IF NOT EXISTS terms_version"));
    assert.ok(sql.includes("ADD COLUMN IF NOT EXISTS session_epoch"));
    // workspace_memberships itself is never touched by ALTER COLUMN --
    // proved precisely (scoped to this table's own ALTER block) in the
    // next test below. The migration as a whole legitimately contains one
    // ALTER COLUMN elsewhere (Phase 5.7D-R5's company_settings.
    // notifications_enabled default correction), so a blanket file-wide
    // check here would be wrong.
  });

  test("the ADD COLUMN statements on the pre-existing workspace_memberships table are nullable or carry a safe default -- no bare NOT NULL forcing an unexplained value onto every existing row", () => {
    const alterStart = sql.indexOf("ALTER TABLE workspace_memberships");
    const alterEnd = sql.indexOf(";", alterStart);
    const alterBlock = sql.slice(alterStart, alterEnd);
    assert.ok(!/terms_accepted_at\s+timestamptz\s+NOT\s+NULL(?!\s+DEFAULT)/i.test(alterBlock));
    assert.ok(!/terms_version\s+text\s+NOT\s+NULL(?!\s+DEFAULT)/i.test(alterBlock));
    // session_epoch IS NOT NULL, but only paired with a DEFAULT -- safe for
    // ADD COLUMN (existing rows are backfilled with the default, not left
    // null-then-violating), unlike a bare NOT NULL with no default.
    assert.ok(/session_epoch\s+integer\s+NOT\s+NULL\s+DEFAULT\s+1/i.test(alterBlock));
    // Scoped specifically to this table's own ALTER block -- the migration
    // as a whole legitimately contains one ALTER COLUMN elsewhere (Phase
    // 5.7D-R5's company_settings.notifications_enabled default correction,
    // proved separately below), but workspace_memberships itself is never
    // touched by anything other than ADD COLUMN.
    assert.ok(!alterBlock.toUpperCase().includes("ALTER COLUMN"), "workspace_memberships itself must not be touched by ALTER COLUMN");
  });

  test("both new tables and the two new indexes are IF NOT EXISTS guarded", () => {
    assert.ok(sql.includes("CREATE TABLE IF NOT EXISTS pending_signups"));
    assert.ok(sql.includes("CREATE TABLE IF NOT EXISTS pending_mfa_challenges"));
    assert.ok(sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_signups_auth_user_id"));
    assert.ok(sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_signups_email"));
    assert.ok(sql.includes("CREATE INDEX IF NOT EXISTS idx_pending_mfa_challenges_auth_user_id"));
    assert.ok(sql.includes("CREATE INDEX IF NOT EXISTS idx_pending_mfa_challenges_expires_at"));
  });

  test("touches only the expected tables by name -- no other table is referenced by an ALTER TABLE statement", () => {
    const alterMatches = [...sql.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1]);
    assert.deepEqual(
      new Set(alterMatches),
      new Set(["pending_signups", "pending_mfa_challenges", "workspace_memberships", "rate_limit_counters", "company_settings"])
    );
  });

  test("no UPDATE statement targets company_settings anywhere in this file -- the notifications_enabled correction below is a schema-default change only, never a data rewrite of existing rows", () => {
    assert.ok(!/UPDATE\s+company_settings/i.test(sql));
  });

  test("the pre-existing workspace_memberships(workspace_id, profile_id) uniqueness is never referenced, dropped, or altered -- this migration only ever adds the separate (profile_id, role) pair", () => {
    assert.ok(!upperSql.includes("DROP CONSTRAINT"));
    // No UNIQUE constraint definition mentions the (workspace_id, profile_id)
    // pair in either column order -- the only constraint this migration
    // ever ADDs is uq_workspace_memberships_profile_role, tested above.
    assert.ok(!/UNIQUE\s*\(\s*workspace_id\s*,\s*profile_id\s*\)/i.test(sql));
    assert.ok(!/UNIQUE\s*\(\s*profile_id\s*,\s*workspace_id\s*\)/i.test(sql));
  });

  test("both new tables enable RLS with no CREATE POLICY statement -- deny-all for anon/authenticated, matching every other table in this schema", () => {
    assert.ok(sql.includes("ALTER TABLE pending_signups ENABLE ROW LEVEL SECURITY"));
    assert.ok(sql.includes("ALTER TABLE pending_mfa_challenges ENABLE ROW LEVEL SECURITY"));
    assert.ok(!upperSql.includes("CREATE POLICY"));
    assert.ok(!upperSql.includes("ENABLE ROW LEVEL SECURITY") || !upperSql.includes("USING (TRUE)"));
  });

  test("the provisioning function's only parameter is the Auth user id -- no workspace/role/billing/toggle/entitlement/trial parameter exists", () => {
    const sigMatch = sql.match(/CREATE OR REPLACE FUNCTION provision_owner_workspace\(([^)]*)\)/i);
    assert.ok(sigMatch);
    assert.equal(sigMatch![1].trim(), "p_auth_user_id uuid");
  });

  test("the provisioning function hardcodes role='owner', billing_mode='stripe', booking_enabled=false, and notifications_enabled=false as literals -- never parameters", () => {
    const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION provision_owner_workspace");
    const fnEnd = sql.indexOf("REVOKE ALL", fnStart);
    const fnBody = sql.slice(fnStart, fnEnd);
    assert.ok(fnBody.includes("'owner'"));
    assert.ok(fnBody.includes("'stripe'"));
    assert.ok(/booking_enabled\)\s*\n\s*VALUES\s*\([^)]*,\s*false/i.test(fnBody) || fnBody.includes("false, false"));
    assert.ok(fnBody.includes("v_new_workspace_id := gen_random_uuid()"), "workspace id must be generated inside the function, never accepted as input");
  });

  test("the provisioning function checks for an existing owner membership before inserting -- idempotent by construction, never creates a second workspace for the same identity", () => {
    const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION provision_owner_workspace");
    const idempotencyCheckIdx = sql.indexOf("v_existing_workspace_id IS NOT NULL", fnStart);
    const firstInsertIdx = sql.indexOf("INSERT INTO workspaces", fnStart);
    assert.ok(idempotencyCheckIdx > -1 && firstInsertIdx > -1 && idempotencyCheckIdx < firstInsertIdx);
  });

  test("the provisioning function does not set trial_consumed_at or any Stripe/trial column -- trial state remains exclusively the webhook's responsibility", () => {
    const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION provision_owner_workspace");
    const fnEnd = sql.indexOf("REVOKE ALL", fnStart);
    const fnBody = sql.slice(fnStart, fnEnd);
    assert.ok(!fnBody.includes("trial_consumed_at"));
    assert.ok(!fnBody.includes("stripe_status"));
    assert.ok(!fnBody.includes("stripe_customer_id"));
    assert.ok(!fnBody.includes("stripe_subscription_id"));
  });

  test("function execution is revoked from public, anon, and authenticated", () => {
    assert.ok(sql.includes("REVOKE ALL ON FUNCTION provision_owner_workspace(uuid) FROM PUBLIC"));
    assert.ok(sql.includes("REVOKE ALL ON FUNCTION provision_owner_workspace(uuid) FROM anon"));
    assert.ok(sql.includes("REVOKE ALL ON FUNCTION provision_owner_workspace(uuid) FROM authenticated"));
  });

  test("the function's actual declaration clause is not SECURITY DEFINER (the file's own explanatory comment legitimately names the term to say why it's absent)", () => {
    const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION provision_owner_workspace");
    const bodyStart = sql.indexOf("AS $$", fnStart);
    const declarationClause = sql.slice(fnStart, bodyStart);
    assert.ok(!declarationClause.toUpperCase().includes("SECURITY DEFINER"));
    assert.ok(declarationClause.includes("LANGUAGE plpgsql"));
  });

  test("the workspace_memberships uniqueness addition is guarded by an information_schema preflight, not assumed absent", () => {
    assert.ok(sql.includes("information_schema.table_constraints"));
    const doBlockIdx = sql.indexOf("DO $$");
    const addConstraintIdx = sql.indexOf("ADD CONSTRAINT uq_workspace_memberships_profile_role");
    assert.ok(doBlockIdx > -1 && addConstraintIdx > -1 && doBlockIdx < addConstraintIdx);
  });

  test("Phase 5.7D-R6: the array_agg/ARRAY[] comparison in the uniqueness guard casts both sides to text/text[] -- prevents the production-confirmed 'operator does not exist: information_schema.sql_identifier[] = text[]' failure (error 42883)", () => {
    // information_schema.key_column_usage.column_name is typed
    // sql_identifier, not text. array_agg() over an un-cast sql_identifier
    // column produces a sql_identifier[], which has no = operator against a
    // plain text[] literal like ARRAY['profile_id', 'role'] -- Postgres
    // array equality requires the exact same element type on both sides,
    // unlike scalar sql_identifier-to-text-literal comparisons (which work
    // via implicit assignment casts on the still-untyped literal). Both
    // array_agg(...)'s argument AND the literal ARRAY[...] on the right
    // must be explicitly cast to text/text[] for this HAVING clause to
    // type-check at all.
    const havingMatch = sql.match(/HAVING\s+array_agg\([^)]*\)\s*=\s*ARRAY\[[^\]]*\][^\n]*/i);
    assert.ok(havingMatch, "expected the HAVING array_agg(...) = ARRAY[...] clause to exist");
    const clause = havingMatch![0];

    // The array_agg() argument itself is explicitly cast to text.
    assert.match(clause, /array_agg\(\s*kcu\.column_name::text/i);
    // The ORDER BY inside array_agg is cast identically -- ordering must
    // compare the same type it aggregates, or this would be a separate
    // type mismatch of its own.
    assert.match(clause, /ORDER BY\s+kcu\.column_name::text/i);
    // The right-hand ARRAY[...] literal is explicitly cast to text[].
    assert.match(clause, /ARRAY\[\s*'profile_id'\s*,\s*'role'\s*\]::text\[\]/i);

    // Guard against literally reintroducing the exact broken form this
    // phase corrects: an UNCAST array_agg(kcu.column_name ...) immediately
    // followed by = ARRAY[...] with no ::text[] cast on the literal.
    assert.ok(
      !/array_agg\(\s*kcu\.column_name\s+ORDER BY\s+kcu\.column_name\s*\)\s*=\s*ARRAY\[[^\]]*\](?!::text\[\])/i.test(sql),
      "must not reintroduce the uncast sql_identifier[] = text[] comparison"
    );
  });
});

describe("migration 017 -- rate_limit_counters (Phase 5.7D-R4 durable rate limiting)", () => {
  test("the table is IF NOT EXISTS guarded, RLS-enabled, no policy", () => {
    assert.ok(sql.includes("CREATE TABLE IF NOT EXISTS rate_limit_counters"));
    assert.ok(sql.includes("ALTER TABLE rate_limit_counters ENABLE ROW LEVEL SECURITY"));
  });

  test("the table has no column that could hold a raw IP address -- only an opaque bucket_key, counters, and timestamps", () => {
    const tableStart = sql.indexOf("CREATE TABLE IF NOT EXISTS rate_limit_counters");
    const tableEnd = sql.indexOf(");", tableStart);
    const tableBody = sql.slice(tableStart, tableEnd).toLowerCase();
    for (const forbidden of ["ip_address", "ip text", "raw_ip", "client_ip"]) {
      assert.ok(!tableBody.includes(forbidden), `must not contain a raw-IP-shaped column: ${forbidden}`);
    }
    assert.ok(tableBody.includes("bucket_key"));
  });

  test("record_rate_limit_attempt takes window/max/lockout as caller-supplied parameters -- never hardcodes a limit itself, and is not SECURITY DEFINER", () => {
    const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION record_rate_limit_attempt");
    const declEnd = sql.indexOf("LANGUAGE plpgsql", fnStart);
    const declaration = sql.slice(fnStart, declEnd);
    assert.ok(declaration.includes("p_bucket_key text"));
    assert.ok(declaration.includes("p_window_seconds integer"));
    assert.ok(declaration.includes("p_max_attempts integer"));
    assert.ok(declaration.includes("p_lockout_seconds integer"));
    assert.ok(!declaration.toUpperCase().includes("SECURITY DEFINER"));
  });

  test("record_rate_limit_attempt locks the row (SELECT ... FOR UPDATE) before reading/incrementing it -- the atomicity guarantee under concurrency", () => {
    const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION record_rate_limit_attempt");
    const fnEnd = sql.indexOf("REVOKE ALL ON FUNCTION record_rate_limit_attempt", fnStart);
    const fnBody = sql.slice(fnStart, fnEnd);
    assert.ok(fnBody.includes("FOR UPDATE"));
  });

  test("both new functions have execution revoked from public, anon, and authenticated", () => {
    for (const fn of ["record_rate_limit_attempt(text, integer, integer, integer)", "clear_rate_limit(text)"]) {
      assert.ok(sql.includes(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`));
      assert.ok(sql.includes(`REVOKE ALL ON FUNCTION ${fn} FROM anon`));
      assert.ok(sql.includes(`REVOKE ALL ON FUNCTION ${fn} FROM authenticated`));
    }
  });
});

describe("migration 017 -- company_settings.notifications_enabled default correction (Phase 5.7D-R5)", () => {
  test("the only statement touching company_settings is a single ALTER COLUMN ... SET DEFAULT false -- no other clause on this table", () => {
    const matches = [...sql.matchAll(/ALTER TABLE\s+company_settings[\s\S]*?;/gi)];
    assert.equal(matches.length, 1);
    const stmt = matches[0][0];
    assert.match(stmt, /ALTER COLUMN\s+notifications_enabled\s+SET DEFAULT\s+false/i);
  });

  test("does not touch booking_enabled at all", () => {
    const matches = [...sql.matchAll(/ALTER TABLE\s+company_settings[\s\S]*?;/gi)];
    assert.ok(!/booking_enabled/i.test(matches[0][0]));
  });

  test("uses SET DEFAULT, never SET NOT NULL / DROP NOT NULL / TYPE -- a pure future-row default change, no constraint or type change on the column", () => {
    const matches = [...sql.matchAll(/ALTER TABLE\s+company_settings[\s\S]*?;/gi)];
    const stmt = matches[0][0].toUpperCase();
    assert.ok(!stmt.includes("SET NOT NULL"));
    assert.ok(!stmt.includes("DROP NOT NULL"));
    assert.ok(!stmt.includes("TYPE "));
  });
});

describe("migration 017 -- provision_owner_workspace supplies workspaces.name from the pending signup (Phase 5.7D-R5)", () => {
  const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION provision_owner_workspace");
  const fnEnd = sql.indexOf("REVOKE ALL", fnStart);
  const fnBody = sql.slice(fnStart, fnEnd);

  test("INSERT INTO workspaces supplies both id and name, and name comes from v_pending.company_name -- never a client parameter, never a literal placeholder", () => {
    assert.match(fnBody, /INSERT INTO workspaces\s*\(\s*id\s*,\s*name\s*\)\s*VALUES\s*\(\s*v_new_workspace_id\s*,\s*v_pending\.company_name\s*\)/i);
  });

  test("company_settings.company_name still receives the identical v_pending.company_name value", () => {
    assert.match(fnBody, /INSERT INTO company_settings[\s\S]*?VALUES\s*\(\s*v_new_workspace_id\s*,\s*v_pending\.company_name/i);
  });

  test("an empty or null pending company name raises an exception BEFORE any INSERT -- never silently produces a blank/placeholder workspace name", () => {
    const guardIdx = fnBody.search(/IF\s+v_pending\.company_name\s+IS\s+NULL\s+OR\s+btrim\(v_pending\.company_name\)\s*=\s*''/i);
    const raiseIdx = fnBody.indexOf("RAISE EXCEPTION", guardIdx);
    const firstInsertIdx = fnBody.indexOf("INSERT INTO workspaces");
    assert.ok(guardIdx > -1, "empty-company-name guard must exist");
    assert.ok(raiseIdx > guardIdx && raiseIdx < firstInsertIdx, "the guard must RAISE EXCEPTION strictly before the first INSERT");
  });

  test("workspaces.slug is never referenced by executable code -- left untouched, matching the approved scope (a comment explaining this omission is expected and doesn't count)", () => {
    const codeOnly = fnBody
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    assert.ok(!codeOnly.toLowerCase().includes("slug"));
  });

  test("the idempotency guard (return existing workspace if one already exists) still runs before any INSERT, unchanged by this correction", () => {
    const idempotencyCheckIdx = fnBody.indexOf("v_existing_workspace_id IS NOT NULL");
    const firstInsertIdx = fnBody.indexOf("INSERT INTO workspaces");
    assert.ok(idempotencyCheckIdx > -1 && firstInsertIdx > -1 && idempotencyCheckIdx < firstInsertIdx);
  });
});
