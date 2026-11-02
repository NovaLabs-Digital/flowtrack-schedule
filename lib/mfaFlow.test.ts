// Phase 5.7D-R12: behavioral tests for lib/mfaFlow.ts's beginMfaFlow -- the
// single shared decision point used by both signup-confirmation and login
// to determine "enroll" vs "challenge" and to create the pending-challenge
// row. Added because this function previously had ZERO dedicated test
// coverage, and its untested behavior (never passing factorId to
// createPendingMfaChallenge) was the exact root cause of a production bug:
// every single-factor login's MFA verification was rejected before
// Supabase's real challenge/verify endpoints were ever reached (see
// app/api/auth/mfa/verify/route.ts's client-supplied-factorId fallback and
// lib/loginNavigation.ts's factorIds query-string threshold). These tests
// use the real Supabase MFA `listFactors()` response shape
// (`{ data: { totp: [...] }, error }`), not an invented shape.
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

let capturedParams: Record<string, unknown> | null = null;
let returnedToken = "opaque-pending-token";

mock.module("@/lib/mfaPending", {
  namedExports: {
    createPendingMfaChallenge: async (params: Record<string, unknown>) => {
      capturedParams = params;
      return returnedToken;
    },
  },
});

const { beginMfaFlow } = await import("./mfaFlow.ts");

function fakeClient(totp: Array<{ id: string; status: string }>) {
  return {
    auth: {
      mfa: {
        listFactors: async () => ({ data: { totp }, error: null }),
      },
    },
  };
}

function resetState() {
  capturedParams = null;
  returnedToken = "opaque-pending-token";
}

const PARAMS = { authUserId: "auth-user-1", accessToken: "at-1", refreshToken: "rt-1" };
// Migration 045: two-step on (every existing and new owner's default), no recovery codes yet.
const ON = { required: true, codesTotal: 0, codesUnused: 0 };

describe("beginMfaFlow -- zero verified factors", () => {
  test("returns step 'enroll' and does not select any factorId", async () => {
    resetState();
    const result = await beginMfaFlow(fakeClient([]), PARAMS, ON);
    assert.deepEqual(result, { step: "enroll", pendingToken: "opaque-pending-token" });
  });

  test("an unverified factor alone is still treated as zero verified factors", async () => {
    resetState();
    const result = await beginMfaFlow(fakeClient([{ id: "factor-1", status: "unverified" }]), PARAMS, ON);
    assert.equal(result.step, "enroll");
    assert.equal(capturedParams!.factorId, null);
  });
});

describe("beginMfaFlow -- exactly one verified factor (Phase 5.7D-R12 regression proof)", () => {
  test("returns step 'challenge' with that factor's id in factorIds", async () => {
    resetState();
    const result = await beginMfaFlow(fakeClient([{ id: "factor-solo", status: "verified" }]), PARAMS, ON);
    assert.deepEqual(result, { step: "challenge", pendingToken: "opaque-pending-token", factorIds: ["factor-solo"] });
  });

  test("passes that exact factor id as factorId to createPendingMfaChallenge -- this is the fix: it was previously never passed at all", async () => {
    resetState();
    await beginMfaFlow(fakeClient([{ id: "factor-solo", status: "verified" }]), PARAMS, ON);
    assert.equal(capturedParams!.factorId, "factor-solo");
  });

  test("the sole verified factor is selected even when unverified factors are also present", async () => {
    resetState();
    const client = fakeClient([
      { id: "factor-old-unverified", status: "unverified" },
      { id: "factor-current", status: "verified" },
    ]);
    const result = await beginMfaFlow(client, PARAMS, ON);
    assert.deepEqual((result as { factorIds: string[] }).factorIds, ["factor-current"]);
    assert.equal(capturedParams!.factorId, "factor-current");
  });

  test("authUserId, accessToken, and refreshToken are passed through to createPendingMfaChallenge unchanged", async () => {
    resetState();
    await beginMfaFlow(fakeClient([{ id: "factor-solo", status: "verified" }]), PARAMS, ON);
    assert.equal(capturedParams!.authUserId, "auth-user-1");
    assert.equal(capturedParams!.supabaseAccessToken, "at-1");
    assert.equal(capturedParams!.supabaseRefreshToken, "rt-1");
  });
});

describe("beginMfaFlow -- multiple verified factors (unchanged ambiguous case)", () => {
  test("returns step 'challenge' with all verified factor ids", async () => {
    resetState();
    const client = fakeClient([
      { id: "factor-a", status: "verified" },
      { id: "factor-b", status: "verified" },
    ]);
    const result = await beginMfaFlow(client, PARAMS, ON);
    assert.deepEqual((result as { factorIds: string[] }).factorIds, ["factor-a", "factor-b"]);
  });

  test("does not select a single factorId on the pending row -- selection remains an explicit client choice, same as before this fix", async () => {
    resetState();
    const client = fakeClient([
      { id: "factor-a", status: "verified" },
      { id: "factor-b", status: "verified" },
    ]);
    await beginMfaFlow(client, PARAMS, ON);
    assert.equal(capturedParams!.factorId, null);
  });
});

describe("beginMfaFlow -- error propagation and real SDK response shape", () => {
  test("propagates a listFactors error instead of swallowing it", async () => {
    resetState();
    const client = { auth: { mfa: { listFactors: async () => ({ data: null, error: { message: "boom" } }) } } };
    await assert.rejects(() => beginMfaFlow(client, PARAMS, ON));
  });

  test("a missing totp array (real SDK shape when a user has enrolled zero factors of any kind) is treated as zero factors, not a throw", async () => {
    resetState();
    const client = { auth: { mfa: { listFactors: async () => ({ data: {}, error: null }) } } };
    const result = await beginMfaFlow(client, PARAMS, ON);
    assert.equal(result.step, "enroll");
  });
});

describe("beginMfaFlow -- migration 045: optional two-step sign-in", () => {
  test("two-step off with no authenticator: password only, and no pending verification is created", async () => {
    resetState();
    const result = await beginMfaFlow(fakeClient([]), PARAMS, { required: false, codesTotal: 0, codesUnused: 0 });
    assert.deepEqual(result, { step: "password" });
    assert.equal(capturedParams, null);
  });

  test("two-step off but an authenticator still exists (a partial failure): the code is still asked for", async () => {
    resetState();
    const result = await beginMfaFlow(fakeClient([{ id: "factor-left", status: "verified" }]), PARAMS, { required: false, codesTotal: 0, codesUnused: 0 });
    assert.equal(result.step, "challenge");
  });

  test("two-step on, no authenticator, and the identity has had recovery codes: a recovery code comes first", async () => {
    resetState();
    const result = await beginMfaFlow(fakeClient([]), PARAMS, { required: true, codesTotal: 10, codesUnused: 0 });
    assert.deepEqual(result, { step: "recover", pendingToken: "opaque-pending-token" });
  });

  test("an unverified authenticator never counts: two-step off still means password only", async () => {
    resetState();
    const result = await beginMfaFlow(fakeClient([{ id: "f", status: "unverified" }]), PARAMS, { required: false, codesTotal: 0, codesUnused: 0 });
    assert.equal(result.step, "password");
  });
});
