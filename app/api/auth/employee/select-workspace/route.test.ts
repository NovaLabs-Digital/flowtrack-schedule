// Route-level tests for app/api/auth/employee/select-workspace/route.ts --
// the second step of the multi-workspace employee login flow. @/lib/session
// and @/lib/supabaseAdmin are mocked in-process. No real Supabase/network
// call is reachable. Run with --experimental-test-module-mocks (see
// package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin } from "../../../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../../../lib/testSupport.ts";

const ADMIN_WORKSPACE_ID = "c6053b32-8c71-498f-8f13-218579805d4d";
const ACS_WORKSPACE_ID = "3c7d1b2b-9d99-4eb5-80d3-5072ecd56d7a";

let currentFake = createFakeSupabaseAdmin({});
let candidatesToReturn: Array<{ selectionId: string; employeeId: string; workspaceId: string }> | null = null;
let clearedPendingCookie = false;
let createSessionCookieValueCalls: Array<{ role: string; employeeId: string; workspaceId: string }> = [];

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});
mock.module("@/lib/session", {
  namedExports: {
    getEmployeeWorkspaceSelectionCandidates: async () => candidatesToReturn,
    clearEmployeeWorkspaceSelectionCookie: () => {
      clearedPendingCookie = true;
    },
    createSessionCookieValue: async (role: "employee", employeeId: string, workspaceId: string) => {
      createSessionCookieValueCalls.push({ role, employeeId, workspaceId });
      return "signed-employee-session-value";
    },
    SESSION_MAX_AGE_SECONDS: 60 * 60 * 24 * 7,
  },
});

const { POST } = await import("./route.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}
function resetState() {
  candidatesToReturn = null;
  clearedPendingCookie = false;
  createSessionCookieValueCalls = [];
}
function req(body: unknown) {
  return new Request("http://localhost/api/auth/employee/select-workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const TWO_CANDIDATES = [
  { selectionId: "sel-admin", employeeId: "emp-admin", workspaceId: ADMIN_WORKSPACE_ID },
  { selectionId: "sel-acs", employeeId: "emp-acs", workspaceId: ACS_WORKSPACE_ID },
];

describe("POST /api/auth/employee/select-workspace -- no valid pending challenge", () => {
  test("no sft_employee_workspace_pending cookie at all -> 401, generic message", async () => {
    resetState();
    resetFixtures({});
    const res = await POST(req({ selectionId: "sel-admin" }));
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, "Unable to complete sign-in. Please log in again.");
  });

  test("an expired/tampered/missing challenge (getEmployeeWorkspaceSelectionCandidates returns null) -> 401, same generic message, no employees-table query", async () => {
    resetState();
    candidatesToReturn = null;
    resetFixtures({});
    const res = await POST(req({ selectionId: "sel-admin" }));
    assert.equal(res.status, 401);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "employees"), []);
  });
});

describe("POST /api/auth/employee/select-workspace -- selectionId must be one of the exact verified candidates", () => {
  test("a selectionId outside the candidate set is rejected -- never falls back to any candidate", async () => {
    resetState();
    candidatesToReturn = TWO_CANDIDATES;
    resetFixtures({});
    const res = await POST(req({ selectionId: "sel-forged-not-in-challenge" }));
    assert.equal(res.status, 401);
    assert.deepEqual(currentFake.calls.filter((c) => c.table === "employees"), []);
  });

  test("a missing/non-string selectionId is rejected the same way", async () => {
    resetState();
    candidatesToReturn = TWO_CANDIDATES;
    resetFixtures({});
    const res = await POST(req({}));
    assert.equal(res.status, 401);
  });

  test("an employeeId or workspaceId submitted directly (never a selectionId) is rejected -- the route only ever accepts the opaque selectionId", async () => {
    resetState();
    candidatesToReturn = TWO_CANDIDATES;
    resetFixtures({});
    const res = await POST(req({ selectionId: "emp-admin" }));
    assert.equal(res.status, 401);
  });
});

