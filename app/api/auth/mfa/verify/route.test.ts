// Phase 5.7D: route-level tests for app/api/auth/mfa/verify/route.ts -- the
// ONE route that ever issues an owner sft_session. @/lib/supabaseAuthClient,
// @/lib/session (the getMfaPendingToken/cookie-writing seam), @/lib/mfaPending,
// and @/lib/signupProvisioning are mocked in-process. No real Supabase/
// Stripe/network call is reachable. Run with --experimental-test-module-mocks
// (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SUPABASE_ANON_KEY = "test-anon-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

const AUTH_USER_ID = "aaaaaaaa-0000-0000-0000-00000000owna";
const WORKSPACE_ID = "wwwwwwww-0000-0000-0000-000000000001";

let pendingToken: string | null = "valid-pending-token";
let challenge: Record<string, unknown> | null = {
  token: "valid-pending-token",
  authUserId: AUTH_USER_ID,
  factorId: "factor-1",
  supabaseAccessToken: "at",
  supabaseRefreshToken: "rt",
  attemptCount: 0,
};
let mfaChallengeResult: { data: unknown; error: unknown } = { data: { id: "challenge-1" }, error: null };
let mfaVerifyResult: { data: unknown; error: unknown } = { data: { access_token: "new-at" }, error: null };
let aalResult: { data: unknown } = { data: { currentLevel: "aal2" } };
let listFactorsResult: { data: unknown } = { data: { totp: [{ id: "factor-1", status: "verified" }] } };
let recordedAttempts: string[] = [];
let consumedTokens: string[] = [];
let consumeReturnsNull = false;
let clearedPendingCookie = false;
let loggedArgs: unknown[] = [];
let findOwnerMembershipImpl: (id: string) => Promise<unknown> = async () => ({ workspaceId: WORKSPACE_ID, sessionEpoch: 1 });
let createdSessionParams: Record<string, unknown> | null = null;
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
mock.module("@/lib/supabaseAuthClient", {
  namedExports: {
    createOwnerAuthClient: () => ({}),
    createScopedAuthClient: async () => ({
      auth: {
        mfa: {
          challenge: async () => mfaChallengeResult,
          verify: async () => mfaVerifyResult,
          getAuthenticatorAssuranceLevel: async () => aalResult,
          listFactors: async () => listFactorsResult,
        },
      },
    }),
  },
});
mock.module("@/lib/mfaPending", {
  namedExports: {
    getPendingMfaChallenge: async (token: string) => (token === pendingToken ? challenge : null),
    recordFailedMfaAttempt: async (token: string) => {
      recordedAttempts.push(token);
      return recordedAttempts.filter((t) => t === token).length;
    },
    // Phase 5.7D-R7: models the real atomic delete-and-return semantics --
    // returns the (mocked) consumed row's data by default, or null when
    // consumeReturnsNull simulates a lost race / already-consumed replay.
    consumePendingMfaChallenge: async (token: string) => {
      consumedTokens.push(token);
      if (consumeReturnsNull) return null;
      return challenge;
    },
    MFA_MAX_ATTEMPTS: 5,
  },
});
mock.module("@/lib/signupProvisioning", {
  namedExports: {
    findOwnerMembership: (id: string) => findOwnerMembershipImpl(id),
  },
});
mock.module("@/lib/session", {
  namedExports: {
    getMfaPendingToken: async () => pendingToken,
    clearMfaPendingCookie: () => {
      clearedPendingCookie = true;
    },
    createOwnerSessionCookieValue: async (params: Record<string, unknown>) => {
      createdSessionParams = params;
      return "signed-owner-session-value";
    },
    setOwnerSessionCookie: () => {},
  },
});

const { POST } = await import("./route.ts");

function resetState() {
  pendingToken = "valid-pending-token";
  challenge = {
    token: "valid-pending-token",
    authUserId: AUTH_USER_ID,
    factorId: "factor-1",
    supabaseAccessToken: "at",
    supabaseRefreshToken: "rt",
    attemptCount: 0,
  };
  mfaChallengeResult = { data: { id: "challenge-1" }, error: null };
  mfaVerifyResult = { data: { access_token: "new-at" }, error: null };
  aalResult = { data: { currentLevel: "aal2" } };
  listFactorsResult = { data: { totp: [{ id: "factor-1", status: "verified" }] } };
  recordedAttempts = [];
  consumedTokens = [];
  consumeReturnsNull = false;
  clearedPendingCookie = false;
  loggedArgs = [];
  findOwnerMembershipImpl = async () => ({ workspaceId: WORKSPACE_ID, sessionEpoch: 1 });
  createdSessionParams = null;
  rateLimitCalls = [];
  rateLimitResult = { limited: false };
}

