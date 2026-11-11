// Scheduling issues reported 2026-11-11, tested against a REAL PostgreSQL built
// from the exported production schema plus migrations 029-041. The real
// update route, dashboard loader and replenishment pass run unchanged; only
// @/lib/supabaseAdmin is swapped for test-db/postgrestAdapter.ts (PostgREST
// response shapes, including "HH:mm:ss" times and the 1000-row cap).
//
//   1. "This & future" must reach every later occurrence of the series AND
//      the occurrences generated afterwards, while earlier visits, cancelled
//      occurrences and their skipped times stay as they are.
//   2. The time the owner enters is the time that is stored and shown after a
//      reload -- never shifted a second time.
//   3. Recurring series keep producing visits across the Dec -> Jan boundary.
//
// All data is fictional and dated 2030-31 so every visit stays in the future.
// Requires TEST_DB_SCHEMA_FILE (the gitignored production schema export).
//
//   TEST_DB_SCHEMA_FILE=test-db/production-schema.sql npm run test:db:scheduling
/* eslint-disable @typescript-eslint/no-explicit-any -- test-only: rows and
   rendered React props are inspected dynamically against the database. */
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { startTestDb, type TestDb } from "./harness.ts";
import { createPostgrestAdapter, POSTGREST_TYPES } from "./postgrestAdapter.ts";

register("./tsx-mock-load-hook.mjs", import.meta.url);

process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaFile = process.env.TEST_DB_SCHEMA_FILE ? path.resolve(ROOT, process.env.TEST_DB_SCHEMA_FILE) : "";
const SKIP = !schemaFile || !existsSync(schemaFile) ? "TEST_DB_SCHEMA_FILE (production schema export) not provided" : false;

const TZ = "America/New_York";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
let currentClient: any = null;
mock.module("@/lib/supabaseAdmin", {
  namedExports: {
    supabaseAdmin: {
      from: (t: string) => currentClient.from(t),
      rpc: (fn: string, args?: Record<string, unknown>) => currentClient.rpc(fn, args),
    },
  },
});
let sessionWorkspace = "";
const { fakeSessionNamedExports } = await import("../lib/testSupport.ts");
mock.module("@/lib/session", {
  namedExports: fakeSessionNamedExports(async () => ({ role: "owner", workspaceId: sessionWorkspace, authUserId: "owner-1" })),
});
mock.module("@/lib/sessionEpoch", { namedExports: { requireCurrentOwnerSession: async () => ({ ok: true }) } });
const { resolveEntitlement } = await import("../lib/entitlement.ts");
const INTERNAL = resolveEntitlement(
  { billingMode: "internal", stripeStatus: null, trialEnd: null, currentPeriodEnd: null, graceUntil: null, cancelAtPeriodEnd: false, canceledAt: null, accessEndedAt: null, trialConsumedAt: null, hasStripeIdentity: false },
  new Date()
);
const RESTRICTED = resolveEntitlement(
  { billingMode: "stripe", stripeStatus: "canceled", trialEnd: null, currentPeriodEnd: null, graceUntil: null, cancelAtPeriodEnd: false, canceledAt: new Date(Date.now() - 5 * 86400000), accessEndedAt: null, trialConsumedAt: new Date(Date.now() - 60 * 86400000), hasStripeIdentity: true },
  new Date()
);
mock.module("@/lib/entitlementServer", {
  namedExports: {
    fetchEntitlementForWorkspace: async () => INTERNAL,
    requireCapability: async () => ({ allowed: true }),
    requireCapabilityForWorkspace: async () => ({ allowed: true }),
  },
});
// No message is ever sent by these tests (notify_channel is always "none");
// the real module would construct provider clients at load time.
const sent: unknown[] = [];
mock.module("@/lib/notify", {
  namedExports: {
    NotifyChannel: undefined,
    shouldSend: () => false,
    describeProviderError: (e: unknown) => String(e),
    recordMessageSent: async (m: unknown) => { sent.push(m); },
    getCompanyIdentity: async () => ({ companyName: "Fictional Cleaning Co", timezone: TZ }),
    sendEmail: async (...a: unknown[]) => { sent.push(a); return "x"; },
    sendSms: async (...a: unknown[]) => { sent.push(a); return "x"; },
  },
});
function ShellStub() {
  return null;
}
mock.module("@/app/components/dashboard/DashboardShell", { defaultExport: ShellStub });
for (const name of ["LockedReactivationScreen", "TemporaryUnavailableScreen", "TrialActivationScreen"]) {
  mock.module(`@/app/components/dashboard/${name}`, { defaultExport: () => null });
}
mock.module("next/navigation", { namedExports: { redirect: () => { throw new Error("redirect"); } } });

const { PATCH } = await import("../app/api/appointments/update/route.ts");
const { default: DashboardPage } = await import("../app/dashboard/page.tsx");
const { runReplenishmentPass } = await import("../lib/recurringSeriesReplenishmentOrchestrator.ts");
const { zonedDateTimeToUTC, zonedTimeValue, zonedDateValue } = await import("../lib/timezone.ts");

let db: TestDb;
let pool: pg.Pool;
let c: pg.Client;

before(async () => {
  if (SKIP) return;
  db = await startTestDb({
    migrations: [
      "029_add_atomic_recurrence_change.sql",
      "030_add_work_recording_locking_protocol.sql",
      "031_add_owner_worked_time_override.sql",
      "032_create_completed_job_billing.sql",
      "033_completed_job_billing_invoice_per_client.sql",
      "034_completed_job_billing_finalize_invoice_per_client.sql",
      "035_reset_reminder_on_recurrence_change.sql",
      "036_reminder_claim_protocol.sql",
      "037_messages_sent_occurrence_snapshot.sql",
      "038_add_cancellation_correction_fields.sql",
      "039_preserve_cancelled_occurrence_exclusion.sql",
      "040_add_messages_sent_subject.sql",
      "041_block_early_job_start.sql",
      "042_add_demo_sessions.sql",
      "043_guest_control_permissions.sql",
      "044_shared_session_view.sql",
      "045_owner_sign_in_security.sql",
      "046_session_chat.sql",
      "047_atomic_future_edit.sql",
    ],
  });
  c = await db.connect();
  pool = new pg.Pool({ host: "127.0.0.1", port: db.port, user: "postgres", password: "test", database: "postgres", max: 8, types: POSTGREST_TYPES as any });
  pool.on("connect", (client) => client.query("SET TIME ZONE 'UTC'"));
  currentClient = createPostgrestAdapter(pool).client;
});
after(async () => {
  if (SKIP) return;
  await pool.end();
  await c.end();
  await db.stop();
});

// ---------------------------------------------------------------------------
// Fixtures: one fictional business, one client, one recurring series every
// `everyWeeks` weeks at `time` local for `minutes`, from `first` through
// `last` (local dates). The series is active (confirmed by the owner), with a
// complete snapshot, and every visit has the one employee assigned.
// ---------------------------------------------------------------------------
type Seeded = { ws: string; client: string; series: string; employee: string; ids: Map<string, string> };

