// Migration 043 (host always enabled, guest editing as a permission): its
// source, and its behaviour against real PostgreSQL applied on top of 042 the
// way production gets it -- including a session already live when 043 arrives.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { startTestDb, MIGRATIONS, backendPid, waitUntilBlocked, track, type TestDb } from "./harness.ts";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION_043 = readFileSync(path.join(MIGRATIONS_DIR, "043_guest_control_permissions.sql"), "utf8");
const sql = MIGRATION_043.replace(/\r\n/g, "\n");
const code = sql.replace(/--.*$/gm, "");

let db: TestDb;
let c: pg.Client;

before(async () => {
  db = await startTestDb({ migrations: [...MIGRATIONS, "042_add_demo_sessions.sql"] });
  c = await db.connect();
});
after(async () => {
  await c?.end();
  await db?.stop();
});

type Json = {
  outcome: string;
  session: { id: string; control_gen: number; [k: string]: unknown };
  visitor_epoch: number;
  result_version: number;
  response_status: number;
  response: unknown;
  [k: string]: unknown;
};
const rpc = async (client: pg.Client, fn: string, args: unknown[]): Promise<Json> => {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  return (await client.query(`SELECT ${fn}(${placeholders}) AS r`, args)).rows[0].r;
};
const HASH = () => randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
const fixture = (n = 1): Record<string, unknown> => ({ marker: n, appointments: [{ id: "a1" }], clients: [] });

async function withVisitor() {
  const host = randomUUID();
  const invite = HASH();
  const created = await rpc(c, "demo_session_create", [host, fixture(), invite]);
  const visitor = randomUUID();
  const claim = await rpc(c, "demo_session_claim", [invite, visitor, "Dana"]);
  assert.equal(claim.outcome, "ok");
  return { host, id: created.session.id as string, visitor, epoch: claim.visitor_epoch as number };
}
type S = Awaited<ReturnType<typeof withVisitor>>;
const allow = (s: S) => rpc(c, "demo_session_set_controller", [s.id, s.host, "visitor"]);
const stop = (s: S) => rpc(c, "demo_session_set_controller", [s.id, s.host, "host"]);
const hostApply = (client: pg.Client, s: S, gen: number, base: number, op = randomUUID(), state: Record<string, unknown> = fixture(9)) =>
  rpc(client, "demo_session_apply", [s.id, "host", s.host, null, null, gen, base, op, state, 200, { by: "host", op }]);
const guestApply = (client: pg.Client, s: S, gen: number, base: number, op = randomUUID(), state: Record<string, unknown> = fixture(9)) =>
  rpc(client, "demo_session_apply", [s.id, "visitor", null, s.visitor, s.epoch, gen, base, op, state, 200, { by: "guest", op }]);
const version = async (id: string) => Number((await c.query("SELECT state_version FROM demo_sessions WHERE id = $1", [id])).rows[0].state_version);

describe("transition from 042", () => {
  test("a session live under 042 keeps working when 043 is applied, and only the editing rule changes", async () => {
    const s = await withVisitor();
    const gen = (await allow(s)).session.control_gen;
    // Under 042, the host is locked out while the guest has control.
    assert.equal((await hostApply(c, s, gen, 1)).outcome, "not_controller");

    await c.query(MIGRATION_043);

    const r = (await c.query("SELECT status, controller, control_gen, state_version, state FROM demo_sessions WHERE id = $1", [s.id])).rows[0];
    assert.deepEqual([r.status, r.controller, Number(r.control_gen), Number(r.state_version)], ["live", "visitor", gen, 1], "session untouched");
    assert.deepEqual(r.state, fixture());
    // Under 043 the host can edit alongside the guest; the guest still can too.
    assert.equal((await hostApply(c, s, 1, 1)).outcome, "ok");
    assert.equal((await guestApply(c, s, gen, 2)).outcome, "ok");
    assert.equal(await version(s.id), 3);
  });

  test("043 replaced demo_session_apply in place (same signature, no overload) and added demo_session_find_op", async () => {
    const fns = (await c.query(
      "SELECT proname, pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND proname IN ('demo_session_apply', 'demo_session_find_op') ORDER BY 1"
    )).rows;
    assert.deepEqual(fns.map((f) => f.proname), ["demo_session_apply", "demo_session_find_op"]);
  });

  test("043 can be applied again without error (CREATE OR REPLACE)", async () => {
    await c.query(MIGRATION_043);
  });
});

