// Tests for the schema exporter's diagnostic (test-db/schema-export-diagnostic.sql)
// and the hardened exporter. Everything runs the COMPLETE query text on the
// disposable embedded PostgreSQL -- never a shared database.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { startTestDb, type TestDb } from "./harness.ts";
import { buildDiagnostic } from "./build-export-diagnostic.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(path.join(HERE, f), "utf8");
const V1 = read("schema-export.v1.sql");
const V4 = read("schema-export.sql");
const DIAG = read("schema-export-diagnostic.sql");

let db: TestDb;
let c: pg.Client;
before(async () => {
  db = await startTestDb();
  c = await db.connect();
  await c.query(read("supabase-shaped-fixture.sql"));
});
after(async () => { await c.end(); await db.stop(); });

async function exportWith(sql: string): Promise<string> {
  const { rows } = await c.query(sql);
  return rows[0].schema_script;
}
async function report(sql: string): Promise<string> {
  try { await c.query(sql); } catch (e) { return (e as Error).message; }
  throw new Error("the diagnostic must end in its intentional error");
}
const stripComments = (t: string) => t.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|COPY|CREATE|ALTER|GRANT|REVOKE)\b/;

// One tier line of the report: "A (original branches, each alone): OK=[A01 A02] FAILED=[A05]"
function tier(msg: string, letter: string) {
  const m = msg.match(new RegExp("^" + letter + " \\(.*\\): OK=\\[(.*)\\] FAILED=\\[(.*)\\]$", "m"));
  assert.ok(m, `tier line ${letter} present`);
  const codes = (t: string) => t.trim().split(/\s+/).filter(Boolean);
  return { ok: codes(m[1]), failed: codes(m[2]) };
}

