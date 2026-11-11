// Capacity fixes D1 + D2 (docs/CAPACITY_PRICING_REPORT.md section 8), tested
// together against a REAL PostgreSQL built from the exported production
// schema plus migrations 029-041. Application code runs unchanged; only
// @/lib/supabaseAdmin is swapped for test-db/postgrestAdapter.ts, which keeps
// PostgREST's 1000-row response cap and lets a test fail any single page.
//
// Requires TEST_DB_SCHEMA_FILE (the gitignored production schema export,
// see test-db/SCHEMA_VALIDATION.md); skipped without it.
//
//   TEST_DB_SCHEMA_FILE=test-db/production-schema.sql npm run test:db:capacity
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
import { createPostgrestAdapter, MAX_ROWS, POSTGREST_TYPES, type AdapterCall } from "./postgrestAdapter.ts";

register("./tsx-mock-load-hook.mjs", import.meta.url);

process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaFile = process.env.TEST_DB_SCHEMA_FILE ? path.resolve(ROOT, process.env.TEST_DB_SCHEMA_FILE) : "";
const SKIP = !schemaFile || !existsSync(schemaFile) ? "TEST_DB_SCHEMA_FILE (production schema export) not provided" : false;

const TZ = "America/New_York";

// ---------------------------------------------------------------------------
// Module mocks: the database client and the dashboard page's session/UI deps.
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
mock.module("@/lib/session", {
  namedExports: { getSession: async () => ({ role: "owner", workspaceId: sessionWorkspace, authUserId: "owner-1" }) },
});
mock.module("@/lib/sessionEpoch", {
  namedExports: { requireCurrentOwnerSession: async () => ({ ok: true }) },
});
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
  namedExports: { fetchEntitlementForWorkspace: async () => INTERNAL },
});
function ShellStub() {
  return null;
}
mock.module("@/app/components/dashboard/DashboardShell", { defaultExport: ShellStub });
for (const name of ["LockedReactivationScreen", "TemporaryUnavailableScreen", "TrialActivationScreen"]) {
  mock.module(`@/app/components/dashboard/${name}`, { defaultExport: () => null });
}
mock.module("next/navigation", { namedExports: { redirect: () => { throw new Error("redirect"); } } });

const { default: DashboardPage } = await import("../app/dashboard/page.tsx");
const { runReplenishmentPass, FAILURE_BUCKET_PREFIX, FAILURE_MAX_ATTEMPTS, REPLENISH_TARGET_COVERAGE_DAYS, REPLENISH_THRESHOLD_DAYS } = await import("../lib/recurringSeriesReplenishmentOrchestrator.ts");
// A tail this far out never needs a top-up under the rolling horizon.
const COVERED = REPLENISH_THRESHOLD_DAYS + 15;
const { excludeSeriesOccurrence } = await import("../lib/seriesOccurrenceExclusion.ts");

let db: TestDb;
let pool: pg.Pool;
let c: pg.Client;

function installClient(failWhen?: (call: AdapterCall) => boolean) {
  const adapter = createPostgrestAdapter(pool, { failWhen });
  currentClient = adapter.client;
  return adapter;
}

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
    ],
  });
  c = await db.connect();
  pool = new pg.Pool({ host: "127.0.0.1", port: db.port, user: "postgres", password: "test", database: "postgres", max: 12, types: POSTGREST_TYPES as any });
  pool.on("connect", (client) => client.query("SET TIME ZONE 'UTC'"));
});
after(async () => {
  if (SKIP) return;
  await pool.end();
  await c.end();
  await db.stop();
});

// ---------------------------------------------------------------------------
// Fixtures: fictional cleaning businesses. One weekly recurring series per
// client; history from ~52 weeks ago; the live tail ends `tailDays` from now.
// Every existing job has both workspace employees assigned.
// ---------------------------------------------------------------------------
type SeededWs = { id: string; employees: string[]; series: { id: string; tailDays: number }[] };

