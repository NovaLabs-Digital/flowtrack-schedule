// Real-PostgreSQL integration tests for migrations 029/030. Every test calls
// the ACTUAL SQL functions (apply_recurrence_change, record_job_action,
// save_employee_hours, replenish_recurring_series, activate_recurring_series)
// on a disposable PostgreSQL instance -- nothing mocked. Run with
// `npm run test:db`.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import type pg from "pg";
import {
  startTestDb, makeWorkspace, makeAppointment, snapshotWorkspace, waitUntilBlocked, backendPid, track,
  type TestDb, type Fixture,
} from "./harness.ts";
import { buildRecurrenceChangeRequest, normalizeExpectedSnapshot, type RecurrenceChangeRequest } from "../lib/recurrenceChange.ts";

let db: TestDb;
let c: pg.Client; // main connection (always superuser)
let obs: pg.Client; // dedicated observer for lock-wait barriers

before(async () => {
  db = await startTestDb();
  c = await db.connect();
  obs = await db.connect();
});
after(async () => {
  await c.end();
  await obs.end();
  await db.stop();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const DAY = 86400000;
// A start comfortably in the future, at 9:00 AM America/New_York.
function futureNineAm(daysAhead = 40, tz = "America/New_York"): Date {
  const d = DateTime.now().setZone(tz).plus({ days: daysAhead }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
  return d.toJSDate();
}

// Rows/JSON come straight from PostgreSQL and are asserted on structurally.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
async function getAppt(id: string): Promise<Row> {
  return (await c.query("SELECT * FROM appointments WHERE id = $1", [id])).rows[0];
}
async function seriesRows(workspaceId: string, seriesId: string): Promise<Row[]> {
  return (await c.query(
    "SELECT * FROM appointments WHERE workspace_id = $1 AND series_id = $2 ORDER BY scheduled_for", [workspaceId, seriesId])).rows;
}

function expectedFrom(appt: Row, employeeIds: string[], tz = "America/New_York") {
  const raw = {
    scheduled_for: new Date(appt.scheduled_for).toISOString(),
    scheduled_end: appt.scheduled_end ? new Date(appt.scheduled_end).toISOString() : null,
    service_type: appt.service_type, notes: appt.notes, duration_minutes: appt.duration_minutes,
    price_cents: appt.price_cents, team_color: appt.team_color, status: appt.status,
    series_id: appt.series_id, frequency_type: appt.frequency_type, employee_ids: employeeIds, timezone: tz,
  };
  const n = normalizeExpectedSnapshot(raw);
  assert.ok(n, "expected snapshot normalizes");
  return n;
}

function requestFor(appt: Row, employeeIds: string[], o: {
  start?: Date; freq?: string; weeks?: number; months?: number; tz?: string; notes?: string; employees?: string[];
} = {}): RecurrenceChangeRequest {
  const start = o.start ?? new Date(appt.scheduled_for);
  const dur = appt.duration_minutes ?? 60;
  const built = buildRecurrenceChangeRequest({
    fields: {
      scheduled_for: start.toISOString(), scheduled_end: new Date(start.getTime() + dur * 60000).toISOString(),
      service_type: appt.service_type, notes: o.notes ?? appt.notes, duration_minutes: dur,
      price_cents: appt.price_cents, team_color: appt.team_color, status: "scheduled",
    },
    employeeIds: o.employees ?? employeeIds, frequencyType: o.freq ?? "weekly", repeatWeeks: o.weeks ?? 4,
    repeatMonths: o.months ?? null, timezone: o.tz ?? "America/New_York",
  });
  assert.ok(built.ok, built.ok ? "" : built.error);
  return built.request;
}

async function apply(
  client: pg.Client, fx: Fixture, apptId: string, opId: string, request: RecurrenceChangeRequest, expected: unknown
): Promise<Row> {
  const { rows } = await client.query(
    "SELECT apply_recurrence_change($1,$2,$3,$4::jsonb,$5::jsonb) AS r",
    [fx.workspaceId, apptId, opId, JSON.stringify(request), JSON.stringify(expected)]
  );
  return rows[0].r;
}

// One-time appointment -> recurring, returns everything a follow-up needs.
async function convert(fx: Fixture, opts: { employees?: string[]; start?: Date; weeks?: number; freq?: string } = {}) {
  const employees = opts.employees ?? [];
  const start = opts.start ?? futureNineAm();
  const apptId = await makeAppointment(c, fx, { scheduledFor: start, employees, priceCents: 9000 });
  const appt = await getAppt(apptId);
  const opId = randomUUID();
  const res = await apply(c, fx, apptId, opId, requestFor(appt, employees, { freq: opts.freq ?? "weekly", weeks: opts.weeks ?? 4 }), expectedFrom(appt, employees));
  return { apptId, opId, res, start };
}

const iso = (d: Date | string) => new Date(d).toISOString();

// ---------------------------------------------------------------------------
// schema / permissions
// ---------------------------------------------------------------------------

describe("schema and permissions", () => {
  test("anon and authenticated can neither read the operations table nor execute any new function; service_role can", async () => {
    const fx = await makeWorkspace(c);
    for (const role of ["anon", "authenticated"]) {
      // own connection: a failed assertion can never leave the shared one demoted
      const cl = await db.connect();
      try {
        await cl.query(`SET ROLE ${role}`);
        await assert.rejects(cl.query("SELECT * FROM recurrence_change_operations"), /permission denied/);
        await assert.rejects(cl.query("SELECT apply_recurrence_change($1,$1,$1,'{}','{}')", [fx.workspaceId]), /permission denied/);
        await assert.rejects(cl.query("SELECT record_job_action($1,$1,$1,'start',NULL)", [fx.workspaceId]), /permission denied/);
        await assert.rejects(cl.query("SELECT save_employee_hours($1,$1,$1,1,'x')", [fx.workspaceId]), /permission denied/);
      } finally { await cl.end(); }
    }
    const svc = await db.connect();
    try {
      await svc.query("SET ROLE service_role");
      const r = await svc.query("SELECT apply_recurrence_change($1,$1,$1,'{}','{}') AS r", [fx.workspaceId]);
      assert.equal(r.rows[0].r.outcome, "invalid_input");
    } finally { await svc.end(); }
  });

  test("the operations table is immutable for service_role (no UPDATE/DELETE grant) and has RLS enabled", async () => {
    const t = await c.query("SELECT relrowsecurity FROM pg_class WHERE relname = 'recurrence_change_operations'");
    assert.equal(t.rows[0].relrowsecurity, true);
    const svc = await db.connect();
    try {
      await svc.query("SET ROLE service_role");
      await assert.rejects(svc.query("UPDATE recurrence_change_operations SET result = '{}'"), /permission denied/);
      await assert.rejects(svc.query("DELETE FROM recurrence_change_operations"), /permission denied/);
      await svc.query("SELECT 1 FROM recurrence_change_operations LIMIT 1"); // SELECT still allowed
    } finally { await svc.end(); }
  });

  test("invalid / malformed input is rejected before any write", async () => {
    const fx = await makeWorkspace(c);
    const before = await snapshotWorkspace(c, fx.workspaceId);
    for (const bad of [
      [null, {}], [{}, null], [{ recurrence: { frequency_type: "yearly" } }, {}], ["not-json-object", {}],
    ] as const) {
      const { rows } = await c.query(
        "SELECT apply_recurrence_change($1,$2,$3,$4::jsonb,$5::jsonb) AS r",
        [fx.workspaceId, randomUUID(), randomUUID(), JSON.stringify(bad[0]), JSON.stringify(bad[1])]);
      assert.equal(rows[0].r.outcome, "invalid_input");
    }
    assert.deepEqual(await snapshotWorkspace(c, fx.workspaceId), before);
  });
});

// ---------------------------------------------------------------------------
// the operation itself
// ---------------------------------------------------------------------------

describe("apply_recurrence_change: one-time -> recurring", () => {
  test("edits the anchor, generates the series, activates it, records the operation -- all in one transaction", async () => {
    const fx = await makeWorkspace(c);
    const { apptId, opId, res, start } = await convert(fx, { employees: [fx.employeeIds[0]] });
    assert.equal(res.outcome, "applied", JSON.stringify(res));
    assert.ok(res.new_series_id);
    assert.equal(res.cancelled_count, 0);
    assert.equal(res.previous_series_id, null);
    assert.equal(iso(res.previous_scheduled_for), iso(start));

    const anchor = await getAppt(apptId);
    assert.equal(anchor.series_id, res.new_series_id);
    assert.equal(anchor.frequency_type, "weekly");
    assert.equal(anchor.repeat_weeks, 4);

    const rows = await seriesRows(fx.workspaceId, res.new_series_id);
    assert.equal(rows.length, 1 + res.created_count);
    assert.ok(res.created_count > 0);
    // every generated occurrence inherited the assignment, price, and series identity
    const asg = await c.query(
      "SELECT appointment_id FROM appointment_employees WHERE workspace_id=$1 AND actual_started_at IS NULL", [fx.workspaceId]);
    assert.equal(asg.rowCount, rows.length);
    assert.ok(rows.every((r) => r.price_cents === 9000 && r.status === "scheduled"));

    const series = (await c.query("SELECT * FROM recurring_series WHERE id=$1", [res.new_series_id])).rows[0];
    assert.equal(series.status, "active");
    assert.equal(series.template_appointment_id, apptId);
    assert.deepEqual(series.snapshot_employee_ids, [fx.employeeIds[0]]);

    const op = (await c.query("SELECT * FROM recurrence_change_operations WHERE id=$1", [opId])).rows[0];
    assert.equal(op.workspace_id, fx.workspaceId);
    assert.equal(op.appointment_id, apptId);
    assert.match(op.request_fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(op.result.outcome, "applied");
  });

  test("Izabel's schedule shape: every 4 weeks at 9:00 AM local, holding 9:00 AM across the November DST end (rows read back from the database)", async () => {
    const fx = await makeWorkspace(c);
    // Same shape as the reported case (Tuesday, every 4 weeks, 9:00 AM New
    // York, crossing the first Sunday of November) in the next calendar
    // year that is still ahead of "now".
    let year = DateTime.now().year;
    let start = DateTime.fromObject({ year, month: 9, day: 22, hour: 9 }, { zone: "America/New_York" });
    if (start <= DateTime.now().plus({ days: 1 })) { year += 1; start = start.set({ year }); }
    const apptId = await makeAppointment(c, fx, { scheduledFor: start.toJSDate() });
    const appt = await getAppt(apptId);
    const res = await apply(c, fx, apptId, randomUUID(), requestFor(appt, [], { freq: "weekly", weeks: 4 }), expectedFrom(appt, []));
    assert.equal(res.outcome, "applied", JSON.stringify(res));
    const rows = await seriesRows(fx.workspaceId, res.new_series_id);
    const local = rows.map((r) => DateTime.fromJSDate(r.scheduled_for).setZone("America/New_York"));
    assert.ok(local.every((d) => d.toFormat("h:mm a") === "9:00 AM"), local.map((d) => d.toISO()).join(","));
    for (let i = 1; i < local.length; i++) {
      assert.equal(local[i].diff(local[i - 1], "days").days > 27.9 && local[i].diff(local[i - 1], "days").days < 28.1 ||
        // the interval that spans the DST change is 28 calendar days but 28 days + 1 hour of elapsed time
        Math.round(local[i].startOf("day").diff(local[i - 1].startOf("day"), "days").days) === 28, true);
    }
    // it must actually cross the November transition to prove something
    assert.ok(local.some((d) => d.month === 11 || d.month === 12), "series crosses the DST end");
    assert.ok(new Set(rows.map((r) => DateTime.fromJSDate(r.scheduled_for).setZone("UTC").toFormat("HH:mm"))).size > 1,
      "UTC hour differs across the transition while local time holds");
  });

  test("literal Izabel dates (Sept 22 / Oct 20 / Nov 17 / Dec 15, 2026, 9:00 AM New York) -- runs only while Sept 22, 2026 is still in the future", {
    skip: Date.now() >= Date.UTC(2026, 8, 22, 12) ? "requires Sept 22, 2026 to be in the future (activation rejects past templates)" : false,
  }, async () => {
    const fx = await makeWorkspace(c);
    const start = DateTime.fromObject({ year: 2026, month: 9, day: 22, hour: 9 }, { zone: "America/New_York" }).toJSDate();
    // originally Sept 29 4:30 AM, edited to Sept 22 9:00 AM every 4 weeks
    const apptId = await makeAppointment(c, fx, { scheduledFor: DateTime.fromObject({ year: 2026, month: 9, day: 29, hour: 4, minute: 30 }, { zone: "America/New_York" }).toJSDate() });
    const appt = await getAppt(apptId);
    const res = await apply(c, fx, apptId, randomUUID(), requestFor(appt, [], { start, freq: "weekly", weeks: 4 }), expectedFrom(appt, []));
    assert.equal(res.outcome, "applied", JSON.stringify(res));
    const all = [await getAppt(apptId), ...(await seriesRows(fx.workspaceId, res.new_series_id)).filter((r) => r.id !== apptId)]
      .map((r) => DateTime.fromJSDate(r.scheduled_for).setZone("America/New_York").toFormat("yyyy-MM-dd h:mm a"));
    assert.deepEqual(all.slice(0, 4), ["2026-09-22 9:00 AM", "2026-10-20 9:00 AM", "2026-11-17 9:00 AM", "2026-12-15 9:00 AM"]);
  });

  test("moving the anchor and changing its fields in the same call: the boundary comes from the LOCKED row, not the request", async () => {
    const fx = await makeWorkspace(c);
    const oldStart = futureNineAm(60);
    const apptId = await makeAppointment(c, fx, { scheduledFor: oldStart, notes: "old note" });
    const appt = await getAppt(apptId);
    const newStart = futureNineAm(45);
    const res = await apply(c, fx, apptId, randomUUID(),
      requestFor(appt, [], { start: newStart, freq: "weekly", weeks: 2, notes: "new note" }), expectedFrom(appt, []));
    assert.equal(res.outcome, "applied");
    assert.equal(iso(res.previous_scheduled_for), iso(oldStart));
    const anchor = await getAppt(apptId);
    assert.equal(iso(anchor.scheduled_for), iso(newStart));
    assert.equal(anchor.notes, "new note");
  });
});

// ---------------------------------------------------------------------------
// stale snapshots, replay, conflicts
// ---------------------------------------------------------------------------

describe("stale snapshots", () => {
  test("a snapshot that no longer matches the locked row is rejected with zero writes, naming the changed fields", async () => {
    const fx = await makeWorkspace(c);
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureNineAm() });
    const appt = await getAppt(apptId);
    const expected = expectedFrom(appt, []);
    await c.query("UPDATE appointments SET notes = 'someone else', price_cents = 1234 WHERE id = $1", [apptId]);
    const before = await snapshotWorkspace(c, fx.workspaceId);
    const res = await apply(c, fx, apptId, randomUUID(), requestFor(appt, []), expected);
    assert.equal(res.outcome, "stale_snapshot");
    assert.deepEqual([...res.mismatched].sort(), ["notes", "price_cents"]);
    assert.deepEqual(await snapshotWorkspace(c, fx.workspaceId), before);
  });

  test("a changed assignment set or a changed workspace timezone is also stale", async () => {
    const fx = await makeWorkspace(c);
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureNineAm(), employees: [fx.employeeIds[0]] });
    const appt = await getAppt(apptId);
    const staleEmployees = await apply(c, fx, apptId, randomUUID(), requestFor(appt, [fx.employeeIds[0]]), expectedFrom(appt, []));
    assert.equal(staleEmployees.outcome, "stale_snapshot");
    assert.deepEqual(staleEmployees.mismatched, ["employee_ids"]);

    await c.query("UPDATE company_settings SET timezone = 'America/Chicago' WHERE workspace_id = $1", [fx.workspaceId]);
    const staleTz = await apply(c, fx, apptId, randomUUID(), requestFor(appt, [fx.employeeIds[0]]), expectedFrom(appt, [fx.employeeIds[0]]));
    assert.equal(staleTz.outcome, "stale_snapshot");
    assert.deepEqual(staleTz.mismatched, ["timezone"]);
  });

  test("regenerating from a re-read snapshot then succeeds", async () => {
    const fx = await makeWorkspace(c);
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureNineAm() });
    const stale = expectedFrom(await getAppt(apptId), []);
    await c.query("UPDATE appointments SET notes = 'changed' WHERE id = $1", [apptId]);
    const appt = await getAppt(apptId);
    const opId = randomUUID();
    assert.equal((await apply(c, fx, apptId, opId, requestFor(appt, []), stale)).outcome, "stale_snapshot");
    assert.equal((await apply(c, fx, apptId, opId, requestFor(appt, []), expectedFrom(appt, []))).outcome, "applied");
  });
});

