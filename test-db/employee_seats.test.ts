// Employee seats (migrations/048) on a REAL PostgreSQL built from the
// exported production schema + migrations 029-047. Data is seeded BEFORE 048
// is applied, so the rollout (grandfathering) is tested exactly as it would
// run in production. The real employees and seats routes run unchanged; only
// @/lib/supabaseAdmin is swapped for test-db/postgrestAdapter.ts.
//
//   TEST_DB_SCHEMA_FILE=test-db/production-schema.sql npm run test:db:seats
/* eslint-disable @typescript-eslint/no-explicit-any -- test-only: rows are
   inspected dynamically against the database. */
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { startTestDb, type TestDb } from "./harness.ts";
import { createPostgrestAdapter, POSTGREST_TYPES } from "./postgrestAdapter.ts";

process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaFile = process.env.TEST_DB_SCHEMA_FILE ? path.resolve(ROOT, process.env.TEST_DB_SCHEMA_FILE) : "";
const SKIP = !schemaFile || !existsSync(schemaFile) ? "TEST_DB_SCHEMA_FILE (production schema export) not provided" : false;

let currentClient: any = null;
mock.module("@/lib/supabaseAdmin", {
  namedExports: {
    supabaseAdmin: {
      from: (t: string) => currentClient.from(t),
      rpc: (fn: string, args?: Record<string, unknown>) => currentClient.rpc(fn, args),
    },
  },
});
let session: any = { role: "none" };
const { fakeSessionNamedExports } = await import("../lib/testSupport.ts");
mock.module("@/lib/session", { namedExports: fakeSessionNamedExports(async () => session) });
mock.module("@/lib/entitlementServer", {
  namedExports: { requireCapability: async () => ({ allowed: true }) },
});

const employeesRoute = await import("../app/api/employees/route.ts");
const seatsRoute = await import("../app/api/employees/seats/route.ts");

let db: TestDb;
let pool: pg.Pool;
let c: pg.Client;

const M048 = readFileSync(path.join(ROOT, "migrations", "048_employee_seat_allowance.sql"), "utf8");

async function newWorkspace(name: string, active: number, inactive = 0, demo = false): Promise<string> {
  const { rows: [w] } = await c.query("INSERT INTO workspaces (name) VALUES ($1) RETURNING id", [name]);
  await c.query(
    `INSERT INTO employees (workspace_id, name, active, is_demo)
     SELECT $1::uuid, 'Member ' || i, i <= $2::int, $4::boolean FROM generate_series(1, $2::int + $3::int) i`,
    [w.id, active, inactive, demo]
  );
  return w.id;
}
const activeCount = async (ws: string) =>
  Number((await c.query("SELECT count(*) n FROM employees WHERE workspace_id = $1 AND active AND NOT is_demo", [ws])).rows[0].n);
const allowanceOf = async (ws: string) =>
  (await c.query("SELECT employee_seat_allowance a FROM workspaces WHERE id = $1", [ws])).rows[0].a;

function asOwner(ws: string) {
  session = { role: "owner", workspaceId: ws, authUserId: "owner-" + ws, sessionEpoch: 1 };
}
async function add(ws: string, body: Record<string, unknown> = {}) {
  asOwner(ws);
  const res = await employeesRoute.POST(new Request("http://localhost/api/employees", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "New hire", ...body }),
  }));
  return { status: res.status, body: await res.json() };
}
async function setActive(ws: string, id: string, active: boolean) {
  asOwner(ws);
  const res = await employeesRoute.PATCH(new Request("http://localhost/api/employees", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, active }),
  }));
  return { status: res.status, body: await res.json() };
}
async function seats(ws: string) {
  asOwner(ws);
  const res = await seatsRoute.GET();
  return { status: res.status, body: await res.json() };
}

let wsBig: string, wsSmall: string, wsFive: string, wsDemo: string;
let auditBefore: { metric: string; value: string }[] = [];
let preflight: { check_name: string; ok: boolean; detail: string }[] = [];
let postflight: { check_name: string; ok: boolean; detail: string }[] = [];
const runSql = async (file: string) => (await c.query(readFileSync(path.join(ROOT, "test-db", file), "utf8"))).rows;

