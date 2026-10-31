// Migration 042 (Guided Demo Sessions) against real PostgreSQL: identity,
// invitations, control ownership and control_gen, compare-and-swap versions,
// idempotent retries, lifecycle (expiry, host absence, visitor timeout),
// ending, cleanup, and privileges.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { startTestDb, MIGRATIONS, backendPid, waitUntilBlocked, track, type TestDb } from "./harness.ts";

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

type Json = Record<string, any>;
const rpc = async (client: pg.Client, fn: string, args: unknown[]): Promise<Json> => {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  return (await client.query(`SELECT ${fn}(${placeholders}) AS r`, args)).rows[0].r;
};

const HASH = () => randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""); // 64 chars
const fixture = (n = 1) => ({ marker: n, appointments: [{ id: "a1" }], clients: [] });

async function newSession() {
  const host = randomUUID();
  const invite = HASH();
  const created = await rpc(c, "demo_session_create", [host, fixture(), invite]);
  assert.equal(created.outcome, "ok");
  return { host, invite, id: created.session.id as string };
}
async function withVisitor() {
  const s = await newSession();
  const visitor = randomUUID();
  const claim = await rpc(c, "demo_session_claim", [s.invite, visitor, "  Dana  "]);
  assert.equal(claim.outcome, "ok");
  return { ...s, visitor, epoch: claim.visitor_epoch as number };
}
const sync = (s: { id: string }, role: string, host: string | null, visitor: string | null, epoch: number | null, since: number | null = null) =>
  rpc(c, "demo_session_sync", [s.id, role, host, visitor, epoch, since]);
const apply = (
  client: pg.Client, s: { id: string }, role: string, host: string | null, visitor: string | null, epoch: number | null,
  gen: number, base: number, op = randomUUID(), state: Json = fixture(9)
) => rpc(client, "demo_session_apply", [s.id, role, host, visitor, epoch, gen, base, op, state, 200, { ok: true, op }]);
const row = async (id: string) => (await c.query("SELECT * FROM demo_sessions WHERE id = $1", [id])).rows[0];

