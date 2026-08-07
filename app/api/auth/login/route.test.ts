// Phase 5.7D: route-level tests for app/api/auth/login/route.ts. Employee
// and tester authentication are UNCHANGED by this phase (see
// docs/SECURITY.md's pre-existing description of both flows) -- these
// tests exist primarily to lock in the new owner MFA hand-off and to prove
// the employee/tester branches remain byte-for-byte behaviorally identical.
// @/lib/supabaseAdmin, @/lib/supabaseAuthClient, and @/lib/mfaFlow are
// mocked in-process. No real Supabase/Stripe/network call is reachable.
// Run with --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.SESSION_SECRET = "test-session-secret-login-route";
process.env.TESTER_EMAIL = "tester@example.com";
process.env.TESTER_PASSWORD = "tester-password";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { createFakeSupabaseAdmin } from "../../../../lib/testSupport.ts";
import type { FakeSupabaseFixture } from "../../../../lib/testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});
let signInWithPasswordResult: { data: unknown; error: unknown } = { data: null, error: { message: "invalid" } };
let beginMfaFlowImpl: () => Promise<unknown> = async () => ({ step: "enroll", pendingToken: "opaque-token-1" });
let beginMfaFlowCalls = 0;
let rateLimitCalls: Array<{ bucket: string; key: string }> = [];
let rateLimitResult: { limited: boolean; retryAfterSeconds?: number } = { limited: false };
let clearRateLimitCalls: Array<{ bucket: string; key: string }> = [];
// Phase 5.7D-R20: login-route provisioning-recovery safety net fixtures.
let getUserByIdResult: { data: unknown; error: unknown } = { data: null, error: { message: "not configured" } };
let getUserByIdCalls = 0;
let provisionOwnerWorkspaceCalls: string[] = [];
let provisionOwnerWorkspaceImpl: (id: string) => Promise<string> = async (id) => {
  provisionOwnerWorkspaceCalls.push(id);
  return "provisioned-workspace";
};

mock.module("@/lib/supabaseAdmin", {
  namedExports: {
    supabaseAdmin: {
      from: (table: string) => currentFake.supabaseAdmin.from(table),
      auth: {
        admin: {
          getUserById: async () => {
            getUserByIdCalls++;
            return getUserByIdResult;
          },
        },
      },
    },
  },
});
mock.module("@/lib/durableRateLimit", {
  namedExports: {
    checkAndRecordRateLimit: (bucket: string, key: string) => {
      rateLimitCalls.push({ bucket, key });
      return Promise.resolve(rateLimitResult);
    },
    clearRateLimit: (bucket: string, key: string) => {
      clearRateLimitCalls.push({ bucket, key });
      return Promise.resolve();
    },
  },
});
mock.module("@/lib/supabaseAuthClient", {
  namedExports: {
    createOwnerAuthClient: () => ({
      auth: { signInWithPassword: async () => signInWithPasswordResult },
    }),
  },
});
mock.module("@/lib/mfaFlow", {
  namedExports: {
    beginMfaFlow: () => {
      beginMfaFlowCalls++;
      return beginMfaFlowImpl();
    },
  },
});
mock.module("@/lib/signupProvisioning", {
  namedExports: {
    provisionOwnerWorkspace: (id: string) => provisionOwnerWorkspaceImpl(id),
  },
});

