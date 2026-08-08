// Phase 5.7D-R18 Review Corrections: tests for scripts/seed-demo-data.cjs's
// appointment_employees compatibility. This is a standalone CommonJS dev
// script (not part of the Next.js app bundle), so it's required directly
// via createRequire rather than through the app's own module-alias
// resolution. Requiring it only constructs a @supabase/supabase-js client
// (harmless with fake credentials -- no network call happens at
// construction time); `main()` is guarded by `require.main === module` and
// is never invoked here, so no real Supabase call is reachable from this
// file. Run with --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const seeder = require("./seed-demo-data.cjs");
const source = fs.readFileSync(fileURLToPath(new URL("./seed-demo-data.cjs", import.meta.url)), "utf8");

describe("buildAssignmentRows -- Phase 5.7D-R18 compatibility with the authoritative appointment_employees model", () => {
  test("an appointment with an employee_id gets exactly one matching assignment row", () => {
    const rows = seeder.buildAssignmentRows([
      { id: "appt-1", employee_id: "emp-1", workspace_id: "ws-1", actual_started_at: null, actual_completed_at: null },
    ]);
    assert.deepEqual(rows, [{ appointment_id: "appt-1", employee_id: "emp-1", workspace_id: "ws-1", actual_started_at: null, actual_completed_at: null }]);
  });

  test("an unassigned appointment (employee_id null) produces no row", () => {
    const rows = seeder.buildAssignmentRows([
      { id: "appt-1", employee_id: null, workspace_id: "ws-1", actual_started_at: null, actual_completed_at: null },
    ]);
    assert.deepEqual(rows, []);
  });

  test("a simulated already-completed demo appointment carries its actual_started_at/actual_completed_at onto the assignment row -- never left blank while the appointment shows as done", () => {
    const rows = seeder.buildAssignmentRows([
      { id: "appt-1", employee_id: "emp-1", workspace_id: "ws-1", actual_started_at: "2026-01-01T09:00:00.000Z", actual_completed_at: "2026-01-01T11:00:00.000Z" },
    ]);
    assert.equal(rows[0].actual_started_at, "2026-01-01T09:00:00.000Z");
    assert.equal(rows[0].actual_completed_at, "2026-01-01T11:00:00.000Z");
  });

  test("multiple appointments each get their own row, matched by their own id/employee_id/workspace_id", () => {
    const inserted = [
      { id: "appt-1", employee_id: "emp-1", workspace_id: "ws-1" },
      { id: "appt-2", employee_id: "emp-2", workspace_id: "ws-1" },
      { id: "appt-3", employee_id: null, workspace_id: "ws-1" },
    ];
    const rows = seeder.buildAssignmentRows(inserted);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].appointment_id, "appt-1");
    assert.equal(rows[0].employee_id, "emp-1");
    assert.equal(rows[1].appointment_id, "appt-2");
    assert.equal(rows[1].employee_id, "emp-2");
  });

  test("never produces a duplicate (appointment_id, employee_id) pair, even if the input somehow repeats one", () => {
    const rows = seeder.buildAssignmentRows([
      { id: "appt-1", employee_id: "emp-1", workspace_id: "ws-1" },
      { id: "appt-1", employee_id: "emp-1", workspace_id: "ws-1" },
    ]);
    assert.equal(rows.length, 1);
  });

  test("each row's workspace_id comes from that specific appointment's own real inserted value, never a shared constant", () => {
    const rows = seeder.buildAssignmentRows([
      { id: "appt-1", employee_id: "emp-1", workspace_id: "ws-a" },
      { id: "appt-2", employee_id: "emp-2", workspace_id: "ws-b" },
    ]);
    assert.equal(rows[0].workspace_id, "ws-a");
    assert.equal(rows[1].workspace_id, "ws-b");
  });

  test("never references or writes appointment_employee_hours", () => {
    const fnStart = source.indexOf("function buildAssignmentRows(");
    const fnEnd = source.indexOf("\n}", fnStart);
    const body = source.slice(fnStart, fnEnd);
    assert.ok(!body.includes("appointment_employee_hours"));
  });
});