before(async () => {
  if (SKIP) return;
  db = await startTestDb({
    migrations: [
      "029_add_atomic_recurrence_change.sql", "030_add_work_recording_locking_protocol.sql", "031_add_owner_worked_time_override.sql",
      "032_create_completed_job_billing.sql", "033_completed_job_billing_invoice_per_client.sql", "034_completed_job_billing_finalize_invoice_per_client.sql",
      "035_reset_reminder_on_recurrence_change.sql", "036_reminder_claim_protocol.sql", "037_messages_sent_occurrence_snapshot.sql",
      "038_add_cancellation_correction_fields.sql", "039_preserve_cancelled_occurrence_exclusion.sql", "040_add_messages_sent_subject.sql",
      "041_block_early_job_start.sql", "042_add_demo_sessions.sql", "043_guest_control_permissions.sql", "044_shared_session_view.sql",
      "045_owner_sign_in_security.sql", "046_session_chat.sql", "047_atomic_future_edit.sql",
    ],
  });
  c = await db.connect();
  pool = new pg.Pool({ host: "127.0.0.1", port: db.port, user: "postgres", password: "test", database: "postgres", max: 20, types: POSTGREST_TYPES as any });
  pool.on("connect", (client) => client.query("SET TIME ZONE 'UTC'"));
  currentClient = createPostgrestAdapter(pool).client;

  // Production-like state BEFORE the rollout.
  wsBig = await newWorkspace("Seven active", 7, 2);
  wsSmall = await newWorkspace("Three active", 3);
  wsFive = await newWorkspace("Exactly five", 5, 1);
  wsDemo = await newWorkspace("Demo rows", 0);
  await c.query("INSERT INTO employees (workspace_id, name, active, is_demo) SELECT $1, 'Demo ' || i, true, true FROM generate_series(1, 8) i", [wsDemo]);
  // An owner who also added themselves as an employee (same email): the audit's hint.
  await c.query("INSERT INTO auth.users (id, email) VALUES ('99999999-0000-0000-0000-000000000001', 'Owner.Big@Example.test')");
  await c.query("INSERT INTO profiles (id, email) VALUES ('99999999-0000-0000-0000-000000000001', 'Owner.Big@Example.test')");
  await c.query("INSERT INTO workspace_memberships (workspace_id, profile_id, role) VALUES ($1, '99999999-0000-0000-0000-000000000001', 'owner')", [wsBig]);
  await c.query("UPDATE employees SET email = 'owner.big@example.test' WHERE id = (SELECT id FROM employees WHERE workspace_id = $1 AND active ORDER BY name LIMIT 1)", [wsBig]);
  auditBefore = (await c.query(readFileSync(path.join(ROOT, "test-db", "employee-seat-audit.sql"), "utf8"))).rows;
  preflight = await runSql("048-preflight.sql");
  await c.query(M048); // the rollout
  postflight = await runSql("048-postflight.sql");
});
after(async () => {
  if (SKIP) return;
  await pool.end();
  await c.end();
  await db.stop();
});