describe("operation identity: replay and conflict", () => {
  test("an identical retry returns the stored result BEFORE any stale-snapshot rejection, with no new writes", async () => {
    const fx = await makeWorkspace(c);
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureNineAm() });
    const appt = await getAppt(apptId);
    const request = requestFor(appt, []);
    const expected = expectedFrom(appt, []);
    const opId = randomUUID();
    const first = await apply(c, fx, apptId, opId, request, expected);
    assert.equal(first.outcome, "applied");
    const after = await snapshotWorkspace(c, fx.workspaceId);
    // The retry carries the ORIGINAL (now stale, because the operation
    // succeeded) snapshot -- it must be replayed, not rejected.
    const second = await apply(c, fx, apptId, opId, request, expected);
    assert.equal(second.replayed, true);
    assert.equal(second.new_series_id, first.new_series_id);
    assert.equal(second.created_count, first.created_count);
    assert.deepEqual(await snapshotWorkspace(c, fx.workspaceId), after);
  });

  test("reusing an operation id for a DIFFERENT request, appointment, or workspace conflicts with zero side effects", async () => {
    const fx = await makeWorkspace(c);
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureNineAm() });
    const otherId = await makeAppointment(c, fx, { scheduledFor: futureNineAm(70) });
    const appt = await getAppt(apptId);
    const opId = randomUUID();
    assert.equal((await apply(c, fx, apptId, opId, requestFor(appt, []), expectedFrom(appt, []))).outcome, "applied");
    const after = await snapshotWorkspace(c, fx.workspaceId);

    // different request (interval)
    const diffReq = await apply(c, fx, apptId, opId, requestFor(appt, [], { weeks: 2 }), expectedFrom(appt, []));
    assert.equal(diffReq.outcome, "operation_id_conflict");
    // different request (a single field other than frequency)
    const diffNote = await apply(c, fx, apptId, opId, requestFor(appt, [], { notes: "other" }), expectedFrom(appt, []));
    assert.equal(diffNote.outcome, "operation_id_conflict");
    // different appointment
    const other = await getAppt(otherId);
    const diffAppt = await apply(c, fx, otherId, opId, requestFor(other, []), expectedFrom(other, []));
    assert.equal(diffAppt.outcome, "operation_id_conflict");
    // different workspace (must not leak or touch the first workspace)
    const fx2 = await makeWorkspace(c);
    const a2 = await makeAppointment(c, fx2, { scheduledFor: futureNineAm() });
    const a2row = await getAppt(a2);
    const before2 = await snapshotWorkspace(c, fx2.workspaceId);
    const diffWs = await apply(c, fx2, a2, opId, requestFor(a2row, []), expectedFrom(a2row, []));
    assert.equal(diffWs.outcome, "operation_id_conflict");

    assert.deepEqual(await snapshotWorkspace(c, fx.workspaceId), after);
    assert.deepEqual(await snapshotWorkspace(c, fx2.workspaceId), before2);
  });

  test("workspace isolation: another workspace cannot see or change this appointment", async () => {
    const fx = await makeWorkspace(c);
    const other = await makeWorkspace(c);
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureNineAm() });
    const appt = await getAppt(apptId);
    const before = await snapshotWorkspace(c, fx.workspaceId);
    const res = await apply(c, other, apptId, randomUUID(), requestFor(appt, []), expectedFrom(appt, []));
    assert.equal(res.outcome, "appointment_not_found");
    assert.deepEqual(await snapshotWorkspace(c, fx.workspaceId), before);
  });
});

