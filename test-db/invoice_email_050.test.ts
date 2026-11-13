// Migration 050 (Review & Send for issued invoices) against a REAL
// PostgreSQL: the production schema export + migrations 029-049 (production
// today), then 050 exactly as it will be applied -- with its preflight and
// postflight. Covers the claim/finish rules, workspace isolation, double-
// click / retry protection, in-flight and unknown-outcome handling, and that
// the currently deployed app's message inserts keep working.
//
//   TEST_DB_SCHEMA_FILE=test-db/production-schema.sql npm run test:db:invoices
/* eslint-disable @typescript-eslint/no-explicit-any -- test-only: rows are inspected dynamically. */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { startTestDb, makeWorkspace, makeAppointment, waitUntilBlocked, backendPid, track, type TestDb, type Fixture } from "./harness.ts";
import { invoiceSendState } from "../lib/invoiceEmail.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaFile = process.env.TEST_DB_SCHEMA_FILE ? path.resolve(ROOT, process.env.TEST_DB_SCHEMA_FILE) : "";
const SKIP = !schemaFile || !existsSync(schemaFile) ? "TEST_DB_SCHEMA_FILE (production schema export) not provided" : false;
const M050 = readFileSync(path.join(ROOT, "migrations", "050_invoice_email.sql"), "utf8");

let db: TestDb;
let c: pg.Client;
let pool: pg.Pool;
const runSql = async (file: string) => (await c.query(readFileSync(path.join(ROOT, "test-db", file), "utf8"))).rows as { check_name: string; ok: boolean; detail: string }[];
let preflight: { check_name: string; ok: boolean; detail: string }[] = [];
let postflight: { check_name: string; ok: boolean; detail: string }[] = [];
let legacyMessageId = "";

type Ws = Fixture;
const fn = async (cl: pg.Client | pg.Pool, name: string, args: unknown[]): Promise<any> => {
  const ph = args.map((_, i) => `$${i + 1}`).join(", ");
  return (await cl.query(`SELECT ${name}(${ph}) AS r`, args)).rows[0].r;
};

let hour = 0;
async function completedJob(ws: Ws): Promise<string> {
  hour += 1;
  const start = new Date(Date.UTC(2026, 9, 1, 14) + hour * 3600_000);
  const id = await makeAppointment(c, ws, { scheduledFor: start, employees: [ws.employeeIds[0]], priceCents: 15000 });
  await c.query("UPDATE appointment_employees SET actual_started_at = $2, actual_completed_at = $3 WHERE appointment_id = $1",
    [id, start, new Date(start.getTime() + 90 * 60_000)]);
  return id;
}

const FIELDS = {
  business_name: "ACS Cleaning", business_address: "1 Main St", business_phone: null, business_email: "office@example.test",
  bill_to_name: "Pat Example", bill_to_address: "2 Oak Ave", bill_to_email: "pat@example.test",
  terms: "due_on_receipt", invoice_date: "2026-11-12", due_date: "2026-11-12", service_date: "2026-11-10",
  product_service: "Deep Cleaning", description: null, quantity: 1, rate_cents: 15000, tax_rate: null,
  payment_instructions: null, note_to_client: null,
};

async function draft(ws: Ws): Promise<string> {
  const d = await fn(pool, "create_invoice_draft", [ws.workspaceId, await completedJob(ws), randomUUID(), JSON.stringify(FIELDS)]);
  assert.equal(d.outcome, "ok", JSON.stringify(d));
  return d.invoice_id;
}
async function issued(ws: Ws): Promise<{ id: string; sha: string; number: string }> {
  const id = await draft(ws);
  for (let i = 0; i < 5; i++) {
    const input = await fn(pool, "invoice_render_input", [ws.workspaceId, id]);
    const snap = JSON.parse(JSON.stringify(input.render_snapshot));
    const bytes = Buffer.from(`%PDF-1.7\n${JSON.stringify(snap)}\n%%EOF\n`);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const out = await fn(pool, "issue_invoice", [ws.workspaceId, id, input.revision, input.invoice_number, JSON.stringify(snap), bytes.toString("base64"), sha]);
    if (out.outcome === "issued") return { id, sha, number: out.invoice_number };
  }
  throw new Error("could not issue");
}