describe("Rollout (migration 048)", { skip: SKIP }, () => {
  test("048-preflight passes on the pre-rollout database (at 047) and reports the teams above 5", () => {
    assert.equal(preflight.length, 8);
    assert.deepEqual(preflight.filter((r) => !r.ok), []);
    assert.match(preflight.find((r) => r.check_name === "workspaces_over_5_active")!.detail, /^1 workspace/);
  });

  test("048-postflight passes right after the rollout: nothing auto-linked, every team has room, enforcement and grants in place", () => {
    assert.equal(postflight.length, 12);
    assert.deepEqual(postflight.filter((r) => !r.ok), []);
    assert.match(postflight.find((r) => r.check_name === "workspaces_with_raised_allowance")!.detail, /^1 workspace/);
  });

  test("after the rollout the preflight says 048 is already applied", async () => {
    const again = await runSql("048-preflight.sql");
    assert.deepEqual(again.filter((r) => !r.ok).map((r) => r.check_name).sort(), ["no_name_conflicts", "owner_link_column_absent", "seat_column_absent"]);
  });

  test("the read-only audit (test-db/employee-seat-audit.sql) counts what the rollout will grandfather, without names", () => {
    const m = Object.fromEntries(auditBefore.map((r) => [r.metric, r.value]));
    assert.equal(m.workspaces_over_5_active, "1", "only the 7-person team; 8 demo rows do not count");
    assert.equal(m.over_5_by_size, "7: 1");
    assert.equal(m.largest_active_team, "7");
    assert.equal(m.workspaces_at_exactly_5, "1");
    assert.equal(m.inactive_employees_total, "3");
    assert.equal(m.possible_owner_as_employee, "1", "the owner's own employee row (matched by email, case-insensitive)");
    assert.ok(!JSON.stringify(auditBefore).includes("Member"), "no names");
  });

  test("default allowance is 5; a team above 5 keeps its active headcount; inactive and demo rows are not counted", async () => {
    assert.equal(await allowanceOf(wsBig), 7, "7 active (2 inactive not counted) -> 7");
    assert.equal(await allowanceOf(wsSmall), 5);
    assert.equal(await allowanceOf(wsFive), 5);
    assert.equal(await allowanceOf(wsDemo), 5, "demo rows never count");
    assert.equal(await activeCount(wsBig), 7, "nobody was deactivated by the rollout");
  });

  test("re-running the migration changes nothing", async () => {
    const before1 = (await c.query("SELECT id, employee_seat_allowance FROM workspaces ORDER BY id")).rows;
    await c.query(M048);
    assert.deepEqual((await c.query("SELECT id, employee_seat_allowance FROM workspaces ORDER BY id")).rows, before1);
  });

  test("the allowance must be between 0 and 1000", async () => {
    await assert.rejects(c.query("UPDATE workspaces SET employee_seat_allowance = -1 WHERE id = $1", [wsSmall]));
  });
});