const { POST } = await import("./route.ts");
const { REAL_WORKSPACE_ID } = await import("../../../../lib/workspace.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}
function resetState() {
  signInWithPasswordResult = { data: null, error: { message: "invalid" } };
  beginMfaFlowImpl = async () => ({ step: "enroll", pendingToken: "opaque-token-1" });
  beginMfaFlowCalls = 0;
  rateLimitCalls = [];
  rateLimitResult = { limited: false };
  clearRateLimitCalls = [];
  getUserByIdResult = { data: null, error: { message: "not configured" } };
  getUserByIdCalls = 0;
  provisionOwnerWorkspaceCalls = [];
  provisionOwnerWorkspaceImpl = async (id) => {
    provisionOwnerWorkspaceCalls.push(id);
    return "provisioned-workspace";
  };
}
function req(body: unknown, ip = "203.0.113.1") {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

const AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";

describe("POST /api/auth/login -- owner branch (Phase 5.7D: password success only advances to MFA)", () => {
  test("a correct password with an existing owner membership advances to the MFA flow -- sft_session is NOT issued from this request", async () => {
    resetState();
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    });
    signInWithPasswordResult = {
      data: { user: { id: AUTH_USER_ID }, session: { access_token: "at", refresh_token: "rt" } },
      error: null,
    };
    const res = await POST(req({ email: "owner@example.com", password: "correct-password" }, "10.0.0.1"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.next, "enroll");
    assert.equal(beginMfaFlowCalls, 1);
    const setCookieHeader = res.headers.get("set-cookie") || "";
    assert.ok(!setCookieHeader.includes("sft_session="));
    assert.ok(setCookieHeader.includes("sft_mfa_pending="));
    // An already-provisioned owner must never trigger the recovery path.
    assert.equal(provisionOwnerWorkspaceCalls.length, 0);
    assert.equal(getUserByIdCalls, 0);
  });

  test("a challenge outcome (one or more verified factors) surfaces factorIds to the client", async () => {
    resetState();
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    });
    signInWithPasswordResult = {
      data: { user: { id: AUTH_USER_ID }, session: { access_token: "at", refresh_token: "rt" } },
      error: null,
    };
    beginMfaFlowImpl = async () => ({ step: "challenge", pendingToken: "opaque-token-2", factorIds: ["f1", "f2"] });
    const res = await POST(req({ email: "owner@example.com", password: "correct-password" }, "10.0.0.2"));
    const body = await res.json();
    assert.equal(body.next, "challenge");
    assert.deepEqual(body.factorIds, ["f1", "f2"]);
  });

  test("a wrong password never reaches beginMfaFlow and returns the same generic error as before", async () => {
    resetState();
    resetFixtures({});
    signInWithPasswordResult = { data: null, error: { message: "invalid" } };
    const res = await POST(req({ email: "owner@example.com", password: "wrong" }, "10.0.0.3"));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Invalid email or password");
    assert.equal(beginMfaFlowCalls, 0);
  });

  test("a correct password but no owner membership yet (never provisioned) returns the same generic error, never a distinct message", async () => {
    resetState();
    resetFixtures({
      workspace_memberships: [{ data: null }],
    });
    signInWithPasswordResult = {
      data: { user: { id: AUTH_USER_ID }, session: { access_token: "at", refresh_token: "rt" } },
      error: null,
    };
    const res = await POST(req({ email: "owner@example.com", password: "correct-password" }, "10.0.0.4"));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Invalid email or password");
    assert.equal(beginMfaFlowCalls, 0);
  });
});