describe("buildAppointments -- unchanged compatibility-mirror generation", () => {
  test("every generated appointment has exactly one employee_id, drawn from the provided employee pool", () => {
    const employeeIds = ["emp-1", "emp-2", "emp-3"];
    const rows = seeder.buildAppointments(
      ["client-1"],
      [{ name: "Test Service", duration_minutes: 60, default_price_cents: 5000 }],
      employeeIds
    );
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.ok(typeof r.employee_id === "string");
      assert.ok(employeeIds.includes(r.employee_id));
    }
  });

  test("every generated appointment sets its own workspace_id explicitly -- there is no database default, so an omitted field here is a NOT NULL violation at insert time, not a silent no-op", () => {
    const rows = seeder.buildAppointments(
      ["client-1"],
      [{ name: "Test Service", duration_minutes: 60, default_price_cents: 5000 }],
      ["emp-1"]
    );
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.equal(typeof r.workspace_id, "string");
      assert.ok(r.workspace_id.length > 0);
    }
  });

  test("every generated appointment has a non-negative price_cents, never undefined", () => {
    const rows = seeder.buildAppointments(
      ["client-1", "client-2", "client-3"],
      [{ name: "Test Service", duration_minutes: 60, default_price_cents: 5000 }],
      ["emp-1"]
    );
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.equal(typeof r.price_cents, "number");
      assert.ok(r.price_cents >= 0);
    }
  });

  test("a recurring series shares one identical price_cents snapshot across every occurrence, matching the real production rule (appointments/create/route.ts)", () => {
    // Only the last 6 rows (2 series x 3 occurrences) are recurring --
    // driven by frequency_type: "weekly" and a shared series_id.
    const rows = seeder.buildAppointments(
      ["client-1", "client-2", "client-3", "client-4", "client-5"],
      [{ name: "Test Service", duration_minutes: 60, default_price_cents: 5000 }],
      ["emp-1"]
    );
    const recurring = rows.filter((r: any) => r.frequency_type === "weekly");
    assert.equal(recurring.length, 6);
    const bySeries = new Map<string, number[]>();
    for (const r of recurring) {
      const list = bySeries.get(r.series_id) ?? [];
      list.push(r.price_cents);
      bySeries.set(r.series_id, list);
    }
    assert.equal(bySeries.size, 2);
    for (const prices of bySeries.values()) {
      assert.equal(prices.length, 3);
      assert.ok(prices.every((p) => p === prices[0]), "every occurrence in a series must share the same price");
    }
  });

  test("price_cents never contains a value parsed or derived from the service name", () => {
    const rows = seeder.buildAppointments(
      ["client-1"],
      [{ name: "175 Regular Cleaning", duration_minutes: 60, default_price_cents: 5000 }],
      ["emp-1"]
    );
    for (const r of rows) {
      assert.notEqual(r.price_cents, 175 * 100, "price must come from default_price_cents, never parsed out of the service name");
    }
  });
});

describe("priceCentsForAppointment -- deterministic, per-client price variation", () => {
  test("is a pure function: the same (defaultPriceCents, clientIndex) pair always produces the same price, across repeated calls", () => {
    const results = new Set<number>();
    for (let i = 0; i < 20; i++) {
      results.add(seeder.priceCentsForAppointment(12000, 1));
    }
    assert.equal(results.size, 1, "must be deterministic -- no Math.random(), no Date, no I/O");
  });

  test("different clientIndex values produce different prices for the same service, demonstrating the same-service/different-customer business rule", () => {
    const clientA = seeder.priceCentsForAppointment(12000, 0);
    const clientB = seeder.priceCentsForAppointment(12000, 1);
    assert.notEqual(clientA, clientB);
    // Matches the approved example concept exactly: Window Washing default
    // $120, Client A (index 0) $120, Client B (index 1) $145.
    assert.equal(clientA, 12000);
    assert.equal(clientB, 14500);
  });

  test("never produces a negative price, even for the smallest service default combined with the largest negative variant", () => {
    const smallestDefault = Math.min(...seeder.SERVICES.map((s: any) => s.default_price_cents));
    for (let clientIndex = 0; clientIndex < 20; clientIndex++) {
      assert.ok(seeder.priceCentsForAppointment(smallestDefault, clientIndex) >= 0);
    }
  });

  test("a missing/undefined default price is treated as 0, never thrown or NaN", () => {
    const result = seeder.priceCentsForAppointment(undefined, 2);
    assert.equal(typeof result, "number");
    assert.ok(Number.isFinite(result));
    assert.ok(result >= 0);
  });
});

describe("SERVICES -- every fictional demo service has a reasonable default_price_cents", () => {
  test("every service has a positive, whole-cent default_price_cents", () => {
    assert.ok(seeder.SERVICES.length > 0);
    for (const s of seeder.SERVICES) {
      assert.equal(typeof s.default_price_cents, "number");
      assert.ok(Number.isInteger(s.default_price_cents));
      assert.ok(s.default_price_cents > 0);
    }
  });

  test("every service sets workspace_id explicitly -- there is no database default for this column", () => {
    for (const s of seeder.SERVICES) {
      assert.equal(typeof s.workspace_id, "string");
      assert.ok(s.workspace_id.length > 0);
    }
  });

  test("no service name contains an embedded price -- price lives only in default_price_cents", () => {
    for (const s of seeder.SERVICES) {
      assert.ok(!/\d/.test(s.name), `service name "${s.name}" must not embed a price/number`);
    }
  });

  test("the services insert requests default_price_cents in its .select(), so buildAppointments actually receives it", () => {
    assert.ok(source.includes('.select("id, name, duration_minutes, default_price_cents")'));
  });
});