const claim = (cl: pg.Client | pg.Pool, ws: Ws, invoiceId: string, o: { requestId?: string; to?: string; subject?: string; body?: string; ack?: string | null } = {}) =>
  fn(cl, "claim_invoice_send", [ws.workspaceId, invoiceId, o.requestId ?? randomUUID(), o.to ?? "pat@example.test",
    o.subject ?? "Invoice SFT-1001 from ACS Cleaning", o.body ?? "Hi Pat,\n\nAttached is your invoice.", o.ack ?? null]);
const finish = (ws: Ws, attemptId: string, providerId: string) => fn(pool, "finish_invoice_send", [ws.workspaceId, attemptId, providerId]);
const attempts = async (invoiceId: string) => (await c.query("SELECT * FROM messages_sent WHERE invoice_id = $1 ORDER BY created_at, id", [invoiceId])).rows;
const EMAIL_ID = () => randomUUID();

before(async () => {
  if (SKIP) return;
  db = await startTestDb({
    migrations: [
      "029_add_atomic_recurrence_change.sql", "030_add_work_recording_locking_protocol.sql", "031_add_owner_worked_time_override.sql",
      "032_create_completed_job_billing.sql", "033_completed_job_billing_invoice_per_client.sql", "034_completed_job_billing_finalize_invoice_per_client.sql",
      "035_reset_reminder_on_recurrence_change.sql", "036_reminder_claim_protocol.sql", "037_messages_sent_occurrence_snapshot.sql",
      "038_add_cancellation_correction_fields.sql", "039_preserve_cancelled_occurrence_exclusion.sql", "040_add_messages_sent_subject.sql",
      "041_block_early_job_start.sql", "042_add_demo_sessions.sql", "043_guest_control_permissions.sql", "044_shared_session_view.sql",
      "045_owner_sign_in_security.sql", "046_session_chat.sql", "047_atomic_future_edit.sql", "048_employee_seat_allowance.sql",
      "049_invoices.sql",
    ],
  });
  c = await db.connect();
  await c.query("SET TIME ZONE 'UTC'");
  pool = new pg.Pool({ host: "127.0.0.1", port: db.port, user: "postgres", password: "test", database: "postgres", max: 25 });
  // A message row written by today's app before 050 (an appointment email).
  const ws = await makeWorkspace(c, { employees: 1 });
  const appt = await completedJob(ws);
  legacyMessageId = (await c.query(
    "INSERT INTO messages_sent (appointment_id, channel, kind, to_value, body, provider_id, workspace_id, subject) VALUES ($1, 'email', 'confirmation', 'a@example.test', 'hi', 'failed', $2, 'Confirmed') RETURNING id",
    [appt, ws.workspaceId])).rows[0].id;
  preflight = await runSql("050-preflight.sql");
  await c.query(M050);
  postflight = await runSql("050-postflight.sql");
});

after(async () => {
  if (SKIP) return;
  await pool.end();
  await c.end();
  await db.stop();
});

describe("Rollout (migration 050)", { skip: SKIP }, () => {
  test("050-preflight passes on the database at 049", () => {
    assert.equal(preflight.length, 5);
    assert.deepEqual(preflight.filter((r) => !r.ok), []);
  });

  test("050-postflight passes right after applying; existing message rows are untouched", async () => {
    assert.equal(postflight.length, 7);
    assert.deepEqual(postflight.filter((r) => !r.ok), []);
    const legacy = (await c.query("SELECT * FROM messages_sent WHERE id = $1", [legacyMessageId])).rows[0];
    assert.deepEqual([legacy.provider_id, legacy.invoice_id, legacy.send_request_id, legacy.attachment_sha256], ["failed", null, null, null]);
  });

  test("re-running 050 is safe; the preflight then says it is already applied", async () => {
    await c.query(M050);
    assert.deepEqual((await runSql("050-postflight.sql")).filter((r) => !r.ok), []);
    assert.equal((await runSql("050-preflight.sql")).find((r) => r.check_name === "not_applied_yet")!.ok, false);
  });

  test("the deployed app's message inserts (appointment emails, reminders) keep working after 050", async () => {
    const ws = await makeWorkspace(c, { employees: 1 });
    const appt = await completedJob(ws);
    await c.query(
      "INSERT INTO messages_sent (appointment_id, channel, kind, to_value, body, provider_id, workspace_id, subject, scheduled_for) VALUES ($1, 'email', 'reminder_24h', 'a@example.test', 'body', $3, $2, 'Reminder', now())",
      [appt, ws.workspaceId, EMAIL_ID()]);
    await c.query("INSERT INTO messages_sent (appointment_id, channel, kind, to_value, body, provider_id, workspace_id) VALUES ($1, 'sms', 'update', '+15555550100', 'b', 'SM0123', $2)", [appt, ws.workspaceId]);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM messages_sent WHERE appointment_id = $1", [appt])).rows[0].n, 2);
  });
});

