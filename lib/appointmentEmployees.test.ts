// Phase 5.7D-R18: unit tests for lib/appointmentEmployees.ts -- the shared
// helpers every assignment-aware route (create/update/manage-recurrence/
// job/employee-hours) builds on. Pure functions are tested directly;
// Supabase-touching functions use the same in-process fake Supabase client
// as the route-level tests (lib/testSupport.ts). Run with
// --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin, writeCalls } from "./testSupport.ts";
import type { FakeSupabaseFixture } from "./testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});

mock.module("@/lib/supabaseAdmin", {
  namedExports: {
    supabaseAdmin: {
      from: (table: string) => currentFake.supabaseAdmin.from(table),
      rpc: (fn: string, args?: unknown) => currentFake.supabaseAdmin.rpc(fn, args),
    },
  },
});

const {
  hasAppointmentEmployeesTable,
  deriveLegacyEmployeeId,
  dedupeEmployeeIds,
  validateEmployeeIdsInWorkspace,
  computeAssignmentDiff,
  findBlockedRemovals,
  fetchAssignments,
  fetchEmployeeHoursForAppointments,
  insertAssignments,
  planAssignmentSync,
  syncAssignmentsAtomically,
  AppointmentAssignmentSyncError,
} = await import("./appointmentEmployees.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>, rpcResponses: Record<string, FakeSupabaseFixture[]> = {}) {
  currentFake = createFakeSupabaseAdmin(responses, rpcResponses);
}

describe("deriveLegacyEmployeeId -- appointments.employee_id compatibility mirror", () => {
  test("zero assignments -> null", () => {
    assert.equal(deriveLegacyEmployeeId([]), null);
  });
  test("exactly one assignment -> that employee's id", () => {
    assert.equal(deriveLegacyEmployeeId(["emp-1"]), "emp-1");
  });
  test("two or more assignments -> null, never an arbitrary 'primary' pick", () => {
    assert.equal(deriveLegacyEmployeeId(["emp-1", "emp-2"]), null);
    assert.equal(deriveLegacyEmployeeId(["emp-1", "emp-2", "emp-3"]), null);
  });
});

describe("dedupeEmployeeIds", () => {
  test("removes duplicates, preserves first-seen order", () => {
    assert.deepEqual(dedupeEmployeeIds(["a", "b", "a", "c", "b"]), ["a", "b", "c"]);
  });
  test("filters out blank/whitespace-only entries", () => {
    assert.deepEqual(dedupeEmployeeIds(["a", "", "  ", "b"]), ["a", "b"]);
  });
  test("empty input -> empty output", () => {
    assert.deepEqual(dedupeEmployeeIds([]), []);
  });
});

describe("computeAssignmentDiff", () => {
  test("adding a second employee: first stays, second is added", () => {
    const { toAdd, toRemove } = computeAssignmentDiff(["teresa"], ["teresa", "roxana"]);
    assert.deepEqual(toAdd, ["roxana"]);
    assert.deepEqual(toRemove, []);
  });
  test("removing Teresa while Alberto remains: only Teresa is removed", () => {
    const { toAdd, toRemove } = computeAssignmentDiff(["alberto", "teresa"], ["alberto"]);
    assert.deepEqual(toAdd, []);
    assert.deepEqual(toRemove, ["teresa"]);
  });
  test("removing the last employee -> empty desired set is allowed as an input (caller decides whether to confirm)", () => {
    const { toAdd, toRemove } = computeAssignmentDiff(["alberto"], []);
    assert.deepEqual(toAdd, []);
    assert.deepEqual(toRemove, ["alberto"]);
  });
  test("no change -> empty diff", () => {
    const { toAdd, toRemove } = computeAssignmentDiff(["a", "b"], ["a", "b"]);
    assert.deepEqual(toAdd, []);
    assert.deepEqual(toRemove, []);
  });
});

