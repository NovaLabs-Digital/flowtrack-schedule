// Phase 5.7D: route-level tests for app/api/auth/mfa/enroll/route.ts.
// @/lib/supabaseAuthClient, @/lib/session, and @/lib/mfaPending are mocked
// in-process. No real Supabase/network call is reachable. Run with
// --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SUPABASE_ANON_KEY = "test-anon-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

let pendingToken: string | null = "valid-pending-token";
let challenge: Record<string, unknown> | null = {
  token: "valid-pending-token",
  authUserId: "aaaaaaaa-0000-0000-0000-00000000owna",
  factorId: null,
  supabaseAccessToken: "at",
  supabaseRefreshToken: "rt",
  attemptCount: 0,
};
let enrollResult: { data: unknown; error: unknown } = {
  data: { id: "factor-1", totp: { qr_code: "data:image/svg+xml;base64,ZmFrZQ==", secret: "JBSWY3DPEHPK3PXP" } },
  error: null,
};
let setFactorIdCalls: Array<[string, string]> = [];

mock.module("@/lib/supabaseAuthClient", {
  namedExports: {
    createOwnerAuthClient: () => ({}),
    createScopedAuthClient: async () => ({
      auth: { mfa: { enroll: async () => enrollResult } },
    }),
  },
});
mock.module("@/lib/session", {
  namedExports: {
    getMfaPendingToken: async () => pendingToken,
  },
});
mock.module("@/lib/mfaPending", {
  namedExports: {
    getPendingMfaChallenge: async (token: string) => (token === pendingToken ? challenge : null),
    setPendingMfaFactorId: async (token: string, factorId: string) => {
      setFactorIdCalls.push([token, factorId]);
    },
  },
});

const { GET } = await import("./route.ts");

function resetState() {
  pendingToken = "valid-pending-token";
  challenge = {
    token: "valid-pending-token",
    authUserId: "aaaaaaaa-0000-0000-0000-00000000owna",
    factorId: null,
    supabaseAccessToken: "at",
    supabaseRefreshToken: "rt",
    attemptCount: 0,
  };
  enrollResult = {
    data: { id: "factor-1", totp: { qr_code: "data:image/svg+xml;base64,ZmFrZQ==", secret: "JBSWY3DPEHPK3PXP" } },
    error: null,
  };
  setFactorIdCalls = [];
}

describe("GET /api/auth/mfa/enroll", () => {
  test("returns Supabase's own QR code and manual secret directly, and records the new factorId against the pending challenge", async () => {
    resetState();
    const res = await GET();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.qrCode, "data:image/svg+xml;base64,ZmFrZQ==");
    assert.equal(body.secret, "JBSWY3DPEHPK3PXP");
    assert.equal(body.factorId, "factor-1");
    assert.deepEqual(setFactorIdCalls, [["valid-pending-token", "factor-1"]]);
  });

  test("no pending MFA cookie -> 401, no enroll call reachable", async () => {
    resetState();
    pendingToken = null;
    const res = await GET();
    assert.equal(res.status, 401);
  });

  test("an expired/consumed/unknown pending token -> 401", async () => {
    resetState();
    challenge = null;
    const res = await GET();
    assert.equal(res.status, 401);
  });

  test("a Supabase enroll error is surfaced as a generic 500, never a raw provider error", async () => {
    resetState();
    enrollResult = { data: null, error: { message: "some internal Supabase detail" } };
    const res = await GET();
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.ok(!body.error.includes("some internal Supabase detail"));
  });
});