describe("hardened exporter", () => {
  test("produces the same restore script as the original (plus only the added header lines) on a Supabase-shaped schema", async () => {
    const original = (await exportWith(V1)).split("\n");
    const hardened = (await exportWith(V4)).split("\n");
    const added = hardened.filter((l) => !original.includes(l));
    const removed = original.filter((l) => !hardened.includes(l));
    assert.deepEqual(removed, [], "nothing the original exported is lost");
    assert.equal(added.length, 2, `only the two new header lines: ${JSON.stringify(added.map((l) => l.slice(0, 40)))}`);
    assert.ok(added.some((l) => l.startsWith("-- NOT EXPORTED")) && added.includes("SET search_path = public;"));
  });

  test("uses no reg* cast and is one MATERIALIZED read-only SELECT", () => {
    const code = stripComments(V4).replace(/'[^']*'/g, "''");
    assert.ok(!/::\s*reg(class|namespace|proc|type|role)/i.test(code), "no reg* cast");
    assert.match(V4, /AS MATERIALIZED \(/);
    assert.ok(!WRITE_WORDS.test(code), "no write keyword outside string literals");
  });

  test("the header lists what is NOT exported, from real counts on this schema", async () => {
    const line = (await exportWith(V4)).split("\n").find((l) => l.startsWith("-- NOT EXPORTED"))!;
    assert.match(line, /domains=1/);
    assert.match(line, /materialized views=1/);
    assert.match(line, /partitioned tables \(skipped\)=1/);
    assert.match(line, /partitions \(exported as ordinary tables\)=1/);
    assert.match(line, /identity columns \(restored as plain columns\)=1/);
    assert.match(line, /procedures and aggregates=2/);
    assert.match(line, /columns with column-level grants=1/);
    assert.match(line, /sequences outside public=\d+/);
  });

  test("gives the same script under a non-superuser role, and the same script modulo schema qualifiers under an empty search_path", async () => {
    const base = await exportWith(V4);
    await c.query("CREATE ROLE pgadmin_t LOGIN NOSUPERUSER");
    await c.query("SET ROLE pgadmin_t");
    try { assert.equal(await exportWith(V4), base, "non-superuser"); } finally { await c.query("RESET ROLE"); }
    // With an empty search_path PostgreSQL schema-qualifies names inside defaults ("public.x" instead of "x");
    // the export sets `search_path = public` before restoring, so both spellings restore identically.
    const unqualified = (t: string) => t.replace(/public\./g, "");
    await c.query("SET search_path = ''");
    try { assert.equal(unqualified(await exportWith(V4)), unqualified(base), "empty search_path"); } finally { await c.query("RESET search_path"); }
  });
});

describe("diagnostic script", () => {
  test("the checked-in file is exactly what the builder generates from the two exporters (not stale)", () => {
    assert.equal(DIAG, buildDiagnostic());
  });

  test("statically read-only: no write keyword outside comments, string literals and the embedded exporter texts", () => {
    const outside = stripComments(DIAG.replace(/\$v1\$[\s\S]*?\$v1\$/, "").replace(/\$v4\$[\s\S]*?\$v4\$/, ""))
      .replace(/\$r\$[\s\S]*?\$r\$/g, "").replace(/'[^']*'/g, "''");
    assert.ok(!WRITE_WORDS.test(outside), outside.match(WRITE_WORDS)?.[0]);
    assert.match(DIAG, /SET LOCAL transaction_read_only = on;/);
  });

  test("on a healthy schema every step succeeds: 4 complete variants, each original branch, each union prefix, each hardened branch", async () => {
    const before = (await c.query("SELECT count(*)::int AS n FROM pg_class")).rows[0].n;
    const msg = await report(DIAG);
    assert.match(msg, /^EXPORTER DIAGNOSTIC REPORT/);
    assert.match(msg, /FAILED STEPS: \(none -- every step succeeded\)/);
    assert.match(msg, /read_only=on/);
    for (const code of ["C1", "C2", "C3", "C4"]) assert.match(msg, new RegExp(code + "\\s+OK"), code);
    const A = tier(msg, "A"), B = tier(msg, "B"), H = tier(msg, "H");
    assert.deepEqual([A.failed, B.failed, H.failed], [[], [], []]);
    assert.ok(A.ok.length >= 14 && H.ok.length >= 15 && B.ok.length === A.ok.length - 1, `A=${A.ok.length} B=${B.ok.length} H=${H.ok.length}`);
    assert.ok(A.ok.every((x) => x.startsWith("A")) && B.ok.every((x) => x.startsWith("B")) && H.ok.every((x) => x.startsWith("H")), "each tier lists only its own steps");
    assert.doesNotMatch(msg, /FAILED\s+sqlstate/);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM pg_class")).rows[0].n, before, "nothing was created");
  });

  test("FAULT INJECTION: 'public'::regclass in the original's sequence branch reproduces relation \"public\" does not exist, and the report names the exact branch", async () => {
    const faulty = V1.replace("WHERE s.schemaname = 'public'\n    AND NOT EXISTS", "WHERE 'public'::regclass IS NOT NULL AND s.schemaname = 'public'\n    AND NOT EXISTS");
    assert.notEqual(faulty, V1, "fault was injected");
    // the complete faulty exporter fails with exactly the reported error
    await assert.rejects(c.query(faulty), (e: pg.DatabaseError) => e.code === "42P01" && e.message === 'relation "public" does not exist');

    const msg = await report(buildDiagnostic({ v1: faulty }));
    assert.match(msg, /C1\s+FAILED\s+sqlstate=42P01 \| message=relation "public" does not exist/);
    assert.match(msg, /C2\s+FAILED/);
    assert.match(msg, /C3\s+FAILED/, "removing only the sequence-section cast does not help when the fault is elsewhere in that branch");
    assert.match(msg, /C4\s+OK/, "the hardened exporter is a separate text and is unaffected");

    // which branch is the sequences branch? read it from the report's own legend, not from a hard-coded index
    const legend = msg.match(/(A\d+)=sequences that are not identity sequences/);
    assert.ok(legend, "legend names the sequences branch");
    const code = legend[1];
    const num = code.slice(1);
    const A = tier(msg, "A"), B = tier(msg, "B"), H = tier(msg, "H");
    assert.deepEqual(A.failed, [code], "exactly that one branch fails alone");
    assert.match(msg, new RegExp("^" + code + "\\s+FAILED\\s+sqlstate=42P01", "m"), "its error detail is printed");
    assert.equal(B.failed[0], "B" + num, "the union first breaks when that branch joins");
    assert.ok(B.ok.every((x) => Number(x.slice(1)) < Number(num)), "every shorter prefix is fine");
    assert.deepEqual(H.failed, [], "no hardened branch fails");
    assert.match(msg, new RegExp("FAILED STEPS: C1 C2 C3 " + code + " B" + num));
  });
});