// Phase 5.7D-R20: the incident-driven login safety net. A confirmed owner
// with a valid password but no owner membership (their confirmation email
// never reached /api/auth/signup/confirm -- see the 2026-08-06 Journey
// Inpsyred incident) must be recovered in-place using their OWN
// already-authenticated identity, never by email, and only when every
// recovery condition holds.
describe("POST /api/auth/login -- owner provisioning-recovery safety net", () => {
  const PENDING_ROW = (overrides: Record<string, unknown> = {}) => ({
    auth_user_id: AUTH_USER_ID,
    consumed_at: null,
    ...overrides,
  });
  const CONFIRMED_USER = (overrides: Record<string, unknown> = {}) => ({
    data: { user: { id: AUTH_USER_ID, email_confirmed_at: "2026-08-06T14:05:45.000Z", ...overrides } },
    error: null,
  });

  test("a confirmed user with an unconsumed pending_signups row is recovered: provisioned, re-fetched, and advanced into MFA", async () => {
    resetState();
    resetFixtures({
      // First fetchOwnerMembership call (no membership yet), then a second
      // after provisioning (recovery succeeded).
      workspace_memberships: [
        { data: null },
        { data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } },
      ],
      pending_signups: [{ data: PENDING_ROW() }],
    });
    signInWithPasswordResult = {
      data: { user: { id: AUTH_USER_ID }, session: { access_token: "at", refresh_token: "rt" } },
      error: null,
    };
    getUserByIdResult = CONFIRMED_USER();
    const res = await POST(req({ email: "owner@example.com", password: "correct-password" }, "10.0.3.1"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.next, "enroll");
    assert.equal(beginMfaFlowCalls, 1);
    assert.deepEqual(provisionOwnerWorkspaceCalls, [AUTH_USER_ID]);
  });

  test("a wrong password never triggers recovery -- signInWithPassword fails before any recovery check runs", async () => {
    resetState();
    resetFixtures({});
    signInWithPasswordResult = { data: null, error: { message: "invalid" } };
    getUserByIdResult = CONFIRMED_USER();
    const res = await POST(req({ email: "owner@example.com", password: "wrong" }, "10.0.3.2"));
    assert.equal(res.status, 401);
    assert.equal(getUserByIdCalls, 0);
    assert.equal(provisionOwnerWorkspaceCalls.length, 0);
  });

  test("an unconfirmed Auth user is never provisioned", async () => {
    resetState();
    resetFixtures({ workspace_memberships: [{ data: null }] });
    signInWithPasswordResult = {
      data: { user: { id: AUTH_USER_ID }, session: { access_token: "at", refresh_token: "rt" } },
      error: null,
    };
    getUserByIdResult = CONFIRMED_USER({ email_confirmed_at: null });
    const res = await POST(req({ email: "owner@example.com", password: "correct-password" }, "10.0.3.3"));
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, "Invalid email or password");
    assert.equal(provisionOwnerWorkspaceCalls.length, 0);
  });

  test("a getUserById error (not just a missing/unconfirmed user) fails closed, never throws a 500", async () => {
    resetState();
    resetFixtures({ workspace_memberships: [{ data: null }] });
    signInWithPasswordResult = {
      data: { user: { id: AUTH_USER_ID }, session: { access_token: "at", refresh_token: "rt" } },
      error: null,
    };
    getUserByIdResult = { data: null, error: { message: "lookup failed" } };
    const res = await POST(req({ email: "owner@example.com", password: "correct-password" }, "10.0.3.4"));
    assert.equal(res.status, 401);
    assert.equal(provisionOwnerWorkspaceCalls.length, 0);
  });

  test("no pending_signups row at all -- never provisioned", async () => {
    resetState();
    resetFixtures({
      workspace_memberships: [{ data: null }],
      pending_signups: [{ data: null }],
    });
    signInWithPasswordResult = {
      data: { user: { id: AUTH_USER_ID }, session: { access_token: "at", refresh_token: "rt" } },
      error: null,
    };
    getUserByIdResult = CONFIRMED_USER();
    const res = await POST(req({ email: "owner@example.com", password: "correct-password" }, "10.0.3.5"));
    assert.equal(res.status, 401);
    assert.equal(provisionOwnerWorkspaceCalls.length, 0);
  });

  test("an already-consumed pending_signups row is never re-provisioned", async () => {
    resetState();
    resetFixtures({
      workspace_memberships: [{ data: null }],
      pending_signups: [{ data: PENDING_ROW({ consumed_at: "2026-07-01T00:00:00.000Z" }) }],
    });
    signInWithPasswordResult = {
      data: { user: { id: AUTH_USER_ID }, session: { access_token: "at", refresh_token: "rt" } },
      error: null,
    };
    getUserByIdResult = CONFIRMED_USER();
    const res = await POST(req({ email: "owner@example.com", password: "correct-password" }, "10.0.3.6"));
    assert.equal(res.status, 401);
    assert.equal(provisionOwnerWorkspaceCalls.length, 0);
  });

  test("a pending_signups row belonging to a DIFFERENT auth_user_id is never trusted, even if it's the row returned by the query", async () => {
    resetState();
    resetFixtures({
      workspace_memberships: [{ data: null }],
      pending_signups: [{ data: PENDING_ROW({ auth_user_id: "bbbbbbbb-1111-1111-1111-111111111111" }) }],
    });
    signInWithPasswordResult = {
      data: { user: { id: AUTH_USER_ID }, session: { access_token: "at", refresh_token: "rt" } },
      error: null,
    };
    getUserByIdResult = CONFIRMED_USER();
    const res = await POST(req({ email: "owner@example.com", password: "correct-password" }, "10.0.3.7"));
    assert.equal(res.status, 401);
    assert.equal(provisionOwnerWorkspaceCalls.length, 0);
  });

  test("a getUserById result for a DIFFERENT user id than the authenticated session is never trusted", async () => {
    resetState();
    resetFixtures({ workspace_memberships: [{ data: null }] });
    signInWithPasswordResult = {
      data: { user: { id: AUTH_USER_ID }, session: { access_token: "at", refresh_token: "rt" } },
      error: null,
    };
    getUserByIdResult = CONFIRMED_USER({ id: "cccccccc-2222-2222-2222-222222222222" });
    const res = await POST(req({ email: "owner@example.com", password: "correct-password" }, "10.0.3.8"));
    assert.equal(res.status, 401);
    assert.equal(provisionOwnerWorkspaceCalls.length, 0);
  });

  test("concurrent/repeated recovery: provisionOwnerWorkspace throwing (losing the unique-membership race) is not fatal -- the re-fetch finding a membership (created by the winning request) still succeeds the login", async () => {
    resetState();
    resetFixtures({
      workspace_memberships: [
        { data: null },
        { data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } },
      ],
      pending_signups: [{ data: PENDING_ROW() }],
    });
    signInWithPasswordResult = {
      data: { user: { id: AUTH_USER_ID }, session: { access_token: "at", refresh_token: "rt" } },
      error: null,
    };
    getUserByIdResult = CONFIRMED_USER();
    provisionOwnerWorkspaceImpl = async (id) => {
      provisionOwnerWorkspaceCalls.push(id);
      throw new Error("duplicate key value violates unique constraint");
    };
    const res = await POST(req({ email: "owner@example.com", password: "correct-password" }, "10.0.3.9"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.next, "enroll");
    assert.deepEqual(provisionOwnerWorkspaceCalls, [AUTH_USER_ID]);
  });

  test("provisionOwnerWorkspace throws AND the re-fetch still finds nothing -- fails closed with the generic error, no crash", async () => {
    resetState();
    resetFixtures({
      workspace_memberships: [{ data: null }, { data: null }],
      pending_signups: [{ data: PENDING_ROW() }],
    });
    signInWithPasswordResult = {
      data: { user: { id: AUTH_USER_ID }, session: { access_token: "at", refresh_token: "rt" } },
      error: null,
    };
    getUserByIdResult = CONFIRMED_USER();
    provisionOwnerWorkspaceImpl = async (id) => {
      provisionOwnerWorkspaceCalls.push(id);
      throw new Error("transient RPC error");
    };
    const res = await POST(req({ email: "owner@example.com", password: "correct-password" }, "10.0.3.10"));
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, "Invalid email or password");
  });

  test("a successful recovery still clears the login rate-limit bucket, same as any other successful password verification", async () => {
    resetState();
    resetFixtures({
      workspace_memberships: [
        { data: null },
        { data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } },
      ],
      pending_signups: [{ data: PENDING_ROW() }],
    });
    signInWithPasswordResult = {
      data: { user: { id: AUTH_USER_ID }, session: { access_token: "at", refresh_token: "rt" } },
      error: null,
    };
    getUserByIdResult = CONFIRMED_USER();
    await POST(req({ email: "owner@example.com", password: "correct-password" }, "10.0.3.11"));
    assert.deepEqual(clearRateLimitCalls, [{ bucket: "login", key: "10.0.3.11" }]);
  });
});

