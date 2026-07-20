import "server-only";
import Stripe from "stripe";

// Lazily constructed and cached on first successful call. Never constructed
// at module load — `next build` imports every route module to collect page
// data, and Stripe env vars may legitimately be unset in some environments
// (local dev before Stripe is configured, preview builds, etc.). A
// module-level `new Stripe(...)` would throw at import time and break the
// build; getStripeConfig() only throws when a route actually calls it at
// request time.
let cached: StripeConfig | null = null;

export interface StripeConfig {
  client: Stripe;
  priceId: string;
  webhookSecret: string;
}

function resolveMode(secretKey: string): "test" | "live" {
  if (secretKey.startsWith("sk_test_")) return "test";
  if (secretKey.startsWith("sk_live_")) return "live";
  throw new Error("STRIPE_CONFIG_INVALID_KEY_PREFIX");
}

// Server-only, lazy, cached Stripe configuration. Every route that talks to
// Stripe calls this first and wraps it in a try/catch — a config problem
// (missing env var, key/price mode mismatch) must fail closed with a
// generic error, never a stack trace or the offending value, back to the
// client.
export function getStripeConfig(): StripeConfig {
  if (cached) return cached;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secretKey || !webhookSecret) {
    console.error("STRIPE_CONFIG_MISSING_ENV");
    throw new Error("STRIPE_CONFIG_MISSING_ENV");
  }

  let mode: "test" | "live";
  try {
    mode = resolveMode(secretKey);
  } catch {
    console.error("STRIPE_CONFIG_INVALID_KEY_PREFIX");
    throw new Error("STRIPE_CONFIG_INVALID_KEY_PREFIX");
  }

  // The secret key's mode selects which price env var is authoritative —
  // a test key must never be paired with a live price id and vice versa.
  // This is checked here, once, rather than trusted at each call site.
  const priceId = mode === "test" ? process.env.STRIPE_PRICE_MONTHLY_TEST : process.env.STRIPE_PRICE_MONTHLY_LIVE;
  if (!priceId) {
    console.error("STRIPE_CONFIG_MISSING_PRICE_FOR_MODE");
    throw new Error("STRIPE_CONFIG_MISSING_PRICE_FOR_MODE");
  }

  const client = new Stripe(secretKey);

  cached = { client, priceId, webhookSecret };
  return cached;
}
