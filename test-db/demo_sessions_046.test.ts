// Migration 046 (Guided Demo Session chat) against real PostgreSQL on top of
// 042 + 043 + 044, the way production gets it -- including a session already
// live when 046 arrives and the calls the currently deployed code makes.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { startTestDb, MIGRATIONS, type TestDb } from "./harness.ts";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION_046 = readFileSync(path.join(MIGRATIONS_DIR, "046_session_chat.sql"), "utf8");

let db: TestDb;
let c: pg.Client;
before(async () => {
  db = await startTestDb({ migrations: [...MIGRATIONS, "042_add_demo_sessions.sql", "043_guest_control_permissions.sql", "044_shared_session_view.sql"] });
  c = await db.connect();
});
after(async () => {
  await c?.end();
  await db?.stop();
});

// Database JSON results, read loosely in assertions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- arbitrary nested RPC result JSON
type Json = Record<string, any>;
const rpc = async (client: pg.Client, fn: string, args: unknown[]): Promise<Json> => {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  return (await client.query(`SELECT ${fn}(${placeholders}) AS r`, args)).rows[0].r;
};
const HASH = () => randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");

async function withVisitor(name: string | null = "Dana") {
  const host = randomUUID();
  const invite = HASH();
  const created = await rpc(c, "demo_session_create", [host, { clients: [] }, invite]);
  const visitor = randomUUID();
  const claim = await rpc(c, "demo_session_claim", [invite, visitor, name]);
  return { host, id: created.session.id as string, visitor, epoch: claim.visitor_epoch as number };
}
type S = Awaited<ReturnType<typeof withVisitor>>;
const hostPost = (s: S, body: string, clientId = randomUUID(), client = c) =>
  rpc(client, "demo_session_post_message", [s.id, "host", s.host, null, null, clientId, body]);
const guestPost = (s: S, body: string, clientId = randomUUID(), client = c) =>
  rpc(client, "demo_session_post_message", [s.id, "visitor", null, s.visitor, s.epoch, clientId, body]);
const hostChat = (s: S, gen: number | null, since: number | null) =>
  rpc(c, "demo_session_sync_chat", [s.id, "host", s.host, null, null, null, null, gen, since]);
const guestChat = (s: S, gen: number | null, since: number | null) =>
  rpc(c, "demo_session_sync_chat", [s.id, "visitor", null, s.visitor, s.epoch, null, null, gen, since]);
const rows = async (id: string) => Number((await c.query("SELECT count(*) FROM demo_session_messages WHERE session_id = $1", [id])).rows[0].count);
const ageMessages = (id: string, seconds: number) =>
  c.query("UPDATE demo_session_messages SET created_at = created_at - make_interval(secs => $2) WHERE session_id = $1", [id, seconds]);

describe("transition from 044", () => {
  test("a session live under 044 keeps working when 046 is applied; the deployed code's calls still work", async () => {
    const s = await withVisitor();
    const gen = (await rpc(c, "demo_session_set_controller", [s.id, s.host, "visitor"])).session.control_gen;
    await c.query(MIGRATION_046);
    assert.equal((await rpc(c, "demo_session_sync_cursor", [s.id, "host", s.host, null, null, null, null])).outcome, "ok");
    assert.equal((await rpc(c, "demo_session_sync", [s.id, "visitor", null, s.visitor, s.epoch, null])).outcome, "ok");
    assert.equal((await rpc(c, "demo_session_apply", [s.id, "visitor", null, s.visitor, s.epoch, gen, 1, randomUUID(), { clients: [1] }, 200, null])).outcome, "ok");
    assert.equal((await rpc(c, "demo_session_put_view", [s.id, "host", s.host, null, null, gen, 0, { nav: {} }])).outcome, "ok");
    assert.equal((await rpc(c, "demo_session_set_controller", [s.id, s.host, "host"])).outcome, "ok");
    const invite = HASH();
    assert.equal((await rpc(c, "demo_session_reinvite", [s.id, s.host, invite])).outcome, "ok");
    assert.equal((await rpc(c, "demo_session_claim", [invite, randomUUID(), "Lee"])).outcome, "ok");
    assert.equal((await rpc(c, "demo_session_end", [s.id, s.host])).outcome, "ok");
  });

  test("046 can be applied again without error", async () => {
    await c.query(MIGRATION_046);
  });
});

