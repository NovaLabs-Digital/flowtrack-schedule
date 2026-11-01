// Migration 044 (shared screen and labelled cursors): its source, and its
// behaviour against real PostgreSQL on top of 042 + 043 the way production
// gets it -- including a session already live when 044 arrives, and the
// calls the previously deployed code makes.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { startTestDb, MIGRATIONS, backendPid, waitUntilBlocked, track, type TestDb } from "./harness.ts";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const read = (f: string) => readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
const MIGRATION_044 = read("044_shared_session_view.sql");
const code = MIGRATION_044.replace(/\r\n/g, "\n").replace(/--.*$/gm, "");

let db: TestDb;
let c: pg.Client;

before(async () => {
  db = await startTestDb({ migrations: [...MIGRATIONS, "042_add_demo_sessions.sql", "043_guest_control_permissions.sql"] });
  c = await db.connect();
});
after(async () => {
  await c?.end();
  await db?.stop();
});

type Session = { id: string; control_gen: number; controller: string; view?: unknown; view_version?: number; host_cursor?: unknown; visitor_cursor?: unknown; status: string };
type Json = { outcome: string; session: Session; visitor_epoch: number; [k: string]: unknown };
const rpc = async (client: pg.Client, fn: string, args: unknown[]): Promise<Json> => {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  return (await client.query(`SELECT ${fn}(${placeholders}) AS r`, args)).rows[0].r;
};
const HASH = () => randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

async function withVisitor() {
  const host = randomUUID();
  const invite = HASH();
  const created = await rpc(c, "demo_session_create", [host, { clients: [] }, invite]);
  const visitor = randomUUID();
  const claim = await rpc(c, "demo_session_claim", [invite, visitor, "Dana"]);
  return { host, id: created.session.id, visitor, epoch: claim.visitor_epoch };
}
type S = Awaited<ReturnType<typeof withVisitor>>;
const allow = (s: S) => rpc(c, "demo_session_set_controller", [s.id, s.host, "visitor"]);
const stop = (s: S) => rpc(c, "demo_session_set_controller", [s.id, s.host, "host"]);
const hostPut = (client: pg.Client, s: S, base: number, view: unknown, gen = 1) =>
  rpc(client, "demo_session_put_view", [s.id, "host", s.host, null, null, gen, base, view]);
const guestPut = (client: pg.Client, s: S, gen: number, base: number, view: unknown) =>
  rpc(client, "demo_session_put_view", [s.id, "visitor", null, s.visitor, s.epoch, gen, base, view]);
const hostSync = (s: S, cursor: unknown = null) => rpc(c, "demo_session_sync_cursor", [s.id, "host", s.host, null, null, null, cursor]);
const guestSync = (s: S, cursor: unknown = null) => rpc(c, "demo_session_sync_cursor", [s.id, "visitor", null, s.visitor, s.epoch, null, cursor]);
const viewOf = async (id: string) => (await c.query("SELECT view, view_version FROM demo_sessions WHERE id = $1", [id])).rows[0];

describe("transition from 043", () => {
  test("a session live under 043 keeps working when 044 is applied; the previously deployed code's calls still work", async () => {
    const s = await withVisitor();
    const gen = (await allow(s)).session.control_gen;
    await c.query(MIGRATION_044);
    // Calls the code deployed before 044 makes, unchanged:
    assert.equal((await rpc(c, "demo_session_sync", [s.id, "host", s.host, null, null, null])).outcome, "ok");
    assert.equal((await rpc(c, "demo_session_apply", [s.id, "visitor", null, s.visitor, s.epoch, gen, 1, randomUUID(), { clients: [1] }, 200, null])).outcome, "ok");
    assert.equal((await stop(s)).outcome, "ok");
    const r = (await c.query("SELECT status, view, view_version, host_cursor, visitor_cursor FROM demo_sessions WHERE id = $1", [s.id])).rows[0];
    assert.deepEqual([r.status, r.view, Number(r.view_version), r.host_cursor, r.visitor_cursor], ["live", null, 0, null, null]);
  });

  test("044 can be applied again without error", async () => {
    await c.query(MIGRATION_044);
  });
});

