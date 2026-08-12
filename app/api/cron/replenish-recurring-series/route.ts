export const runtime = "nodejs";
// Bounded batch (MAX_SERIES_PROCESSED_PER_RUN, see the orchestrator module)
// of Supabase queries and RPC calls -- generous relative to typical
// per-invocation load, but still a hard, enforced cap, matching
// app/api/cron/reconcile-subscriptions/route.ts's own precedent.
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cronAuth";
import { runReplenishmentPass } from "@/lib/recurringSeriesReplenishmentOrchestrator";

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

// Block 2C-2C: connects the already-deployed generator (Block 2C-2A) and
// atomic RPCs (Block 2C-2B) to a scheduled process.
//
// Dry-run control: REPLENISHMENT_DRY_RUN is a server-only environment
// variable, never a request-supplied query parameter or header. This is a
// deliberate choice, not merely a stylistic one: even though this entire
// route is already gated by CRON_SECRET, a query-parameter-based toggle
// would still mean "whether this run mutates production data" is decided by
// something in the request rather than something only the deployment owner
// controls ahead of time. Reading it from process.env instead makes dry-run
// a pure server-side deployment configuration.
//
// Production-review correction: FAIL-SAFE, inverted from an earlier draft.
// The earlier version returned `env === "true"`, which meant an ABSENT
// variable (the exact state of a freshly deployed environment that has
// never had this variable configured) evaluated to LIVE mode -- exactly
// backwards from what a brand-new deployment must default to. This is now
// deliberately inverted: dry-run is the DEFAULT for every value except one
// single, exact, explicit opt-in. Enumerated:
//   - unset / undefined                -> dry-run (default, safe)
//   - "" (blank)                       -> dry-run
//   - "true"                           -> dry-run (still safe, redundant)
//   - any unrecognized/malformed value
//     ("1", "TRUE", "yes", " false"
//     with stray whitespace, etc.)     -> dry-run (fails closed)
//   - exactly the literal "false"      -> LIVE MODE (the only opt-in)
// No trimming is performed (matching lib/cronAuth.ts's own no-trim
// convention for its Bearer token comparison) -- accidental whitespace
// around a real "false" value fails closed to dry-run rather than silently
// being coerced into enabling live mode. This means deploying this route
// and its vercel.json schedule can never accidentally enable real
// replenishment merely because the Vercel project lacks this variable.
function isDryRunEnabled(): boolean {
  return process.env.REPLENISHMENT_DRY_RUN !== "false";
}

export async function GET(req: Request) {
  try {
    const authHeader = req.headers.get("authorization");
    if (!isAuthorizedCronRequest(authHeader, process.env.CRON_SECRET)) {
      return json({ error: "Unauthorized" }, 401);
    }

    const dryRun = isDryRunEnabled();
    const summary = await runReplenishmentPass({ dryRun });

    return json({
      ok: true,
      dryRun: summary.dryRun,
      counts: summary.counts,
    });
  } catch {
    // Fixed tag only -- never the caught error's own message or object,
    // matching app/api/cron/reconcile-subscriptions/route.ts's convention
    // (never app/api/cron/reminders/route.ts's older, laxer console.error("...", e)
    // pattern, which this route deliberately does not follow).
    console.error("CRON_REPLENISH_ROUTE_ERROR");
    return json({ error: "Server error" }, 500);
  }
}
