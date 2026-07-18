// Lightweight in-memory login rate limiter, keyed by client IP.
//
// Caveat: state lives in one serverless function instance's memory. Vercel
// may run multiple instances concurrently and recycles them on cold starts,
// so this is NOT a hard distributed limit — a determined attacker spread
// across instances could exceed it. It's a reasonable default for this
// app's threat model (blunting casual credential-stuffing / brute force
// against a single-owner/small-team app), not a guarantee. A durable limit
// would need an external store (e.g. Upstash Redis), which this sprint
// intentionally avoids per "no external service unless absolutely necessary."

type Entry = { failures: number; firstFailureAt: number; lockedUntil: number };

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const attempts = new Map<string, Entry>();

function isStale(entry: Entry, now: number): boolean {
  if (entry.lockedUntil) return entry.lockedUntil < now;
  return now - entry.firstFailureAt > WINDOW_MS;
}

export function isRateLimited(key: string): { limited: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry) return { limited: false };
  if (isStale(entry, now)) {
    attempts.delete(key);
    return { limited: false };
  }
  if (entry.lockedUntil > now) {
    return { limited: true, retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  return { limited: false };
}

export function recordFailedAttempt(key: string): void {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || isStale(entry, now)) {
    attempts.set(key, { failures: 1, firstFailureAt: now, lockedUntil: 0 });
    return;
  }
  entry.failures += 1;
  if (entry.failures >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
}

export function recordSuccessfulAttempt(key: string): void {
  attempts.delete(key);
}