describe("the seeder fails closed, before any insert or delete, when appointment_employees doesn't exist yet", () => {
  test("hasAppointmentEmployeesTable is exported and is the first thing main() checks", () => {
    assert.equal(typeof seeder.hasAppointmentEmployeesTable, "function");
    const mainStart = source.indexOf("async function main() {");
    const firstAwait = source.indexOf("await hasAppointmentEmployeesTable()", mainStart);
    assert.ok(firstAwait > -1, "main() must call hasAppointmentEmployeesTable()");
    // Nothing that reads/writes clients/employees/services/appointments
    // appears between the start of main() and this check.
    const beforeCheck = source.slice(mainStart, firstAwait);
    for (const forbidden of ['.from("clients")', '.from("employees")', '.from("services")', '.from("appointments")', ".delete(", ".insert("]) {
      assert.ok(!beforeCheck.includes(forbidden), `must not touch "${forbidden}" before the table-existence check`);
    }
  });

  test("a missing table exits the process with a non-zero code and a clear message, never a silent partial seed", () => {
    const mainStart = source.indexOf("async function main() {");
    const checkIdx = source.indexOf("if (!tableReady) {", mainStart);
    const exitIdx = source.indexOf("process.exit(1)", checkIdx);
    assert.ok(checkIdx > -1 && exitIdx > -1);
    const block = source.slice(checkIdx, exitIdx);
    assert.ok(block.includes("SEED_ABORTED"));
    assert.ok(/migration 021|migrations\/021/i.test(block));
  });

  test("direct execution is guarded -- requiring this module for its exports never calls main() or touches Supabase", () => {
    assert.ok(source.includes("if (require.main === module) {"));
    const exportsIdx = source.indexOf("module.exports = {");
    assert.ok(exportsIdx > -1);
    const exportsBlock = source.slice(exportsIdx, source.indexOf("};", exportsIdx));
    for (const name of ["buildAppointments", "buildAssignmentRows", "hasAppointmentEmployeesTable", "priceCentsForAppointment", "SERVICES"]) {
      assert.ok(exportsBlock.includes(name), `module.exports must include ${name}`);
    }
  });
});

describe("workspace_id -- every insert payload sets it explicitly (there is no database default for this column)", () => {
  test("EMPLOYEES array literal sets workspace_id on every entry", () => {
    const start = source.indexOf("const EMPLOYEES = [");
    const end = source.indexOf("];", start);
    const block = source.slice(start, end);
    const entryCount = (block.match(/\{ name:/g) || []).length;
    const workspaceIdCount = (block.match(/workspace_id: DEMO_WORKSPACE_ID/g) || []).length;
    assert.ok(entryCount > 0);
    assert.equal(workspaceIdCount, entryCount);
  });

  test("CLIENTS .map() output sets workspace_id", () => {
    const start = source.indexOf(".map((c, i) => ({");
    const end = source.indexOf("}));", start);
    const block = source.slice(start, end);
    assert.ok(block.includes("workspace_id: DEMO_WORKSPACE_ID"));
  });

  test("DEMO_WORKSPACE_ID matches lib/workspace.ts's constant exactly", () => {
    const workspaceTsSource = fs.readFileSync(
      fileURLToPath(new URL("../lib/workspace.ts", import.meta.url)),
      "utf8"
    );
    const match = workspaceTsSource.match(/DEMO_WORKSPACE_ID = "([^"]+)"/);
    assert.ok(match, "lib/workspace.ts must still export DEMO_WORKSPACE_ID as a quoted literal");
    assert.ok(source.includes(`const DEMO_WORKSPACE_ID = "${match![1]}"`));
  });
});

describe("reset ordering still safe under the new FK shape (appointment_employees.employee_id has no cascade)", () => {
  test("appointments are deleted before employees in --reset, so cascade-cleared assignment rows never block the employees delete", () => {
    const resetIdx = source.indexOf('console.log("Resetting existing demo rows...");');
    assert.ok(resetIdx > -1);
    const apptDeleteIdx = source.indexOf('supabase.from("appointments").delete()', resetIdx);
    const empDeleteIdx = source.indexOf('supabase.from("employees").delete()', resetIdx);
    assert.ok(apptDeleteIdx > -1 && empDeleteIdx > -1);
    assert.ok(apptDeleteIdx < empDeleteIdx, "appointments must be deleted before employees");
  });
});