describe("findBlockedRemovals -- never silently discard recorded work", () => {
  test("an unworked assignment (no timestamps, no manual hours) is not blocked", () => {
    const blocked = findBlockedRemovals(
      ["teresa"],
      [{ employee_id: "teresa", actual_started_at: null, actual_completed_at: null }],
      []
    );
    assert.deepEqual(blocked, []);
  });
  test("a started-but-not-completed assignment is blocked (in-progress work must not be lost)", () => {
    const blocked = findBlockedRemovals(
      ["teresa"],
      [{ employee_id: "teresa", actual_started_at: "2026-07-30T09:00:00Z", actual_completed_at: null }],
      []
    );
    assert.deepEqual(blocked, ["teresa"]);
  });
  test("a fully completed assignment is blocked", () => {
    const blocked = findBlockedRemovals(
      ["teresa"],
      [{ employee_id: "teresa", actual_started_at: "2026-07-30T09:00:00Z", actual_completed_at: "2026-07-30T12:00:00Z" }],
      []
    );
    assert.deepEqual(blocked, ["teresa"]);
  });
  test("a saved manual appointment_employee_hours entry blocks removal even with no timestamps", () => {
    const blocked = findBlockedRemovals(
      ["teresa"],
      [{ employee_id: "teresa", actual_started_at: null, actual_completed_at: null }],
      [{ employee_id: "teresa" }]
    );
    assert.deepEqual(blocked, ["teresa"]);
  });
  test("mixed removal set: only the employee with recorded work is blocked, the other is allowed", () => {
    const blocked = findBlockedRemovals(
      ["teresa", "roxana"],
      [
        { employee_id: "teresa", actual_started_at: null, actual_completed_at: null },
        { employee_id: "roxana", actual_started_at: "2026-07-30T09:00:00Z", actual_completed_at: "2026-07-30T12:00:00Z" },
      ],
      []
    );
    assert.deepEqual(blocked, ["roxana"]);
  });
});

describe("hasAppointmentEmployeesTable", () => {
  test("returns true when the select succeeds", async () => {
    resetFixtures({ appointment_employees: [{ data: [] }] });
    assert.equal(await hasAppointmentEmployeesTable(), true);
  });
  test("returns false when the table doesn't exist yet (query errors)", async () => {
    resetFixtures({ appointment_employees: [{ error: { message: "relation does not exist" } }] });
    assert.equal(await hasAppointmentEmployeesTable(), false);
  });
});

describe("validateEmployeeIdsInWorkspace -- never trust a browser-submitted employee id", () => {
  test("empty list is trivially valid, zero Supabase calls", async () => {
    resetFixtures({});
    const result = await validateEmployeeIdsInWorkspace([], "ws-1");
    assert.deepEqual(result, { ok: true });
    assert.equal(currentFake.calls.length, 0);
  });
  test("all IDs found in the workspace -> ok", async () => {
    resetFixtures({ employees: [{ data: [{ id: "emp-1" }, { id: "emp-2" }] }] });
    const result = await validateEmployeeIdsInWorkspace(["emp-1", "emp-2"], "ws-1");
    assert.deepEqual(result, { ok: true });
  });
  test("an id belonging to a different workspace (or nonexistent) is rejected, not silently dropped", async () => {
    resetFixtures({ employees: [{ data: [{ id: "emp-1" }] }] });
    const result = await validateEmployeeIdsInWorkspace(["emp-1", "cross-workspace-emp"], "ws-1");
    assert.equal(result.ok, false);
  });
});

describe("fetchAssignments / fetchEmployeeHoursForAppointments -- workspace-scoped reads", () => {
  test("fetchAssignments scopes by both appointment_id and workspace_id", async () => {
    resetFixtures({
      appointment_employees: [{ data: [{ id: "ae-1", appointment_id: "appt-1", employee_id: "emp-1", actual_started_at: null, actual_completed_at: null, created_at: "x", updated_at: "x" }] }],
    });
    const rows = await fetchAssignments("appt-1", "ws-1");
    assert.equal(rows.length, 1);
    const eqCalls = currentFake.calls.filter((c) => c.table === "appointment_employees" && c.method === "eq");
    assert.deepEqual(eqCalls.map((c) => c.args[0]), ["appointment_id", "workspace_id"]);
  });

  test("fetchEmployeeHoursForAppointments with an empty appointmentIds list makes zero calls", async () => {
    resetFixtures({});
    const rows = await fetchEmployeeHoursForAppointments([], "ws-1");
    assert.deepEqual(rows, []);
    assert.equal(currentFake.calls.length, 0);
  });
});

describe("insertAssignments", () => {
  test("insertAssignments with an empty list makes zero calls", async () => {
    resetFixtures({});
    await insertAssignments("appt-1", "ws-1", []);
    assert.equal(currentFake.calls.length, 0);
  });
  test("insertAssignments writes one row per employee_id, each carrying appointment_id and workspace_id", async () => {
    resetFixtures({ appointment_employees: [{ data: null, error: null }] });
    await insertAssignments("appt-1", "ws-1", ["emp-1", "emp-2"]);
    const insertCall = currentFake.calls.find((c) => c.table === "appointment_employees" && c.method === "insert");
    assert.ok(insertCall);
    const rows = insertCall!.args[0] as Array<Record<string, string>>;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.appointment_id, "appt-1");
      assert.equal(row.workspace_id, "ws-1");
    }
    assert.deepEqual(rows.map((r) => r.employee_id), ["emp-1", "emp-2"]);
  });
});