describe("POST /api/auth/login -- employee branch, single-workspace case unchanged", () => {
  test("a correct employee password still issues sft_session directly -- no MFA hand-off, beginMfaFlow never called", async () => {
    resetState();
    resetFixtures({
      employees: [{ data: [{ id: "emp-1", password_hash: await bcrypt.hash("emp-password", 10), active: true, workspace_id: REAL_WORKSPACE_ID }] }],
    });
    const res = await POST(req({ email: "emp@example.com", password: "emp-password", role: "employee" }, "10.0.1.1"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.redirect, "/schedule");
    assert.equal(beginMfaFlowCalls, 0);
    const setCookieHeader = res.headers.get("set-cookie") || "";
    assert.ok(setCookieHeader.includes("sft_session="));
    assert.ok(!setCookieHeader.includes("sft_mfa_pending="));
  });

  test("a wrong password for a single-candidate email is rejected with the generic error", async () => {
    resetState();
    resetFixtures({
      employees: [{ data: [{ id: "emp-1", password_hash: await bcrypt.hash("emp-password", 10), active: true, workspace_id: REAL_WORKSPACE_ID }] }],
    });
    const res = await POST(req({ email: "emp@example.com", password: "wrong-password", role: "employee" }, "10.0.1.1"));
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, "Invalid email or password");
  });

  test("an email matching zero employees is rejected with the same generic error, never a distinct 'no such account' message", async () => {
    resetState();
    resetFixtures({ employees: [{ data: [] }] });
    const res = await POST(req({ email: "nobody@example.com", password: "whatever", role: "employee" }, "10.0.1.1"));
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, "Invalid email or password");
  });

  test("an inactive employee cannot log in even with the correct password", async () => {
    resetState();
    resetFixtures({
      employees: [{ data: [{ id: "emp-1", password_hash: await bcrypt.hash("emp-password", 10), active: false, workspace_id: REAL_WORKSPACE_ID }] }],
    });
    const res = await POST(req({ email: "emp@example.com", password: "emp-password", role: "employee" }, "10.0.1.1"));
    assert.equal(res.status, 401);
  });

  test("an employee row with no password_hash set cannot log in even if a password is submitted", async () => {
    resetState();
    resetFixtures({
      employees: [{ data: [{ id: "emp-1", password_hash: null, active: true, workspace_id: REAL_WORKSPACE_ID }] }],
    });
    const res = await POST(req({ email: "emp@example.com", password: "anything", role: "employee" }, "10.0.1.1"));
    assert.equal(res.status, 401);
  });

  test("the email lookup is normalized to lowercase before querying -- a mixed-case submission still matches the stored lowercase value", async () => {
    resetState();
    resetFixtures({
      employees: [{ data: [{ id: "emp-1", password_hash: await bcrypt.hash("emp-password", 10), active: true, workspace_id: REAL_WORKSPACE_ID }] }],
    });
    const res = await POST(req({ email: "EMP@Example.COM", password: "emp-password", role: "employee" }, "10.0.1.1"));
    assert.equal(res.status, 200);
    const eqCall = currentFake.calls.find((c) => c.table === "employees" && c.method === "eq");
    assert.deepEqual(eqCall?.args, ["email", "emp@example.com"]);
  });
});