describe("--reset delete isolation -- every delete is double-scoped, structurally incapable of reaching a row outside the fixed demo workspace", () => {
  const resetIdx = source.indexOf('console.log("Resetting existing demo rows...");');
  const resetBlockEnd = source.indexOf("\n  }", resetIdx);
  const resetBlock = source.slice(resetIdx, resetBlockEnd);

  test('every .delete() call in the --reset block chains BOTH .eq("workspace_id", DEMO_WORKSPACE_ID) AND .eq("is_demo", true), in that order', () => {
    assert.ok(resetIdx > -1 && resetBlockEnd > resetIdx);
    // One line per table -- matched individually so a missing predicate on
    // any single table fails with a clear "which table" message rather than
    // one opaque whole-block regex failure.
    for (const table of ["appointments", "clients", "employees", "services"]) {
      const lineMatch = resetBlock.match(
        new RegExp(`supabase\\.from\\("${table}"\\)\\.delete\\(\\)\\.eq\\("workspace_id",\\s*DEMO_WORKSPACE_ID\\)\\.eq\\("is_demo",\\s*true\\)`)
      );
      assert.ok(lineMatch, `${table} delete must chain .eq("workspace_id", DEMO_WORKSPACE_ID).eq("is_demo", true)`);
    }
  });

  test("no delete in the --reset block targets rows using is_demo alone -- every .delete() is immediately followed by a workspace_id predicate before any is_demo predicate", () => {
    const deleteCalls = resetBlock.match(/supabase\.from\("\w+"\)\.delete\(\)[^;]*;/g) ?? [];
    assert.equal(deleteCalls.length, 4, "expected exactly 4 delete statements (appointments, clients, employees, services)");
    for (const call of deleteCalls) {
      assert.ok(call.includes('.eq("workspace_id", DEMO_WORKSPACE_ID)'), `delete call missing workspace_id scoping: ${call}`);
      assert.ok(call.includes('.eq("is_demo", true)'), `delete call missing is_demo scoping: ${call}`);
    }
  });

  test("the reset scope was narrowed, not broadened -- the same 4 tables are deleted, no new table added", () => {
    const deleteCalls = resetBlock.match(/supabase\.from\("(\w+)"\)\.delete\(\)/g) ?? [];
    const tables = deleteCalls.map((c) => c.match(/from\("(\w+)"\)/)![1]);
    assert.deepEqual(tables, ["appointments", "clients", "employees", "services"]);
  });
});

describe("insert isolation -- every seed insert is workspace-scoped (already required, re-verified after the reset-scope correction)", () => {
  test("SERVICES, EMPLOYEES, and CLIENTS every entry sets workspace_id, and buildAppointments output does too", () => {
    for (const s of seeder.SERVICES) {
      assert.equal(s.workspace_id, "e3e8f3a7-c114-4d4c-9f15-590188a654b6");
    }
    const rows = seeder.buildAppointments(
      ["client-1", "client-2"],
      [{ name: "Test Service", duration_minutes: 60, default_price_cents: 5000 }],
      ["emp-1"]
    );
    for (const r of rows) {
      assert.equal(r.workspace_id, "e3e8f3a7-c114-4d4c-9f15-590188a654b6");
    }
  });
});

describe("regression: demo pricing behavior from the prior task is unchanged by this reset-scope correction", () => {
  test("priceCentsForAppointment is still deterministic and still demonstrates same-service/different-customer pricing", () => {
    assert.equal(seeder.priceCentsForAppointment(12000, 0), 12000);
    assert.equal(seeder.priceCentsForAppointment(12000, 1), 14500);
  });

  test("SERVICES still carries the same 6 fictional services with the same default_price_cents values", () => {
    const byName = Object.fromEntries(seeder.SERVICES.map((s: any) => [s.name, s.default_price_cents]));
    assert.deepEqual(byName, {
      "Lawn Mowing & Edging": 4500,
      "Property Inspection": 6500,
      "Window Washing": 12000,
      "Pressure Washing": 18000,
      "Move-Out Turnover Cleaning": 25000,
      "Landscaping & Yard Cleanup": 15000,
    });
  });
});

describe("regression: canonical reseed volume is unchanged by this reset-scope correction", () => {
  test("buildAppointments still generates exactly 32 one-time + 6 recurring (2 series x 3) = 38 rows for the real seed inputs (6 services, 20 clients, 3 employees)", () => {
    const clientIds = Array.from({ length: 20 }, (_, i) => `client-${i}`);
    const employeeIds = ["emp-1", "emp-2", "emp-3"];
    const rows = seeder.buildAppointments(clientIds, seeder.SERVICES, employeeIds);
    assert.equal(rows.length, 38);
  });
});