// ---------------------------------------------------------------------------
// concurrent identical / conflicting retries (real second connection)
// ---------------------------------------------------------------------------

describe("concurrent requests with the same operation id", () => {
  test("two identical concurrent requests: the second waits on the identity claim, then returns the SAME stored result; one series exists", async () => {
    const fx = await makeWorkspace(c);
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureNineAm() });
    const appt = await getAppt(apptId);
    const request = requestFor(appt, []);
    const expected = expectedFrom(appt, []);
    const opId = randomUUID();

    const a = await db.connect();
    const b = await db.connect();
    try {
      const bPid = await backendPid(b);
      await a.query("BEGIN");
      const first = await apply(a, fx, apptId, opId, request, expected); // holds every lock, uncommitted
      assert.equal(first.outcome, "applied");

      const second = track(apply(b, fx, apptId, opId, request, expected));
      await waitUntilBlocked(obs, bPid);
      assert.equal(second.settled(), false, "second request must be waiting, not executing");
      await a.query("COMMIT");

      const secondResult = await second.result;
      assert.equal(secondResult.replayed, true);
      assert.equal(secondResult.new_series_id, first.new_series_id);
      const series = await c.query("SELECT count(*)::int AS n FROM recurring_series WHERE workspace_id=$1", [fx.workspaceId]);
      assert.equal(series.rows[0].n, 1);
      const ops = await c.query("SELECT count(*)::int AS n FROM recurrence_change_operations WHERE id=$1", [opId]);
      assert.equal(ops.rows[0].n, 1);
    } finally {
      await a.end();
      await b.end();
    }
  });

  test("two concurrent requests with the same id but DIFFERENT intent: the loser gets a conflict and changes nothing", async () => {
    const fx = await makeWorkspace(c);
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureNineAm() });
    const appt = await getAppt(apptId);
    const expected = expectedFrom(appt, []);
    const opId = randomUUID();
    const a = await db.connect();
    const b = await db.connect();
    try {
      const bPid = await backendPid(b);
      await a.query("BEGIN");
      const first = await apply(a, fx, apptId, opId, requestFor(appt, [], { weeks: 4 }), expected);
      assert.equal(first.outcome, "applied");
      const second = track(apply(b, fx, apptId, opId, requestFor(appt, [], { weeks: 2 }), expected));
      await waitUntilBlocked(obs, bPid);
      await a.query("COMMIT");
      assert.equal((await second.result).outcome, "operation_id_conflict");
      const anchor = await getAppt(apptId);
      assert.equal(anchor.repeat_weeks, 4, "the winning request's pattern is untouched");
      assert.equal((await c.query("SELECT count(*)::int AS n FROM recurring_series WHERE workspace_id=$1", [fx.workspaceId])).rows[0].n, 1);
    } finally {
      await a.end();
      await b.end();
    }
  });

  test("if the first request rolls back, the identity is not claimed and the waiting request runs normally", async () => {
    const fx = await makeWorkspace(c);
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureNineAm() });
    const appt = await getAppt(apptId);
    const request = requestFor(appt, []);
    const expected = expectedFrom(appt, []);
    const opId = randomUUID();
    const a = await db.connect();
    const b = await db.connect();
    try {
      const bPid = await backendPid(b);
      await a.query("BEGIN");
      assert.equal((await apply(a, fx, apptId, opId, request, expected)).outcome, "applied");
      const second = track(apply(b, fx, apptId, opId, request, expected));
      await waitUntilBlocked(obs, bPid);
      await a.query("ROLLBACK"); // e.g. connection lost before commit
      const res = await second.result;
      assert.equal(res.outcome, "applied");
      assert.equal(res.replayed, undefined);
    } finally {
      await a.end();
      await b.end();
    }
  });
});

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

