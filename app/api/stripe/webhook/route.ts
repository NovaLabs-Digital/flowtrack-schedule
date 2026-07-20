export const runtime = "nodejs";
// Explicit ceiling this route can never exceed — LEASE_TIMEOUT_MS in
// lib/stripeWebhook.ts (300s) is defined relative to this value and must
// stay well above it. See that file's comment on LEASE_TIMEOUT_MS.
export const maxDuration = 30;

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripeConfig } from "@/lib/stripe";
import { claimEvent, completeClaim, releaseClaim, extractWorkspaceIdHint, processWebhookEvent } from "@/lib/stripeWebhook";

// No session auth here — Stripe calls this endpoint directly. The raw
// request body is verified against STRIPE_WEBHOOK_SECRET (constructEvent)
// BEFORE any database access; nothing below that point can be reached by a
// request that isn't a genuine, unmodified Stripe delivery.
export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature");

  let config;
  try {
    config = getStripeConfig();
  } catch {
    console.error("STRIPE_WEBHOOK_CONFIG_ERROR");
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }

  if (!signature) {
    console.error("STRIPE_WEBHOOK_MISSING_SIGNATURE");
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = config.client.webhooks.constructEvent(rawBody, signature, config.webhookSecret);
  } catch {
    console.error("STRIPE_WEBHOOK_SIGNATURE_INVALID");
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const claim = await claimEvent(event, extractWorkspaceIdHint(event));

  if (claim.outcome === "already_processed") {
    return NextResponse.json({ ok: true });
  }
  if (claim.outcome === "claimed_by_other") {
    // Another delivery (or an active, not-yet-expired lease) already owns
    // this event. Ask Stripe to retry rather than double-processing.
    return NextResponse.json({ error: "Processing in progress" }, { status: 409 });
  }

  try {
    await processWebhookEvent(event, config, claim.claimToken);
    await completeClaim(event.id, claim.claimToken);
    return NextResponse.json({ ok: true });
  } catch {
    // Fixed tag only — never log the event payload itself (could contain
    // payment/customer details).
    console.error("STRIPE_WEBHOOK_HANDLER_ERROR");
    await releaseClaim(event.id, claim.claimToken);
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }
}
