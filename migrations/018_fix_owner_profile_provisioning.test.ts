// Phase 5.7D-R9: static, source-level proof that migration 018 correctly
// replaces provision_owner_workspace to insert the required `profiles` row
// before `workspace_memberships`, while preserving every other established
// behavior from migration 017. Migrations are never executed by this test
// suite (no database is reachable from tests anywhere in this repository)
// -- this file proves the SQL text itself, matching the same discipline
// already established for migration 017.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./018_fix_owner_profile_provisioning.sql", import.meta.url)), "utf8");
const upperSql = sql.toUpperCase();

const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION provision_owner_workspace");
const fnBodyStart = sql.indexOf("AS $$", fnStart);
const fnEnd = sql.indexOf("REVOKE ALL", fnStart);
const fnBody = sql.slice(fnStart, fnEnd);
const declarationClause = sql.slice(fnStart, fnBodyStart);

describe("migration 018 -- exists, transaction-wrapped, replaces the function safely", () => {
  test("the file exists and its executable content is wrapped in BEGIN;/COMMIT; (a leading header comment precedes BEGIN;, matching migration 017's own convention)", () => {
    const codeOnly = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();
    assert.match(codeOnly, /^BEGIN;/);
    assert.match(codeOnly, /COMMIT;\s*$/);
  });

  test("uses CREATE OR REPLACE FUNCTION (never DROP FUNCTION, never a differently-named function)", () => {
    assert.ok(fnStart > -1, "expected CREATE OR REPLACE FUNCTION provision_owner_workspace");
    assert.ok(!upperSql.includes("DROP FUNCTION"));
  });

  test("does not modify migration 017's file -- confirmed separately by this test suite not touching that file, and by migration 017's own test file still passing unchanged", () => {
    // This migration's own text never references editing another file; the
    // authoritative proof that 017 itself is untouched is that
    // migrations/017_add_signup_and_owner_mfa.test.ts (a separate file,
    // run in the same suite) still passes against 017's own unmodified
    // content -- see that file's own R6-era assertions.
    assert.ok(!sql.includes("017_add_signup_and_owner_mfa"));
  });
});

describe("migration 018 -- function signature and parameter safety (unchanged from 017)", () => {
  test("the function's only parameter remains the server-verified Auth user id -- one uuid parameter, nothing else", () => {
    const sigMatch = sql.match(/CREATE OR REPLACE FUNCTION provision_owner_workspace\(([^)]*)\)/i);
    assert.ok(sigMatch);
    assert.equal(sigMatch![1].trim(), "p_auth_user_id uuid");
  });

  test("no parameter or literal in this file could supply a workspace id, role, billing mode, toggle, entitlement, or trial value from a caller", () => {
    assert.ok(fnBody.includes("'owner'"));
    assert.ok(fnBody.includes("'stripe'"));
    assert.ok(fnBody.includes("v_new_workspace_id := gen_random_uuid()"), "workspace id must be generated inside the function, never accepted as input");
    assert.ok(!fnBody.includes("trial_consumed_at"));
    assert.ok(!fnBody.includes("stripe_status"));
    assert.ok(!fnBody.includes("stripe_customer_id"));
    assert.ok(!fnBody.includes("stripe_subscription_id"));
  });
});

describe("migration 018 -- the profiles fix itself", () => {
  test("INSERT INTO profiles (id, email) exists, sourced from p_auth_user_id and v_pending.email", () => {
    assert.match(fnBody, /INSERT INTO profiles\s*\(\s*id\s*,\s*email\s*\)\s*\n\s*VALUES\s*\(\s*p_auth_user_id\s*,\s*v_pending\.email\s*\)/i);
  });

  test("the profiles insert uses ON CONFLICT (id) DO NOTHING -- never overwrites an existing profiles row", () => {
    assert.match(fnBody, /INSERT INTO profiles[\s\S]{0,120}ON CONFLICT\s*\(\s*id\s*\)\s*DO NOTHING/i);
  });

  test("the profiles insert appears strictly before the workspace_memberships insert", () => {
    const profilesIdx = fnBody.indexOf("INSERT INTO profiles");
    const membershipIdx = fnBody.indexOf("INSERT INTO workspace_memberships");
    assert.ok(profilesIdx > -1 && membershipIdx > -1 && profilesIdx < membershipIdx);
  });

  test("no destructive UPDATE or DELETE ever targets profiles anywhere in this file", () => {
    assert.ok(!/UPDATE\s+profiles/i.test(sql));
    assert.ok(!/DELETE\s+FROM\s+profiles/i.test(sql));
  });
});

