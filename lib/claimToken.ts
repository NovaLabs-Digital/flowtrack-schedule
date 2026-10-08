import crypto from "crypto";

// A thin, deliberately mockable seam around crypto.randomUUID() -- used by
// app/api/cron/reminders/route.ts to mint a fresh reminder_24h_claim_token
// per claim attempt. Kept as its own module (rather than calling
// crypto.randomUUID() directly in the route) so route-level tests can
// substitute a deterministic sequence via mock.module("@/lib/claimToken",
// ...) without mocking Node's built-in "crypto" module itself, which would
// risk affecting anything else reachable from the same test file.
export function generateClaimToken(): string {
  return crypto.randomUUID();
}
