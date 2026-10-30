// Migration 041 against real PostgreSQL: employees may record the FIRST work
// on an appointment (Start, or a Complete that would create the missing
// start) only on its scheduled business day, using the workspace timezone
// and the database clock. Finishing work already started is never limited,
// and owner corrections (save_employee_hours, migration 031) still work.
//
// Times are built relative to the database's own now() in each zone, so a
// run within about a minute of local midnight in one of the tested zones
// could see "today" move between building a time and calling the function.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { startTestDb, makeWorkspace, makeAppointment, snapshotWorkspace, MIGRATIONS, type TestDb, type Fixture } from "./harness.ts";
import { effectiveTimezone } from "../lib/timezone.ts";

let db: TestDb;
let c: pg.Client;

before(async () => {
  db = await startTestDb({ migrations: [...MIGRATIONS, "041_block_early_job_start.sql"] });
  c = await db.connect();
});
after(async () => {
  await c?.end();
  await db?.stop();
});

const call = async (fx: Fixture, id: string, action: string, employee = fx.employeeIds[0], workspace = fx.workspaceId) =>
  (await c.query("SELECT record_job_action($1,$2,$3,$4,NULL) AS r", [workspace, employee, id, action])).rows[0].r as { outcome: string };

// Local wall-clock instants in `zone`, relative to the database clock.
async function localTimes(zone: string) {
  const r = (await c.query(
    `SELECT (d AT TIME ZONE $1)                                          AS today_start,
            ((d + interval '1 day' - interval '1 minute') AT TIME ZONE $1) AS today_end,
            ((d + interval '1 day') AT TIME ZONE $1)                       AS tomorrow_start,
            ((d - interval '1 minute') AT TIME ZONE $1)                    AS yesterday_end,
            ((d + interval '3 days' + interval '10 hours') AT TIME ZONE $1) AS future,
            ((d - interval '3 days' + interval '10 hours') AT TIME ZONE $1) AS past
     FROM (SELECT date_trunc('day', now() AT TIME ZONE $1) AS d) t`,
    [zone]
  )).rows[0];
  return r as Record<"today_start" | "today_end" | "tomorrow_start" | "yesterday_end" | "future" | "past", Date>;
}

async function assertRejectedWithoutWrites(fx: Fixture, id: string, outcome: string, label: string) {
  const before = await snapshotWorkspace(c, fx.workspaceId);
  assert.equal((await call(fx, id, "start")).outcome, outcome, `${label}: start`);
  assert.equal((await call(fx, id, "complete")).outcome, outcome, `${label}: complete cannot create the missing start`);
  assert.deepEqual(await snapshotWorkspace(c, fx.workspaceId), before, `${label}: nothing written`);
}