describe("sending and receiving", () => {
  test("both can send; names are Alberto and the guest's name; the receiver gets them in order", async () => {
    const s = await withVisitor("Dana");
    assert.equal((await hostPost(s, "Welcome!")).message.name, "Alberto");
    assert.equal((await guestPost(s, "  Thanks  ")).message.body, "Thanks");
    const got = await guestChat(s, null, null);
    assert.equal(got.outcome, "ok");
    assert.deepEqual(got.chat.messages.map((m: Json) => [m.role, m.name, m.body]), [["host", "Alberto", "Welcome!"], ["visitor", "Dana", "Thanks"]]);
    assert.equal(got.chat.more, false);
  });

  test("a guest without a name is 'Guest'", async () => {
    const s = await withVisitor(null);
    assert.equal((await guestPost(s, "hi")).message.name, "Guest");
  });

  test("a watch-only guest can chat (dashboard control is irrelevant)", async () => {
    const s = await withVisitor();
    const view = (await rpc(c, "demo_session_sync", [s.id, "host", s.host, null, null, null])).session;
    assert.equal(view.controller, "host");
    assert.equal((await guestPost(s, "Just watching")).outcome, "ok");
  });

  test("only new messages after the cursor are returned; the check-in result is unchanged otherwise", async () => {
    const s = await withVisitor();
    const first = (await hostPost(s, "one")).message.id;
    await hostPost(s, "two");
    const got = await guestChat(s, 0, first);
    assert.deepEqual(got.chat.messages.map((m: Json) => m.body), ["two"]);
    assert.ok(got.session && "state" in got, "still the 044 check-in result");
  });
});