async function seedWorkspace(name: string, tails: number[]): Promise<SeededWs> {
  const { rows: [w] } = await c.query("INSERT INTO workspaces (id, name) VALUES (gen_random_uuid(), $1) RETURNING id", [name]);
  const ws = w.id as string;
  await c.query("INSERT INTO company_settings (workspace_id, timezone) VALUES ($1, $2)", [ws, TZ]);
  const { rows: emps } = await c.query(
    "INSERT INTO employees (id, workspace_id, name) SELECT gen_random_uuid(), $1::uuid, 'Member ' || m FROM generate_series(1,2) m RETURNING id",
    [ws]
  );
  await c.query("DROP TABLE IF EXISTS plan; CREATE TEMP TABLE plan (idx int, client uuid, series uuid, anchor_date date, anchor_time time, tail_days int)");
  await c.query(
    `INSERT INTO plan SELECT i::int, gen_random_uuid(), gen_random_uuid(),
            (now() AT TIME ZONE $2::text)::date - 364 + (i::int % 7), make_time(8 + (i::int % 3) * 3, 0, 0), t
     FROM unnest($1::int[]) WITH ORDINALITY AS u(t, i)`,
    [tails, TZ]
  );
  await c.query(
    `INSERT INTO clients (id, workspace_id, name, status) SELECT client, $1::uuid, $2 || ' client ' || idx, 'active' FROM plan`,
    [ws, name]
  );
  await c.query(
    `INSERT INTO recurring_series (id, workspace_id, status, client_id, is_demo, frequency_type, repeat_weeks,
        anchor_local_date, anchor_local_time, anchor_timezone, source)
     SELECT series, $1::uuid, 'review_required', client, false, 'weekly', 1, anchor_date, anchor_time, $2::text, 'owner_created' FROM plan`,
    [ws, TZ]
  );
  await c.query(
    `INSERT INTO appointments (id, workspace_id, client_id, service_type, scheduled_for, scheduled_end, duration_minutes,
        status, cancel_token, series_id, frequency_type, repeat_weeks, price_cents, is_demo)
     SELECT gen_random_uuid(), $1::uuid, p.client, 'Regular Cleaning', s.slot, s.slot + interval '150 minutes', 150,
            'scheduled', md5(random()::text), p.series, 'weekly', 1, 16000, false
     FROM plan p
     CROSS JOIN LATERAL (SELECT ((p.anchor_date + 7 * k) + p.anchor_time) AT TIME ZONE $2::text AS slot FROM generate_series(0, 90) k) s
     WHERE s.slot <= now() + p.tail_days * interval '1 day'`,
    [ws, TZ]
  );
  await c.query(
    `UPDATE recurring_series rs SET status = 'active', snapshot_service_type = 'Regular Cleaning', snapshot_duration_minutes = 150,
        snapshot_price_cents = 16000, snapshot_employee_ids = $2::uuid[], snapshot_updated_at = now(), reviewed_at = now(),
        review_reason = NULL,
        template_appointment_id = (SELECT id FROM appointments a WHERE a.series_id = rs.id ORDER BY scheduled_for DESC LIMIT 1)
     WHERE rs.workspace_id = $1::uuid`,
    [ws, emps.map((e) => e.id)]
  );
  await c.query(
    `INSERT INTO appointment_employees (appointment_id, employee_id, workspace_id)
     SELECT a.id, e.id, a.workspace_id FROM appointments a JOIN employees e ON e.workspace_id = a.workspace_id WHERE a.workspace_id = $1::uuid`,
    [ws]
  );
  const { rows: series } = await c.query("SELECT series AS id, tail_days FROM plan ORDER BY idx");
  return { id: ws, employees: emps.map((e) => e.id), series: series.map((s) => ({ id: s.id, tailDays: s.tail_days })) };
}

async function snapshotRows(wsIds: string[]) {
  const appts = await c.query(
    "SELECT id, workspace_id, client_id, series_id, scheduled_for, scheduled_end, status, service_type, price_cents FROM appointments WHERE workspace_id = ANY($1::uuid[]) ORDER BY id",
    [wsIds]
  );
  const asg = await c.query(
    "SELECT id, appointment_id, employee_id, workspace_id, actual_started_at, actual_completed_at, job_notes FROM appointment_employees WHERE workspace_id = ANY($1::uuid[]) ORDER BY id",
    [wsIds]
  );
  return { appts: appts.rows, asg: asg.rows };
}

// Independent expectation (SQL, not the app's generator): weekly slots after
// the live tail, through now + the rolling horizon, at most 20.
async function expectedNewSlots(seriesId: string): Promise<string[]> {
  const { rows } = await c.query(
    `WITH s AS (SELECT * FROM recurring_series WHERE id = $1),
          tail AS (SELECT GREATEST(now(), COALESCE(max(scheduled_for), now())) AS t FROM appointments WHERE series_id = $1 AND status = 'scheduled')
     SELECT slot FROM s, tail,
       LATERAL (SELECT ((s.anchor_local_date + 7 * k) + s.anchor_local_time) AT TIME ZONE s.anchor_timezone AS slot FROM generate_series(0, 200) k) g
     WHERE g.slot > tail.t AND g.slot <= now() + make_interval(days => $2::int)
       AND g.slot <> ALL (s.excluded_occurrences)
     ORDER BY slot LIMIT 20`,
    [seriesId, REPLENISH_TARGET_COVERAGE_DAYS]
  );
  return rows.map((r) => r.slot.toISOString());
}

