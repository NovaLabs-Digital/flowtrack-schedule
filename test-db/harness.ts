// Disposable real-PostgreSQL harness for test-db/*.test.ts.
//
// Boots an isolated PostgreSQL (the `embedded-postgres` devDependency ships
// real PostgreSQL binaries) on a random local port in a throwaway temp data
// directory, applies test-db/baseline.sql, then the REAL migration files from
// migrations/ in order, exactly as written. Nothing here can reach a shared
// or production database: the only connection string is the one built for
// the embedded instance, and the data directory is deleted on stop.
//
// Concurrency tests use separate pg connections, explicit transactions that
// deliberately keep locks held, and the barrier helpers below (polling
// pg_stat_activity until a session is genuinely waiting on a lock). No
// sleep/delay is ever injected into production SQL.
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The real migrations that build the schema the recurrence functions run
// against, in production order. 014/015-019/024/025 (RLS bulk enable,
// billing, auth, business hours, timezone) touch tables/columns none of these
// functions read; 025's company_settings.timezone is declared in the baseline.
export const MIGRATIONS = [
  "001_add_duration_minutes.sql",
  "002_create_services.sql",
  "003_add_recurrence.sql",
  "004_add_client_archived.sql",
  "005_expand_client_fields.sql",
  "006_create_employees.sql",
  "009_add_job_tracking.sql",
  "010_add_appointment_employee_hours.sql",
  "013_add_is_demo.sql",
  "020_add_service_and_appointment_pricing.sql",
  "021_add_appointment_employees.sql",
  "022_add_appointment_team_color.sql",
  "023_add_repeat_months.sql",
  "026_add_recurring_series.sql",
  "027a_add_recurring_series_snapshots.sql",
  "027b_add_recurring_series_replenishment.sql",
  "028_add_appointment_employees_job_notes.sql",
  "029_add_atomic_recurrence_change.sql",
  "030_add_work_recording_locking_protocol.sql",
  "031_add_owner_worked_time_override.sql",
];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export type TestDb = {
  port: number;
  connect(): Promise<pg.Client>;
  stop(): Promise<void>;
};

// Migrations 029/030/031 are the only ones the exported production schema
// (test-db/production-schema.sql, taken 2026-09-21, before any of the three
// were applied) lacks. (026-028 must already be applied in production; if
// they are not, the restored schema is missing them and the failure that
// follows is the finding.)
export const NEW_MIGRATIONS = MIGRATIONS.slice(-3);

// Where a schema-only export of the real database is expected, if Alberto has
// produced one (see test-db/SCHEMA_VALIDATION.md). Gitignored; never committed.
export const PRODUCTION_SCHEMA_FILE = path.join(ROOT, "test-db", "production-schema.sql");

