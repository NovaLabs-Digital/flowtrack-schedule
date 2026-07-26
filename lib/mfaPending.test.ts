// Phase 5.7D: focused tests for lib/mfaPending.ts's pending_mfa_challenges
// helpers. Exercises the real functions against a fake "pending_mfa_challenges"
// table. No real Supabase/network call is reachable. Run with
// --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SESSION_SECRET = "test-session-secret-mfa-pending";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabaseAdmin } from "./testSupport.ts";
import type { FakeSupabaseFixture } from "./testSupport.ts";

let currentFake = createFakeSupabaseAdmin({});

mock.module("@/lib/supabaseAdmin", {
  namedExports: { supabaseAdmin: { from: (table: string) => currentFake.supabaseAdmin.from(table) } },
});

const {
  createPendingMfaChallenge,
  getPendingMfaChallenge,
  recordFailedMfaAttempt,
  consumePendingMfaChallenge,
  setPendingMfaFactorId,
  MFA_MAX_ATTEMPTS,
} = await import("./mfaPending.ts");

function resetFixtures(responses: Record<string, FakeSupabaseFixture[]>) {
  currentFake = createFakeSupabaseAdmin(responses);
}

describe("createPendingMfaChallenge", () => {
  test("inserts a row and returns an opaque token, never the caller-supplied tokens as the return value", async () => {
    resetFixtures({ pending_mfa_challenges: [{ error: null }] });
    const token = await createPendingMfaChallenge({
      authUserId: "user-1",
      supabaseAccessToken: "at-secret",
      supabaseRefreshToken: "rt-secret",
    });
    assert.equal(typeof token, "string");
    assert.ok(token.length >= 32);
    assert.notEqual(token, "at-secret");
    assert.notEqual(token, "rt-secret");
    const insertCall = currentFake.calls.find((c) => c.table === "pending_mfa_challenges" && c.method === "insert");
    assert.ok(insertCall);
    const row = insertCall!.args[0] as Record<string, unknown>;
    assert.equal(row.auth_user_id, "user-1");
    assert.equal(row.supabase_access_token, "at-secret");
    assert.equal(row.supabase_refresh_token, "rt-secret");
    assert.ok(row.expires_at);
  });

  test("two calls produce different tokens", async () => {
    resetFixtures({ pending_mfa_challenges: [{ error: null }, { error: null }] });
    const a = await createPendingMfaChallenge({ authUserId: "u", supabaseAccessToken: "at", supabaseRefreshToken: "rt" });
    const b = await createPendingMfaChallenge({ authUserId: "u", supabaseAccessToken: "at", supabaseRefreshToken: "rt" });
    assert.notEqual(a, b);
  });
});

describe("getPendingMfaChallenge -- fails closed on anything but a genuinely live, unconsumed row", () => {
  test("returns the challenge for a live, unconsumed, unexpired row", async () => {
    resetFixtures({
      pending_mfa_challenges: [
        {
          data: {
            token: "tok-1",
            auth_user_id: "user-1",
            factor_id: "f1",
            supabase_access_token: "at",
            supabase_refresh_token: "rt",
            attempt_count: 0,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            consumed_at: null,
          },
        },
      ],
    });
    const result = await getPendingMfaChallenge("tok-1");
    assert.ok(result);
    assert.equal(result!.authUserId, "user-1");
  });

  test("a query error returns null", async () => {
    resetFixtures({ pending_mfa_challenges: [{ error: { message: "db error" } }] });
    const result = await getPendingMfaChallenge("tok-1");
    assert.equal(result, null);
  });

  test("a missing row returns null", async () => {
    resetFixtures({ pending_mfa_challenges: [{ data: null }] });
    const result = await getPendingMfaChallenge("tok-1");
    assert.equal(result, null);
  });

  test("an already-consumed row returns null even though it isn't expired yet -- single-use enforced", async () => {
    resetFixtures({
      pending_mfa_challenges: [
        {
          data: {
            token: "tok-1",
            auth_user_id: "user-1",
            factor_id: "f1",
            supabase_access_token: "at",
            supabase_refresh_token: "rt",
            attempt_count: 0,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            consumed_at: new Date().toISOString(),
          },
        },
      ],
    });
    const result = await getPendingMfaChallenge("tok-1");
    assert.equal(result, null);
  });

  test("an expired row (past its 5-minute window) returns null even though it was never consumed", async () => {
    resetFixtures({
      pending_mfa_challenges: [
        {
          data: {
            token: "tok-1",
            auth_user_id: "user-1",
            factor_id: "f1",
            supabase_access_token: "at",
            supabase_refresh_token: "rt",
            attempt_count: 0,
            expires_at: new Date(Date.now() - 1000).toISOString(),
            consumed_at: null,
          },
        },
      ],
    });
    const result = await getPendingMfaChallenge("tok-1");
    assert.equal(result, null);
  });
});

describe("recordFailedMfaAttempt / MFA_MAX_ATTEMPTS", () => {
  test("increments and returns the new attempt count", async () => {
    resetFixtures({
      pending_mfa_challenges: [{ data: { attempt_count: 2 } }, { error: null }],
    });
    const next = await recordFailedMfaAttempt("tok-1");
    assert.equal(next, 3);
    const updateCall = currentFake.calls.find((c) => c.table === "pending_mfa_challenges" && c.method === "update");
    assert.deepEqual(updateCall!.args[0], { attempt_count: 3 });
  });

  test("MFA_MAX_ATTEMPTS is 5", () => {
    assert.equal(MFA_MAX_ATTEMPTS, 5);
  });
});

describe("consumePendingMfaChallenge / setPendingMfaFactorId", () => {
  test("consumePendingMfaChallenge sets consumed_at", async () => {
    resetFixtures({ pending_mfa_challenges: [{ error: null }] });
    await consumePendingMfaChallenge("tok-1");
    const updateCall = currentFake.calls.find((c) => c.table === "pending_mfa_challenges" && c.method === "update");
    assert.ok((updateCall!.args[0] as Record<string, unknown>).consumed_at);
  });

  test("setPendingMfaFactorId writes only factor_id", async () => {
    resetFixtures({ pending_mfa_challenges: [{ error: null }] });
    await setPendingMfaFactorId("tok-1", "factor-9");
    const updateCall = currentFake.calls.find((c) => c.table === "pending_mfa_challenges" && c.method === "update");
    assert.deepEqual(updateCall!.args[0], { factor_id: "factor-9" });
  });
});