describe("mid-operation rollback (fault injected by a test-created trigger; production SQL untouched)", () => {
  async function withTrigger(name: string, fnBody: string, table: string, timing: string, fn: () => Promise<void>) {
    await c.query(`CREATE FUNCTION ${name}_fn() RETURNS trigger LANGUAGE plpgsql AS $t$ BEGIN ${fnBody} END $t$`);
    await c.query(`CREATE TRIGGER ${name} ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}_fn()`);
    try {
      await fn();
    } finally {
      await c.query(`DROP TRIGGER ${name} ON ${table}`);
      await c.query(`DROP FUNCTION ${name}_fn()`);
    }
  }

  async function scenarioWithSiblings() {
    const fx = await makeWorkspace(c);
    // an existing series with a future tail the operation will cancel/replace
    const first = await convert(fx, { employees: [fx.employeeIds[0]], weeks: 2 });
    assert.equal(first.res.outcome, "applied");
    const anchor = await getAppt(first.apptId);
    return { fx, first, anchor };
  }

  test("an unexpected error after writes aborts the whole call: cancellations, new series, occurrences and operation record all roll back", async () => {
    const { fx, first, anchor } = await scenarioWithSiblings();
    const before = await snapshotWorkspace(c, fx.workspaceId);
    await withTrigger("inject_fail_activate",
      "IF NEW.status = 'active' THEN RAISE EXCEPTION 'injected failure after writes'; END IF; RETURN NEW;",
      "recurring_series", "BEFORE UPDATE", async () => {
        await assert.rejects(
          apply(c, fx, first.apptId, randomUUID(), requestFor(anchor, [fx.employeeIds[0]], { weeks: 4 }), expectedFrom(anchor, [fx.employeeIds[0]])),
          /injected failure after writes/);
      });
    assert.deepEqual(await snapshotWorkspace(c, fx.workspaceId), before);
  });

  test("a post-write rejection (activation refused) returns a normal outcome yet ROLLS BACK every write -- error JSON alone would not", async () => {
    const { fx, first, anchor } = await scenarioWithSiblings();
    const before = await snapshotWorkspace(c, fx.workspaceId);
    const opId = randomUUID();
    // Force activate_recurring_series to see a non-scheduled template AFTER the
    // function has already cancelled siblings, stopped the old series, moved
    // the anchor and inserted the new series + occurrences.
    await withTrigger("inject_state_change",
      "IF NEW.notes = '__force_state_changed__' THEN NEW.status := 'cancelled'; END IF; RETURN NEW;",
      "appointments", "BEFORE UPDATE", async () => {
        const request = requestFor(anchor, [fx.employeeIds[0]], { weeks: 4, notes: "__force_state_changed__" });
        const res = await apply(c, fx, first.apptId, opId, request, expectedFrom(anchor, [fx.employeeIds[0]]));
        assert.equal(res.outcome, "rolled_back");
        assert.match(res.reason, /activation_failed/);
      });
    assert.deepEqual(await snapshotWorkspace(c, fx.workspaceId), before, "no write from the failed call survives");
    const gone = await c.query("SELECT 1 FROM recurrence_change_operations WHERE id = $1", [opId]);
    assert.equal(gone.rowCount, 0);

    // the same operation id can be retried once the fault is gone
    const retry = await apply(c, fx, first.apptId, opId, requestFor(anchor, [fx.employeeIds[0]], { weeks: 4 }), expectedFrom(anchor, [fx.employeeIds[0]]));
    assert.equal(retry.outcome, "applied", JSON.stringify(retry));
  });
});

// ---------------------------------------------------------------------------
// recorded work: sequential
// ---------------------------------------------------------------------------