// Phase (migration 019): the same real person can now be an employee of
// more than one workspace, using the same normalized email in each --
// employees.email is unique per workspace, no longer globally. These tests
// prove the login route safely resolves which workspace was intended using
// the submitted password as the disambiguating signal, and never guesses.
describe("POST /api/auth/login -- employee branch, same email in multiple workspaces (migration 019)", () => {
  const ACS_WORKSPACE_ID = "3c7d1b2b-9d99-4eb5-80d3-5072ecd56d7a";

  test("two workspaces share the email; the submitted password matches only the intended workspace's row -- login succeeds into that exact workspace", async () => {
    resetState();
    resetFixtures({
      employees: [
        {
          data: [
            { id: "emp-admin", password_hash: await bcrypt.hash("admin-password", 10), active: true, workspace_id: REAL_WORKSPACE_ID },
            { id: "emp-acs", password_hash: await bcrypt.hash("acs-password", 10), active: true, workspace_id: ACS_WORKSPACE_ID },
          ],
        },
      ],
    });
    const res = await POST(req({ email: "shared@example.com", password: "acs-password", role: "employee" }, "10.0.1.2"));
    assert.equal(res.status, 200);
    // The session cookie is opaque by design; behavioral proof that the
    // ACS-workspace row (not the admin one) was selected is that this
    // exact request succeeds at all -- the admin row's hash does not match
    // "acs-password", so only the ACS candidate could have produced a 200.
  });

  test("the same scenario, submitting the OTHER workspace's password, resolves into that other workspace instead", async () => {
    resetState();
    resetFixtures({
      employees: [
        {
          data: [
            { id: "emp-admin", password_hash: await bcrypt.hash("admin-password", 10), active: true, workspace_id: REAL_WORKSPACE_ID },
            { id: "emp-acs", password_hash: await bcrypt.hash("acs-password", 10), active: true, workspace_id: ACS_WORKSPACE_ID },
          ],
        },
      ],
    });
    const res = await POST(req({ email: "shared@example.com", password: "admin-password", role: "employee" }, "10.0.1.2"));
    assert.equal(res.status, 200);
  });

  test("if the SAME password matches both workspaces' rows, no session is issued yet -- a workspace-selection challenge is returned instead of a silent pick or a rejection", async () => {
    resetState();
    const sameHash = await bcrypt.hash("identical-password", 10);
    resetFixtures({
      employees: [
        {
          data: [
            { id: "emp-admin", password_hash: sameHash, active: true, workspace_id: REAL_WORKSPACE_ID },
            { id: "emp-acs", password_hash: sameHash, active: true, workspace_id: ACS_WORKSPACE_ID },
          ],
        },
      ],
      company_settings: [
        {
          data: [
            { workspace_id: REAL_WORKSPACE_ID, company_name: "Alberto Cleaning Services" },
            { workspace_id: ACS_WORKSPACE_ID, company_name: "ACS" },
          ],
        },
      ],
    });
    const res = await POST(req({ email: "shared@example.com", password: "identical-password", role: "employee" }, "10.0.1.2"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.next, "select_workspace");
    assert.equal(body.choices.length, 2);
    const names = body.choices.map((c: { companyName: string }) => c.companyName).sort();
    assert.deepEqual(names, ["ACS", "Alberto Cleaning Services"]);
  });

  test("the select_workspace response never includes an employee id, workspace id, password, or password hash -- only selectionId and companyName per choice", async () => {
    resetState();
    const sameHash = await bcrypt.hash("identical-password", 10);
    resetFixtures({
      employees: [
        {
          data: [
            { id: "emp-admin", password_hash: sameHash, active: true, workspace_id: REAL_WORKSPACE_ID },
            { id: "emp-acs", password_hash: sameHash, active: true, workspace_id: ACS_WORKSPACE_ID },
          ],
        },
      ],
      company_settings: [
        {
          data: [
            { workspace_id: REAL_WORKSPACE_ID, company_name: "Alberto Cleaning Services" },
            { workspace_id: ACS_WORKSPACE_ID, company_name: "ACS" },
          ],
        },
      ],
    });
    const res = await POST(req({ email: "shared@example.com", password: "identical-password", role: "employee" }, "10.0.1.2"));
    const body = await res.json();
    for (const choice of body.choices) {
      assert.deepEqual(Object.keys(choice).sort(), ["companyName", "selectionId"]);
    }
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes(REAL_WORKSPACE_ID));
    assert.ok(!raw.includes(ACS_WORKSPACE_ID));
    assert.ok(!raw.includes("emp-admin"));
    assert.ok(!raw.includes("emp-acs"));
    assert.ok(!raw.toLowerCase().includes("password"));
    assert.ok(!raw.includes(sameHash));
  });

  test("each choice's selectionId is unique, and no sft_session cookie is set -- only the short-lived selection-pending cookie", async () => {
    resetState();
    const sameHash = await bcrypt.hash("identical-password", 10);
    resetFixtures({
      employees: [
        {
          data: [
            { id: "emp-admin", password_hash: sameHash, active: true, workspace_id: REAL_WORKSPACE_ID },
            { id: "emp-acs", password_hash: sameHash, active: true, workspace_id: ACS_WORKSPACE_ID },
          ],
        },
      ],
      company_settings: [
        {
          data: [
            { workspace_id: REAL_WORKSPACE_ID, company_name: "Alberto Cleaning Services" },
            { workspace_id: ACS_WORKSPACE_ID, company_name: "ACS" },
          ],
        },
      ],
    });
    const res = await POST(req({ email: "shared@example.com", password: "identical-password", role: "employee" }, "10.0.1.2"));
    const body = await res.json();
    const ids = body.choices.map((c: { selectionId: string }) => c.selectionId);
    assert.equal(new Set(ids).size, ids.length);
    const setCookieHeader = res.headers.get("set-cookie") || "";
    assert.ok(setCookieHeader.includes("sft_employee_workspace_pending="));
    assert.ok(!setCookieHeader.includes("sft_session="));
  });

  test("a successful password match producing a selection challenge still clears the login rate-limit bucket -- the password itself was correct", async () => {
    resetState();
    const sameHash = await bcrypt.hash("identical-password", 10);
    resetFixtures({
      employees: [
        {
          data: [
            { id: "emp-admin", password_hash: sameHash, active: true, workspace_id: REAL_WORKSPACE_ID },
            { id: "emp-acs", password_hash: sameHash, active: true, workspace_id: ACS_WORKSPACE_ID },
          ],
        },
      ],
      company_settings: [
        {
          data: [
            { workspace_id: REAL_WORKSPACE_ID, company_name: "Alberto Cleaning Services" },
            { workspace_id: ACS_WORKSPACE_ID, company_name: "ACS" },
          ],
        },
      ],
    });
    await POST(req({ email: "shared@example.com", password: "identical-password", role: "employee" }, "10.0.1.5"));
    assert.deepEqual(clearRateLimitCalls, [{ bucket: "login", key: "10.0.1.5" }]);
  });

  test("three workspaces sharing the same email AND the same password produces three choices, not an automatic pick or a rejection", async () => {
    resetState();
    const sameHash = await bcrypt.hash("shared-password", 10);
    resetFixtures({
      employees: [
        {
          data: [
            { id: "emp-1", password_hash: sameHash, active: true, workspace_id: "ws-1" },
            { id: "emp-2", password_hash: sameHash, active: true, workspace_id: "ws-2" },
            { id: "emp-3", password_hash: sameHash, active: true, workspace_id: "ws-3" },
          ],
        },
      ],
      company_settings: [
        {
          data: [
            { workspace_id: "ws-1", company_name: "Company One" },
            { workspace_id: "ws-2", company_name: "Company Two" },
            { workspace_id: "ws-3", company_name: "Company Three" },
          ],
        },
      ],
    });
    const res = await POST(req({ email: "shared3@example.com", password: "shared-password", role: "employee" }, "10.0.1.2"));
    const body = await res.json();
    assert.equal(body.next, "select_workspace");
    assert.equal(body.choices.length, 3);
  });

  test("an inactive row for one workspace is excluded from candidates -- only the active workspace's row can ever match", async () => {
    resetState();
    resetFixtures({
      employees: [
        {
          data: [
            { id: "emp-admin", password_hash: await bcrypt.hash("shared-password", 10), active: false, workspace_id: REAL_WORKSPACE_ID },
            { id: "emp-acs", password_hash: await bcrypt.hash("shared-password", 10), active: true, workspace_id: ACS_WORKSPACE_ID },
          ],
        },
      ],
    });
    const res = await POST(req({ email: "shared@example.com", password: "shared-password", role: "employee" }, "10.0.1.2"));
    assert.equal(res.status, 200, "the inactive admin row must never block or get confused with the active ACS row");
  });

  test("three workspaces sharing the email is handled the same way -- exactly one password match still succeeds", async () => {
    resetState();
    resetFixtures({
      employees: [
        {
          data: [
            { id: "emp-1", password_hash: await bcrypt.hash("pw-1", 10), active: true, workspace_id: "ws-1" },
            { id: "emp-2", password_hash: await bcrypt.hash("pw-2", 10), active: true, workspace_id: "ws-2" },
            { id: "emp-3", password_hash: await bcrypt.hash("pw-3", 10), active: true, workspace_id: "ws-3" },
          ],
        },
      ],
    });
    const res = await POST(req({ email: "shared3@example.com", password: "pw-2", role: "employee" }, "10.0.1.2"));
    assert.equal(res.status, 200);
  });
});

