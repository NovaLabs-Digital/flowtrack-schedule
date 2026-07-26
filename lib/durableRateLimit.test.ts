// Phase 5.7D-R4: focused tests for lib/durableRateLimit.ts. Exercises the
// real checkAndRecordRateLimit/clearRateLimit functions against a fake
// Supabase admin client whose .rpc() is fully controllable, proving:
// atomic-call semantics (one round trip per attempt), independent buckets,
// fail-closed behavior on a storage error, and that no raw IP is ever sent
// to Postgres (only a keyed hash). No real Supabase/network call is
// reachable. Run with --experimental-test-module-mocks (see package.json).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.SESSION_SECRET = "test-session-secret-durable-rate-limit";

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: unknown } = { data: [{ limited: false, retry_after_seconds: 0 }], error: null };

mock.module("@/lib/supabaseAdmin", {
  namedExports: {
    supabaseAdmin: {
      rpc: (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        return Promise.resolve(rpcResult);
      },
    },
  },
});

const { checkAndRecordRateLimit, clearRateLimit, RATE_LIMIT_BUCKETS } = await import("./durableRateLimit.ts");

function resetState() {
  rpcCalls = [];
  rpcResult = { data: [{ limited: false, retry_after_seconds: 0 }], error: null };
}

describe("checkAndRecordRateLimit -- one atomic RPC call per attempt", () => {
  test("calls record_rate_limit_attempt exactly once per attempt, with the bucket's fixed, documented window/max/lockout", () => {
    resetState();
    return checkAndRecordRateLimit("signup", "203.0.113.5").then(() => {
      assert.equal(rpcCalls.length, 1);
      assert.equal(rpcCalls[0].fn, "record_rate_limit_attempt");
      assert.equal(rpcCalls[0].args.p_window_seconds, RATE_LIMIT_BUCKETS.signup.windowSeconds);
      assert.equal(rpcCalls[0].args.p_max_attempts, RATE_LIMIT_BUCKETS.signup.maxAttempts);
      assert.equal(rpcCalls[0].args.p_lockout_seconds, RATE_LIMIT_BUCKETS.signup.lockoutSeconds);
    });
  });

  test("never sends the raw IP to Postgres -- only a keyed hash, prefixed with the bucket name", async () => {
    resetState();
    await checkAndRecordRateLimit("login", "198.51.100.7");
    const sentKey = rpcCalls[0].args.p_bucket_key as string;
    assert.ok(!sentKey.includes("198.51.100.7"));
    assert.ok(sentKey.startsWith("login:"));
  });

  test("the same IP and bucket always hashes to the same key; different IPs hash to different keys", async () => {
    resetState();
    await checkAndRecordRateLimit("login", "10.0.0.1");
    await checkAndRecordRateLimit("login", "10.0.0.1");
    await checkAndRecordRateLimit("login", "10.0.0.2");
    assert.equal(rpcCalls[0].args.p_bucket_key, rpcCalls[1].args.p_bucket_key);
    assert.notEqual(rpcCalls[0].args.p_bucket_key, rpcCalls[2].args.p_bucket_key);
  });

  test("the same IP hashes to a DIFFERENT key across different buckets -- signup/login/confirmResend/mfaVerify are fully independent", async () => {
    resetState();
    await checkAndRecordRateLimit("signup", "10.0.0.9");
    await checkAndRecordRateLimit("login", "10.0.0.9");
    await checkAndRecordRateLimit("confirmResend", "10.0.0.9");
    await checkAndRecordRateLimit("mfaVerify", "10.0.0.9");
    const keys = rpcCalls.map((c) => c.args.p_bucket_key);
    assert.equal(new Set(keys).size, 4, "all four bucket keys must be distinct for the same IP");
  });

  test("returns limited: true with retryAfterSeconds when the RPC reports a lockout", async () => {
    resetState();
    rpcResult = { data: [{ limited: true, retry_after_seconds: 900 }], error: null };
    const result = await checkAndRecordRateLimit("signup", "10.0.0.3");
    assert.equal(result.limited, true);
    assert.equal(result.retryAfterSeconds, 900);
  });

  test("fails CLOSED (limited: true) on a storage/RPC error -- never fails open", async () => {
    resetState();
    rpcResult = { data: null, error: { message: "simulated database outage" } };
    const result = await checkAndRecordRateLimit("signup", "10.0.0.4");
    assert.equal(result.limited, true);
    assert.ok(result.retryAfterSeconds! > 0);
  });

  test("fails CLOSED when the RPC returns no row at all", async () => {
    resetState();
    rpcResult = { data: [], error: null };
    const result = await checkAndRecordRateLimit("login", "10.0.0.5");
    assert.equal(result.limited, true);
  });
});

describe("clearRateLimit", () => {
  test("invokes clear_rate_limit with the same hashed bucket key shape", async () => {
    resetState();
    await clearRateLimit("login", "10.0.0.6");
    assert.equal(rpcCalls.length, 1);
    assert.equal(rpcCalls[0].fn, "clear_rate_limit");
    assert.ok((rpcCalls[0].args.p_bucket_key as string).startsWith("login:"));
  });

  test("swallows a storage error rather than throwing -- clearing on success is a courtesy, not a security-critical path", async () => {
    resetState();
    rpcResult = { data: null, error: { message: "simulated error" } };
    await assert.doesNotReject(() => clearRateLimit("login", "10.0.0.7"));
  });
});

describe("RATE_LIMIT_BUCKETS -- fixed, documented configuration", () => {
  test("signup and confirmResend count every attempt within a 15/30-minute window; mfaVerify uses a tight 5-minute window matching the pending-challenge TTL", () => {
    assert.equal(RATE_LIMIT_BUCKETS.signup.windowSeconds, 15 * 60);
    assert.equal(RATE_LIMIT_BUCKETS.signup.maxAttempts, 5);
    assert.equal(RATE_LIMIT_BUCKETS.confirmResend.maxAttempts, 3);
    assert.equal(RATE_LIMIT_BUCKETS.login.maxAttempts, 5);
    assert.equal(RATE_LIMIT_BUCKETS.mfaVerify.windowSeconds, 5 * 60);
    assert.equal(RATE_LIMIT_BUCKETS.mfaVerify.maxAttempts, 5);
  });

  test("exactly four buckets exist -- signup, confirmResend, login, mfaVerify", () => {
    assert.deepEqual(Object.keys(RATE_LIMIT_BUCKETS).sort(), ["confirmResend", "login", "mfaVerify", "signup"]);
  });
});