describe("replacing a series while occurrences carry recorded work", () => {
  async function seriesWithTail(weeks = 1) {
    const fx = await makeWorkspace(c, { employees: 2 });
    const built = await convert(fx, { employees: [fx.employeeIds[0]], weeks, start: futureNineAm(30) });
    assert.equal(built.res.outcome, "applied", JSON.stringify(built.res));
    const rows = (await seriesRows(fx.workspaceId, built.res.new_series_id)).filter((r) => r.id !== built.apptId);
    assert.ok(rows.length >= 6, "fixture has a future tail");
    return { fx, ...built, tail: rows };
  }

  test("started work, job notes, manual hours, and in-progress multi-employee jobs are retained; everything else after the boundary is replaced", async () => {
    const { fx, apptId, tail } = await seriesWithTail();
    const [started, noted, hours, partial, plain] = tail;
    await c.query("UPDATE appointment_employees SET actual_started_at = now() WHERE appointment_id = $1", [started.id]);
    await c.query("UPDATE appointment_employees SET actual_started_at = now(), job_notes = 'gate code 1234' WHERE appointment_id = $1", [noted.id]);
    await c.query("INSERT INTO appointment_employee_hours (appointment_id, employee_id, workspace_id, hours_worked, note) VALUES ($1,$2,$3,2,'manual')",
      [hours.id, fx.employeeIds[0], fx.workspaceId]);
    // multi-employee, one finished, one still working, scheduled end in the future
    await c.query("INSERT INTO appointment_employees (appointment_id, employee_id, workspace_id, actual_started_at, actual_completed_at) VALUES ($1,$2,$3, now() - interval '30 minutes', now())",
      [partial.id, fx.employeeIds[1], fx.workspaceId]);
    await c.query("UPDATE appointment_employees SET actual_started_at = now() WHERE appointment_id = $1 AND employee_id = $2", [partial.id, fx.employeeIds[0]]);

    const anchor = await getAppt(apptId);
    const res = await apply(c, fx, apptId, randomUUID(), requestFor(anchor, [fx.employeeIds[0]], { freq: "weekly", weeks: 2 }), expectedFrom(anchor, [fx.employeeIds[0]]));
    assert.equal(res.outcome, "applied", JSON.stringify(res));
    assert.equal(res.protected_count, 4);
    assert.deepEqual(res.protected.map((p: Row) => p.id).sort(), [started.id, noted.id, hours.id, partial.id].sort());
    assert.equal(res.cancelled_count, tail.length - 4);

    for (const kept of [started, noted, hours, partial]) {
      const row = await getAppt(kept.id);
      assert.equal(row.status, "scheduled", "retained occurrence untouched");
      assert.equal(row.series_id, kept.series_id, "retained occurrence keeps its old (now stopped) series");
    }
    assert.equal((await getAppt(plain.id)).status, "cancelled");
    // recorded work is byte-for-byte intact
    const notes = await c.query("SELECT job_notes FROM appointment_employees WHERE appointment_id=$1", [noted.id]);
    assert.equal(notes.rows[0].job_notes, "gate code 1234");
    const old = (await c.query("SELECT status FROM recurring_series WHERE id=$1", [started.series_id])).rows[0];
    assert.equal(old.status, "stopped");
    // nothing copied recorded work into new rows
    const fresh = await c.query(
      `SELECT ae.* FROM appointment_employees ae JOIN appointments a ON a.id = ae.appointment_id
       WHERE a.series_id = $1 AND (ae.actual_started_at IS NOT NULL OR ae.job_notes IS NOT NULL)`, [res.new_series_id]);
    assert.equal(fresh.rowCount, 0);
    const freshHours = await c.query(
      "SELECT 1 FROM appointment_employee_hours h JOIN appointments a ON a.id=h.appointment_id WHERE a.series_id=$1", [res.new_series_id]);
    assert.equal(freshHours.rowCount, 0);
  });

  test("the new series never creates a second appointment at a retained occurrence's instant (initial generation)", async () => {
    const { fx, apptId, tail } = await seriesWithTail();
    const retained = tail[3];
    await c.query("UPDATE appointment_employees SET actual_started_at = now() WHERE appointment_id = $1", [retained.id]);
    const anchor = await getAppt(apptId);
    // weekly every 1 week -> the new series' cadence lands exactly on the retained instant
    const res = await apply(c, fx, apptId, randomUUID(), requestFor(anchor, [fx.employeeIds[0]], { freq: "weekly", weeks: 1 }), expectedFrom(anchor, [fx.employeeIds[0]]));
    assert.equal(res.outcome, "applied");
    assert.ok(res.skipped_for_exclusion_count >= 1);
    const atInstant = await c.query(
      "SELECT id, series_id FROM appointments WHERE workspace_id=$1 AND scheduled_for=$2 AND status <> 'cancelled'", [fx.workspaceId, retained.scheduled_for]);
    assert.equal(atInstant.rowCount, 1, "exactly one live appointment at the retained instant");
    assert.equal(atInstant.rows[0].id, retained.id);
    const series = (await c.query("SELECT excluded_occurrences FROM recurring_series WHERE id=$1", [res.new_series_id])).rows[0];
    assert.ok(series.excluded_occurrences.map(iso).includes(iso(retained.scheduled_for)));
  });

  test("assignment diff preserves recorded work on a kept assignment and blocks removing one that has work", async () => {
    const fx = await makeWorkspace(c, { employees: 2 });
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureNineAm(), employees: [fx.employeeIds[0]] });
    await c.query("UPDATE appointment_employees SET actual_started_at = now(), job_notes = 'kept' WHERE appointment_id = $1", [apptId]);
    const appt = await getAppt(apptId);
    // add a second employee: the first assignment's start time + note survive
    const ok = await apply(c, fx, apptId, randomUUID(),
      requestFor(appt, [fx.employeeIds[0]], { employees: [fx.employeeIds[0], fx.employeeIds[1]], freq: "weekly", weeks: 2 }),
      expectedFrom(appt, [fx.employeeIds[0]]));
    assert.equal(ok.outcome, "applied", JSON.stringify(ok));
    const kept = await c.query("SELECT actual_started_at, job_notes FROM appointment_employees WHERE appointment_id=$1 AND employee_id=$2", [apptId, fx.employeeIds[0]]);
    assert.ok(kept.rows[0].actual_started_at);
    assert.equal(kept.rows[0].job_notes, "kept");

    // removing the worked employee is blocked with zero writes
    const appt2 = await getAppt(apptId);
    const before = await snapshotWorkspace(c, fx.workspaceId);
    const blocked = await apply(c, fx, apptId, randomUUID(),
      requestFor(appt2, [], { employees: [fx.employeeIds[1]], freq: "weekly", weeks: 3 }),
      expectedFrom(appt2, [fx.employeeIds[0], fx.employeeIds[1]]));
    assert.equal(blocked.outcome, "assignment_removal_blocked");
    assert.deepEqual(await snapshotWorkspace(c, fx.workspaceId), before);
  });

  // Release-validation regression: the operation must never take the destructive
  // delete-and-reinsert path (sync_appointment_assignments). Two assigned
  // employees, one has started + Job Notes + a manual-hours row, the other has
  // not completed; the change keeps both employees and moves the date/time.
  describe("assignment preservation on the anchor (two employees, recorded work)", () => {
    async function twoEmployeeAnchor() {
      const fx = await makeWorkspace(c, { employees: 2 });
      const [a, b] = fx.employeeIds;
      const apptId = await makeAppointment(c, fx, { scheduledFor: futureNineAm(30), employees: [a, b] });
      await c.query("UPDATE appointment_employees SET actual_started_at = now() - interval '20 minutes', job_notes = 'gate code 1234' WHERE appointment_id=$1 AND employee_id=$2", [apptId, a]);
      await c.query("INSERT INTO appointment_employee_hours (appointment_id, employee_id, workspace_id, hours_worked, note) VALUES ($1,$2,$3,1.5,'manual')", [apptId, a, fx.workspaceId]);
      // B: assigned, started, NOT completed
      await c.query("UPDATE appointment_employees SET actual_started_at = now() - interval '5 minutes' WHERE appointment_id=$1 AND employee_id=$2", [apptId, b]);
      return { fx, a, b, apptId };
    }
    const assignmentRows = async (apptId: string) =>
      (await c.query("SELECT * FROM appointment_employees WHERE appointment_id=$1 ORDER BY employee_id", [apptId])).rows;
    const hoursRows = async (apptId: string) =>
      (await c.query("SELECT * FROM appointment_employee_hours WHERE appointment_id=$1 ORDER BY employee_id", [apptId])).rows;

    test("retaining the same employees while changing date/time and recurrence leaves every assignment and hours row byte-identical (ids, timestamps, notes)", async () => {
      const { fx, a, b, apptId } = await twoEmployeeAnchor();
      const beforeAssign = await assignmentRows(apptId);
      const beforeHours = await hoursRows(apptId);
      assert.equal(beforeAssign.length, 2);

      const appt = await getAppt(apptId);
      const moved = new Date(new Date(appt.scheduled_for).getTime() + 2 * DAY);
      const res = await apply(c, fx, apptId, randomUUID(),
        requestFor(appt, [a, b], { start: moved, freq: "weekly", weeks: 4 }), expectedFrom(appt, [a, b]));
      assert.equal(res.outcome, "applied", JSON.stringify(res));
      assert.equal(iso((await getAppt(apptId)).scheduled_for), iso(moved), "the anchor really moved");
      assert.deepEqual(await assignmentRows(apptId), beforeAssign, "assignment rows (id, timestamps, job_notes, created/updated_at) untouched");
      assert.deepEqual(await hoursRows(apptId), beforeHours, "manual-hours rows untouched");

      // a second replacement (A -> B -> C) on the same anchor still preserves everything
      const appt2 = await getAppt(apptId);
      const again = await apply(c, fx, apptId, randomUUID(),
        requestFor(appt2, [a, b], { freq: "weekly", weeks: 2 }), expectedFrom(appt2, [a, b]));
      assert.equal(again.outcome, "applied", JSON.stringify(again));
      assert.deepEqual(await assignmentRows(apptId), beforeAssign);
      assert.deepEqual(await hoursRows(apptId), beforeHours);

      // converting back to one-time (no series) also keeps them
      const appt3 = await getAppt(apptId);
      const one = await apply(c, fx, apptId, randomUUID(),
        requestFor(appt3, [a, b], { freq: "one_time" }), expectedFrom(appt3, [a, b]));
      assert.equal(one.outcome, "applied", JSON.stringify(one));
      assert.deepEqual(await assignmentRows(apptId), beforeAssign);
      assert.deepEqual(await hoursRows(apptId), beforeHours);
    });

    test("removing an employee who has ANY recorded work is rejected before any write, naming that employee; nothing is discarded", async () => {
      const { fx, a, b, apptId } = await twoEmployeeAnchor();
      const appt = await getAppt(apptId);
      const before = await snapshotWorkspace(c, fx.workspaceId);
      const blocked = await apply(c, fx, apptId, randomUUID(),
        requestFor(appt, [a, b], { employees: [b], freq: "weekly", weeks: 4 }), expectedFrom(appt, [a, b]));
      assert.equal(blocked.outcome, "assignment_removal_blocked");
      assert.deepEqual(blocked.blocked_employee_ids, [a]);
      assert.deepEqual(await snapshotWorkspace(c, fx.workspaceId), before, "zero writes");
    });

    test("each kind of recorded work independently blocks removal: started only, Job Notes only, manual hours only", async () => {
      const fx = await makeWorkspace(c, { employees: 3 });
      const [e1, e2, e3] = fx.employeeIds;
      const apptId = await makeAppointment(c, fx, { scheduledFor: futureNineAm(30), employees: [e1, e2, e3] });
      await c.query("UPDATE appointment_employees SET actual_started_at = now() WHERE appointment_id=$1 AND employee_id=$2", [apptId, e1]);
      await c.query("UPDATE appointment_employees SET job_notes = 'note only' WHERE appointment_id=$1 AND employee_id=$2", [apptId, e2]);
      await c.query("INSERT INTO appointment_employee_hours (appointment_id, employee_id, workspace_id, hours_worked) VALUES ($1,$2,$3,1)", [apptId, e3, fx.workspaceId]);
      const appt = await getAppt(apptId);
      const before = await snapshotWorkspace(c, fx.workspaceId);
      for (const [worked, keep] of [[e1, [e2, e3]], [e2, [e1, e3]], [e3, [e1, e2]]] as const) {
        const r = await apply(c, fx, apptId, randomUUID(),
          requestFor(appt, [e1, e2, e3], { employees: [...keep], freq: "weekly", weeks: 4 }), expectedFrom(appt, [e1, e2, e3]));
        assert.equal(r.outcome, "assignment_removal_blocked", worked);
        assert.deepEqual(r.blocked_employee_ids, [worked]);
      }
      assert.deepEqual(await snapshotWorkspace(c, fx.workspaceId), before);
    });

    test("removing an employee with NO recorded work is allowed and the other employees' records stay byte-identical", async () => {
      const fx = await makeWorkspace(c, { employees: 3 });
      const [a, b, idle] = fx.employeeIds;
      const apptId = await makeAppointment(c, fx, { scheduledFor: futureNineAm(30), employees: [a, b, idle] });
      await c.query("UPDATE appointment_employees SET actual_started_at = now() - interval '10 minutes', job_notes = 'keep me' WHERE appointment_id=$1 AND employee_id=$2", [apptId, a]);
      const beforeKept = (await assignmentRows(apptId)).filter((r) => r.employee_id !== idle);
      const appt = await getAppt(apptId);
      const res = await apply(c, fx, apptId, randomUUID(),
        requestFor(appt, [a, b, idle], { employees: [a, b], freq: "weekly", weeks: 4 }), expectedFrom(appt, [a, b, idle]));
      assert.equal(res.outcome, "applied", JSON.stringify(res));
      const after = await assignmentRows(apptId);
      assert.deepEqual(after, beforeKept);
      assert.ok(!after.some((r) => r.employee_id === idle));
    });
  });

  test("a fully completed or past anchor can never be changed", async () => {
    const fx = await makeWorkspace(c);
    const done = await makeAppointment(c, fx, { scheduledFor: futureNineAm(), employees: [fx.employeeIds[0]] });
    await c.query("UPDATE appointment_employees SET actual_started_at = now() - interval '10 minutes', actual_completed_at = now() WHERE appointment_id=$1", [done]);
    const appt = await getAppt(done);
    assert.equal((await apply(c, fx, done, randomUUID(), requestFor(appt, [fx.employeeIds[0]]), expectedFrom(appt, [fx.employeeIds[0]]))).outcome, "appointment_is_historical");
    const past = await makeAppointment(c, fx, { scheduledFor: new Date(Date.now() - 3 * DAY) });
    const p = await getAppt(past);
    const pastReq = { ...requestFor({ ...p, scheduled_for: futureNineAm() }, []), };
    assert.equal((await apply(c, fx, past, randomUUID(), pastReq, expectedFrom(p, []))).outcome, "appointment_is_historical");
  });
});

