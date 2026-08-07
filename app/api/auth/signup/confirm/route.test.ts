// Phase 5.7D: route-level tests for app/api/auth/signup/confirm/route.ts --
// the callback that proves email ownership and hands off into the MFA
// flow. @/lib/supabaseAuthClient, @/lib/supabaseAdmin, @/lib/signupProvisioning,
// and @/lib/mfaFlow are mocked in-process. No real Supabase/network call is
// reachable. Run with --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SUPABASE_ANON_KEY = "test-anon-key";
process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";
process.env.SESSION_SECRET = "test-session-secret-signup-confirm";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

const AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";

let exchangeResult: { data: unknown; error: unknown } = {
  data: { session: { access_token: "at", refresh_token: "rt" }, user: { id: AUTH_USER_ID } },
  error: null,
};
let verifyOtpResult: { data: unknown; error: unknown } = {
  data: { session: { access_token: "at", refresh_token: "rt" }, user: { id: AUTH_USER_ID } },
  error: null,
};
let verifyOtpCalls: Array<{ token_hash: string; type: string }> = [];
let getUserByIdResult: { data: unknown; error: unknown } = {
  data: { user: { id: AUTH_USER_ID, email_confirmed_at: "2026-07-26T00:00:00.000Z" } },
  error: null,
};
let provisionCalls: string[] = [];
let beginMfaFlowImpl: () => Promise<unknown> = async () => ({ step: "enroll", pendingToken: "opaque-token-1" });

mock.module("@/lib/supabaseAuthClient", {
  namedExports: {
    createOwnerAuthClient: () => ({
      auth: {
        exchangeCodeForSession: async () => exchangeResult,
        verifyOtp: async (params: { token_hash: string; type: string }) => {
          verifyOtpCalls.push(params);
          return verifyOtpResult;
        },
      },
    }),
  },
});
mock.module("@/lib/supabaseAdmin", {
  namedExports: {
    supabaseAdmin: {
      auth: { admin: { getUserById: async () => getUserByIdResult } },
    },
  },
});
mock.module("@/lib/signupProvisioning", {
  namedExports: {
    provisionOwnerWorkspace: async (id: string) => {
      provisionCalls.push(id);
      return "provisioned-workspace-1";
    },
  },
});
mock.module("@/lib/mfaFlow", {
  namedExports: {
    beginMfaFlow: () => beginMfaFlowImpl(),
  },
});

const { GET } = await import("./route.ts");

function resetState() {
  exchangeResult = {
    data: { session: { access_token: "at", refresh_token: "rt" }, user: { id: AUTH_USER_ID } },
    error: null,
  };
  verifyOtpResult = {
    data: { session: { access_token: "at", refresh_token: "rt" }, user: { id: AUTH_USER_ID } },
    error: null,
  };
  verifyOtpCalls = [];
  getUserByIdResult = { data: { user: { id: AUTH_USER_ID, email_confirmed_at: "2026-07-26T00:00:00.000Z" } }, error: null };
  provisionCalls = [];
  beginMfaFlowImpl = async () => ({ step: "enroll", pendingToken: "opaque-token-1" });
}

function req(code?: string) {
  const url = code ? `http://localhost/api/auth/signup/confirm?code=${code}` : "http://localhost/api/auth/signup/confirm";
  return new Request(url);
}

function tokenHashReq(tokenHash: string, extraQuery = "") {
  return new Request(`http://localhost/api/auth/signup/confirm?token_hash=${tokenHash}${extraQuery}`);
}

function redirectPath(res: Response): string {
  const location = res.headers.get("location") || "";
  return new URL(location).pathname + new URL(location).search;
}

