// Migration 045 (optional two-step sign-in, recovery codes): its behaviour
// against real PostgreSQL, on the production-shaped tables it builds on
// (workspace_memberships and pending_mfa_challenges, exactly as exported
// from production) -- including the calls
// the previously deployed code makes, concurrent changes, and code reuse.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { startTestDb, backendPid, waitUntilBlocked, track, type TestDb } from "./harness.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_045 = readFileSync(path.join(ROOT, "migrations", "045_owner_sign_in_security.sql"), "utf8");
// The two tables 045 builds on, exactly as exported from production
// (test-db/production-schema.sql, which is not kept in git).
const PRODUCTION_TABLES = [
  "CREATE TABLE public.workspace_memberships (id uuid DEFAULT gen_random_uuid() NOT NULL, workspace_id uuid NOT NULL, profile_id uuid NOT NULL, role text DEFAULT 'owner'::text NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL, terms_accepted_at timestamp with time zone, terms_version text, session_epoch integer DEFAULT 1 NOT NULL);",
  "CREATE TABLE public.pending_mfa_challenges (token text NOT NULL, auth_user_id uuid NOT NULL, factor_id text, supabase_access_token text NOT NULL, supabase_refresh_token text NOT NULL, attempt_count integer DEFAULT 0 NOT NULL, created_at timestamp with time zone DEFAULT now() NOT NULL, expires_at timestamp with time zone NOT NULL, consumed_at timestamp with time zone);",
  "ALTER TABLE ONLY public.pending_mfa_challenges ADD CONSTRAINT pending_mfa_challenges_pkey PRIMARY KEY (token);",
];

let db: TestDb;
let c: pg.Client;

