// Schema export/restore pipeline + schema audit for migrations 029/030.
//
//  1. ALWAYS runs: proves the export procedure (test-db/schema-export.sql) and
//     the restore path work, using the local disposable database (in its
//     pre-029 state) as a stand-in for production. This validates the TOOLING;
//     it says nothing about the real production schema.
//  2. Runs ONLY when test-db/production-schema.sql exists (Alberto's read-only
//     export): restores it, applies 029/030, and audits the real constraints,
//     triggers, functions, grants, RLS and cleanup dependencies.
//
// Run with `npm run test:db:schema`. Nothing here connects anywhere but the
// embedded disposable instances.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { startTestDb, MIGRATIONS, NEW_MIGRATIONS, PRODUCTION_SCHEMA_FILE, type TestDb } from "./harness.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_SQL = readFileSync(path.join(HERE, "schema-export.sql"), "utf8");
const MIGRATIONS_DIR = path.join(HERE, "..", "migrations");

async function runExport(c: pg.Client): Promise<string> {
  // The export is one SELECT; run it in a READ ONLY transaction anyway, exactly
  // as a cautious operator would, so any accidental write would error.
  await c.query("BEGIN READ ONLY");
  try {
    const { rows } = await c.query(EXPORT_SQL);
    assert.equal(rows.length, 1);
    assert.ok(typeof rows[0].schema_script === "string" && rows[0].schema_script.length > 500);
    return rows[0].schema_script;
  } finally {
    await c.query("ROLLBACK");
  }
}