describe("migration 018 -- every other established provisioning behavior is preserved", () => {
  test("idempotency guard: an existing owner membership short-circuits before any INSERT, unchanged from 017", () => {
    const idempotencyCheckIdx = fnBody.indexOf("v_existing_workspace_id IS NOT NULL");
    const firstInsertIdx = fnBody.indexOf("INSERT INTO workspaces");
    assert.ok(idempotencyCheckIdx > -1 && firstInsertIdx > -1 && idempotencyCheckIdx < firstInsertIdx);
  });

  test("missing pending_signups row still raises before any insert", () => {
    const guardIdx = fnBody.indexOf("RAISE EXCEPTION 'provision_owner_workspace: no pending_signups row");
    const firstInsertIdx = fnBody.indexOf("INSERT INTO workspaces");
    assert.ok(guardIdx > -1 && firstInsertIdx > -1 && guardIdx < firstInsertIdx);
  });

  test("empty/blank company_name still raises before any insert", () => {
    const guardIdx = fnBody.search(/IF\s+v_pending\.company_name\s+IS\s+NULL\s+OR\s+btrim\(v_pending\.company_name\)\s*=\s*''/i);
    const firstInsertIdx = fnBody.indexOf("INSERT INTO workspaces");
    assert.ok(guardIdx > -1 && firstInsertIdx > -1 && guardIdx < firstInsertIdx);
  });

  test("workspaces gets id and name from v_pending.company_name", () => {
    assert.match(fnBody, /INSERT INTO workspaces\s*\(\s*id\s*,\s*name\s*\)\s*VALUES\s*\(\s*v_new_workspace_id\s*,\s*v_pending\.company_name\s*\)/i);
  });

  test("workspace_memberships gets role='owner', terms evidence, and session_epoch=1", () => {
    assert.match(
      fnBody,
      /INSERT INTO workspace_memberships \(profile_id, workspace_id, role, terms_accepted_at, terms_version, session_epoch\)\s*\n\s*VALUES\s*\(\s*p_auth_user_id,\s*v_new_workspace_id,\s*'owner',\s*v_pending\.terms_accepted_at,\s*v_pending\.terms_version,\s*1\s*\)/i
    );
  });

  test("company_settings gets booking_enabled=false and notifications_enabled=false", () => {
    assert.match(
      fnBody,
      /INSERT INTO company_settings \(workspace_id, company_name, booking_enabled, notifications_enabled\)\s*\n\s*VALUES\s*\(\s*v_new_workspace_id,\s*v_pending\.company_name,\s*false,\s*false\s*\)/i
    );
  });

  test("subscriptions gets billing_mode='stripe' only -- no trial column set locally", () => {
    assert.match(fnBody, /INSERT INTO subscriptions \(workspace_id, billing_mode\)\s*\n\s*VALUES\s*\(\s*v_new_workspace_id,\s*'stripe'\s*\)/i);
  });

  test("pending_signups.consumed_at is set at the end, scoped by auth_user_id", () => {
    assert.match(fnBody, /UPDATE pending_signups SET consumed_at = now\(\) WHERE auth_user_id = p_auth_user_id/i);
  });

  test("workspaces.slug is never referenced by executable code", () => {
    const codeOnly = fnBody
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    assert.ok(!codeOnly.toLowerCase().includes("slug"));
  });
});

describe("migration 018 -- function privilege restrictions preserved", () => {
  test("the function is not SECURITY DEFINER", () => {
    assert.ok(!declarationClause.toUpperCase().includes("SECURITY DEFINER"));
    assert.ok(declarationClause.includes("LANGUAGE plpgsql"));
  });

  test("execution is revoked from PUBLIC, anon, and authenticated", () => {
    assert.ok(sql.includes("REVOKE ALL ON FUNCTION provision_owner_workspace(uuid) FROM PUBLIC"));
    assert.ok(sql.includes("REVOKE ALL ON FUNCTION provision_owner_workspace(uuid) FROM anon"));
    assert.ok(sql.includes("REVOKE ALL ON FUNCTION provision_owner_workspace(uuid) FROM authenticated"));
  });
});

describe("migration 018 -- migration 017's executable SQL remains unchanged", () => {
  const sql017 = fs.readFileSync(fileURLToPath(new URL("./017_add_signup_and_owner_mfa.sql", import.meta.url)), "utf8");

  test("017 still contains its own (pre-018) provision_owner_workspace definition, without a profiles insert -- proving 018 is a separate, additive replacement, not an edit to 017's history", () => {
    const fn017Start = sql017.indexOf("CREATE OR REPLACE FUNCTION provision_owner_workspace");
    const fn017End = sql017.indexOf("REVOKE ALL", fn017Start);
    const fn017Body = sql017.slice(fn017Start, fn017End);
    assert.ok(fn017Start > -1);
    assert.ok(!fn017Body.includes("INSERT INTO profiles"), "017's own text must remain exactly as originally applied to production -- the profiles fix belongs only to 018");
  });

  test("017 still contains the Phase 5.7D-R6 explicit text[] cast correction, untouched by this phase", () => {
    assert.ok(sql017.includes("array_agg(kcu.column_name::text ORDER BY kcu.column_name::text) = ARRAY['profile_id', 'role']::text[]"));
  });

  test("017 still contains the Phase 5.7D-R5 workspaces.name / notifications_enabled corrections, untouched by this phase", () => {
    assert.ok(sql017.includes("INSERT INTO workspaces (id, name) VALUES (v_new_workspace_id, v_pending.company_name)"));
    assert.ok(sql017.includes("ALTER COLUMN notifications_enabled SET DEFAULT false"));
  });
});
