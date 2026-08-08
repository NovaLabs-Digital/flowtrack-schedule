import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Phase 5.7D-R4 — durable, repository-backed rate limiting for public
// auth surfaces (signup, confirmation resend, password login, MFA
// verification). Replaces the previous in-memory-only Map, which cannot
// protect a public endpoint on Vercel: cold starts and multiple
// concurrent serverless instances mean an in-memory counter is very
// likely spread across several completely independent copies, giving an
// attacker effectively no real limit at all. Every attempt is recorded in
// the `rate_limit_counters` table (migration 017) via one atomic RPC call
// (record_rate_limit_attempt), which takes a row lock for the duration of
// its transaction — two concurrent requests for the same bucket are
// serialized by Postgres itself, not raced in application code.

// Fixed, documented per-bucket configuration — never client-influenced,
// never read from a request. Each caller passes its own bucket name; the
// limits below are the only values ever sent to record_rate_limit_attempt.
export const RATE_LIMIT_BUCKETS = {
  signup: { windowSeconds: 15 * 60, maxAttempts: 5, lockoutSeconds: 15 * 60 },
  confirmResend: { windowSeconds: 15 * 60, maxAttempts: 3, lockoutSeconds: 30 * 60 },
  login: { windowSeconds: 15 * 60, maxAttempts: 5, lockoutSeconds: 15 * 60 },
  mfaVerify: { windowSeconds: 5 * 60, maxAttempts: 5, lockoutSeconds: 5 * 60 },
  contact: { windowSeconds: 15 * 60, maxAttempts: 5, lockoutSeconds: 15 * 60 },
} as const;

export type RateLimitBucket = keyof typeof RATE_LIMIT_BUCKETS;

export interface RateLimitResult {
  limited: boolean;
  retryAfterSeconds?: number;
}

async function getSecret(): Promise<string> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  return secret;
}

// Computes the opaque bucket_key: "<bucket>:<hex HMAC-SHA256 of rawKey>".
// The raw key (an IP address, in every real call site) never reaches the
// database — only this keyed, non-reversible digest does. Reuses
// SESSION_SECRET (the same key that already signs every cookie in this
// app) rather than introducing a second secret with its own rotation
// story to manage.
async function hashBucketKey(bucket: RateLimitBucket, rawKey: string): Promise<string> {
  const secret = await getSecret();
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(rawKey));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${bucket}:${hex}`;
}

// Records one attempt against the given bucket for rawKey (an IP address
// in every real call site) and returns whether THIS attempt is limited.
// Fails CLOSED on any storage error: a rate limiter that fails open under
// a database outage is worse than useless for public abuse protection —
// better to briefly deny a legitimate request during an outage than to
// let unlimited signups/logins/MFA attempts through while the limiter
// itself can't be consulted.
export async function checkAndRecordRateLimit(bucket: RateLimitBucket, rawKey: string): Promise<RateLimitResult> {
  const config = RATE_LIMIT_BUCKETS[bucket];
  let bucketKey: string;
  try {
    bucketKey = await hashBucketKey(bucket, rawKey);
  } catch {
    console.error("RATE_LIMIT_HASH_ERROR");
    return { limited: true, retryAfterSeconds: config.lockoutSeconds };
  }

  const { data, error } = await supabaseAdmin.rpc("record_rate_limit_attempt", {
    p_bucket_key: bucketKey,
    p_window_seconds: config.windowSeconds,
    p_max_attempts: config.maxAttempts,
    p_lockout_seconds: config.lockoutSeconds,
  });

  if (error) {
    console.error("RATE_LIMIT_STORAGE_ERROR");
    return { limited: true, retryAfterSeconds: config.lockoutSeconds };
  }

  const row = (Array.isArray(data) ? data[0] : data) as { limited: boolean; retry_after_seconds: number } | undefined;
  if (!row) {
    console.error("RATE_LIMIT_STORAGE_ERROR");
    return { limited: true, retryAfterSeconds: config.lockoutSeconds };
  }

  return { limited: row.limited, retryAfterSeconds: row.limited ? row.retry_after_seconds : undefined };
}

// Clears a bucket outright — used only by the password-login bucket,
// whose pre-existing (pre-durable) semantics were "only failures count; a
// successful login clears the count." Preserved deliberately rather than
// silently changed to "every attempt counts forever," which is the
// stricter (and intentionally different) rule for signup/confirmation-
// resend/MFA-verify, whose abuse shape is different: a successful signup
// or a successful MFA verification IS itself part of the thing worth
// limiting, whereas a successful login is the legitimate outcome logins
// exist to allow.
export async function clearRateLimit(bucket: RateLimitBucket, rawKey: string): Promise<void> {
  let bucketKey: string;
  try {
    bucketKey = await hashBucketKey(bucket, rawKey);
  } catch {
    return;
  }
  const { error } = await supabaseAdmin.rpc("clear_rate_limit", { p_bucket_key: bucketKey });
  if (error) {
    console.error("RATE_LIMIT_CLEAR_ERROR");
  }
}