async function applyMigrations(c: pg.Client, files: string[]) {
  for (const f of files) await c.query(readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
}

// Everything structural that matters to 029/030, in a comparable, sorted form.
async function fingerprint(c: pg.Client) {
  const q = async (sql: string) => (await c.query(sql)).rows.map((r) => Object.values(r).join(" | "));
  const fnSql = `p.prokind = 'f' AND n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`;
  return {
    columns: await q(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
                      WHERE table_schema='public' ORDER BY 1,2`),
    constraints: await q(`SELECT c.relname, k.conname, pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
                          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY 1,2`),
    indexes: await q(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1`),
    functions: await q(`SELECT p.proname, pg_get_function_identity_arguments(p.oid), md5(pg_get_functiondef(p.oid)), p.prosecdef
                        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE ${fnSql} ORDER BY 1,2`),
    triggers: await q(`SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                       JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY 1,2`),
    rls: await q(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1`),
    policies: await q(`SELECT tablename, policyname, cmd, roles, qual, with_check FROM pg_policies WHERE schemaname='public' ORDER BY 1,2`),
    tableGrants: await q(`SELECT c.relname, COALESCE(r.rolname,'PUBLIC'), x.privilege_type FROM pg_class c
                          JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) x
                          LEFT JOIN pg_roles r ON r.oid=x.grantee
                          WHERE n.nspname='public' AND c.relkind='r' AND (x.grantee=0 OR r.rolname IN ('anon','authenticated','service_role'))
                          ORDER BY 1,2,3`),
    functionGrants: await q(`SELECT p.proname, pg_get_function_identity_arguments(p.oid), COALESCE(r.rolname,'PUBLIC'), x.privilege_type
                             FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) x
                             LEFT JOIN pg_roles r ON r.oid=x.grantee
                             WHERE ${fnSql} AND (x.grantee=0 OR r.rolname IN ('anon','authenticated','service_role')) ORDER BY 1,2,3,4`),
  };
}

// The facts migrations 029/030 and the recurrence functions depend on, checked
// against whatever schema `c` holds (after 029/030). Hard assertions for what
// the new code REQUIRES; the inventory it returns is for human review.
async function auditSchema(c: pg.Client) {
  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;

  // -- columns the new SQL reads or writes
  const required: Record<string, Record<string, string>> = {
    appointments: {
      id: "uuid", workspace_id: "uuid", client_id: "uuid", service_type: "text", scheduled_for: "timestamp with time zone",
      scheduled_end: "timestamp with time zone", notes: "text", status: "text", cancel_token: "text", is_demo: "boolean",
      duration_minutes: "integer", series_id: "uuid", frequency_type: "text", repeat_weeks: "integer", repeat_months: "integer",
      employee_id: "uuid", price_cents: "integer", team_color: "text",
    },
    appointment_employees: {
      id: "uuid", appointment_id: "uuid", employee_id: "uuid", workspace_id: "uuid", actual_started_at: "timestamp with time zone",
      actual_completed_at: "timestamp with time zone", job_notes: "text", updated_at: "timestamp with time zone",
    },
    appointment_employee_hours: {
      id: "uuid", appointment_id: "uuid", employee_id: "uuid", workspace_id: "uuid", hours_worked: "numeric", note: "text",
    },
    recurring_series: {
      id: "uuid", workspace_id: "uuid", status: "text", client_id: "uuid", template_appointment_id: "uuid",
      frequency_type: "text", anchor_local_date: "date", anchor_local_time: "time without time zone", anchor_timezone: "text",
      excluded_occurrences: "ARRAY", superseded_series_id: "uuid",
    },
    recurrence_change_operations: { id: "uuid", workspace_id: "uuid", appointment_id: "uuid", request_fingerprint: "text", result: "jsonb" },
    clients: { id: "uuid", workspace_id: "uuid" },
    employees: { id: "uuid", workspace_id: "uuid", active: "boolean" },
    company_settings: { workspace_id: "uuid", timezone: "text" },
  };
  for (const [table, cols] of Object.entries(required)) {
    const have = await one(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table]);
    const map = new Map(have.map((r) => [r.column_name, r.data_type]));
    for (const [col, type] of Object.entries(cols)) {
      assert.equal(map.get(col), type, `${table}.${col} should exist with type ${type} (found ${map.get(col) ?? "MISSING"})`);
    }
  }

  // -- the duplicate-slot guard the replacement relies on (ON CONFLICT (series_id, scheduled_for))
  const slot = await one(`SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='appointments'
                          AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%series_id%' AND indexdef ILIKE '%scheduled_for%'`);
  assert.ok(slot.length >= 1, "unique (series_id, scheduled_for) index missing on appointments");

  // -- RLS and grants on the new table
  const rls = await one(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.recurrence_change_operations'::regclass`);
  assert.equal(rls[0].relrowsecurity, true, "RLS must be enabled on recurrence_change_operations");
  const grants = await one(`SELECT COALESCE(r.rolname,'PUBLIC') AS role, x.privilege_type FROM pg_class c
                            CROSS JOIN LATERAL aclexplode(c.relacl) x LEFT JOIN pg_roles r ON r.oid = x.grantee
                            WHERE c.oid = 'public.recurrence_change_operations'::regclass
                              AND (x.grantee = 0 OR r.rolname IN ('anon','authenticated','service_role'))`);
  assert.deepEqual(grants.map((g) => `${g.role}:${g.privilege_type}`).sort(), ["service_role:INSERT", "service_role:SELECT"]);

  // -- new / replaced functions: executable by service_role only
  for (const fn of ["apply_recurrence_change", "record_job_action", "save_employee_hours", "replenish_recurring_series"]) {
    const r = await one(`SELECT p.oid, p.prosecdef, has_function_privilege('service_role', p.oid, 'EXECUTE') AS srv,
                                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
                         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=$1`, [fn]);
    assert.equal(r.length, 1, `${fn}: exactly one overload expected`);
    assert.deepEqual([r[0].srv, r[0].anon, r[0].auth, r[0].prosecdef], [true, false, false, false], `${fn}: service_role only, SECURITY INVOKER`);
  }

  // -- foreign keys that decide what a hard delete / cleanup can do
  const fks = await one(`SELECT c.relname AS "table", k.conname, k.confdeltype AS rule, rc.relname AS references
                         FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_class rc ON rc.oid=k.confrelid
                         JOIN pg_namespace n ON n.oid=c.relnamespace
                         WHERE k.contype='f' AND n.nspname='public' AND rc.relname IN ('appointments','recurring_series','clients','workspaces','employees')
                         ORDER BY 1,2`);
  const rule = (t: string, refs: string, col: string) =>
    fks.find((f) => f.table === t && f.references === refs && f.conname.includes(col));
  assert.equal(rule("recurrence_change_operations", "appointments", "appointment")?.rule, "c", "operations.appointment_id must CASCADE");
  assert.equal(rule("recurring_series", "recurring_series", "superseded")?.rule, "n", "superseded_series_id must SET NULL");

  // -- inventory for review: every non-internal trigger on tables the operation touches
  const triggers = await one(`SELECT c.relname AS "table", t.tgname AS trigger, pg_get_triggerdef(t.oid) AS def
                              FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
                              WHERE n.nspname='public' AND NOT t.tgisinternal
                                AND c.relname IN ('appointments','appointment_employees','appointment_employee_hours','recurring_series','clients','employees','recurrence_change_operations')
                              ORDER BY 1,2`);
  const delRule: Record<string, string> = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };
  return {
    triggers: triggers.map((t) => `${t.table}: ${t.trigger}`),
    foreignKeys: fks.map((f) => `${f.table}.${f.conname} -> ${f.references} ON DELETE ${delRule[f.rule]}`),
  };
}

describe("schema export + restore pipeline (stand-in schema, validates the TOOLING only)", () => {
  test("export is read-only and data-free, restores into a fresh database, and the restored schema equals the source after 029/030", async (t) => {
    // A "production stand-in": pre-029 state, plus a row that must NEVER appear in the export.
    let source: TestDb | undefined, restored: TestDb | undefined;
    let s: pg.Client | undefined, r: pg.Client | undefined;
    try {
      source = await startTestDb({ migrations: MIGRATIONS.slice(0, -2), schemaSql: undefined });
      s = await source.connect();
      await s.query("INSERT INTO workspaces (name) VALUES ('SECRET-BUSINESS-ROW-MARKER')");
      const exported = await runExport(s);

      assert.ok(!exported.includes("SECRET-BUSINESS-ROW-MARKER"), "business rows must not be exported");
      assert.ok(!/^COPY /m.test(exported), "export contains no COPY data blocks");
      assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|COPY)\b/i.test(EXPORT_SQL.replace(/--.*$/gm, "").replace(/'[^']*'/g, "''")),
        "the export script itself contains no write keywords");
      assert.match(exported, /CREATE TABLE public\.appointments/);
      assert.match(exported, /CREATE OR REPLACE FUNCTION public\.replenish_recurring_series/);
      t.diagnostic(`exported ${exported.split("\n").length} lines, ${Math.round(exported.length / 1024)} KB`);

      restored = await startTestDb({ schemaSql: exported }); // stubs + exported schema + 029/030
      r = await restored.connect();
      await applyMigrations(s, NEW_MIGRATIONS); // bring the source to the same point

      const a = await fingerprint(s);
      const b = await fingerprint(r);
      for (const k of Object.keys(a) as (keyof typeof a)[]) assert.deepEqual(b[k], a[k], `restored schema differs from source: ${k}`);

      const audit = await auditSchema(r);
      t.diagnostic(`audit ok on restored stand-in; triggers: ${audit.triggers.length}, foreign keys inspected: ${audit.foreignKeys.length}`);
    } finally {
      await s?.end().catch(() => {});
      await r?.end().catch(() => {});
      await source?.stop();
      await restored?.stop();
    }
  });
});

describe("REAL production schema audit (needs test-db/production-schema.sql from Alberto)", () => {
  const present = existsSync(PRODUCTION_SCHEMA_FILE);
  test("restores the exported production schema, applies 029/030, and audits it", { skip: present ? false : "test-db/production-schema.sql not present -- see test-db/SCHEMA_VALIDATION.md" }, async (t) => {
    const schemaSql = readFileSync(PRODUCTION_SCHEMA_FILE, "utf8");
    const db = await startTestDb({ schemaSql });
    try {
      const c = await db.connect();
      const audit = await auditSchema(c);
      t.diagnostic("TRIGGERS on touched tables (review each): " + (audit.triggers.join("; ") || "none"));
      t.diagnostic("FOREIGN KEYS to appointments/series/clients/workspaces/employees:\n  " + audit.foreignKeys.join("\n  "));
      await c.end();
    } finally {
      await db.stop();
    }
  });
});