describe("Claiming and finishing a send", { skip: SKIP }, () => {
  test("an issued invoice: one attempt row in Message History, with the stored PDF's fingerprint; finishing records the email id", async () => {
    const ws = await makeWorkspace(c, { employees: 1 });
    const inv = await issued(ws);
    const requestId = randomUUID();
    const cl = await claim(pool, ws, inv.id, { requestId });
    assert.equal(cl.outcome, "claimed", JSON.stringify(cl));
    assert.deepEqual([cl.invoice_number, cl.pdf_sha256], [inv.number, inv.sha]);
    const [row] = await attempts(inv.id);
    assert.deepEqual(
      [row.kind, row.channel, row.to_value, row.subject, row.provider_id, row.send_request_id, row.attachment_sha256, row.workspace_id],
      ["invoice", "email", "pat@example.test", "Invoice SFT-1001 from ACS Cleaning", "sending", requestId, inv.sha, ws.workspaceId]);
    assert.equal(row.appointment_id, (await c.query("SELECT appointment_id FROM invoices WHERE id = $1", [inv.id])).rows[0].appointment_id);
    const emailId = EMAIL_ID();
    assert.deepEqual(await finish(ws, cl.attempt_id, emailId), { outcome: "ok", state: "sent" });
    assert.equal((await attempts(inv.id))[0].provider_id, emailId);
    assert.equal((await finish(ws, cl.attempt_id, "failed")).outcome, "already_finished", "a finished attempt never changes");
  });

  test("issuing an invoice never creates a send attempt", async () => {
    const ws = await makeWorkspace(c, { employees: 1 });
    const inv = await issued(ws);
    assert.equal((await attempts(inv.id)).length, 0);
    assert.equal((await c.query("SELECT count(*)::int AS n FROM messages_sent WHERE workspace_id = $1", [ws.workspaceId])).rows[0].n, 0);
  });

  test("drafts and voided invoices can't be sent", async () => {
    const ws = await makeWorkspace(c, { employees: 1 });
    const d = await draft(ws);
    assert.deepEqual(await claim(pool, ws, d), { outcome: "not_issued", status: "draft" });
    const inv = await issued(ws);
    assert.equal((await fn(pool, "void_invoice", [ws.workspaceId, inv.id, "wrong client"])).outcome, "ok");
    assert.deepEqual(await claim(pool, ws, inv.id), { outcome: "not_issued", status: "void" });
    assert.equal((await c.query("SELECT count(*)::int AS n FROM messages_sent WHERE workspace_id = $1", [ws.workspaceId])).rows[0].n, 0);
  });

  test("the recipient, subject and message are checked: one address, one-line subject, a message", async () => {
    const ws = await makeWorkspace(c, { employees: 1 });
    const inv = await issued(ws);
    for (const to of ["", "pat", "pat@example", "a@b.c, d@e.f", "Pat <pat@example.test>", "pat @example.test"]) {
      assert.deepEqual(await claim(pool, ws, inv.id, { to }), { outcome: "invalid", field: "to" }, to);
    }
    assert.deepEqual(await claim(pool, ws, inv.id, { subject: "Invoice\nBcc: x@y.z" }), { outcome: "invalid", field: "subject" });
    assert.deepEqual(await claim(pool, ws, inv.id, { subject: "  " }), { outcome: "invalid", field: "subject" });
    assert.deepEqual(await claim(pool, ws, inv.id, { body: " " }), { outcome: "invalid", field: "body" });
    assert.equal((await attempts(inv.id)).length, 0);
  });

  test("finishing accepts only an email id, 'failed', 'unconfirmed' or 'disabled'", async () => {
    const ws = await makeWorkspace(c, { employees: 1 });
    const inv = await issued(ws);
    const cl = await claim(pool, ws, inv.id);
    for (const bad of ["resend", "", "sent", "SM123"]) assert.equal((await finish(ws, cl.attempt_id, bad)).outcome, "invalid", bad);
    assert.equal((await attempts(inv.id))[0].provider_id, "sending");
  });
});

