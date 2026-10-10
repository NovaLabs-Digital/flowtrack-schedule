// Real-PostgreSQL proof of the SFT reminder occurrence-dedup fix
// (migrations/037). This specifically proves the one thing that is a
// property of real SQL NULL/equality semantics, not application logic: that
// app/api/cron/reminders/route.ts's alreadyDelivered() query -- a literal
// copy of the exact SQL below -- correctly treats a messages_sent row as
// "already delivered for THIS occurrence" only when scheduled_for matches
// exactly, and NEVER matches a row whose scheduled_for is NULL (a historical
// row written before this migration) or set to a different occurrence (an
// earlier, now-superseded scheduled_for on a since-rescheduled appointment).
// The route-level fake-harness tests in
// app/api/cron/reminders/route.test.ts prove the SURROUNDING application
// logic (what the route does with the result); this file proves the actual
// database comparison it depends on. Run with `npm run test:db:reminders`.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { startTestDb, makeWorkspace, makeAppointment, MIGRATIONS, type TestDb } from "./harness.ts";

let db: TestDb;
let c: pg.Client;

before(async () => {
  db = await startTestDb({
    migrations: [
      ...MIGRATIONS,
      "035_reset_reminder_on_recurrence_change.sql",
      "036_reminder_claim_protocol.sql",
      "037_messages_sent_occurrence_snapshot.sql",
      "038_add_cancellation_correction_fields.sql",
      "039_preserve_cancelled_occurrence_exclusion.sql",
    ],
  });
  c = await db.connect();
});
after(async () => {
  await c.end();
  await db.stop();
});

