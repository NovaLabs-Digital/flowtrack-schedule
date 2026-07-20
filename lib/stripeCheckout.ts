import "server-only";
import type Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export interface SubscriptionRow {
  id: string;
  billing_mode: "internal" | "stripe";
  stripe_customer_id: string | null;
  stripe_status: string | null;
}

// Claims (or reads) this workspace's single subscriptions row. workspace_id
// is UNIQUE on this table (migration 015), so a bare INSERT racing another
// concurrent request has exactly one winner at the Postgres level — the
// loser's insert fails with 23505 and simply re-reads the winner's row.
// This is the whole concurrency story for "does a row exist yet": no new
// schema, no separate lock table, just the existing unique constraint used
// as the claim primitive (see the Phase 5.3 concurrency write-up for why
// this is sufficient — reported alongside this route).
export async function claimSubscriptionRow(workspaceId: string): Promise<SubscriptionRow> {
  const { data: existing, error: selectErr } = await supabaseAdmin
    .from("subscriptions")
    .select("id, billing_mode, stripe_customer_id, stripe_status")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (selectErr) throw selectErr;
  if (existing) return existing;

  const { error: insertErr } = await supabaseAdmin
    .from("subscriptions")
    .insert({ workspace_id: workspaceId, billing_mode: "stripe" });
  if (insertErr && insertErr.code !== "23505") throw insertErr;

  const { data: row, error: reselectErr } = await supabaseAdmin
    .from("subscriptions")
    .select("id, billing_mode, stripe_customer_id, stripe_status")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (reselectErr) throw reselectErr;
  if (!row) throw new Error("STRIPE_CHECKOUT_ROW_MISSING_AFTER_CLAIM");
  return row;
}

// Signals "a concurrent request is already creating this workspace's
// customer or session right now — ask the client to retry shortly" rather
// than a hard failure. Distinguished from other errors so the route can
// return 409 instead of 500.
export class CheckoutRetryableError extends Error {}

// Resolves the one Stripe customer for this workspace, creating it if
// needed. Concurrency-safe without new schema: the Stripe idempotency key
// is deterministic per workspace, so two racing requests that both reach
// customers.create at the same moment get back the SAME customer object
// from Stripe itself (Stripe's own dedup guarantee) — there is structurally
// no way for this to produce two customers. The DB write that follows is
// therefore safe regardless of which request "wins": both write the
// identical id. A genuinely concurrent collision on the idempotency key
// (two in-flight requests at the exact same instant) surfaces as Stripe's
// own StripeIdempotencyError, which is treated as "try again in a moment"
// rather than silently creating a second customer.
export async function resolveStripeCustomerId(
  workspaceId: string,
  existingCustomerId: string | null,
  client: Stripe
): Promise<string> {
  if (existingCustomerId) return existingCustomerId;

  let customerId: string;
  try {
    const customer = await client.customers.create(
      { metadata: { workspace_id: workspaceId } },
      { idempotencyKey: `ws-${workspaceId}-customer-create` }
    );
    customerId = customer.id;
  } catch (e) {
    if (isStripeIdempotencyError(e)) {
      throw new CheckoutRetryableError();
    }
    throw e;
  }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("subscriptions")
    .update({ stripe_customer_id: customerId })
    .eq("workspace_id", workspaceId)
    .is("stripe_customer_id", null)
    .select("stripe_customer_id")
    .maybeSingle();
  if (updateErr) throw updateErr;

  if (!updated) {
    // Someone else's concurrent request already wrote a value first —
    // re-read the authoritative stored id. Given the idempotency key above,
    // it should always equal customerId; if it doesn't, something is wrong
    // enough to fail closed rather than silently proceed with a mismatched
    // customer.
    const { data: row, error: reselectErr } = await supabaseAdmin
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (reselectErr) throw reselectErr;
    if (!row?.stripe_customer_id) throw new Error("STRIPE_CHECKOUT_CUSTOMER_MISSING_AFTER_RACE");
    if (row.stripe_customer_id !== customerId) {
      console.error("STRIPE_CHECKOUT_CUSTOMER_MISMATCH");
      throw new Error("STRIPE_CHECKOUT_CUSTOMER_MISMATCH");
    }
    return row.stripe_customer_id;
  }

  return updated.stripe_customer_id!;
}

