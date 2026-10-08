// Real-PostgreSQL proof of the SFT reminder claim protocol's atomicity and
// ownership guarantees (migrations/036). The application logic that DECIDES
// what to do with a claim's result (compose a message, skip, finalize,
// release) is proven at the route level with a fake Supabase harness in
// app/api/cron/reminders/route.test.ts -- that fake cannot prove true
// concurrent atomicity (it has no real row locking). This file proves the
// one thing only a real database can: that two genuinely concurrent
// transactions racing the exact same UPDATE statement the route issues can
// never both "win" a claim, and that claim_token ownership is a real,
// database-enforced guarantee, not just an application convention. Run with
// `npm run test:db:reminders`.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  startTestDb, makeWorkspace, makeAppointment, waitUntilBlocked, backendPid, track, MIGRATIONS,
  type TestDb,
} from "./harness.ts";

let db: TestDb;
let c: pg.Client; // main connection
let obs: pg.Client; // dedicated observer for lock-wait barriers

before(async () => {
  db = await startTestDb({
    migrations: [
      ...MIGRATIONS,
      "035_reset_reminder_on_recurrence_change.sql",
      "036_reminder_claim_protocol.sql",
      "037_messages_sent_occurrence_snapshot.sql",
    ],
  });
  c = await db.connect();
  obs = await db.connect();
});
after(async () => {
  await c.end();
  await obs.end();
  await db.stop();
});

function futureDate(hoursAhead = 24): Date {
  return new Date(Date.now() + hoursAhead * 60 * 60 * 1000);
}

// Literal copies of the exact three SQL statements
// app/api/cron/reminders/route.ts issues (claim / finalize / release) --
// kept as raw SQL here, not routed through the application's own
// supabase-js call, specifically so this test proves the real PostgreSQL
// guarantee independent of any JS-layer behavior.
async function claimSql(client: pg.Client, apptId: string, workspaceId: string, token: string, leaseMinutes = 10) {
  return client.query(
    `UPDATE appointments
     SET reminder_24h_claimed_at = now(), reminder_24h_claim_token = $3
     WHERE id = $1 AND workspace_id = $2
       AND status = 'scheduled' AND is_demo = false
       AND reminder_24h_sent_at IS NULL
       AND scheduled_for BETWEEN now() AND now() + interval '48 hours'
       AND (reminder_24h_claimed_at IS NULL OR reminder_24h_claimed_at < now() - interval '${leaseMinutes} minutes')
     RETURNING id`,
    [apptId, workspaceId, token]
  );
}
async function finalizeSql(client: pg.Client, apptId: string, workspaceId: string, token: string) {
  return client.query(
    `UPDATE appointments SET reminder_24h_sent_at = now()
     WHERE id = $1 AND workspace_id = $2 AND reminder_24h_claim_token = $3
     RETURNING id`,
    [apptId, workspaceId, token]
  );
}
async function releaseSql(client: pg.Client, apptId: string, workspaceId: string, token: string) {
  return client.query(
    `UPDATE appointments SET reminder_24h_claimed_at = NULL, reminder_24h_claim_token = NULL
     WHERE id = $1 AND workspace_id = $2 AND reminder_24h_claim_token = $3
     RETURNING id`,
    [apptId, workspaceId, token]
  );
}

