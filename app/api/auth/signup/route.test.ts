// Phase 5.7D-R4: route-level tests for app/api/auth/signup/route.ts.
// @/lib/signupAuth, @/lib/signupProvisioning, @/lib/mfaFlow, and (as of
// R4) @/lib/durableRateLimit are mocked in-process -- the durable,
// repository-backed rate limiter (migration 017's rate_limit_counters)
// replaced the previous in-memory-only limiter, and this file exercises
// the route's OWN logic (does it call the rate limiter first, does it
// stop on a limited result) via a fully controllable fake, rather than
// depending on real Postgres timing/concurrency (that atomicity guarantee
// is proven at the SQL level by migrations/017's own tests and at the
// lib level by lib/durableRateLimit.test.ts). @/lib/session runs for
// real (pure crypto, no network). No real Supabase/Stripe/network call is
// reachable. Run with --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.SESSION_SECRET = "test-session-secret-signup-route";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

let signInWithPasswordImpl: (email: string, password: string) => Promise<unknown> = async () => null;
let signUpImpl: (email: string, password: string) => Promise<unknown> = async () => ({ outcome: "created", userId: "new-user-1" });
let findOwnerMembershipImpl: (authUserId: string) => Promise<unknown> = async () => null;
let provisionOwnerWorkspaceCalls: string[] = [];
let createPendingSignupCalls: Array<Record<string, unknown>> = [];
let beginMfaFlowCalls: Array<Record<string, unknown>> = [];
let beginMfaFlowImpl: () => Promise<unknown> = async () => ({ step: "enroll", pendingToken: "opaque-token-1" });
let rateLimitCalls: Array<{ bucket: string; key: string }> = [];
let rateLimitResult: { limited: boolean; retryAfterSeconds?: number } = { limited: false };

mock.module("@/lib/durableRateLimit", {
  namedExports: {
    checkAndRecordRateLimit: (bucket: string, key: string) => {
      rateLimitCalls.push({ bucket, key });
      return Promise.resolve(rateLimitResult);
    },
  },
});
mock.module("@/lib/signupAuth", {
  namedExports: {
    signInWithPassword: (email: string, password: string) => signInWithPasswordImpl(email, password),
    signUp: (email: string, password: string) => signUpImpl(email, password),
  },
});
mock.module("@/lib/signupProvisioning", {
  namedExports: {
    createPendingSignup: (params: Record<string, unknown>) => {
      createPendingSignupCalls.push(params);
      return Promise.resolve();
    },
    findOwnerMembership: (authUserId: string) => findOwnerMembershipImpl(authUserId),
    provisionOwnerWorkspace: (authUserId: string) => {
      provisionOwnerWorkspaceCalls.push(authUserId);
      return Promise.resolve("provisioned-workspace-1");
    },
  },
});
mock.module("@/lib/mfaFlow", {
  namedExports: {
    beginMfaFlow: (...args: unknown[]) => {
      beginMfaFlowCalls.push({ args });
      return beginMfaFlowImpl();
    },
  },
});

const { POST } = await import("./route.ts");

function resetState() {
  signInWithPasswordImpl = async () => null;
  signUpImpl = async () => ({ outcome: "created", userId: "new-user-1" });
  findOwnerMembershipImpl = async () => null;
  provisionOwnerWorkspaceCalls = [];
  createPendingSignupCalls = [];
  beginMfaFlowCalls = [];
  beginMfaFlowImpl = async () => ({ step: "enroll", pendingToken: "opaque-token-1" });
  rateLimitCalls = [];
  rateLimitResult = { limited: false };
}

const VALID_BODY = {
  email: "Owner@Example.com",
  password: "correct-horse-battery-staple",
  companyName: "Acme Cleaning",
  termsAccepted: true,
};

function req(body: unknown, ip = "203.0.113.10") {
  return new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/signup -- field validation, entirely server-side authoritative", () => {
  test("rejects a missing/invalid email", async () => {
    resetState();
    const res = await POST(req({ ...VALID_BODY, email: "not-an-email" }, "1.1.1.1"));
    assert.equal(res.status, 400);
  });

  test("rejects a password shorter than 12 characters, even if the client claims otherwise", async () => {
    resetState();
    const res = await POST(req({ ...VALID_BODY, password: "short11char" }, "1.1.1.2"));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /12 characters/);
  });

  test("rejects a missing/blank company name", async () => {
    resetState();
    const res = await POST(req({ ...VALID_BODY, companyName: "   " }, "1.1.1.3"));
    assert.equal(res.status, 400);
  });

  test("rejects when termsAccepted is not literally true", async () => {
    resetState();
    const res = await POST(req({ ...VALID_BODY, termsAccepted: "yes" }, "1.1.1.4"));
    assert.equal(res.status, 400);
  });

  test("email is trimmed and lowercased before any downstream call", async () => {
    resetState();
    let seenEmail = "";
    signUpImpl = async (email) => {
      seenEmail = email;
      return { outcome: "created", userId: "u1" };
    };
    await POST(req({ ...VALID_BODY, email: "  Owner@Example.COM  " }, "1.1.1.5"));
    assert.equal(seenEmail, "owner@example.com");
  });
});