const permitted = async () => INTERNAL;

// ---------------------------------------------------------------------------
describe("D1: the owner dashboard loads every required row past 1,000, and never a partial schedule", { skip: SKIP }, () => {
  let main: SeededWs;
  let other: SeededWs;

  before(async () => {
    // Tails past the threshold: these series never need a top-up, so later suites' counts stay exact.
    main = await seedWorkspace("Dash main", Array.from({ length: 20 }, () => COVERED));
    other = await seedWorkspace("Dash other", [COVERED, COVERED]);
    // > 1000 clients (one-time clients without series).
    await c.query(
      "INSERT INTO clients (id, workspace_id, name, status) SELECT gen_random_uuid(), $1::uuid, 'One-off ' || lpad(i::text, 4, '0'), 'active' FROM generate_series(1, 1040) i",
      [main.id]
    );
    // Two clients with the same name, to prove the id tiebreaker.
    await c.query("INSERT INTO clients (id, workspace_id, name, status) SELECT gen_random_uuid(), $1::uuid, 'Same Name', 'active' FROM generate_series(1, 3)", [main.id]);
    // > 1000 manual-hours rows.
    await c.query(
      `INSERT INTO appointment_employee_hours (appointment_id, employee_id, workspace_id, hours_worked, note)
       SELECT ae.appointment_id, ae.employee_id, ae.workspace_id, 2.5, 'manual'
       FROM appointment_employees ae JOIN appointments a ON a.id = ae.appointment_id
       WHERE ae.workspace_id = $1::uuid AND a.scheduled_for < now()
       ORDER BY a.scheduled_for LIMIT 1100`,
      [main.id]
    );
  });

  async function render(wsId: string, failWhen?: (call: AdapterCall) => boolean) {
    const adapter = installClient(failWhen);
    sessionWorkspace = wsId;
    const element: any = await DashboardPage();
    return { element, adapter };
  }

  test("fixture really exceeds the 1,000-row response cap on every paginated read", async () => {
    const n = async (sql: string) => Number((await c.query(sql, [main.id])).rows[0].n);
    assert.ok((await n("SELECT count(*) n FROM appointment_employees WHERE workspace_id = $1")) > MAX_ROWS);
    assert.ok((await n("SELECT count(*) n FROM appointment_employee_hours WHERE workspace_id = $1")) > MAX_ROWS);
    assert.ok((await n("SELECT count(*) n FROM clients WHERE workspace_id = $1")) > MAX_ROWS);
    assert.ok((await n("SELECT count(*) n FROM appointments WHERE workspace_id = $1")) > MAX_ROWS);
    // Every assignment row shares one created_at: the id tiebreaker is what keeps pages stable.
    assert.equal(await n("SELECT count(DISTINCT created_at) n FROM appointment_employees WHERE workspace_id = $1"), 1);
  });

  test("every assignment, manual-hours row, client and appointment reaches the dashboard exactly once -- and only this workspace's", async () => {
    const { element } = await render(main.id);
    assert.equal(element.type, ShellStub);
    const props = element.props;
    const ids = (sql: string) => c.query(sql, [main.id]).then((r) => r.rows.map((x) => x.id).sort());
    const sortIds = (xs: { id: string }[]) => xs.map((x) => x.id).sort();
    assert.deepEqual(sortIds(props.assignments), await ids("SELECT id FROM appointment_employees WHERE workspace_id = $1"));
    assert.deepEqual(sortIds(props.employeeHours), await ids("SELECT id FROM appointment_employee_hours WHERE workspace_id = $1"));
    assert.deepEqual(sortIds(props.clients), await ids("SELECT id FROM clients WHERE workspace_id = $1 AND is_demo = false"));
    assert.deepEqual(sortIds(props.appointments), await ids("SELECT id FROM appointments WHERE workspace_id = $1 AND is_demo = false"));
    for (const list of [props.assignments, props.employeeHours, props.clients, props.appointments]) {
      assert.equal(new Set(sortIds(list)).size, list.length, "no row appears twice");
    }
    // Every today/future job shows both of its employees (the original D1 symptom).
    const byAppt = new Map<string, number>();
    for (const a of props.assignments) byAppt.set(a.appointment_id, (byAppt.get(a.appointment_id) ?? 0) + 1);
    const future = props.appointments.filter((a: any) => new Date(a.scheduled_for) >= new Date());
    assert.ok(future.length > 0);
    for (const a of future) assert.equal(byAppt.get(a.id), 2, `future job ${a.id} must show both employees`);
    // Workspace isolation.
    const { rows: foreign } = await c.query(
      "SELECT id FROM appointment_employees WHERE workspace_id = $1 UNION ALL SELECT id FROM clients WHERE workspace_id = $1 UNION ALL SELECT id FROM appointments WHERE workspace_id = $1",
      [other.id]
    );
    const shown = new Set([...props.assignments, ...props.clients, ...props.appointments].map((x: any) => x.id));
    for (const f of foreign) assert.ok(!shown.has(f.id), "another workspace's row was shown");
  });

  test("clients with the same name keep a stable order across pages (name, then id)", async () => {
    const { element } = await render(main.id);
    const same = element.props.clients.filter((x: any) => x.name === "Same Name").map((x: any) => x.id);
    assert.deepEqual(same, [...same].sort());
  });

  for (const [table, page] of [
    ["appointment_employees", 2],
    ["appointment_employee_hours", 2],
    ["clients", 2],
    ["appointments", 2],
    ["appointment_employees", 1],
  ] as const) {
    test(`a failure on page ${page} of ${table} shows the load-error screen, never a partial schedule`, async () => {
      const { element, adapter } = await render(main.id, (call) => call.kind === "select" && call.table === table && call.seq === page);
      assert.notEqual(element.type, ShellStub);
      assert.equal(element.type.name, "DashboardLoadErrorScreen");
      assert.ok(adapter.calls.some((call) => call.table === table && call.seq === page), "the injected failure was reached");
    });
  }
});

