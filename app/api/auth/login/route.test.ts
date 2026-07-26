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

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
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

describe("POST /api/auth/login -- employee branch remains completely unchanged", () => {
  test("a correct employee password still issues sft_session directly -- no MFA hand-off, beginMfaFlow never called", async () => {
    resetState();
    resetFixtures({
      employees: [{ data: { id: "emp-1", password_hash: await bcrypt.hash("emp-password", 10), active: true, workspace_id: REAL_WORKSPACE_ID } }],
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
      employees: [{ data: { id: "emp-1", password_hash: await bcrypt.hash("emp-password", 10), active: true, workspace_id: REAL_WORKSPACE_ID } }],
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