describe("Adding and reactivating staff respects the allowance", { skip: SKIP }, () => {
  test("3 of 5: two more can be added; the next is refused with 409 and nothing is saved", async () => {
    assert.equal((await add(wsSmall)).status, 201);
    assert.equal((await add(wsSmall)).status, 201);
    const refused = await add(wsSmall, { name: "One too many" });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "EMPLOYEE_SEATS_FULL");
    assert.deepEqual(refused.body.seats, { used: 5, allowance: 5, available: 0 });
    assert.match(refused.body.error, /All 5 employee seats are in use/);
    assert.equal(Number((await c.query("SELECT count(*) n FROM employees WHERE workspace_id = $1 AND name = 'One too many'", [wsSmall])).rows[0].n), 0);
  });

  test("adding someone as inactive needs no seat; reactivating them while full is refused", async () => {
    const r = await add(wsSmall, { name: "Seasonal", active: false });
    assert.equal(r.status, 201);
    assert.equal((await setActive(wsSmall, r.body.id, true)).status, 409);
    assert.equal((await c.query("SELECT active FROM employees WHERE id = $1", [r.body.id])).rows[0].active, false);
  });

  test("editing an active employee while full is allowed (no new seat needed)", async () => {
    const { rows: [e] } = await c.query("SELECT id FROM employees WHERE workspace_id = $1 AND active LIMIT 1", [wsSmall]);
    asOwner(wsSmall);
    const res = await employeesRoute.PATCH(new Request("http://localhost/api/employees", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: e.id, name: "Renamed", phone: "555" }),
    }));
    assert.equal(res.status, 200);
  });

  test("deactivating frees a seat, keeps that person's assignments and worked hours, and the freed seat can be reused", async () => {
    const { rows: [e] } = await c.query("SELECT id FROM employees WHERE workspace_id = $1 AND active ORDER BY name LIMIT 1", [wsSmall]);
    const { rows: [cl] } = await c.query("INSERT INTO clients (workspace_id, name, status) VALUES ($1, 'Seat Client', 'active') RETURNING id", [wsSmall]);
    const { rows: [a] } = await c.query(
      `INSERT INTO appointments (workspace_id, client_id, service_type, scheduled_for, scheduled_end, status, cancel_token, is_demo)
       VALUES ($1, $2, 'Regular Cleaning', now() - interval '3 days', now() - interval '3 days' + interval '2 hours', 'scheduled', md5(random()::text), false) RETURNING id`,
      [wsSmall, cl.id]
    );
    await c.query("INSERT INTO appointment_employees (appointment_id, employee_id, workspace_id) VALUES ($1, $2, $3)", [a.id, e.id, wsSmall]);
    await c.query("INSERT INTO appointment_employee_hours (appointment_id, employee_id, workspace_id, hours_worked) VALUES ($1, $2, $3, 2.5)", [a.id, e.id, wsSmall]);
    const history = async () => (await c.query(
      `SELECT (SELECT count(*) FROM appointment_employees WHERE employee_id = $1) ae, (SELECT sum(hours_worked) FROM appointment_employee_hours WHERE employee_id = $1) h`, [e.id])).rows[0];
    const before1 = await history();

    assert.equal((await setActive(wsSmall, e.id, false)).status, 200);
    assert.deepEqual(await history(), before1, "assignments and worked hours untouched");
    assert.deepEqual((await seats(wsSmall)).body, { used: 4, allowance: 5, available: 1, ownerLinked: false });
    // The freed seat: a replacement (or the inactive seasonal worker) can now be activated.
    const { rows: [seasonal] } = await c.query("SELECT id FROM employees WHERE workspace_id = $1 AND name = 'Seasonal'", [wsSmall]);
    assert.equal((await setActive(wsSmall, seasonal.id, true)).status, 200);
    assert.equal(await activeCount(wsSmall), 5);
  });

  test("a grandfathered team (7 of 7) can replace someone who leaves, but not grow", async () => {
    assert.equal((await add(wsBig)).status, 409);
    const { rows: [leaver] } = await c.query("SELECT id FROM employees WHERE workspace_id = $1 AND active LIMIT 1", [wsBig]);
    assert.equal((await setActive(wsBig, leaver.id, false)).status, 200);
    assert.equal(await allowanceOf(wsBig), 7, "deactivating does not lower the allowance");
    assert.equal((await add(wsBig, { name: "Replacement" })).status, 201);
    assert.equal(await activeCount(wsBig), 7);
    assert.equal((await add(wsBig)).status, 409);
  });

  test("the allowance is per workspace: raised to 10 (e.g. a future plan), the workspace can grow to exactly 10", async () => {
    await c.query("UPDATE workspaces SET employee_seat_allowance = 10 WHERE id = $1", [wsFive]);
    for (let i = 0; i < 5; i++) assert.equal((await add(wsFive)).status, 201);
    assert.equal((await add(wsFive)).status, 409);
    assert.equal(await activeCount(wsFive), 10);
    assert.equal(await allowanceOf(wsSmall), 5, "other workspaces are unaffected");
  });

  test("demo rows are never limited", async () => {
    await c.query("INSERT INTO employees (workspace_id, name, active, is_demo) SELECT $1, 'More demo ' || i, true, true FROM generate_series(1, 3) i", [wsDemo]);
    assert.equal(Number((await c.query("SELECT count(*) n FROM employees WHERE workspace_id = $1 AND active", [wsDemo])).rows[0].n), 11);
  });
});