describe("reminder claim protocol -- real PostgreSQL concurrency proof", () => {
  test("two concurrent cron executions racing the same appointment: exactly one claim succeeds, the other gets zero rows", async () => {
    const fx = await makeWorkspace(c);
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureDate() });
    const tokenA = randomUUID();
    const tokenB = randomUUID();
    const a = await db.connect();
    const b = await db.connect();
    try {
      const bPid = await backendPid(b);
      await a.query("BEGIN");
      const first = await claimSql(a, apptId, fx.workspaceId, tokenA); // holds the row lock, uncommitted
      assert.equal(first.rowCount, 1, "the first claim succeeds");

      const second = track(claimSql(b, apptId, fx.workspaceId, tokenB));
      await waitUntilBlocked(obs, bPid);
      assert.equal(second.settled(), false, "the second claim must genuinely wait on the row lock, never race past it");
      await a.query("COMMIT");

      const secondResult = await second.result;
      assert.equal(secondResult.rowCount, 0, "the second claim re-evaluates against the first's now-committed, fresh claimed_at and correctly finds nothing eligible");

      const row = (await c.query("SELECT reminder_24h_claim_token FROM appointments WHERE id=$1", [apptId])).rows[0];
      assert.equal(row.reminder_24h_claim_token, tokenA, "ownership belongs to the winner only");
    } finally {
      await a.end();
      await b.end();
    }
  });

  test("an abandoned claim (lease already expired) becomes reclaimable without any explicit unclaim step", async () => {
    const fx = await makeWorkspace(c);
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureDate() });
    const abandonedToken = randomUUID();
    const newToken = randomUUID();
    await c.query(
      "UPDATE appointments SET reminder_24h_claimed_at = now() - interval '11 minutes', reminder_24h_claim_token = $2 WHERE id=$1",
      [apptId, abandonedToken]
    );

    const result = await claimSql(c, apptId, fx.workspaceId, newToken, 10);
    assert.equal(result.rowCount, 1, "an 11-minute-old claim is older than the 10-minute lease, so it is reclaimable");
    const row = (await c.query("SELECT reminder_24h_claim_token FROM appointments WHERE id=$1", [apptId])).rows[0];
    assert.equal(row.reminder_24h_claim_token, newToken);
  });

  test("a claim still within its lease is NOT reclaimable -- a second attempt before it expires finds zero rows", async () => {
    const fx = await makeWorkspace(c);
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureDate() });
    const activeToken = randomUUID();
    await c.query(
      "UPDATE appointments SET reminder_24h_claimed_at = now() - interval '2 minutes', reminder_24h_claim_token = $2 WHERE id=$1",
      [apptId, activeToken]
    );

    const result = await claimSql(c, apptId, fx.workspaceId, randomUUID(), 10);
    assert.equal(result.rowCount, 0, "a 2-minute-old claim is still well within the 10-minute lease");
  });

  test("finalize succeeds only when claim_token matches -- a stale/mismatched token affects zero rows and never marks the appointment sent", async () => {
    const fx = await makeWorkspace(c);
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureDate() });
    const realToken = randomUUID();
    await claimSql(c, apptId, fx.workspaceId, realToken);

    const staleFinalize = await finalizeSql(c, apptId, fx.workspaceId, randomUUID());
    assert.equal(staleFinalize.rowCount, 0, "a stale worker can never finalize a claim it no longer owns");
    const stillUnsent = (await c.query("SELECT reminder_24h_sent_at FROM appointments WHERE id=$1", [apptId])).rows[0];
    assert.equal(stillUnsent.reminder_24h_sent_at, null);

    const realFinalize = await finalizeSql(c, apptId, fx.workspaceId, realToken);
    assert.equal(realFinalize.rowCount, 1, "the worker that actually holds the claim can finalize it");
  });

  test("release succeeds only when claim_token matches -- a stale/mismatched token cannot release someone else's active claim", async () => {
    const fx = await makeWorkspace(c);
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureDate() });
    const realToken = randomUUID();
    await claimSql(c, apptId, fx.workspaceId, realToken);

    const staleRelease = await releaseSql(c, apptId, fx.workspaceId, randomUUID());
    assert.equal(staleRelease.rowCount, 0);
    const stillHeld = (await c.query("SELECT reminder_24h_claim_token FROM appointments WHERE id=$1", [apptId])).rows[0];
    assert.equal(stillHeld.reminder_24h_claim_token, realToken, "the claim must still be held -- a stale token cannot release it");

    const realRelease = await releaseSql(c, apptId, fx.workspaceId, realToken);
    assert.equal(realRelease.rowCount, 1);
    const cleared = (await c.query("SELECT reminder_24h_claimed_at, reminder_24h_claim_token FROM appointments WHERE id=$1", [apptId])).rows[0];
    assert.equal(cleared.reminder_24h_claimed_at, null);
    assert.equal(cleared.reminder_24h_claim_token, null);
  });

  test("the exact 'stale worker' scenario: a worker whose lease expired and was reclaimed by a newer attempt can never finalize OR release the newer claim, even though its own (stale, slow) attempt only finishes afterward", async () => {
    const fx = await makeWorkspace(c);
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureDate() });
    const workerAToken = randomUUID();
    const workerBToken = randomUUID();
    // Worker A claims, then goes quiet (crash, killed function) long enough for its own lease to expire.
    await claimSql(c, apptId, fx.workspaceId, workerAToken);
    await c.query("UPDATE appointments SET reminder_24h_claimed_at = now() - interval '11 minutes' WHERE id=$1", [apptId]);
    // Worker B reclaims it in the meantime.
    const reclaim = await claimSql(c, apptId, fx.workspaceId, workerBToken);
    assert.equal(reclaim.rowCount, 1);
    // Worker A, unaware anything changed, finally finishes its own stale attempt and tries to finalize with ITS OWN (now-stale) token.
    const staleFinalize = await finalizeSql(c, apptId, fx.workspaceId, workerAToken);
    assert.equal(staleFinalize.rowCount, 0, "worker A's stale token no longer matches -- it cannot finalize worker B's claim");
    const staleRelease = await releaseSql(c, apptId, fx.workspaceId, workerAToken);
    assert.equal(staleRelease.rowCount, 0, "nor can worker A release worker B's claim");
    // Worker B's own finalize still works correctly, unaffected by worker A's stale attempts.
    const realFinalize = await finalizeSql(c, apptId, fx.workspaceId, workerBToken);
    assert.equal(realFinalize.rowCount, 1);
  });
});