// ---------------------------------------------------------------------------
// concurrent job tracking / manual hours (shared locking protocol)
// ---------------------------------------------------------------------------

describe("concurrency with Job Tracking and manual hours", () => {
  async function setup() {
    const fx = await makeWorkspace(c, { employees: 2 });
    const built = await convert(fx, { employees: [fx.employeeIds[0]], weeks: 1, start: futureNineAm(30) });
    const tail = (await seriesRows(fx.workspaceId, built.res.new_series_id)).filter((r) => r.id !== built.apptId);
    const target = tail[2];
    const anchor = await getAppt(built.apptId);
    const request = requestFor(anchor, [fx.employeeIds[0]], { freq: "weekly", weeks: 2 });
    const expected = expectedFrom(anchor, [fx.employeeIds[0]]);
    return { fx, built, tail, target, request, expected };
  }
  const job = (cl: pg.Client, fx: Fixture, apptId: string, action = "start") =>
    cl.query("SELECT record_job_action($1,$2,$3,$4,NULL) AS r", [fx.workspaceId, fx.employeeIds[0], apptId, action]).then((x) => x.rows[0].r);
  const hours = (cl: pg.Client, fx: Fixture, apptId: string) =>
    cl.query("SELECT save_employee_hours($1,$2,$3,2.5,'forgot to clock in') AS r", [fx.workspaceId, apptId, fx.employeeIds[0]]).then((x) => x.rows[0].r);

  test("work recorded FIRST (job-start holds the appointment, uncommitted): the replacement waits, then sees the start and retains the occurrence", async () => {
    const { fx, built, target, request, expected } = await setup();
    const w = await db.connect();
    const r = await db.connect();
    try {
      const rPid = await backendPid(r);
      await w.query("BEGIN");
      assert.equal((await job(w, fx, target.id)).outcome, "ok");
      const replacement = track(apply(r, fx, built.apptId, randomUUID(), request, expected));
      await waitUntilBlocked(obs, rPid);
      assert.equal(replacement.settled(), false);
      await w.query("COMMIT");
      const res = await replacement.result;
      assert.equal(res.outcome, "applied", JSON.stringify(res));
      assert.ok(res.protected.some((p: Row) => p.id === target.id), "the just-started occurrence is protected");
      const row = await getAppt(target.id);
      assert.equal(row.status, "scheduled");
      const asg = await c.query("SELECT actual_started_at FROM appointment_employees WHERE appointment_id=$1", [target.id]);
      assert.ok(asg.rows[0].actual_started_at);
    } finally { await w.end(); await r.end(); }
  });

  test("replacement committed FIRST (uncommitted, holding locks): a queued job-start revalidates and is REJECTED without writing", async () => {
    const { fx, built, target, request, expected } = await setup();
    const w = await db.connect();
    const r = await db.connect();
    try {
      const wPid = await backendPid(w);
      await r.query("BEGIN");
      const res = await apply(r, fx, built.apptId, randomUUID(), request, expected);
      assert.equal(res.outcome, "applied");
      const start = track(job(w, fx, target.id));
      await waitUntilBlocked(obs, wPid);
      assert.equal(start.settled(), false, "job-start must wait for the replacement, not race it");
      await r.query("COMMIT");
      const outcome = await start.result;
      assert.equal(outcome.outcome, "appointment_not_active");
      assert.equal((await getAppt(target.id)).status, "cancelled");
      const asg = await c.query("SELECT actual_started_at FROM appointment_employees WHERE appointment_id=$1", [target.id]);
      assert.equal(asg.rows[0].actual_started_at, null, "no work was recorded on the replaced occurrence");
    } finally { await w.end(); await r.end(); }
  });

  test("manual hours recorded FIRST: the replacement waits, then retains the occurrence", async () => {
    const { fx, built, target, request, expected } = await setup();
    const w = await db.connect();
    const r = await db.connect();
    try {
      const rPid = await backendPid(r);
      await w.query("BEGIN");
      assert.equal((await hours(w, fx, target.id)).outcome, "ok");
      const replacement = track(apply(r, fx, built.apptId, randomUUID(), request, expected));
      await waitUntilBlocked(obs, rPid);
      await w.query("COMMIT");
      const res = await replacement.result;
      assert.equal(res.outcome, "applied");
      assert.ok(res.protected.some((p: Row) => p.id === target.id));
      assert.equal((await getAppt(target.id)).status, "scheduled");
    } finally { await w.end(); await r.end(); }
  });

  test("a NEW manual-hours insert cannot slip past the protection check: replacement first => the insert is rejected", async () => {
    const { fx, built, target, request, expected } = await setup();
    const w = await db.connect();
    const r = await db.connect();
    try {
      const wPid = await backendPid(w);
      await r.query("BEGIN");
      assert.equal((await apply(r, fx, built.apptId, randomUUID(), request, expected)).outcome, "applied");
      const insert = track(hours(w, fx, target.id));
      await waitUntilBlocked(obs, wPid);
      await r.query("COMMIT");
      assert.equal((await insert.result).outcome, "appointment_not_active");
      const n = await c.query("SELECT count(*)::int AS n FROM appointment_employee_hours WHERE appointment_id=$1", [target.id]);
      assert.equal(n.rows[0].n, 0);
    } finally { await w.end(); await r.end(); }
  });

  test("two workers recording work on the same appointment do not block each other", async () => {
    const fx = await makeWorkspace(c, { employees: 2 });
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureNineAm(), employees: fx.employeeIds });
    const a = await db.connect();
    const b = await db.connect();
    try {
      await a.query("BEGIN");
      await a.query("SELECT record_job_action($1,$2,$3,'start',NULL)", [fx.workspaceId, fx.employeeIds[0], apptId]);
      // would hang (and fail the test by timeout) if workers serialized on the parent row
      const r = await b.query("SELECT record_job_action($1,$2,$3,'start',NULL) AS r", [fx.workspaceId, fx.employeeIds[1], apptId]);
      assert.equal(r.rows[0].r.outcome, "ok");
      await a.query("COMMIT");
    } finally { await a.end(); await b.end(); }
  });

  test("job actions: existing rules preserved (unassigned employee, already started/completed, notes need a started job, complete-without-start)", async () => {
    const fx = await makeWorkspace(c, { employees: 2 });
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureNineAm(), employees: [fx.employeeIds[0]] });
    assert.equal((await c.query("SELECT record_job_action($1,$2,$3,'start',NULL) AS r", [fx.workspaceId, fx.employeeIds[1], apptId])).rows[0].r.outcome, "unauthorized");
    assert.equal((await job(c, fx, apptId, "save_notes")).outcome, "not_started");
    assert.equal((await job(c, fx, apptId, "start")).outcome, "ok");
    assert.equal((await job(c, fx, apptId, "start")).outcome, "already_started");
    assert.equal((await c.query("SELECT record_job_action($1,$2,$3,'save_notes','on site') AS r", [fx.workspaceId, fx.employeeIds[0], apptId])).rows[0].r.job_notes, "on site");
    assert.equal((await job(c, fx, apptId, "complete")).outcome, "ok");
    assert.equal((await job(c, fx, apptId, "complete")).outcome, "already_completed");
    const other = await makeAppointment(c, fx, { scheduledFor: futureNineAm(50), employees: [fx.employeeIds[0]] });
    const both = await job(c, fx, other, "complete");
    assert.ok(both.actual_started_at && both.actual_completed_at);
  });

  test("hours rules preserved: tracked time cannot be overridden, unassigned employee, and an existing entry on a cancelled appointment may still be corrected", async () => {
    const fx = await makeWorkspace(c, { employees: 2 });
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureNineAm(), employees: [fx.employeeIds[0]] });
    assert.equal((await c.query("SELECT save_employee_hours($1,$2,$3,1,'x') AS r", [fx.workspaceId, apptId, fx.employeeIds[1]])).rows[0].r.outcome, "not_assigned");
    assert.equal((await hours(c, fx, apptId)).outcome, "ok");
    await c.query("UPDATE appointments SET status='cancelled' WHERE id=$1", [apptId]);
    assert.equal((await hours(c, fx, apptId)).outcome, "ok", "existing entry can be corrected");
    const other = await makeAppointment(c, fx, { scheduledFor: futureNineAm(50), employees: [fx.employeeIds[0]] });
    await c.query("UPDATE appointment_employees SET actual_started_at = now() - interval '2 hours', actual_completed_at = now() WHERE appointment_id=$1", [other]);
    assert.equal((await hours(c, fx, other)).outcome, "tracked_time_exists");
  });
});