// ---------------------------------------------------------------------------
describe("D2: fair top-up across all workspaces, beyond 100 series, on the real RPC", { skip: SKIP }, () => {
  let A: SeededWs, B: SeededWs, C: SeededWs, R: SeededWs;
  let before1: Awaited<ReturnType<typeof snapshotRows>>;
  const expected = new Map<string, string[]>();
  let summary: Awaited<ReturnType<typeof runReplenishmentPass>>;

  // 70 series per workspace: 50 need a top-up (tail 0-29 days), 20 do not (past the threshold).
  const tails = Array.from({ length: 70 }, (_, i) => (i < 50 ? i % 30 : COVERED));

  before(async () => {
    A = await seedWorkspace("Top-up A", tails);
    B = await seedWorkspace("Top-up B", tails);
    C = await seedWorkspace("Top-up C", tails);
    R = await seedWorkspace("Top-up restricted", tails.slice(0, 10));
    before1 = await snapshotRows([A.id, B.id, C.id, R.id]);
    for (const ws of [A, B, C]) for (const s of ws.series.filter((x) => x.tailDays < REPLENISH_THRESHOLD_DAYS)) expected.set(s.id, await expectedNewSlots(s.id));
    const { rows } = await c.query("SELECT count(*) n FROM appointments WHERE status = 'scheduled' AND series_id IS NOT NULL");
    assert.ok(Number(rows[0].n) > 10 * MAX_ROWS, "scheduled history far exceeds one response");
    installClient();
    summary = await runReplenishmentPass({
      dryRun: false,
      fetchEntitlement: async (ws) => (ws === R.id ? RESTRICTED : INTERNAL),
    });
  });

  test("all 150 series needing a top-up in entitled workspaces are processed in ONE run (more than 100)", () => {
    assert.ok(summary.counts.activeSeriesExamined >= 220);
    assert.equal(summary.counts.replenished, 150);
    assert.equal(summary.counts.deferredByProcessingLimit, 0);
    assert.equal(summary.counts.safeFailures, 0);
    assert.equal(summary.counts.skippedEntitlementRestricted, 10);
  });

  test("each processed series gets exactly the expected new weekly slots -- right local time, both snapshot employees, its own workspace", async () => {
    for (const ws of [A, B, C]) {
      for (const s of ws.series.filter((x) => x.tailDays < REPLENISH_THRESHOLD_DAYS)) {
        const { rows } = await c.query(
          `SELECT a.id, a.scheduled_for, a.workspace_id, (a.scheduled_for AT TIME ZONE $2)::time AS local_time, rs.anchor_local_time,
                  array_agg(ae.employee_id ORDER BY ae.employee_id) AS emps, array_agg(DISTINCT ae.workspace_id) AS asg_ws
           FROM appointments a JOIN recurring_series rs ON rs.id = a.series_id
           LEFT JOIN appointment_employees ae ON ae.appointment_id = a.id
           WHERE a.series_id = $1 AND a.id <> ALL($3::uuid[])
           GROUP BY a.id, rs.anchor_local_time ORDER BY a.scheduled_for`,
          [s.id, TZ, before1.appts.map((x) => x.id)]
        );
        assert.deepEqual(rows.map((r) => r.scheduled_for.toISOString()), expected.get(s.id), `series ${s.id}`);
        for (const r of rows) {
          assert.equal(r.workspace_id, ws.id);
          assert.equal(r.local_time, r.anchor_local_time, "keeps the series' local time (across DST)");
          assert.deepEqual(r.emps, [...ws.employees].sort());
          assert.deepEqual(r.asg_ws, [ws.id]);
        }
      }
    }
  });

  test("existing appointments, times and assignments are unchanged; restricted and sufficiently covered series get nothing", async () => {
    const after1 = await snapshotRows([A.id, B.id, C.id, R.id]);
    const afterById = new Map(after1.appts.map((x) => [x.id, x]));
    for (const row of before1.appts) assert.deepEqual(afterById.get(row.id), row);
    const asgById = new Map(after1.asg.map((x) => [x.id, x]));
    for (const row of before1.asg) assert.deepEqual(asgById.get(row.id), row);
    const added = (wsId: string) => after1.appts.filter((x) => x.workspace_id === wsId).length - before1.appts.filter((x) => x.workspace_id === wsId).length;
    assert.equal(added(R.id), 0);
    for (const ws of [A, B, C]) {
      for (const s of ws.series.filter((x) => x.tailDays >= REPLENISH_THRESHOLD_DAYS)) {
        const n = after1.appts.filter((x) => x.series_id === s.id).length;
        const m = before1.appts.filter((x) => x.series_id === s.id).length;
        assert.equal(n, m);
      }
    }
  });

  test("a second run only continues after the first batch (bounded, 26-week window): no duplicates, nothing re-created, existing rows untouched", async () => {
    const wsIds = [A.id, B.id, C.id, R.id];
    const mid = await snapshotRows(wsIds);
    installClient();
    const s2 = await runReplenishmentPass({ dryRun: false, fetchEntitlement: async (ws) => (ws === R.id ? RESTRICTED : INTERNAL) });
    assert.ok(s2.counts.occurrencesInserted <= s2.counts.replenished * 20, "never more than 20 per series per run");
    const after2 = await snapshotRows(wsIds);
    const byId = new Map(after2.appts.map((x) => [x.id, x]));
    for (const row of mid.appts) assert.deepEqual(byId.get(row.id), row, "an existing row changed");
    const lastBefore = new Map<string, number>();
    for (const r of mid.appts) if (r.series_id) lastBefore.set(r.series_id, Math.max(lastBefore.get(r.series_id) ?? 0, new Date(r.scheduled_for).getTime()));
    const midIds = new Set(mid.appts.map((x) => x.id));
    for (const r of after2.appts.filter((x) => !midIds.has(x.id))) {
      assert.ok(new Date(r.scheduled_for).getTime() > lastBefore.get(r.series_id)!, "a new visit landed before the existing tail");
      assert.ok(new Date(r.scheduled_for).getTime() <= Date.now() + REPLENISH_TARGET_COVERAGE_DAYS * 86400000, "past the rolling window");
    }
    assert.equal(after2.appts.filter((x) => x.workspace_id === R.id).length, mid.appts.filter((x) => x.workspace_id === R.id).length);
    const { rows: dup } = await c.query(
      "SELECT series_id, scheduled_for, count(*) FROM appointments WHERE workspace_id = ANY($1::uuid[]) GROUP BY 1, 2 HAVING count(*) > 1",
      [wsIds]
    );
    assert.deepEqual(dup, []);
  });
});