describe("authorization", () => {
  test("someone else, a former guest, or an unknown session cannot send or read", async () => {
    const s = await withVisitor();
    assert.equal((await rpc(c, "demo_session_post_message", [s.id, "host", randomUUID(), null, null, randomUUID(), "x"])).outcome, "unauthorized");
    assert.equal((await rpc(c, "demo_session_post_message", [s.id, "visitor", null, randomUUID(), s.epoch, randomUUID(), "x"])).outcome, "unauthorized");
    assert.equal((await rpc(c, "demo_session_post_message", [randomUUID(), "host", s.host, null, null, randomUUID(), "x"])).outcome, "unauthorized");
    await rpc(c, "demo_session_reinvite", [s.id, s.host, HASH()]);
    assert.equal((await guestPost(s, "still here?")).outcome, "unauthorized", "a former guest is out");
    assert.equal((await guestChat(s, 0, null)).outcome, "unauthorized");
  });

  test("nothing can be sent after End or expiry, and the conversation is gone", async () => {
    const s = await withVisitor();
    await hostPost(s, "before end");
    await rpc(c, "demo_session_end", [s.id, s.host]);
    assert.equal((await hostPost(s, "after end")).outcome, "ended");
    assert.equal(await rows(s.id), 0);

    const t = await withVisitor();
    await guestPost(t, "before expiry");
    await c.query("UPDATE demo_sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [t.id]);
    assert.equal((await guestPost(t, "after expiry")).outcome, "ended");
    assert.equal(await rows(t.id), 0);
    assert.equal((await guestChat(t, 0, null)).outcome, "ended");
  });
});

describe("limits", () => {
  test("1-500 characters after trimming", async () => {
    const s = await withVisitor();
    assert.equal((await hostPost(s, "x".repeat(500))).outcome, "ok");
    for (const bad of ["", "   ", "x".repeat(501)]) assert.equal((await hostPost(s, bad)).outcome, "invalid_input", JSON.stringify(bad.slice(0, 5)));
  });

  test("5 messages per 10 seconds per sender; the other person is unaffected; allowed again after 10 seconds", async () => {
    const s = await withVisitor();
    for (let i = 0; i < 5; i++) assert.equal((await guestPost(s, `m${i}`)).outcome, "ok");
    assert.equal((await guestPost(s, "m5")).outcome, "rate_limited");
    assert.equal((await hostPost(s, "host is fine")).outcome, "ok");
    await ageMessages(s.id, 11);
    assert.equal((await guestPost(s, "later")).outcome, "ok");
  });

  test("300 messages per conversation", async () => {
    const s = await withVisitor();
    await c.query(
      `INSERT INTO demo_session_messages (session_id, sender_role, sender_name, body, client_msg_id, created_at)
       SELECT $1, 'host', 'Alberto', 'm' || g, gen_random_uuid(), now() - interval '1 minute' FROM generate_series(1, 300) g`,
      [s.id]
    );
    assert.equal((await guestPost(s, "one more")).outcome, "chat_full");
  });
});

describe("duplicates and simultaneous requests", () => {
  test("a retried send returns the original message instead of adding one", async () => {
    const s = await withVisitor();
    const id = randomUUID();
    const a = await guestPost(s, "hello", id);
    const b = await guestPost(s, "hello", id);
    assert.deepEqual([a.duplicate, b.duplicate, b.message.id], [false, true, a.message.id]);
    assert.equal(await rows(s.id), 1);
    assert.equal((await hostPost(s, "hijack", id)).outcome, "invalid_input", "the other person can't reuse it");
  });

  test("the same send arriving twice at once: one message", async () => {
    const s = await withVisitor();
    const clients = await Promise.all([db.connect(), db.connect(), db.connect()]);
    try {
      const id = randomUUID();
      const results = await Promise.all(clients.map((cl) => guestPost(s, "dup", id, cl)));
      assert.ok(results.every((r) => r.outcome === "ok"));
      assert.equal(results.filter((r) => r.duplicate === false).length, 1);
      assert.equal(await rows(s.id), 1);
    } finally {
      await Promise.all(clients.map((cl) => cl.end()));
    }
  });

  test("10 messages at once from one sender: exactly 5 accepted", async () => {
    const s = await withVisitor();
    const clients = await Promise.all(Array.from({ length: 10 }, () => db.connect()));
    try {
      const results = await Promise.all(clients.map((cl, i) => guestPost(s, `burst ${i}`, randomUUID(), cl)));
      assert.equal(results.filter((r) => r.outcome === "ok").length, 5);
      assert.equal(results.filter((r) => r.outcome === "rate_limited").length, 5);
    } finally {
      await Promise.all(clients.map((cl) => cl.end()));
    }
  });

  test("messages racing End: nothing survives the end", async () => {
    const s = await withVisitor();
    const clients = await Promise.all(Array.from({ length: 4 }, () => db.connect()));
    try {
      await Promise.all([
        ...clients.slice(0, 3).map((cl, i) => hostPost(s, `race ${i}`, randomUUID(), cl)),
        rpc(clients[3], "demo_session_end", [s.id, s.host]),
      ]);
      assert.equal(await rows(s.id), 0);
      assert.equal((await hostPost(s, "after")).outcome, "ended");
    } finally {
      await Promise.all(clients.map((cl) => cl.end()));
    }
  });
});

describe("reading a full conversation in batches", () => {
  test("300 messages: 200, then the remaining 100 -- none lost, none repeated", async () => {
    const s = await withVisitor();
    await c.query(
      `INSERT INTO demo_session_messages (session_id, sender_role, sender_name, body, client_msg_id)
       SELECT $1, CASE WHEN g % 2 = 0 THEN 'host' ELSE 'visitor' END, 'x', 'm' || g, gen_random_uuid() FROM generate_series(1, 300) g`,
      [s.id]
    );
    const first = await hostChat(s, null, null);
    assert.deepEqual([first.chat.messages.length, first.chat.more], [200, true]);
    const last = first.chat.messages.at(-1).id;
    const second = await hostChat(s, first.chat.gen, last);
    assert.deepEqual([second.chat.messages.length, second.chat.more], [100, false]);
    const bodies = [...first.chat.messages, ...second.chat.messages].map((m: Json) => m.body);
    assert.deepEqual(bodies, Array.from({ length: 300 }, (_, i) => `m${i + 1}`));
  });
});

describe("clearing", () => {
  test("a replacement guest starts with an empty chat; both browsers see a new chat generation and read from the start", async () => {
    const s = await withVisitor("First");
    await hostPost(s, "hello first guest");
    await guestPost(s, "hi");
    const before = await hostChat(s, null, null);
    const invite = HASH();
    await rpc(c, "demo_session_reinvite", [s.id, s.host, invite]);
    const next = { ...s, visitor: randomUUID(), epoch: 0 };
    next.epoch = (await rpc(c, "demo_session_claim", [invite, next.visitor, "Second"])).visitor_epoch;
    assert.equal(await rows(s.id), 0);
    const hostAfter = await hostChat(s, before.chat.gen, before.chat.messages.at(-1).id);
    assert.ok(hostAfter.chat.gen > before.chat.gen, "the host's browser is told to drop its copy");
    assert.deepEqual(hostAfter.chat.messages, []);
    assert.deepEqual((await guestChat(next, null, null)).chat.messages, []);
  });

  test("the first guest still sees what the host wrote before they joined", async () => {
    const host = randomUUID();
    const invite = HASH();
    const created = await rpc(c, "demo_session_create", [host, { clients: [] }, invite]);
    const s = { host, id: created.session.id, visitor: randomUUID(), epoch: 0 };
    await hostPost(s, "Welcome -- I'll be with you shortly");
    s.epoch = (await rpc(c, "demo_session_claim", [invite, s.visitor, "Dana"])).visitor_epoch;
    assert.deepEqual((await guestChat(s, null, null)).chat.messages.map((m: Json) => m.body), ["Welcome -- I'll be with you shortly"]);
  });

  test("End increments the chat generation and deletes the conversation", async () => {
    const s = await withVisitor();
    await hostPost(s, "bye");
    const gen = (await hostChat(s, null, null)).chat.gen;
    await rpc(c, "demo_session_end", [s.id, s.host]);
    const after = (await c.query("SELECT chat_gen FROM demo_sessions WHERE id = $1", [s.id])).rows[0].chat_gen;
    assert.ok(after > gen);
    assert.equal(await rows(s.id), 0);
  });
});

describe("access", () => {
  test("only the service role may read the messages table or call the chat functions", async () => {
    for (const role of ["anon", "authenticated"]) {
      assert.equal((await c.query("SELECT has_table_privilege($1, 'demo_session_messages', 'SELECT') AS ok", [role])).rows[0].ok, false);
      for (const fn of ["demo_session_post_message(uuid, text, uuid, uuid, integer, uuid, text)", "demo_session_sync_chat(uuid, text, uuid, uuid, integer, bigint, jsonb, integer, bigint)"]) {
        assert.equal((await c.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, fn])).rows[0].ok, false, `${role} ${fn}`);
      }
    }
  });
});