// Literal copy of app/api/cron/reminders/route.ts's alreadyDelivered() query.
async function alreadyDelivered(client: pg.Client, appointmentId: string, channel: string, scheduledFor: Date): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT id FROM messages_sent
     WHERE appointment_id = $1 AND channel = $2 AND kind = 'reminder_24h'
       AND scheduled_for = $3 AND provider_id != 'failed'
     LIMIT 1`,
    [appointmentId, channel, scheduledFor]
  );
  return rows.length > 0;
}

async function insertMessage(
  client: pg.Client,
  workspaceId: string,
  appointmentId: string,
  opts: { channel?: string; providerId?: string; scheduledFor?: Date | null }
) {
  await client.query(
    `INSERT INTO messages_sent (id, appointment_id, channel, kind, provider_id, workspace_id, scheduled_for)
     VALUES ($1,$2,$3,'reminder_24h',$4,$5,$6)`,
    [randomUUID(), appointmentId, opts.channel ?? "email", opts.providerId ?? "resend-id-1", workspaceId, opts.scheduledFor ?? null]
  );
}

describe("reminder occurrence dedup -- real PostgreSQL proof (migrations/037)", () => {
  test("a successful delivery recorded for the CURRENT occurrence is a match -- a genuine retry of the same occurrence is correctly deduped", async () => {
    const fx = await makeWorkspace(c);
    const occurrence = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const apptId = await makeAppointment(c, fx, { scheduledFor: occurrence });
    await insertMessage(c, fx.workspaceId, apptId, { scheduledFor: occurrence });

    assert.equal(await alreadyDelivered(c, apptId, "email", occurrence), true);
  });

  test("a successful delivery recorded for a DIFFERENT (earlier) occurrence of the SAME appointment row never matches the new occurrence -- a reschedule is never suppressed", async () => {
    const fx = await makeWorkspace(c);
    const oldOccurrence = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const newOccurrence = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const apptId = await makeAppointment(c, fx, { scheduledFor: newOccurrence });
    await insertMessage(c, fx.workspaceId, apptId, { scheduledFor: oldOccurrence });

    assert.equal(await alreadyDelivered(c, apptId, "email", newOccurrence), false, "the old occurrence's success must never suppress the new occurrence's reminder");
  });

  test("a historical row with scheduled_for = NULL (written before migration 037, or never backfilled) never matches any occurrence -- NULL is never equal to a specific timestamp", async () => {
    const fx = await makeWorkspace(c);
    const occurrence = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const apptId = await makeAppointment(c, fx, { scheduledFor: occurrence });
    await insertMessage(c, fx.workspaceId, apptId, { scheduledFor: null });

    assert.equal(await alreadyDelivered(c, apptId, "email", occurrence), false, "a NULL-scheduled_for historical row must not suppress a new reminder for any occurrence");
  });

  test("a 'failed' provider_id for the CURRENT occurrence is NOT a match -- the channel remains retryable", async () => {
    const fx = await makeWorkspace(c);
    const occurrence = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const apptId = await makeAppointment(c, fx, { scheduledFor: occurrence });
    await insertMessage(c, fx.workspaceId, apptId, { scheduledFor: occurrence, providerId: "failed" });

    assert.equal(await alreadyDelivered(c, apptId, "email", occurrence), false);
  });

  test("channels are independent -- a delivered email for this occurrence does not mark sms as delivered", async () => {
    const fx = await makeWorkspace(c);
    const occurrence = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const apptId = await makeAppointment(c, fx, { scheduledFor: occurrence });
    await insertMessage(c, fx.workspaceId, apptId, { channel: "email", scheduledFor: occurrence });

    assert.equal(await alreadyDelivered(c, apptId, "email", occurrence), true);
    assert.equal(await alreadyDelivered(c, apptId, "sms", occurrence), false);
  });

  // "SFT -- Final Reminder Release Preparation": move-away-and-back
  // investigation. Scenario: an appointment is reminded, rescheduled away,
  // then rescheduled BACK to its original scheduled_for, and re-enters the
  // cron's window. The reset-on-reschedule logic (app/api/appointments/
  // update/route.ts, apply_recurrence_change) only ever compares the new
  // value against the CURRENT locked row -- it has no memory of history --
  // so each move (including the move back) independently re-arms
  // reminder_24h_sent_at/claim columns to NULL. This proves what happens
  // next: the dedup check correctly finds the ORIGINAL success row (its
  // scheduled_for now matches the RESTORED value exactly) and treats the
  // channel as already delivered -- which is the correct outcome, not a
  // defect: the client already received an accurate reminder for the
  // appointment's final (and only ever actually communicated) time, and
  // sending it again would be a literal duplicate, not new information.
  test("move-away-and-back: after two resets (away, then back to the ORIGINAL scheduled_for), the original success is still correctly recognized for the restored occurrence -- no duplicate send", async () => {
    const fx = await makeWorkspace(c);
    const original = new Date(Date.now() + 24 * 60 * 60 * 1000); // "Oct 20"
    const movedAway = new Date(Date.now() + 48 * 60 * 60 * 1000); // "Oct 21"
    const apptId = await makeAppointment(c, fx, { scheduledFor: original });

    // The original send succeeded for the appointment's original time.
    await insertMessage(c, fx.workspaceId, apptId, { channel: "email", scheduledFor: original });
    await insertMessage(c, fx.workspaceId, apptId, { channel: "sms", scheduledFor: original });
    await c.query(
      "UPDATE appointments SET reminder_24h_sent_at = now(), reminder_24h_claimed_at = NULL, reminder_24h_claim_token = NULL WHERE id = $1",
      [apptId]
    );

    // Move 1: away. Literal copy of the app's reset-on-reschedule condition
    // (the new value differs from the row's current value -> reset).
    await c.query(
      "UPDATE appointments SET scheduled_for = $2, reminder_24h_sent_at = NULL, reminder_24h_claimed_at = NULL, reminder_24h_claim_token = NULL WHERE id = $1",
      [apptId, movedAway]
    );
    let row = (await c.query("SELECT scheduled_for, reminder_24h_sent_at FROM appointments WHERE id=$1", [apptId])).rows[0];
    assert.equal(row.reminder_24h_sent_at, null, "moving away re-arms eligibility");

    // Move 2: back to the ORIGINAL scheduled_for. The app compares against
    // the row's CURRENT value (movedAway), which differs from `original` --
    // so this is independently treated as a real change, and resets again.
    await c.query(
      "UPDATE appointments SET scheduled_for = $2, reminder_24h_sent_at = NULL, reminder_24h_claimed_at = NULL, reminder_24h_claim_token = NULL WHERE id = $1",
      [apptId, original]
    );
    row = (await c.query("SELECT scheduled_for, reminder_24h_sent_at FROM appointments WHERE id=$1", [apptId])).rows[0];
    assert.equal(row.reminder_24h_sent_at, null, "moving back also re-arms eligibility -- the appointment IS claimable again");
    assert.equal(row.scheduled_for.getTime(), original.getTime());

    // The cron would now claim this row and revalidate fresh.scheduled_for
    // = original. alreadyDelivered() correctly finds the ORIGINAL success
    // row for both channels, because scheduled_for matches exactly --
    // despite the two resets in between, which never touched messages_sent.
    assert.equal(await alreadyDelivered(c, apptId, "email", original), true, "the original success for this exact occurrence is still correctly recognized");
    assert.equal(await alreadyDelivered(c, apptId, "sms", original), true);
  });
});