describe("Double-clicks, retries and earlier sends", { skip: SKIP }, () => {
  test("the same request again (double-click / retry) returns the same attempt -- never a second row", async () => {
    const ws = await makeWorkspace(c, { employees: 1 });
    const inv = await issued(ws);
    const requestId = randomUUID();
    const first = await claim(pool, ws, inv.id, { requestId });
    const again = await claim(pool, ws, inv.id, { requestId });
    assert.deepEqual([again.outcome, again.attempt_id, again.state], ["replay", first.attempt_id, "sending"]);
    await finish(ws, first.attempt_id, EMAIL_ID());
    const later = await claim(pool, ws, inv.id, { requestId });
    assert.deepEqual([later.outcome, later.state], ["replay", "sent"]);
    assert.equal((await attempts(inv.id)).length, 1);
  });

  test("20 simultaneous sends with one request id: exactly one attempt", async () => {
    const ws = await makeWorkspace(c, { employees: 1 });
    const inv = await issued(ws);
    const requestId = randomUUID();
    const outs = await Promise.all(Array.from({ length: 20 }, () => claim(pool, ws, inv.id, { requestId })));
    assert.equal(outs.filter((o) => o.outcome === "claimed").length, 1);
    assert.ok(outs.every((o) => o.outcome === "claimed" || o.outcome === "replay"));
    assert.equal((await attempts(inv.id)).length, 1);
  });

  test("20 simultaneous sends with different request ids (two tabs): one is sent, the rest see it in progress", async () => {
    const ws = await makeWorkspace(c, { employees: 1 });
    const inv = await issued(ws);
    const outs = await Promise.all(Array.from({ length: 20 }, () => claim(pool, ws, inv.id)));
    assert.equal(outs.filter((o) => o.outcome === "claimed").length, 1);
    assert.equal(outs.filter((o) => o.outcome === "in_progress").length, 19);
    assert.equal((await attempts(inv.id)).length, 1);
  });

  test("after a send went out, sending again needs that attempt acknowledged by its id", async () => {
    const ws = await makeWorkspace(c, { employees: 1 });
    const inv = await issued(ws);
    const first = await claim(pool, ws, inv.id);
    await finish(ws, first.attempt_id, EMAIL_ID());
    const blocked = await claim(pool, ws, inv.id);
    assert.deepEqual([blocked.outcome, blocked.attempt_id, blocked.state, blocked.to], ["needs_acknowledgement", first.attempt_id, "sent", "pat@example.test"]);
    assert.equal((await claim(pool, ws, inv.id, { ack: randomUUID() })).outcome, "needs_acknowledgement", "acknowledging another attempt doesn't count");
    const second = await claim(pool, ws, inv.id, { ack: first.attempt_id });
    assert.equal(second.outcome, "claimed");
    await finish(ws, second.attempt_id, EMAIL_ID());
    const third = await claim(pool, ws, inv.id, { ack: first.attempt_id });
    assert.deepEqual([third.outcome, third.attempt_id], ["needs_acknowledgement", second.attempt_id], "the newest send is the one to acknowledge");
  });

  test("after a confirmed failure (or sending switched off), the owner can simply try again", async () => {
    const ws = await makeWorkspace(c, { employees: 1 });
    const inv = await issued(ws);
    const a = await claim(pool, ws, inv.id);
    await finish(ws, a.attempt_id, "failed");
    const b = await claim(pool, ws, inv.id);
    assert.equal(b.outcome, "claimed");
    await finish(ws, b.attempt_id, "disabled");
    assert.equal((await claim(pool, ws, inv.id)).outcome, "claimed");
  });

  test("an unknown outcome must be acknowledged before an intentional resend; a fresh in-flight send can't be overridden", async () => {
    const ws = await makeWorkspace(c, { employees: 1 });
    const inv = await issued(ws);
    const a = await claim(pool, ws, inv.id);
    await finish(ws, a.attempt_id, "unconfirmed");
    const blocked = await claim(pool, ws, inv.id);
    assert.deepEqual([blocked.outcome, blocked.state, blocked.attempt_id], ["needs_acknowledgement", "uncertain", a.attempt_id]);
    const b = await claim(pool, ws, inv.id, { ack: a.attempt_id });
    assert.equal(b.outcome, "claimed");
    // b is in flight: nobody can start another, acknowledged or not.
    assert.equal((await claim(pool, ws, inv.id, { ack: b.attempt_id })).outcome, "in_progress");
    assert.equal((await claim(pool, ws, inv.id, { ack: a.attempt_id })).outcome, "in_progress");
  });

  test("a send stuck in flight for 2+ minutes (server stopped mid-send) reads as an unknown outcome; acknowledging it marks it so", async () => {
    const ws = await makeWorkspace(c, { employees: 1 });
    const inv = await issued(ws);
    const a = await claim(pool, ws, inv.id);
    await c.query("UPDATE messages_sent SET created_at = now() - interval '3 minutes' WHERE id = $1", [a.attempt_id]);
    const blocked = await claim(pool, ws, inv.id);
    assert.deepEqual([blocked.outcome, blocked.state], ["needs_acknowledgement", "uncertain"]);
    const b = await claim(pool, ws, inv.id, { ack: a.attempt_id });
    assert.equal(b.outcome, "claimed");
    const rows = await attempts(inv.id);
    assert.deepEqual(rows.map((r) => r.provider_id), ["unconfirmed", "sending"]);
    // A late answer for the stuck attempt is still recorded.
    const late = EMAIL_ID();
    assert.equal((await finish(ws, a.attempt_id, late)).outcome, "ok");
    assert.equal((await attempts(inv.id))[0].provider_id, late);
  });

  test("voiding waits for a send being claimed (same invoice lock), and a voided invoice can't be claimed after", async () => {
    const ws = await makeWorkspace(c, { employees: 1 });
    const inv = await issued(ws);
    const a = await db.connect();
    const b = await db.connect();
    const bPid = await backendPid(b);
    try {
      await a.query("BEGIN");
      assert.equal((await claim(a, ws, inv.id)).outcome, "claimed");
      const pending = track(fn(b, "void_invoice", [ws.workspaceId, inv.id, "typo"]));
      await waitUntilBlocked(c, bPid);
      await a.query("COMMIT");
      assert.equal((await pending.result).outcome, "ok");
    } finally {
      await a.end();
      await b.end();
    }
    assert.deepEqual(await claim(pool, ws, inv.id), { outcome: "not_issued", status: "void" });
  });
});

