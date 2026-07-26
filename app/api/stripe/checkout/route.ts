export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getStripeConfig } from "@/lib/stripe";
import { getSession, requireRole, assertWorkspace } from "@/lib/session";
import { isBlockingSubscriptionStatus } from "@/lib/stripeWebhook";
import {
  claimSubscriptionRow,
  resolveStripeCustomerId,
  resolveOrCreateCheckoutSession,
  CheckoutRetryableError,
} from "@/lib/stripeCheckout";

const GENERIC_ERROR = "Unable to start checkout";

export async function POST() {
  const session = await getSession();
  const deny = requireRole(session, ["owner"]);
  if (deny) return deny;
  assertWorkspace(session);
  const workspaceId = session.workspaceId;

  let config;
  try {
    config = getStripeConfig();
  } catch {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }

  try {
    const row = await claimSubscriptionRow(workspaceId);

    if (row.billing_mode !== "stripe") {
      return NextResponse.json({ error: "This workspace is not billed through Stripe." }, { status: 400 });
    }

    if (isBlockingSubscriptionStatus(row.stripe_status)) {
      return NextResponse.json(
        { error: "This workspace already has a subscription. Manage it from the billing portal.", redirectToPortal: true },
        { status: 409 }
      );
    }

    const customerId = await resolveStripeCustomerId(workspaceId, row.stripe_customer_id, config.client);
    // Phase 5.6F: trial eligibility is resolved exclusively from this
    // workspace's own subscriptions row (never a client-supplied value --
    // this route takes no request body at all). trial_consumed_at is set
    // once, permanently, the first time this workspace ever completes a
    // trial-bearing Checkout Session (see lib/stripeWebhook.ts) and is
    // never cleared by cancellation or reactivation, so a returning
    // customer is correctly billed immediately.
    const trialEligible = row.trial_consumed_at === null;
    const url = await resolveOrCreateCheckoutSession(workspaceId, row.id, customerId, config.client, config.priceId, trialEligible);

    return NextResponse.json({ url });
  } catch (e) {
    if (e instanceof CheckoutRetryableError) {
      return NextResponse.json({ error: "Checkout is already starting — please try again in a moment." }, { status: 409 });
    }
    console.error("STRIPE_CHECKOUT_ERROR");
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }
}