async function seedSeries(opts: { first: string; last: string; time: string; minutes: number; everyWeeks: number; wsId?: string; clientName?: string }): Promise<Seeded> {
  const { rows: [w] } = await c.query(
    `WITH ins AS (INSERT INTO workspaces (id, name) VALUES (COALESCE($1::uuid, gen_random_uuid()), 'Fictional Cleaning Co') ON CONFLICT (id) DO NOTHING RETURNING id)
     SELECT id FROM ins UNION ALL SELECT $1::uuid WHERE NOT EXISTS (SELECT 1 FROM ins)`,
    [opts.wsId ?? null]
  );
  const ws = w.id as string;
  await c.query("INSERT INTO company_settings (workspace_id, timezone) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM company_settings WHERE workspace_id = $1)", [ws, TZ]);
  const { rows: [e] } = await c.query("INSERT INTO employees (id, workspace_id, name) VALUES (gen_random_uuid(), $1, 'Member One') RETURNING id", [ws]);
  const { rows: [cl] } = await c.query("INSERT INTO clients (id, workspace_id, name, status) VALUES (gen_random_uuid(), $1, $2, 'active') RETURNING id", [ws, opts.clientName ?? "Sample Client"]);
  const { rows: [s] } = await c.query(
    `INSERT INTO recurring_series (id, workspace_id, status, client_id, is_demo, frequency_type, repeat_weeks,
        anchor_local_date, anchor_local_time, anchor_timezone, source)
     VALUES (gen_random_uuid(), $1, 'review_required', $2, false, 'weekly', $3, $4::date, $5::time, $6, 'owner_created') RETURNING id`,
    [ws, cl.id, opts.everyWeeks, opts.first, opts.time, TZ]
  );
  const { rows } = await c.query(
    `INSERT INTO appointments (id, workspace_id, client_id, service_type, scheduled_for, scheduled_end, duration_minutes,
        status, cancel_token, series_id, frequency_type, repeat_weeks, price_cents, is_demo, employee_id)
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'Regular Cleaning', slot, slot + make_interval(mins => $3::int), $3::int,
            'scheduled', md5(random()::text), $4::uuid, 'weekly', $5::int, 16000, false, $9::uuid
     FROM (SELECT (d::date + $6::time) AT TIME ZONE $7::text AS slot
           FROM generate_series($8::date, $10::date, make_interval(days => 7 * $5::int)) d) g
     RETURNING id, to_char(scheduled_for AT TIME ZONE $7::text, 'YYYY-MM-DD') AS d`,
    [ws, cl.id, opts.minutes, s.id, opts.everyWeeks, opts.time, TZ, opts.first, e.id, opts.last]
  );
  await c.query("INSERT INTO appointment_employees (appointment_id, employee_id, workspace_id) SELECT id, $2, $1 FROM appointments WHERE series_id = $3", [ws, e.id, s.id]);
  await c.query(
    `UPDATE recurring_series SET status = 'active', snapshot_service_type = 'Regular Cleaning', snapshot_duration_minutes = $2,
        snapshot_price_cents = 16000, snapshot_employee_ids = ARRAY[$3::uuid], snapshot_updated_at = now(), reviewed_at = now(),
        review_reason = NULL,
        template_appointment_id = (SELECT id FROM appointments a WHERE a.series_id = $1 ORDER BY scheduled_for LIMIT 1)
     WHERE id = $1`,
    [s.id, opts.minutes, e.id]
  );
  return { ws, client: cl.id, series: s.id, employee: e.id, ids: new Map(rows.map((r) => [r.d, r.id])) };
}

async function seriesRows(seriesId: string): Promise<string[]> {
  const { rows } = await c.query(
    `SELECT to_char(scheduled_for AT TIME ZONE $2, 'Dy YYYY-MM-DD HH24:MI') || '-' || to_char(scheduled_end AT TIME ZONE $2, 'HH24:MI') || ' ' || status AS v
     FROM appointments WHERE series_id = $1 ORDER BY scheduled_for`,
    [seriesId, TZ]
  );
  return rows.map((r) => r.v);
}

// Exactly what the edit form sends: the date and times as entered, converted
// in the business's timezone (AppointmentModal.executeCoordinatedSave).
function formPayload(date: string, timeIn: string, timeOut: string) {
  const start = zonedDateTimeToUTC(date, timeIn, TZ);
  const end = zonedDateTimeToUTC(date, timeOut, TZ);
  assert.ok(start.ok && end.ok);
  return { scheduled_for: start.iso, scheduled_end: end.iso };
}