// ---------------------------------------------------------------------------
describe("D2: overlapping cron runs never create duplicate appointments", { skip: SKIP }, () => {
  test("two runs at once over 60 needing series insert each slot exactly once", async () => {
    const D = await seedWorkspace("Overlap D", Array.from({ length: 30 }, (_, i) => i % 25));
    const E = await seedWorkspace("Overlap E", Array.from({ length: 30 }, (_, i) => i % 25));
    const exp = new Map<string, string[]>();
    for (const ws of [D, E]) for (const s of ws.series) exp.set(s.id, await expectedNewSlots(s.id));
    const beforeIds = (await c.query("SELECT id FROM appointments WHERE workspace_id = ANY($1::uuid[])", [[D.id, E.id]])).rows.map((r) => r.id);
    // Only D and E may be topped up here (everything seeded earlier is either
    // already covered or restricted), so the runs' insert totals are exact.
    const onlyDE = async (ws: string) => (ws === D.id || ws === E.id ? INTERNAL : RESTRICTED);
    installClient();
    const [r1, r2] = await Promise.all([
      runReplenishmentPass({ dryRun: false, fetchEntitlement: onlyDE }),
      runReplenishmentPass({ dryRun: false, fetchEntitlement: onlyDE }),
    ]);
    const expectedTotal = [...exp.values()].reduce((n, v) => n + v.length, 0);
    assert.equal(r1.counts.occurrencesInserted + r2.counts.occurrencesInserted, expectedTotal);
    const added = await c.query("SELECT count(*) n FROM appointments WHERE workspace_id = ANY($1::uuid[]) AND id <> ALL($2::uuid[])", [[D.id, E.id], beforeIds]);
    assert.equal(Number(added.rows[0].n), expectedTotal);
    // Evidence the runs really overlapped on the same series: the slower run
    // found slots already taken (idempotent skips) or a changed snapshot.
    console.log("OVERLAP_EVIDENCE", JSON.stringify({ r1: { ins: r1.counts.occurrencesInserted, skip: r1.counts.occurrencesSkippedIdempotent, conflicts: r1.counts.conflicts }, r2: { ins: r2.counts.occurrencesInserted, skip: r2.counts.occurrencesSkippedIdempotent, conflicts: r2.counts.conflicts } }));
    for (const [seriesId, slots] of exp) {
      const { rows } = await c.query(
        "SELECT scheduled_for FROM appointments WHERE series_id = $1 AND id <> ALL($2::uuid[]) ORDER BY scheduled_for",
        [seriesId, beforeIds]
      );
      assert.deepEqual(rows.map((r) => r.scheduled_for.toISOString()), slots);
    }
    const { rows: dup } = await c.query(
      "SELECT series_id, (scheduled_for AT TIME ZONE $1)::date d, count(*) FROM appointments WHERE workspace_id = ANY($2::uuid[]) GROUP BY 1, 2 HAVING count(*) > 1",
      [TZ, [D.id, E.id]]
    );
    assert.deepEqual(dup, []);
  });
});

