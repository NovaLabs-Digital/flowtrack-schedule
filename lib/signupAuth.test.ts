// Phase 5.7D-R21 (incident-driven -- see the 2026-08-06 Journey Inpsyred and
// 2026-08-07 SFT Signup Test lockouts): lib/signupAuth.ts's signUp() now
// passes emailRedirectTo explicitly, rather than leaving the confirmation
// email's destination entirely governed by Supabase Dashboard config. This
// file did not previously have a dedicated test. @/lib/supabaseAuthClient is
// mocked in-process; no real Supabase/network call is reachable.
process.env.NEXT_PUBLIC_APP_URL = "https://app.example.com";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

let signUpResult: { data: unknown; error: unknown } = {
  data: { user: { id: "u1", identities: [{ id: "i1" }] }, session: { access_token: "at", refresh_token: "rt" } },
  error: null,
};
let signInResult: { data: unknown; error: unknown } = {
  data: { user: { id: "u1" }, session: { access_token: "at", refresh_token: "rt" } },
  error: null,
};
let signUpCalls: Array<Record<string, unknown>> = [];

mock.module("@/lib/supabaseAuthClient", {
  namedExports: {
    createOwnerAuthClient: () => ({
      auth: {
        signUp: async (params: Record<string, unknown>) => {
          signUpCalls.push(params);
          return signUpResult;
        },
        signInWithPassword: async () => signInResult,
      },
    }),
  },
});

const { signUp, signInWithPassword } = await import("./signupAuth.ts");

function resetState() {
  signUpCalls = [];
  signUpResult = {
    data: { user: { id: "u1", identities: [{ id: "i1" }] }, session: { access_token: "at", refresh_token: "rt" } },
    error: null,
  };
  signInResult = {
    data: { user: { id: "u1" }, session: { access_token: "at", refresh_token: "rt" } },
    error: null,
  };
}

describe("signUp -- passes an explicit emailRedirectTo pointing at our own confirm route", () => {
  test("calls the underlying Supabase signUp with options.emailRedirectTo = `${NEXT_PUBLIC_APP_URL}/api/auth/signup/confirm`", async () => {
    resetState();
    await signUp("owner@example.com", "correct-horse-battery-staple");
    assert.equal(signUpCalls.length, 1);
    assert.deepEqual(signUpCalls[0], {
      email: "owner@example.com",
      password: "correct-horse-battery-staple",
      options: { emailRedirectTo: "https://app.example.com/api/auth/signup/confirm" },
    });
  });

  test("a successful signup returns outcome 'created' with the new user id", async () => {
    resetState();
    const result = await signUp("owner@example.com", "correct-horse-battery-staple");
    assert.equal(result.outcome, "created");
    assert.equal(result.userId, "u1");
  });

  test("Supabase's anti-enumeration empty-identities response is reported as already_registered", async () => {
    resetState();
    signUpResult = { data: { user: { id: "u1", identities: [] } }, error: null };
    const result = await signUp("owner@example.com", "correct-horse-battery-staple");
    assert.equal(result.outcome, "already_registered");
  });

  test("an explicit Supabase error is reported as already_registered (anti-enumeration -- never a distinct error)", async () => {
    resetState();
    signUpResult = { data: null, error: { message: "User already registered" } };
    const result = await signUp("owner@example.com", "correct-horse-battery-staple");
    assert.equal(result.outcome, "already_registered");
  });
});

describe("signInWithPassword -- unaffected by the emailRedirectTo change", () => {
  test("a successful sign-in returns the user id and tokens", async () => {
    resetState();
    const result = await signInWithPassword("owner@example.com", "correct-password");
    assert.deepEqual(result, { userId: "u1", accessToken: "at", refreshToken: "rt" });
  });

  test("a failed sign-in returns null", async () => {
    resetState();
    signInResult = { data: null, error: { message: "invalid" } };
    const result = await signInWithPassword("owner@example.com", "wrong");
    assert.equal(result, null);
  });
});