async function save(ws: string, body: Record<string, unknown>) {
  sessionWorkspace = ws;
  const res = await PATCH(new Request("http://localhost/api/appointments/update", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notify_channel: "none", ...body }),
  }));
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------
describe("Issue 2: the time the owner enters is the time stored and shown after a reload", { skip: SKIP }, () => {
  // Every other Tuesday 8:00-9:15, Nov 12 2030 is one visit of the series.
  const opts = { first: "2030-10-29", last: "2030-12-24", time: "08:00", minutes: 75, everyWeeks: 2 };

  test("This & future, moved one hour later (8:00 -> 9:00): the moved visit is at 9:00, not 10:00, and so is every later visit", async () => {
    const s = await seedSeries(opts);
    const anchor = s.ids.get("2030-11-12")!;
    const r = await save(s.ws, { appointment_id: anchor, mode: "future", ...formPayload("2030-11-12", "09:00", "10:15") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await seriesRows(s.series), [
      "Tue 2030-10-29 08:00-09:15 scheduled", // earlier visit untouched
      "Tue 2030-11-12 09:00-10:15 scheduled", // exactly what was entered
      "Tue 2030-11-26 09:00-10:15 scheduled",
      "Tue 2030-12-10 09:00-10:15 scheduled",
      "Tue 2030-12-24 09:00-10:15 scheduled",
    ]);

    // After a reload: the calendar and the edit form read 9:00-10:15.
    sessionWorkspace = s.ws;
    const page: any = await DashboardPage();
    assert.equal(page.type, ShellStub);
    const shown = page.props.appointments.find((a: any) => a.id === anchor);
    assert.equal(zonedDateValue(shown.scheduled_for, page.props.timezone), "2030-11-12");
    assert.equal(zonedTimeValue(shown.scheduled_for, page.props.timezone), "09:00");
    assert.equal(zonedTimeValue(shown.scheduled_end, page.props.timezone), "10:15");
    assert.equal(shown.duration_minutes, 75);
  });

  test("This & future with a new start AND a longer visit (8:00-9:15 -> 8:45-10:30): every visit from that one on is 8:45-10:30", async () => {
    const s = await seedSeries(opts);
    const r = await save(s.ws, { appointment_id: s.ids.get("2030-11-12")!, mode: "future", duration_minutes: 105, ...formPayload("2030-11-12", "08:45", "10:30") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await seriesRows(s.series), [
      "Tue 2030-10-29 08:00-09:15 scheduled",
      "Tue 2030-11-12 08:45-10:30 scheduled",
      "Tue 2030-11-26 08:45-10:30 scheduled",
      "Tue 2030-12-10 08:45-10:30 scheduled",
      "Tue 2030-12-24 08:45-10:30 scheduled",
    ]);
  });

  test("This & future, moved to a later day (Tue 8:00 -> Thu 9:00): the moved visit lands on Thursday 9:00 once", async () => {
    const s = await seedSeries(opts);
    const r = await save(s.ws, { appointment_id: s.ids.get("2030-11-12")!, mode: "future", ...formPayload("2030-11-14", "09:00", "10:15") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await seriesRows(s.series), [
      "Tue 2030-10-29 08:00-09:15 scheduled",
      "Thu 2030-11-14 09:00-10:15 scheduled",
      "Thu 2030-11-28 09:00-10:15 scheduled",
      "Thu 2030-12-12 09:00-10:15 scheduled",
      "Thu 2030-12-26 09:00-10:15 scheduled",
    ]);
  });

  test("This & future, moved earlier (8:00 -> 7:30): unchanged behavior, every visit from that one on is 7:30", async () => {
    const s = await seedSeries(opts);
    const r = await save(s.ws, { appointment_id: s.ids.get("2030-11-12")!, mode: "future", ...formPayload("2030-11-12", "07:30", "08:45") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual((await seriesRows(s.series)).slice(1), [
      "Tue 2030-11-12 07:30-08:45 scheduled",
      "Tue 2030-11-26 07:30-08:45 scheduled",
      "Tue 2030-12-10 07:30-08:45 scheduled",
      "Tue 2030-12-24 07:30-08:45 scheduled",
    ]);
  });

  test("Only this appointment, moved later (8:00 -> 9:00): just that visit, at 9:00", async () => {
    const s = await seedSeries(opts);
    const r = await save(s.ws, { appointment_id: s.ids.get("2030-11-12")!, mode: "single", ...formPayload("2030-11-12", "09:00", "10:15") });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await seriesRows(s.series), [
      "Tue 2030-10-29 08:00-09:15 scheduled",
      "Tue 2030-11-12 09:00-10:15 scheduled",
      "Tue 2030-11-26 08:00-09:15 scheduled",
      "Tue 2030-12-10 08:00-09:15 scheduled",
      "Tue 2030-12-24 08:00-09:15 scheduled",
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("Issue 1: This & future reaches every later visit and the visits generated afterwards; exceptions stay", { skip: SKIP }, () => {
  let s: Seeded;
  let saved: { status: number; body: any };
  const reminderAt = "2030-12-09T13:00:00.000Z";

  before(async () => {
    if (SKIP) return;
    // Every other Tuesday 8:00-9:15 from Oct 1 through Dec 10 (the generated
    // tail ends there). Oct 1 - Oct 29 are visits BEFORE the one the owner
    // edits; Nov 26 was cancelled by the owner (its time is recorded as
    // skipped, as the cancel route does); Dec 10 already holds a reminder.
    s = await seedSeries({ first: "2030-10-01", last: "2030-12-10", time: "08:00", minutes: 75, everyWeeks: 2 });
    const cancelled = s.ids.get("2030-11-26")!;
    await c.query("UPDATE appointments SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [cancelled]);
    await c.query(
      "UPDATE recurring_series SET excluded_occurrences = ARRAY[(SELECT scheduled_for FROM appointments WHERE id = $2)] WHERE id = $1",
      [s.series, cancelled]
    );
    await c.query(
      "UPDATE appointments SET reminder_24h_sent_at = $2, reminder_24h_claimed_at = $2, reminder_24h_claim_token = gen_random_uuid() WHERE id = $1",
      [s.ids.get("2030-12-10")!, reminderAt]
    );
    saved = await save(s.ws, { appointment_id: s.ids.get("2030-11-12")!, mode: "future", ...formPayload("2030-11-12", "09:00", "10:15") });
  });

  test("the save succeeds with no review warning", () => {
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body, { ok: true });
  });

  test("earlier visits keep their time; the edited and every later scheduled visit move to 9:00; the cancelled visit is untouched", async () => {
    assert.deepEqual(await seriesRows(s.series), [
      "Tue 2030-10-01 08:00-09:15 scheduled",
      "Tue 2030-10-15 08:00-09:15 scheduled",
      "Tue 2030-10-29 08:00-09:15 scheduled",
      "Tue 2030-11-12 09:00-10:15 scheduled",
      "Tue 2030-11-26 08:00-09:15 cancelled",
      "Tue 2030-12-10 09:00-10:15 scheduled",
    ]);
  });

  test("a moved visit's old reminder is cleared so it is reminded for the new time only", async () => {
    const { rows: [r] } = await c.query(
      "SELECT reminder_24h_sent_at, reminder_24h_claimed_at, reminder_24h_claim_token FROM appointments WHERE id = $1",
      [s.ids.get("2030-12-10")!]
    );
    assert.deepEqual(r, { reminder_24h_sent_at: null, reminder_24h_claimed_at: null, reminder_24h_claim_token: null });
  });

  test("the series stays confirmed and now carries the new time, from the edited visit", async () => {
    const { rows: [r] } = await c.query(
      "SELECT status, to_char(anchor_local_time, 'HH24:MI') AS t, anchor_local_date::text AS d, template_appointment_id FROM recurring_series WHERE id = $1",
      [s.series]
    );
    assert.deepEqual(r, { status: "active", t: "09:00", d: "2030-11-12", template_appointment_id: s.ids.get("2030-11-12")! });
  });

  test("visits generated afterwards (Dec -> Jan) are at 9:00-10:15, every other Tuesday, with the series' employee; the cancelled date is not recreated", async () => {
    const run = (now: Date) =>
      runReplenishmentPass({ dryRun: false, now: () => now, fetchEntitlement: async (ws) => (ws === s.ws ? INTERNAL : RESTRICTED) });
    const summary = await run(new Date("2030-12-01T12:00:00.000Z"));
    assert.equal(summary.counts.replenished, 1, JSON.stringify(summary.counts));
    const after1 = await seriesRows(s.series);
    assert.deepEqual(after1.slice(5, 9), [
      "Tue 2030-12-10 09:00-10:15 scheduled",
      "Tue 2030-12-24 09:00-10:15 scheduled",
      "Tue 2031-01-07 09:00-10:15 scheduled",
      "Tue 2031-01-21 09:00-10:15 scheduled",
    ]);
    // Rolling 26 weeks from Dec 1: every other Tuesday through May 27, all at 9:00-10:15.
    assert.equal(after1.at(-1), "Tue 2031-05-27 09:00-10:15 scheduled");
    assert.ok(after1.slice(5).every((r) => r.includes(" 09:00-10:15 scheduled")));
    const { rows: staff } = await c.query(
      "SELECT DISTINCT ae.employee_id FROM appointments a JOIN appointment_employees ae ON ae.appointment_id = a.id WHERE a.series_id = $1 AND a.scheduled_for > '2030-12-11'",
      [s.series]
    );
    assert.deepEqual(staff.map((x) => x.employee_id), [s.employee]);
    // A second run the same day adds nothing and never duplicates a date.
    const again = await run(new Date("2030-12-01T12:00:00.000Z"));
    assert.equal(again.counts.occurrencesInserted, 0);
    const { rows: dup } = await c.query(
      "SELECT (scheduled_for AT TIME ZONE $2)::date d FROM appointments WHERE series_id = $1 GROUP BY 1 HAVING count(*) > 1",
      [s.series, TZ]
    );
    assert.deepEqual(dup, []);
  });
});

// ---------------------------------------------------------------------------
describe("Issue 1: a visit whose cleaner is no longer active can still be moved, and the change reaches every later visit", { skip: SKIP }, () => {
  const opts = { first: "2030-10-29", last: "2030-12-24", time: "08:00", minutes: 75, everyWeeks: 2 };

  test("edit form (which always resends the assigned staff) + This & future: saved once, every later visit moves, nothing reported as failed", async () => {
    const s = await seedSeries(opts);
    await c.query("UPDATE employees SET active = false WHERE id = $1", [s.employee]);
    const r = await save(s.ws, {
      appointment_id: s.ids.get("2030-11-12")!, mode: "future", duration_minutes: 105,
      employee_ids: [s.employee], ...formPayload("2030-11-12", "08:45", "10:30"),
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await seriesRows(s.series), [
      "Tue 2030-10-29 08:00-09:15 scheduled",
      "Tue 2030-11-12 08:45-10:30 scheduled",
      "Tue 2030-11-26 08:45-10:30 scheduled",
      "Tue 2030-12-10 08:45-10:30 scheduled",
      "Tue 2030-12-24 08:45-10:30 scheduled",
    ]);
    // The (inactive) cleaner stays on every visit -- nothing about staff changed.
    const { rows } = await c.query(
      "SELECT count(*)::int AS n FROM appointment_employees ae JOIN appointments a ON a.id = ae.appointment_id WHERE a.series_id = $1 AND ae.employee_id = $2",
      [s.series, s.employee]
    );
    assert.equal(rows[0].n, 5);
  });

  test("ADDING an employee who is no longer active is refused before anything is saved", async () => {
    const s = await seedSeries(opts);
    const { rows: [gone] } = await c.query("INSERT INTO employees (id, workspace_id, name, active) VALUES (gen_random_uuid(), $1, 'Former Member', false) RETURNING id", [s.ws]);
    const before1 = await seriesRows(s.series);
    const r = await save(s.ws, {
      appointment_id: s.ids.get("2030-11-12")!, mode: "future",
      employee_ids: [s.employee, gone.id], ...formPayload("2030-11-12", "09:00", "10:15"),
    });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /no longer active/);
    assert.deepEqual(await seriesRows(s.series), before1, "nothing was saved");
    const { rows: [st] } = await c.query("SELECT status FROM recurring_series WHERE id = $1", [s.series]);
    assert.equal(st.status, "active", "the series was not put on hold");
  });
});

// ---------------------------------------------------------------------------
describe("Issue 3: an untouched recurring series keeps producing visits across Dec -> Jan", { skip: SKIP }, () => {
  test("weekly Wednesday 13:30 series ending Dec 18 is topped up into January at 13:30 local, skipping a cancelled date", async () => {
    const s = await seedSeries({ first: "2030-11-06", last: "2030-12-18", time: "13:30", minutes: 120, everyWeeks: 1 });
    // The owner cancelled Dec 25 in advance: recorded as skipped on the series.
    await c.query("UPDATE recurring_series SET excluded_occurrences = ARRAY[timestamptz '2030-12-25 13:30 America/New_York'] WHERE id = $1", [s.series]);
    const summary = await runReplenishmentPass({
      dryRun: false,
      now: () => new Date("2030-12-05T12:00:00.000Z"),
      fetchEntitlement: async (ws) => (ws === s.ws ? INTERNAL : RESTRICTED),
    });
    assert.equal(summary.counts.replenished, 1, JSON.stringify(summary.counts));
    const rows = await seriesRows(s.series);
    assert.deepEqual(rows.filter((r) => r >= "Wed 2030-12-18" && r < "Wed 2031-02"), [
      "Wed 2030-12-18 13:30-15:30 scheduled",
      "Wed 2031-01-01 13:30-15:30 scheduled",
      "Wed 2031-01-08 13:30-15:30 scheduled",
      "Wed 2031-01-15 13:30-15:30 scheduled",
      "Wed 2031-01-22 13:30-15:30 scheduled",
      "Wed 2031-01-29 13:30-15:30 scheduled",
    ]);
    assert.ok(!rows.some((r) => r.includes("2030-12-25")), "the cancelled date is never recreated");
  });
});

// ---------------------------------------------------------------------------
// Faults are injected INSIDE the database (test-only triggers), after the
// first write of the save has already happened, so the test does not depend
// on how the route issues its writes.
describe("This & future is all-or-nothing: a failure after the first write leaves nothing changed, and a retry applies exactly once", { skip: SKIP }, () => {
  const opts = { first: "2030-10-29", last: "2030-12-24", time: "08:00", minutes: 75, everyWeeks: 2 };

  before(async () => {
    if (SKIP) return;
    await c.query(`
      CREATE TABLE IF NOT EXISTS test_fault (target uuid NOT NULL, tbl text NOT NULL);
      CREATE OR REPLACE FUNCTION test_fault_raise() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM test_fault WHERE target = NEW.id AND tbl = TG_TABLE_NAME) THEN
          RAISE EXCEPTION 'injected test fault on %', TG_TABLE_NAME;
        END IF;
        RETURN NEW;
      END $$;
      CREATE OR REPLACE FUNCTION test_fault_raise_ae() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM test_fault WHERE target = NEW.appointment_id AND tbl = TG_TABLE_NAME) THEN
          RAISE EXCEPTION 'injected test fault on %', TG_TABLE_NAME;
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS test_fault_appt ON appointments;
      CREATE TRIGGER test_fault_appt BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION test_fault_raise();
      DROP TRIGGER IF EXISTS test_fault_ae ON appointment_employees;
      CREATE TRIGGER test_fault_ae BEFORE INSERT ON appointment_employees FOR EACH ROW EXECUTE FUNCTION test_fault_raise_ae();
      DROP TRIGGER IF EXISTS test_fault_rs ON recurring_series;
      CREATE TRIGGER test_fault_rs BEFORE UPDATE ON recurring_series FOR EACH ROW EXECUTE FUNCTION test_fault_raise();
    `);
  });
  after(async () => {
    if (SKIP) return;
    await c.query(`
      DROP TRIGGER IF EXISTS test_fault_appt ON appointments;
      DROP TRIGGER IF EXISTS test_fault_ae ON appointment_employees;
      DROP TRIGGER IF EXISTS test_fault_rs ON recurring_series;
      DROP TABLE IF EXISTS test_fault;`);
  });

  async function state(s: Seeded) {
    const appts = await c.query(
      `SELECT id, scheduled_for, scheduled_end, status, duration_minutes, reminder_24h_sent_at, reminder_24h_claimed_at, reminder_24h_claim_token
       FROM appointments WHERE series_id = $1 ORDER BY scheduled_for`, [s.series]);
    const asg = await c.query(
      "SELECT ae.appointment_id, ae.employee_id FROM appointment_employees ae JOIN appointments a ON a.id = ae.appointment_id WHERE a.series_id = $1 ORDER BY 1, 2", [s.series]);
    const series = await c.query(
      "SELECT status, anchor_local_date, anchor_local_time, template_appointment_id, updated_at, excluded_occurrences FROM recurring_series WHERE id = $1", [s.series]);
    return { appts: appts.rows, asg: asg.rows, series: series.rows[0] };
  }

  async function seedWithReminder() {
    const s = await seedSeries(opts);
    // A later visit already holds a reminder: it must neither be cleared by a
    // failed save nor survive a successful move.
    await c.query("UPDATE appointments SET reminder_24h_sent_at = now(), reminder_24h_claimed_at = now(), reminder_24h_claim_token = gen_random_uuid() WHERE id = $1", [s.ids.get("2030-12-10")!]);
    return s;
  }

  for (const [where, target, tbl] of [
    ["a later visit's time change (third write)", (s: Seeded) => s.ids.get("2030-12-10")!, "appointments"],
    ["the last later visit (final appointment write)", (s: Seeded) => s.ids.get("2030-12-24")!, "appointments"],
    ["the series registry update", (s: Seeded) => s.series, "recurring_series"],
  ] as const) {
    test(`fault in ${where}: nothing changed, then a retry moves everything exactly once`, async () => {
      const s = await seedWithReminder();
      const before1 = await state(s);
      await c.query("INSERT INTO test_fault VALUES ($1, $2)", [target(s), tbl]);
      const body = { appointment_id: s.ids.get("2030-11-12")!, mode: "future", ...formPayload("2030-11-12", "09:00", "10:15") };
      const failed = await save(s.ws, body);
      assert.ok(failed.status >= 400, `expected a failure, got ${failed.status}`);
      assert.deepEqual(await state(s), before1, "a failed save must leave every visit, assignment, reminder and the series exactly as they were");

      await c.query("DELETE FROM test_fault");
      const ok = await save(s.ws, body);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual(await seriesRows(s.series), [
        "Tue 2030-10-29 08:00-09:15 scheduled",
        "Tue 2030-11-12 09:00-10:15 scheduled",
        "Tue 2030-11-26 09:00-10:15 scheduled",
        "Tue 2030-12-10 09:00-10:15 scheduled",
        "Tue 2030-12-24 09:00-10:15 scheduled",
      ]);
      const after1 = await state(s);
      const reminded = after1.appts.find((a) => a.id === s.ids.get("2030-12-10"));
      assert.deepEqual([reminded.reminder_24h_sent_at, reminded.reminder_24h_claimed_at, reminded.reminder_24h_claim_token], [null, null, null], "the moved visit's old reminder is gone");
      assert.equal(after1.appts.length, before1.appts.length, "no visit added or lost");
      assert.equal(after1.series.status, "active");

      // The same request again (e.g. a double click after a slow response)
      // changes nothing more: the visit is already where the owner put it.
      const settled = await seriesRows(s.series);
      const again = await save(s.ws, body);
      assert.equal(again.status, 200);
      assert.deepEqual(await seriesRows(s.series), settled);
    });
  }

  test("fault in the staff sync for a later visit (adding a cleaner, with a time change): no visit moved and no cleaner added anywhere", async () => {
    const s = await seedWithReminder();
    const { rows: [helper] } = await c.query("INSERT INTO employees (id, workspace_id, name) VALUES (gen_random_uuid(), $1, 'Member Two') RETURNING id", [s.ws]);
    const before1 = await state(s);
    // Fails only on Dec 10's NEW assignment row -- after every visit's time
    // and the earlier visits' staff were already written.
    await c.query("INSERT INTO test_fault VALUES ($1, 'appointment_employees')", [s.ids.get("2030-12-10")!]);
    const body = { appointment_id: s.ids.get("2030-11-12")!, mode: "future", employee_ids: [s.employee, helper.id], ...formPayload("2030-11-12", "09:00", "10:15") };
    const failed = await save(s.ws, body);
    assert.ok(failed.status >= 400, `expected a failure, got ${failed.status}`);
    assert.deepEqual(await state(s), before1);
    await c.query("DELETE FROM test_fault");
    // Retried: everything applies once -- new time everywhere, both cleaners on every changed visit.
    const ok = await save(s.ws, body);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const after1 = await state(s);
    const moved = after1.appts.filter((a) => a.scheduled_for >= new Date("2030-11-12"));
    assert.equal(moved.length, 4);
    for (const a of moved) {
      assert.equal(zonedTimeValue(a.scheduled_for.toISOString(), TZ), "09:00");
      assert.deepEqual(after1.asg.filter((x) => x.appointment_id === a.id).map((x) => x.employee_id).sort(), [s.employee, helper.id].sort());
    }
  });
});

// ---------------------------------------------------------------------------
describe("apply_future_edit guards (migrations/047): only the server may call it, and a stale plan saves nothing", { skip: SKIP }, () => {
  const SIG = "apply_future_edit(uuid,uuid,timestamptz,jsonb,jsonb,jsonb,jsonb,jsonb)";
  const opts = { first: "2030-10-29", last: "2030-12-24", time: "08:00", minutes: 75, everyWeeks: 2 };

  async function rows(s: Seeded) {
    return (await c.query("SELECT id, scheduled_for, scheduled_end, status, reminder_24h_sent_at FROM appointments WHERE series_id = $1 ORDER BY scheduled_for, id", [s.series])).rows;
  }
  // A plan exactly as the route would build it for "Nov 12 8:00 -> 9:00, This & future".
  async function plan(s: Seeded) {
    const anchor = s.ids.get("2030-11-12")!;
    const { rows: later } = await c.query(
      "SELECT id, scheduled_for, scheduled_end FROM appointments WHERE series_id = $1 AND status = 'scheduled' AND scheduled_for > (SELECT scheduled_for FROM appointments WHERE id = $2) ORDER BY scheduled_for",
      [s.series, anchor]
    );
    const hour = 3_600_000;
    return {
      anchor,
      expected: (await c.query("SELECT scheduled_for FROM appointments WHERE id = $1", [anchor])).rows[0].scheduled_for.toISOString(),
      siblings: later.map((r) => ({
        id: r.id, expected_scheduled_for: r.scheduled_for.toISOString(), expected_scheduled_end: r.scheduled_end.toISOString(),
        scheduled_for: new Date(r.scheduled_for.getTime() + hour).toISOString(), scheduled_end: new Date(r.scheduled_end.getTime() + hour).toISOString(),
      })),
    };
  }
  async function call(s: Seeded, p: Awaited<ReturnType<typeof plan>>) {
    const start = zonedDateTimeToUTC("2030-11-12", "09:00", TZ);
    assert.ok(start.ok);
    const { rows: [r] } = await c.query(
      `SELECT apply_future_edit($1, $2, $3, $4::jsonb, $5::jsonb, '{}'::jsonb, '[]'::jsonb, NULL) AS out`,
      [s.ws, p.anchor, p.expected, JSON.stringify({ scheduled_for: start.iso }), JSON.stringify(p.siblings)]
    );
    return r.out;
  }

  test("anon and authenticated cannot execute it; service_role can", async () => {
    const { rows: [r] } = await c.query(
      `SELECT has_function_privilege('anon', '${SIG}', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', '${SIG}', 'EXECUTE') AS authed,
              has_function_privilege('service_role', '${SIG}', 'EXECUTE') AS service`
    );
    assert.deepEqual(r, { anon: false, authed: false, service: true });
  });

  test("a later visit added after planning (e.g. a concurrent top-up): state_changed, nothing written", async () => {
    const s = await seedSeries(opts);
    const p = await plan(s);
    await c.query(
      `INSERT INTO appointments (id, workspace_id, client_id, service_type, scheduled_for, scheduled_end, duration_minutes, status, cancel_token, series_id, is_demo)
       VALUES (gen_random_uuid(), $1, $2, 'Regular Cleaning', timestamptz '2031-01-07 08:00 America/New_York', timestamptz '2031-01-07 09:15 America/New_York', 75, 'scheduled', md5(random()::text), $3, false)`,
      [s.ws, s.client, s.series]
    );
    const before1 = await rows(s);
    assert.deepEqual(await call(s, p), { outcome: "state_changed" });
    assert.deepEqual(await rows(s), before1);
  });

  test("the edited visit moved by someone else after planning: state_changed, nothing written", async () => {
    const s = await seedSeries(opts);
    const p = await plan(s);
    await c.query("UPDATE appointments SET scheduled_for = scheduled_for + interval '30 minutes' WHERE id = $1", [p.anchor]);
    const before1 = await rows(s);
    assert.deepEqual(await call(s, p), { outcome: "state_changed" });
    assert.deepEqual(await rows(s), before1);
  });

  test("a later visit cancelled after planning: state_changed, nothing written", async () => {
    const s = await seedSeries(opts);
    const p = await plan(s);
    await c.query("UPDATE appointments SET status = 'cancelled' WHERE id = $1", [s.ids.get("2030-12-10")!]);
    const before1 = await rows(s);
    assert.deepEqual(await call(s, p), { outcome: "state_changed" });
    assert.deepEqual(await rows(s), before1);
  });

  test("another workspace's id cannot touch these visits", async () => {
    const s = await seedSeries(opts);
    const other = await seedSeries(opts);
    const p = await plan(s);
    const before1 = await rows(s);
    const start = zonedDateTimeToUTC("2030-11-12", "09:00", TZ);
    assert.ok(start.ok);
    const { rows: [r] } = await c.query(
      `SELECT apply_future_edit($1, $2, $3, $4::jsonb, $5::jsonb, '{}'::jsonb, '[]'::jsonb, NULL) AS out`,
      [other.ws, p.anchor, p.expected, JSON.stringify({ scheduled_for: start.iso }), JSON.stringify(p.siblings)]
    );
    assert.deepEqual(r.out, { outcome: "state_changed" });
    assert.deepEqual(await rows(s), before1);
  });

  test("the current plan applies everything at once", async () => {
    const s = await seedSeries(opts);
    const out = await call(s, await plan(s));
    assert.equal(out.outcome, "applied");
    assert.equal(out.updated_later_count, 3);
    assert.deepEqual((await seriesRows(s.series)).slice(1), [
      "Tue 2030-11-12 09:00-09:15 scheduled", // only the start was in this hand-built plan
      "Tue 2030-11-26 09:00-10:15 scheduled",
      "Tue 2030-12-10 09:00-10:15 scheduled",
      "Tue 2030-12-24 09:00-10:15 scheduled",
    ]);
  });
});

// ---------------------------------------------------------------------------
describe("Rolling 26-week horizon: bounded batches, exceptions kept, holds respected, repeat runs are safe", { skip: SKIP }, () => {
  const NOW = new Date("2030-11-04T12:00:00.000Z"); // a Monday
  const DAY = 86_400_000;
  const horizonEnd = NOW.getTime() + 182 * DAY;
  let weekly: Seeded, daily: Seeded, held: Seeded, stopped: Seeded, cancelledTail: Seeded, movedTail: Seeded;
  let existingBefore: any[];
  const runs: Awaited<ReturnType<typeof runReplenishmentPass>>[] = [];

  // One fictional workspace per series; only these six may be topped up here.
  const mine = () => new Set([weekly, daily, held, stopped, cancelledTail, movedTail].map((x) => x.ws));
  const run = (now: Date) =>
    runReplenishmentPass({ dryRun: false, now: () => now, fetchEntitlement: async (ws) => (mine().has(ws) ? INTERNAL : RESTRICTED) });

  async function allRows(seriesId: string) {
    const { rows } = await c.query(
      `SELECT id, scheduled_for, scheduled_end, status, reminder_24h_sent_at, reminder_24h_claimed_at, reminder_24h_claim_token
       FROM appointments WHERE series_id = $1 ORDER BY scheduled_for`,
      [seriesId]
    );
    return rows;
  }

  before(async () => {
    if (SKIP) return;
    // Weekly Thursday 10:00, live tail 2 weeks out; one visit already reminded.
    weekly = await seedSeries({ first: "2030-10-03", last: "2030-11-14", time: "10:00", minutes: 90, everyWeeks: 1 });
    await c.query("UPDATE appointments SET reminder_24h_sent_at = now(), reminder_24h_claimed_at = now(), reminder_24h_claim_token = gen_random_uuid() WHERE id = $1", [weekly.ids.get("2030-11-07")!]);
    // Daily 7:30, tail tomorrow: needs ~180 visits, at most 20 per run.
    daily = await seedSeries({ first: "2030-11-01", last: "2030-11-05", time: "07:30", minutes: 60, everyWeeks: 1 });
    await c.query("UPDATE recurring_series SET frequency_type = 'daily', repeat_weeks = NULL WHERE id = $1", [daily.series]);
    await c.query(
      `INSERT INTO appointments (id, workspace_id, client_id, service_type, scheduled_for, scheduled_end, duration_minutes, status, cancel_token, series_id, frequency_type, is_demo)
       SELECT gen_random_uuid(), workspace_id, client_id, service_type, scheduled_for + make_interval(days => d), scheduled_end + make_interval(days => d), duration_minutes, 'scheduled', md5(random()::text), series_id, 'daily', false
       FROM appointments a, generate_series(1, 6) d WHERE a.series_id = $1 AND a.scheduled_for = (SELECT min(scheduled_for) FROM appointments WHERE series_id = $1)`,
      [daily.series]
    ); // fill in the daily days the weekly seed skipped (Nov 2-7 -> one per day; tail stays Nov 7 at the latest)
    // Intentional holds: waiting for review (owner never confirmed) and stopped.
    held = await seedSeries({ first: "2030-10-01", last: "2030-11-12", time: "09:00", minutes: 60, everyWeeks: 1 });
    await c.query("UPDATE recurring_series SET status = 'review_required' WHERE id = $1", [held.series]);
    stopped = await seedSeries({ first: "2030-10-01", last: "2030-11-12", time: "09:00", minutes: 60, everyWeeks: 1 });
    await c.query("UPDATE recurring_series SET status = 'stopped', stopped_at = now() WHERE id = $1", [stopped.series]);
    // Final visit cancelled (skip recorded) -- must not come back.
    cancelledTail = await seedSeries({ first: "2030-10-07", last: "2030-11-18", time: "14:00", minutes: 60, everyWeeks: 1 });
    const lastC = cancelledTail.ids.get("2030-11-18")!;
    await c.query("UPDATE appointments SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [lastC]);
    await c.query("UPDATE recurring_series SET excluded_occurrences = ARRAY[(SELECT scheduled_for FROM appointments WHERE id = $2)] WHERE id = $1", [cancelledTail.series, lastC]);
    // Final visit moved two days EARLIER by the owner (skip recorded) -- its
    // original slot must not come back, and the moved visit keeps its time.
    movedTail = await seedSeries({ first: "2030-10-09", last: "2030-11-20", time: "11:00", minutes: 60, everyWeeks: 1 });
    const lastM = movedTail.ids.get("2030-11-20")!;
    await c.query("UPDATE recurring_series SET excluded_occurrences = ARRAY[(SELECT scheduled_for FROM appointments WHERE id = $2)] WHERE id = $1", [movedTail.series, lastM]);
    await c.query("UPDATE appointments SET scheduled_for = scheduled_for - interval '2 days', scheduled_end = scheduled_end - interval '2 days' WHERE id = $1", [lastM]);

    const { rows } = await c.query(
      "SELECT id, scheduled_for, scheduled_end, status, reminder_24h_sent_at, reminder_24h_claimed_at, reminder_24h_claim_token FROM appointments WHERE workspace_id = ANY($1::uuid[]) ORDER BY id",
      [[...mine()]]
    );
    existingBefore = rows;
    // Repeated runs on the same day until nothing is left to add.
    for (let i = 0; i < 12; i++) {
      const r = await run(NOW);
      runs.push(r);
      if (r.counts.occurrencesInserted === 0) break;
    }
  });

  test("every run is bounded: never more than 20 visits for one series", () => {
    for (const r of runs) assert.ok(r.counts.occurrencesInserted <= r.counts.replenished * 20, JSON.stringify(r.counts));
    assert.equal(runs.at(-1)!.counts.occurrencesInserted, 0, "repeated runs converge -- the last one adds nothing");
    assert.ok(runs.length >= 9, "the daily series needs several bounded runs to fill 26 weeks");
  });

  test("weekly: filled exactly to 26 weeks ahead, every Thursday at 10:00, one visit per week, no duplicates", async () => {
    const rows = await seriesRows(weekly.series);
    const future = rows.filter((r) => r > "Thu 2030-11-14");
    assert.ok(future.every((r) => / 10:00-11:30 scheduled$/.test(r)));
    const last = (await allRows(weekly.series)).at(-1)!;
    assert.ok(last.scheduled_for.getTime() <= horizonEnd && last.scheduled_for.getTime() + 7 * DAY > horizonEnd, "ends within one week of the 26-week mark");
    assert.equal(new Set(rows.map((r) => r.slice(4, 14))).size, rows.length, "one visit per date");
  });

  test("daily: filled to 26 weeks in bounded batches, no gaps and no duplicates", async () => {
    const rows = await allRows(daily.series);
    const dates = rows.map((r) => zonedDateValue(r.scheduled_for.toISOString(), TZ));
    assert.equal(new Set(dates).size, dates.length);
    for (let i = 1; i < dates.length; i++) {
      assert.equal(new Date(dates[i] + "T12:00:00Z").getTime() - new Date(dates[i - 1] + "T12:00:00Z").getTime(), DAY, `gap after ${dates[i - 1]}`);
    }
    assert.ok(rows.at(-1)!.scheduled_for.getTime() <= horizonEnd && rows.at(-1)!.scheduled_for.getTime() + DAY > horizonEnd);
    assert.ok(rows.every((r) => zonedTimeValue(r.scheduled_for.toISOString(), TZ) === "07:30"));
  });

  test("held (review_required) and stopped series get nothing", async () => {
    for (const x of [held, stopped]) assert.equal((await allRows(x.series)).length, x.ids.size);
  });

  test("a cancelled final visit stays cancelled and is not recreated; the series continues after it", async () => {
    const rows = await seriesRows(cancelledTail.series);
    assert.deepEqual(rows.filter((r) => r.includes("2030-11-18")), ["Mon 2030-11-18 14:00-15:00 cancelled"]);
    assert.ok(rows.includes("Mon 2030-11-25 14:00-15:00 scheduled"));
  });

  test("a final visit moved earlier keeps its new time and its original slot is not recreated", async () => {
    const rows = await seriesRows(movedTail.series);
    assert.ok(rows.includes("Mon 2030-11-18 11:00-12:00 scheduled"), "the moved visit");
    assert.ok(!rows.some((r) => r.includes("2030-11-20")), "the original Wednesday slot is not recreated");
    assert.ok(rows.includes("Wed 2030-11-27 11:00-12:00 scheduled"), "the series continues the week after");
  });

  test("existing visits are untouched (time, status, reminder state); new visits carry no reminder state, so they are reminded on the normal schedule", async () => {
    const { rows } = await c.query(
      "SELECT id, scheduled_for, scheduled_end, status, reminder_24h_sent_at, reminder_24h_claimed_at, reminder_24h_claim_token FROM appointments WHERE workspace_id = ANY($1::uuid[]) ORDER BY id",
      [[...mine()]]
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const before1 of existingBefore) assert.deepEqual(byId.get(before1.id), before1);
    const known = new Set(existingBefore.map((r) => r.id));
    const added = rows.filter((r) => !known.has(r.id));
    assert.ok(added.length > 200);
    for (const r of added) {
      assert.equal(r.reminder_24h_sent_at, null);
      assert.equal(r.reminder_24h_claimed_at, null);
      assert.equal(r.reminder_24h_claim_token, null);
    }
  });

  test("a week later the window rolls forward by about one visit per weekly series, still with no duplicates", async () => {
    const before1 = (await allRows(weekly.series)).length;
    const r = await run(new Date(NOW.getTime() + 7 * DAY));
    const rows = await allRows(weekly.series);
    assert.equal(rows.length - before1, 1, JSON.stringify(r.counts));
    const { rows: dup } = await c.query(
      "SELECT series_id, scheduled_for FROM appointments WHERE workspace_id = ANY($1::uuid[]) GROUP BY 1, 2 HAVING count(*) > 1",
      [[...mine()]]
    );
    assert.deepEqual(dup, []);
  });
});

// ---------------------------------------------------------------------------
describe("Read-only production diagnosis query (test-db/scheduling-diagnosis.sql): repair candidates for owner review are separated from possible intentional exceptions", { skip: SKIP }, () => {
  test("test-db/scheduling-issues-evidence.sql classifies each fictional case correctly, proposes the right times, and changes nothing", async () => {
    const sqlFile = path.join(ROOT, "test-db", "scheduling-diagnosis.sql");
    const WS = "3c7d1b2b-9d99-4eb5-80d3-5072ecd56d7a";
    const base = { first: "2030-11-05", last: "2030-12-31", minutes: 75, everyWeeks: 2, wsId: WS };
    const shift = (id: string, startMin: number, endMin: number) =>
      c.query("UPDATE appointments SET scheduled_for = scheduled_for + make_interval(mins => $2), scheduled_end = scheduled_end + make_interval(mins => $3) WHERE id = $1", [id, startMin, endMin]);
    const hold = (seriesId: string) => c.query("UPDATE recurring_series SET status = 'review_required' WHERE id = $1", [seriesId]);

    // C1: moved twice. Series at 8:00; "This & future" Nov 12 -> 9:00 moved the
    // later visits to 9:00 and Nov 12 itself to 10:00; series held by the edit.
    const twice = await seedSeries({ ...base, time: "08:00", clientName: "Client One" });
    await shift(twice.ids.get("2030-11-19")!, 120, 120);
    for (const d of ["2030-12-03", "2030-12-17", "2030-12-31"]) await shift(twice.ids.get(d)!, 60, 60);
    await hold(twice.series);

    // C2: not carried. Nov 12 saved at 8:45-10:30, the later visits never
    // moved (cleaner deactivated), series held by the edit.
    const partial = await seedSeries({ ...base, time: "08:00", clientName: "Client Two" });
    await shift(partial.ids.get("2030-11-19")!, 45, 75);
    await hold(partial.series);
    await c.query("UPDATE employees SET active = false WHERE id = $1", [partial.employee]);

    // C3: the owner-reported client (tag DC in this run), not held.
    const reported = await seedSeries({ ...base, time: "10:00", clientName: "Sample Client" });
    await shift(reported.ids.get("2030-11-19")!, 45, 45);

    // X: a one-off move in a confirmed series (could be intentional).
    const oneOff = await seedSeries({ ...base, time: "08:00", clientName: "Client Four" });
    await shift(oneOff.ids.get("2030-12-03")!, 180, 180);

    // Across a clock change the arithmetic proof is not trusted (older visits
    // can carry a fixed-UTC hour): same "moved twice" shape, visit before on
    // Oct 29 (daylight time) -> listed as a POSSIBLE exception, not confirmed.
    const acrossDst = await seedSeries({ first: "2030-10-29", last: "2030-12-24", minutes: 75, everyWeeks: 2, wsId: WS, time: "08:00", clientName: "Client Five" });
    await shift(acrossDst.ids.get("2030-11-12")!, 120, 120);
    for (const d of ["2030-11-26", "2030-12-10", "2030-12-24"]) await shift(acrossDst.ids.get(d)!, 60, 60);

    // C4: a visit weeks away already marked reminded.
    await c.query("UPDATE appointments SET reminder_24h_sent_at = now() WHERE id = $1", [oneOff.ids.get("2030-12-31")!]);

    // The committed query lists no reported clients; tag one fictional client, as the run-ready copy does.
    const sql = readFileSync(sqlFile, "utf8")
      .replace("reported(pattern, tag) AS (SELECT NULL::text, NULL::text WHERE false)", "reported(pattern, tag) AS (VALUES ('sample%client%', 'DC'), ('nobody%', 'LC'))")
      .replace("2026-11-01 00:00", "2030-10-01 00:00").replace("2027-04-01 00:00", "2031-04-01 00:00");
    const count = async () => Number((await c.query("SELECT (SELECT count(*) FROM appointments) + (SELECT count(*) FROM recurring_series) + (SELECT count(*) FROM appointment_employees) AS n")).rows[0].n);
    const before1 = await count();
    await c.query("BEGIN READ ONLY");
    const { rows } = await c.query(sql);
    await c.query("COMMIT");
    assert.equal(await count(), before1);

    const ref = (id: string) => id.slice(0, 8);
    const of = (chk: string) => rows.filter((r) => r.chk.startsWith(chk));
    // C1 -> exactly the twice-moved visit, proposed back to 9:00-10:15.
    assert.deepEqual(of("C1").map((r) => [r.grp, r.appt]), [[1, ref(twice.ids.get("2030-11-19")!)]]);
    assert.match(of("C1")[0].detail, /later visits at 09:00 \(moved 60 min\) \| this visit 60 min past them \| PROPOSED 09:00-10:15/);
    // C2 -> each later visit of the partial edit, proposed at 8:45-10:30.
    assert.deepEqual(of("C2").map((r) => r.appt), ["2030-12-03", "2030-12-17", "2030-12-31"].map((d) => ref(partial.ids.get(d)!)));
    for (const r of of("C2")) assert.match(r.detail, /PROPOSED 08:45-10:30 \| staff 1 \(inactive 1\)/);
    // C3 -> the reported client's later visits at 10:45-12:00.
    assert.deepEqual(of("C3").map((r) => r.appt), ["2030-12-03", "2030-12-17", "2030-12-31"].map((d) => ref(reported.ids.get(d)!)));
    assert.ok(of("C3").every((r) => r.chk === "C3 owner_reported DC" && /PROPOSED 10:45-12:00/.test(r.detail)));
    // C4 -> the stale reminder flag.
    assert.deepEqual(of("C4").map((r) => r.appt), [ref(oneOff.ids.get("2030-12-31")!)]);
    // C5 -> both held series, with what still blocks re-confirmation.
    assert.deepEqual(of("C5").map((r) => r.series).sort(), [ref(twice.series), ref(partial.series)].sort());
    assert.match(of("C5").find((r) => r.series === ref(partial.series)).detail, /blocked by: C1\/C2\/C3 rows, inactive staff on upcoming visits, mixed clock times upcoming/);
    // grp 2 -> only the one-off move; nothing confirmed is listed as "possible", and vice versa.
    assert.deepEqual(of("X").map((r) => [r.grp, r.appt]).sort(), [[2, ref(oneOff.ids.get("2030-12-03")!)], [2, ref(acrossDst.ids.get("2030-11-12")!)]].sort());
    assert.match(of("X").find((r) => r.appt === ref(acrossDst.ids.get("2030-11-12")!)).detail, /other clock period/);
    // grp 0 -> the reported client's visits and series; no names or contact details anywhere.
    assert.ok(rows.some((r) => r.chk === "D visit" && r.client === "DC"));
    assert.ok(rows.some((r) => r.chk === "D series" && r.client === "DC"));
    const text = JSON.stringify(rows);
    for (const secret of ["Sample Client", "Client One", "Client Two", "Client Four", "Client Five", "Member One", "Fictional Cleaning"]) assert.ok(!text.includes(secret), `leaked ${secret}`);
    assert.match(of("S")[0].detail, /C1 1 \| C2 1 \| C3 1 \| possible exceptions 2 \| stale reminder flags 1/);
  });
});

// ---------------------------------------------------------------------------
describe("Migration 047 release checks (test-db/047-preflight.sql, 047-postflight.sql)", { skip: SKIP }, () => {
  const run = async (file: string) => (await c.query(readFileSync(path.join(ROOT, "test-db", file), "utf8"))).rows as { check_name: string; ok: boolean }[];

  test("preflight on a database at 046 (047 removed inside a rolled-back transaction): every check passes", async () => {
    await c.query("BEGIN");
    try {
      await c.query("DROP FUNCTION apply_future_edit(uuid, uuid, timestamptz, jsonb, jsonb, jsonb, jsonb, jsonb)");
      const rows = await run("047-preflight.sql");
      assert.equal(rows.length, 8);
      assert.deepEqual(rows.filter((r) => !r.ok), []);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  test("preflight after 047 flags it as already applied; postflight passes every check", async () => {
    const pre = await run("047-preflight.sql");
    assert.deepEqual(pre.filter((r) => !r.ok).map((r) => r.check_name), ["apply_future_edit_absent"]);
    const post = await run("047-postflight.sql");
    assert.equal(post.length, 7);
    assert.deepEqual(post.filter((r) => !r.ok), []);
  });

  test("postflight fails when 047 is missing", async () => {
    await c.query("BEGIN");
    try {
      await c.query("DROP FUNCTION apply_future_edit(uuid, uuid, timestamptz, jsonb, jsonb, jsonb, jsonb, jsonb)");
      assert.ok((await run("047-postflight.sql")).every((r) => !r.ok));
    } finally {
      await c.query("ROLLBACK");
    }
  });
});