// ---------------------------------------------------------------------------
// randomized interleavings: the invariant, and no deadlocks
// ---------------------------------------------------------------------------

describe("randomized concurrency: recorded work is never lost or attached to a replaced occurrence, and nothing deadlocks", () => {
  test("40 rounds of one replacement racing four workers (job starts and manual hours) with random start jitter", async () => {
    const stats = { retained: 0, rejected: 0 };
    for (let round = 0; round < 40; round++) {
      const fx = await makeWorkspace(c, { employees: 1 });
      const emp = [fx.employeeIds[0]];
      const built = await convert(fx, { employees: emp, weeks: 1, start: futureNineAm(30) });
      const tail = (await seriesRows(fx.workspaceId, built.res.new_series_id)).filter((r) => r.id !== built.apptId);
      const anchor = await getAppt(built.apptId);
      const request = requestFor(anchor, emp, { weeks: 2 });
      const expected = expectedFrom(anchor, emp);
      const picks = [tail[1], tail[2], tail[3], tail[6]];
      const conns = await Promise.all(Array.from({ length: picks.length + 1 }, () => db.connect()));
      // A replacement takes ~10ms; spreading the workers across that window is what
      // produces genuinely different interleavings (both outcomes are asserted below).
      const jitter = (max: number) => new Promise((r) => setTimeout(r, Math.random() * max));
      try {
        const results = await Promise.allSettled([
          (async () => { await jitter(3); return apply(conns[0], fx, built.apptId, randomUUID(), request, expected); })(),
          ...picks.map((p, i) => (async () => {
            await jitter(30);
            return i % 2 === 0
              ? conns[i + 1].query("SELECT record_job_action($1,$2,$3,'start',NULL) AS r", [fx.workspaceId, emp[0], p.id]).then((x) => x.rows[0].r)
              : conns[i + 1].query("SELECT save_employee_hours($1,$2,$3,1.5,'forgot') AS r", [fx.workspaceId, p.id, emp[0]]).then((x) => x.rows[0].r);
          })()),
        ]);
        for (const r of results) {
          assert.equal(r.status, "fulfilled", r.status === "rejected" ? `round ${round}: ${(r.reason as Error).message}` : "");
        }
        const applied = (results[0] as PromiseFulfilledResult<Row>).value;
        assert.equal(applied.outcome, "applied", JSON.stringify(applied));
        for (let i = 0; i < picks.length; i++) {
          const outcome = (results[i + 1] as PromiseFulfilledResult<Row>).value.outcome;
          const row = await getAppt(picks[i].id);
          const work = await c.query(
            `SELECT (SELECT count(*) FROM appointment_employees WHERE appointment_id=$1 AND actual_started_at IS NOT NULL)
                  + (SELECT count(*) FROM appointment_employee_hours WHERE appointment_id=$1) AS n`, [picks[i].id]);
          const hasWork = Number(work.rows[0].n) > 0;
          if (outcome === "ok") {
            assert.equal(row.status, "scheduled", `round ${round}: recorded work survives`);
            assert.ok(hasWork);
            assert.ok(applied.protected.some((p: Row) => p.id === picks[i].id), `round ${round}: work recorded => occurrence protected`);
            stats.retained++;
          } else {
            assert.equal(outcome, "appointment_not_active", `round ${round}`);
            assert.equal(row.status, "cancelled");
            assert.equal(hasWork, false, `round ${round}: nothing recorded on a replaced occurrence`);
            stats.rejected++;
          }
        }
      } finally {
        await Promise.all(conns.map((x) => x.end()));
      }
    }
    // Both outcomes must actually have been exercised, or the jitter is not
    // producing real interleavings.
    assert.ok(stats.retained > 0 && stats.rejected > 0, `interleavings not diverse enough: ${JSON.stringify(stats)}`);
  });

  test("Job Tracking on the ANCHOR itself while it is being changed: no deadlock, both complete, work preserved", async () => {
    const fx = await makeWorkspace(c, { employees: 1 });
    const emp = [fx.employeeIds[0]];
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureNineAm(30), employees: emp });
    const appt = await getAppt(apptId);
    const a = await db.connect();
    const b = await db.connect();
    try {
      const bPid = await backendPid(b);
      await a.query("BEGIN");
      assert.equal((await a.query("SELECT record_job_action($1,$2,$3,'start',NULL) AS r", [fx.workspaceId, emp[0], apptId])).rows[0].r.outcome, "ok");
      const change = track(apply(b, fx, apptId, randomUUID(), requestFor(appt, emp, { weeks: 2 }), expectedFrom(appt, emp)));
      await waitUntilBlocked(obs, bPid);
      await a.query("COMMIT");
      // the anchor's snapshot was valid when the owner opened it, but the start committed first:
      // the assignment set/fields are unchanged, so the change applies and the start is preserved
      const res = await change.result;
      assert.equal(res.outcome, "applied", JSON.stringify(res));
      const asg = await c.query("SELECT actual_started_at FROM appointment_employees WHERE appointment_id=$1", [apptId]);
      assert.ok(asg.rows[0].actual_started_at);
    } finally { await a.end(); await b.end(); }
  });
});

// ---------------------------------------------------------------------------
// A -> B -> C and replenishment
// ---------------------------------------------------------------------------