describe("GET /api/auth/signup/confirm", () => {
  test("no code param -> redirected to /signup with an error, nothing exchanged", async () => {
    resetState();
    const res = await GET(req());
    assert.equal(res.status, 307);
    assert.ok(redirectPath(res).startsWith("/signup"));
    assert.equal(provisionCalls.length, 0);
  });

  test("a failed exchange -> redirected to /signup, no provisioning", async () => {
    resetState();
    exchangeResult = { data: {}, error: { message: "invalid code" } };
    const res = await GET(req("bad-code"));
    assert.ok(redirectPath(res).startsWith("/signup"));
    assert.equal(provisionCalls.length, 0);
  });

  test("exchange succeeds but the authoritative re-fetch shows email_confirmed_at is still null -> redirected to /signup, no provisioning (never trusts the exchange response alone)", async () => {
    resetState();
    getUserByIdResult = { data: { user: { id: AUTH_USER_ID, email_confirmed_at: null } }, error: null };
    const res = await GET(req("good-code"));
    assert.ok(redirectPath(res).startsWith("/signup"));
    assert.equal(provisionCalls.length, 0);
  });

  test("confirmed email -> provisions the workspace for exactly the exchanged user id, then begins the MFA flow and redirects to /mfa/enroll", async () => {
    resetState();
    const res = await GET(req("good-code"));
    assert.equal(provisionCalls.length, 1);
    assert.equal(provisionCalls[0], AUTH_USER_ID);
    assert.equal(res.status, 307);
    assert.equal(redirectPath(res), "/mfa/enroll");
    const setCookieHeader = res.headers.get("set-cookie") || "";
    assert.ok(setCookieHeader.includes("sft_mfa_pending="));
    assert.ok(!setCookieHeader.includes("sft_session="));
  });

  test("a challenge outcome (already-enrolled identity resuming) redirects to /mfa/challenge instead", async () => {
    resetState();
    beginMfaFlowImpl = async () => ({ step: "challenge", pendingToken: "tok", factorIds: ["f1"] });
    const res = await GET(req("good-code"));
    assert.equal(redirectPath(res), "/mfa/challenge");
  });

  test("this route never issues sft_session under any outcome", async () => {
    resetState();
    const res = await GET(req("good-code"));
    const setCookieHeader = res.headers.get("set-cookie") || "";
    assert.ok(!setCookieHeader.includes("sft_session="));
  });
});

// Phase 5.7D-R21 (incident-driven -- see the 2026-08-06 Journey Inpsyred and
// 2026-08-07 SFT Signup Test lockouts): token_hash is the stateless,
// server-side-safe confirmation mechanism -- unlike `code` (PKCE), it
// requires no code_verifier persisted between the original signUp() call
// and this later, separate callback request.
describe("GET /api/auth/signup/confirm -- token_hash path (primary, stateless mechanism)", () => {
  test("a token_hash param calls verifyOtp, not exchangeCodeForSession, with type hardcoded to 'signup'", async () => {
    resetState();
    const res = await GET(tokenHashReq("good-token-hash"));
    assert.equal(verifyOtpCalls.length, 1);
    assert.deepEqual(verifyOtpCalls[0], { token_hash: "good-token-hash", type: "signup" });
    assert.equal(provisionCalls.length, 1);
    assert.equal(provisionCalls[0], AUTH_USER_ID);
    assert.equal(redirectPath(res), "/mfa/enroll");
  });

  test("a `type` query param supplied by the URL is never trusted -- verifyOtp is always called with type: 'signup' regardless", async () => {
    resetState();
    await GET(tokenHashReq("good-token-hash", "&type=recovery"));
    assert.equal(verifyOtpCalls.length, 1);
    assert.equal(verifyOtpCalls[0].type, "signup");
  });

  test("a failed verifyOtp -> redirected to /signup, no provisioning", async () => {
    resetState();
    verifyOtpResult = { data: {}, error: { message: "token expired or invalid" } };
    const res = await GET(tokenHashReq("bad-token-hash"));
    assert.ok(redirectPath(res).startsWith("/signup"));
    assert.equal(provisionCalls.length, 0);
  });

  test("verifyOtp succeeds but the authoritative re-fetch shows email_confirmed_at is still null -> redirected to /signup, no provisioning", async () => {
    resetState();
    getUserByIdResult = { data: { user: { id: AUTH_USER_ID, email_confirmed_at: null } }, error: null };
    const res = await GET(tokenHashReq("good-token-hash"));
    assert.ok(redirectPath(res).startsWith("/signup"));
    assert.equal(provisionCalls.length, 0);
  });

  test("when both token_hash and code are present, token_hash (the primary, stateless mechanism) takes precedence -- exchangeCodeForSession is never called", async () => {
    resetState();
    const res = await GET(new Request("http://localhost/api/auth/signup/confirm?token_hash=th-1&code=legacy-code"));
    assert.equal(verifyOtpCalls.length, 1);
    assert.equal(redirectPath(res), "/mfa/enroll");
  });

  test("this route never issues sft_session under the token_hash path either", async () => {
    resetState();
    const res = await GET(tokenHashReq("good-token-hash"));
    const setCookieHeader = res.headers.get("set-cookie") || "";
    assert.ok(!setCookieHeader.includes("sft_session="));
  });
});
