// Phase 5.6F: focused tests for lib/stripeCheckout.ts's one-time-trial
// enforcement -- the FIRST test coverage this file has ever had. Exercises
// resolveOrCreateCheckoutSession directly with a fake Stripe client (no
// real network call reachable), proving trial_period_days is included or
// omitted from the actual Checkout Session params based purely on the
// trialEligible argument the caller (app/api/stripe/checkout/route.ts)
// resolves from the workspace's own subscriptions.trial_consumed_at column
// -- never from any client-supplied value (this function has no such
// parameter to accept one from).
process.env.SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";

const { resolveOrCreateCheckoutSession, CheckoutRetryableError } = await import("./stripeCheckout.ts");

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const SUBSCRIPTION_ROW_ID = "sub-row-1";
const CUSTOMER_ID = "cus_test123";
const PRICE_ID = "price_test123";

interface CreateCall {
  params: Stripe.Checkout.SessionCreateParams;
  opts: { idempotencyKey: string };
}

function fakeStripeClient(overrides: {
  listResult?: { data: Array<{ id: string; url: string | null; metadata?: Record<string, string> }> };
  createImpl?: (params: Stripe.Checkout.SessionCreateParams, opts: { idempotencyKey: string }) => Promise<{ id: string; url: string | null }>;
} = {}) {
  const createCalls: CreateCall[] = [];
  const defaultCreate = async () => ({ id: "cs_test_new", url: "https://checkout.stripe.com/c/pay/cs_test_new" });
  const client = {
    checkout: {
      sessions: {
        list: async () => overrides.listResult ?? { data: [] },
        create: async (params: Stripe.Checkout.SessionCreateParams, opts: { idempotencyKey: string }) => {
          createCalls.push({ params, opts });
          const impl = overrides.createImpl ?? defaultCreate;
          return impl(params, opts);
        },
      },
    },
  } as unknown as Stripe;
  return { client, createCalls };
}

describe("one trial per workspace -- resolved server-side, never from client input", () => {
  test("trialEligible=true includes trial_period_days: 30 in the actual Checkout Session params", async () => {
    const { client, createCalls } = fakeStripeClient();
    await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, true);
    assert.equal(createCalls.length, 1);
    assert.equal(createCalls[0].params.subscription_data?.trial_period_days, 30);
  });

  test("trialEligible=false omits trial_period_days entirely -- not set to 0, simply absent", async () => {
    const { client, createCalls } = fakeStripeClient();
    await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, false);
    assert.equal(createCalls.length, 1);
    assert.equal("trial_period_days" in (createCalls[0].params.subscription_data ?? {}), false);
  });

  test("resolveOrCreateCheckoutSession has no parameter through which a caller could request/override trial eligibility other than the one explicit boolean the route itself computes", () => {
    // Structural guarantee: exactly 6 positional parameters, the last of
    // which is trialEligible -- there is no options bag, no request body,
    // no query string this function reads to derive eligibility itself.
    assert.equal(resolveOrCreateCheckoutSession.length, 6);
  });

  test("workspace_id is still stamped into subscription_data.metadata regardless of trial eligibility", async () => {
    const { client, createCalls } = fakeStripeClient();
    await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, false);
    assert.equal(createCalls[0].params.subscription_data?.metadata?.workspace_id, WORKSPACE_ID);
  });

  test("the idempotency key is identical regardless of trial eligibility -- eligibility does not create a second concurrency path", async () => {
    const { client: clientA, createCalls: callsA } = fakeStripeClient();
    const { client: clientB, createCalls: callsB } = fakeStripeClient();
    await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, clientA, PRICE_ID, true);
    await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, clientB, PRICE_ID, false);
    assert.equal(callsA[0].opts.idempotencyKey, callsB[0].opts.idempotencyKey);
    assert.equal(callsA[0].opts.idempotencyKey, `checkout-${SUBSCRIPTION_ROW_ID}`);
  });
});

describe("an already-open Checkout Session is reused, never recreated with different trial params", () => {
  test("an open session for this workspace is returned directly -- create() is never called, trialEligible is irrelevant", async () => {
    const { client, createCalls } = fakeStripeClient({
      listResult: { data: [{ id: "cs_existing", url: "https://checkout.stripe.com/c/pay/cs_existing", metadata: { workspace_id: WORKSPACE_ID } }] },
    });
    const url = await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, true);
    assert.equal(url, "https://checkout.stripe.com/c/pay/cs_existing");
    assert.equal(createCalls.length, 0);
  });

  test("an open session belonging to a DIFFERENT workspace is ignored -- a new session is still created for this one", async () => {
    const { client, createCalls } = fakeStripeClient({
      listResult: { data: [{ id: "cs_other", url: "https://checkout.stripe.com/c/pay/cs_other", metadata: { workspace_id: "some-other-workspace" } }] },
    });
    await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, true);
    assert.equal(createCalls.length, 1);
  });
});

describe("stale idempotent replay (expired cached session) is retried with a fresh key, preserving trial eligibility", () => {
  test("a null-url create response triggers exactly one retry with the SAME trialEligible params", async () => {
    let callCount = 0;
    const { client, createCalls } = fakeStripeClient({
      createImpl: async () => {
        callCount++;
        if (callCount === 1) return { id: "cs_stale", url: null };
        return { id: "cs_fresh", url: "https://checkout.stripe.com/c/pay/cs_fresh" };
      },
    });
    const url = await resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, true);
    assert.equal(url, "https://checkout.stripe.com/c/pay/cs_fresh");
    assert.equal(createCalls.length, 2);
    assert.equal(createCalls[0].params.subscription_data?.trial_period_days, 30);
    assert.equal(createCalls[1].params.subscription_data?.trial_period_days, 30);
  });
});

describe("a genuine idempotency collision surfaces as a retryable error, not a silently wrong trial decision", () => {
  test("StripeIdempotencyError from create() becomes CheckoutRetryableError", async () => {
    const { client } = fakeStripeClient({
      createImpl: async () => {
        throw { type: "StripeIdempotencyError" };
      },
    });
    await assert.rejects(
      () => resolveOrCreateCheckoutSession(WORKSPACE_ID, SUBSCRIPTION_ROW_ID, CUSTOMER_ID, client, PRICE_ID, true),
      CheckoutRetryableError
    );
  });
});
