// Real-PostgreSQL verification of migration 040 (messages_sent.subject) --
// proves, against a genuine disposable PostgreSQL instance (not the fake
// Supabase client in lib/testSupport.ts, which can't enforce or reproduce
// real ALTER TABLE ADD COLUMN semantics on a populated table), that:
//   A. a row inserted BEFORE migration 040 is applied is untouched by it --
//      after the migration runs, that row's subject reads back as NULL,
//      never backfilled or guessed.
//   B. a row inserted AFTER migration 040, with an explicit subject value,
//      persists that exact string, unmodified.
//   C. an sms row (no subject concept) stays NULL, not an empty string.
//   D. re-applying the migration (ADD COLUMN IF NOT EXISTS) is a no-op.
//
// Deliberately NOT wired into test-db/harness.ts's own MIGRATIONS list (same
// convention as test-db/completed_job_billing.test.ts) -- migration 040 is
// applied here as its own query, issued AFTER the "legacy" row is inserted,
// specifically so the ordering matches what actually happens in production:
// existing rows exist first, the migration runs once, against data that is
// already there.
//
// This spins up a throwaway LOCAL PostgreSQL instance (embedded-postgres)
// and deletes it on exit -- it never touches production or any shared
// database. Applying migration 040 here is local/test-only; it is not
// applied to production by this file or by anything else in this change.
// Run with: node --import ./scripts/test-register.mjs --test
// --test-concurrency=1 test-db/messages_sent_subject.test.ts
// (or `npm run test:db:messages`).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { startTestDb, makeWorkspace, makeAppointment, MIGRATIONS, type TestDb, type Fixture } from "./harness.ts";

const MIGRATION_040_SQL = fs.readFileSync(
  fileURLToPath(new URL("../migrations/040_add_messages_sent_subject.sql", import.meta.url)),
  "utf8"
);

describe("migration 040 (messages_sent.subject) -- real PostgreSQL verification", () => {
  let db: TestDb;
  let c: pg.Client;
  let fx: Fixture;
  let appointmentId: string;
  let legacyRowId: string;

  before(async () => {
    // MIGRATIONS (001-031) only -- migration 040 is deliberately NOT in this
    // startup list. It is applied manually below, as a separate query, after
    // the "legacy" row already exists.
    db = await startTestDb({ migrations: [...MIGRATIONS] });
    c = await db.connect();
    fx = await makeWorkspace(c);
    appointmentId = await makeAppointment(c, fx, { scheduledFor: new Date("2026-06-01T13:00:00Z") });

    // A "legacy" row: written before migration 040 ever existed. The
    // baseline messages_sent shape (test-db/baseline.sql) has no subject
    // column at all at this point, so this INSERT cannot reference one.
    legacyRowId = randomUUID();
    await c.query(
      `INSERT INTO messages_sent (id, appointment_id, channel, kind, provider_id, workspace_id)
       VALUES ($1, $2, 'email', 'confirmation', 're_legacy123', $3)`,
      [legacyRowId, appointmentId, fx.workspaceId]
    );

    // Apply migration 040 now, against a database that already has the
    // legacy row above -- the real ALTER TABLE ADD COLUMN behavior on
    // populated data, not an empty table.
    await c.query(MIGRATION_040_SQL);
  });
  after(async () => {
    await c.end();
    await db.stop();
  });

  test("a row that existed before migration 040 keeps subject = NULL -- never backfilled or guessed", async () => {
    const res = await c.query("SELECT subject FROM messages_sent WHERE id = $1", [legacyRowId]);
    assert.equal(res.rows[0].subject, null);
  });

  test("a row inserted after migration 040, with an explicit subject, persists that exact string unmodified", async () => {
    const newRowId = randomUUID();
    const subject = "Your Regular Cleaning is confirmed for Tue, Jun 2 at 1:00 PM";
    await c.query(
      `INSERT INTO messages_sent (id, appointment_id, channel, kind, provider_id, workspace_id, subject)
       VALUES ($1, $2, 'email', 'confirmation', 're_new456', $3, $4)`,
      [newRowId, appointmentId, fx.workspaceId, subject]
    );
    const res = await c.query("SELECT subject FROM messages_sent WHERE id = $1", [newRowId]);
    assert.equal(res.rows[0].subject, subject);
  });

  test("an sms row (no subject concept) inserted after migration 040 without one keeps subject = NULL, not an empty string", async () => {
    const smsRowId = randomUUID();
    await c.query(
      `INSERT INTO messages_sent (id, appointment_id, channel, kind, provider_id, workspace_id)
       VALUES ($1, $2, 'sms', 'reminder_24h', 'SM_fake789', $3)`,
      [smsRowId, appointmentId, fx.workspaceId]
    );
    const res = await c.query("SELECT subject FROM messages_sent WHERE id = $1", [smsRowId]);
    assert.equal(res.rows[0].subject, null);
  });

  test("re-applying migration 040 (ADD COLUMN IF NOT EXISTS) is a no-op -- never errors, never disturbs an already-set value", async () => {
    await c.query(MIGRATION_040_SQL);
    const legacy = await c.query("SELECT subject FROM messages_sent WHERE id = $1", [legacyRowId]);
    assert.equal(legacy.rows[0].subject, null);
  });
});