// Checked structurally (name + rawType) rather than via `instanceof
// Stripe.errors.StripeIdempotencyError` so tests can inject a plain fake
// error object without constructing a real Stripe SDK error instance.
function isStripeIdempotencyError(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { type?: string }).type === "StripeIdempotencyError";
}

function buildSessionParams(
  workspaceId: string,
  customerId: string,
  priceId: string,
  appUrl: string | undefined
): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: 30,
      metadata: { workspace_id: workspaceId },
    },
    metadata: { workspace_id: workspaceId },
    payment_method_collection: "always",
    success_url: `${appUrl}/dashboard?settings=subscription&checkout=success`,
    cancel_url: `${appUrl}/dashboard?settings=subscription&checkout=cancelled`,
  };
}

// Resolves (or creates) the one Checkout Session this workspace should be
// sent to right now — never two.
//
// 1. Authoritative pre-check: ask Stripe directly whether an open session
//    already exists for this customer. This is what makes "resume an
//    in-progress checkout" and "a session recently expired" both safe:
//    Stripe itself decides open vs. expired (session.url is only ever
//    non-null while a session is active — see Stripe's docs on that field),
//    so there is no separate expiry bookkeeping on our side to get wrong.
// 2. If none is open, create one with a deterministic idempotency key
//    scoped to this workspace's subscription row id — the row is the
//    durable, 1:1-with-workspace identity of "the current pending
//    subscription attempt" (workspace_id is UNIQUE on subscriptions, so
//    there is exactly one row, and its id never changes for the life of
//    that workspace). Two requests racing to this exact point get back the
//    SAME session from Stripe's own idempotency cache, not two — and a
//    genuinely simultaneous collision surfaces as Stripe's own
//    StripeIdempotencyError, turned into a 409 by the caller.
// 3. Session.url is only ever null for an inactive session (Stripe's own
//    invariant). A null url here is only possible if Stripe served a
//    cached idempotent response for a session created earlier that has
//    since expired (a retry hours later, still inside Stripe's 24h
//    idempotency window, that didn't need step 1's list to catch it because
//    that check and this create aren't atomic with each other). Detected
//    and recovered with one retry using a fresh, nonce-suffixed key — never
//    silently handed back a dead link.
export async function resolveOrCreateCheckoutSession(
  workspaceId: string,
  subscriptionRowId: string,
  customerId: string,
  client: Stripe,
  priceId: string
): Promise<string> {
  const openSessions = await client.checkout.sessions.list({ customer: customerId, status: "open", limit: 5 });
  const existing = openSessions.data.find((s) => s.metadata?.workspace_id === workspaceId && s.url);
  if (existing?.url) {
    return existing.url;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const params = buildSessionParams(workspaceId, customerId, priceId, appUrl);
  const idempotencyKey = `checkout-${subscriptionRowId}`;

  let session: Stripe.Checkout.Session;
  try {
    session = await client.checkout.sessions.create(params, { idempotencyKey });
  } catch (e) {
    if (isStripeIdempotencyError(e)) {
      throw new CheckoutRetryableError();
    }
    throw e;
  }

  if (session.url) {
    return session.url;
  }

  console.log("STRIPE_CHECKOUT_STALE_IDEMPOTENT_SESSION_RETRIED");
  // Deterministic, not random: two callers racing through the block above
  // both received the SAME cached expired session from Stripe's idempotency
  // replay (they used the same base idempotencyKey), so `session.id` here
  // is identical for both of them. Deriving the retry key from it means
  // both retries land on the same key too, and Stripe's own idempotency
  // guarantee converges them onto one replacement session — a random nonce
  // would instead let both callers create their own separate replacement.
  const retryKey = `${idempotencyKey}-after-${session.id}`;
  const retrySession = await client.checkout.sessions.create(params, { idempotencyKey: retryKey });
  if (!retrySession.url) throw new Error("STRIPE_CHECKOUT_SESSION_NO_URL");
  return retrySession.url;
}