describe("host always enabled, guest as a permission", () => {
  test("the host edits whether guest control is allowed or not, with any control_gen", async () => {
    const s = await withVisitor();
    assert.equal((await hostApply(c, s, 99, 1)).outcome, "ok", "guest watching");
    await allow(s);
    assert.equal((await hostApply(c, s, 1, 2)).outcome, "ok", "guest allowed");
    await stop(s);
    assert.equal((await hostApply(c, s, 1, 3)).outcome, "ok", "guest stopped again");
  });

  test("a watching guest is refused; an allowed guest edits; after Stop the guest is refused again", async () => {
    const s = await withVisitor();
    assert.equal((await guestApply(c, s, 1, 1)).outcome, "not_controller");
    const gen = (await allow(s)).session.control_gen;
    assert.equal((await guestApply(c, s, gen, 1)).outcome, "ok");
    await stop(s);
    assert.equal((await guestApply(c, s, gen, 2)).outcome, "not_controller");
    assert.equal(await version(s.id), 2, "nothing refused was written");
  });

  test("a guest save made under an earlier permission stays invalid even after guest control is allowed again", async () => {
    const s = await withVisitor();
    const first = (await allow(s)).session.control_gen;
    await stop(s);
    const second = (await allow(s)).session.control_gen;
    assert.ok(second > first);
    assert.equal((await guestApply(c, s, first, 1)).outcome, "stale_control");
    assert.equal((await guestApply(c, s, second, 1)).outcome, "ok");
  });

  test("Stop Guest Control does NOT invalidate the host's own in-flight save", async () => {
    const s = await withVisitor();
    const gen = (await allow(s)).session.control_gen;
    await stop(s);
    // A host save prepared before Stop still applies.
    assert.equal((await hostApply(c, s, gen, 1)).outcome, "ok");
  });

  test("Stop waits for an in-flight guest save holding the row: a save that committed first stands; a delayed one after Stop is refused", async () => {
    const s = await withVisitor();
    const gen = (await allow(s)).session.control_gen;
    const guestConn = await db.connect();
    const hostConn = await db.connect();
    try {
      await guestConn.query("BEGIN");
      assert.equal((await guestApply(guestConn, s, gen, 1)).outcome, "ok");
      const pid = await backendPid(hostConn);
      const stopping = track(rpc(hostConn, "demo_session_set_controller", [s.id, s.host, "host"]));
      await waitUntilBlocked(c, pid);
      assert.equal(stopping.settled(), false, "Stop waits on the row lock");
      await guestConn.query("COMMIT");
      assert.equal((await stopping.result).session.control_gen, gen + 1);
      assert.equal(await version(s.id), 2, "the committed guest save stands");
      // The guest's next request -- prepared under the old permission -- arrives late.
      assert.equal((await guestApply(c, s, gen, 2)).outcome, "not_controller");
      assert.equal(await version(s.id), 2);
    } finally {
      await guestConn.end();
      await hostConn.end();
    }
  });

  test("host and guest saving from the same version at the same moment: exactly one applies, nothing is overwritten", async () => {
    const s = await withVisitor();
    const gen = (await allow(s)).session.control_gen;
    const a = await db.connect();
    const b = await db.connect();
    try {
      const [rh, rg] = await Promise.all([
        hostApply(a, s, gen, 1, randomUUID(), fixture(10)),
        guestApply(b, s, gen, 1, randomUUID(), fixture(11)),
      ]);
      assert.deepEqual([rh.outcome, rg.outcome].sort(), ["ok", "stale_version"]);
      const stored = (await c.query("SELECT state FROM demo_sessions WHERE id = $1", [s.id])).rows[0].state;
      assert.equal(stored.marker, rh.outcome === "ok" ? 10 : 11, "the stored dataset is the winner's, intact");
    } finally {
      await a.end();
      await b.end();
    }
  });
});