// ---------------------------------------------------------------------------
describe("Approved: a moved or cancelled final occurrence is never recreated by a top-up", { skip: SKIP }, () => {
  let F: SeededWs;
  const finalOf = async (seriesId: string) =>
    (await c.query("SELECT id, scheduled_for, workspace_id FROM appointments WHERE series_id = $1 ORDER BY scheduled_for DESC LIMIT 1", [seriesId])).rows[0];
  const slotsOf = async (seriesId: string) =>
    (await c.query("SELECT id, scheduled_for, status FROM appointments WHERE series_id = $1 ORDER BY scheduled_for", [seriesId])).rows;

  let moved: { id: string; original: string; to: string };
  let legacyMoved: { id: string; original: string; to: string };
  let cancelled: { id: string; original: string };
  let reviewFindings: { legacyFlagged: boolean; recordedMoveFlagged: boolean };

  before(async () => {
    F = await seedWorkspace("Moves F", [10, 10, 10]);
    installClient();
    // F1: final occurrence moved two days earlier -- the route's order: skip first, then move.
    const f1 = await finalOf(F.series[0].id);
    assert.equal(await excludeSeriesOccurrence(F.series[0].id, F.id, f1.scheduled_for.toISOString()), "excluded");
    const to1 = new Date(f1.scheduled_for.getTime() - 2 * 86400000);
    await c.query("UPDATE appointments SET scheduled_for = $2, scheduled_end = $2::timestamptz + interval '150 minutes' WHERE id = $1", [f1.id, to1]);
    moved = { id: f1.id, original: f1.scheduled_for.toISOString(), to: to1.toISOString() };
    // F2 (control, legacy): the same move made before this fix -- no skip recorded.
    const f2 = await finalOf(F.series[1].id);
    const to2 = new Date(f2.scheduled_for.getTime() - 2 * 86400000);
    await c.query("UPDATE appointments SET scheduled_for = $2, scheduled_end = $2::timestamptz + interval '150 minutes' WHERE id = $1", [f2.id, to2]);
    legacyMoved = { id: f2.id, original: f2.scheduled_for.toISOString(), to: to2.toISOString() };
    // F3: final occurrence cancelled ("delete one").
    const f3 = await finalOf(F.series[2].id);
    assert.equal(await excludeSeriesOccurrence(F.series[2].id, F.id, f3.scheduled_for.toISOString()), "excluded");
    await c.query("UPDATE appointments SET status = 'cancelled' WHERE id = $1", [f3.id]);
    cancelled = { id: f3.id, original: f3.scheduled_for.toISOString() };

    // The read-only pre-enable review (test-db/capacity-production-check.sql
    // section 4) must flag the legacy move and not the recorded one.
    const sqlFile = readFileSync(path.join(ROOT, "test-db", "capacity-production-check.sql"), "utf8");
    const review = await c.query(sqlFile.slice(sqlFile.indexOf("WITH s AS (")));
    const forSeries = (id: string) => review.rows.filter((r) => r.series_id === id);
    const legacyRows = forSeries(F.series[1].id);
    const legacyFlag = legacyRows.find((r) => r.nearby_off_pattern_jobs_review);
    assert.ok(legacyFlag, "review must flag the legacy move's vacated slot");
    reviewFindings = { legacyFlagged: true, recordedMoveFlagged: forSeries(F.series[0].id).some((r) => r.nearby_off_pattern_jobs_review) };

    await runReplenishmentPass({ dryRun: false, fetchEntitlement: permitted });
  });

  test("moved final occurrence: its original slot is NOT recreated, the moved job keeps its new time, the series continues", async () => {
    const rows = await slotsOf(F.series[0].id);
    const times = rows.map((r) => r.scheduled_for.toISOString());
    assert.ok(!times.includes(moved.original), "the vacated original slot must not come back");
    assert.equal(rows.find((r) => r.id === moved.id).scheduled_for.toISOString(), moved.to);
    assert.ok(times.some((t) => t > moved.original), "later weekly occurrences are still added");
  });

  test("CONTROL -- a legacy move with no skip recorded IS recreated (why live mode must stay off until reviewed)", async () => {
    const times = (await slotsOf(F.series[1].id)).map((r) => r.scheduled_for.toISOString());
    assert.ok(times.includes(legacyMoved.original), "documents the pre-fix duplicate-visit risk");
    assert.ok(times.includes(legacyMoved.to));
  });

  test("cancelled final occurrence: stays cancelled, is not recreated, later occurrences are added", async () => {
    const rows = await slotsOf(F.series[2].id);
    const atOriginal = rows.filter((r) => r.scheduled_for.toISOString() === cancelled.original);
    assert.equal(atOriginal.length, 1);
    assert.equal(atOriginal[0].status, "cancelled");
    assert.ok(rows.some((r) => r.scheduled_for.toISOString() > cancelled.original && r.status === "scheduled"));
  });

  test("the pre-enable review query flags the legacy move's slot, not the properly recorded move", () => {
    assert.equal(reviewFindings.legacyFlagged, true);
    assert.equal(reviewFindings.recordedMoveFlagged, false);
  });

  test("skips are recorded on the series' own workspace row only", async () => {
    const { rows } = await c.query("SELECT id, workspace_id, cardinality(excluded_occurrences) n FROM recurring_series WHERE id = ANY($1::uuid[])", [F.series.map((s) => s.id)]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(F.series[0].id).n, 1);
    assert.equal(byId.get(F.series[1].id).n, 0);
    assert.equal(byId.get(F.series[2].id).n, 1);
    assert.equal(await excludeSeriesOccurrence(F.series[0].id, "00000000-0000-0000-0000-000000000000", moved.original), "no_series");
  });

  test("concurrent skips on the same series are both kept (compare-and-set, no lost update)", async () => {
    const s = F.series[1].id;
    const future = [3, 4, 5, 6].map((d) => new Date(Date.now() + d * 86400000).toISOString());
    installClient();
    const results = await Promise.all(future.map((iso) => excludeSeriesOccurrence(s, F.id, iso)));
    for (const r of results) assert.ok(r === "excluded" || r === "conflict", r);
    const { rows } = await c.query("SELECT excluded_occurrences FROM recurring_series WHERE id = $1", [s]);
    const kept = new Set(rows[0].excluded_occurrences.map((d: Date) => d.toISOString()));
    for (let i = 0; i < future.length; i++) if (results[i] === "excluded") assert.ok(kept.has(future[i]), "an acknowledged skip was lost");
  });
});