describe("shared view", () => {
  test("the session view now reports the shared view and its version", async () => {
    const s = await withVisitor();
    assert.equal((await hostPut(c, s, 0, { nav: { mode: "week" } })).outcome, "ok");
    const synced = await hostSync(s);
    assert.deepEqual([synced.session.view, synced.session.view_version], [{ nav: { mode: "week" } }, 1]);
  });

  test("the host may always change the view; a watching guest may not; an allowed guest may", async () => {
    const s = await withVisitor();
    assert.equal((await hostPut(c, s, 0, { v: 1 })).outcome, "ok");
    assert.equal((await guestPut(c, s, 1, 1, { v: 2 })).outcome, "not_controller");
    const gen = (await allow(s)).session.control_gen;
    assert.equal((await guestPut(c, s, gen, 1, { v: 2 })).outcome, "ok");
    assert.equal((await hostPut(c, s, 2, { v: 3 }, 1)).outcome, "ok", "the host's control_gen is never checked");
  });

  test("a guest view change made before Stop Guest Control is rejected, even if guest control is allowed again", async () => {
    const s = await withVisitor();
    const first = (await allow(s)).session.control_gen;
    await stop(s);
    assert.equal((await guestPut(c, s, first, 0, { late: true })).outcome, "not_controller");
    const second = (await allow(s)).session.control_gen;
    assert.equal((await guestPut(c, s, first, 0, { late: true })).outcome, "stale_control");
    assert.equal((await guestPut(c, s, second, 0, { fresh: true })).outcome, "ok");
    assert.deepEqual((await viewOf(s.id)).view, { fresh: true });
  });

  test("compare-and-swap: two changes from the same version -- exactly one is stored", async () => {
    const s = await withVisitor();
    const gen = (await allow(s)).session.control_gen;
    const a = await db.connect();
    const b = await db.connect();
    try {
      const [ra, rb] = await Promise.all([hostPut(a, s, 0, { by: "host" }), guestPut(b, s, gen, 0, { by: "guest" })]);
      assert.deepEqual([ra.outcome, rb.outcome].sort(), ["ok", "stale_view"]);
      const v = await viewOf(s.id);
      assert.equal(Number(v.view_version), 1);
      assert.equal(v.view.by, ra.outcome === "ok" ? "host" : "guest");
    } finally {
      await a.end();
      await b.end();
    }
  });

  test("Stop waits for an in-flight guest view change holding the row; a delayed one after Stop is refused", async () => {
    const s = await withVisitor();
    const gen = (await allow(s)).session.control_gen;
    const guestConn = await db.connect();
    const hostConn = await db.connect();
    try {
      await guestConn.query("BEGIN");
      assert.equal((await guestPut(guestConn, s, gen, 0, { committed: true })).outcome, "ok");
      const pid = await backendPid(hostConn);
      const stopping = track(rpc(hostConn, "demo_session_set_controller", [s.id, s.host, "host"]));
      await waitUntilBlocked(c, pid);
      assert.equal(stopping.settled(), false);
      await guestConn.query("COMMIT");
      await stopping.result;
      assert.equal((await guestPut(c, s, gen, 1, { late: true })).outcome, "not_controller");
      assert.deepEqual((await viewOf(s.id)).view, { committed: true });
    } finally {
      await guestConn.end();
      await hostConn.end();
    }
  });

  test("malformed or oversized views are rejected without writing", async () => {
    const s = await withVisitor();
    assert.equal((await hostPut(c, s, 0, JSON.stringify([1]))).outcome, "invalid_input");
    assert.equal((await hostPut(c, s, 0, { big: "x".repeat(70_000) })).outcome, "invalid_input");
    assert.equal(Number((await viewOf(s.id)).view_version), 0);
  });

  test("ending the session clears the view and both cursors", async () => {
    const s = await withVisitor();
    await allow(s);
    await hostPut(c, s, 0, { nav: {} });
    await hostSync(s, { anchor: "schedule-grid", x: 0.5, y: 0.5 });
    await guestSync(s, { anchor: "schedule-grid", x: 0.1, y: 0.1 });
    await rpc(c, "demo_session_end", [s.id, s.host]);
    const r = (await c.query("SELECT view, host_cursor, visitor_cursor FROM demo_sessions WHERE id = $1", [s.id])).rows[0];
    assert.deepEqual([r.view, r.host_cursor, r.visitor_cursor], [null, null, null]);
    assert.equal((await hostPut(c, s, 1, { after: true })).outcome, "ended");
  });
});