describe("idempotency, lifecycle, privileges", () => {
  test("a retried op_id returns its original result (apply and find_op), even after the guest was stopped", async () => {
    const s = await withVisitor();
    const gen = (await allow(s)).session.control_gen;
    const op = randomUUID();
    assert.equal((await guestApply(c, s, gen, 1, op)).outcome, "ok");
    await stop(s);
    const retry = await guestApply(c, s, gen, 1, op);
    assert.deepEqual([retry.outcome, retry.result_version, retry.response], ["duplicate", 2, { by: "guest", op }]);
    const found = await rpc(c, "demo_session_find_op", [s.id, "visitor", null, s.visitor, s.epoch, op]);
    assert.deepEqual([found.outcome, found.response_status, found.response], ["duplicate", 200, { by: "guest", op }]);
    assert.equal((await rpc(c, "demo_session_find_op", [s.id, "visitor", null, s.visitor, s.epoch, randomUUID()])).outcome, "none");
  });

  test("find_op checks identity and lifecycle like every other session function", async () => {
    const s = await withVisitor();
    assert.equal((await rpc(c, "demo_session_find_op", [s.id, "visitor", null, randomUUID(), s.epoch, randomUUID()])).outcome, "unauthorized");
    assert.equal((await rpc(c, "demo_session_find_op", [s.id, "host", randomUUID(), null, null, randomUUID()])).outcome, "unauthorized");
    assert.equal((await rpc(c, "demo_session_find_op", [s.id, "host", s.host, null, null, null])).outcome, "invalid_input");
    await rpc(c, "demo_session_end", [s.id, s.host]);
    assert.equal((await rpc(c, "demo_session_find_op", [s.id, "host", s.host, null, null, randomUUID()])).outcome, "ended");
  });

  test("an allowed guest who stops checking in for 20 seconds loses the permission (unchanged from 042); the host keeps editing", async () => {
    const s = await withVisitor();
    const gen = (await allow(s)).session.control_gen;
    await c.query("UPDATE demo_sessions SET visitor_last_seen_at = now() - interval '21 seconds' WHERE id = $1", [s.id]);
    assert.equal((await guestApply(c, s, gen, 1)).outcome, "not_controller");
    assert.equal((await hostApply(c, s, gen, 1)).outcome, "ok");
  });

  test("an ended or expired session refuses everyone, the host included", async () => {
    const s = await withVisitor();
    await c.query("UPDATE demo_sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [s.id]);
    assert.equal((await hostApply(c, s, 1, 1)).outcome, "ended");
  });

  test("only service_role can call the replaced and the new function", async () => {
    const s = await withVisitor();
    for (const role of ["anon", "authenticated"]) {
      const client = await db.connect();
      try {
        await client.query(`SET ROLE ${role}`);
        await assert.rejects(client.query("SELECT demo_session_find_op($1, 'host', $2, NULL, NULL, $3)", [s.id, s.host, randomUUID()]), /permission denied/);
        await assert.rejects(hostApply(client, s, 1, 1), /permission denied/);
      } finally {
        await client.end();
      }
    }
    const svc = await db.connect();
    try {
      await svc.query("SET ROLE service_role");
      assert.equal((await rpc(svc, "demo_session_find_op", [s.id, "host", s.host, null, null, randomUUID()])).outcome, "none");
      assert.equal((await hostApply(svc, s, 1, 1)).outcome, "ok");
    } finally {
      await svc.end();
    }
  });
});

describe("migration 043 source", () => {
  test("runs in one transaction and only replaces/adds session functions: no table, column, or data change", () => {
    assert.match(sql, /^BEGIN;$/m);
    assert.match(sql, /^COMMIT;$/m);
    assert.ok(!/\b(CREATE|ALTER|DROP)\s+TABLE\b/i.test(code));
    assert.ok(!/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?!demo_session)/i.test(code), "writes only inside the session functions' own tables");
    assert.ok(!/\bDROP\s+FUNCTION\b/i.test(code));
    const fns = [...code.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(/g)].map((m) => m[1]);
    assert.deepEqual(fns, ["demo_session_apply", "demo_session_find_op"]);
  });

  test("demo_session_apply keeps 042's exact signature (replaced in place, no overload)", () => {
    const params = code.match(/CREATE OR REPLACE FUNCTION demo_session_apply\(([\s\S]*?)\)\s*RETURNS JSONB/)![1]
      .split(",").map((p) => p.trim().split(/\s+/)[1].toLowerCase());
    assert.deepEqual(params, ["uuid", "text", "uuid", "uuid", "integer", "bigint", "bigint", "uuid", "jsonb", "integer", "jsonb"]);
  });

  test("the permission rule: guest checks apply only to the visitor role; the host is never refused for control", () => {
    const body = code.match(/CREATE OR REPLACE FUNCTION demo_session_apply[\s\S]*?\$fn\$;/)![0];
    assert.match(body, /IF p_role = 'visitor' THEN\s+IF v\.controller <> 'visitor' THEN[\s\S]*?'not_controller'[\s\S]*?IF p_gen <> v\.control_gen THEN[\s\S]*?'stale_control'[\s\S]*?END IF;\s+END IF;/);
    assert.equal((body.match(/not_controller/g) ?? []).length, 1);
    // Order of checks: identity, lifecycle, retry, permission, version.
    const order = ["'unauthorized'", "'ended'", "'duplicate'", "'not_controller'", "'stale_version'"].map((s) => body.indexOf(s));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });

  test("SECURITY INVOKER, fixed search_path, service_role-only grants for both functions", () => {
    assert.ok(!/SECURITY DEFINER/i.test(code));
    assert.equal((code.match(/SECURITY INVOKER\s+SET search_path = public/g) ?? []).length, 2);
    for (const sig of [
      "demo_session_apply(uuid, text, uuid, uuid, integer, bigint, bigint, uuid, jsonb, integer, jsonb)",
      "demo_session_find_op(uuid, text, uuid, uuid, integer, uuid)",
    ]) assert.ok(code.includes(`'${sig}'`), sig);
    for (const role of ["PUBLIC", "anon", "authenticated"]) assert.match(code, new RegExp(`REVOKE ALL ON FUNCTION %s FROM ${role}`));
    assert.match(code, /GRANT EXECUTE ON FUNCTION %s TO service_role/);
  });

  test("042 is unchanged (already applied in production)", () => {
    const m042 = readFileSync(path.join(MIGRATIONS_DIR, "042_add_demo_sessions.sql"), "utf8").replace(/\r\n/g, "\n");
    assert.equal(createHash("sha256").update(m042).digest("hex").slice(0, 16), "e355bbd6aca68f0c");
  });
});
