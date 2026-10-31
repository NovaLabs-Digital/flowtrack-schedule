// Source checks for migration 042 (Guided Demo Sessions). Behavior is
// proven against real PostgreSQL in test-db/demo_sessions.test.ts.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sql = fs.readFileSync(fileURLToPath(new URL("./042_add_demo_sessions.sql", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const code = sql.replace(/--.*$/gm, "");

describe("migration 042 -- Guided Demo Sessions", () => {
  test("runs in one transaction and only creates its own two tables", () => {
    assert.match(sql, /^BEGIN;$/m);
    assert.match(sql, /^COMMIT;$/m);
    const created = [...code.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    assert.deepEqual(created, ["demo_sessions", "demo_session_ops"]);
    assert.ok(!/\bALTER TABLE (?!demo_session)/.test(code), "no other table is altered");
  });

  test("never references real business tables", () => {
    for (const table of ["appointments", "appointment_employees", "clients", "employees", "services", "company_settings", "messages_sent", "workspaces", "subscriptions", "completed_job_billing"]) {
      assert.ok(!new RegExp(`\\b${table}\\b`).test(code), `must not reference ${table}`);
    }
  });

  test("row level security on, no policies, and no access for anon/authenticated", () => {
    assert.match(code, /ALTER TABLE demo_sessions ENABLE ROW LEVEL SECURITY;/);
    assert.match(code, /ALTER TABLE demo_session_ops ENABLE ROW LEVEL SECURITY;/);
    assert.ok(!/CREATE POLICY/i.test(code));
    assert.match(code, /REVOKE ALL ON TABLE demo_sessions, demo_session_ops FROM anon;/);
    assert.match(code, /REVOKE ALL ON TABLE demo_sessions, demo_session_ops FROM authenticated;/);
  });

  test("every function is SECURITY INVOKER-or-SQL with a fixed search_path, and every one is in the service_role-only grant list", () => {
    const defined = [...code.matchAll(/CREATE OR REPLACE FUNCTION (demo_session_\w+)\(/g)].map((m) => m[1]);
    const granted = [...code.matchAll(/'(demo_session_\w+)\(/g)].map((m) => m[1]);
    assert.deepEqual([...granted].sort(), [...defined].sort());
    assert.ok(!/SECURITY DEFINER/i.test(code));
    const fnBlocks = code.split("CREATE OR REPLACE FUNCTION").slice(1);
    for (const block of fnBlocks.filter((b) => /LANGUAGE plpgsql/.test(b))) {
      assert.match(block, /SET search_path = public/);
    }
  });

  test("the time limits are the approved ones: 2-hour session, 30-minute invitation, 7-day retention", () => {
    assert.match(code, /now\(\) \+ interval '2 hours'/);
    assert.match(code, /now\(\) \+ interval '30 minutes'/);
    assert.match(code, /ended_at < now\(\) - interval '7 days'/);
  });
});
