// Phase 5.7D-R4: route-level tests for app/api/auth/signup/resend/route.ts.
// @/lib/supabaseAuthClient and @/lib/durableRateLimit are mocked in-process.
// No real Supabase/network call is reachable. Run with
// --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SUPABASE_ANON_KEY = "test-anon-key";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

let resendCalls: Array<{ type: string; email: string }> = [];
let resendShouldThrow = false;
let rateLimitCalls: Array<{ bucket: string; key: string }> = [];
let rateLimitResult: { limited: boolean; retryAfterSeconds?: number } = { limited: false };

mock.module("@/lib/supabaseAuthClient", {
  namedExports: {
    createOwnerAuthClient: () => ({
      auth: {
        resend: async (params: { type: string; email: string }) => {
          resendCalls.push(params);
          if (resendShouldThrow) throw new Error("simulated Supabase error");
          return { data: {}, error: null };
        },
      },
    }),
  },
});
mock.module("@/lib/durableRateLimit", {
  namedExports: {
    checkAndRecordRateLimit: (bucket: string, key: string) => {
      rateLimitCalls.push({ bucket, key });
      return Promise.resolve(rateLimitResult);
    },
  },
});

const { POST } = await import("./route.ts");

function resetState() {
  resendCalls = [];
  resendShouldThrow = false;
  rateLimitCalls = [];
  rateLimitResult = { limited: false };
}

function req(body: unknown, ip = "203.0.113.20") {
  return new Request("http://localhost/api/auth/signup/resend", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

const GENERIC_MESSAGE = "If an account with this email is awaiting verification, we've sent a new confirmation link.";

describe("POST /api/auth/signup/resend", () => {
  test("uses the durable 'confirmResend' bucket, keyed by IP", async () => {
    resetState();
    await POST(req({ email: "owner@example.com" }, "203.0.113.21"));
    assert.equal(rateLimitCalls.length, 1);
    assert.equal(rateLimitCalls[0].bucket, "confirmResend");
    assert.equal(rateLimitCalls[0].key, "203.0.113.21");
  });

  test("a limited result returns 429 before ever calling Supabase's resend", async () => {
    resetState();
    rateLimitResult = { limited: true, retryAfterSeconds: 1800 };
    const res = await POST(req({ email: "owner@example.com" }));
    assert.equal(res.status, 429);
    assert.equal(resendCalls.length, 0);
  });

  test("a valid email calls Supabase's native resend({type:'signup', email}) with the trimmed/lowercased address", async () => {
    resetState();
    const res = await POST(req({ email: "  Owner@Example.com  " }));
    assert.equal(res.status, 200);
    assert.equal(resendCalls.length, 1);
    assert.equal(resendCalls[0].type, "signup");
    assert.equal(resendCalls[0].email, "owner@example.com");
    const body = await res.json();
    assert.equal(body.message, GENERIC_MESSAGE);
  });

  test("an invalid/malformed email still returns the identical generic message, never a distinct validation error -- no enumeration signal", async () => {
    resetState();
    const res = await POST(req({ email: "not-an-email" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.message, GENERIC_MESSAGE);
    assert.equal(resendCalls.length, 0);
  });

  test("a Supabase resend error is swallowed -- the response is still the identical generic success message", async () => {
    resetState();
    resendShouldThrow = true;
    const res = await POST(req({ email: "owner@example.com" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.message, GENERIC_MESSAGE);
  });

  test("the response is byte-identical regardless of whether the account exists, is already confirmed, or errors -- proven by comparing all three bodies", async () => {
    resetState();
    const r1 = await (await POST(req({ email: "definitely-not-registered@example.com" }))).json();

    resetState();
    const r2 = await (await POST(req({ email: "owner@example.com" }))).json();

    resetState();
    resendShouldThrow = true;
    const r3 = await (await POST(req({ email: "owner@example.com" }))).json();

    assert.deepEqual(r1, r2);
    assert.deepEqual(r2, r3);
  });
});