before(async () => {
  db = await startTestDb({ migrations: [] });
  c = await db.connect();
  for (const ddl of PRODUCTION_TABLES) await c.query(ddl);
  await c.query("ALTER TABLE workspace_memberships ADD CONSTRAINT uq_workspace_memberships_profile_role UNIQUE (profile_id, role)");
  await c.query("GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_memberships, pending_mfa_challenges TO service_role");
  // A sign-in challenge created by the code deployed before 045.
  await c.query(
    `INSERT INTO pending_mfa_challenges (token, auth_user_id, factor_id, supabase_access_token, supabase_refresh_token, expires_at)
     VALUES ('before-045', $1, 'f1', 'at', 'rt', now() + interval '5 minutes')`,
    [randomUUID()]
  );
  await c.query(MIGRATION_045);
});
after(async () => {
  await c?.end();
  await db?.stop();
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const codes = (n = 10) => Array.from({ length: n }, () => sha(randomUUID()));

async function owner(epoch = 1) {
  const user = randomUUID();
  await c.query("INSERT INTO workspace_memberships (workspace_id, profile_id, role, session_epoch) VALUES ($1, $2, 'owner', $3)", [randomUUID(), user, epoch]);
  return user;
}
const state = async (user: string, client = c) => (await client.query("SELECT owner_security_state($1) AS s", [user])).rows[0].s;
const lock = async (user: string, holder: string, client = c, seconds = 300) =>
  (await client.query("SELECT owner_security_lock($1, $2, $3) AS ok", [user, holder, seconds])).rows[0].ok as boolean;
const finish = async (user: string, holder: string, required: boolean | null, hashes: string[] | null, client = c) =>
  (await client.query("SELECT owner_security_finish($1, $2, $3, $4) AS e", [user, holder, required, hashes])).rows[0].e as number | null;
const useCode = async (user: string, hash: string, client = c) =>
  (await client.query("SELECT owner_use_recovery_code($1, $2) AS ok", [user, hash])).rows[0].ok as boolean;
const epochOf = async (user: string) => (await c.query("SELECT session_epoch FROM workspace_memberships WHERE profile_id = $1", [user])).rows[0].session_epoch;

describe("transition", () => {
  test("a sign-in challenge created before 045 keeps working and is a sign-in", async () => {
    const r = (await c.query("SELECT purpose, enrolled, recovered FROM pending_mfa_challenges WHERE token = 'before-045'")).rows[0];
    assert.deepEqual(r, { purpose: "login", enrolled: false, recovered: false });
  });

  test("the deployed code's calls still work: insert, update factor, consume", async () => {
    const user = randomUUID();
    await c.query(
      `INSERT INTO pending_mfa_challenges (token, auth_user_id, factor_id, supabase_access_token, supabase_refresh_token, expires_at)
       VALUES ('deployed', $1, NULL, 'at', 'rt', now() + interval '5 minutes')`,
      [user]
    );
    await c.query("UPDATE pending_mfa_challenges SET factor_id = 'f2' WHERE token = 'deployed'");
    const gone = await c.query("DELETE FROM pending_mfa_challenges WHERE token = 'deployed' RETURNING factor_id");
    assert.equal(gone.rows[0].factor_id, "f2");
  });

  test("045 can be applied again without error", async () => {
    await c.query(MIGRATION_045);
  });

  test("an unknown purpose is refused", async () => {
    await assert.rejects(
      c.query(
        `INSERT INTO pending_mfa_challenges (token, auth_user_id, supabase_access_token, supabase_refresh_token, expires_at, purpose)
         VALUES ('bad', $1, 'at', 'rt', now(), 'anything')`,
        [randomUUID()]
      )
    );
  });
});

describe("state and default", () => {
  test("an owner with no row has two-step sign-in ON and no recovery codes", async () => {
    const user = await owner();
    assert.deepEqual(await state(user), { required: true, codes_total: 0, codes_unused: 0 });
  });
});

describe("lock", () => {
  test("a second change is refused while the first holds the lock; the holder may renew it", async () => {
    const user = await owner();
    assert.equal(await lock(user, "a"), true);
    assert.equal(await lock(user, "b"), false);
    assert.equal(await lock(user, "a"), true);
  });

  test("an expired lock can be taken by a new change", async () => {
    const user = await owner();
    assert.equal(await lock(user, "a"), true);
    await c.query("UPDATE owner_security SET lock_expires_at = now() - interval '1 second' WHERE auth_user_id = $1", [user]);
    assert.equal(await lock(user, "b"), true);
  });

  test("unlock releases only the holder's own lock", async () => {
    const user = await owner();
    await lock(user, "a");
    await c.query("SELECT owner_security_unlock($1, 'b')", [user]);
    assert.equal(await lock(user, "b"), false);
    await c.query("SELECT owner_security_unlock($1, 'a')", [user]);
    assert.equal(await lock(user, "b"), true);
  });

  test("two changes racing for the lock: exactly one gets it", async () => {
    const user = await owner();
    const c2 = await db.connect();
    try {
      const results = await Promise.all([lock(user, "a", c), lock(user, "b", c2)]);
      assert.deepEqual(results.sort(), [false, true]);
    } finally {
      await c2.end();
    }
  });
});

describe("finish", () => {
  test("turning off: setting, codes and session epoch change together, and the lock is released", async () => {
    const user = await owner(4);
    await lock(user, "a");
    await finish(user, "a", null, codes());
    await lock(user, "a");
    assert.equal(await finish(user, "a", false, []), 6);
    assert.deepEqual(await state(user), { required: false, codes_total: 0, codes_unused: 0 });
    assert.equal(await lock(user, "z"), true);
  });

  test("turning off in three steps: setting off with codes kept, re-lock while the authenticator is removed, then codes cleared", async () => {
    const user = await owner(1);
    await lock(user, "a");
    await finish(user, "a", true, codes());
    await lock(user, "off");
    assert.equal(await finish(user, "off", false, null), 3);
    assert.deepEqual(await state(user), { required: false, codes_total: 10, codes_unused: 10 }, "codes kept until the authenticator is gone");
    assert.equal(await lock(user, "off"), true, "the same change takes the lock again");
    assert.equal(await finish(user, "off", null, []), 4);
    assert.deepEqual(await state(user), { required: false, codes_total: 0, codes_unused: 0 });
  });

  test("if another change takes the lock between the steps, the last step changes nothing (codes stay)", async () => {
    const user = await owner(1);
    await lock(user, "a");
    await finish(user, "a", true, codes());
    await lock(user, "off");
    await finish(user, "off", false, null);
    assert.equal(await lock(user, "other"), true);
    assert.equal(await lock(user, "off"), false);
    assert.equal(await finish(user, "off", null, []), null);
    assert.equal((await state(user)).codes_unused, 10);
  });

  test("turning on with new codes replaces every old code", async () => {
    const user = await owner();
    const first = codes();
    await lock(user, "a");
    await finish(user, "a", true, first);
    const second = codes();
    await lock(user, "b");
    await finish(user, "b", true, second);
    assert.equal(await useCode(user, first[0]), false);
    assert.equal(await useCode(user, second[0]), true);
    assert.deepEqual(await state(user), { required: true, codes_total: 10, codes_unused: 9 });
  });

  test("without the lock nothing changes", async () => {
    const user = await owner(2);
    assert.equal(await finish(user, "a", false, []), null);
    await lock(user, "a");
    assert.equal(await finish(user, "b", false, []), null);
    assert.equal(await epochOf(user), 2);
    assert.equal((await state(user)).required, true);
  });

  test("an identity without an owner membership changes nothing", async () => {
    const user = randomUUID();
    await lock(user, "a");
    assert.equal(await finish(user, "a", false, []), null);
    assert.equal((await state(user)).required, true);
  });

  test("malformed code hashes are refused and nothing changes", async () => {
    const user = await owner(3);
    await lock(user, "a");
    for (const bad of [["not-a-hash"], [sha("x"), sha("x")], Array.from({ length: 21 }, () => sha(randomUUID()))]) {
      await assert.rejects(finish(user, "a", false, bad));
    }
    assert.equal(await epochOf(user), 3);
    assert.equal((await state(user)).required, true);
  });

  test("two finishes racing on the same lock: exactly one applies, the epoch moves once", async () => {
    const user = await owner(1);
    await lock(user, "a");
    const c2 = await db.connect();
    const blocker = await db.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM owner_security WHERE auth_user_id = $1 FOR UPDATE", [user]);
      const pids = [await backendPid(c), await backendPid(c2)];
      const first = track(finish(user, "a", false, [], c));
      const second = track(finish(user, "a", true, codes(), c2));
      for (const pid of pids) await waitUntilBlocked(blocker, pid);
      await blocker.query("COMMIT");
      const results = [await first.result, await second.result];
      assert.equal(results.filter((r) => r === 2).length, 1);
      assert.equal(results.filter((r) => r === null).length, 1);
      assert.equal(await epochOf(user), 2);
    } finally {
      await c2.end();
      await blocker.end();
    }
  });
});

describe("recovery codes", () => {
  test("each code works once; unknown codes and other owners' codes never work", async () => {
    const user = await owner();
    const other = await owner();
    const mine = codes();
    await lock(user, "a");
    await finish(user, "a", true, mine);
    assert.equal(await useCode(other, mine[1]), false);
    assert.equal(await useCode(user, sha("guess")), false);
    assert.equal(await useCode(user, mine[1]), true);
    assert.equal(await useCode(user, mine[1]), false);
  });

  test("the same code used twice at once: exactly one use succeeds", async () => {
    const user = await owner();
    const mine = codes();
    await lock(user, "a");
    await finish(user, "a", true, mine);
    const c2 = await db.connect();
    try {
      const results = await Promise.all([useCode(user, mine[2], c), useCode(user, mine[2], c2)]);
      assert.deepEqual(results.sort(), [false, true]);
    } finally {
      await c2.end();
    }
  });

  test("codes are stored only as hashes", async () => {
    const r = await c.query("SELECT code_hash FROM owner_recovery_codes LIMIT 5");
    for (const row of r.rows) assert.match(row.code_hash, /^[0-9a-f]{64}$/);
  });
});

describe("access", () => {
  const FNS = [
    "owner_security_state(uuid)",
    "owner_security_lock(uuid, text, integer)",
    "owner_security_unlock(uuid, text)",
    "owner_security_finish(uuid, text, boolean, text[])",
    "owner_use_recovery_code(uuid, text)",
  ];
  test("only the service role may call the functions or read the tables", async () => {
    for (const fn of FNS) {
      for (const role of ["anon", "authenticated"]) {
        const r = await c.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, fn]);
        assert.equal(r.rows[0].ok, false, `${role} ${fn}`);
      }
      assert.equal((await c.query("SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok", [fn])).rows[0].ok, true);
    }
    for (const table of ["owner_security", "owner_recovery_codes"]) {
      for (const role of ["anon", "authenticated"]) {
        const r = await c.query("SELECT has_table_privilege($1, $2, 'SELECT') AS ok", [role, table]);
        assert.equal(r.rows[0].ok, false, `${role} ${table}`);
      }
    }
  });

  test("the service role can run a whole change", async () => {
    const user = await owner();
    await c.query("SET ROLE service_role");
    try {
      assert.equal(await lock(user, "svc"), true);
      assert.equal(await finish(user, "svc", false, []), 2);
    } finally {
      await c.query("RESET ROLE");
    }
  });
});