describe("Simultaneous requests can never exceed the allowance", { skip: SKIP }, () => {
  test("two transactions racing for the last seat: the second waits for the first and is refused", async () => {
    const ws = await newWorkspace("Race last seat", 4);
    const c1 = await db.connect();
    const c2 = await db.connect();
    try {
      await c1.query("BEGIN");
      await c1.query("INSERT INTO employees (workspace_id, name, active, is_demo) VALUES ($1, 'First', true, false)", [ws]);
      await c2.query("BEGIN");
      let settled = false;
      const second = c2.query("INSERT INTO employees (workspace_id, name, active, is_demo) VALUES ($1, 'Second', true, false)", [ws])
        .then(() => "inserted", (e) => e.code).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(settled, false, "the second request waits on the workspace lock");
      await c1.query("COMMIT");
      assert.equal(await second, "SL001");
      await c2.query("ROLLBACK");
    } finally {
      await c1.end();
      await c2.end();
    }
    assert.equal(await activeCount(ws), 5);
  });

  test("12 simultaneous 'Add employee' requests on an empty workspace: exactly 5 succeed, 7 get 409", async () => {
    const ws = await newWorkspace("Burst adds", 0);
    asOwner(ws);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      employeesRoute.POST(new Request("http://localhost/api/employees", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Burst " + i }),
      })).then((r) => r.status)
    ));
    assert.equal(results.filter((s) => s === 201).length, 5);
    assert.equal(results.filter((s) => s === 409).length, 7);
    assert.equal(await activeCount(ws), 5);
  });

  test("simultaneous reactivations: only as many as there are free seats succeed", async () => {
    const ws = await newWorkspace("Burst reactivate", 3, 6);
    const { rows } = await c.query("SELECT id FROM employees WHERE workspace_id = $1 AND NOT active", [ws]);
    asOwner(ws);
    const results = await Promise.all(rows.map((r) =>
      employeesRoute.PATCH(new Request("http://localhost/api/employees", {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: r.id, active: true }),
      })).then((x) => x.status)
    ));
    assert.equal(results.filter((s) => s === 200).length, 2);
    assert.equal(await activeCount(ws), 5);
  });
});

describe("GET /api/employees/seats", { skip: SKIP }, () => {
  test("reports used / allowance / available for the owner's workspace; the owner is never counted", async () => {
    const ws = await newWorkspace("Seats view", 2, 3);
    await c.query("INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), 'owner-seats@example.test')");
    const { rows: [u] } = await c.query("SELECT id FROM auth.users WHERE email = 'owner-seats@example.test'");
    await c.query("INSERT INTO profiles (id, email) VALUES ($1, 'owner-seats@example.test')", [u.id]);
    await c.query("INSERT INTO workspace_memberships (workspace_id, profile_id, role) VALUES ($1, $2, 'owner')", [ws, u.id]);
    assert.deepEqual((await seats(ws)).body, { used: 2, allowance: 5, available: 3, ownerLinked: false });
  });

  test("non-owners are refused", async () => {
    session = { role: "tester", workspaceId: wsSmall };
    assert.equal((await seatsRoute.GET()).status, 403);
  });
});

describe("Re-running migration 048 later preserves every allowance", { skip: SKIP }, () => {
  test("grandfathered (team since shrunk), raised, deliberately lowered and post-rollout allowances all survive a re-run; enforcement still applies", async () => {
    // Grandfathered team of 7 that has since dropped to 5 active.
    const { rows: leavers } = await c.query("SELECT id FROM employees WHERE workspace_id = $1 AND active ORDER BY name LIMIT 2", [wsBig]);
    for (const l of leavers) assert.equal((await setActive(wsBig, l.id, false)).status, 200);
    // Raised (e.g. a larger plan) earlier in this file: wsFive = 10.
    // Deliberately lowered below its headcount: wsSmall has 5 active, allowance 3.
    await c.query("UPDATE workspaces SET employee_seat_allowance = 3 WHERE id = $1", [wsSmall]);
    // Created after the rollout, then given 8 seats with 8 active.
    const late = await newWorkspace("After rollout", 0);
    await c.query("UPDATE workspaces SET employee_seat_allowance = 8 WHERE id = $1", [late]);
    for (let i = 0; i < 8; i++) assert.equal((await add(late)).status, 201);

    const snapshot = async () => (await c.query("SELECT id, employee_seat_allowance FROM workspaces ORDER BY id")).rows;
    const before1 = await snapshot();
    assert.equal(await allowanceOf(wsBig), 7);
    assert.equal(await activeCount(wsBig), 5);

    await c.query(M048); // re-run
    assert.deepEqual(await snapshot(), before1, "no allowance changed");
    assert.equal(await allowanceOf(wsBig), 7, "grandfathered allowance kept although only 5 are active");
    assert.equal(await allowanceOf(wsSmall), 3, "a deliberately lowered allowance is not raised back to the headcount");
    assert.equal(await allowanceOf(wsFive), 10);
    assert.equal(await allowanceOf(late), 8);

    // The re-created trigger still enforces.
    assert.equal((await add(wsSmall)).status, 409, "5 active of 3: nobody can be added");
    assert.equal((await add(late)).status, 409);
    assert.equal((await add(wsBig)).status, 201, "5 of 7: two seats free");
    assert.equal(Number((await c.query("SELECT count(*) n FROM pg_trigger WHERE tgname = 'employees_seat_allowance'")).rows[0].n), 1, "exactly one trigger");
  });
});

