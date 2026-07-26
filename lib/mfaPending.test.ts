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

  // Phase 5.7D-R7: single-use consumption is now a hard DELETE (see
  // consumePendingMfaChallenge below) -- a consumed row is deleted, not
  // soft-marked, so "an already-consumed row returns null" is now simply
  // "a missing row returns null" (already covered above). This function no
  // longer reads or checks consumed_at at all -- proven here by supplying a
  // fixture row that still has a stale consumed_at value set (as a legacy
  // row from before this correction might) and confirming it is returned
  // normally rather than rejected, since consumption and existence are now
  // the same thing by construction.
  test("does not check consumed_at even if a fixture row has it set -- consumption is deletion now, not a flag this function reads", async () => {
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
    assert.ok(result, "a row with a stale consumed_at value must still be returned -- this function no longer reads that column");
    assert.equal(result!.authUserId, "user-1");
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

// Phase 5.7D-R7: consumePendingMfaChallenge is now an atomic DELETE ...
// RETURNING (via .delete().select().maybeSingle()), never a separate
// SELECT followed by a separate DELETE, and never a soft "mark
// consumed_at" UPDATE. These tests prove: the shape of the single database
// call itself (no pre-delete read), that a successful delete returns the
// row's required fields, that a second/replayed call against an
// already-deleted row fails closed, and that database errors fail closed.
describe("consumePendingMfaChallenge -- atomic delete-and-return, single-winner consumption", () => {
  const CHALLENGE_ROW = {
    token: "tok-1",
    auth_user_id: "user-1",
    factor_id: "f1",
    supabase_access_token: "at-secret",
    supabase_refresh_token: "rt-secret",
    attempt_count: 2,
  };

  test("issues exactly one from() call, chaining delete().eq(token, ...).select(...).maybeSingle() -- no separate SELECT precedes the DELETE", async () => {
    resetFixtures({ pending_mfa_challenges: [{ data: CHALLENGE_ROW }] });
    await consumePendingMfaChallenge("tok-1");

    const tableCalls = currentFake.calls.filter((c) => c.table === "pending_mfa_challenges");
    const fromCalls = tableCalls.filter((c) => c.method === "from");
    assert.equal(fromCalls.length, 1, "must be exactly one from() call -- a single chained operation, not a read then a separate write");

    // The chain, in order: delete -> eq(token, ...) -> select(...) -> maybeSingle().
    const methodSequence = tableCalls.map((c) => c.method);
    assert.deepEqual(methodSequence, ["from", "delete", "eq", "select", "maybeSingle"]);

    const eqCall = tableCalls.find((c) => c.method === "eq");
    assert.deepEqual(eqCall!.args, ["token", "tok-1"], "must filter by the exact opaque token, nothing broader");

    // No standalone select-only call exists anywhere before the delete --
    // confirmed by there being no "select" entry earlier in the sequence
    // than "delete".
    assert.ok(methodSequence.indexOf("delete") < methodSequence.indexOf("select"));
  });

  test("a successful delete returns the deleted row's required fields, and never re-exposes the raw column names", async () => {
    resetFixtures({ pending_mfa_challenges: [{ data: CHALLENGE_ROW }] });
    const result = await consumePendingMfaChallenge("tok-1");
    assert.deepEqual(result, {
      token: "tok-1",
      authUserId: "user-1",
      factorId: "f1",
      supabaseAccessToken: "at-secret",
      supabaseRefreshToken: "rt-secret",
      attemptCount: 2,
    });
  });

  test("a second/replayed call against the same token, once already deleted, matches zero rows and returns null -- fails closed, does not resurrect or re-issue the challenge", async () => {
    // Simulates two concurrent or replayed requests for the identical
    // token: the first delete wins and gets the row back; the second
    // delete (modeled here as a fresh call against a fixture representing
    // "already gone") matches nothing.
    resetFixtures({ pending_mfa_challenges: [{ data: CHALLENGE_ROW }] });
    const first = await consumePendingMfaChallenge("tok-1");
    assert.ok(first, "the first (winning) consumption must return the row");

    resetFixtures({ pending_mfa_challenges: [{ data: null }] });
    const second = await consumePendingMfaChallenge("tok-1");
    assert.equal(second, null, "the second (losing/replayed) consumption must return null, never a resurrected row");
  });

  test("a database error on the delete fails closed -- returns null, never throws, never treats an errored call as a successful consumption", async () => {
    resetFixtures({ pending_mfa_challenges: [{ error: { message: "db error" } }] });
    const result = await consumePendingMfaChallenge("tok-1");
    assert.equal(result, null);
  });

  test("a missing/nonexistent token (never existed, or already expired and separately purged) returns null, identical to a replayed consumption -- no distinguishing signal", async () => {
    resetFixtures({ pending_mfa_challenges: [{ data: null }] });
    const result = await consumePendingMfaChallenge("tok-does-not-exist");
    assert.equal(result, null);
  });
});

describe("setPendingMfaFactorId", () => {
  test("writes only factor_id", async () => {
    resetFixtures({ pending_mfa_challenges: [{ error: null }] });
    await setPendingMfaFactorId("tok-1", "factor-9");
    const updateCall = currentFake.calls.find((c) => c.table === "pending_mfa_challenges" && c.method === "update");
    assert.deepEqual(updateCall!.args[0], { factor_id: "factor-9" });
  });
});