describe("POST /api/auth/login -- tester branch remains completely unchanged", () => {
  test("correct tester credentials still issue sft_session directly -- no MFA hand-off", async () => {
    resetState();
    resetFixtures({});
    const res = await POST(req({ email: "tester@example.com", password: "tester-password" }, "10.0.2.1"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.redirect, "/dashboard");
    assert.equal(beginMfaFlowCalls, 0);
    const setCookieHeader = res.headers.get("set-cookie") || "";
    assert.ok(setCookieHeader.includes("sft_session="));
  });
});

describe("POST /api/auth/login -- durable rate limiting (Phase 5.7D-R4)", () => {
  test("calls the durable limiter with the 'login' bucket and the request's IP, before checking any credentials", async () => {
    resetState();
    resetFixtures({});
    await POST(req({ email: "tester@example.com", password: "wrong" }, "7.7.7.7"));
    assert.equal(rateLimitCalls.length, 1);
    assert.equal(rateLimitCalls[0].bucket, "login");
    assert.equal(rateLimitCalls[0].key, "7.7.7.7");
  });

  test("a limited result stops the request immediately with 429, before any credential check", async () => {
    resetState();
    resetFixtures({});
    rateLimitResult = { limited: true, retryAfterSeconds: 600 };
    const res = await POST(req({ email: "tester@example.com", password: "tester-password" }, "7.7.7.7"));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Retry-After"), "600");
    assert.equal(currentFake.calls.length, 0, "no employee/owner lookup should happen once rate-limited");
  });

  test("a successful employee login clears the login bucket (only-failures-count semantics preserved)", async () => {
    resetState();
    resetFixtures({
      employees: [{ data: [{ id: "emp-1", password_hash: await bcrypt.hash("emp-password", 10), active: true, workspace_id: REAL_WORKSPACE_ID }] }],
    });
    await POST(req({ email: "emp@example.com", password: "emp-password", role: "employee" }, "7.7.7.8"));
    assert.deepEqual(clearRateLimitCalls, [{ bucket: "login", key: "7.7.7.8" }]);
  });

  test("a successful tester login clears the login bucket", async () => {
    resetState();
    resetFixtures({});
    await POST(req({ email: "tester@example.com", password: "tester-password" }, "7.7.7.9"));
    assert.deepEqual(clearRateLimitCalls, [{ bucket: "login", key: "7.7.7.9" }]);
  });

  test("a successful owner password verification (advancing to MFA) clears the login bucket", async () => {
    resetState();
    resetFixtures({
      workspace_memberships: [{ data: { workspace_id: REAL_WORKSPACE_ID, session_epoch: 1 } }],
    });
    signInWithPasswordResult = {
      data: { user: { id: AUTH_USER_ID }, session: { access_token: "at", refresh_token: "rt" } },
      error: null,
    };
    await POST(req({ email: "owner@example.com", password: "correct-password" }, "7.7.7.10"));
    assert.deepEqual(clearRateLimitCalls, [{ bucket: "login", key: "7.7.7.10" }]);
  });

  test("a failed login (wrong password) never clears the bucket", async () => {
    resetState();
    resetFixtures({});
    await POST(req({ email: "tester@example.com", password: "wrong" }, "7.7.7.11"));
    assert.deepEqual(clearRateLimitCalls, []);
  });
});
