import { timingSafeEqual } from "crypto";

// Constant-time string comparison for secrets (passwords, tokens). Plain
// `===` short-circuits on the first differing byte, which leaks a timing
// signal proportional to how many leading characters match — irrelevant for
// bcrypt hashes (already constant-time internally) but real for the raw
// env-var comparisons used for owner/tester/cron auth.
export function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Do a same-length dummy comparison so a length mismatch doesn't itself
    // return faster than a same-length mismatch would.
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