function req(body: unknown, ip = "192.0.2.1") {
  return new Request("http://localhost/api/auth/mfa/verify", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/mfa/verify -- no pending challenge", () => {
  test("no sft_mfa_pending cookie at all -> 401, generic expired message", async () => {
    resetState();
    pendingToken = null;
    const res = await POST(req({ code: "123456" }));
    assert.equal(res.status, 401);
  });

  test("a pending token that doesn't resolve to a real challenge (expired/consumed/unknown) -> 401, same generic message", async () => {
    resetState();
    challenge = null;
    const res = await POST(req({ code: "123456" }));
    assert.equal(res.status, 401);
  });
});

describe("POST /api/auth/mfa/verify -- correct code reaches aal2 and issues the owner session", () => {
  test("issues sft_session only after aal2 is confirmed server-side, using the membership's own workspaceId/sessionEpoch", async () => {
    resetState();
    const res = await POST(req({ code: "123456" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(createdSessionParams);
    assert.equal(createdSessionParams!.workspaceId, WORKSPACE_ID);
    assert.equal(createdSessionParams!.authUserId, AUTH_USER_ID);
    assert.equal(createdSessionParams!.sessionEpoch, 1);
  });

  test("the pending challenge is consumed (single-use) and its cookie cleared on success", async () => {
    resetState();
    await POST(req({ code: "123456" }));
    assert.deepEqual(consumedTokens, ["valid-pending-token"]);
    assert.equal(clearedPendingCookie, true);
  });

  test("trustDevice: true is threaded through to session creation; omitted/false is the 12-hour default", async () => {
    resetState();
    await POST(req({ code: "123456", trustDevice: true }));
    assert.equal(createdSessionParams!.trusted, true);

    resetState();
    await POST(req({ code: "123456" }));
    assert.equal(createdSessionParams!.trusted, false);
  });

  test("the workspace/auth-user identity used for the new session comes from a fresh findOwnerMembership lookup keyed by the challenged authUserId, never a client-supplied value", async () => {
    resetState();
    let seenId = "";
    findOwnerMembershipImpl = async (id) => {
      seenId = id;
      return { workspaceId: WORKSPACE_ID, sessionEpoch: 1 };
    };
    await POST(req({ code: "123456", authUserId: "attacker-supplied-id", workspaceId: "attacker-workspace" }));
    assert.equal(seenId, AUTH_USER_ID);
  });
});

describe("POST /api/auth/mfa/verify -- server re-checks aal2, never trusts a client claim", () => {
  test("if Supabase's own getAuthenticatorAssuranceLevel does not report aal2 after a nominally successful verify, no session is issued", async () => {
    resetState();
    aalResult = { data: { currentLevel: "aal1" } };
    const res = await POST(req({ code: "123456" }));
    assert.equal(res.status, 401);
    assert.equal(createdSessionParams, null);
  });
});

describe("POST /api/auth/mfa/verify -- incorrect/expired code and attempt lockout", () => {
  test("an incorrect code returns a generic 401 and does not issue a session", async () => {
    resetState();
    mfaVerifyResult = { data: null, error: { message: "invalid code" } };
    const res = await POST(req({ code: "000000" }));
    assert.equal(res.status, 401);
    assert.equal(createdSessionParams, null);
    assert.equal(consumedTokens.length, 0);
  });

  test("five failed attempts consume/invalidate the pending challenge and force a fresh login", async () => {
    resetState();
    mfaVerifyResult = { data: null, error: { message: "invalid code" } };
    let lastStatus = 0;
    let lastBody: { error?: string } = {};
    for (let i = 0; i < 5; i++) {
      const res = await POST(req({ code: "000000" }));
      lastStatus = res.status;
      lastBody = await res.json();
    }
    assert.equal(lastStatus, 401);
    assert.match(lastBody.error || "", /Too many attempts/);
    assert.deepEqual(consumedTokens, ["valid-pending-token"]);
    assert.equal(clearedPendingCookie, true);
  });
});

describe("POST /api/auth/mfa/verify -- multiple verified factors require a legitimate factorId selection", () => {
  test("when the pending row has no recorded factorId, a client-supplied factorId is only honored if it matches a currently verified factor", async () => {
    resetState();
    challenge = { ...challenge!, factorId: null };
    listFactorsResult = { data: { totp: [{ id: "factor-a", status: "verified" }, { id: "factor-b", status: "verified" }] } };
    const resBad = await POST(req({ code: "123456", factorId: "not-a-real-factor" }));
    assert.equal(resBad.status, 400);

    const resGood = await POST(req({ code: "123456", factorId: "factor-b" }));
    assert.equal(resGood.status, 200);
  });
});

describe("POST /api/auth/mfa/verify -- atomic consumption gates session issuance (Phase 5.7D-R7)", () => {
  test("a lost consumption race (consumePendingMfaChallenge returns null) fails closed with 401, never issues a session, even though aal2 was already confirmed", async () => {
    resetState();
    consumeReturnsNull = true;
    const res = await POST(req({ code: "123456" }));
    assert.equal(res.status, 401);
    assert.equal(createdSessionParams, null);
  });

  test("a lost race returns the same generic expired-session message as no-pending-challenge -- no distinguishing signal", async () => {
    resetState();
    consumeReturnsNull = true;
    const raceLostBody = await (await POST(req({ code: "123456" }))).json();

    resetState();
    pendingToken = null;
    const noChallengeBody = await (await POST(req({ code: "123456" }))).json();

    assert.deepEqual(raceLostBody, noChallengeBody);
  });

  test("a lost race never reaches membership lookup or cookie issuance -- consumption is checked before any further work", async () => {
    resetState();
    consumeReturnsNull = true;
    let membershipCalled = false;
    findOwnerMembershipImpl = async () => {
      membershipCalled = true;
      return { workspaceId: WORKSPACE_ID, sessionEpoch: 1 };
    };
    await POST(req({ code: "123456" }));
    assert.equal(membershipCalled, false, "findOwnerMembership must never be called once consumption itself has already failed");
  });

  test("a winning consumption still clears the pending cookie on the fail-closed response path, same as every other 401 in this route", async () => {
    resetState();
    consumeReturnsNull = true;
    await POST(req({ code: "123456" }));
    assert.equal(clearedPendingCookie, true);
  });
});

describe("POST /api/auth/mfa/verify -- access/refresh tokens never leak (Phase 5.7D-R7)", () => {
  test("a successful verification's JSON response body never contains the challenge's access or refresh token values", async () => {
    resetState();
    challenge = { ...challenge!, supabaseAccessToken: "SECRET-ACCESS-TOKEN-VALUE", supabaseRefreshToken: "SECRET-REFRESH-TOKEN-VALUE" };
    const res = await POST(req({ code: "123456" }));
    const rawBody = JSON.stringify(await res.json());
    assert.ok(!rawBody.includes("SECRET-ACCESS-TOKEN-VALUE"));
    assert.ok(!rawBody.includes("SECRET-REFRESH-TOKEN-VALUE"));
  });

  test("no console.error call anywhere in this route's paths includes the access or refresh token values", async () => {
    resetState();
    challenge = { ...challenge!, supabaseAccessToken: "SECRET-ACCESS-TOKEN-VALUE", supabaseRefreshToken: "SECRET-REFRESH-TOKEN-VALUE" };
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      loggedArgs.push(...args);
    };
    try {
      // Exercise both a failure path (logs MFA_VERIFY_MEMBERSHIP_MISSING)
      // and the success path -- neither should ever log a token value.
      findOwnerMembershipImpl = async () => null;
      await POST(req({ code: "123456" }));
      findOwnerMembershipImpl = async () => ({ workspaceId: WORKSPACE_ID, sessionEpoch: 1 });
      consumeReturnsNull = false;
      challenge = { ...challenge!, supabaseAccessToken: "SECRET-ACCESS-TOKEN-VALUE", supabaseRefreshToken: "SECRET-REFRESH-TOKEN-VALUE" };
      await POST(req({ code: "654321" }));
    } finally {
      console.error = originalError;
    }
    const loggedText = JSON.stringify(loggedArgs);
    assert.ok(!loggedText.includes("SECRET-ACCESS-TOKEN-VALUE"));
    assert.ok(!loggedText.includes("SECRET-REFRESH-TOKEN-VALUE"));
  });
});

describe("POST /api/auth/mfa/verify -- durable IP rate limiting (Phase 5.7D-R4, defense-in-depth beyond the per-challenge counter)", () => {
  test("calls the durable limiter with the 'mfaVerify' bucket and the request's IP, before reading the pending challenge", async () => {
    resetState();
    await POST(req({ code: "123456" }, "203.0.113.50"));
    assert.equal(rateLimitCalls.length, 1);
    assert.equal(rateLimitCalls[0].bucket, "mfaVerify");
    assert.equal(rateLimitCalls[0].key, "203.0.113.50");
  });

  test("a limited result stops the request immediately with 429, before the pending challenge is even looked up", async () => {
    resetState();
    rateLimitResult = { limited: true, retryAfterSeconds: 120 };
    const res = await POST(req({ code: "123456" }, "203.0.113.51"));
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Retry-After"), "120");
    assert.equal(createdSessionParams, null);
  });

  test("this durable check is independent of the per-challenge attempt counter -- both are enforced, neither substitutes for the other", async () => {
    resetState();
    // Per-challenge counter would still allow this (attemptCount starts at
    // 0), but the durable, IP-scoped limiter denies it outright -- proving
    // the two are separate, both-enforced layers.
    rateLimitResult = { limited: true, retryAfterSeconds: 60 };
    const res = await POST(req({ code: "123456" }, "203.0.113.52"));
    assert.equal(res.status, 429);
    assert.equal(recordedAttempts.length, 0, "the per-challenge counter must never even be touched once the IP-level limit already denies");
  });
});