// ---------------------------------------------------------------------------
describe("D2: failures partway through and bounded retries", { skip: SKIP }, () => {
  test("one series failing every run is retried a bounded number of times, then backed off; the others progress", async () => {
    const G = await seedWorkspace("Failing G", [5, 5, 5]);
    const bad = G.series[0].id;
    const failWhen = (call: AdapterCall) => call.kind === "rpc" && call.table === "replenish_recurring_series" && (call.args as any)?.p_series_id === bad;

    installClient(failWhen);
    const r1 = await runReplenishmentPass({ dryRun: false, fetchEntitlement: permitted });
    assert.ok(r1.counts.safeFailures >= 1);
    const first = await c.query("SELECT attempt_count FROM rate_limit_counters WHERE bucket_key = $1", [FAILURE_BUCKET_PREFIX + bad]);
    assert.equal(first.rows[0].attempt_count, 1);
    const good = await c.query("SELECT count(*) n FROM appointments WHERE series_id = ANY($1::uuid[]) AND scheduled_for > now() + interval '30 days'", [[G.series[1].id, G.series[2].id]]);
    assert.ok(Number(good.rows[0].n) > 0, "the healthy series in the same workspace were topped up in the same run");

    for (let run = 2; run <= FAILURE_MAX_ATTEMPTS; run++) {
      installClient(failWhen);
      await runReplenishmentPass({ dryRun: false, fetchEntitlement: permitted });
    }
    const { rows } = await c.query("SELECT attempt_count, locked_until FROM rate_limit_counters WHERE bucket_key = $1", [FAILURE_BUCKET_PREFIX + bad]);
    assert.equal(rows[0].attempt_count, FAILURE_MAX_ATTEMPTS);
    assert.ok(rows[0].locked_until > new Date());

    const adapter = installClient(failWhen);
    const r4 = await runReplenishmentPass({ dryRun: false, fetchEntitlement: permitted });
    assert.ok(r4.counts.backedOffAfterFailures >= 1);
    assert.ok(!adapter.calls.some((call) => call.kind === "rpc" && (call.args as any)?.p_series_id === bad), "no attempt while backed off");

    // Once the series works again (after its lockout), success clears the record.
    await c.query("UPDATE rate_limit_counters SET locked_until = now() - interval '1 minute' WHERE bucket_key = $1", [FAILURE_BUCKET_PREFIX + bad]);
    installClient();
    const r5 = await runReplenishmentPass({ dryRun: false, fetchEntitlement: permitted });
    assert.ok(r5.counts.replenished >= 1);
    const cleared = await c.query("SELECT 1 FROM rate_limit_counters WHERE bucket_key = $1", [FAILURE_BUCKET_PREFIX + bad]);
    assert.equal(cleared.rowCount, 0);
  });

  test("a failure on page 2 of the active-series read aborts the run before ANY write (fail closed)", async () => {
    const H = await seedWorkspace("Pages H", Array.from({ length: 5 }, () => 3));
    // Enough active series in total for a second page.
    const { rows } = await c.query("SELECT count(*) n FROM recurring_series WHERE status = 'active'");
    if (Number(rows[0].n) <= MAX_ROWS) {
      await seedWorkspace("Pages filler", Array.from({ length: MAX_ROWS + 1 - Number(rows[0].n) }, () => COVERED));
    }
    const beforeCount = Number((await c.query("SELECT count(*) n FROM appointments WHERE workspace_id = $1", [H.id])).rows[0].n);
    installClient((call) => call.kind === "select" && call.table === "recurring_series" && call.seq === 2);
    await assert.rejects(runReplenishmentPass({ dryRun: false, fetchEntitlement: permitted }));
    assert.equal(Number((await c.query("SELECT count(*) n FROM appointments WHERE workspace_id = $1", [H.id])).rows[0].n), beforeCount);

    // And without the failure, a second page is read and processed.
    const adapter = installClient();
    const ok = await runReplenishmentPass({ dryRun: false, fetchEntitlement: permitted });
    assert.ok(adapter.calls.some((call) => call.table === "recurring_series" && call.seq === 2));
    assert.ok(ok.counts.activeSeriesExamined > MAX_ROWS);
    assert.ok(Number((await c.query("SELECT count(*) n FROM appointments WHERE workspace_id = $1", [H.id])).rows[0].n) > beforeCount);
  });

  test("dry run reads everything but writes nothing (production stays in dry-run until reviewed)", async () => {
    const I = await seedWorkspace("Dry I", [2, 2]);
    const snap = await snapshotRows([I.id]);
    const counters = Number((await c.query("SELECT count(*) n FROM rate_limit_counters")).rows[0].n);
    installClient();
    const r = await runReplenishmentPass({ dryRun: true, fetchEntitlement: permitted });
    assert.ok(r.counts.wouldRequestOccurrencesTotal > 0);
    assert.deepEqual(await snapshotRows([I.id]), snap);
    assert.equal(Number((await c.query("SELECT count(*) n FROM rate_limit_counters")).rows[0].n), counters);
  });
});
