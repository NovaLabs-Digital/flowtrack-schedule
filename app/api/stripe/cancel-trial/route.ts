export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getStripeConfig } from "@/lib/stripe";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";
import { requireCurrentOwnerSession } from "@/lib/sessionEpoch";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { updateSubscriptionIfUnchanged } from "@/lib/stripeWebhook";
import { cancelTrialSubscription } from "@/lib/stripeCancelTrial";

const GENERIC_ERROR = "Unable to cancel your trial right now. Please try again.";
const NOT_TRIALING_ERROR = "This workspace isn't in a trial right now. Use Billing to manage your subscription.";

// Phase 5.6D — the ONE application-controlled action that ends TRIAL access
// immediately, on the owner's explicit request. Deliberately separate from
// app/api/stripe/portal/route.ts (unchanged, still the correct surface for a
// PAID subscription's cancel-at-period-end flow) -- the Stripe Customer
// Portal's own Dashboard-configured cancellation behavior is one uniform
// setting this application cannot rely on to apply "immediate" only to
// trials, so this route calls Stripe's immediate-cancel endpoint directly.
//
// Cross-workspace access is structurally impossible here, same reasoning as
// the checkout/portal routes: workspaceId and the resulting Stripe
// subscription id both come exclusively from the authenticated session and
// this workspace's own stored subscriptions row -- there is no request body
// to trust or distrust in the first place.
export async function POST() {
  const session = await getSession();
  const deny = requireRole(session, ["owner"]);
  if (deny) return deny;
  assertWorkspace(session);
  const ownerSessionCheck = await requireCurrentOwnerSession(session);
  if (!ownerSessionCheck.ok) return ownerSessionCheck.response;
  const workspaceId = session.workspaceId;

  let config;
  try {
    config = getStripeConfig();
  } catch {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }

  const { data: row, error } = await supabaseAdmin
    .from("subscriptions")
    .select("stripe_subscription_id, stripe_status, grace_until, trial_consumed_at, access_ended_at, last_event_created_at")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error || !row) {
    console.error("STRIPE_CANCEL_TRIAL_QUERY_ERROR");
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }

  try {
    // Deterministic, per-subscription idempotency key (same convention as
    // lib/stripeCheckout.ts's customer/session creation) -- a genuine
    // double-click or network retry within Stripe's own idempotency window
    // converges on the SAME cancel response rather than erroring or
    // double-canceling, independent of cancelTrialSubscription's own
    // stripe_status-based idempotency check below.
    const idempotencyKey = row.stripe_subscription_id ? `cancel-trial-${row.stripe_subscription_id}` : undefined;
    const outcome = await cancelTrialSubscription(row, workspaceId, {
      cancelSubscription: (id) => config.client.subscriptions.cancel(id, undefined, idempotencyKey ? { idempotencyKey } : undefined),
      applyPatch: updateSubscriptionIfUnchanged,
    });

    switch (outcome.outcome) {
      case "canceled":
      case "conflict":
        // "conflict" (a lost compare-and-swap race) still means the
        // cancellation genuinely happened at Stripe -- the eventual webhook
        // for this same event persists the identical terminal state, so
        // this is reported to the owner as success, not an error.
        return NextResponse.json({ ok: true });
      case "not_trialing":
        return NextResponse.json({ error: NOT_TRIALING_ERROR }, { status: 409 });
      case "no_subscription":
        console.error("STRIPE_CANCEL_TRIAL_MISSING_SUBSCRIPTION_ID");
        return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
    }
  } catch {
    console.error("STRIPE_CANCEL_TRIAL_ERROR");
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }
}