describe("cursors", () => {
  test("the host's cursor is shared; the guest's only while guest control is allowed", async () => {
    const s = await withVisitor();
    await hostSync(s, { anchor: "schedule-grid", x: 0.25, y: 0.75 });
    const seenByGuest = await guestSync(s, { anchor: "top-bar", x: 0.5, y: 0.5 });
    assert.deepEqual(seenByGuest.session.host_cursor, { anchor: "schedule-grid", x: 0.25, y: 0.75 });
    assert.equal(seenByGuest.session.visitor_cursor, null, "a watching guest's cursor is not kept");
    await allow(s);
    await guestSync(s, { anchor: "top-bar", x: 0.5, y: 0.5 });
    assert.deepEqual((await hostSync(s, { anchor: "schedule-grid", x: 0.3, y: 0.3 })).session.visitor_cursor, { anchor: "top-bar", x: 0.5, y: 0.5 });
    await stop(s);
    assert.equal((await hostSync(s)).session.visitor_cursor, null, "hidden as soon as guest control stops");
  });

  test("a cursor older than 5 seconds is not returned (disconnected participant); null clears it", async () => {
    const s = await withVisitor();
    await hostSync(s, { anchor: "schedule-grid", x: 0.5, y: 0.5 });
    await c.query("UPDATE demo_sessions SET host_cursor = jsonb_set(host_cursor, '{at}', to_jsonb(now() - interval '6 seconds')) WHERE id = $1", [s.id]);
    assert.equal((await guestSync(s)).session.host_cursor, null);
    await hostSync(s, { anchor: "schedule-grid", x: 0.5, y: 0.5 });
    assert.ok((await guestSync(s)).session.host_cursor);
    await hostSync(s, null);
    assert.equal((await guestSync(s)).session.host_cursor, null);
  });

  test("oversized or non-object cursors are rejected; identity is checked as everywhere else", async () => {
    const s = await withVisitor();
    assert.equal((await hostSync(s, { anchor: "x".repeat(400), x: 0, y: 0 })).outcome, "invalid_input");
    assert.equal((await hostSync(s, JSON.stringify([1]))).outcome, "invalid_input");
    assert.equal((await rpc(c, "demo_session_sync_cursor", [s.id, "host", randomUUID(), null, null, null, null])).outcome, "unauthorized");
  });
});

describe("privileges and source", () => {
  test("only service_role can call the new and replaced functions", async () => {
    const s = await withVisitor();
    for (const role of ["anon", "authenticated"]) {
      const client = await db.connect();
      try {
        await client.query(`SET ROLE ${role}`);
        await assert.rejects(hostPut(client, s, 0, {}), /permission denied/);
        await assert.rejects(client.query("SELECT demo_session_sync_cursor($1, 'host', $2, NULL, NULL, NULL, NULL)", [s.id, s.host]), /permission denied/);
      } finally {
        await client.end();
      }
    }
    const svc = await db.connect();
    try {
      await svc.query("SET ROLE service_role");
      assert.equal((await hostPut(svc, s, 0, { ok: true })).outcome, "ok");
      assert.equal((await rpc(svc, "demo_session_sync_cursor", [s.id, "host", s.host, null, null, null, null])).outcome, "ok");
    } finally {
      await svc.end();
    }
  });

  test("044 runs in one transaction, only adds columns to demo_sessions, and keeps SECURITY INVOKER + fixed search_path", () => {
    assert.match(MIGRATION_044, /^BEGIN;$/m);
    assert.match(MIGRATION_044, /^COMMIT;$/m);
    assert.ok(!/\b(CREATE|DROP)\s+TABLE\b/i.test(code));
    const altered = [...code.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => `${m[1]}.${m[2]}`);
    assert.deepEqual(altered, ["demo_sessions.view", "demo_sessions.view_version", "demo_sessions.host_cursor", "demo_sessions.visitor_cursor"]);
    assert.ok(!/SECURITY DEFINER/i.test(code));
    const fns = [...code.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(/g)].map((m) => m[1]);
    assert.deepEqual(fns, ["demo_session_view", "demo_session_close", "demo_session_put_view", "demo_session_sync_cursor"]);
  });

  test("042 and 043 are unchanged (already applied in production)", () => {
    const hash = (f: string) => createHash("sha256").update(read(f).replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);
    assert.equal(hash("042_add_demo_sessions.sql"), "e355bbd6aca68f0c");
    assert.equal(hash("043_guest_control_permissions.sql"), "6013cbde42cb4b9e");
  });
});