// ---------------------------------------------------------------------------
// A working owner (the owner link in migration 048).
const ownerLinkRoute = await import("../app/api/employees/owner-link/route.ts");

async function ownedWorkspace(name: string, active: number, inactive = 0): Promise<{ ws: string; owner: string }> {
  const ws = await newWorkspace(name, active, inactive);
  const { rows: [u] } = await c.query("INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), $1) RETURNING id", [`owner-${ws}@example.test`]);
  await c.query("INSERT INTO profiles (id, email) VALUES ($1, $2)", [u.id, `owner-${ws}@example.test`]);
  await c.query("INSERT INTO workspace_memberships (workspace_id, profile_id, role) VALUES ($1, $2, 'owner')", [ws, u.id]);
  return { ws, owner: u.id };
}
function asRealOwner(o: { ws: string; owner: string }) {
  session = { role: "owner", workspaceId: o.ws, authUserId: o.owner, sessionEpoch: 1 };
}
async function ownerLink(o: { ws: string; owner: string }, employeeId: string, link = true) {
  asRealOwner(o);
  const res = await (link ? ownerLinkRoute.POST : ownerLinkRoute.DELETE)(new Request("http://localhost/api/employees/owner-link", {
    method: link ? "POST" : "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ employee_id: employeeId }),
  }));
  return { status: res.status, body: await res.json() };
}
async function addAs(o: { ws: string; owner: string }, body: Record<string, unknown> = {}) {
  asRealOwner(o);
  const res = await employeesRoute.POST(new Request("http://localhost/api/employees", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Hire", ...body }),
  }));
  return { status: res.status, body: await res.json() };
}
async function seatsAs(o: { ws: string; owner: string }) {
  asRealOwner(o);
  return (await seatsRoute.GET()).json();
}
const linkOf = async (id: string) => (await c.query("SELECT owner_profile_id FROM employees WHERE id = $1", [id])).rows[0].owner_profile_id;