describe("planAssignmentSync -- validate-before-mutate (Block 2C-1: now also surfaces currentEmployeeIds for syncAssignmentsAtomically)", () => {
  test("a safe diff (no blocked removals) returns ok with the correct add/remove sets AND the exact currentEmployeeIds observed", async () => {
    resetFixtures({
      appointment_employees: [{ data: [{ id: "ae-1", appointment_id: "appt-1", employee_id: "teresa", actual_started_at: null, actual_completed_at: null, created_at: "x", updated_at: "x" }] }],
    });
    const plan = await planAssignmentSync("appt-1", "ws-1", ["alberto"], []);
    assert.deepEqual(plan, { ok: true, toAdd: ["alberto"], toRemove: ["teresa"], currentEmployeeIds: ["teresa"] });
  });

  test("a blocked removal (recorded work) returns ok:false and makes zero mutating calls", async () => {
    resetFixtures({
      appointment_employees: [{ data: [{ id: "ae-1", appointment_id: "appt-1", employee_id: "teresa", actual_started_at: "2026-07-30T09:00:00Z", actual_completed_at: "2026-07-30T12:00:00Z", created_at: "x", updated_at: "x" }] }],
    });
    const plan = await planAssignmentSync("appt-1", "ws-1", ["alberto"], []);
    assert.deepEqual(plan, { ok: false, blockedEmployeeIds: ["teresa"] });
    assert.equal(writeCalls(currentFake.calls).length, 0);
  });
});

describe("syncAssignmentsAtomically -- the ONLY way to add/remove an EXISTING appointment's assignments, delegating entirely to the atomic sync_appointment_assignments RPC", () => {
  // The RPC's own locking/validation logic is proven exclusively by
  // migrations/027a_add_recurring_series_snapshots.test.ts's source-level
  // assertions against the SQL itself (no live database is reachable from
  // any test in this repository) -- this describe block's only job is to
  // prove the THIN TypeScript wrapper: it calls .rpc() with the correctly
  // canonicalized parameters, maps whatever outcome string comes back
  // verbatim, and never swallows a real RPC-call error.
  function callParams(overrides: Record<string, unknown> = {}) {
    return {
      appointmentId: "appt-1",
      workspaceId: "ws-1",
      expectedCurrentEmployeeIds: ["teresa"],
      desiredEmployeeIds: ["alberto", "teresa"],
      ...overrides,
    };
  }

  test("calls the RPC with both arrays canonicalized (sorted), even when the caller passed them unsorted", async () => {
    resetFixtures({}, { sync_appointment_assignments: [{ data: "synced" }] });
    const result = await syncAssignmentsAtomically(
      callParams({ expectedCurrentEmployeeIds: ["teresa", "alberto"], desiredEmployeeIds: ["zed", "alberto"] })
    );
    assert.deepEqual(result, { outcome: "synced" });
    assert.equal(currentFake.rpcCalls.length, 1);
    const call = currentFake.rpcCalls[0];
    assert.equal(call.fn, "sync_appointment_assignments");
    assert.deepEqual(call.args, {
      p_appointment_id: "appt-1",
      p_workspace_id: "ws-1",
      p_expected_current_employee_ids: ["alberto", "teresa"],
      p_desired_employee_ids: ["alberto", "zed"],
    });
  });

  test("a genuinely empty desired set canonicalizes to an empty array, not undefined/null", async () => {
    resetFixtures({}, { sync_appointment_assignments: [{ data: "synced" }] });
    await syncAssignmentsAtomically(callParams({ desiredEmployeeIds: [] }));
    const call = currentFake.rpcCalls[0];
    assert.deepEqual((call.args as Record<string, unknown>).p_desired_employee_ids, []);
  });

  for (const outcome of ["appointment_not_found", "state_changed", "employee_not_eligible"] as const) {
    test(`returns outcome '${outcome}' verbatim when the RPC reports it -- never thrown, never swallowed`, async () => {
      resetFixtures({}, { sync_appointment_assignments: [{ data: outcome }] });
      const result = await syncAssignmentsAtomically(callParams());
      assert.deepEqual(result, { outcome });
    });
  }

  test("failure injection: a real RPC-call error throws AppointmentAssignmentSyncError -- never swallowed, never returned as a fake outcome", async () => {
    resetFixtures({}, { sync_appointment_assignments: [{ error: { message: "simulated rpc failure" } }] });
    await assert.rejects(
      () => syncAssignmentsAtomically(callParams()),
      (err: unknown) => err instanceof AppointmentAssignmentSyncError
    );
  });
});