describe("Workspace isolation and access", { skip: SKIP }, () => {
  test("another workspace can't claim, replay or finish an invoice's send; the database refuses a cross-workspace link", async () => {
    const ws1 = await makeWorkspace(c, { employees: 1 });
    const ws2 = await makeWorkspace(c, { employees: 1 });
    const inv = await issued(ws1);
    const requestId = randomUUID();
    assert.deepEqual(await claim(pool, ws2, inv.id), { outcome: "not_found" });
    const mine = await claim(pool, ws1, inv.id, { requestId });
    assert.deepEqual(await claim(pool, ws2, inv.id, { requestId }), { outcome: "not_found" });
    assert.equal((await finish(ws2, mine.attempt_id, EMAIL_ID())).outcome, "not_found");
    assert.equal((await attempts(inv.id))[0].provider_id, "sending");
    const appt2 = await completedJob(ws2);
    await assert.rejects(
      c.query(`INSERT INTO messages_sent (appointment_id, channel, kind, to_value, body, provider_id, workspace_id, invoice_id, send_request_id, attachment_sha256)
               VALUES ($1, 'email', 'invoice', 'x@example.test', 'b', 'failed', $2, $3, $4, $5)`, [appt2, ws2.workspaceId, inv.id, randomUUID(), inv.sha]),
      /messages_sent_invoice_fkey/);
  });

  test("only the service role can run the functions", async () => {
    const { rows } = await c.query(`
      SELECT p.proname, r AS role, has_function_privilege(r, p.oid, 'EXECUTE') AS can
      FROM pg_proc p, unnest(ARRAY['anon', 'authenticated', 'service_role']) r
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('claim_invoice_send', 'finish_invoice_send', 'invoice_send_state')`);
    assert.equal(rows.length, 9);
    assert.deepEqual(rows.filter((x) => x.can !== (x.role === "service_role")), []);
  });

  test("the app reads each attempt's state exactly as the database does", async () => {
    const cases: [string | null, string][] = [
      ["sending", "now()"], ["sending", "now() - interval '119 seconds'"], ["sending", "now() - interval '3 minutes'"],
      ["unconfirmed", "now()"], ["failed", "now()"], ["disabled", "now()"], [randomUUID(), "now()"], ["resend", "now()"], [null, "now()"],
    ];
    for (const [providerId, at] of cases) {
      const r = (await c.query(`SELECT invoice_send_state($1, ${at}) AS s, (${at})::text AS t, now()::text AS n`, [providerId])).rows[0];
      assert.equal(invoiceSendState(providerId, new Date(r.t).toISOString(), new Date(r.n).getTime()), r.s, `${providerId} @ ${at}`);
    }
  });
});
