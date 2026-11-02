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
// Migration 045 fixtures: existing authenticators, the two-step setting, and
// the per-identity change lock.
let factors: Array<{ id: string; status: string }> = [];
let security = { required: true, codesTotal: 0, codesUnused: 0 };
let lockFree = true;
let lockCalls: string[] = [];
let enrollCalls = 0;

mock.module("@/lib/supabaseAuthClient", {
  namedExports: {
    createOwnerAuthClient: () => ({}),
    createScopedAuthClient: async () => ({
      auth: {
        mfa: {
          enroll: async () => {
            enrollCalls++;
            return enrollResult;
          },
          listFactors: async () => ({ data: { totp: factors }, error: null }),
        },
      },
    }),
  },
});
mock.module("@/lib/ownerSecurityStore", {
  namedExports: {
    getOwnerSecurityState: async () => security,
    lockOwnerSecurity: async (_user: string, holder: string) => {
      lockCalls.push(holder);
      return lockFree;
    },
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
    setPendingEnrolled: async (token: string, factorId: string) => {
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
    purpose: "login",
    enrolled: false,
    recovered: false,
  };
  factors = [];
  security = { required: true, codesTotal: 0, codesUnused: 0 };
  lockFree = true;
  lockCalls = [];
  enrollCalls = 0;
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

describe("GET /api/auth/mfa/enroll -- migration 045: who may set up an authenticator", () => {
  test("signing in with none set up and no recovery codes ever: allowed, and the change lock is taken for this verification", async () => {
    resetState();
    const res = await GET();
    assert.equal(res.status, 200);
    assert.equal(lockCalls.length, 1);
    assert.match(lockCalls[0], /^[0-9a-f]{64}$/, "the lock holder is a hash, never the pending token itself");
  });

  test("this identity has had recovery codes: refused until a recovery code was accepted in this sign-in", async () => {
    resetState();
    security = { required: true, codesTotal: 10, codesUnused: 4 };
    assert.equal((await GET()).status, 400);
    assert.equal(enrollCalls, 0);
    challenge = { ...challenge!, recovered: true };
    assert.equal((await GET()).status, 200);
  });

  test("an authenticator already exists: refused (sign-in asks for its code instead)", async () => {
    resetState();
    factors = [{ id: "existing", status: "verified" }];
    assert.equal((await GET()).status, 400);
    assert.equal(enrollCalls, 0);
  });

  test("turning two-step on: allowed only while it is off", async () => {
    resetState();
    challenge = { ...challenge!, purpose: "enable" };
    assert.equal((await GET()).status, 400);
    security = { required: false, codesTotal: 0, codesUnused: 0 };
    assert.equal((await GET()).status, 200);
  });

  test("never during turning off or new recovery codes", async () => {
    for (const purpose of ["disable", "codes"]) {
      resetState();
      challenge = { ...challenge!, purpose };
      assert.equal((await GET()).status, 400);
      assert.equal(enrollCalls, 0);
    }
  });

  test("another security change holds the lock: refused (409) before any authenticator is created", async () => {
    resetState();
    lockFree = false;
    assert.equal((await GET()).status, 409);
    assert.equal(enrollCalls, 0);
  });
});