describe("POST /api/auth/employee/select-workspace -- successful selection", () => {
  test("selecting the ACS candidate creates a session for exactly that employee/workspace pair, and only that pair", async () => {
    resetState();
    candidatesToReturn = TWO_CANDIDATES;
    resetFixtures({
      employees: [{ data: { id: "emp-acs", active: true, workspace_id: ACS_WORKSPACE_ID } }],
    });
    const res = await POST(req({ selectionId: "sel-acs" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, redirect: "/schedule" });
    assert.equal(createSessionCookieValueCalls.length, 1);
    assert.deepEqual(createSessionCookieValueCalls[0], { role: "employee", employeeId: "emp-acs", workspaceId: ACS_WORKSPACE_ID });
  });

  test("selecting the admin candidate instead creates a session for the admin workspace, never the ACS one", async () => {
    resetState();
    candidatesToReturn = TWO_CANDIDATES;
    resetFixtures({
      employees: [{ data: { id: "emp-admin", active: true, workspace_id: ADMIN_WORKSPACE_ID } }],
    });
    const res = await POST(req({ selectionId: "sel-admin" }));
    assert.equal(res.status, 200);
    assert.deepEqual(createSessionCookieValueCalls[0], { role: "employee", employeeId: "emp-admin", workspaceId: ADMIN_WORKSPACE_ID });
  });

  test("re-verifies the chosen employee row fresh against the database, scoped by both id and workspace_id -- never trusts the challenge alone", async () => {
    resetState();
    candidatesToReturn = TWO_CANDIDATES;
    resetFixtures({
      employees: [{ data: { id: "emp-acs", active: true, workspace_id: ACS_WORKSPACE_ID } }],
    });
    await POST(req({ selectionId: "sel-acs" }));
    const eqCalls = currentFake.calls.filter((c) => c.table === "employees" && c.method === "eq");
    assert.ok(eqCalls.some((c) => c.args[0] === "id" && c.args[1] === "emp-acs"));
    assert.ok(eqCalls.some((c) => c.args[0] === "workspace_id" && c.args[1] === ACS_WORKSPACE_ID));
  });

  test("the pending selection cookie is cleared on a successful selection", async () => {
    resetState();
    candidatesToReturn = TWO_CANDIDATES;
    resetFixtures({
      employees: [{ data: { id: "emp-acs", active: true, workspace_id: ACS_WORKSPACE_ID } }],
    });
    await POST(req({ selectionId: "sel-acs" }));
    assert.equal(clearedPendingCookie, true);
  });

  test("issues the real sft_session cookie with Max-Age set (a persistent cookie, not a browser-session-only one)", async () => {
    resetState();
    candidatesToReturn = TWO_CANDIDATES;
    resetFixtures({
      employees: [{ data: { id: "emp-acs", active: true, workspace_id: ACS_WORKSPACE_ID } }],
    });
    const res = await POST(req({ selectionId: "sel-acs" }));
    const setCookieHeader = res.headers.get("set-cookie") || "";
    assert.ok(setCookieHeader.includes("sft_session=signed-employee-session-value"));
    assert.ok(/max-age=\d+/i.test(setCookieHeader));
  });
});

describe("POST /api/auth/employee/select-workspace -- the chosen employee is re-verified active, not merely trusted from the challenge", () => {
  test("a chosen candidate whose row has since gone inactive is rejected, and the pending cookie is still cleared", async () => {
    resetState();
    candidatesToReturn = TWO_CANDIDATES;
    resetFixtures({
      employees: [{ data: { id: "emp-acs", active: false, workspace_id: ACS_WORKSPACE_ID } }],
    });
    const res = await POST(req({ selectionId: "sel-acs" }));
    assert.equal(res.status, 401);
    assert.equal(createSessionCookieValueCalls.length, 0);
    assert.equal(clearedPendingCookie, true);
  });

  test("a chosen candidate whose row no longer exists at all is rejected the same way", async () => {
    resetState();
    candidatesToReturn = TWO_CANDIDATES;
    resetFixtures({ employees: [{ data: null }] });
    const res = await POST(req({ selectionId: "sel-acs" }));
    assert.equal(res.status, 401);
    assert.equal(createSessionCookieValueCalls.length, 0);
  });
});

describe("POST /api/auth/employee/select-workspace -- safe error handling", () => {
  test("a database error is caught and never leaks a raw error message to the client", async () => {
    resetState();
    candidatesToReturn = TWO_CANDIDATES;
    resetFixtures({ employees: [{ error: { message: "SECRET_INTERNAL_DB_DETAIL" } }] });
    const res = await POST(req({ selectionId: "sel-acs" }));
    assert.equal(res.status, 500);
    const raw = JSON.stringify(await res.json());
    assert.ok(!raw.includes("SECRET_INTERNAL_DB_DETAIL"));
  });
});