describe("record_job_action -- first work only on the scheduled business day", () => {
  // The zone the database must use is whatever the app's own
  // effectiveTimezone picks for the same stored value -- proving the two
  // rules are identical, including padded values and valid IANA zones the
  // app does not support (which both treat as New York).
  for (const stored of [
    null, "", "   ", "Not/AZone", "america/new_york",
    "America/New_York", "Pacific/Honolulu", " Pacific/Honolulu ", "\tAmerica/Chicago\n",
    "Pacific/Kiritimati", "Europe/London", "Asia/Tokyo",
  ]) {
    const zone = effectiveTimezone(stored);

    test(`${JSON.stringify(stored)} (app uses ${zone}): past and future days are rejected, today (any time) is allowed`, async () => {
      const fx = await makeWorkspace(c, { timezone: stored, employees: 1 });
      const t = await localTimes(zone);
      const appt = (when: Date) => makeAppointment(c, fx, { scheduledFor: when, employees: fx.employeeIds });

      await assertRejectedWithoutWrites(fx, await appt(t.future), "appointment_not_due", "future day");
      await assertRejectedWithoutWrites(fx, await appt(t.tomorrow_start), "appointment_not_due", "12:00 AM tomorrow");
      await assertRejectedWithoutWrites(fx, await appt(t.past), "appointment_day_passed", "past day");
      await assertRejectedWithoutWrites(fx, await appt(t.yesterday_end), "appointment_day_passed", "11:59 PM yesterday");

      const early = await appt(t.today_end); // later today: starting early that day is fine
      assert.equal((await call(fx, early, "start")).outcome, "ok", "11:59 PM today");
      assert.equal((await call(fx, early, "complete")).outcome, "ok");
      const first = await appt(t.today_start);
      assert.equal((await call(fx, first, "complete")).outcome, "ok", "12:00 AM today: complete-without-start allowed on the day");
      const row = (await c.query("SELECT actual_started_at, actual_completed_at FROM appointment_employees WHERE appointment_id=$1", [first])).rows[0];
      assert.ok(row.actual_started_at && row.actual_completed_at);
    });
  }

  test("an already-started job can be completed after midnight (forgotten clock-out), and notes still save", async () => {
    const fx = await makeWorkspace(c, { timezone: "America/New_York", employees: 1 });
    const t = await localTimes("America/New_York");
    const yesterday = await makeAppointment(c, fx, { scheduledFor: t.yesterday_end, employees: fx.employeeIds });
    await c.query("UPDATE appointment_employees SET actual_started_at = $2 WHERE appointment_id = $1", [yesterday, t.yesterday_end]);
    assert.equal((await call(fx, yesterday, "save_notes")).outcome, "ok");
    assert.equal((await call(fx, yesterday, "start")).outcome, "already_started");
    assert.equal((await call(fx, yesterday, "complete")).outcome, "ok");
    // Work started before the appointment was moved to a later day can also finish.
    const moved = await makeAppointment(c, fx, { scheduledFor: t.future, employees: fx.employeeIds });
    await c.query("UPDATE appointment_employees SET actual_started_at = now() - interval '1 hour' WHERE appointment_id = $1", [moved]);
    assert.equal((await call(fx, moved, "complete")).outcome, "ok");
  });

  test("unassigned employees and other workspaces are 'unauthorized' on any day, never told about the date, and write nothing", async () => {
    const fx = await makeWorkspace(c, { timezone: "America/New_York", employees: 2 });
    const other = await makeWorkspace(c, { timezone: "America/New_York", employees: 1 });
    const t = await localTimes("America/New_York");
    for (const when of [t.past, t.today_end, t.future]) {
      const id = await makeAppointment(c, fx, { scheduledFor: when, employees: [fx.employeeIds[0]] });
      const before = await snapshotWorkspace(c, fx.workspaceId);
      for (const action of ["start", "complete"]) {
        assert.equal((await call(fx, id, action, fx.employeeIds[1])).outcome, "unauthorized", "not assigned");
        assert.equal((await call(fx, id, action, other.employeeIds[0], other.workspaceId)).outcome, "unauthorized", "other workspace");
        assert.equal((await call(fx, id, action, fx.employeeIds[0], other.workspaceId)).outcome, "unauthorized", "right employee, wrong workspace");
      }
      assert.deepEqual(await snapshotWorkspace(c, fx.workspaceId), before);
    }
  });

  test("a cancelled appointment is still 'appointment_not_active', even today", async () => {
    const fx = await makeWorkspace(c, { timezone: "America/New_York", employees: 1 });
    const t = await localTimes("America/New_York");
    const id = await makeAppointment(c, fx, { scheduledFor: t.today_end, employees: fx.employeeIds, status: "cancelled" });
    await assertRejectedWithoutWrites(fx, id, "appointment_not_active", "cancelled");
  });

  test("owners can still record worked time for a past appointment the employee could not start", async () => {
    const fx = await makeWorkspace(c, { timezone: "America/New_York", employees: 1 });
    const t = await localTimes("America/New_York");
    const id = await makeAppointment(c, fx, { scheduledFor: t.past, employees: fx.employeeIds });
    assert.equal((await call(fx, id, "start")).outcome, "appointment_day_passed");
    const r = (await c.query("SELECT save_employee_hours($1,$2,$3,$4,$5) AS r", [fx.workspaceId, id, fx.employeeIds[0], 2.5, "Forgot to clock in"])).rows[0].r;
    assert.equal(r.outcome, "ok");
    const assignment = (await c.query("SELECT actual_started_at, actual_completed_at FROM appointment_employees WHERE appointment_id=$1", [id])).rows[0];
    assert.deepEqual(assignment, { actual_started_at: null, actual_completed_at: null }, "owner hours never fabricate tracking timestamps");
  });
});