describe("A working owner does not use an employee seat", { skip: SKIP }, () => {
  test("owner + 5 active employees is allowed; a 6th employee is blocked", async () => {
    const o = await ownedWorkspace("Owner plus five", 0);
    const me = await addAs(o, { name: "The Owner" });
    assert.equal(me.status, 201);
    assert.equal((await ownerLink(o, me.body.id)).status, 200);
    assert.equal(await linkOf(me.body.id), o.owner, "linked to the signed-in owner's own account");
    for (let i = 1; i <= 5; i++) assert.equal((await addAs(o, { name: `Employee ${i}` })).status, 201, `employee ${i}`);
    const sixth = await addAs(o, { name: "Employee 6" });
    assert.equal(sixth.status, 409);
    assert.equal(sixth.body.code, "EMPLOYEE_SEATS_FULL");
    assert.equal(Number((await c.query("SELECT count(*) n FROM employees WHERE workspace_id = $1 AND active", [o.ws])).rows[0].n), 6, "owner + 5 active");
    assert.deepEqual(await seatsAs(o), { used: 5, allowance: 5, available: 0, ownerLinked: true });
    // The employees list marks only the owner's own record; the profile id never leaves the server.
    asRealOwner(o);
    const list = await (await employeesRoute.GET()).json();
    assert.deepEqual(list.filter((e: any) => e.is_you).map((e: any) => e.name), ["The Owner"]);
    assert.ok(!JSON.stringify(list).includes(o.owner));
  });

  test("the owner's record can be assigned to jobs; linking and unlinking keep assignments and worked hours", async () => {
    const o = await ownedWorkspace("Owner works jobs", 1);
    const me = await addAs(o, { name: "Working Owner" });
    const { rows: [cl] } = await c.query("INSERT INTO clients (workspace_id, name, status) VALUES ($1, 'Owner Client', 'active') RETURNING id", [o.ws]);
    const { rows: [a] } = await c.query(
      `INSERT INTO appointments (workspace_id, client_id, service_type, scheduled_for, scheduled_end, status, cancel_token, is_demo)
       VALUES ($1, $2, 'Regular Cleaning', now() - interval '2 days', now() - interval '2 days' + interval '2 hours', 'scheduled', md5(random()::text), false) RETURNING id`,
      [o.ws, cl.id]
    );
    await c.query("INSERT INTO appointment_employees (appointment_id, employee_id, workspace_id) VALUES ($1, $2, $3)", [a.id, me.body.id, o.ws]);
    await c.query("INSERT INTO appointment_employee_hours (appointment_id, employee_id, workspace_id, hours_worked) VALUES ($1, $2, $3, 3)", [a.id, me.body.id, o.ws]);
    const history = async () => (await c.query("SELECT (SELECT count(*) FROM appointment_employees WHERE employee_id = $1) ae, (SELECT sum(hours_worked) FROM appointment_employee_hours WHERE employee_id = $1) h", [me.body.id])).rows[0];
    const before1 = await history();
    assert.equal((await ownerLink(o, me.body.id)).status, 200);
    assert.deepEqual(await history(), before1);
    assert.equal((await ownerLink(o, me.body.id, false)).status, 200);
    assert.deepEqual(await history(), before1);
    assert.equal(await linkOf(me.body.id), null);
  });

  test("the link is checked against workspace ownership in the database, not trusted from the app", async () => {
    const a = await ownedWorkspace("Owner A", 2);
    const b = await ownedWorkspace("Owner B", 2);
    const { rows: [recA] } = await c.query("SELECT id FROM employees WHERE workspace_id = $1 LIMIT 1", [a.ws]);
    // Owner B cannot link a record in A (the route only touches B's own workspace).
    assert.equal((await ownerLink(b, recA.id)).status, 404);
    assert.equal(await linkOf(recA.id), null);
    // Even writing directly: another workspace's owner, or a profile with no ownership, is refused (SL002).
    await assert.rejects(c.query("UPDATE employees SET owner_profile_id = $2 WHERE id = $1", [recA.id, b.owner]), (e: any) => e.code === "SL002");
    const { rows: [stranger] } = await c.query("INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), 'stranger@example.test') RETURNING id");
    await c.query("INSERT INTO profiles (id, email) VALUES ($1, 'stranger@example.test')", [stranger.id]);
    await assert.rejects(c.query("UPDATE employees SET owner_profile_id = $2 WHERE id = $1", [recA.id, stranger.id]), (e: any) => e.code === "SL002");
    // Demo data can never be linked.
    const { rows: [demoRow] } = await c.query("INSERT INTO employees (workspace_id, name, active, is_demo) VALUES ($1, 'Demo person', false, true) RETURNING id", [a.ws]);
    assert.equal((await ownerLink(a, demoRow.id)).status, 404);
    await assert.rejects(c.query("UPDATE employees SET owner_profile_id = $2 WHERE id = $1", [demoRow.id, a.owner]), (e: any) => e.code === "SL002");
  });

  test("at most one linked record per workspace (also under simultaneous requests)", async () => {
    const o = await ownedWorkspace("One link only", 3);
    const { rows } = await c.query("SELECT id FROM employees WHERE workspace_id = $1 ORDER BY name", [o.ws]);
    assert.equal((await ownerLink(o, rows[0].id)).status, 200);
    const second = await ownerLink(o, rows[1].id);
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "OWNER_ALREADY_LINKED");
    assert.equal(await linkOf(rows[0].id), o.owner, "the first link is unchanged");
    assert.equal((await ownerLink(o, rows[0].id, false)).status, 200);
    const both = await Promise.all([ownerLink(o, rows[1].id), ownerLink(o, rows[2].id)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
    assert.equal(Number((await c.query("SELECT count(*) n FROM employees WHERE workspace_id = $1 AND owner_profile_id IS NOT NULL", [o.ws])).rows[0].n), 1);
  });

  test("removing the link from an active record needs a free seat; reactivating the owner's own record never does", async () => {
    const o = await ownedWorkspace("Unlink when full", 0);
    const me = await addAs(o, { name: "Owner Self" });
    await ownerLink(o, me.body.id);
    for (let i = 1; i <= 5; i++) assert.equal((await addAs(o, { name: `Crew ${i}` })).status, 201);
    const refused = await ownerLink(o, me.body.id, false);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "EMPLOYEE_SEATS_FULL");
    assert.equal(await linkOf(me.body.id), o.owner, "still linked");
    // Owner steps back and returns: their own record reactivates even when full.
    asRealOwner(o);
    const patch = (id: string, active: boolean) => employeesRoute.PATCH(new Request("http://localhost/api/employees", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, active }),
    }));
    assert.equal((await patch(me.body.id, false)).status, 200);
    assert.equal((await patch(me.body.id, true)).status, 200);
    // With a seat free, unlinking works and the record then uses that seat.
    const { rows: [crew] } = await c.query("SELECT id FROM employees WHERE workspace_id = $1 AND name = 'Crew 1'", [o.ws]);
    assert.equal((await patch(crew.id, false)).status, 200);
    assert.equal((await ownerLink(o, me.body.id, false)).status, 200);
    assert.deepEqual(await seatsAs(o), { used: 5, allowance: 5, available: 0, ownerLinked: false });
  });

  test("nothing is linked automatically: a record with the owner's email stays unlinked and keeps using a seat", async () => {
    const { rows } = await c.query(
      `SELECT e.owner_profile_id FROM employees e JOIN profiles p ON lower(p.email) = lower(e.email) WHERE e.workspace_id = $1`, [wsBig]);
    assert.equal(rows.length, 1, "the email-matching record from the audit fixture exists");
    assert.equal(rows[0].owner_profile_id, null);
  });

  test("if the account is no longer the workspace's owner, its linked record counts again", async () => {
    const o = await ownedWorkspace("Ownership changes", 2);
    const { rows: [rec] } = await c.query("SELECT id FROM employees WHERE workspace_id = $1 LIMIT 1", [o.ws]);
    await ownerLink(o, rec.id);
    assert.equal((await seatsAs(o)).used, 1);
    await c.query("DELETE FROM workspace_memberships WHERE workspace_id = $1 AND profile_id = $2", [o.ws, o.owner]);
    const usage = (await c.query("SELECT employee_seat_usage($1) u", [o.ws])).rows[0].u;
    assert.deepEqual(usage, { used: 2, allowance: 5, available: 3, owner_linked: false });
  });

  test("only the server role can read seat usage or check ownership", async () => {
    const { rows: [r] } = await c.query(`SELECT
      has_function_privilege('anon', 'employee_seat_usage(uuid)', 'EXECUTE') a1,
      has_function_privilege('authenticated', 'employee_seat_usage(uuid)', 'EXECUTE') a2,
      has_function_privilege('anon', 'is_workspace_owner(uuid,uuid)', 'EXECUTE') a3,
      has_function_privilege('service_role', 'employee_seat_usage(uuid)', 'EXECUTE') s1`);
    assert.deepEqual(r, { a1: false, a2: false, a3: false, s1: true });
  });
});