describe("retained occurrences survive repeated replacement and replenishment", () => {
  // replenish_recurring_series compares snapshot_updated_at at full timestamptz
  // precision; a JS Date would truncate microseconds, so it is read in SQL.
  async function replenish(seriesId: string, workspaceId: string, instants: Date[]): Promise<Row> {
    const { rows } = await c.query(
      "SELECT replenish_recurring_series($1,$2,(SELECT snapshot_updated_at FROM recurring_series WHERE id=$1),$3::timestamptz[]) AS r",
      [seriesId, workspaceId, instants]);
    return rows[0].r;
  }

  test("A -> B -> C: a retained occurrence from series A is still excluded from C's generation and from every later replenishment", async () => {
    const fx = await makeWorkspace(c, { employees: 1 });
    const A = await convert(fx, { employees: [fx.employeeIds[0]], weeks: 1, start: futureNineAm(30) });
    assert.equal(A.res.outcome, "applied");
    const tailA = (await seriesRows(fx.workspaceId, A.res.new_series_id)).filter((r) => r.id !== A.apptId);
    const retained = tailA[4];
    await c.query("UPDATE appointment_employees SET actual_started_at = now() WHERE appointment_id=$1", [retained.id]);

    // A -> B (every 2 weeks)
    let anchor = await getAppt(A.apptId);
    const toB = await apply(c, fx, A.apptId, randomUUID(), requestFor(anchor, [fx.employeeIds[0]], { weeks: 2 }), expectedFrom(anchor, [fx.employeeIds[0]]));
    assert.equal(toB.outcome, "applied", JSON.stringify(toB));
    assert.equal(toB.protected_count, 1);
    const seriesB = (await c.query("SELECT * FROM recurring_series WHERE id=$1", [toB.new_series_id])).rows[0];
    assert.equal(seriesB.superseded_series_id, A.res.new_series_id);
    assert.ok(seriesB.excluded_occurrences.map(iso).includes(iso(retained.scheduled_for)));

    // B -> C (every week again, so C's cadence hits the retained instant)
    anchor = await getAppt(A.apptId);
    const toC = await apply(c, fx, A.apptId, randomUUID(), requestFor(anchor, [fx.employeeIds[0]], { weeks: 1 }), expectedFrom(anchor, [fx.employeeIds[0]]));
    assert.equal(toC.outcome, "applied", JSON.stringify(toC));
    assert.equal(toC.protected_count, 0, "the retained occurrence is not in B, so nothing new is protected -- the exclusion must come from lineage");
    assert.ok(toC.skipped_for_exclusion_count >= 1, "C skipped the instant retained since series A");
    const seriesC = (await c.query("SELECT * FROM recurring_series WHERE id=$1", [toC.new_series_id])).rows[0];
    assert.ok(seriesC.excluded_occurrences.map(iso).includes(iso(retained.scheduled_for)));
    const live = await c.query("SELECT id, series_id FROM appointments WHERE workspace_id=$1 AND scheduled_for=$2 AND status<>'cancelled'", [fx.workspaceId, retained.scheduled_for]);
    assert.equal(live.rowCount, 1);
    assert.equal(live.rows[0].id, retained.id);
    assert.equal(live.rows[0].series_id, A.res.new_series_id, "still owned by series A (stopped)");

    // Replenishing C with a window that offers the retained instant (real
    // replenish_recurring_series): it is skipped, the genuinely new ones inserted.
    const before = (await c.query("SELECT count(*)::int AS n FROM appointments WHERE series_id=$1", [toC.new_series_id])).rows[0].n;
    const last = new Date((await seriesRows(fx.workspaceId, toC.new_series_id)).at(-1)!.scheduled_for);
    const offered = [new Date(retained.scheduled_for), ...[1, 2].map((n) => new Date(last.getTime() + n * 7 * DAY))];
    const r = await replenish(toC.new_series_id, fx.workspaceId, offered);
    assert.equal(r.outcome, "replenished", JSON.stringify(r));
    assert.equal(r.inserted_count, 2, "only the two genuinely new instants were inserted");
    assert.equal(r.skipped_count, 1, "the excluded instant was skipped");
    const after = (await c.query("SELECT count(*)::int AS n FROM appointments WHERE series_id=$1", [toC.new_series_id])).rows[0].n;
    assert.equal(after, before + 2);
    const atRetained = await c.query("SELECT count(*)::int AS n FROM appointments WHERE series_id=$1 AND scheduled_for=$2", [toC.new_series_id, retained.scheduled_for]);
    assert.equal(atRetained.rows[0].n, 0, "series C never gets a row at the retained instant, even from replenishment");
  });

  test("replenishment of a series with NO exclusions is unchanged (regression: the replaced function still inserts normally)", async () => {
    const fx = await makeWorkspace(c, { employees: 1 });
    const built = await convert(fx, { employees: [fx.employeeIds[0]], weeks: 2, start: futureNineAm(20) });
    const series = (await c.query("SELECT * FROM recurring_series WHERE id=$1", [built.res.new_series_id])).rows[0];
    assert.deepEqual(series.excluded_occurrences, []);
    const last = (await seriesRows(fx.workspaceId, built.res.new_series_id)).at(-1)!;
    const next = [1, 2].map((n) => new Date(new Date(last.scheduled_for).getTime() + n * 14 * DAY));
    const r = await replenish(built.res.new_series_id, fx.workspaceId, next);
    assert.equal(r.outcome, "replenished");
    assert.equal(r.inserted_count, 2);
  });
});

// ---------------------------------------------------------------------------
// one-time conversion of an existing series
// ---------------------------------------------------------------------------

describe("converting a series to one-time", () => {
  test("old tail replaced, old series stopped, no new series, no exclusions needed; operation recorded", async () => {
    const fx = await makeWorkspace(c, { employees: 1 });
    const built = await convert(fx, { employees: [fx.employeeIds[0]], weeks: 2 });
    const anchor = await getAppt(built.apptId);
    const res = await apply(c, fx, built.apptId, randomUUID(), requestFor(anchor, [fx.employeeIds[0]], { freq: "one_time" }), expectedFrom(anchor, [fx.employeeIds[0]]));
    assert.equal(res.outcome, "applied", JSON.stringify(res));
    assert.equal(res.new_series_id, null);
    assert.equal(res.old_series_stopped, true);
    assert.ok(res.cancelled_count > 0);
    const a = await getAppt(built.apptId);
    assert.equal(a.series_id, null);
    assert.equal(a.frequency_type, "one_time");
  });
});

// ---------------------------------------------------------------------------
// cleanup compatibility with the new foreign keys
// ---------------------------------------------------------------------------

describe("deletion and cleanup remain compatible with the new foreign keys", () => {
  test("hard-deleting an appointment cascades its operation records; hours and assignments still cascade", async () => {
    const fx = await makeWorkspace(c);
    const apptId = await makeAppointment(c, fx, { scheduledFor: futureNineAm() });
    const appt = await getAppt(apptId);
    const opId = randomUUID();
    const res = await apply(c, fx, apptId, opId, requestFor(appt, [], { freq: "one_time" }), expectedFrom(appt, []));
    assert.equal(res.outcome, "applied");
    await c.query("DELETE FROM appointments WHERE id = $1", [apptId]);
    assert.equal((await c.query("SELECT 1 FROM recurrence_change_operations WHERE id=$1", [opId])).rowCount, 0);
  });

  test("the demo-reset order (appointments, then clients, employees) is not blocked by operation records or superseded_series_id", async () => {
    const fx = await makeWorkspace(c, { employees: 1 });
    const A = await convert(fx, { employees: [fx.employeeIds[0]], weeks: 2 });
    const anchor = await getAppt(A.apptId);
    await apply(c, fx, A.apptId, randomUUID(), requestFor(anchor, [fx.employeeIds[0]], { weeks: 1 }), expectedFrom(anchor, [fx.employeeIds[0]]));
    // recurring_series rows are removed first (as any cleanup of series data must,
    // since 026's own client_id RESTRICT and template SET NULL rules are unchanged)
    await c.query("DELETE FROM recurring_series WHERE workspace_id = $1", [fx.workspaceId]);
    await c.query("DELETE FROM appointments WHERE workspace_id = $1", [fx.workspaceId]);
    assert.equal((await c.query("SELECT 1 FROM recurrence_change_operations WHERE workspace_id=$1", [fx.workspaceId])).rowCount, 0);
    await c.query("DELETE FROM clients WHERE workspace_id = $1", [fx.workspaceId]);
    await c.query("DELETE FROM employees WHERE workspace_id = $1", [fx.workspaceId]);
  });

  test("deleting a superseded series row nulls the lineage pointer instead of failing", async () => {
    const fx = await makeWorkspace(c, { employees: 1 });
    const A = await convert(fx, { employees: [fx.employeeIds[0]], weeks: 2 });
    const anchor = await getAppt(A.apptId);
    const toB = await apply(c, fx, A.apptId, randomUUID(), requestFor(anchor, [fx.employeeIds[0]], { weeks: 1 }), expectedFrom(anchor, [fx.employeeIds[0]]));
    await c.query("UPDATE appointments SET series_id = NULL WHERE series_id = $1", [A.res.new_series_id]);
    await c.query("UPDATE recurring_series SET template_appointment_id = template_appointment_id WHERE id = $1", [toB.new_series_id]);
    await c.query("DELETE FROM recurring_series WHERE id = $1", [A.res.new_series_id]);
    const b = (await c.query("SELECT superseded_series_id FROM recurring_series WHERE id=$1", [toB.new_series_id])).rows[0];
    assert.equal(b.superseded_series_id, null);
  });
});
