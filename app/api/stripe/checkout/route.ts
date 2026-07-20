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
    const url = await resolveOrCreateCheckoutSession(workspaceId, row.id, customerId, config.client, config.priceId);

    return NextResponse.json({ url });
  } catch (e) {
    if (e instanceof CheckoutRetryableError) {
      return NextResponse.json({ error: "Checkout is already starting — please try again in a moment." }, { status: 409 });
    }
    console.error("STRIPE_CHECKOUT_ERROR");
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 });
  }
}