describe("POST /api/auth/signup -- no client-controlled provisioning fields are ever honored", () => {
  test("workspace_id, role, billing_mode, notifications_enabled, booking_enabled, and trial fields in the request body have no effect and are never forwarded", async () => {
    resetState();
    const res = await POST(
      req(
        {
          ...VALID_BODY,
          workspace_id: "attacker-workspace",
          role: "owner",
          billing_mode: "internal",
          notifications_enabled: true,
          booking_enabled: true,
          trial_consumed_at: null,
        },
        "1.1.1.6"
      )
    );
    assert.equal(res.status, 200);
    assert.equal(createPendingSignupCalls.length, 1);
    const forwarded = createPendingSignupCalls[0];
    assert.ok(!("workspace_id" in forwarded));
    assert.ok(!("role" in forwarded));
    assert.ok(!("billing_mode" in forwarded));
    assert.ok(!("notifications_enabled" in forwarded));
    assert.ok(!("booking_enabled" in forwarded));
    assert.ok(!("trial_consumed_at" in forwarded));
  });
});

describe("POST /api/auth/signup -- fresh signup", () => {
  test("a genuinely new email creates a pending signup and returns check_email, without ever calling provisionOwnerWorkspace", async () => {
    resetState();
    const res = await POST(req(VALID_BODY, "1.1.2.1"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.next, "check_email");
    assert.equal(createPendingSignupCalls.length, 1);
    assert.equal(createPendingSignupCalls[0].companyName, "Acme Cleaning");
    assert.equal(provisionOwnerWorkspaceCalls.length, 0);
    assert.equal(beginMfaFlowCalls.length, 0);
  });

  test("signUp reporting already_registered (password did not match / signInWithPassword failed) returns the approved message, not check_email", async () => {
    resetState();
    signUpImpl = async () => ({ outcome: "already_registered" });
    const res = await POST(req(VALID_BODY, "1.1.2.2"));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, "An account with this email already exists.");
    assert.equal(createPendingSignupCalls.length, 0);
  });
});

describe("POST /api/auth/signup -- resume path (password proven for an existing account)", () => {
  test("password verified, no owner membership yet -> provisions the workspace and begins the MFA flow, no session issued directly", async () => {
    resetState();
    signInWithPasswordImpl = async () => ({ userId: "existing-user-1", accessToken: "at", refreshToken: "rt" });
    findOwnerMembershipImpl = async () => null;
    const res = await POST(req(VALID_BODY, "1.1.3.1"));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.next, "enroll");
    assert.equal(provisionOwnerWorkspaceCalls.length, 1);
    assert.equal(provisionOwnerWorkspaceCalls[0], "existing-user-1");
    assert.equal(beginMfaFlowCalls.length, 1);
    // No sft_session cookie is ever set by this route -- only sft_mfa_pending.
    const setCookieHeader = res.headers.get("set-cookie") || "";
    assert.ok(!setCookieHeader.includes("sft_session="));
  });

  test("password verified, owner membership already exists -> the approved 'already exists' message, zero provisioning, zero MFA flow", async () => {
    resetState();
    signInWithPasswordImpl = async () => ({ userId: "existing-user-2", accessToken: "at", refreshToken: "rt" });
    findOwnerMembershipImpl = async () => ({ workspaceId: "ws-1", sessionEpoch: 1 });
    const res = await POST(req(VALID_BODY, "1.1.3.2"));
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, "An account with this email already exists.");
    assert.equal(provisionOwnerWorkspaceCalls.length, 0);
    assert.equal(beginMfaFlowCalls.length, 0);
  });

  test("this route never issues an owner sft_session under any outcome -- only the MFA verify route does", async () => {
    resetState();
    signInWithPasswordImpl = async () => ({ userId: "existing-user-3", accessToken: "at", refreshToken: "rt" });
    findOwnerMembershipImpl = async () => null;
    const res = await POST(req(VALID_BODY, "1.1.3.3"));
    const setCookieHeader = res.headers.get("set-cookie") || "";
    assert.ok(!setCookieHeader.includes("sft_session="));
  });
});

describe("POST /api/auth/signup -- durable rate limiting (Phase 5.7D-R4)", () => {
  test("calls the durable limiter with the 'signup' bucket and the request's IP, before any other work", async () => {
    resetState();
    await POST(req(VALID_BODY, "9.9.9.9"));
    assert.equal(rateLimitCalls.length, 1);
    assert.equal(rateLimitCalls[0].bucket, "signup");
    assert.equal(rateLimitCalls[0].key, "9.9.9.9");
  });

  test("a limited result stops the request immediately with 429, before any signup logic runs", async () => {
    resetState();
    rateLimitResult = { limited: true, retryAfterSeconds: 900 };
    const res = await POST(req(VALID_BODY, "9.9.9.9"));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Retry-After"), "900");
    assert.equal(createPendingSignupCalls.length, 0);
    assert.equal(provisionOwnerWorkspaceCalls.length, 0);
  });

  test("an allowed result lets the request proceed normally", async () => {
    resetState();
    rateLimitResult = { limited: false };
    const res = await POST(req(VALID_BODY, "9.9.9.9"));
    assert.equal(res.status, 200);
  });
});