describe("creating and joining", () => {
  test("create stores a fresh dataset, 2-hour expiry, 30-minute invitation; a new session ends the host's previous one", async () => {
    const s = await newSession();
    const r = await row(s.id);
    assert.equal(r.status, "live");
    assert.deepEqual(r.state, fixture());
    const hours = (r.expires_at - r.created_at) / 3_600_000;
    const inviteMinutes = (r.invite_expires_at - r.created_at) / 60_000;
    assert.ok(Math.abs(hours - 2) < 0.01 && Math.abs(inviteMinutes - 30) < 0.1);
    const again = await rpc(c, "demo_session_create", [s.host, fixture(2), HASH()]);
    assert.equal(again.outcome, "ok");
    const old = await row(s.id);
    assert.equal(old.status, "ended");
    assert.equal(old.end_reason, "replaced");
    assert.equal(old.state, null);
  });

  test("an invitation works once; unknown, reused, expired, and ended-session invitations are all 'invite_unavailable'", async () => {
    const s = await newSession();
    assert.equal((await rpc(c, "demo_session_claim", [HASH(), randomUUID(), null])).outcome, "invite_unavailable");
    const first = await rpc(c, "demo_session_claim", [s.invite, randomUUID(), "  Dana  "]);
    assert.equal(first.outcome, "ok");
    assert.equal(first.session.visitor_display_name, "Dana", "name trimmed");
    assert.equal((await rpc(c, "demo_session_claim", [s.invite, randomUUID(), null])).outcome, "invite_unavailable", "single use");
    assert.equal((await row(s.id)).invite_token_hash, null, "hash cleared once used");

    const expired = await newSession();
    await c.query("UPDATE demo_sessions SET invite_expires_at = now() - interval '1 second' WHERE id = $1", [expired.id]);
    assert.equal((await rpc(c, "demo_session_claim", [expired.invite, randomUUID(), null])).outcome, "invite_unavailable");

    const ended = await newSession();
    await rpc(c, "demo_session_end", [ended.id, ended.host]);
    assert.equal((await rpc(c, "demo_session_claim", [ended.invite, randomUUID(), null])).outcome, "invite_unavailable");
  });

  test("demo_session_current finds only the host's own live session (Resume Session)", async () => {
    const s = await newSession();
    const found = await rpc(c, "demo_session_current", [s.host]);
    assert.equal(found.outcome, "ok");
    assert.equal(found.session.id, s.id);
    assert.equal((await rpc(c, "demo_session_current", [randomUUID()])).outcome, "none", "another host sees nothing");
    await c.query("UPDATE demo_sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [s.id]);
    assert.equal((await rpc(c, "demo_session_current", [s.host])).outcome, "none", "an expired session is not resumable");
    assert.equal((await row(s.id)).end_reason, "expired");
  });

  test("display names over 40 characters are rejected", async () => {
    const s = await newSession();
    assert.equal((await rpc(c, "demo_session_claim", [s.invite, randomUUID(), "x".repeat(41)])).outcome, "invalid_input");
  });
});

describe("identity on every call", () => {
  test("wrong host, wrong visitor, or a stale visitor epoch is 'unauthorized' and learns nothing", async () => {
    const s = await withVisitor();
    assert.equal((await sync(s, "host", randomUUID(), null, null)).outcome, "unauthorized");
    assert.equal((await sync(s, "visitor", null, randomUUID(), s.epoch)).outcome, "unauthorized");
    assert.equal((await sync(s, "visitor", null, s.visitor, s.epoch + 1)).outcome, "unauthorized");
    assert.equal((await sync({ id: randomUUID() }, "host", s.host, null, null)).outcome, "unauthorized");
    assert.equal((await rpc(c, "demo_session_set_controller", [s.id, randomUUID(), "visitor"])).outcome, "unauthorized");
    assert.equal((await rpc(c, "demo_session_end", [s.id, randomUUID()])).outcome, "unauthorized");
    assert.equal((await row(s.id)).status, "live");
  });

  test("sync returns the dataset only when it is newer than the caller's version", async () => {
    const s = await withVisitor();
    const first = await sync(s, "visitor", null, s.visitor, s.epoch, null);
    assert.equal(first.outcome, "ok");
    assert.deepEqual(first.state, fixture());
    assert.equal((await sync(s, "visitor", null, s.visitor, s.epoch, 1)).state, null);
    assert.equal(first.session.invite_pending, false);
    assert.equal("invite_token_hash" in first.session, false, "never exposes the token hash");
  });
});

describe("control ownership and control_gen", () => {
  test("a watching visitor cannot change data; the host can", async () => {
    const s = await withVisitor();
    const denied = await apply(c, s, "visitor", null, s.visitor, s.epoch, 1, 1);
    assert.equal(denied.outcome, "not_controller");
    assert.equal((await row(s.id)).state_version, "1");
    const ok = await apply(c, s, "host", s.host, null, null, 1, 1);
    assert.equal(ok.outcome, "ok");
    assert.equal(ok.session.state_version, 2);
  });

  test("Give Control lets the visitor change data; Take Back invalidates the visitor's previous authority immediately", async () => {
    const s = await withVisitor();
    const given = await rpc(c, "demo_session_set_controller", [s.id, s.host, "visitor"]);
    assert.equal(given.outcome, "ok");
    const gen = given.session.control_gen;
    assert.equal(gen, 2);
    assert.equal((await apply(c, s, "visitor", null, s.visitor, s.epoch, gen, 1)).outcome, "ok");

    const taken = await rpc(c, "demo_session_set_controller", [s.id, s.host, "host"]);
    assert.equal(taken.session.control_gen, 3);
    // A delayed visitor request carrying the old authority:
    const delayed = await apply(c, s, "visitor", null, s.visitor, s.epoch, gen, 2);
    assert.equal(delayed.outcome, "not_controller");
    // Even after control is given back, the OLD generation stays invalid:
    await rpc(c, "demo_session_set_controller", [s.id, s.host, "visitor"]);
    const stale = await apply(c, s, "visitor", null, s.visitor, s.epoch, gen, 2);
    assert.equal(stale.outcome, "stale_control");
    // The host, no longer controlling, is refused too.
    assert.equal((await apply(c, s, "host", s.host, null, null, 4, 2)).outcome, "not_controller");
    assert.equal((await row(s.id)).state_version, "2", "no rejected request wrote anything");
  });

  test("giving control to an absent visitor is refused; repeating the current controller does not bump the generation", async () => {
    const s = await newSession();
    assert.equal((await rpc(c, "demo_session_set_controller", [s.id, s.host, "visitor"])).outcome, "visitor_unavailable");
    const same = await rpc(c, "demo_session_set_controller", [s.id, s.host, "host"]);
    assert.equal(same.session.control_gen, 1);
  });

  test("Take Back waits for an in-flight visitor change: a change that committed first stands, nothing after it applies", async () => {
    const s = await withVisitor();
    const gen = (await rpc(c, "demo_session_set_controller", [s.id, s.host, "visitor"])).session.control_gen;
    const visitorConn = await db.connect();
    const hostConn = await db.connect();
    try {
      await visitorConn.query("BEGIN");
      const inFlight = await apply(visitorConn, s, "visitor", null, s.visitor, s.epoch, gen, 1);
      assert.equal(inFlight.outcome, "ok");
      const pid = await backendPid(hostConn);
      const takeBack = track(rpc(hostConn, "demo_session_set_controller", [s.id, s.host, "host"]));
      await waitUntilBlocked(c, pid);
      assert.equal(takeBack.settled(), false, "Take Back waits on the row lock");
      await visitorConn.query("COMMIT");
      assert.equal((await takeBack.result).session.control_gen, gen + 1);
      assert.equal((await row(s.id)).state_version, "2", "the committed change stands");
      assert.equal((await apply(c, s, "visitor", null, s.visitor, s.epoch, gen, 2)).outcome, "not_controller");
    } finally {
      await visitorConn.end();
      await hostConn.end();
    }
  });
});

describe("versions and retries", () => {
  test("two concurrent changes from the same version: exactly one applies", async () => {
    const s = await newSession();
    const a = await db.connect();
    const b = await db.connect();
    try {
      const [ra, rb] = await Promise.all([
        apply(a, s, "host", s.host, null, null, 1, 1, randomUUID(), fixture(10)),
        apply(b, s, "host", s.host, null, null, 1, 1, randomUUID(), fixture(11)),
      ]);
      assert.deepEqual([ra.outcome, rb.outcome].sort(), ["ok", "stale_version"]);
      assert.equal((await row(s.id)).state_version, "2");
    } finally {
      await a.end();
      await b.end();
    }
  });

  test("a retried op_id returns its original result and never applies twice, even after control changed", async () => {
    const s = await withVisitor();
    const gen = (await rpc(c, "demo_session_set_controller", [s.id, s.host, "visitor"])).session.control_gen;
    const op = randomUUID();
    const first = await apply(c, s, "visitor", null, s.visitor, s.epoch, gen, 1, op);
    assert.equal(first.outcome, "ok");
    const retry = await apply(c, s, "visitor", null, s.visitor, s.epoch, gen, 1, op);
    assert.equal(retry.outcome, "duplicate");
    assert.equal(retry.result_version, 2);
    assert.deepEqual(retry.response, { ok: true, op });
    await rpc(c, "demo_session_set_controller", [s.id, s.host, "host"]);
    assert.equal((await apply(c, s, "visitor", null, s.visitor, s.epoch, gen, 1, op)).outcome, "duplicate");
    assert.equal((await row(s.id)).state_version, "2");
    assert.equal((await c.query("SELECT count(*)::int AS n FROM demo_session_ops WHERE session_id = $1", [s.id])).rows[0].n, 1);
  });

  test("malformed changes are rejected without writing", async () => {
    const s = await newSession();
    assert.equal((await rpc(c, "demo_session_apply", [s.id, "host", s.host, null, null, 1, 1, randomUUID(), JSON.stringify([1]), 200, null])).outcome, "invalid_input");
    assert.equal((await rpc(c, "demo_session_apply", [s.id, "host", s.host, null, null, 1, 1, null, fixture(), 200, null])).outcome, "invalid_input");
    assert.equal((await row(s.id)).state_version, "1");
  });
});

describe("lifecycle", () => {
  test("a visitor in control who stops polling for 20 seconds loses control to the host", async () => {
    const s = await withVisitor();
    const gen = (await rpc(c, "demo_session_set_controller", [s.id, s.host, "visitor"])).session.control_gen;
    await c.query("UPDATE demo_sessions SET visitor_last_seen_at = now() - interval '21 seconds' WHERE id = $1", [s.id]);
    const r = await sync(s, "host", s.host, null, null);
    assert.equal(r.session.controller, "host");
    assert.equal(r.session.control_gen, gen + 1);
    // The visitor reconnects: still a participant, now watching.
    const back = await sync(s, "visitor", null, s.visitor, s.epoch);
    assert.equal(back.outcome, "ok");
    assert.equal(back.session.controller, "host");
  });

  test("leaving returns control to the host at once; the visitor can rejoin with the same identity", async () => {
    const s = await withVisitor();
    await rpc(c, "demo_session_set_controller", [s.id, s.host, "visitor"]);
    const left = await rpc(c, "demo_session_leave", [s.id, s.visitor, s.epoch]);
    assert.equal(left.session.controller, "host");
    assert.equal((await sync(s, "visitor", null, s.visitor, s.epoch)).outcome, "ok");
  });

  test("sessions end 2 hours after creation and when the host is gone for 5 minutes; everything is cleared", async () => {
    const expired = await withVisitor();
    await c.query("UPDATE demo_sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.id]);
    const e = await sync(expired, "visitor", null, expired.visitor, expired.epoch);
    assert.equal(e.outcome, "ended");
    assert.equal(e.session.end_reason, "expired");
    assert.equal((await apply(c, expired, "host", expired.host, null, null, 1, 1)).outcome, "ended");

    const absent = await withVisitor();
    await c.query("UPDATE demo_sessions SET host_last_seen_at = now() - interval '6 minutes' WHERE id = $1", [absent.id]);
    const a = await sync(absent, "visitor", null, absent.visitor, absent.epoch);
    assert.equal(a.session.end_reason, "host_absent");
    const r = await row(absent.id);
    assert.equal(r.state, null);
    assert.equal(r.visitor_display_name, null);
  });

  test("End Session clears the dataset, invitation, name, and retry log; every later call is refused", async () => {
    const s = await withVisitor();
    await apply(c, s, "host", s.host, null, null, 1, 1);
    const ended = await rpc(c, "demo_session_end", [s.id, s.host]);
    assert.equal(ended.session.status, "ended");
    const r = await row(s.id);
    assert.equal(r.state, null);
    assert.equal(r.invite_token_hash, null);
    assert.equal(r.visitor_display_name, null);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM demo_session_ops WHERE session_id = $1", [s.id])).rows[0].n, 0);
    assert.equal((await sync(s, "visitor", null, s.visitor, s.epoch)).outcome, "ended");
    assert.equal((await rpc(c, "demo_session_set_controller", [s.id, s.host, "visitor"])).outcome, "ended");
    assert.equal((await rpc(c, "demo_session_reinvite", [s.id, s.host, HASH()])).outcome, "ended");
    assert.equal((await rpc(c, "demo_session_end", [s.id, s.host])).outcome, "ok", "ending twice is harmless");
  });

  test("a new invitation revokes the previous visitor and returns control to the host", async () => {
    const s = await withVisitor();
    await rpc(c, "demo_session_set_controller", [s.id, s.host, "visitor"]);
    const re = await rpc(c, "demo_session_reinvite", [s.id, s.host, HASH()]);
    assert.equal(re.session.controller, "host");
    assert.equal(re.session.visitor_joined, false);
    assert.equal((await sync(s, "visitor", null, s.visitor, s.epoch)).outcome, "unauthorized");
  });
});

describe("cleanup and privileges", () => {
  test("cleanup ends expired sessions and deletes sessions ended more than 7 days ago", async () => {
    const live = await newSession();
    await c.query("UPDATE demo_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [live.id]);
    const old = await newSession();
    await rpc(c, "demo_session_end", [old.id, old.host]);
    await c.query("UPDATE demo_sessions SET ended_at = now() - interval '8 days' WHERE id = $1", [old.id]);
    const recent = await newSession();
    await rpc(c, "demo_session_end", [recent.id, recent.host]);
    const r = await rpc(c, "demo_session_cleanup", []);
    assert.equal(r.outcome, "ok");
    assert.equal((await row(live.id)).status, "ended");
    assert.equal(await row(old.id), undefined);
    assert.ok(await row(recent.id), "recently ended rows are kept");
  });

  test("only service_role can use the tables and functions", async () => {
    const s = await newSession();
    for (const role of ["anon", "authenticated"]) {
      const client = await db.connect();
      try {
        await client.query(`SET ROLE ${role}`);
        await assert.rejects(client.query("SELECT * FROM demo_sessions"), /permission denied/);
        await assert.rejects(client.query("SELECT demo_session_sync($1, 'host', $2, NULL, NULL, NULL)", [s.id, s.host]), /permission denied/);
      } finally {
        await client.end();
      }
    }
    const svc = await db.connect();
    try {
      await svc.query("SET ROLE service_role");
      assert.equal((await rpc(svc, "demo_session_sync", [s.id, "host", s.host, null, null, null])).outcome, "ok");
    } finally {
      await svc.end();
    }
  });
});