// Options:
//  - schemaSql: restore this exported schema INSTEAD of test-db/baseline.sql
//    (defaults to the file named by TEST_DB_SCHEMA_FILE, when that is set).
//    Migrations then default to just the new ones (NEW_MIGRATIONS).
//  - migrations: explicit migration list to apply afterwards.
export async function startTestDb(opts: { migrations?: string[]; schemaSql?: string } = {}): Promise<TestDb> {
  const schemaFile = process.env.TEST_DB_SCHEMA_FILE;
  const schemaSql = opts.schemaSql ?? (schemaFile ? readFileSync(path.resolve(ROOT, schemaFile), "utf8") : undefined);
  const port = await freePort();
  const dir = mkdtempSync(path.join(tmpdir(), "sft-pg-"));
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password: "test",
    port,
    persistent: false,
    // Production databases are UTF8; the Windows default (WIN1252) cannot even
    // load migrations containing non-ASCII comments.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await server.initialise();
  await server.start();

  const conn = { host: "127.0.0.1", port, user: "postgres", password: "test", database: "postgres" };
  const connect = async () => {
    const c = new pg.Client(conn);
    await c.connect();
    return c;
  };

  const admin = await connect();
  try {
    await admin.query(readFileSync(path.join(ROOT, "test-db", "supabase-stubs.sql"), "utf8"));
    try {
      await admin.query(schemaSql ?? readFileSync(path.join(ROOT, "test-db", "baseline.sql"), "utf8"));
    } catch (err) {
      throw new Error(`${schemaSql ? "restoring the exported schema" : "baseline.sql"} failed: ${(err as Error).message}`);
    }
    for (const file of opts.migrations ?? (schemaSql ? NEW_MIGRATIONS : MIGRATIONS)) {
      try {
        await admin.query(readFileSync(path.join(ROOT, "migrations", file), "utf8"));
      } catch (err) {
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    await admin.end();
    await server.stop();
    throw err;
  }
  await admin.end();

  return {
    port,
    connect,
    stop: async () => {
      await server.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// Barrier helpers
// ---------------------------------------------------------------------------

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Resolves once the backend `pid` is genuinely blocked on a lock (row,
// transaction or advisory). Polls pg_stat_activity from a separate
// connection; throws on timeout so a missing block fails loudly instead of
// hanging.
export async function waitUntilBlocked(observer: pg.Client, pid: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await observer.query(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
      [pid]
    );
    if (rows[0]?.wait_event_type === "Lock") return;
    if (Date.now() > deadline) throw new Error(`backend ${pid} never blocked on a lock`);
    await sleep(20);
  }
}

export async function backendPid(c: pg.Client): Promise<number> {
  const { rows } = await c.query("SELECT pg_backend_pid() AS pid");
  return rows[0].pid as number;
}

// Runs `promise` while asserting it has NOT settled yet at the time `check`
// is called (used to prove a call is really waiting behind a lock).
export function track<T>(promise: Promise<T>): { settled: () => boolean; result: Promise<T> } {
  let done = false;
  const result = promise.finally(() => {
    done = true;
  });
  result.catch(() => {});
  return { settled: () => done, result };
}

// ---------------------------------------------------------------------------
// Fixtures (plain SQL against the real schema)
// ---------------------------------------------------------------------------

export type Fixture = {
  workspaceId: string;
  clientId: string;
  employeeIds: string[];
};

export async function makeWorkspace(
  c: pg.Client,
  opts: { timezone?: string | null; employees?: number; clientStatus?: string } = {}
): Promise<Fixture> {
  const workspaceId = randomUUID();
  const clientId = randomUUID();
  await c.query("INSERT INTO workspaces (id, name) VALUES ($1, 'ws')", [workspaceId]);
  await c.query("INSERT INTO company_settings (workspace_id, timezone) VALUES ($1, $2)", [
    workspaceId,
    opts.timezone === undefined ? "America/New_York" : opts.timezone,
  ]);
  await c.query("INSERT INTO clients (id, workspace_id, name, status) VALUES ($1, $2, 'Izabel', $3)", [
    clientId,
    workspaceId,
    opts.clientStatus ?? "active",
  ]);
  const employeeIds: string[] = [];
  for (let i = 0; i < (opts.employees ?? 2); i++) {
    const id = randomUUID();
    await c.query("INSERT INTO employees (id, workspace_id, name) VALUES ($1, $2, $3)", [id, workspaceId, `emp${i}`]);
    employeeIds.push(id);
  }
  return { workspaceId, clientId, employeeIds };
}

export async function makeAppointment(
  c: pg.Client,
  fx: Fixture,
  opts: {
    scheduledFor: Date;
    durationMinutes?: number;
    employees?: string[];
    seriesId?: string | null;
    frequencyType?: string;
    repeatWeeks?: number | null;
    status?: string;
    notes?: string | null;
    priceCents?: number | null;
  }
): Promise<string> {
  const id = randomUUID();
  const dur = opts.durationMinutes ?? 60;
  await c.query(
    `INSERT INTO appointments (id, workspace_id, client_id, service_type, scheduled_for, scheduled_end,
        duration_minutes, notes, status, cancel_token, series_id, frequency_type, repeat_weeks, price_cents)
     VALUES ($1,$2,$3,'Regular Cleaning',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id, fx.workspaceId, fx.clientId, opts.scheduledFor,
      new Date(opts.scheduledFor.getTime() + dur * 60000), dur,
      opts.notes ?? null, opts.status ?? "scheduled", randomUUID().replace(/-/g, ""),
      opts.seriesId ?? null, opts.frequencyType ?? "one_time",
      opts.repeatWeeks === undefined ? 1 : opts.repeatWeeks, opts.priceCents ?? null,
    ]
  );
  for (const e of opts.employees ?? []) {
    await c.query(
      "INSERT INTO appointment_employees (appointment_id, employee_id, workspace_id) VALUES ($1,$2,$3)",
      [id, e, fx.workspaceId]
    );
  }
  return id;
}

// Rows of an appointment/series graph, for before/after equality assertions.
export async function snapshotWorkspace(c: pg.Client, workspaceId: string) {
  const q = async (sql: string) => (await c.query(sql, [workspaceId])).rows;
  return {
    appointments: await q("SELECT * FROM appointments WHERE workspace_id = $1 ORDER BY id"),
    assignments: await q("SELECT * FROM appointment_employees WHERE workspace_id = $1 ORDER BY id"),
    hours: await q("SELECT * FROM appointment_employee_hours WHERE workspace_id = $1 ORDER BY id"),
    series: await q("SELECT * FROM recurring_series WHERE workspace_id = $1 ORDER BY id"),
    operations: await q("SELECT * FROM recurrence_change_operations WHERE workspace_id = $1 ORDER BY id"),
  };
}
