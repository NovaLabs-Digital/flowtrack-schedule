export const runtime = "nodejs";
// Bounded batch of RECONCILE_BATCH_LIMIT sequential Stripe calls — generous
// relative to the webhook route's 30s ceiling since this does more network
// round-trips per invocation, but still a hard, enforced cap.
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getStripeConfig } from "@/lib/stripe";
import { DEMO_WORKSPACE_ID } from "@/lib/workspace";
import { updateSubscriptionIfUnchanged } from "@/lib/stripeWebhook";
import {
  isAuthorizedCronRequest,
  reconcileRows,
  RECONCILE_STALE_THRESHOLD_MS,
  RECONCILE_BATCH_LIMIT,
} from "@/lib/reconcileSubscriptions";

// Phase 5.4B — bounded reconciliation for Stripe-billed subscriptions whose
// local state hasn't been confirmed by a webhook (or a prior reconciliation
// run) within RECONCILE_STALE_THRESHOLD_MS. Not scheduled by anything yet —
// this route exists and can be invoked manually/for testing, but no
// external cron trigger or vercel.json entry is added in this phase.
//
// No session auth — same model as app/api/cron/reminders: a shared-secret
// query param, checked before any database or Stripe access.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (!isAuthorizedCronRequest(secret, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let config;
  try {
    config = getStripeConfig();
  } catch {
    console.error("STRIPE_RECONCILE_CONFIG_ERROR");
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }

  const thresholdIso = new Date(Date.now() - RECONCILE_STALE_THRESHOLD_MS).toISOString();

  // billing_mode = 'stripe' is the primary protection against ever touching
  // an internal or demo workspace (the demo workspace has no row here at
  // all, and Alberto's production workspace stays billing_mode = 'internal'
  // throughout this phase — see migration 015). The explicit .neq below is
  // a second, redundant layer purely for defense-in-depth, matching how
  // strongly the approved scope emphasizes never reconciling either.
  // Deterministic pagination: oldest-unconfirmed-first, hard-capped, with
  // workspace_id (unique per row) as a tiebreaker — `updated_at` alone can
  // tie (e.g. several rows claimed in the same request, or touched by the
  // same reconciliation run), and an undetermined tie order across repeated
  // queries risks rows being skipped or duplicated across LIMIT-bounded
  // pages/runs — never an unbounded scan either way.
  const { data: rows, error } = await supabaseAdmin
    .from("subscriptions")
    .select("workspace_id, billing_mode, stripe_subscription_id, grace_until, last_event_created_at, updated_at")
    .eq("billing_mode", "stripe")
    .neq("workspace_id", DEMO_WORKSPACE_ID)
    .lt("updated_at", thresholdIso)
    .order("updated_at", { ascending: true })
    .order("workspace_id", { ascending: true })
    .limit(RECONCILE_BATCH_LIMIT);

  if (error) {
    console.error("STRIPE_RECONCILE_QUERY_ERROR");
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }

  const result = await reconcileRows(rows ?? [], {
    retrieveSubscription: (id) => config.client.subscriptions.retrieve(id),
    applyPatch: updateSubscriptionIfUnchanged,
  });

  return NextResponse.json(result);
}
