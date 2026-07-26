// Phase 5.7D-R4: an exhaustive, self-updating inventory proof. Walks every
// app/api/**/route.ts file at test time (not a hand-maintained list that
// can silently go stale) and requires that any route reachable by an
// owner-role session references one of the three approved,
// session_epoch-validated gates (lib/entitlementServer.ts's
// requireCapability/requireFullAccess, or lib/sessionEpoch.ts's
// requireCurrentOwnerSession directly) -- UNLESS the route is in the
// explicit, individually-justified exemption list below. Adding a new
// owner-reachable route.ts without wiring one of these three gates, and
// without adding a reviewed exemption here, fails this test.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const apiDir = path.join(projectRoot, "app", "api");

function findRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findRouteFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

const ROUTE_FILES = findRouteFiles(apiDir).map((f) => path.relative(apiDir, f).replace(/\\/g, "/"));

// Every entry here was individually inspected during the Phase 5.7D-R4
// audit (see that phase's final report for the full classification table)
// and is exempt for the stated, structural reason -- not merely "it looked
// fine." If a route's actual behavior ever changes such that a reason no
// longer holds, remove it from this list; the test above will then fail
// until the route is properly gated.
const EXEMPT: Record<string, string> = {
  "auth/login/route.ts": "pre-session: this route ESTABLISHES a session (or an MFA hand-off), it never consumes one",
  "auth/logout/route.ts": "clears the sft_session cookie unconditionally for any role; reads no business data",
  "auth/logout-all/route.ts":
    "the session_epoch-bump action itself, gated by requireOwner() alone; bumping is safe even from an already-stale session, since it can only move the epoch forward, never restore access",
  "auth/signup/route.ts": "pre-session: no Auth session exists yet at any point in this route",
  "auth/signup/confirm/route.ts": "pre-session: this is the email-confirmation exchange itself, still aal1 at most",
  "auth/signup/resend/route.ts": "pre-session: re-triggers Supabase's own confirmation email for an unconfirmed account, no Auth session exists at any point",
  "auth/mfa/enroll/route.ts": "pre-session: uses the separate, structurally distinct sft_mfa_pending mechanism, never sft_session",
  "auth/mfa/verify/route.ts": "pre-session: uses the separate, structurally distinct sft_mfa_pending mechanism, never sft_session -- and is the ONE route that mints sft_session, so it cannot itself already hold a validated one",
  "appointments/cancel/route.ts": "fully public, unguessable-token-based (cancel_token match) -- no session of any kind, owner or otherwise",
  "appointments/job/route.ts": "employee-only: session.role !== \"employee\" is rejected before any data read; never reachable by an owner session",
  "book/availability/route.ts": "public: resolves against the fixed REAL_WORKSPACE_ID constant, no session of any kind",
  "cron/reconcile-subscriptions/route.ts": "authenticated by CRON_SECRET, not a user session of any kind",
  "cron/reminders/route.ts": "authenticated by CRON_SECRET, not a user session of any kind (per-appointment workspace checks use requireCapabilityForWorkspace with a server-derived workspace id, not a session)",
  "stripe/webhook/route.ts": "authenticated by Stripe's own signature verification, not a user session of any kind",
};

const APPROVED_GATES = ["requireCapability(", "requireFullAccess(", "requireCurrentOwnerSession("];

describe("Phase 5.7D-R4: exhaustive owner-route session_epoch coverage", () => {
  test("every app/api/**/route.ts file that exists today is accounted for -- either gated or exempted with a stated reason", () => {
    for (const rel of ROUTE_FILES) {
      const isKnown = rel in EXEMPT;
      const source = fs.readFileSync(path.join(apiDir, rel), "utf8");
      const hasGate = APPROVED_GATES.some((g) => source.includes(g));
      assert.ok(isKnown || hasGate, `${rel} is neither an approved-gated route nor a documented exemption -- classify it`);
    }
  });

  test("every route that can be reached by an owner-role session (mentions the literal \"owner\" role) references an approved gate, unless explicitly exempted", () => {
    for (const rel of ROUTE_FILES) {
      const source = fs.readFileSync(path.join(apiDir, rel), "utf8");
      const mentionsOwnerRole = source.includes('"owner"');
      if (!mentionsOwnerRole) continue;

      const hasGate = APPROVED_GATES.some((g) => source.includes(g));
      const isExempt = rel in EXEMPT;
      assert.ok(
        hasGate || isExempt,
        `${rel} mentions the "owner" role but references no approved gate (requireCapability/requireFullAccess/requireCurrentOwnerSession) and has no documented exemption -- this is exactly the regression this test exists to catch`
      );
    }
  });

  test("every exempted file still exists -- a stale exemption for a deleted/renamed route is itself a bug in this inventory", () => {
    for (const rel of Object.keys(EXEMPT)) {
      assert.ok(fs.existsSync(path.join(apiDir, rel)), `exempted file ${rel} no longer exists -- remove its exemption`);
    }
  });

  test("appointments/job/route.ts's exemption reason (employee-only) still holds -- the literal role check rejecting non-employees appears before any requireCapability call", () => {
    // This file is the one exemption that legitimately DOES reference
    // requireCapability( -- for its own employee-scoped canUseJobTracking
    // check, which is unrelated to owner session_epoch validation
    // (requireCapability's epoch re-verification is a no-op for any
    // non-owner session). Exempted from owner-gate coverage because it is
    // structurally unreachable by an owner session at all, not because it
    // lacks a requireCapability reference -- so this is checked separately
    // and precisely, rather than by the blanket "no exempted file has a
    // gate reference" assumption that would incorrectly flag it.
    const source = fs.readFileSync(path.join(apiDir, "appointments/job/route.ts"), "utf8");
    const roleCheckIdx = source.indexOf('session.role !== "employee"');
    const capabilityIdx = source.indexOf("requireCapability(");
    assert.ok(roleCheckIdx > -1 && capabilityIdx > -1 && roleCheckIdx < capabilityIdx);
  });

  test("the three approved gate names are exactly the ones this inventory checks for -- kept as an explicit, reviewable list rather than a broad substring", () => {
    assert.deepEqual(APPROVED_GATES, ["requireCapability(", "requireFullAccess(", "requireCurrentOwnerSession("]);
  });
});
